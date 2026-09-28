#!/usr/bin/env node
// Boot the real server and probe the HTTP surface of the unauthenticated
// endpoints that gate the sales funnel: tracked CTA redirects, Calendly/Stripe
// conversion callbacks, and the RFC 8058 one-click unsubscribe.
//
// Unit tests cover the logic; this covers the wiring that logic tests cannot
// see — that the routes are mounted before the /api 404 catch-all, that an
// unverifiable webhook is refused, and that a CTA redirect can never be steered
// to an attacker-supplied host. It runs without a database on purpose.
//
//   node scripts/smoke.mjs
//
// Exits non-zero on the first unmet expectation.
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT || 4111);
const BASE = `http://127.0.0.1:${PORT}`;

const CALENDLY_URL = "https://calendly.com/signalflow-smoke/30min";
const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/signalflow_smoke";
const CALENDLY_SECRET = "smoke_calendly_secret_not_real";
const STRIPE_SECRET = "whsec_smoke_stripe_not_real";
const INGEST_SECRET = "smoke_ingest_secret_not_real";
const TG_BOT_TOKEN = "123456789:smoke-bot-token-not-real";
const TG_BOT_USERNAME = "signalflow_smoke_bot";
const TG_WEBHOOK_SECRET = "smoke_telegram_webhook_secret_not_real";
const WA_APP_SECRET = "smoke_whatsapp_app_secret_not_real";
const WA_VERIFY_TOKEN = "smoke_whatsapp_verify_token_not_real";

let failures = 0;
function check(label, passed, detail) {
  console.log(`${passed ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!passed) failures++;
}

/** Start the server and resolve once it is listening. */
async function startServer(overrides = {}, port = PORT) {
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    PUBLIC_APP_URL: base,
    CALENDLY_URL,
    STRIPE_PAYMENT_LINK,
    CALENDLY_SIGNING_SECRET: CALENDLY_SECRET,
    STRIPE_WEBHOOK_SECRET: STRIPE_SECRET,
    // Set explicitly rather than inherited: the SES checks below assert a
    // refusal, and an empty or shell-inherited value would change its meaning.
    REPLY_INGEST_SECRET: INGEST_SECRET,
    // Configured so the messenger checks below exercise the real auth contract;
    // the fail-closed case gets its own boot at the end with these blanked.
    TELEGRAM_BOT_TOKEN: TG_BOT_TOKEN,
    TELEGRAM_BOT_USERNAME: TG_BOT_USERNAME,
    TELEGRAM_WEBHOOK_SECRET: TG_WEBHOOK_SECRET,
    WHATSAPP_ACCESS_TOKEN: "smoke-wa-token",
    WHATSAPP_PHONE_NUMBER_ID: "smoke-wa-phone-id",
    WHATSAPP_APP_SECRET: WA_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: WA_VERIFY_TOKEN,
    ...overrides,
  };
  // Several checks below assert that a provider must be asked to *retry* when we
  // cannot persist. A database inherited from the shell would silently turn those
  // 503s into 200s and the run would pass while proving nothing.
  delete env.DATABASE_URL;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join(root, "server", "_core", "index.ts")],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (output.includes("listening on")) return { child, output, base };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error("Server never became ready. Output:\n" + output);
  await stopServer(child);
  process.exit(1);
}

function sign(secret, timestamp, body, version) {
  return `t=${timestamp},${version}=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Kill the server child and resolve only once its stdio has actually closed.
 *
 * Exiting while those handles are still being torn down trips a libuv
 * assertion on Windows (`UV_HANDLE_CLOSING`, src\win\async.c) and aborts the
 * process with a non-zero status *after* every check has printed "ok" — which
 * inverts the result for anything reading the exit code. The Linux runner never
 * shows this, so it would otherwise be trusted as a passing run locally and a
 * failing one elsewhere, or the reverse.
 */
function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("close", resolve);
    child.kill();
  });
}

