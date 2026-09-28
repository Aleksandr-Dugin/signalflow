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
  // Second discovery pass: how many companies per run get their own
  // /contact|/team|/about pages scraped to find a real person's address. Each
  // company costs scraper credits (the walk stops early once a named
  // company-domain contact is found), so this is a budget cap, not a target.
  // 0 turns automatic contact discovery off; manual contacts still work.
  maxContactEnrichments: num("MAX_CONTACT_ENRICHMENTS", 10),

  // Paid enrichment (docs/ai-agents.md: the only compliant route to phones and
  // social profiles). Deliberately empty by default: the selector must name a
  // provider, so having a key is never enough to start spending money. Setting
  // this to `hunter` or `apollo` plus its key turns a manual lookup into an
  // automated one; anything else keeps the pipeline on free page scraping.
  enrichmentProvider: str("ENRICHMENT_PROVIDER"),
  hunterApiKey: str("HUNTER_API_KEY"),
  apolloApiKey: str("APOLLO_API_KEY"),
  // Records looked up per prospect. Providers bill per person (Apollo 1-9
  // credits each), so this is a spend cap.
  enrichmentMaxPeople: num("ENRICHMENT_MAX_PEOPLE", 5),
  // Off by default, and required *in addition to* ENRICHMENT_PROVIDER: unattended
  // work may spend effort but must never spend money by surprise. Turning this on
  // lets an autopilot discovery run buy contacts for the companies whose own pages
  // named nobody, within MAX_CONTACT_ENRICHMENTS per run.
  enrichmentAutoDiscover: bool("ENRICHMENT_AUTO_DISCOVER", false),

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
  // CAN-SPAM and most equivalents require a valid physical postal address in every
  // commercial message. It cannot be derived from anything else we have, so the
  // operator must supply it; the footer prints it only when set. Leaving it unset
  // does not stop sending — see the boot warning below — but a campaign mailed
  // without it is the operator's violation, not this software's bug.
  senderPostalAddress: str("SENDER_POSTAL_ADDRESS"),
  replyIngestSecret: str("REPLY_INGEST_SECRET"),

  // Non-email channels. Neither of these is a cold-outreach channel: Telegram only
  // lets a bot write to a person who has opened the chat, and the WhatsApp Cloud
  // API only lets it write inside a 24-hour window that the *user* opened by
  // messaging the business. So the product sends email, offers a link, and the
  // inbound event on that other platform is what creates the permission (see
  // services/channels.ts). Every value here is empty by default, which means the
  // channels exist as data but nothing can be sent on them.
  telegramBotToken: str("TELEGRAM_BOT_TOKEN"),
  // Public username, used to build the t.me/<bot>?start=<ref> deep link that turns
  // an email reader into someone who chose to be written to on Telegram.
  telegramBotUsername: str("TELEGRAM_BOT_USERNAME"),
  // Telegram cannot sign its webhook payloads, so this is sent as the
  // X-Telegram-Bot-Api-Secret-Token header and compared here. Unset => the
  // endpoint accepts nothing, because anyone who learns the bot's webhook URL
  // would otherwise be able to fabricate consent on someone's behalf.
  telegramWebhookSecret: str("TELEGRAM_WEBHOOK_SECRET"),
  whatsappAccessToken: str("WHATSAPP_ACCESS_TOKEN"),
  whatsappPhoneNumberId: str("WHATSAPP_PHONE_NUMBER_ID"),
  // Meta signs each webhook body with this app secret (HMAC-SHA256 over the raw
  // body), so inbound is authentic rather than merely well-formed.
  whatsappAppSecret: str("WHATSAPP_APP_SECRET"),
  // Only used for the subscription handshake (hub.verify_token echo).
  whatsappVerifyToken: str("WHATSAPP_VERIFY_TOKEN"),
  // How long after the person's last message a reply is still allowed. The
  // platform window is 24 h; the setting exists to shorten it, never to lengthen
  // it past what the provider permits.
  messengerWindowHours: num("MESSENGER_WINDOW_HOURS", 24),

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
 *
 * Warnings are the second tier: configuration that is legal to run but wrong for a
 * real deployment. They do not stop the process — refusing to boot over a missing
 * postal address would break an operator who is mid-setup and has no way to read
 * this advice at that moment — but they name the consequence instead of describing
 * the variable, so the log line is actionable on its own.
 */
export function assertRuntimeConfig(): void {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!env.jwtSecret || env.jwtSecret.length < 16) {
    problems.push("JWT_SECRET must be set to a long random string (>= 16 chars).");
  }
  if (env.isProd) {
    if (!env.databaseUrl) problems.push("DATABASE_URL is required in production.");
    if (env.jwtSecret === "change-me-to-a-long-random-string-at-least-32-chars") {
      problems.push("JWT_SECRET is still the example value.");
    }
    if (env.smtpHost && !env.senderPostalAddress) {
      warnings.push(
        "SMTP is configured but SENDER_POSTAL_ADDRESS is unset: every message goes out without the physical address CAN-SPAM and equivalent laws require. Sending anyway is the operator's compliance decision, not a configuration detail to ignore.",
      );
    }
    if (!env.trustProxy) {
      warnings.push(
        "TRUST_PROXY is off. Behind a load proxy every request arrives from one IP, so per-client rate limits — auth, contact search, reply ingest — collapse into a single shared bucket and start blocking real users.",
      );
    }
    if (!env.replyIngestSecret) {
      warnings.push(
        "REPLY_INGEST_SECRET is unset, so inbound webhook requests cannot be authenticated. The endpoints refuse everything (fail closed), which means replies arrive nowhere and the funnel silently stops at 'sent'.",
      );
    }
    // Half-configured channels: on these platforms the inbound leg is what creates the
    // permission to send, so a sender without it is not a channel with no takers yet —
    // it is a channel that can never have one, and only the operator can tell.
    if (env.telegramBotToken && !env.telegramWebhookSecret) {
      warnings.push(
        "TELEGRAM_BOT_TOKEN is set but TELEGRAM_WEBHOOK_SECRET is not, so /api/channels/telegram refuses every update. Nobody can grant permission to be written to on Telegram, and the channel will stay empty however many links are sent.",
      );
    }
    if (env.telegramBotToken && !env.telegramBotUsername) {
      warnings.push(
        "TELEGRAM_BOT_USERNAME is unset, so no outgoing email can carry a t.me link. The bot will still answer anyone who finds it, but nothing in this system will ever direct a prospect there.",
      );
    }
    if (env.whatsappAccessToken && !env.whatsappAppSecret) {
      warnings.push(
        "WHATSAPP_ACCESS_TOKEN is set but WHATSAPP_APP_SECRET is not, so inbound WhatsApp messages cannot be signature-verified and are rejected. No reply window can open, so nothing can be sent back.",
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n - ${problems.join("\n - ")}`);
  }
  for (const warning of warnings) console.warn(`[config] ${warning}`);
}
