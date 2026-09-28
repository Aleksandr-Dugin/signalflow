// Non-email channels: how a second way to reach a person opens, and what it costs.
//
// The important part is not the API calls, it is that neither platform allows cold
// outreach, so the feature cannot be built the way email is built:
//
//   Telegram  a bot may only write to a chat the *user* opened first. There is no
//             endpoint that takes a phone number or a handle and delivers a message
//             to a stranger; getChat fails, and sendMessage 400s.
//   WhatsApp  the Cloud API lets a business write free text only inside the 24-hour
//             window that starts when the *user* messages the business. Outside it,
//             the only permitted outbound is a pre-approved template to a number that
//             opted in — a review process this module deliberately does not fake.
//
// So the loop is: email finds the person, the email carries a link that starts a chat
// on the other platform (`/api/track/cta/<ref>/telegram` → t.me/<bot>?start=<ref>),
// and the inbound event on that platform is what creates the permission to write back.
// Consent is therefore a fact recorded from the person's own action, never a field an
// operator can set because a prospect looked promising.
//
// Consequences enforced here rather than in prose:
//   - A send requires a `channel_identities` row with `consentAt` set, no
//     `revokedAt`, and (WhatsApp) a reply window that is still open.
//   - Inbound endpoints refuse everything until their verification secret is
//     configured. Telegram cannot sign its payloads, so we require the
//     X-Telegram-Bot-Api-Secret-Token we registered the webhook with; WhatsApp
//     bodies are HMAC-verified against the app secret. Without that, anyone who
//     learned the webhook URL could invent consent on a stranger's behalf.
//   - Nothing here ever moves an opportunity stage. A channel conversation is
//     engagement; the funnel still only advances on Calendly/Stripe evidence
//     (docs/ai-agents.md), and the platform's own "replied" event flows through the
//     same classification path email replies use.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";
import { env } from "../_core/env";

export type MessagingChannel = "telegram" | "whatsapp";

export const MESSAGING_CHANNELS: readonly MessagingChannel[] = ["telegram", "whatsapp"];

export interface ChannelSendResult {
  provider: MessagingChannel | "mock";
  externalMessageId: string;
  delivered: boolean;
  /** Nothing was really delivered; callers must say so instead of "sent". */
  simulated: boolean;
  error: string | null;
}

// ── What this deployment can actually do ──────────────────────────────────────

export interface ChannelCapability {
  /** An outbound API call is possible. */
  sender: boolean;
  /** Inbound events can be received, which is the only way consent can ever appear. */
  inbound: boolean;
  /** The t.me / wa.me link that starts a conversation can be built. */
  entryPoint: boolean;
}

/**
 * Reported separately on purpose: a sender without inbound is a broken deployment,
 * not a channel with no takers yet — permission can never be created, so the channel
 * will stay empty forever and the operator is the only one who can fix it.
 */
export function channelCapability(): Record<MessagingChannel, ChannelCapability> {
  return {
    telegram: {
      sender: Boolean(env.telegramBotToken),
      inbound: Boolean(env.telegramBotToken && env.telegramWebhookSecret),
      entryPoint: Boolean(env.telegramBotUsername),
    },
    whatsapp: {
      sender: Boolean(env.whatsappAccessToken && env.whatsappPhoneNumberId),
      inbound: Boolean(env.whatsappAccessToken && env.whatsappAppSecret),
      entryPoint: Boolean(env.whatsappPhoneNumberId),
    },
  };
}

export function isMessagingChannel(value: unknown): value is MessagingChannel {
  return value === "telegram" || value === "whatsapp";
}

/** The address of record for a channel message, in the column email also uses. */
export function channelAddress(channel: MessagingChannel, externalId: string): string {
  return `${channel}:${externalId}`.slice(0, 320);
}

/**
 * Link that turns an email reader into someone who chose a channel. The `start`
 * parameter carries our per-message reference so the inbound event can be attributed
 * to the prospect the email was written for; without it the bot would meet a stranger.
 */
export function telegramDeepLink(username: string, startParam?: string): string {
  const clean = username.replace(/^@/, "").trim();
  const base = `https://t.me/${clean}`;
  return startParam ? `${base}?start=${encodeURIComponent(startParam)}` : base;
}

