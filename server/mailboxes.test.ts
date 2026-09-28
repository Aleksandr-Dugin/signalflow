import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import * as schema from "../drizzle/schema";
import { closeDb, getDb } from "./_core/database";
import { env } from "./_core/env";
import { decryptSecret, encryptSecret, mailCryptoConfigured } from "./services/crypto";
import {
  buildState,
  exchangeCodeForTokens,
  fetchMailboxEmail,
  getUsableMailbox,
  MailboxGatedError,
  MailboxOAuthError,
  mailboxRedirectUri,
  parseState,
  refreshMailboxAccessToken,
  startMailboxOAuth,
} from "./services/mailOAuth";
import { parseGmailMessage, parseGraphMessage } from "./services/mailIngest";
import { buildRfc2822, resolveEmailProvider } from "./services/email";

/** A valid 32-byte AES key, base64 — the shape MAIL_CREDENTIAL_KEY must take. */
const GOOD_KEY = Buffer.alloc(32, 7).toString("base64");

// Snapshot every env var these tests touch and restore after each, so mutating the
// shared `env` object never leaks into another file (vitest runs one module graph).
const SNAPSHOT = {
  mailCredentialKey: env.mailCredentialKey,
  jwtSecret: env.jwtSecret,
  publicUrl: env.publicUrl,
  gmailOAuthClientId: env.gmailOAuthClientId,
  gmailOAuthClientSecret: env.gmailOAuthClientSecret,
  msOAuthClientId: env.msOAuthClientId,
  msOAuthClientSecret: env.msOAuthClientSecret,
  mailboxDeliveryVerified: env.mailboxDeliveryVerified,
  smtpReplyTo: env.smtpReplyTo,
};
afterEach(() => Object.assign(env, SNAPSHOT));

function withMailEnv(over: Partial<typeof SNAPSHOT> = {}): void {
  env.jwtSecret = "test-jwt-secret";
  env.publicUrl = "https://app.example.com";
  env.mailCredentialKey = GOOD_KEY;
  env.gmailOAuthClientId = "gmail-client";
  env.gmailOAuthClientSecret = "gmail-secret";
  env.msOAuthClientId = "";
  env.msOAuthClientSecret = "";
  env.mailboxDeliveryVerified = false;
  env.smtpReplyTo = "replies@example.com";
  Object.assign(env, over);
}

