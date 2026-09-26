import dotenv from "dotenv";

dotenv.config();

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const env = {
  nodeEnv: str("NODE_ENV", str("NODE_ENV", "development")),
  isProd: str("NODE_ENV") === "production",
  isTest: str("NODE_ENV") === "test",

  port: num("PORT", 3000),
  publicUrl: str("PUBLIC_APP_URL", "http://localhost:3000"),
  trustProxy: bool("TRUST_PROXY", false),

  databaseUrl: str("DATABASE_URL"),
  jwtSecret: str("JWT_SECRET"),

  // Comma-separated allow-list of emails that are auto-promoted to the
  // `admin` role on login/registration. Only these people can reach the admin
  // panel (cross-workspace data + system health). Never grant lightly.
  adminEmails: str("ADMIN_EMAILS"),

  // Auth providers
  googleClientId: str("GOOGLE_CLIENT_ID"),
  googleClientSecret: str("GOOGLE_CLIENT_SECRET"),
  githubClientId: str("GITHUB_CLIENT_ID"),
  githubClientSecret: str("GITHUB_CLIENT_SECRET"),

  // AI
  groqApiKey: str("GROQ_API_KEY"),
  groqModel: str("GROQ_MODEL", "openai/gpt-oss-20b"),
  aiCacheHours: num("AI_CACHE_HOURS", 24),
  researchCacheHours: num("RESEARCH_CACHE_HOURS", 72),

  // Discovery
  sgaiApiKey: str("SGAI_API_KEY"),

  // Outbound email
  smtpHost: str("SMTP_HOST"),
  smtpPort: num("SMTP_PORT", 587),
  smtpSecure: bool("SMTP_SECURE", false),
  smtpUser: str("SMTP_USER"),
  smtpPassword: str("SMTP_PASSWORD"),
  smtpFrom: str("SMTP_FROM", "SignalFlow <no-reply@localhost>"),
  // Must be a mailbox that can actually receive replies. Also powers the mailto
  // leg of the RFC 8058 List-Unsubscribe header.
  smtpReplyTo: str("SMTP_REPLY_TO"),
  replyIngestSecret: str("REPLY_INGEST_SECRET"),

  // Billing
  plategaMerchantId: str("PLATEGA_MERCHANT_ID"),
  plategaSecret: str("PLATEGA_SECRET"),
  plategaApiUrl: str("PLATEGA_API_URL", "https://app.platega.io/"),
  billingProvider: str("BILLING_PROVIDER"),
  mockBillingWebhookSecret: str("MOCK_BILLING_WEBHOOK_SECRET", "mock"),
  billingCurrency: str("BILLING_CURRENCY", "USD"),
  cronSecret: str("CRON_SECRET"),

  // Autonomous sales-agent tooling (docs/ai-agents.md). When unset the AI
  // simply omits the link from follow-up drafts.
  calendlyUrl: str("CALENDLY_URL"),
  stripePaymentLink: str("STRIPE_PAYMENT_LINK"),
  // Signing secrets for the conversion callbacks that move a deal to
  // meeting_booked / won. Unset => that endpoint refuses every request, so a
  // half-configured deployment can never be tricked into reporting closed deals.
  calendlySigningSecret: str("CALENDLY_SIGNING_SECRET"),
  stripeWebhookSecret: str("STRIPE_WEBHOOK_SECRET"),

  // Discovery re-check cadence. When >0 the job worker re-enqueues discovery
  // for active campaigns on that interval (a lightweight cron).
  discoveryIntervalHours: num("DISCOVERY_INTERVAL_HOURS", 0),
};

export type Env = typeof env;

/** True when the email is in the ADMIN_EMAILS allow-list (case-insensitive). */
export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return env.adminEmails
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}

/**
 * Fail-fast configuration validation. Called at boot. In production a missing
 * JWT_SECRET must stop the process rather than silently 500 every auth call
 * (audit P1 fix).
 */
export function assertRuntimeConfig(): void {
  const problems: string[] = [];
  if (!env.jwtSecret || env.jwtSecret.length < 16) {
    problems.push("JWT_SECRET must be set to a long random string (>= 16 chars).");
  }
  if (env.isProd) {
    if (!env.databaseUrl) problems.push("DATABASE_URL is required in production.");
    if (env.jwtSecret === "change-me-to-a-long-random-string-at-least-32-chars") {
      problems.push("JWT_SECRET is still the example value.");
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n - ${problems.join("\n - ")}`);
  }
}
