// Launch preflight — one command that answers "can this deployment go live, and if
// not, what exactly is missing". Run it with `pnpm preflight` (needs devDependencies,
// i.e. run it from the source checkout, not from a slim production image).
//
// Why a script and not a test: every item below is a fact about the *outside* world —
// DNS records, a live database, keys on this machine — which no test suite can assert
// about a deployment it does not run. CI proves the logic; only this can prove the
// configuration.
//
// Exit code: 1 if anything is FAIL. WARNs do not block, because the operator may know
// something this script cannot (a pilot launch to five friendly prospects is a valid
// reason to ship with enrichment unconfigured). Each line states its own consequence,
// so the decision can be made from this output alone.
//
// The order of operations around this script is docs/launch.md.
import { promises as dns } from "node:dns";
import { env } from "../server/_core/env";
import { describeDatabaseUrl } from "../server/_core/dbConnection";
import { detectSchemaDrift } from "../server/_core/schemaCheck";
import { discoveryMode } from "../server/services/providers";
import { CONTROLLER, legalIsUnfiled } from "../shared/legal";

type Grade = "ok" | "warn" | "fail";

const results: { grade: Grade; area: string; line: string }[] = [];

function record(grade: Grade, area: string, line: string): void {
  results.push({ grade, area, line });
}

/** Email inside an SMTP_FROM display name, `"SignalFlow <a@b.com>"` -> `a@b.com`. */
function addressFrom(sender: string): string | null {
  const m = /<([^@\s>]+@[^@\s>]+)>/.exec(sender) ?? /^([^@\s>]+@[^@\s>]+)$/.exec(sender.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

function domainOf(address: string): string {
  return address.split("@")[1] ?? "";
}

// DNS with a hard deadline, and three answers rather than two. "No such record" and
// "the resolver could not be reached" look identical to a caller and mean opposite
// things: one is a missing SPF record the operator has to add, the other is this script
// failing to see. Collapsing them would have the checklist reassure a bad deployment.
type Txt =
  | { status: "found"; values: string[] }
  | { status: "absent" }
  | { status: "unreachable" };

async function txt(name: string): Promise<Txt> {
  try {
    const rows = await Promise.race([
      dns.resolveTxt(name),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 4000),
      ),
    ]);
    // Each TXT record arrives as chunks that must be joined without separators.
    return { status: "found", values: rows.map((chunks) => chunks.join("")) };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NOTFOUND" || code === "NOERROR") {
      return { status: "absent" };
    }
    return { status: "unreachable" };
  }
}

const DKIM_SELECTORS = [
  // The selectors the providers this project is wired for actually publish. A real
  // DKIM key can use another one, which is why a miss is a warning that names what to
  // check rather than a claim that no key exists.
  "default",
  "s1", // Mailgun
  "k1", // SendGrid
  "selector1", // Microsoft 365
  "google", // Google Workspace
];

async function checkDatabase(): Promise<void> {
  if (!env.databaseUrl) {
    record("fail", "database", "DATABASE_URL is unset — the server boots and stores nothing.");
    return;
  }
  const masked = describeDatabaseUrl(env.databaseUrl);
  const drift = await detectSchemaDrift();
  if (drift === null) {
    record(
      "warn",
      "database",
      `Could not read the schema at ${masked} — wrong host, credentials, or TLS is required and not being offered (TiDB Cloud public endpoints are; DATABASE_SSL/DATABASE_CA_PATH control this).`,
    );
    return;
  }
  if (drift.missing.length) {
    for (const d of drift.missing.slice(0, 6)) {
      record("fail", "database", `Table ${d.table} has no column ${d.column}. Fix: ${d.fix}`);
    }
  }
  if (drift.unknownTables.length) {
    record("warn", "database", `Tables the code does not know about: ${drift.unknownTables.join(", ")} (harmless, usually leftovers from an older schema).`);
  }
  if (!drift.missing.length) {
    record("ok", "database", `Connected, and the live schema matches what the code assumes (${masked}).`);
  }
}

