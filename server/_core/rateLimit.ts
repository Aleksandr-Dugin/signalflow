import type { RequestHandler } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface LimitSpec {
  windowMs: number;
  max: number;
}

/**
 * Fixed-window in-memory limiter. Adequate for a single-process deploy and a
 * cheap first line of defense against brute force + paid-API abuse (audit P1).
 * For multi-instance deployments swap for a Redis-backed limiter.
 */
export function hit(key: string, spec: LimitSpec): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + spec.windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  existing.count += 1;
  const ok = existing.count <= spec.max;
  return { ok, retryAfterSec: Math.ceil((existing.resetAt - now) / 1000) };
}

export function expressRateLimiter(name: string, spec: LimitSpec): RequestHandler {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const { ok, retryAfterSec } = hit(`${name}:${ip}`, spec);
    if (!ok) {
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({ error: "Too many requests", retryAfterSec });
      return;
    }
    next();
  };
}

// Periodically clear stale buckets so memory does not grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}, 60_000).unref?.();
