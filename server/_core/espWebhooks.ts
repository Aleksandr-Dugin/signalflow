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

export function mountEspWebhooks(app: Express): void {
  const reply = (res: Response, err?: unknown) => {
    if (err) {
      console.error("[esp-webhook]", err);
      return res.status(500).json({ ok: false });
    }
    res.json({ ok: true });
  };

  app.post("/api/replies/webhook/mailgun", async (req, res) => {
    if (!(await verifyMailgun(req))) return res.status(401).json({ ok: false, reason: "bad signature" });
    const input = parseGenericInbound(req.body);
    await ingestEmailEvent(input);
    reply(res);
  });

  app.post("/api/replies/webhook/sendgrid", async (req, res) => {
    if (!verifySendGrid(req)) return res.status(401).json({ ok: false, reason: "bad auth" });
    const input = parseGenericInbound(req.body);
    const result = await ingestEmailEvent(input);
    // Auto-handle List-Unsubscribe links that come through SendGrid parse.
    if (/^unsubscribe$/i.test(input.bodyText ?? "") && input.referenceId) {
      await handleUnsubscribeByRef(input.referenceId);
    }
    reply(res);
    void result;
  });

  app.post("/api/replies/webhook/postmark", async (req, res) => {
    if (!verifyPostmark(req)) return res.status(401).json({ ok: false, reason: "bad secret" });
    const input = parseGenericInbound(req.body);
    await ingestEmailEvent(input);
    reply(res);
  });

  app.post("/api/replies/webhook/ses", async (req, res) => {
    const input = parseSes(req);
    if (!input) return res.status(204).end();
    await ingestEmailEvent(input);
    reply(res);
  });
}
