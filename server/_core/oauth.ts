import { nanoid } from "nanoid";
import { env } from "./env";

export type OAuthProvider = "google" | "github";

export interface OAuthProfile {
  provider: OAuthProvider;
  providerAccountId: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
}

const REDIRECT_PATH = "/api/auth/oauth/callback";

function redirectUri(): string {
  const base = env.publicUrl.replace(/\/$/, "");
  return `${base}${REDIRECT_PATH}`;
}

const stateStore = new Map<string, { provider: OAuthProvider; createdAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  }
}

export function isProviderConfigured(provider: OAuthProvider): boolean {
  return provider === "google"
    ? Boolean(env.googleClientId && env.googleClientSecret)
    : Boolean(env.githubClientId && env.githubClientSecret);
}

/** Build the provider authorize URL with a CSRF `state` nonce. */
export function getAuthorizeUrl(provider: OAuthProvider): { url: string; state: string } {
  pruneStates();
  const state = nanoid(24);
  stateStore.set(state, { provider, createdAt: Date.now() });
  const params = new URLSearchParams({ state });
  if (provider === "google") {
    if (!isProviderConfigured("google")) throw new Error("Google OAuth not configured");
    params.set("client_id", env.googleClientId);
    params.set("redirect_uri", redirectUri());
    params.set("response_type", "code");
    params.set("scope", "openid email profile");
    params.set("access_type", "online");
    params.set("prompt", "select_account");
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state };
  }
  if (!isProviderConfigured("github")) throw new Error("GitHub OAuth not configured");
  params.set("client_id", env.githubClientId);
  params.set("redirect_uri", redirectUri());
  params.set("scope", "read:user user:email");
  return { url: `https://github.com/login/oauth/authorize?${params}`, state };
}

export function consumeState(state: string): OAuthProvider | null {
  const entry = stateStore.get(state);
  if (!entry) return null;
  stateStore.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
  return entry.provider;
}

async function jsonFetch(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} responded ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    // GitHub token endpoint can return form-encoded
    const parsed = new URLSearchParams(text);
    return Object.fromEntries(parsed.entries());
  }
}

/** Exchange an authorization code for the profile. */
export async function exchangeCodeForProfile(
  provider: OAuthProvider,
  code: string,
): Promise<OAuthProfile> {
  if (provider === "google") {
    const tok = await jsonFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });
    if (!tok.access_token) throw new Error("Google did not return an access token");
    const me = await jsonFetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    return {
      provider: "google",
      providerAccountId: String(me.sub),
      email: me.email ? String(me.email) : null,
      name: String(me.name ?? me.email ?? "Google user"),
      avatarUrl: me.picture ? String(me.picture) : null,
    };
  }

  const tok = await jsonFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.githubClientId,
      client_secret: env.githubClientSecret,
      redirect_uri: redirectUri(),
    }),
  });
  if (!tok.access_token) throw new Error("GitHub did not return an access token");
  const me = await jsonFetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "signalflow" },
  });
  let email: string | null = me.email ?? null;
  if (!email) {
    try {
      const emails = await jsonFetch("https://api.github.com/user/emails", {
        headers: { Authorization: `Bearer ${tok.access_token}`, "User-Agent": "signalflow" },
      });
      const primary = Array.isArray(emails)
        ? emails.find((e: any) => e.primary && e.verified) ?? emails[0]
        : null;
      email = primary?.email ?? null;
    } catch {
      /* email is optional for GitHub */
    }
  }
  return {
    provider: "github",
    providerAccountId: String(me.id),
    email,
    name: String(me.login ?? me.name ?? email ?? "GitHub user"),
    avatarUrl: me.avatar_url ? String(me.avatar_url) : null,
  };
}
