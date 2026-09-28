import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";
import { env } from "../_core/env";
import { decryptSecret, encryptSecret, mailCryptoConfigured } from "./crypto";

/**
 * OAuth linking for "connect your own mailbox" (docs/launch.md free-tier notes).
 *
 * The whole point is that outreach leaves from a real person's address rather than a
 * shared throwaway domain. That is the honest reason the feature is gated: writing to
 * strangers through a Gmail/Microsoft mailbox requires an app the provider has
 * *verified*, and verification needs the deployed domain. Until the operator says
 * that is done (`MAILBOX_DELIVERY_VERIFIED`), a linked mailbox is stored with status
 * `gated` and nothing is sent — the code refuses instead of pretending, because a
 * half-configured sender either fails silently or gets the user's account flagged.
 */

export type MailboxProvider = "gmail" | "microsoft";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string | null;
  expiresInSec?: number | null;
  scope?: string | null;
  email?: string | null;
}

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: string;
  clientSecret: string;
}

export class MailboxOAuthError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

function providerConfig(provider: MailboxProvider): ProviderConfig | null {
  if (provider === "gmail") {
    if (!env.gmailOAuthClientId || !env.gmailOAuthClientSecret) return null;
    return {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      // gmail.send to write, gmail.readonly to ingest replies, offline_access so a
      // refresh token is issued (access tokens last an hour).
      scopes: [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly",
        "openid",
        "email",
      ],
      clientId: env.gmailOAuthClientId,
      clientSecret: env.gmailOAuthClientSecret,
    };
  }
  if (!env.msOAuthClientId || !env.msOAuthClientSecret) return null;
  return {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["Mail.Send", "Mail.Read", "offline_access", "openid", "email"],
    clientId: env.msOAuthClientId,
    clientSecret: env.msOAuthClientSecret,
  };
}

export function mailboxProviderConfigured(provider: MailboxProvider): boolean {
  return providerConfig(provider) !== null;
}

export function mailboxRedirectUri(): string {
  return `${env.publicUrl.replace(/\/$/, "")}/api/mailbox/oauth/callback`;
}

/**
 * A state that binds the consent round-trip to one workspace and provider. It is
 * signed (HMAC over the payload) so a callback cannot name an arbitrary workspace to
 * attach a mailbox to — the classic OAuth CSRF/link-hijack. Format: `payload.sig`.
 */
export function buildState(workspaceId: string, provider: MailboxProvider): string {
  const nonce = randomBytes(8).toString("hex");
  const payload = Buffer.from(JSON.stringify({ workspaceId, provider, nonce })).toString("base64url");
  return `${payload}.${signState(payload)}`;
}

function signState(payload: string): string {
  return createHmac("sha256", env.jwtSecret).update(payload).digest("base64url");
}

export function parseState(
  state: string | undefined | null,
): { workspaceId: string; provider: MailboxProvider } | null {
  if (!state || !state.includes(".")) return null;
  const [payload, sig] = state.split(".", 2);
  const expected = signState(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const provider: MailboxProvider = parsed.provider === "microsoft" ? "microsoft" : "gmail";
    if (!parsed.workspaceId) return null;
    return { workspaceId: String(parsed.workspaceId), provider };
  } catch {
    return null;
  }
}

/** Build the consent URL a user is redirected to. Refuses unless creds + key exist. */
export function startMailboxOAuth(workspaceId: string, provider: MailboxProvider): string {
  const cfg = providerConfig(provider);
  if (!cfg) {
    throw new MailboxOAuthError(
      "The operator has not registered an OAuth app for this provider; mailbox linking is unavailable.",
      "OAUTH_NOT_CONFIGURED",
    );
  }
  if (!mailCryptoConfigured()) {
    throw new MailboxOAuthError(
      "MAIL_CREDENTIAL_KEY is not set; tokens could not be stored securely, so linking is disabled.",
      "NO_CREDENTIAL_KEY",
    );
  }
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: mailboxRedirectUri(),
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state: buildState(workspaceId, provider),
    // Google needs these two to hand back a refresh token, not just a one-hour access
    // token; harmless for Microsoft which issues refresh via offline_access.
    access_type: "offline",
    prompt: "consent",
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

type FetchLike = typeof fetch;

/** Exchange an authorization code for tokens. Fetch is injectable for tests. */
export async function exchangeCodeForTokens(
  provider: MailboxProvider,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthTokens> {
  const cfg = providerConfig(provider);
  if (!cfg) throw new MailboxOAuthError("OAuth app not configured.", "OAUTH_NOT_CONFIGURED");
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: mailboxRedirectUri(),
    }).toString(),
  });
  if (!res.ok) {
    throw new MailboxOAuthError(`Token exchange failed (${res.status})`, "TOKEN_EXCHANGE_FAILED");
  }
  const json: any = await res.json();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresInSec: json.expires_in ? Number(json.expires_in) : null,
    scope: json.scope ?? null,
    // Google returns email/id_token only with the openid scope; tolerate absence.
    email: json.email ?? null,
  };
}

/**
 * Resolve the linked account's address from its access token. The token exchange does
 * not reliably return an email for either provider (Google only puts it in an id_token
 * we did not request here, Microsoft never does), but the mailbox row must be keyed by
 * an address, so we call the provider's own "who am I" endpoint. Fetch is injectable.
 */
export async function fetchMailboxEmail(
  provider: MailboxProvider,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const url =
    provider === "gmail"
      ? "https://openidconnect.googleapis.com/v1/userinfo"
      : "https://graph.microsoft.com/v1.0/me";
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const json: any = await res.json();
    const email = json?.email ?? json?.mail ?? json?.userPrincipalName ?? null;
    return email ? String(email) : null;
  } catch {
    return null;
  }
}

