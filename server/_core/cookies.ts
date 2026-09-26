import { parse, serialize } from "cookie";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SESSION_COOKIE_NAME } from "../../shared/const";
import { env } from "./env";

export function isSecureRequest(req: IncomingMessage): boolean {
  // With trust proxy, req.protocol is correct. Without it, only https: origins
  // are secure. We never *downgrade* — only decide whether to add Secure.
  const forwardedProto = req.socket ? (req as any).protocol : undefined;
  if (env.trustProxy) {
    const xf = req.headers["x-forwarded-proto"];
    const first = Array.isArray(xf) ? xf[0] : xf;
    return first === "https" || forwardedProto === "https:";
  }
  return forwardedProto === "https:";
}

interface CookieOpts {
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
}

function baseOptions(req: IncomingMessage): Omit<CookieOpts, "maxAge"> {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
  };
}

function appendSetCookie(res: ServerResponse, value: string) {
  const existing = res.getHeader("Set-Cookie");
  const list = Array.isArray(existing)
    ? existing
    : existing
      ? [String(existing)]
      : [];
  res.setHeader("Set-Cookie", [...list, value]);
}

export function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string, maxAgeSec: number) {
  appendSetCookie(
    res,
    serialize(SESSION_COOKIE_NAME, token, { ...baseOptions(req), maxAge: maxAgeSec }),
  );
}

export function clearSessionCookie(req: IncomingMessage, res: ServerResponse) {
  appendSetCookie(
    res,
    serialize(SESSION_COOKIE_NAME, "", { ...baseOptions(req), maxAge: 0 }),
  );
}

export function getCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  return parse(header)[name];
}