async function checkSendingDomain(): Promise<void> {
  if (!env.smtpHost) {
    record("warn", "sending domain", "SMTP is not configured, so the sender's DNS cannot be judged yet. Once SMTP_* is set, this checks SPF, DKIM and DMARC on the From domain.");
    return;
  }
  const address = addressFrom(env.smtpFrom);
  if (!address) {
    record("fail", "sending domain", `SMTP_FROM has no parsable address ("${env.smtpFrom}"). The unsubscribe header and DNS checks both need one.`);
    return;
  }
  const domain = domainOf(address);
  if (domain === "localhost" || !domain.includes(".")) {
    record("fail", "sending domain", `SMTP_FROM uses the domain "${domain}", which cannot receive mail. Set SMTP_FROM to a domain you control.`);
    return;
  }
  if (["gmail.com", "yahoo.com", "hotmail.com", "outlook.com"].includes(domain)) {
    record("fail", "sending domain", `SMTP_FROM is at ${domain} — a free mailbox. Cold outreach from it will be filtered, and the account is likely to be limited mid-campaign.`);
    return;
  }

  const spf = await txt(domain);
  if (spf.status === "unreachable") {
    record("warn", "sending domain", `Could not query DNS for ${domain} from this machine. Check SPF by hand: it must authorise your SMTP provider (e.g. "v=spf1 include:mailgun.org ~all").`);
  } else if (spf.status === "absent" || !spf.values.some((t) => t.startsWith("v=spf1"))) {
    record("fail", "sending domain", `No SPF record on ${domain}. Receiving servers will treat the campaign as forgery: expect spam folders and bounces.`);
  } else {
    record("ok", "sending domain", `SPF present on ${domain}: ${spf.values.find((t) => t.startsWith("v=spf1"))}`);
  }

  const dmarc = await txt(`_dmarc.${domain}`);
  if (dmarc.status === "unreachable") {
    record("warn", "sending domain", `Could not query _dmarc.${domain} — verify by hand that a DMARC record exists with a reporting address.`);
  } else if (dmarc.status === "absent" || !dmarc.values.some((t) => t.startsWith("v=DMARC1"))) {
    record("fail", "sending domain", `No DMARC record on _dmarc.${domain}. Gmail and Yahoo require it for bulk senders; without it a warmed-up domain is not usable.`);
  } else {
    record("ok", "sending domain", `DMARC present: ${dmarc.values.find((t) => t.startsWith("v=DMARC1"))}`);
  }

  const dkimHits: string[] = [];
  let dkimUnreachable = false;
  for (const selector of DKIM_SELECTORS) {
    const value = await txt(`${selector}._domainkey.${domain}`);
    if (value.status === "unreachable") dkimUnreachable = true;
    else if (value.status === "found" && value.values.length) dkimHits.push(selector);
  }
  if (dkimHits.length) {
    record("ok", "sending domain", `DKIM key published for selector(s): ${dkimHits.join(", ")}.`);
  } else if (dkimUnreachable) {
    record("warn", "sending domain", `Could not confirm DKIM on ${domain} (DNS queries failed from this machine). Sign the domain in your SMTP provider's dashboard and note the selector it uses.`);
  } else {
    record("warn", "sending domain", `No DKIM key found under the selectors this script knows (${DKIM_SELECTORS.join(", ")}). If your provider uses another selector, verify it by hand — an unsigned DKIM is the most common reason a warmed domain still lands in spam.`);
  }
}

function checkConfig(): void {
  if (!env.jwtSecret || env.jwtSecret.length < 32) {
    record("fail", "auth", `JWT_SECRET is ${env.jwtSecret ? `only ${env.jwtSecret.length} characters` : "unset"} — sessions are forgeable.`);
  } else if (env.jwtSecret.startsWith("change-me")) {
    record("fail", "auth", "JWT_SECRET is still the example value from .env.example.");
  } else {
    record("ok", "auth", "JWT_SECRET is set to a long non-example value.");
  }

  if (!env.publicUrl.startsWith("https://") && env.isProd) {
    record("fail", "urls", `PUBLIC_APP_URL is ${env.publicUrl} in production: unsubscribe links, CTA tracking and webhook URLs are all built from it, and http:// breaks the first one for every recipient.`);
  } else if (!env.publicUrl.startsWith("http")) {
    record("fail", "urls", `PUBLIC_APP_URL ("${env.publicUrl}") is not a URL — every generated link is broken.`);
  } else if (env.publicUrl.includes("localhost")) {
    record("warn", "urls", `PUBLIC_APP_URL is ${env.publicUrl}: fine for development, useless in a message a prospect reads. Set it to the deployed origin before the first send.`);
  } else {
    record("ok", "urls", `PUBLIC_APP_URL = ${env.publicUrl}.`);
  }

  if (env.isProd && !env.trustProxy) {
    record("warn", "urls", "TRUST_PROXY is off in production: behind a proxy every request shares one IP, so auth / contact-search / reply-ingest rate limits collapse into a single bucket and start locking out real users.");
  }

  if (!env.adminEmails) {
    record("warn", "auth", "ADMIN_EMAILS is unset — nobody can reach the Admin page, which means nobody can pull the platform autonomy kill switch or read the queue report from the UI.");
  } else {
    record("ok", "auth", `Admin access: ${env.adminEmails}`);
  }
}

