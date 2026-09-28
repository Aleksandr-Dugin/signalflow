// Unit tests for the non-email channel layer (P2.9). These cover the parts that are
// pure decisions — what counts as consent, what may be sent, whether an inbound call
// is genuine — because those are the rules that keep this from becoming a cold
// messaging machine, and they are all checkable without a platform account.
import { describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import {
  channelAddress,
  isMessagingChannel,
  MESSAGING_CHANNELS,
  parseTelegramUpdate,
  parseWhatsAppWebhook,
  permissionToSend,
  telegramDeepLink,
  telegramSecretMatches,
  telegramSendRequest,
  telegramSetWebhookRequest,
  whatsappSendRequest,
  whatsappSignatureValid,
  windowOpen,
  type ChannelIdentity,
  type SendPermission,
} from "./services/channels";

/** The reason text, asserting the refusal the caller expects before reading it. */
function refusal(result: SendPermission): string {
  if (result.allowed) throw new Error("expected a refusal, got permission");
  return result.reason;
}

function headersOf(call: { init: RequestInit }): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  return JSON.parse(call.init.body as string);
}

function identity(overrides: Partial<ChannelIdentity> = {}): ChannelIdentity {
  const now = new Date("2026-09-28T12:00:00Z");
  return {
    id: "idn_1",
    workspaceId: "ws_1",
    prospectId: "pros_1",
    channel: "telegram",
    externalId: "123456",
    handle: "@someone",
    consentSource: "telegram.start",
    consentAt: now,
    revokedAt: null,
    lastInboundAt: now,
    ...overrides,
  };
}

describe("channel inventory", () => {
  it("recognises only the channels it can honour", () => {
    expect(isMessagingChannel("telegram")).toBe(true);
    expect(isMessagingChannel("whatsapp")).toBe(true);
    // Email is not a messaging channel here: it has its own suppression model, and
    // letting it through this gate would subject it to messenger rules it does not have.
    expect(isMessagingChannel("email")).toBe(false);
    expect(isMessagingChannel("sms")).toBe(false);
    expect(MESSAGING_CHANNELS).toEqual(["telegram", "whatsapp"]);
  });

  it("addresses a recipient in the column email shares, without looking like an email", () => {
    expect(channelAddress("telegram", "123456")).toBe("telegram:123456");
    expect(channelAddress("whatsapp", "15551234567")).toBe("whatsapp:15551234567");
    expect(channelAddress("telegram", "x".repeat(500)).length).toBeLessThanOrEqual(320);
  });
});

describe("telegramDeepLink", () => {
  it("carries our reference so the inbound event can be attributed", () => {
    expect(telegramDeepLink("mybot", "abc123")).toBe("https://t.me/mybot?start=abc123");
  });

  it("tolerates the @ a username is often written with", () => {
    expect(telegramDeepLink("@mybot")).toBe("https://t.me/mybot");
  });

  it("omits the start parameter rather than sending a bare marker", () => {
    expect(telegramDeepLink("mybot")).toBe("https://t.me/mybot");
    expect(telegramDeepLink("mybot", "")).toBe("https://t.me/mybot");
  });
});