async function main() {
  const { child } = await startServer();
  process.on("exit", () => child.kill());
  console.log(`Smoke-testing ${BASE} (no database by design)\n`);

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check("GET /api/health responds", health?.ok === true, JSON.stringify(health));

  // ── Tracked CTA redirect ───────────────────────────────────────────────────
  const booking = await fetch(`${BASE}/api/track/cta/ref_smoke/booking`, { redirect: "manual" });
  check(
    "booking click redirects to the configured Calendly URL",
    booking.status === 302 && booking.headers.get("location") === CALENDLY_URL,
    `${booking.status} -> ${booking.headers.get("location")}`,
  );

  const payment = await fetch(`${BASE}/api/track/cta/ref_smoke/payment`, { redirect: "manual" });
  check(
    "payment click redirects to the configured Stripe link",
    payment.status === 302 && payment.headers.get("location") === STRIPE_PAYMENT_LINK,
    `${payment.status} -> ${payment.headers.get("location")}`,
  );

  // The messenger leg of the funnel: a click on the chat link is the only thing that
  // can start a channel conversation, and it must carry our reference to Telegram.
  const telegramCta = await fetch(`${BASE}/api/track/cta/ref_smoke/telegram`, { redirect: "manual" });
  check(
    "telegram click redirects to the bot with our reference as the start parameter",
    telegramCta.status === 302 &&
      telegramCta.headers.get("location") === `https://t.me/${TG_BOT_USERNAME}?start=ref_smoke`,
    `${telegramCta.status} -> ${telegramCta.headers.get("location")}`,
  );

  // The path parameter must never be interpretable as a destination.
  const evil = await fetch(`${BASE}/api/track/cta/ref_smoke/https:%2F%2Fattacker.example`, {
    redirect: "manual",
  });
  check(
    "unknown CTA kind is refused and redirects nowhere",
    evil.status === 404 && !evil.headers.get("location"),
    String(evil.status),
  );

  // ── Conversion webhook auth ────────────────────────────────────────────────
  // The shape and scheme Calendly actually uses: event `invitee.created`, the
  // invitee under payload.resource, and a `t=…,v1=…` signature header. Signing
  // with v1 rather than v0 is deliberate — a digest prefix the live provider
  // never sends would leave this suite green while real callbacks failed auth.
  const calendlyBody = JSON.stringify({
    event: "invitee.created",
    event_uuid: "evt_smoke",
    payload: { resource: { email: "someone@example.test", status: "active" } },
  });
  const calendlyDigest = "v1";
  const ts = Math.floor(Date.now() / 1000);
  const post = (url, body, headers = {}) =>
    fetch(`${BASE}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  const unsigned = await post("/api/conversions/calendly", calendlyBody);
  check(
    "Calendly callback without a signature is rejected",
    unsigned.status === 401,
    String(unsigned.status),
  );

  const wrongKey = sign("not_the_secret", ts, calendlyBody, calendlyDigest);
  const forged = await post("/api/conversions/calendly", calendlyBody, {
    "calendly-webhook-signature": wrongKey,
  });
  check(
    "Calendly callback signed with the wrong secret is rejected",
    forged.status === 401,
    String(forged.status),
  );

  const validCalendly = sign(CALENDLY_SECRET, ts, calendlyBody, calendlyDigest);
  const tampered = await post("/api/conversions/calendly", calendlyBody.replace("someone@", "victim@"), {
    "calendly-webhook-signature": validCalendly,
  });
  check(
    "replaying a valid signature against a modified body is rejected",
    tampered.status === 401,
    String(tampered.status),
  );

  const stale = sign(CALENDLY_SECRET, ts - 3600, calendlyBody, calendlyDigest);
  const replay = await post("/api/conversions/calendly", calendlyBody, {
    "calendly-webhook-signature": stale,
  });
  check("an old (replayable) timestamp is rejected", replay.status === 401, String(replay.status));

  // Correctly signed but no database: must NOT be a 2xx, or the provider marks
  // the delivery successful and the conversion signal is lost permanently.
  const fresh = sign(CALENDLY_SECRET, ts, calendlyBody, calendlyDigest);
  const accepted = await post("/api/conversions/calendly", calendlyBody, {
    "calendly-webhook-signature": fresh,
  });
  const acceptedBody = await accepted.json().catch(() => ({}));
  check(
    "valid Calendly signature passes auth, and a missing DB asks the provider to retry",
    accepted.status === 503 && acceptedBody.reason === "db_unavailable",
    `${accepted.status} ${JSON.stringify(acceptedBody)}`,
  );

  const stripe = await post("/api/conversions/stripe", '{"type":"checkout.session.completed"}', {
    "stripe-signature": sign(STRIPE_SECRET, ts, "wrong-body", "v1"),
  });
  check("Stripe callback with a mismatched signature is rejected", stripe.status === 401, String(stripe.status));

  // ── SES/SNS inbound authentication ──────────────────────────────────────
  // SNS cannot carry an HMAC of our choosing, so this route is keyed by a
  // capability in the subscription URL. It previously accepted any well-formed
  // body, which let anyone forge a `replied`/`bounced` event into a deal.
  const forgedSes = JSON.stringify({
    Type: "Notification",
    Message: JSON.stringify({
      notificationType: "Received",
      mail: {
        messageId: "forged",
        source: "attacker@example.test",
        destination: ["reply+ref_smoke@your.domain"],
      },
      content: "I want to buy",
    }),
  });
  const sesNoKey = await post("/api/replies/webhook/ses", forgedSes);
  check(
    "SES inbound with no key is refused",
    sesNoKey.status === 401,
    String(sesNoKey.status),
  );
  const sesWrongKey = await post("/api/replies/webhook/ses?key=not_the_secret", forgedSes);
  check(
    "SES inbound with a wrong key is refused",
    sesWrongKey.status === 401,
    String(sesWrongKey.status),
  );

  // Correct key but no database: must answer 500 and keep serving. This used to
  // throw out of the async handler, and Express does not catch async rejections
  // — the unhandled rejection ended the process, so a database blip turned into
  // a crash loop driven by the provider's own retries.
  const sesValidKey = await post(`/api/replies/webhook/ses?key=${INGEST_SECRET}`, forgedSes);
  check(
    "SES inbound that cannot persist asks the provider to retry instead of crashing",
    sesValidKey.status === 500,
    String(sesValidKey.status),
  );
  const survivors = await fetch(`${BASE}/api/health`)
    .then((r) => r.json())
    .catch(() => null);
  check(
    "server is still alive after a failed ingest",
    survivors?.ok === true,
    JSON.stringify(survivors),
  );

  // The manual inbound ingest endpoint is the second write path into the funnel,
  // and it used to accept every request whenever no secret was configured. With
  // a secret present, an unkeyed forged "replied" event must be refused.
  const ingestNoSecret = await post(
    "/api/replies/ingest",
    JSON.stringify({ from: "attacker@example.test", bodyText: "sounds great", eventType: "replied" }),
  );
  check(
    "manual inbound ingest without the secret is refused",
    ingestNoSecret.status === 401,
    String(ingestNoSecret.status),
  );

  // ── One-click unsubscribe (RFC 8058) ───────────────────────────────────────
  const oneClick = await fetch(`${BASE}/api/replies/unsubscribe?ref=does_not_exist`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  check(
    "one-click unsubscribe POST is routed and answers 404 for an unknown ref",
    oneClick.status === 404,
    String(oneClick.status),
  );

  const landing = await fetch(`${BASE}/api/replies/unsubscribe?ref=does_not_exist`);
  check(
    "GET unsubscribe landing page still renders",
    landing.status === 200 && (await landing.text()).includes("Unsubscribe"),
    String(landing.status),
  );

  // ── Messenger inbound authentication ───────────────────────────────
  // These are the only endpoints that create permission to write to a person, so an
  // unverified POST must never be able to invent a consent record for a stranger.
  const tgUpdate = JSON.stringify({
    update_id: 1,
    message: { from: { id: 555, username: "smoke", is_bot: false }, chat: { id: 555 }, text: "/start ref_smoke" },
  });
  const tgPlain = { "x-telegram-bot-api-secret-token": TG_WEBHOOK_SECRET };

  const tgNoHeader = await post("/api/channels/telegram", tgUpdate);
  check("Telegram update with no secret header is refused", tgNoHeader.status === 401, String(tgNoHeader.status));
  const tgWrongHeader = await post("/api/channels/telegram", tgUpdate, { "x-telegram-bot-api-secret-token": "guess" });
  check("Telegram update with the wrong secret is refused", tgWrongHeader.status === 401, String(tgWrongHeader.status));

  const tgAuthed = await post("/api/channels/telegram", tgUpdate, tgPlain);
  const tgAuthedBody = await tgAuthed.json().catch(() => ({}));
  check(
    "authenticated Telegram update passes auth and a missing DB asks Telegram to retry",
    tgAuthed.status === 503 && tgAuthedBody.reason === "db_unavailable",
    `${tgAuthed.status} ${JSON.stringify(tgAuthedBody)}`,
  );

  // A bot cannot give consent, and a public channel post is an audience rather than a
  // person. Both are acknowledged (200) instead of retried, because retrying them
  // forever would hide the updates that matter.
  const tgFromBot = await post(
    "/api/channels/telegram",
    JSON.stringify({ update_id: 2, message: { from: { id: 1, is_bot: true }, text: "hi" } }),
    tgPlain,
  );
  const tgFromBotBody = await tgFromBot.json().catch(() => ({}));
  check(
    "a bot's message cannot grant consent and is acknowledged without a database",
    tgFromBot.status === 200 && tgFromBotBody.reason === "not_a_person_message",
    `${tgFromBot.status} ${JSON.stringify(tgFromBotBody)}`,
  );

  const waBody = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              contacts: [{ profile: { name: "Smoke" }, wa_id: "15550001111" }],
              messages: [{ id: "wamid.SMOKE", from: "15550001111", type: "text", text: { body: "hello" } }],
            },
          },
        ],
      },
    ],
  });
  const waSignature = `sha256=${createHmac("sha256", WA_APP_SECRET).update(waBody, "utf8").digest("hex")}`;

  const waNoSig = await post("/api/channels/whatsapp", waBody);
  check("WhatsApp webhook with no signature is refused", waNoSig.status === 401, String(waNoSig.status));
  const waBadSig = await post("/api/channels/whatsapp", waBody, { "x-hub-signature-256": `sha256=${"0".repeat(64)}` });
  check("WhatsApp webhook with a forged signature is refused", waBadSig.status === 401, String(waBadSig.status));
  // Signed over the original body, sent with a modified one: the signature must be over
  // what was parsed, not merely present.
  const waTampered = await post("/api/channels/whatsapp", waBody.replace("15550001111", "15559999999"), {
    "x-hub-signature-256": waSignature,
  });
  check("WhatsApp signature does not carry over to a modified body", waTampered.status === 401, String(waTampered.status));
  const waAuthed = await post("/api/channels/whatsapp", waBody, { "x-hub-signature-256": waSignature });
  const waAuthedBody = await waAuthed.json().catch(() => ({}));
  check(
    "signed WhatsApp webhook passes auth and a missing DB asks Meta to retry",
    waAuthed.status === 503 && waAuthedBody.reason === "db_unavailable",
    `${waAuthed.status} ${JSON.stringify(waAuthedBody)}`,
  );

  const handshake = await fetch(
    `${BASE}/api/channels/whatsapp?hub.mode=subscribe&hub.verify_token=${WA_VERIFY_TOKEN}&hub.challenge=chal-42`,
  );
  check(
    "the subscription handshake echoes the challenge for the configured token",
    handshake.status === 200 && (await handshake.text()) === "chal-42",
    String(handshake.status),
  );
  const handshakeWrong = await fetch(
    `${BASE}/api/channels/whatsapp?hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=chal-42`,
  );
  check("the handshake refuses a guessed verify token", handshakeWrong.status === 403, String(handshakeWrong.status));

  // The legal pages are SPA routes with no server handler, and `/api` has a
  // catch-all 404 mounted: reaching them proves the SPA fallback does not swallow
  // them. A policy nobody can load is the same as no policy.
  for (const route of ["/privacy", "/terms"]) {
    const res = await fetch(`${BASE}${route}`);
    const html = await res.text();
    check(
      `GET ${route} serves the app instead of 404`,
      res.status === 200 && html.includes("root"),
      String(res.status),
    );
  }

  await checkChannelsFailClosed();
  await stopServer(child);
  console.log(`\n${failures === 0 ? "smoke: all checks passed" : `smoke: ${failures} check(s) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * A second boot carrying no messenger credentials at all - the state every fresh
 * deployment starts in, including this repository. Refusing the inbound leg here is
 * what makes configuring a bot later safe: an unverified "/start" would otherwise be
 * a fabricated permission to message whoever's id was supplied.
 */
async function checkChannelsFailClosed() {
  const port = PORT + 1;
  const { child, base } = await startServer(
    {
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_BOT_USERNAME: "",
      TELEGRAM_WEBHOOK_SECRET: "",
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_PHONE_NUMBER_ID: "",
      WHATSAPP_APP_SECRET: "",
      WHATSAPP_VERIFY_TOKEN: "",
    },
    port,
  );
  const postTo = (url, body) =>
    fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body });

  const tg = await postTo("/api/channels/telegram", JSON.stringify({ update_id: 1, message: { from: { id: 5 }, text: "/start x" } }));
  check("Telegram inbound is refused with no webhook secret configured", tg.status === 503, String(tg.status));

  const wa = await postTo("/api/channels/whatsapp", waEmptyBody());
  check("WhatsApp inbound is refused with no app secret configured", wa.status === 503, String(wa.status));

  const hs = await fetch(`${base}/api/channels/whatsapp?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=9`);
  check("the WhatsApp handshake cannot be satisfied with an unconfigured token", hs.status === 403, String(hs.status));

  // No bot username means no honest link to offer: the CTA must fail rather than send
  // someone to a chat that cannot be attributed.
  const cta = await fetch(`${base}/api/track/cta/ref_smoke/telegram`, { redirect: "manual" });
  check(
    "telegram CTA has no destination to offer when no bot is configured",
    cta.status === 404 && !cta.headers.get("location"),
    `${cta.status} -> ${cta.headers.get("location")}`,
  );

  await stopServer(child);
}

function waEmptyBody() {
  return JSON.stringify({ object: "whatsapp_business_account", entry: [] });
}

main().catch((err) => {
  console.error("smoke run crashed:", err);
  process.exit(1);
});