function checkPipeline(): void {
  // Three honest states: a self-hosted OpenAI-compatible server, the Groq fallback,
  // or no live model at all (mock). AI_BASE_URL wins when both are set.
  if (env.aiBaseUrl) {
    record("ok", "AI", `Live model at ${env.aiBaseUrl} (model ${env.aiModel || "UNSET — set AI_MODEL"}).`);
  } else if (env.groqApiKey) {
    record("ok", "AI", `Groq fallback (model ${env.groqModel}). For a self-hosted model set AI_BASE_URL/AI_MODEL.`);
  } else {
    record("warn", "AI", "No AI backend configured (AI_BASE_URL / GROQ_API_KEY unset) — drafts and reply classification fall back to mock text. Nothing here is sendable to a real prospect.");
  }

  const engine = discoveryMode();
  if (engine === "open") {
    record(
      "ok",
      "discovery",
      `Free keyless discovery is on: real companies from public sources (${env.openDiscoverySources}), capped at ${env.openDiscoveryLimit} candidates and ${env.openDiscoveryHomepageReads} homepage reads per run.`,
    );
    record(
      "warn",
      "discovery",
      "The free sources cover two ICPs: startups that announce themselves on Hacker News, and businesses mapped in OpenStreetMap under a recognised category. A campaign outside those returns nothing rather than something invented, which is the reason to trust what it does return.",
    );
    if (env.maxContactEnrichments <= 0) {
      record("warn", "discovery", `Companies are found, but MAX_CONTACT_ENRICHMENTS=${env.maxContactEnrichments} stops the pass over their own pages, so every prospect needs a manual contact.`);
    }
    if (env.openDiscoverySources.includes("osm")) {
      record(
        "warn",
        "discovery",
        `OpenStreetMap runs on shared public servers that answer 504 when busy; one lookup gets ${env.overpassBudgetMs}ms across ${env.overpassEndpoints.split(",").length} endpoints before it is reported as unavailable. Expect an empty result sometimes when the city is not empty.`,
      );
    }
  } else if (engine === "scrapegraph") {
    if (env.maxContactEnrichments <= 0) {
      record("warn", "discovery", `SGAI_API_KEY set but MAX_CONTACT_ENRICHMENTS=${env.maxContactEnrichments}: companies are found, but nobody's address is extracted, so every prospect needs a manual contact.`);
    } else {
      record("ok", "discovery", `Live discovery with a second pass over /contact|/team|/about for up to ${env.maxContactEnrichments} companies per run.`);
    }
  } else {
    record(
      "warn",
      "discovery",
      "Discovery returns demo companies: no SGAI_API_KEY, and DISCOVERY_PROVIDER is not set to open. The free option needs no key and costs nothing - set DISCOVERY_PROVIDER=open.",
    );
  }

  if (!env.enrichmentProvider) {
    record("ok", "enrichment", "No paid enrichment provider set — nothing is bought, and a stray API key alone cannot spend money by accident.");
  } else {
    // The key that matters depends on the selector: a Hunter key does nothing for
    // ENRICHMENT_PROVIDER=apollo, and reporting "key present" would be a lie.
    const key =
      env.enrichmentProvider === "hunter"
        ? env.hunterApiKey
        : env.enrichmentProvider === "apollo"
          ? env.apolloApiKey
          : "";
    const known = env.enrichmentProvider === "hunter" || env.enrichmentProvider === "apollo";
    record(
      known && key ? "ok" : "fail",
      "enrichment",
      `ENRICHMENT_PROVIDER=${env.enrichmentProvider}${!known ? " (not a provider this build knows: hunter or apollo)" : key ? " with a matching key" : " but its API key is missing — every lookup will fail"}; automatic spend is ${
        env.enrichmentAutoDiscover
          ? "ON (an unattended run may buy contacts, capped per run)"
          : "off (only an explicit click buys)"
      } at up to ${env.enrichmentMaxPeople} people per lookup.`,
    );
  }

  if (!env.smtpHost || !env.smtpUser || !env.smtpPassword) {
    record("fail", "outbound", "SMTP_HOST / SMTP_USER / SMTP_PASSWORD incomplete — outreach cannot be delivered. Everything upstream of it (discovery, scoring, replies) is untestable without this.");
  } else {
    record("ok", "outbound", `SMTP configured for ${env.smtpHost}:${env.smtpPort}${env.smtpSecure ? " (TLS)" : " (STARTTLS)"}.`);
    if (!env.smtpReplyTo) {
      record("warn", "outbound", "SMTP_REPLY_TO unset: replies have nowhere obvious to go and the List-Unsubscribe header loses its mailto leg. Set it to a monitored mailbox.");
    }
    if (!env.senderPostalAddress) {
      record("warn", "outbound", "SENDER_POSTAL_ADDRESS unset — every message goes out without the physical address CAN-SPAM and equivalents require. The footer prints it only when it is real.");
    }
  }

  if (!env.replyIngestSecret) {
    record("fail", "inbound", "REPLY_INGEST_SECRET unset — every inbound webhook answers 503 (fail closed). Replies arrive nowhere, the funnel stops at 'sent', and no follow-up is ever queued.");
  } else if (env.replyIngestSecret.length < 24) {
    record("warn", "inbound", `REPLY_INGEST_SECRET is only ${env.replyIngestSecret.length} characters. It signs inbound mail from your provider; generate a long random one.`);
  } else {
    record("ok", "inbound", "REPLY_INGEST_SECRET set.");
  }
}

