// Native ESP inbound adapters. Users no longer have to hand-write a bridge to
// /api/replies/ingest — they just point their provider's inbound webhook here.
// Every adapter parses the provider's payload into our canonical
// InboundEmailInput and delegates to the same ingestEmailEvent pipeline the
// manual webhook uses (dedupe, classify, advance opportunity, queue follow-up).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { env } from "./env";
import { ingestEmailEvent, handleUnsubscribeByRef, type InboundEmailInput } from "../services/replies";

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a || "");
  const bb = Buffer.from(b || "");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Mailgun "Routes" / webhook forward.
 *   POST https://your.app/api/replies/webhook/mailgun
 *   fields: From, To, Subject, body-plain, event (or Mailgun signature check)
 * Signature: hmac-sha256 of `${timestamp}${token}` with the Mailgun signing key,
 * sent as `signature` in a multipart form or `Mailgun-Signature` header.
 */
async function verifyMailgun(req: Request): Promise<boolean> {
  if (!env.replyIngestSecret) return false;
  const token = req.body?.token ?? req.header("Mailgun-Token");
  const timestamp = req.body?.timestamp ?? req.header("Mailgun-Timestamp");
  const signature = req.body?.signature ?? req.header("Mailgun-Signature");
  if (!token || !timestamp || !signature) return false;
  const expected = createHmac("sha256", env.replyIngestSecret).update(`${timestamp}${token}`).digest("hex");
  return safeEqualHex(expected, String(signature));
}

/** SendGrid Inbound Parse posts url-encoded fields, basic-auth protected. */
function verifySendGrid(req: Request): boolean {
  if (!env.replyIngestSecret) return false;
  const header = req.header("authorization") ?? "";
  const [scheme, b64] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !b64) return false;
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  const pass = decoded.split(":")[1] ?? "";
  return safeEqualHex(pass, env.replyIngestSecret);
}

/** Postmark inbound uses a server-wide JSON header `X-Postmark-Secret` (legacy)
 *  or `Accept` verification. Kept minimal; users can also drop the payload into
 *  /api/replies/ingest directly if they prefer their own signing. */
function verifyPostmark(req: Request): boolean {
  if (!env.replyIngestSecret) return false;
  const secret = req.header("x-postmark-secret") ?? req.body?.Secret;
  return Boolean(secret) && safeEqualHex(String(secret), env.replyIngestSecret);
}

/**
 * Authenticate an SNS-delivered SES event.
 *
 * Unlike the other three providers this route previously had no check at all,
 * which made it an unauthenticated write endpoint into the sales funnel: anyone
 * who knew the URL could post a forged `replied` or `bounced` event, advance or
 * kill another tenant's deal, and queue follow-ups. SNS cannot attach a custom
 * header or HMAC of our choosing, so the credential rides in the subscription
 * URL — register the endpoint as
 * `https://your.app/api/replies/webhook/ses?key=<REPLY_INGEST_SECRET>` and the
 * `?key=` (or `x-ses-webhook-key`) is compared in constant time.
 *
 * This is a capability check, not proof of origin: full SNS signature
 * verification (fetch SigningCertUrl, pin it to *.sns.<region>.amazonaws.com,
 * RSA-SHA1 over the canonical string) is still outstanding. What is no longer
 * possible is accepting these events with no credential whatsoever.
 */
function verifySes(req: Request): boolean {
  if (!env.replyIngestSecret) return false;
  const provided = String(req.query?.key ?? "") || String(req.header("x-ses-webhook-key") ?? "");
  return Boolean(provided) && safeEqualHex(provided, env.replyIngestSecret);
}

/** Amazon SES → SNS subscription confirmation + notification body.
 *  We only parse the JSON notification for simplicity; production deployments
 *  should also validate the SNS signature (SignCertUrl chain). */
function parseSes(req: Request): InboundEmailInput | null {
  const body: any = req.body;
  if (!body) return null;
  if (body.Type === "SubscriptionConfirmation" || body.Type === "UnsubscribeConfirmation") {
    return null; // caller must visit SubscribeURL; we log-and-ignore here
  }
  let mail: any;
  try {
    mail = JSON.parse(body.Message);
  } catch {
    return null;
  }
  const recv = mail?.mail?.destination?.[0] ?? "";
  const from = mail?.mail?.source ?? mail?.notificationType ?? "";
  const content: string = mail?.content ?? "";
  const isBounce = mail?.notificationType === "Bounce";
  return {
    workspaceId: null, // resolved from referenceId / recipient inside ingest
    referenceId: extractRef(recv),
    fromAddress: String(from),
    toAddress: recv ? String(recv).split("@")[0] : null,
    subject: mail?.mail?.subject ?? null,
    bodyText: isBounce ? "bounce" : content.slice(0, 200_000),
    eventType: isBounce ? "bounced" : "replied",
    dedupeKey: mail?.mail?.messageId ? `ses:${mail.mail.messageId}` : null,
    metadata: { provider: "ses" },
  };
}

