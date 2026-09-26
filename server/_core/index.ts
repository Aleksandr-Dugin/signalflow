import express, { type Request, type Response, type NextFunction } from "express";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { env, assertRuntimeConfig } from "./env";
import { createContext } from "./context";
import { appRouter } from "../routers";
import { closeDb, getDb } from "./database";
import { setSessionCookie, clearSessionCookie } from "./cookies";
import { expressRateLimiter } from "./rateLimit";
import {
  getAuthorizeUrl,
  consumeState,
  exchangeCodeForProfile,
  isProviderConfigured,
  type OAuthProvider,
} from "./oauth";
import { register, loginWithPassword, loginWithOAuth, logout, AuthError } from "../services/auth";
import { verifySession } from "./sdk";
import { getCookie } from "./cookies";
import { SESSION_COOKIE_NAME } from "../../shared/const";
import {
  handlePlategaEvent,
  verifyPlategaSignature,
  completeMockCheckout,
} from "../services/billing";
import { ingestEmailEvent, handleUnsubscribeByRef } from "../services/replies";
import { startJobWorker, stopJobWorker } from "../services/jobs";
import { mountEspWebhooks } from "./espWebhooks";
// Side-effect import: registers "reply.followup" and "campaign.discovery" onto
// the job worker so autonomous AI follow-up and scheduled discovery actually run.
import "../services/jobHandlers";

// Dev convenience: never block local startup on a missing JWT secret, but never
// run production without one either (assertRuntimeConfig enforces prod below).
if (!env.jwtSecret && !env.isProd) {
  (env as { jwtSecret: string }).jwtSecret = randomBytes(32).toString("hex");
  console.warn("[auth] JWT_SECRET not set — generated an ephemeral dev secret. Sessions won't survive restarts.");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

if (env.trustProxy) app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "1mb",
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf?.toString("utf8") ?? "";
    },
  }),
);
// Mailgun Routes + SendGrid Inbound Parse arrive as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasDb: getDb() !== null, env: env.nodeEnv });
});

// ── Auth (email + password) ───────────────────────────────────────────────────
const authLimiter = expressRateLimiter("auth", { windowMs: 15 * 60_000, max: 30 });

function clientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || "unknown").toString();
}

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {};
    const session = await register({
      email: String(email ?? ""),
      password: String(password ?? ""),
      name: String(name ?? ""),
      userAgent: req.headers["user-agent"],
      ip: clientIp(req),
    });
    setSessionCookie(req, res, session.token, session.maxAgeSec);
    res.json({ user: session.user });
  } catch (err) {
    handleAuthError(res, err);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body ?? {};
    const session = await loginWithPassword({
      email: String(email ?? ""),
      password: String(password ?? ""),
      userAgent: req.headers["user-agent"],
      ip: clientIp(req),
    });
    setSessionCookie(req, res, session.token, session.maxAgeSec);
    res.json({ user: session.user });
  } catch (err) {
    handleAuthError(res, err);
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const token = getCookie(req, SESSION_COOKIE_NAME);
  if (token) {
    const payload = await verifySession(token);
    if (payload) await logout(payload.jti);
  }
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const token = getCookie(req, SESSION_COOKIE_NAME);
  if (!token) return res.json({ user: null });
  const payload = await verifySession(token);
  if (!payload) return res.json({ user: null });
  const db = getDb();
  if (!db) return res.json({ user: null });
  const { users } = await import("../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user) return res.json({ user: null });
  res.json({
    user: { id: user.id, name: user.name, email: user.email ?? "", avatarUrl: user.avatarUrl },
  });
});

function handleAuthError(res: Response, err: unknown) {
  if (err instanceof AuthError) {
    const status = err.code === "INVALID_CREDENTIALS" ? 401 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error("[auth] unexpected error:", err);
  res.status(500).json({ error: "Authentication failed." });
}

// ── OAuth (Google / GitHub) ────────────────────────────────────────────────────
const oauthLimiter = expressRateLimiter("oauth", { windowMs: 60_000, max: 30 });

app.get("/api/auth/oauth/:provider/start", oauthLimiter, (req, res) => {
  const provider = String(req.params.provider) as OAuthProvider;
  if (provider !== "google" && provider !== "github") {
    return res.status(404).send("Unknown provider");
  }
  if (!isProviderConfigured(provider)) {
    return res.status(501).send(`${provider} OAuth is not configured on this server.`);
  }
  try {
    const { url } = getAuthorizeUrl(provider);
    res.redirect(url);
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : "OAuth start failed");
  }
});