/** Click-to-chat link. No carrier of metadata is possible, so attribution is by phone. */
export function whatsappDeepLink(phone: string, text?: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  const base = `https://wa.me/${digits}`;
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
}

// ── Provider requests (pure: the shape of each call is a test, not a live API) ──

export interface HttpCall {
  url: string;
  init: RequestInit;
}

const TELEGRAM_API_BASE = "https://api.telegram.org";
const WHATSAPP_GRAPH_VERSION = "v21.0";

/**
 * sendMessage. `chat_id` is the identifier the person's own /start produced — never a
 * number we found ourselves. parse_mode is deliberately unset: a stray `_` in a
 * sentence must not turn into formatting that mangles the message.
 */
export function telegramSendRequest(botToken: string, chatId: string, text: string): HttpCall {
  return {
    url: `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true }),
    },
  };
}

/**
 * Send a plain text reply inside the user-opened window. No template, so nothing here
 * can be a business-initiated message: the API will reject it outside 24 h, and
 * permissionToSend refuses it before we ever ask.
 */
export function whatsappSendRequest(
  accessToken: string,
  phoneNumberId: string,
  toExternalId: string,
  text: string,
): HttpCall {
  return {
    url: `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toExternalId,
        type: "text",
        text: { body: text.slice(0, 4096) },
      }),
    },
  };
}

/**
 * Tell Telegram where to deliver updates. The secret is supplied at registration and
 * the platform echoes it back on every call — the only authentication it offers.
 * setWebhook is HTTPS-only, so it cannot be pointed at a localhost.
 */
export function telegramSetWebhookRequest(botToken: string, url: string, secret: string): HttpCall {
  return {
    url: `${TELEGRAM_API_BASE}/bot${botToken}/setWebhook`,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, secret_token: secret, drop_pending_updates: false }),
    },
  };
}

// ── Inbound: verification, then parsing ───────────────────────────────────────

/**
 * Telegram's webhook secret is compared here rather than trusted upstream: the header
 * is the only proof that the call came to *our* registered webhook with *our* token,
 * and an unset secret means the endpoint accepts nothing.
 */
export function telegramSecretMatches(header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  // timingSafeEqual throws on length mismatch, and a wrong-length secret is still a
  // mismatch — so return false rather than letting an attacker probe with short values.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Meta signs the raw body with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function whatsappSignatureValid(header: string | undefined, rawBody: string, appSecret: string): boolean {
  if (!appSecret || !header || !rawBody) return false;
  const provided = header.replace(/^sha256=/, "");
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ChannelInbound {
  channel: MessagingChannel;
  /** Platform id of the *person*: Telegram user id, WhatsApp sender number. */
  externalId: string;
  handle: string | null;
  text: string | null;
  /** The reference from t.me/<bot>?start=<ref>, when this message carried one. */
  startParam: string | null;
  /** The person told the platform to stop. Consent is revoked, not merely absent. */
  revoking: boolean;
  at: Date;
  dedupeKey: string;
}

const STOP_WORDS = ["stop", "unsubscribe", "opt out", "optout", "отписаться", "стоп"];

/** Punctuation that can follow a command word without changing its meaning. */
const SEPARATOR = /[\s.,!?;:]/;

/**
 * Reads as an opt-out when the message *begins* with one of these words.
 *
 * Biased deliberately toward refusal: "stop by the office" would be misread as an
 * opt-out, and that is the acceptable error — a wrongly honoured revocation stops a
 * channel until the person writes again (which restores it), whereas a missed "STOP."
 * is messaging someone who told us not to. Only a leading word counts, so "please do
 * not stop replying" stays a conversation.
 */
function isRevocation(text: string | null): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase().replace(/^[.,!?;:\s]+|[.,!?;:\s]+$/g, "");
  return STOP_WORDS.some((word) => {
    if (normalized === word) return true;
    if (!normalized.startsWith(word)) return false;
    const next = normalized[word.length];
    return next !== undefined && SEPARATOR.test(next);
  });
}

/**
 * An update from a real user, or null when it is not something that can create consent:
 * bot-to-bot traffic, edited messages, callback presses, channel posts. The last one
 * matters — a message in a public channel is not a person writing to us.
 */