describe("crypto (AES-256-GCM at rest)", () => {
  it("round-trips a secret", () => {
    withMailEnv();
    const cipher = encryptSecret("ya29.access-token-value");
    expect(cipher.startsWith("v1:")).toBe(true);
    expect(cipher).not.toContain("ya29");
    expect(decryptSecret(cipher)).toBe("ya29.access-token-value");
  });

  it("produces a different cipher each time (random IV)", () => {
    withMailEnv();
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("returns null for an absent cipher (nothing stored), distinct from tampering", () => {
    withMailEnv();
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret("")).toBeNull();
  });

  it("throws on a tampered payload (GCM authentication)", () => {
    withMailEnv();
    const cipher = encryptSecret("token");
    const parts = cipher.split(":");
    parts[3] = Buffer.from("forged").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("fails closed when the key is unset or malformed", () => {
    env.mailCredentialKey = "";
    expect(mailCryptoConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/MAIL_CREDENTIAL_KEY/);

    env.mailCredentialKey = Buffer.alloc(16).toString("base64"); // wrong length
    expect(mailCryptoConfigured()).toBe(false);
  });
});

describe("OAuth state (CSRF / link-hijack guard)", () => {
  it("round-trips workspaceId + provider through the signed state", () => {
    withMailEnv();
    const state = buildState("ws_123", "microsoft");
    expect(state).toContain(".");
    expect(parseState(state)).toEqual({ workspaceId: "ws_123", provider: "microsoft" });
  });

  it("rejects a tampered signature and an unverifiable workspace claim", () => {
    withMailEnv();
    const state = buildState("ws_123", "gmail");
    const [payload] = state.split(".", 1);
    // Forged: valid payload shape but re-signed under a different secret is impossible
    // without the key, so just drop the signature.
    expect(parseState(`${payload}.not-the-real-sig`)).toBeNull();
    expect(parseState("garbage")).toBeNull();
    expect(parseState("")).toBeNull();
    expect(parseState(null)).toBeNull();
  });
});

describe("startMailboxOAuth (honest gate + consent URL)", () => {
  it("refuses when no OAuth app is registered (not a silent mock)", () => {
    withMailEnv({ gmailOAuthClientId: "", gmailOAuthClientSecret: "" });
    expect(() => startMailboxOAuth("ws_1", "gmail")).toThrow(MailboxOAuthError);
    try {
      startMailboxOAuth("ws_1", "gmail");
    } catch (e) {
      expect((e as MailboxOAuthError).code).toBe("OAUTH_NOT_CONFIGURED");
    }
  });

  it("refuses when tokens could not be stored securely (no credential key)", () => {
    withMailEnv({ mailCredentialKey: "" });
    try {
      startMailboxOAuth("ws_1", "gmail");
      expect.unreachable();
    } catch (e) {
      expect((e as MailboxOAuthError).code).toBe("NO_CREDENTIAL_KEY");
    }
  });

  it("builds a Google consent URL whose state decodes back to this workspace", () => {
    withMailEnv();
    const url = new URL(startMailboxOAuth("ws_42", "gmail"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe(mailboxRedirectUri());
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(parseState(url.searchParams.get("state"))).toEqual({ workspaceId: "ws_42", provider: "gmail" });
  });

  it("redirect URI points at the mounted callback route", () => {
    withMailEnv({ publicUrl: "https://app.example.com/" });
    expect(mailboxRedirectUri()).toBe("https://app.example.com/api/mailbox/oauth/callback");
  });
});

describe("token exchange / userinfo / refresh (fetch mocked)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exchanges an authorization code for tokens", async () => {
    withMailEnv();
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ access_token: "acc", refresh_token: "ref", expires_in: 3600, scope: "gmail.send" }),
    })) as any;
    const tokens = await exchangeCodeForTokens("gmail", "code-abc");
    expect(tokens.accessToken).toBe("acc");
    expect(tokens.refreshToken).toBe("ref");
    expect(tokens.expiresInSec).toBe(3600);
  });

  it("surfaces a failed exchange as a typed error", async () => {
    withMailEnv();
    globalThis.fetch = (async () => ({ ok: false, status: 400, json: async () => ({}) })) as any;
    await expect(exchangeCodeForTokens("gmail", "bad")).rejects.toMatchObject({ code: "TOKEN_EXCHANGE_FAILED" });
  });

  it("resolves the account email from provider userinfo", async () => {
    withMailEnv();
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ email: "me@gmail.example" }) };
    }) as any;
    expect(await fetchMailboxEmail("gmail", "acc")).toBe("me@gmail.example");
    expect(calls[0]).toBe("https://openidconnect.googleapis.com/v1/userinfo");
  });

  it("refreshes an access token from a refresh token", async () => {
    withMailEnv();
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ access_token: "fresh", expires_in: 100 }) })) as any;
    const r = await refreshMailboxAccessToken("gmail", "ref");
    expect(r.accessToken).toBe("fresh");
    expect(r.expiresInSec).toBe(100);
  });
});

describe("inbound payload mapping -> InboundEmailInput", () => {
  it("maps a Gmail reply, pulling the reference and a gmail: dedupe key", () => {
    const input = parseGmailMessage({
      id: "msg-1",
      snippet: "",
      payload: {
        headers: [
          { name: "From", value: "Bob <bob@prospect.example>" },
          { name: "To", value: "me@gmail.example" },
          { name: "Subject", value: "Re: hello" },
          { name: "X-SignalFlow-Ref", value: "REF123" },
        ],
        body: { data: Buffer.from("Sounds good.", "utf8").toString("base64url") },
      },
    });
    expect(input).toMatchObject({
      referenceId: "REF123",
      fromAddress: "bob@prospect.example",
      toAddress: "me@gmail.example",
      subject: "Re: hello",
      bodyText: "Sounds good.",
      eventType: "replied",
      dedupeKey: "gmail:msg-1",
    });
  });

  it("detects an unsubscribe reply", () => {
    const input = parseGmailMessage({
      id: "msg-2",
      payload: {
        headers: [{ name: "From", value: "bob@prospect.example" }],
        body: { data: Buffer.from("unsubscribe", "utf8").toString("base64url") },
      },
    });
    expect(input?.eventType).toBe("unsubscribed");
  });

  it("returns null when there is no sender to attribute", () => {
    expect(parseGmailMessage({ id: "x", payload: { headers: [] } })).toBeNull();
  });

  it("maps a Microsoft Graph reply", () => {
    const input = parseGraphMessage({
      id: "g-1",
      subject: "Re: quote",
      body: { content: "Send the deck." },
      from: { emailAddress: { address: "carol@prospect.example" } },
      toRecipients: [{ emailAddress: { address: "me@outlook.example" } }],
      internetMessageHeaders: [{ name: "X-SignalFlow-Ref", value: "REF9" }],
    });
    expect(input).toMatchObject({
      referenceId: "REF9",
      fromAddress: "carol@prospect.example",
      toAddress: "me@outlook.example",
      subject: "Re: quote",
      bodyText: "Send the deck.",
      dedupeKey: "graph:g-1",
    });
  });
});