app.get("/api/auth/oauth/callback", oauthLimiter, async (req, res) => {
  const state = String(req.query.state ?? "");
  const code = String(req.query.code ?? "");
  const provider = consumeState(state);
  if (!provider) {
    return res.redirect(`${env.publicUrl}/login?error=oauth_state`);
  }
  if (!code) {
    return res.redirect(`${env.publicUrl}/login?error=oauth_no_code`);
  }
  try {
    const profile = await exchangeCodeForProfile(provider, code);
    const session = await loginWithOAuth(profile, {
      userAgent: req.headers["user-agent"],
      ip: clientIp(req),
    });
    setSessionCookie(req, res, session.token, session.maxAgeSec);
    res.redirect(`${env.publicUrl}/`);
  } catch (err) {
    console.error("[oauth] callback failed:", err);
    res.redirect(`${env.publicUrl}/login?error=oauth_failed`);
  }
});

// ── Billing webhook (verified) + mock completion ───────────────────────────────
app.post("/api/billing/webhook", async (req: Request, res) => {
  const raw = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
  const signature = req.header("Platega-Signature") ?? req.header("signature");
  if (env.plategaSecret && !verifyPlategaSignature(raw, signature)) {
    return res.status(401).json({ error: "invalid signature" });
  }
  try {
    const result = await handlePlategaEvent(raw);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[billing] webhook failed:", err);
    res.status(500).json({ error: "webhook processing failed" });
  }
});

app.get("/api/billing/mock/complete", async (req, res) => {
  const token = String(req.query.token ?? "");
  const result = await completeMockCheckout(token);
  const status = result.handled ? "success" : "failed";
  res.redirect(`${env.publicUrl}/billing?status=${status}`);
});

// ── Inbound replies / unsubscribe ──────────────────────────────────────────────
const replyLimiter = expressRateLimiter("reply", { windowMs: 60_000, max: 120 });

app.post("/api/replies/ingest", replyLimiter, async (req, res) => {
  const secret = req.header("x-reply-secret") ?? String(req.query.secret ?? "");
  if (env.replyIngestSecret && secret !== env.replyIngestSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const result = await ingestEmailEvent({
      referenceId: req.body?.referenceId ? String(req.body.referenceId) : null,
      fromAddress: String(req.body?.from ?? ""),
      toAddress: req.body?.to ? String(req.body.to) : null,
      subject: req.body?.subject ? String(req.body.subject) : null,
      bodyText: req.body?.bodyText ? String(req.body.bodyText) : null,
      eventType: (req.body?.eventType as never) ?? "replied",
      dedupeKey: req.body?.dedupeKey ? String(req.body.dedupeKey) : null,
      metadata: req.body?.metadata,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[replies] ingest failed:", err);
    res.status(500).json({ error: "ingest failed" });
  }
});

app.get("/api/replies/unsubscribe", async (req, res) => {
  const ref = String(req.query.ref ?? "");
  const done = ref ? await handleUnsubscribeByRef(ref) : false;
  res
    .status(200)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title><body style="font-family:system-ui;padding:40px;max-width:520px;margin:auto"><h1>${done ? "You've been unsubscribed" : "Unsubscribe"}</h1><p>${done ? "You will no longer receive emails from this sender." : "We couldn't find that link, but replies with 'unsubscribe' also work."}</p></body>`,
    );
});

// Mailgun / SendGrid / Postmark / SES native inbound webhooks.
mountEspWebhooks(app);

// ── tRPC ────────────────────────────────────────────────────────────────────
app.use(
  "/api/trpc",
  createExpressMiddleware({
    router: appRouter,
    createContext: ({ req, res }) => createContext({ req, res }),
  }),
);

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// ── Client (Vite dev middleware / static production build) ─────────────────────
async function attachClient(appInstance: express.Express) {
  if (env.isProd) {
    const distPath = path.resolve(__dirname, "../../dist/public");
    appInstance.use(express.static(distPath));
    appInstance.get("*", (_req, res) => res.sendFile(path.join(distPath, "index.html")));
    return;
  }
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    configFile: path.resolve(__dirname, "../../vite.config.ts"),
    server: { middlewareMode: true, hmr: { server: httpServer } },
    appType: "spa",
  });
  appInstance.use(vite.middlewares);
}

const httpServer = createServer(app);

assertRuntimeConfig();

async function start() {
  await attachClient(app);
  httpServer.listen(env.port, () => {
    console.log(`SignalFlow listening on http://localhost:${env.port} (${env.nodeEnv})`);
    if (getDb()) startJobWorker();
  });
}

start().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});

function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down.`);
  stopJobWorker();
  httpServer.close(() => {
    closeDb().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