export function parseTelegramUpdate(update: unknown): ChannelInbound | null {
  const u = update as
    | {
        update_id?: number;
        message?: {
          from?: { id?: number; username?: string; is_bot?: boolean };
          chat?: { id?: number };
          text?: string;
        };
      }
    | null;
  const message = u?.message;
  const from = message?.from;
  if (!message || !from || typeof from.id !== "number" || from.is_bot) return null;
  const text = typeof message.text === "string" ? message.text : null;
  // Telegram prefixes a deep-link start with "/start <param>".
  const startParam = text?.startsWith("/start") ? text.slice("/start".length).trim() || null : null;
  return {
    channel: "telegram",
    externalId: String(from.id),
    handle: from.username ? `@${from.username}` : null,
    text,
    startParam,
    revoking: isRevocation(text),
    at: new Date(),
    dedupeKey: `telegram:${u?.update_id ?? randomUUID()}`.slice(0, 128),
  };
}

/** Meta batches changes; each contact can carry several messages, oldest first. */
export function parseWhatsAppWebhook(body: unknown): ChannelInbound[] {
  const b = body as {
    entry?: {
      changes?: {
        field?: string;
        value?: {
          messaging_product?: string;
          contacts?: { profile?: { name?: string }; wa_id?: string }[];
          messages?: { id?: string; from?: string; type?: string; text?: { body?: string } }[];
          statuses?: { id?: string; status?: string }[];
        };
      }[];
    }[];
  } | null;
  const out: ChannelInbound[] = [];
  for (const entry of b?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (value?.messaging_product !== "whatsapp") continue;
      const profileName = value.contacts?.[0]?.profile?.name ?? null;
      for (const message of value.messages ?? []) {
        if (!message.from) continue;
        const text = message.type === "text" ? message.text?.body ?? null : null;
        out.push({
          channel: "whatsapp",
          externalId: message.from,
          handle: profileName,
          text,
          // WhatsApp carries no reference of ours; attribution is by the number.
          startParam: null,
          revoking: isRevocation(text),
          at: new Date(),
          dedupeKey: `whatsapp:${message.id ?? randomUUID()}`.slice(0, 128),
        });
      }
    }
  }
  return out;
}

// ── The permission decision ───────────────────────────────────────────────────

export interface ChannelIdentity {
  id: string;
  workspaceId: string;
  prospectId: string;
  channel: MessagingChannel;
  externalId: string;
  handle: string | null;
  consentSource: string;
  consentAt: Date;
  revokedAt: Date | null;
  lastInboundAt: Date | null;
}

export type SendPermission = { allowed: true } | { allowed: false; reason: string };

/**
 * WhatsApp's own rule, expressed as code: free text is only answerable inside the
 * window the *recipient* opened. `hours` is capped by the platform, so the setting can
 * shorten our window but cannot buy a longer one than Meta allows.
 */
export function windowOpen(lastInboundAt: Date | null, now: Date, hours: number): boolean {
  if (!lastInboundAt) return false;
  const capped = Math.min(Math.max(hours, 0), 24);
  return now.getTime() - lastInboundAt.getTime() <= capped * 60 * 60 * 1000;
}

/**
 * Why a message may or may not go out on this channel, in the order that matters:
 * no permission, then permission withdrawn, then the platform's own limits. The
 * reasons are written to be shown to a human — each one says what to do about it.
 */
export function permissionToSend(
  identity: ChannelIdentity | null,
  args: { channel: MessagingChannel; now: Date; windowHours?: number },
): SendPermission {
  if (!identity) {
    return {
      allowed: false,
      reason:
        "This person has never written to us on this channel. Ask them to start the chat — on Telegram by clicking the link in your email.",
    };
  }
  if (identity.revokedAt) {
    return { allowed: false, reason: `They asked to stop on ${identity.revokedAt.toISOString()}. This cannot be overridden.` };
  }
  if (args.channel === "whatsapp") {
    const hours = args.windowHours ?? env.messengerWindowHours;
    if (!windowOpen(identity.lastInboundAt, args.now, hours)) {
      return {
        allowed: false,
        reason:
          "WhatsApp's reply window is closed — free text is only allowed within 24 h of their last message. Write on email instead.",
      };
    }
  }
  return { allowed: true };
}