function checkConversions(): void {
  if (!env.calendlyUrl && !env.stripePaymentLink) {
    record("warn", "conversions", "No CALENDLY_URL and no STRIPE_PAYMENT_LINK: AI follow-ups have no CTA to embed, so the loop can get a reply and nothing else.");
  }
  const booking = env.calendlyUrl && !env.calendlySigningSecret;
  const payment = env.stripePaymentLink && !env.stripeWebhookSecret;
  if (booking) {
    record("fail", "conversions", "CALENDLY_URL set without CALENDLY_SIGNING_SECRET — /api/conversions/calendly refuses everything (503), so meeting_booked will never arrive and the funnel stalls at 'responded'.");
  }
  if (payment) {
    record("fail", "conversions", "STRIPE_PAYMENT_LINK set without STRIPE_WEBHOOK_SECRET — /api/conversions/stripe refuses everything, so 'won' will never arrive.");
  }
  if (env.calendlyUrl && env.calendlySigningSecret) {
    record("ok", "conversions", `Calendly ready: point the event webhook at ${env.publicUrl.replace(/\/$/, "")}/api/conversions/calendly`);
  }
  if (env.stripePaymentLink && env.stripeWebhookSecret) {
    record("ok", "conversions", `Stripe ready: point the Payment Link webhook at ${env.publicUrl.replace(/\/$/, "")}/api/conversions/stripe`);
  }
  record(
    env.discoveryIntervalHours > 0 ? "ok" : "warn",
    "conversions",
    env.discoveryIntervalHours > 0
      ? `Recurring discovery every ${env.discoveryIntervalHours}h.`
      : "DISCOVERY_INTERVAL_HOURS=0 — nothing re-runs on its own; every discovery pass is a manual click.",
  );
}

/**
 * Messenger channels. Optional by design — neither platform permits cold outreach, so
 * these exist to answer someone who chose to write to us there, and the funnel works
 * without them. What is *not* optional is a half-configured channel: on these platforms
 * the inbound leg is the only thing that can ever create permission to send, so a sender
 * without it is not an idle channel but a dead one, and only the operator can tell which
 * was intended.
 */