function extractRef(to: string): string | null {
  // We encode the reference into the reply-to address when outreach is sent
  // (see outreach.ts unsubscribe URL). If your ESP uses plus-addressing like
  // `reply+<ref>@your.domain`, uncomment the second branch.
  const m = /reply\+([A-Za-z0-9_-]+)/.exec(to || "");
  return m ? m[1] : null;
}

function pickFirst(...vals: (string | undefined | null)[]): string | null {
  for (const v of vals) if (v) return v;
  return null;
}

function parseGenericInbound(body: any): InboundEmailInput {
  const from = pickFirst(body.sender, body.from, body["From"], body.from_address) ?? "";
  const to = pickFirst(body["To"], body.to, body.recipient, body.to_address) ?? "";
  const subject = pickFirst(body.subject, body.Subject) ?? null;
  const text =
    pickFirst(body["body-plain"], body.bodyPlain, body.body, body.body_text, body.text, body.Text) ?? "";
  const eventType: InboundEmailInput["eventType"] =
    body.event === "bounced" || body.NotificationType === "Bounce" ? "bounced" : "replied";
  return {
    workspaceId: null,
    referenceId: extractRef(to),
    fromAddress: String(from),
    toAddress: to || null,
    subject,
    bodyText: String(text).slice(0, 200_000),
    eventType,
    dedupeKey: body["message-headers-key"] ?? body.MessageId ?? body.messageId ?? null,
    metadata: { provider: body.provider ?? "generic" },
  };
}

/**
 * Run an inbound handler and translate the outcome into a status providers
 * understand.
 *
 * ingestEmailEvent() throws when the database is unreachable, and Express does
 * not catch async rejections — so until now a webhook arriving during a
 * database blip produced an unhandled rejection and terminated the Node
 * process. The provider sees a reset connection and retries, and the retry
 * kills it again: one blip becomes a crash loop, and every other tenant's
 * traffic goes down with it. A 500 asks for the same retry without taking the
 * server with it, which is the contract the Calendly/Stripe callbacks in
 * conversionWebhooks.ts already honour.
 */
async function ingest(res: Response, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    if (!res.headersSent) res.json({ ok: true });
  } catch (err) {
    console.error("[esp-webhook]", err);
    if (!res.headersSent) res.status(500).json({ ok: false, reason: "ingest_failed" });
  }
}

export function mountEspWebhooks(app: Express): void {
  app.post("/api/replies/webhook/mailgun", async (req, res) => {
    if (!(await verifyMailgun(req))) return res.status(401).json({ ok: false, reason: "bad signature" });
    const input = parseGenericInbound(req.body);
    await ingest(res, async () => {
      await ingestEmailEvent(input);
    });
  });

  app.post("/api/replies/webhook/sendgrid", async (req, res) => {
    if (!verifySendGrid(req)) return res.status(401).json({ ok: false, reason: "bad auth" });
    const input = parseGenericInbound(req.body);
    await ingest(res, async () => {
      await ingestEmailEvent(input);
      // Auto-handle List-Unsubscribe links that come through SendGrid parse.
      if (/^unsubscribe$/i.test(input.bodyText ?? "") && input.referenceId) {
        await handleUnsubscribeByRef(input.referenceId);
      }
    });
  });

  app.post("/api/replies/webhook/postmark", async (req, res) => {
    if (!verifyPostmark(req)) return res.status(401).json({ ok: false, reason: "bad secret" });
    const input = parseGenericInbound(req.body);
    await ingest(res, async () => {
      await ingestEmailEvent(input);
    });
  });

  app.post("/api/replies/webhook/ses", async (req, res) => {
    // Fail closed with 503 when the secret is unset so a half-configured
    // deployment cannot silently ingest forged mail events, matching the
    // contract the Calendly/Stripe callbacks already honour.
    if (!env.replyIngestSecret) {
      return res.status(503).json({ ok: false, reason: "REPLY_INGEST_SECRET not set" });
    }
    if (!verifySes(req)) {
      return res.status(401).json({ ok: false, reason: "bad key" });
    }
    const input = parseSes(req);
    if (!input) return res.status(204).end();
    await ingest(res, async () => {
      await ingestEmailEvent(input);
    });
  });
}
