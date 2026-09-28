// Inbound endpoints for the non-email channels.
//
//   POST /api/channels/telegram    a person started or answered the bot's chat
//   GET  /api/channels/whatsapp    Meta's subscription handshake (hub.challenge)
//   POST /api/channels/whatsapp    signed inbound WhatsApp messages
//
// These endpoints create permission to write to someone, so they are the strictest
// ones in the app: each refuses everything until its verification secret is configured
// (fail closed), because an unauthenticated writer could otherwise fabricate a consent
// record for any address and hand a stranger's number to an automated sender.
//
// Telegram cannot sign its payloads. The defence is the secret we supplied when
// registering the webhook, which Telegram echoes back in
// X-Telegram-Bot-Api-Secret-Token on every call.
//
// WhatsApp bodies carry X-Hub-Signature-256, an HMAC of the raw body with the app
// secret, which is verified before the JSON is interpreted at all.
import type { Express, Request, Response } from "express";
import { env } from "./env";
import { expressRateLimiter } from "./rateLimit";
import {
  parseTelegramUpdate,
  parseWhatsAppWebhook,
  recordChannelInbound,
  telegramSecretMatches,
  whatsappSignatureValid,
  type ChannelInbound,
} from "../services/channels";

function rawBodyOf(req: Request): string {
  return (req as Request & { rawBody?: string }).rawBody ?? "";
}

/**
 * Acknowledge or ask for a retry. Telegram and Meta both redeliver on a non-2xx, so a
 * database outage must be 503 (come back later) while a permanent refusal must be 200
 * (come back later will not help, and a queue of retries hides the real problem).
 */
function answer(res: Response, outcome: { reason?: string } | null): void {
  if (outcome?.reason === "db_unavailable") {
    res.status(503).json({ ok: false, reason: "db_unavailable" });
    return;
  }
  res.json({ ok: true, ...outcome });
}

async function handleOne(res: Response, inbound: ChannelInbound | null): Promise<void> {
  if (!inbound) {
    // Not a human message (bot traffic, channel post, edit, button press). Nothing to
    // record and nothing to retry, so acknowledge it and move on.
    res.json({ ok: true, handled: false, reason: "not_a_person_message" });
    return;
  }
  try {
    answer(res, await recordChannelInbound(inbound));
  } catch (err) {
    console.error("[channels] inbound processing failed:", err);
    res.status(503).json({ ok: false, reason: "processing_failed" });
  }
}

export function mountChannelEndpoints(app: Express): void {
  const limiter = expressRateLimiter("channel-inbound", { windowMs: 60_000, max: 120 });

  app.post("/api/channels/telegram", limiter, async (req, res) => {
    if (!env.telegramWebhookSecret) {
      return res.status(503).json({ ok: false, reason: "TELEGRAM_WEBHOOK_SECRET not set" });
    }
    if (!telegramSecretMatches(req.header("x-telegram-bot-api-secret-token"), env.telegramWebhookSecret)) {
      return res.status(401).json({ ok: false, reason: "bad secret token" });
    }
    await handleOne(res, parseTelegramUpdate(req.body));
  });

  // The handshake Meta performs once when the subscription is created.
  app.get("/api/channels/whatsapp", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode !== "subscribe" || !env.whatsappVerifyToken || token !== env.whatsappVerifyToken) {
      return res.status(403).send("verification failed");
    }
    res.status(200).send(String(challenge ?? ""));
  });

  app.post("/api/channels/whatsapp", limiter, async (req, res) => {
    if (!env.whatsappAppSecret) {
      return res.status(503).json({ ok: false, reason: "WHATSAPP_APP_SECRET not set" });
    }
    if (!whatsappSignatureValid(req.header("x-hub-signature-256"), rawBodyOf(req), env.whatsappAppSecret)) {
      return res.status(401).json({ ok: false, reason: "bad signature" });
    }
    const inbounds = parseWhatsAppWebhook(req.body);
    if (!inbounds.length) {
      // Delivery statuses and reads carry no message. Acknowledged, not stored.
      return res.json({ ok: true, handled: false, reason: "no_messages" });
    }
    const results = [];
    for (const inbound of inbounds) {
      try {
        results.push(await recordChannelInbound(inbound));
      } catch (err) {
        console.error("[channels] whatsapp inbound failed:", err);
        return res.status(503).json({ ok: false, reason: "processing_failed" });
      }
    }
    answer(res, results[results.length - 1] ?? null);
  });
}
