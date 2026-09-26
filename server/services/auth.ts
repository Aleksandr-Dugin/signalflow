import { and, eq } from "drizzle-orm";
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import { SESSION_TTL_MS } from "../../shared/const";
import type { OAuthProfile } from "../_core/oauth";
import { getDb, type DB } from "../_core/database";
import { isAdminEmail } from "../_core/env";
import { signSession } from "../_core/sdk";

const scrypt = promisify(_scrypt) as (password: any, salt: any, keylen: number, opts: any) => Promise<Buffer>;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface IssuedSession {
  token: string;
  maxAgeSec: number;
  user: AuthenticatedUser;
}

export class AuthError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password.normalize("NFKC"), salt, 64, SCRYPT_PARAMS);
  return `scrypt:${SCRYPT_PARAMS.N}:${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, salt, hex] = stored.split(":");
  if (scheme !== "scrypt" || !n || !salt || !hex) return false;
  const key = await scrypt(password.normalize("NFKC"), salt, 64, {
    ...SCRYPT_PARAMS,
    N: Number.parseInt(n, 10),
  });
  const expected = Buffer.from(hex, "hex");
  if (expected.length !== key.length) return false;
  return timingSafeEqual(key, expected);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function findUserByEmail(db: DB, email: string): Promise<schema.User | undefined> {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
  return row;
}

async function getOrCreateWorkspaceFor(db: DB, user: schema.User): Promise<string> {
  const [existing] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.ownerId, user.id))
    .limit(1);
  if (existing) return existing.id;

  const id = nanoid();
  const slug = `ws-${user.id.slice(0, 8)}`;
  await db.insert(schema.workspaces).values({
    id,
    name: `${user.name || user.email || "My"} workspace`,
    slug,
    ownerId: user.id,
    planId: "free",
  });
  await db.insert(schema.workspaceMembers).values({
    id: nanoid(),
    workspaceId: id,
    userId: user.id,
    role: "owner",
  });
  return id;
}

export async function ensureWorkspace(userId: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) return null;
  return getOrCreateWorkspaceFor(db, user);
}

async function createSession(
  db: DB,
  user: schema.User,
  meta: { userAgent?: string; ip?: string },
): Promise<IssuedSession> {
  // Admin bootstrap: an email on the ADMIN_EMAILS allow-list is promoted to the
  // `admin` role on every sign-in (covers pre-existing users too). The session
  // context re-reads users.role per request, so this takes effect immediately.
  if (isAdminEmail(user.email) && user.role !== "admin") {
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, user.id));
    user = { ...user, role: "admin" };
  }
  const { token, jti, expiresAt } = await signSession(
    { sub: user.id, name: user.name, email: user.email ?? "" },
    SESSION_TTL_MS,
  );
  await db.insert(schema.sessions).values({
    id: jti,
    userId: user.id,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
    ip: meta.ip?.slice(0, 64) ?? null,
    expiresAt,
  });
  return {
    token,
    maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
    user: { id: user.id, name: user.name, email: user.email ?? "", avatarUrl: user.avatarUrl },
  };
}

export async function register(opts: {
  email: string;
  password: string;
  name: string;
  userAgent?: string;
  ip?: string;
}): Promise<IssuedSession> {
  const db = getDb();
  if (!db) throw new AuthError("Database is not configured.", "DB_UNAVAILABLE");
  const email = normalizeEmail(opts.email);
  if (!email.includes("@")) throw new AuthError("A valid email is required.", "INVALID_EMAIL");
  if (opts.password.length < 8) {
    throw new AuthError("Password must be at least 8 characters.", "WEAK_PASSWORD");
  }
  if (await findUserByEmail(db, email)) {
    throw new AuthError("An account with this email already exists.", "EMAIL_TAKEN");
  }
  const id = nanoid();
  const passwordHash = await hashPassword(opts.password);
  const name = opts.name?.trim() || email.split("@")[0];
  await db.insert(schema.users).values({ id, email, name, passwordHash });
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  await db.insert(schema.oauthAccounts).values({
    id: nanoid(),
    userId: id,
    provider: "email",
    providerAccountId: email,
    email,
  });
  await getOrCreateWorkspaceFor(db, user);
  return createSession(db, user, opts);
}

export async function loginWithPassword(opts: {
  email: string;
  password: string;
  userAgent?: string;
  ip?: string;
}): Promise<IssuedSession> {
  const db = getDb();
  if (!db) throw new AuthError("Database is not configured.", "DB_UNAVAILABLE");
  const email = normalizeEmail(opts.email);
  const user = await findUserByEmail(db, email);
  const ok = await verifyPassword(opts.password, user?.passwordHash ?? null);
  if (!user || !ok) {
    // Uniform error — do not reveal whether the email exists.
    throw new AuthError("Invalid email or password.", "INVALID_CREDENTIALS");
  }
  await getOrCreateWorkspaceFor(db, user);
  return createSession(db, user, opts);
}

/** Log in (or create) a user from a verified OAuth profile. */
export async function loginWithOAuth(
  profile: OAuthProfile,
  meta: { userAgent?: string; ip?: string },
): Promise<IssuedSession> {
  const db = getDb();
  if (!db) throw new AuthError("Database is not configured.", "DB_UNAVAILABLE");
  const email = profile.email ? normalizeEmail(profile.email) : null;

  const [linked] = await db
    .select()
    .from(schema.oauthAccounts)
    .where(
      and(
        eq(schema.oauthAccounts.provider, profile.provider),
        eq(schema.oauthAccounts.providerAccountId, profile.providerAccountId),
      ),
    )
    .limit(1);

  let user: schema.User | undefined;
  if (linked) {
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, linked.userId)).limit(1);
    user = u;
  } else if (email) {
    // Link to an existing email account, otherwise create a new one.
    user = await findUserByEmail(db, email);
    if (!user) {
      const id = nanoid();
      await db.insert(schema.users).values({
        id,
        email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
      });
      const [created] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
      user = created;
    }
    await db.insert(schema.oauthAccounts).values({
      id: nanoid(),
      userId: user!.id,
      provider: profile.provider,
      providerAccountId: profile.providerAccountId,
      email,
    });
  } else {
    throw new AuthError("OAuth account did not provide an email.", "NO_EMAIL");
  }

  if (!user) throw new AuthError("Could not resolve user.", "NO_USER");
  await getOrCreateWorkspaceFor(db, user);
  return createSession(db, user, meta);
}

export async function logout(jti: string | undefined): Promise<void> {
  const db = getDb();
  if (!db || !jti) return;
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.id, jti));
}
