import { SignJWT, jwtVerify } from "jose";
import { nanoid } from "nanoid";
import { env } from "./env";

export interface SessionPayload {
  sub: string; // user id
  jti: string; // session id (checked against sessions table for revocation)
  name: string;
  email: string;
}

function secretKey(): Uint8Array {
  if (!env.jwtSecret) {
    throw new Error("JWT_SECRET is not configured — cannot sign sessions.");
  }
  return new TextEncoder().encode(env.jwtSecret);
}

export async function signSession(
  payload: Omit<SessionPayload, "jti">,
  ttlMs: number,
): Promise<{ token: string; jti: string; expiresAt: Date }> {
  const jti = nanoid(24);
  const expiresAt = new Date(Date.now() + ttlMs);
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secretKey());
  return { token, jti, expiresAt };
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"] });
    const sub = payload.sub;
    const jti = payload.jti;
    const name = typeof payload.name === "string" ? payload.name : "";
    const email = typeof payload.email === "string" ? payload.email : "";
    if (!sub || !jti) return null;
    return { sub, jti, name, email };
  } catch {
    return null;
  }
}
