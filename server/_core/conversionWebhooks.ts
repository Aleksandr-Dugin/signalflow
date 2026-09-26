// Conversion + click-tracking endpoints.
//
//   GET  /api/track/cta/:ref/:kind     attributed redirect for Calendly/Stripe CTAs
//   POST /api/conversions/calendly     meeting booked -> meeting_booked
//   POST /api/conversions/stripe       payment captured -> won
//   POST /api/replies/unsubscribe      RFC 8058 one-click List-Unsubscribe
//
// Trust model: both provider endpoints verify an HMAC over the raw request body
// using a per-provider signing secret, and refuse everything (503) when the
// secret is not configured. A half-set-up deployment therefore cannot be walked
// into reporting fake meetings or fake revenue — that is strictly better than a
// permissive default, because these endpoints write to the sales funnel.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { env } from "./env";
import { expressRateLimiter } from "./rateLimit";
import { isCtaKind } from "../services/cta";
import {
  ctaTargetFor,
  applyStripeValue,
  handleCalendlyEvent,
  handleStripeEvent,
  recordCtaClick,
  type CalendlyPayload,
  type ConversionOutcome,
  type StripeEvent,
} from "../services/conversions";
import { handleUnsubscribeByRef } from "../services/replies";

/**
 * Verify a `t=<timestamp>,v<N>=<hex>` signature header (the scheme shared by
 * Stripe and Calendly) against the raw body. Accepts any of the offered digest
 * versions so a provider can rotate its scheme without breaking verification.
 */
export function verifySignedHeader(
  header: string | undefined,
  rawBody: string,
  secret: string,
  digestVersions: string[],
  toleranceSec = 300,
): boolean {
  if (!header || !secret || !rawBody) return false;
  const parts = new Map<string, string>();
  for (const field of header.split(",")) {
    const idx = field.indexOf("=");
    if (idx === -1) continue;
    parts.set(field.slice(0, idx).trim(), field.slice(idx + 1).trim());
  }
  const timestamp = parts.get("t");
  if (!timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > toleranceSec) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  for (const version of digestVersions) {
    const provided = parts.get(version);
    if (!provided || !/^[0-9a-f]+$/i.test(provided)) continue;
    const candidate = Buffer.from(provided, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}

function rawBodyOf(req: Request): string {
  return (req as Request & { rawBody?: string }).rawBody ?? "";
}

function jsonOrEmpty(req: Request): unknown {
  return req.body && typeof req.body === "object" ? req.body : {};
}

/**
 * Decide the HTTP status for an outcome. Providers retry on 5xx, so a transient
 * database outage must *not* be answered with 200 — that acknowledges the event
 * and the conversion signal is lost forever, leaving a booked meeting or a paid
 * invoice stuck mid-funnel. Permanent outcomes (unmatched payer, malformed body)
 * answer 200 because retrying them cannot help.
 */
function respond(res: Response, result: ConversionOutcome): void {
  if (result.reason === "db_unavailable") {
    res.status(503).json({ ok: false, reason: "db_unavailable" });
    return;
  }
  res.json({ ok: true, ...result });
}

export function mountConversionEndpoints(app: Express): void {
  const trackLimiter = expressRateLimiter("cta-track", { windowMs: 60_000, max: 120 });

  // Tracked CTA click. The destination comes from server config for the given
  // kind only — never from the request — so this can't become an open redirect.
  app.get("/api/track/cta/:ref/:kind", trackLimiter, async (req, res) => {
    const kind = req.params.kind;
    const ref = String(req.params.ref ?? "");
    const target = isCtaKind(kind) ? ctaTargetFor(kind) : null;
    if (!isCtaKind(kind) || !target) {
      // Link was sent before the tool was configured, or the kind is bogus.
      return res.status(404).send("This link is no longer available.");
    }
    try {
      await recordCtaClick(ref, kind);
    } catch (err) {
      // A failed attribution must never strand the prospect mid-funnel.
      console.error("[track] cta click recording failed:", err);
    }
    res.redirect(302, target);
  });

  app.post("/api/conversions/calendly", async (req, res) => {
    if (!env.calendlySigningSecret) {
      return res.status(503).json({ ok: false, reason: "CALENDLY_SIGNING_SECRET not set" });
    }
    const signature = req.header("calendly-webhook-signature");
    if (!verifySignedHeader(signature, rawBodyOf(req), env.calendlySigningSecret, ["v0", "v1"])) {
      return res.status(401).json({ ok: false, reason: "bad signature" });
    }
    try {
      const result = await handleCalendlyEvent(jsonOrEmpty(req) as CalendlyPayload);
      respond(res, result);
    } catch (err) {
      console.error("[conversions] calendly failed:", err);
      // 500 so Calendly retries its delivery rather than dropping the event.
      res.status(500).json({ ok: false, error: "calendly processing failed" });
    }
  });

  app.post("/api/conversions/stripe", async (req, res) => {
    if (!env.stripeWebhookSecret) {
      return res.status(503).json({ ok: false, reason: "STRIPE_WEBHOOK_SECRET not set" });
    }
    const signature = req.header("stripe-signature");
    if (!verifySignedHeader(signature, rawBodyOf(req), env.stripeWebhookSecret, ["v1"])) {
      return res.status(401).json({ ok: false, reason: "bad signature" });
    }
    try {
      const event = jsonOrEmpty(req) as StripeEvent;
      const result = await handleStripeEvent(event);
      if (result.reason !== "db_unavailable") {
        // Recorded separately so a value update never gates the stage transition.
        await applyStripeValue(event);
      }
      respond(res, result);
    } catch (err) {
      console.error("[conversions] stripe failed:", err);
      res.status(500).json({ ok: false, error: "stripe processing failed" });
    }
  });

  // RFC 8058 one-click unsubscribe: the mail client POSTs to the exact URI we put
  // in the header (body `List-Unsubscribe=One-Click`), with no user interaction.
  // Our URI carries ?ref=<per-message nanoid(16)>, which is an unguessable
  // capability token — that is what makes an unauthenticated POST acceptable for
  // a suppression action. Suppression is also idempotent, so a replay is inert.
  app.post("/api/replies/unsubscribe", async (req, res) => {
    const ref =
      String(req.query.ref ?? "") ||
      String(req.body?.ref ?? "") ||
      (/ref=([\w-]+)/.exec(String(req.header("referer") ?? ""))?.[1] ?? "");
    const done = ref ? await handleUnsubscribeByRef(ref) : false;
    if (!done) return res.status(404).send("Unsubscribe link not recognised.");
    res.status(200).send("Unsubscribed.");
  });
}