function checkChannels(): void {
  const origin = env.publicUrl.replace(/\/$/, "");
  const telegramAny = Boolean(env.telegramBotToken || env.telegramWebhookSecret || env.telegramBotUsername);
  const whatsappAny = Boolean(
    env.whatsappAccessToken || env.whatsappPhoneNumberId || env.whatsappAppSecret || env.whatsappVerifyToken,
  );

  if (!telegramAny && !whatsappAny) {
    record(
      "ok",
      "channels",
      "No messenger channel configured — outreach is email-only, which is a complete pipeline. Set the TELEGRAM_* or WHATSAPP_* variables to answer prospects who prefer chat.",
    );
    return;
  }

  if (telegramAny) {
    if (!env.telegramBotToken) {
      record(
        "fail",
        "channels",
        "Telegram variables are set but TELEGRAM_BOT_TOKEN is empty — nothing can be sent, and the webhook has no bot to belong to.",
      );
    } else if (!env.telegramWebhookSecret) {
      record(
        "fail",
        "channels",
        "TELEGRAM_BOT_TOKEN set without TELEGRAM_WEBHOOK_SECRET — /api/channels/telegram refuses every update, so no one can ever grant permission and the channel stays empty however many links go out.",
      );
    } else {
      record(
        "ok",
        "channels",
        `Telegram can receive and send. Register the webhook once the app is on a public HTTPS origin: POST ${origin}/api/channels/telegram (see .env.example for the setWebhook curl).`,
      );
      if (!env.telegramBotUsername) {
        record(
          "warn",
          "channels",
          "Telegram works but TELEGRAM_BOT_USERNAME is unset, so no chat link can be built and none appears in a tracked CTA. The channel is reachable only by someone who finds the bot themselves.",
        );
      }
    }
  }

  if (whatsappAny) {
    const sender = Boolean(env.whatsappAccessToken && env.whatsappPhoneNumberId);
    if (!sender) {
      record(
        "fail",
        "channels",
        "WhatsApp variables are set but WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID are incomplete — inbound consent may be recorded that nothing can ever answer.",
      );
    } else if (!env.whatsappAppSecret) {
      record(
        "fail",
        "channels",
        "WhatsApp sender configured without WHATSAPP_APP_SECRET — /api/channels/whatsapp cannot verify Meta's signature and refuses everything, so the reply window can never open.",
      );
    } else {
      record(
        "ok",
        "channels",
        `WhatsApp Cloud API configured. Subscribe the webhook at ${origin}/api/channels/whatsapp (field: messages) with a verify token.`,
      );
      if (!env.whatsappVerifyToken) {
        record(
          "warn",
          "channels",
          "WHATSAPP_VERIFY_TOKEN is unset, so Meta's subscription handshake fails and the webhook cannot be created through the UI.",
        );
      }
    }
  }

  // Informational, not a warning: this is what a working configuration enforces, and the
  // manual half of proving it lives in docs/verification.md.
  record(
    "ok",
    "channels",
    `Free-text replies are permitted for ${Math.min(env.messengerWindowHours, 24)}h after the prospect's last inbound message (MESSENGER_WINDOW_HOURS, capped at the platform's own 24).`,
  );
}

function checkLegal(): void {
  if (legalIsUnfiled()) {
    const placeholders = Object.entries(CONTROLLER)
      .filter(([, v]) => v.startsWith("TODO:"))
      .map(([k]) => k)
      .join(", ");
    record("warn", "legal", `/privacy and /terms render as drafts (banner on the page) until CONTROLLER in shared/legal.ts is filled in: ${placeholders}. A policy that names no controller is not a policy.`);
  } else {
    record("ok", "legal", "Controller fields are filled in. Have the text reviewed for the jurisdictions you send to.");
  }
}

async function main(): Promise<void> {
  checkConfig();
  await checkDatabase();
  await checkSendingDomain();
  checkPipeline();
  checkConversions();
  checkChannels();
  checkLegal();

  // Grouped in launch order rather than alphabetically: the operator reads this top to
  // bottom and fixes it top to bottom, so "database" must not arrive after "auth".
  const areas = ["urls", "auth", "database", "sending domain", "outbound", "inbound", "AI", "discovery", "enrichment", "conversions", "channels", "legal"];
  const order: Record<Grade, number> = { fail: 0, warn: 1, ok: 2 };
  const sorted = results.slice().sort(
    (a, b) =>
      areas.indexOf(a.area) - areas.indexOf(b.area) ||
      order[a.grade] - order[b.grade] ||
      a.line.localeCompare(b.line),
  );
  let lastArea = "";
  for (const r of sorted) {
    if (r.area !== lastArea) {
      console.log(`\n${r.area}`);
      lastArea = r.area;
    }
    console.log(`  [${r.grade.toUpperCase().padEnd(4)}] ${r.line}`);
  }

  const fails = results.filter((r) => r.grade === "fail").length;
  const warns = results.filter((r) => r.grade === "warn").length;
  console.log(
    `\n${fails ? `${fails} blocking item(s)` : "no blocking items"}, ${warns} warning(s). ` +
      `Environment: ${env.nodeEnv}, ${env.isProd ? "production" : "not production"} (NODE_ENV).`,
  );
  console.log(
    "Not checkable from here — verify by hand (docs/verification.md): an actual inbox test, " +
      "the provider webhook routes registered at the deployed URLs, and one full live run of " +
      "discovery -> contact -> send -> reply -> follow-up -> booking -> won.",
  );
  process.exit(fails ? 1 : 0);
}

main().catch((err) => {
  console.error("preflight crashed:", err);
  process.exit(1);
});