// ── Persistence ───────────────────────────────────────────────────────────────

type Db = NonNullable<ReturnType<typeof getDb>>;

/** The prospect a deep-link reference belongs to, resolved from the sent message. */
async function ownerFromReference(db: Db, referenceId: string): Promise<{ workspaceId: string; prospectId: string } | null> {
  const [msg] = await db
    .select({ workspaceId: schema.outreachMessages.workspaceId, prospectId: schema.outreachMessages.prospectId })
    .from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.referenceId, referenceId))
    .limit(1);
  return msg ?? null;
}

/**
 * Match an inbound WhatsApp number to a prospect through the phone we hold for them.
 * Compared on digits only, in JS rather than SQL: a stored "+7 (495) 123-45-67" and the
 * "74951234567" the platform sends are the same number, and no collation makes that
 * equal.
 */
async function ownerFromPhone(db: Db, workspaceId: string, phone: string): Promise<string | null> {
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length < 8) return null;
  const candidates = await db
    .select({ prospectId: schema.prospects.id, phone: schema.contacts.phone })
    .from(schema.prospects)
    .innerJoin(schema.contacts, eq(schema.contacts.companyId, schema.prospects.companyId))
    .where(and(eq(schema.prospects.workspaceId, workspaceId), eq(schema.contacts.workspaceId, workspaceId)));
  const hit = candidates.find((c) => c.phone && c.phone.replace(/[^\d]/g, "") === digits);
  return hit?.prospectId ?? null;
}

export interface InboundOutcome {
  handled: boolean;
  duplicate?: boolean;
  attributed?: boolean;
  reason?: string;
  prospectId?: string | null;
  revoked?: boolean;
}

const NO_DB: InboundOutcome = { handled: false, reason: "db_unavailable" };

/**
 * Record an inbound platform event: the consent row it creates (or revokes), the
 * message itself, and the window clock. Attribution is mandatory — an event we cannot
 * tie to a prospect is stored nowhere, because a consent row without an owner would be
 * a licence to message an unknown person later, and a message with no prospect is
 * invisible noise.
 */
