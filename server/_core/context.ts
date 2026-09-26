import { and, eq, gt, isNull } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as schema from "../../drizzle/schema";
import { getDb } from "./database";
import { getCookie } from "./cookies";
import { SESSION_COOKIE_NAME } from "../../shared/const";
import { verifySession } from "./sdk";

export interface ContextUser {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  user: ContextUser | null;
}

export async function createContext({
  req,
  res,
}: {
  req: IncomingMessage;
  res: ServerResponse;
}): Promise<Context> {
  const base: Context = { req, res, user: null };
  const token = getCookie(req, SESSION_COOKIE_NAME);
  if (!token) return base;

  const payload = await verifySession(token);
  if (!payload) return base;

  const db = getDb();
  if (!db) return base;

  try {
    // Validate that the session still exists, is unexpired and not revoked
    // (audit P1 fix: logout must actually revoke the token).
    const [sess] = await db
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, payload.jti),
          isNull(schema.sessions.revokedAt),
          gt(schema.sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!sess) return base;

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, sess.userId))
      .limit(1);
    if (!user) return base;

    base.user = {
      id: user.id,
      name: user.name,
      email: user.email ?? "",
      role: user.role,
    };
  } catch (err) {
    console.error("[context] session lookup failed:", err);
  }
  return base;
}