/**
 * Persist (or update) a linked mailbox. Status is `connected` only when the operator
 * has marked the app verified; otherwise `gated`, so send path refuses. Tokens are
 * encrypted here and never held in plaintext.
 */
export async function saveMailboxTokens(input: {
  workspaceId: string;
  provider: MailboxProvider;
  email: string;
  tokens: OAuthTokens;
  fromName?: string | null;
}): Promise<string> {
  const db = getDb();
  if (!db) throw new MailboxOAuthError("Database unavailable.", "DB_UNAVAILABLE");
  if (!mailCryptoConfigured()) {
    throw new MailboxOAuthError("MAIL_CREDENTIAL_KEY is not set.", "NO_CREDENTIAL_KEY");
  }

  const status: "connected" | "gated" = env.mailboxDeliveryVerified ? "connected" : "gated";
  const accessCipher = encryptSecret(input.tokens.accessToken);
  const refreshCipher = input.tokens.refreshToken ? encryptSecret(input.tokens.refreshToken) : null;
  const accessExpiresAt =
    input.tokens.expiresInSec != null ? new Date(Date.now() + input.tokens.expiresInSec * 1000) : null;

  const [existing] = await db
    .select()
    .from(schema.workspaceMailboxes)
    .where(
      and(
        eq(schema.workspaceMailboxes.workspaceId, input.workspaceId),
        eq(schema.workspaceMailboxes.email, input.email.toLowerCase()),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(schema.workspaceMailboxes)
      .set({
        provider: input.provider,
        status,
        accessTokenCipher: accessCipher,
        refreshTokenCipher: refreshCipher ?? existing.refreshTokenCipher,
        accessExpiresAt,
        scope: input.tokens.scope ?? null,
        fromName: input.fromName ?? existing.fromName,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.workspaceMailboxes.id, existing.id));
    return existing.id;
  }

  const id = nanoid();
  await db.insert(schema.workspaceMailboxes).values({
    id,
    workspaceId: input.workspaceId,
    provider: input.provider,
    email: input.email.toLowerCase(),
    status,
    accessTokenCipher: accessCipher,
    refreshTokenCipher: refreshCipher,
    accessExpiresAt,
    scope: input.tokens.scope ?? null,
    fromName: input.fromName ?? null,
  });
  return id;
}

/**
 * Refresh an access token from a stored refresh token. Access tokens are short-lived
 * (Google: ~1 hour), so every send that finds a near-expiry token goes through here
 * rather than firing a request that would come back 401.
 */
export async function refreshMailboxAccessToken(
  provider: MailboxProvider,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accessToken: string; expiresInSec: number | null }> {
  const cfg = providerConfig(provider);
  if (!cfg) throw new MailboxOAuthError("OAuth app not configured.", "OAUTH_NOT_CONFIGURED");
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new MailboxOAuthError(`Token refresh failed (${res.status})`, "TOKEN_REFRESH_FAILED");
  const json: any = await res.json();
  return { accessToken: json.access_token, expiresInSec: json.expires_in ? Number(json.expires_in) : null };
}

export class MailboxGatedError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export interface UsableMailbox {
  id: string;
  provider: MailboxProvider;
  email: string;
  accessToken: string;
  fromName: string | null;
  replyTo: string | null;
}

/**
 * The mailbox a workspace should send from, with a live access token — or null when
 * the workspace has not linked one (the caller then falls back to global SMTP/mock).
 *
 * A linked-but-`gated`/`error` mailbox does NOT fall back: someone chose to send from
 * their own address, and quietly sending from the app's shared server instead would
 * be its own surprise. That case throws, so the outreach record says plainly why
 * nothing went out.
 */
export async function getUsableMailbox(
  workspaceId: string,
  fetchImpl: FetchLike = fetch,
): Promise<UsableMailbox | null> {
  const db = getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(schema.workspaceMailboxes)
    .where(eq(schema.workspaceMailboxes.workspaceId, workspaceId))
    .orderBy(desc(schema.workspaceMailboxes.updatedAt));
  if (!rows.length) return null;

  const connected = rows.find((r) => r.status === "connected" && r.accessTokenCipher);
  if (!connected) {
    throw new MailboxGatedError(
      "A mailbox is linked but sending is gated: the deployment's OAuth app is not verified. " +
        "Complete provider verification, then set MAILBOX_DELIVERY_VERIFIED.",
      "MAILBOX_GATED",
    );
  }

  let accessToken = decryptSecret(connected.accessTokenCipher);
  const needsRefresh =
    !accessToken ||
    (connected.accessExpiresAt != null && connected.accessExpiresAt.getTime() - Date.now() < 60_000);
  if (needsRefresh && connected.refreshTokenCipher) {
    const refreshToken = decryptSecret(connected.refreshTokenCipher);
    if (refreshToken) {
      const fresh = await refreshMailboxAccessToken(connected.provider, refreshToken, fetchImpl);
      accessToken = fresh.accessToken;
      await db
        .update(schema.workspaceMailboxes)
        .set({
          accessTokenCipher: encryptSecret(fresh.accessToken),
          accessExpiresAt:
            fresh.expiresInSec != null ? new Date(Date.now() + fresh.expiresInSec * 1000) : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.workspaceMailboxes.id, connected.id));
    }
  }
  if (!accessToken) {
    throw new MailboxGatedError("Stored mailbox token could not be resolved.", "MAILBOX_NO_TOKEN");
  }

  return {
    id: connected.id,
    provider: connected.provider,
    email: connected.email,
    accessToken,
    fromName: connected.fromName,
    replyTo: connected.replyTo,
  };
}