export async function recordChannelInbound(inbound: ChannelInbound): Promise<InboundOutcome> {
  const db = getDb();
  if (!db) return NO_DB;

  let workspaceId: string | null = null;
  let prospectId: string | null = null;
  if (inbound.startParam) {
    const owner = await ownerFromReference(db, inbound.startParam);
    if (owner) {
      workspaceId = owner.workspaceId;
      prospectId = owner.prospectId;
    }
  }
  if (!prospectId && inbound.channel === "whatsapp") {
    // WhatsApp gives us no reference of ours, so the only join available is the phone
    // number - and the same number may exist in several tenants. Searching every
    // workspace is therefore allowed only to *disambiguate*: exactly one match binds
    // the message, two or more bind nothing, because writing prospect A's conversation
    // into tenant B's pipeline is the cross-tenant leak this whole path exists to avoid.
    const matches: { workspaceId: string; prospectId: string }[] = [];
    const workspaces = await db.select({ id: schema.workspaces.id }).from(schema.workspaces).limit(200);
    for (const ws of workspaces) {
      const found = await ownerFromPhone(db, ws.id, inbound.externalId);
      if (found) matches.push({ workspaceId: ws.id, prospectId: found });
      if (matches.length > 1) break;
    }
    if (matches.length === 1) {
      workspaceId = matches[0].workspaceId;
      prospectId = matches[0].prospectId;
    } else if (matches.length > 1) {
      return { handled: true, attributed: false, reason: "number_matches_multiple_workspaces" };
    }
  }
  if (!prospectId) {
    return { handled: true, attributed: false, reason: "no_prospect_for_this_sender" };
  }

  const existing = await findIdentity(db, {
    workspaceId: workspaceId!,
    channel: inbound.channel,
    externalId: inbound.externalId,
  });

  if (inbound.revoking) {
    if (!existing) return { handled: true, attributed: true, revoked: false, reason: "nothing_to_revoke" };
    await db
      .update(schema.channelIdentities)
      .set({ revokedAt: inbound.at })
      .where(eq(schema.channelIdentities.id, existing.id));
    return { handled: true, attributed: true, revoked: true, prospectId };
  }

  if (existing) {
    // The person wrote again: the window reopens, and a row that had been revoked
    // comes back only because *they* initiated it — consent they withdrew is not
    // ours to keep honouring after they start talking again.
    await db
      .update(schema.channelIdentities)
      .set({ lastInboundAt: inbound.at, revokedAt: null })
      .where(eq(schema.channelIdentities.id, existing.id));
  } else {
    await db.insert(schema.channelIdentities).values({
      id: nanoid(),
      workspaceId: workspaceId!,
      prospectId,
      channel: inbound.channel,
      externalId: inbound.externalId,
      handle: inbound.handle,
      consentSource: inbound.startParam ? "telegram.start" : `${inbound.channel}.inbound`,
      consentAt: inbound.at,
      lastInboundAt: inbound.at,
    });
  }

  // The conversation belongs in the same timeline email replies use, so the thread
  // and the reply classifier see it without learning about this channel.
  const inserted = await db
    .insert(schema.emailEvents)
    .ignore()
    .values({
      id: nanoid(),
      workspaceId: workspaceId!,
      prospectId,
      eventType: "replied",
      direction: "inbound",
      fromAddress: channelAddress(inbound.channel, inbound.externalId),
      subject: `${inbound.channel} message${inbound.handle ? ` from ${inbound.handle}` : ""}`.slice(0, 500),
      bodyText: inbound.text,
      dedupeKey: inbound.dedupeKey,
      metadata: { channel: inbound.channel, externalId: inbound.externalId, handle: inbound.handle },
    });
  const duplicate = ((inserted as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0) === 0;
  return { handled: true, attributed: true, duplicate, prospectId };
}

async function findIdentity(
  db: Db,
  args: { workspaceId: string; channel: MessagingChannel; externalId: string },
): Promise<typeof schema.channelIdentities.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(schema.channelIdentities)
    .where(
      and(
        eq(schema.channelIdentities.workspaceId, args.workspaceId),
        eq(schema.channelIdentities.channel, args.channel),
        eq(schema.channelIdentities.externalId, args.externalId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Everything the interface may claim about a prospect's non-email channels. */
export async function listProspectIdentities(workspaceId: string, prospectId: string): Promise<ChannelIdentity[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(schema.channelIdentities)
    .where(and(eq(schema.channelIdentities.workspaceId, workspaceId), eq(schema.channelIdentities.prospectId, prospectId)));
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    prospectId: r.prospectId,
    channel: r.channel as MessagingChannel,
    externalId: r.externalId,
    handle: r.handle ?? null,
    consentSource: r.consentSource,
    consentAt: r.consentAt ?? new Date(),
    revokedAt: r.revokedAt ?? null,
    lastInboundAt: r.lastInboundAt ?? null,
  }));
}

export interface ChannelSendInput {
  workspaceId: string;
  prospectId: string;
  channel: MessagingChannel;
  text: string;
  /**
   * Injectable for tests: the provider call is one POST, and its exact shape is what
   * a unit test should pin rather than something only a live API can check.
   */
  fetchImpl?: typeof fetch;
}

export class ChannelError extends Error {}

/**
 * Send on a channel. Manual only, by design: an autopilot that writes on Telegram or
 * WhatsApp would be multiplying the reach of a sender whose reputation on those
 * platforms is one complaint from being suspended. Approval stays with a person.
 */
export async function sendChannelMessage(input: ChannelSendInput): Promise<ChannelSendResult> {
  const db = getDb();
  if (!db) throw new ChannelError("Database unavailable.");
  const text = input.text.trim();
  if (!text) throw new ChannelError("Nothing to send.");

  const [prospect] = await db
    .select({ id: schema.prospects.id })
    .from(schema.prospects)
    .where(and(eq(schema.prospects.id, input.prospectId), eq(schema.prospects.workspaceId, input.workspaceId)))
    .limit(1);
  if (!prospect) throw new ChannelError("Prospect not found in this workspace.");

  const identity = await identityForProspect(db, input.workspaceId, input.prospectId, input.channel);
  const permission = permissionToSend(identity, { channel: input.channel, now: new Date() });
  if (!permission.allowed || !identity) {
    throw new ChannelError(permission.allowed ? "No consent on this channel." : permission.reason);
  }

  const capability = channelCapability()[input.channel];
  const outreachId = nanoid();
  const referenceId = nanoid(16);
  const recipient = channelAddress(input.channel, identity.externalId);

  await db.insert(schema.outreachMessages).values({
    id: outreachId,
    workspaceId: input.workspaceId,
    prospectId: input.prospectId,
    recipientEmail: recipient,
    channel: input.channel,
    recipientName: identity.handle ?? null,
    subject: "",
    body: text,
    status: "sending",
    referenceId,
  });

  if (!capability.sender) {
    // Recorded, not delivered, and said as much — the same honesty the mock email
    // provider is held to: a row must never look like a message nobody sent.
    await db
      .update(schema.outreachMessages)
      .set({ status: "sent", sentAt: new Date(), error: `simulated (${input.channel} sender not configured)` })
      .where(eq(schema.outreachMessages.id, outreachId));
    return {
      provider: "mock",
      externalMessageId: `mock-${outreachId}`,
      delivered: false,
      simulated: true,
      error: null,
    };
  }

  const call =
    input.channel === "telegram"
      ? telegramSendRequest(env.telegramBotToken, identity.externalId, text)
      : whatsappSendRequest(env.whatsappAccessToken, env.whatsappPhoneNumberId, identity.externalId, text);

  try {
    const doFetch = input.fetchImpl ?? fetch;
    const response = await doFetch(call.url, call.init);
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { message_id?: number | string };
      error?: { message?: string };
      messages?: { id?: string }[];
    };
    // Both providers answer 200 with ok:false when the chat is gone (person blocked
    // the bot). That is a revocation, not a retry: recording it as sent would be a lie.
    if (!response.ok || payload.ok === false) {
      const message = payload.error?.message ?? `HTTP ${response.status}`;
      const blocked = /bot was blocked|user is deactivated|Chat not found|recipient not in session/i.test(message);
      if (blocked) {
        await db.update(schema.channelIdentities).set({ revokedAt: new Date() }).where(eq(schema.channelIdentities.id, identity.id));
      }
      await db
        .update(schema.outreachMessages)
        .set({ status: "failed", error: message })
        .where(eq(schema.outreachMessages.id, outreachId));
      return { provider: input.channel, externalMessageId: "", delivered: false, simulated: false, error: message };
    }
    const externalMessageId = String(payload.result?.message_id ?? payload.messages?.[0]?.id ?? outreachId);
    await db
      .update(schema.outreachMessages)
      .set({ status: "sent", sentAt: new Date(), providerMessageId: externalMessageId })
      .where(eq(schema.outreachMessages.id, outreachId));
    return { provider: input.channel, externalMessageId, delivered: true, simulated: false, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "channel send failed";
    await db
      .update(schema.outreachMessages)
      .set({ status: "failed", error: message })
      .where(eq(schema.outreachMessages.id, outreachId));
    return { provider: input.channel, externalMessageId: "", delivered: false, simulated: false, error: message };
  }
}

async function identityForProspect(db: Db, workspaceId: string, prospectId: string, channel: MessagingChannel) {
  const [row] = await db
    .select()
    .from(schema.channelIdentities)
    .where(
      and(
        eq(schema.channelIdentities.workspaceId, workspaceId),
        eq(schema.channelIdentities.prospectId, prospectId),
        eq(schema.channelIdentities.channel, channel),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    prospectId: row.prospectId,
    channel: row.channel as MessagingChannel,
    externalId: row.externalId,
    handle: row.handle ?? null,
    consentSource: row.consentSource,
    consentAt: row.consentAt ?? new Date(),
    revokedAt: row.revokedAt ?? null,
    lastInboundAt: row.lastInboundAt ?? null,
  } satisfies ChannelIdentity;
}

/** Operator-facing revocation (Settings/Admin): honour an opt-out learned offline. */
export async function revokeChannelIdentity(workspaceId: string, identityId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const result = await db
    .update(schema.channelIdentities)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.channelIdentities.workspaceId, workspaceId), eq(schema.channelIdentities.id, identityId)));
  return ((result as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0) > 0;
}