describe("parseTelegramUpdate", () => {
  const message = (over: Record<string, unknown> = {}) => ({
    update_id: 42,
    message: {
      from: { id: 777, username: "peer", is_bot: false },
      chat: { id: 777 },
      text: "hello",
      ...over,
    },
  });

  it("accepts a person's message and reads the /start parameter", () => {
    const inbound = parseTelegramUpdate(message({ text: "/start ref_99" }));
    expect(inbound).not.toBeNull();
    expect(inbound!.externalId).toBe("777");
    expect(inbound!.handle).toBe("@peer");
    expect(inbound!.startParam).toBe("ref_99");
    expect(inbound!.revoking).toBe(false);
  });

  it("refuses anything that cannot grant consent", () => {
    // A bot is not a person, so it cannot ask us to be left alone or agree to be written to.
    expect(parseTelegramUpdate(message({ from: { id: 1, is_bot: true } }))).toBeNull();
    // A channel post is an audience, not a conversation.
    expect(parseTelegramUpdate({ update_id: 1, channel_post: { chat: { id: -100 }, text: "hi" } })).toBeNull();
    // An edit is not a new message; counting it would duplicate consent and the thread.
    expect(parseTelegramUpdate({ update_id: 1, edited_message: message().message })).toBeNull();
    expect(parseTelegramUpdate({ update_id: 1 })).toBeNull();
    expect(parseTelegramUpdate(null)).toBeNull();
  });

  it("treats a bare /start as no reference at all", () => {
    const inbound = parseTelegramUpdate(message({ text: "/start" }));
    expect(inbound!.startParam).toBeNull();
  });

  it("recognises opt-out words in the languages the operator's prospects use", () => {
    for (const text of ["STOP", "stop", "unsubscribe", "opt out", "Отписаться", "стоп, пожалуйста"]) {
      expect(parseTelegramUpdate(message({ text }))!.revoking).toBe(true);
    }
    expect(parseTelegramUpdate(message({ text: "tell me more about pricing" }))!.revoking).toBe(false);
    // A word appearing mid-sentence is not a revocation; "stop" is a common verb.
    expect(parseTelegramUpdate(message({ text: "please do not stop replying" }))!.revoking).toBe(false);
  });

  it("accepts the false positive that errs toward silence", () => {
    // "Stop by the office" is English, not an opt-out - but reading it as one stops this
    // channel until the person writes again, while reading a real "STOP." as chatter
    // messages someone who told us not to. The test exists to keep that trade explicit.
    expect(parseTelegramUpdate(message({ text: "stop by the office tomorrow" }))!.revoking).toBe(true);
    expect(parseTelegramUpdate(message({ text: "  Unsubscribe!  " }))!.revoking).toBe(true);
  });

  it("keys deduplication off the platform's update id", () => {
    expect(parseTelegramUpdate(message())!.dedupeKey).toBe("telegram:42");
  });
});

describe("parseWhatsAppWebhook", () => {
  const body = (messages: unknown[]) => ({
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: "Ivan" }, wa_id: "15551234567" }],
              messages,
            },
          },
        ],
      },
    ],
  });

  it("reads each message as a separate inbound event", () => {
    const events = parseWhatsAppWebhook(
      body([
        { id: "wamid.A", from: "15550001111", type: "text", text: { body: "hi" } },
        { id: "wamid.B", from: "15550002222", type: "text", text: { body: "STOP" } },
      ]),
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.externalId).toBe("15550001111");
    expect(events[0]!.handle).toBe("Ivan");
    expect(events[1]!.revoking).toBe(true);
  });

  it("has no reference to trust, so attribution can only be the number", () => {
    const [event] = parseWhatsAppWebhook(body([{ id: "wamid.A", from: "15550001111", type: "text", text: { body: "/start x" } }]));
    expect(event!.startParam).toBeNull();
  });

  it("ignores delivery receipts and other products", () => {
    expect(parseWhatsAppWebhook(body([{ id: "x", status: "delivered" }]))).toHaveLength(0);
    expect(
      parseWhatsAppWebhook({ entry: [{ changes: [{ field: "x", value: { messaging_product: "messenger", messages: [] } }] }] }),
    ).toHaveLength(0);
    expect(parseWhatsAppWebhook({})).toHaveLength(0);
    expect(parseWhatsAppWebhook(null)).toHaveLength(0);
  });
});

describe("inbound authentication", () => {
  it("requires the telegram secret to be both set and equal", () => {
    const secret = randomBytes(16).toString("hex");
    expect(telegramSecretMatches(secret, secret)).toBe(true);
    expect(telegramSecretMatches(undefined, secret)).toBe(false);
    // An unset secret must not turn into "accept anything".
    expect(telegramSecretMatches("whatever", "")).toBe(false);
    // Different length would throw inside timingSafeEqual; it must read as a mismatch.
    expect(telegramSecretMatches("short", secret)).toBe(false);
    expect(telegramSecretMatches(`${secret}x`, secret)).toBe(false);
  });

  it("verifies Meta's signature over the exact raw body", () => {
    const appSecret = "test-app-secret";
    const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const good = `sha256=${createHmac("sha256", appSecret).update(raw, "utf8").digest("hex")}`;
    expect(whatsappSignatureValid(good, raw, appSecret)).toBe(true);
    expect(whatsappSignatureValid(good, raw + " ", appSecret)).toBe(false);
    expect(whatsappSignatureValid("sha256=deadbeef", raw, appSecret)).toBe(false);
    expect(whatsappSignatureValid(undefined, raw, appSecret)).toBe(false);
    expect(whatsappSignatureValid(good, raw, "")).toBe(false);
  });
});