describe("buildRfc2822 (mailbox send carries the compliance headers)", () => {
  it("sends From the mailbox and keeps the reference + unsubscribe legs", () => {
    withMailEnv();
    const raw = buildRfc2822(
      {
        toName: "Bob",
        toEmail: "bob@prospect.example",
        subject: "Hello Bob",
        text: "Body.",
        referenceId: "REF1",
        unsubscribeUrl: "https://app.example.com/api/replies/unsubscribe?ref=REF1",
      },
      { id: "m1", provider: "gmail", email: "me@gmail.example", accessToken: "acc", fromName: "Alice", replyTo: null },
    );
    expect(raw).toContain('From: "Alice" <me@gmail.example>');
    expect(raw).toContain("To: \"Bob\" <bob@prospect.example>");
    expect(raw).toContain("X-SignalFlow-Ref: REF1");
    expect(raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    // Reply-To falls back to the configured reply mailbox when the row has none.
    expect(raw).toContain("Reply-To: replies@example.com");
  });
});

describe("provider resolution", () => {
  it("with no workspace id, falls back to the global provider without touching mailboxes", async () => {
    // No DB in unit mode, and no workspaceId short-circuits the mailbox lookup.
    withMailEnv();
    const provider = await resolveEmailProvider(null);
    expect(["smtp", "mock"]).toContain(provider.name);
  });
});

// The gate itself lives in the mailbox table, so verifying it needs a real database.
// This mirrors integration.test.ts: it skips cleanly offline and runs under the CI
// `integration` job, which applies the migrations (workspace_mailboxes included).
const databaseConfigured = Boolean(process.env.DATABASE_URL);
const dbSuite = databaseConfigured ? describe : describe.skip;

dbSuite("mailbox gate + priority against a real database", () => {
  const run = nanoid(8);
  const gatedWs = `ws_gated_${run}`;
  const liveWs = `ws_live_${run}`;
  const userId = `u_${run}`;
  const db = getDb();

  beforeAll(async () => {
    if (!db) throw new Error("no db");
    withMailEnv();
    await db.insert(schema.users).values({ id: userId, email: `mb-${run}@acme-corp.example`, name: "MB Owner" });
    for (const [id, slug] of [
      [gatedWs, `mb-gated-${run}`],
      [liveWs, `mb-live-${run}`],
    ] as const) {
      await db.insert(schema.workspaces).values({ id, name: `MB ${slug}`, slug, ownerId: userId, planId: "pro" });
    }
    await db.insert(schema.workspaceMailboxes).values({
      id: `mb_${run}`,
      workspaceId: gatedWs,
      provider: "gmail",
      email: `gated-${run}@gmail.example`,
      status: "gated",
      accessTokenCipher: encryptSecret("gated-token"),
    });
    await db.insert(schema.workspaceMailboxes).values({
      id: `mb_live_${run}`,
      workspaceId: liveWs,
      provider: "gmail",
      email: `live-${run}@gmail.example`,
      status: "connected",
      accessTokenCipher: encryptSecret("live-token"),
      accessExpiresAt: new Date(Date.now() + 3600_000),
    });
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(schema.workspaces).where(eq(schema.workspaces.ownerId, userId));
    await closeDb().catch(() => {});
  });

  it("throws (never silently falls back) when a mailbox is linked but gated", async () => {
    await expect(getUsableMailbox(gatedWs)).rejects.toBeInstanceOf(MailboxGatedError);
    await expect(resolveEmailProvider(gatedWs)).rejects.toMatchObject({ code: "MAILBOX_GATED" });
  });

  it("returns a live mailbox with a decrypted access token when connected", async () => {
    const usable = await getUsableMailbox(liveWs);
    expect(usable?.email).toBe(`live-${run}@gmail.example`);
    expect(usable?.accessToken).toBe("live-token");
    const provider = await resolveEmailProvider(liveWs);
    expect(provider.name).toBe("mailbox");
  });
});