describe("windowOpen", () => {
  const now = new Date("2026-09-28T12:00:00Z");
  const hoursBefore = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

  it("is closed without an inbound message", () => {
    expect(windowOpen(null, now, 24)).toBe(false);
  });

  it("is inclusive exactly at the boundary and closed after it", () => {
    expect(windowOpen(hoursBefore(24), now, 24)).toBe(true);
    expect(windowOpen(hoursBefore(24.5), now, 24)).toBe(false);
  });

  it("cannot be configured wider than the platform allows", () => {
    // The setting exists to be conservative, not to buy reach: 48 requested is 24 enforced.
    expect(windowOpen(hoursBefore(30), now, 48)).toBe(false);
    expect(windowOpen(hoursBefore(30), now, 24)).toBe(false);
  });
});

describe("permissionToSend", () => {
  const now = new Date("2026-09-28T12:00:00Z");

  it("refuses a person who never contacted us there, and says what to do", () => {
    const result = permissionToSend(null, { channel: "telegram", now });
    expect(result.allowed).toBe(false);
    expect(refusal(result)).toMatch(/never written to us/i);
    expect(refusal(result)).toMatch(/link in your email/i);
  });

  it("honours a revocation permanently", () => {
    const result = permissionToSend(identity({ revokedAt: new Date("2026-09-20T00:00:00Z") }), { channel: "telegram", now });
    expect(result.allowed).toBe(false);
    expect(refusal(result)).toMatch(/cannot be overridden/i);
  });

  it("checks the reply window only where the platform imposes one", () => {
    const stale = identity({ channel: "whatsapp", lastInboundAt: new Date("2026-09-20T00:00:00Z") });
    const closed = permissionToSend(stale, { channel: "whatsapp", now, windowHours: 24 });
    expect(closed.allowed).toBe(false);
    expect(refusal(closed)).toMatch(/Write on email instead/i);

    const fresh = identity({ channel: "whatsapp", lastInboundAt: new Date("2026-09-28T05:00:00Z") });
    expect(permissionToSend(fresh, { channel: "whatsapp", now, windowHours: 24 }).allowed).toBe(true);

    // Telegram chats stay open until the person closes them; no invented window here.
    expect(permissionToSend(identity({ lastInboundAt: new Date("2026-01-01T00:00:00Z") }), { channel: "telegram", now }).allowed).toBe(true);
  });

  it("prefers the reason a human must act on when several apply", () => {
    // Revoked *and* out of window: the revocation is the one that must never be bypassed.
    const result = permissionToSend(identity({ channel: "whatsapp", revokedAt: new Date("2026-09-01T00:00:00Z"), lastInboundAt: null }), {
      channel: "whatsapp",
      now,
    });
    expect(refusal(result)).toMatch(/asked to stop/i);
  });
});

describe("outbound request shapes", () => {
  it("sends plain text to telegram without a link preview", () => {
    const call = telegramSendRequest("123:ABC", "777", "hello there");
    expect(call.url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(bodyOf(call)).toEqual({ chat_id: "777", text: "hello there", disable_web_page_preview: true });
  });

  it("clips to the platform's message limit rather than failing at send time", () => {
    const call = telegramSendRequest("t", "1", "x".repeat(5000));
    expect((bodyOf(call).text as string).length).toBe(4096);
  });

  it("asks for a session message, never a template", () => {
    const call = whatsappSendRequest("token", "phone-number-id", "15550001111", "hi");
    expect(call.url).toContain("/phone-number-id/messages");
    expect(headersOf(call).authorization).toBe("Bearer token");
    const body = bodyOf(call);
    expect(body.type).toBe("text");
    expect(body.text).toEqual({ body: "hi" });
    expect(body).not.toHaveProperty("template");
  });

  it("registers the webhook with the secret the endpoint will demand", () => {
    const call = telegramSetWebhookRequest("tok", "https://host/api/channels/telegram", "s3cr3t");
    expect(call.url).toBe("https://api.telegram.org/bottok/setWebhook");
    expect(bodyOf(call)).toEqual({
      url: "https://host/api/channels/telegram",
      secret_token: "s3cr3t",
      drop_pending_updates: false,
    });
  });
});
