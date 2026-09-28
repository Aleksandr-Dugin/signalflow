# Launch runbook

The order in which this project goes from a checkout to mailing a real prospect, and
what each step proves. Read [verification.md](./verification.md) for the evidence behind
the claims below — CI proves the logic, nothing here has ever touched a live provider.

Two rules govern the whole sequence:

- **Autonomy stays off until the rehearsal passes.** The platform master switch ships
  unpressed, but nothing is ever *lost* by pulling it first: queued work is held and
  resumes. Pause it before the rehearsal, release it after.
- **The first campaign goes to addresses you own.** Not to a list. The rehearsal below
  uses your own mailbox as the prospect, because a campaign that is broken in the
  inbound leg looks exactly like a campaign nobody replied to.

`pnpm preflight` automates every configuration check in steps 1–4 and exits non-zero
while something blocking is unset. Run it after each step; it is a checklist, not a
test suite, and it is meant to be run against the real `.env`.

## 1. Database

1. Provision MySQL 8 or TiDB Serverless. Nothing else is required to start.
2. `DATABASE_URL=mysql://user:pass@host:3306/signalflow` (TiDB: use the mysql:// form and
   the provided 25001/4000 port and CA as documented by the provider).
3. `pnpm db:migrate`. The journal in `drizzle/` is the schema's only source of truth.
4. Confirm the boot log says nothing about drift. `server/_core/schemaCheck.ts` compares
   the live tables against what the code assumes and prints the exact `ALTER` for each
   missing column; the app also self-heals `system_state` (the autonomy switch row) at
   boot, so an unmigrated database fails **closed** — autonomy reads as "cannot be
   checked", which means paused.

Preflight check: connects, reads the schema, and reports missing columns per table.

## 2. Identity, URLs, and a domain that can send mail

This is the part only the operator can supply, and the part that decides whether the
messages arrive.

| Variable | Why it blocks |
| --- | --- |
| `JWT_SECRET` | Sessions. 32+ chars, not the example value. |
| `ADMIN_EMAILS` | Without it nobody reaches `/app/admin` — no kill switch, no queue report, no way to resume autonomy. |
| `PUBLIC_APP_URL` | Every unsubscribe link, tracked CTA and webhook path is built from it. A `localhost` value produces links a prospect cannot open. |
| `TRUST_PROXY` | Behind a proxy with this off, every user shares one IP bucket, so auth / contact-search / reply-ingest rate limits lock out real people. |
| `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM` | Delivery. Nothing about the funnel can be verified without it. |
| `SMTP_REPLY_TO` | A mailbox that can receive. Also the `mailto:` leg of the `List-Unsubscribe` header. |
| `SENDER_POSTAL_ADDRESS` | CAN-SPAM and equivalents: a physical address in every commercial message. Printed in the footer only when set; production boot warns when SMTP is set without it. |

**DNS on the From domain, before any campaign:**

- **SPF** — must authorise the SMTP provider (`v=spf1 include:mailgun.org ~all`, or the
  value the provider prints).
- **DKIM** — sign the domain in the provider's dashboard; note the selector it publishes.
- **DMARC** — `_dmarc.<domain>` with `v=DMARC1` and a reporting address. Gmail and Yahoo
  require all three for bulk senders; without them a cold domain's mail is filtered, and
  a filtered domain warms up backwards.

Preflight check: resolves all three (and distinguishes "no record" from "DNS unreachable"
— they are different problems with different fixes).

Buy the domain and mailbox as the operator; the software cannot help with it. Send a
test message to a Gmail and a Outlook address you control and look at *where it lands*
before you believe the SPF/DKIM/DMARC checkmarks.

## 3. The keys that decide what the agent can do

| Variable | Without it |
| --- | --- |
| `GROQ_API_KEY` | Drafts, qualification and reply classification fall back to mock text. Nothing is sendable. |
| `SGAI_API_KEY` | One way to get real companies. Without it (and without `DISCOVERY_PROVIDER=open`) discovery returns demo companies instead of real ones. |
| `DISCOVERY_PROVIDER=open` | The free, keyless alternative: real companies from Hacker News (tech ICPs) and OpenStreetMap (local ICPs, including published phone numbers), and it reads their own pages for an address with no scraper service. See section 3a. |
| `MAX_CONTACT_ENRICHMENTS` | Budget for the second discovery pass over each company's `/contact|/team|/about`. `0` = manual contacts only. |
| `ENRICHMENT_PROVIDER` + `HUNTER_API_KEY` / `APOLLO_API_KEY` | The only compliant route to a named person, phone and licensed profile when the company's own pages name nobody. Empty = nothing is ever bought. |
| `ENRICHMENT_AUTO_DISCOVER` | Whether an unattended run may spend money. Off means the autopilot never buys anything — leave it off until you have watched the credit meter on manual lookups. |
| `ENRICHMENT_MAX_PEOPLE` | Records per lookup. Apollo bills per person (1–9 credits), so this is a spend cap. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` + `TELEGRAM_BOT_USERNAME` | Optional. Answering prospects who prefer chat. All three are needed: without the secret nobody can ever grant permission, and without the username no link can be built. See §4. |
| `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_APP_SECRET` | Optional, and needs a Meta business-verified app. Free-form replies are allowed for 24 h after the prospect writes; templates are never sent. |

This is a decision, not a configuration: buying contact data costs money per person and
puts a name in front of an automated sender. Decide deliberately, and leave
`ENRICHMENT_AUTO_DISCOVER=false` for the first campaign.

## 3a. What costs nothing, and what nothing free can cover

Checked September 2026. Quotas move; re-read the provider's own page before relying on
a number here. The point of the list is that the *finding* leg is free and the *sending*
leg is not, which is the opposite of what most launch budgets assume.

| Leg | Free option | What it actually buys |
| --- | --- | --- |
| Database | TiDB Cloud Starter (this repo's `DATABASE_URL`) | 5 GiB row + 5 GiB columnar storage and 50M request units per month, per instance, no card. Public endpoint is TLS-only, caps at 400 connections, and drops a connection that goes quiet (about 340 s on the AWS gateway), which is why the pool idles out in 60 s rather than trusting the server. |
| Finding companies | `DISCOVERY_PROVIDER=open` | Real companies from two public datasets, no key and no account: **Show HN** posts for tech ICPs (deliberately not `tags=story`, which returns journalism *about* a topic rather than the companies making it) and OpenStreetMap for local ones. `services/openDiscovery.ts`. Covers two families of ICP and returns nothing for others, on purpose. |
| Reading their pages for an address | same provider, no scraper service | The `/contact\|/team\|/about` pass, then the homepage, is a plain HTTPS GET plus string work. Nothing is invented: an address is returned only if it was printed on the page. A contact form rendered entirely by JavaScript stays invisible — see the measured result below, because that is the common case. |
| AI writing and classification | Groq free tier (`GROQ_API_KEY`) | Free at realistic volume and no card. Without a key the product still works but the writing leg is not AI: qualification, drafts and reply classification fall back to keyword rules and labelled demo text. The key has to be pasted into `.env` — nothing in the repository contains one. |
| Phone numbers | OpenStreetMap where a business published one | Only as a *claim in the evidence*: a prospect is keyed by its company domain, so a mapped business with a phone and no website cannot be carried forward, and the engine logs how many it had to leave behind. Beyond that, a paid lookup — no free source supplies direct-dial numbers for decision makers. |
| Named decision-maker lookup | Hunter free plan (about 50 credits a month, no card); Apollo has a free plan too, with numbers that change quarterly | Enough to try the provider path before paying. `ENRICHMENT_AUTO_DISCOVER` stays off, so an unattended run never spends a credit. |
| Booking meetings | Calendly free | One event type and one scheduling link, which is the whole requirement for the `meeting_booked` leg. |
| Payment evidence | Stripe test mode | The rehearsal's `won` transition, at no cost. Live billing is the operator's separate decision (Platega), and `BILLING_PROVIDER=mock` is refused in production. |
| Chat channel | Telegram Bot API via @BotFather | Free, no business verification, no template approval. WhatsApp is not free in the way that matters: it needs a Meta business-verified app. |
| Uptime and queue alerts | any free HTTP pinger | Point it at `GET /api/health` and alert the log on `[jobs] queue degraded`. There is no alerting service wired into the code; these two are the whole mechanism. |

**What a live run of the free path actually produced** (September 2026, no keys, this
machine). Four `Show HN` SaaS companies with correct names read from their own
`og:site_name`; three Berlin dental practices from OpenStreetMap, two with a phone and a
website; and **zero published email addresses out of eight companies**. Three things
follow from that, and the runbook should say them rather than the code hiding them:

- The *companies* are real and reachable by domain. The *address* is still the scarce
  thing, because small businesses publish a form, not a `mailto:`. Free discovery solves
  "who should I talk to", not "what do I write to". A Hunter free plan (~50 credits a
  month) or one typed contact is how the gap gets closed.
- One mapped domain had changed hands since OpenStreetMap recorded it and now serves an
  online casino. Reading the homepage is what caught it: a mapped name that appears
  nowhere on the site it points to is dropped, with the reason logged.
- Public Overpass instances are shared infrastructure. The same valid query returned 12
  rows in 5.3 s on one run and `504 too busy` on the next two, from the same network, so
  the engine walks a mirror list twice inside `OVERPASS_BUDGET_MS` and reports
  "the source is busy" as distinct from "this city has none". Expect OpenStreetMap to be
  intermittently empty; Hacker News does not do that.

**The one leg with no free option: sending.** A domain that can carry mail costs money
(a second-level domain at cost is roughly 10 USD a year, and the mailbox on it should be
a paid one), and the free tiers of the friendly-looking API providers are not a path
for cold outreach: Brevo's anti-spam policy is zero-tolerance on unsolicited mail and
Mailjet, Resend and Postmark draw the same line in their acceptable-use terms. A free
tier used for cold email ends in a suspended account and a domain that has been reported
to blocklists, which is a worse outcome than paying 10 USD. Buy the domain, authenticate
it with SPF, DKIM and DMARC, and send slowly from it.

## 4. Webhooks — point the providers at the deployed origin

Each row is a thing that will silently not happen if skipped. The endpoints refuse
everything until their secret is set (fail closed), so a half-configured deployment
cannot be spoofed — but "refusing everything" also looks like "nobody replied".

| Where | Register at the provider | Auth it carries | Proves |
| --- | --- | --- | --- |
| `POST /api/replies/webhook/mailgun` | Mailgun routes → `forward` / webhook | HMAC of `timestamp`+`token` in the `signature` field | Replies reach the pipeline |
| `POST /api/replies/webhook/sendgrid` | SendGrid mail event webhook | Basic auth, `REPLY_INGEST_SECRET` as the password | as above |
| `POST /api/replies/webhook/postmark` | Postmark inbound | `X-Postmark-Secret` header | as above |
| `POST /api/replies/webhook/ses` | SNS subscription for the receiving mailbox | `?key=<REPLY_INGEST_SECRET>` (SNS cannot send an HMAC of our choosing; the SES certificate signature is **not** yet verified) | as above |
| `POST /api/conversions/calendly` | Calendly → event notification, `invitee.created` (v2) | `CALENDLY_SIGNING_SECRET` | `meeting_booked` |
| `POST /api/conversions/stripe` | Stripe → Payment Link webhook, `checkout.session.completed` | `STRIPE_WEBHOOK_SECRET` | `won` |
| `POST /api/channels/telegram` | `setWebhook` on the bot (curl in `.env.example`) | `X-Telegram-Bot-Api-Secret-Token`, echoed from `TELEGRAM_WEBHOOK_SECRET` | permission to write on Telegram, and the reply itself |
| `GET` + `POST /api/channels/whatsapp` | Meta app → Webhooks field `messages` | handshake `hub.verify_token`; each body HMAC'd with `WHATSAPP_APP_SECRET` | permission to write on WhatsApp, and the reply itself |

The two channel endpoints are the only writers of *permission* in the system, which is
why they are the strictest: nothing is accepted before their secret is configured, and
no request can create a consent row for somebody who did not write to us. They are
optional — the funnel is complete without them.

Outbound side, configured from the app's own origin:

- `/api/track/cta/<ref>/<booking|payment|telegram>` — the rewritten CTA links. Only a
  click through these counts as evidence, so `PUBLIC_APP_URL` must be the public origin.
  The `telegram` leg is the one that turns an email reader into a chat: it redirects to
  `t.me/<bot>?start=<ref>`, and the click itself advances no stage. It is rewritten, never
  inserted — a draft only gets a tracked chat link if the message already names the bot,
  so offering Telegram to a prospect is a human decision made while reading the draft.
- `POST /api/replies/unsubscribe` — RFC 8058 one-click. The `ref` in the URI is the
  capability token; nothing to register.

`pnpm smoke` exercises the HTTP contracts of all of these without a provider; it cannot
prove you registered them.

## 5. Deploy

1. `pnpm build` → `NODE_ENV=production TRUST_PROXY=true pnpm start` behind TLS.
2. Read the boot log. `assertRuntimeConfig()` refuses to start a production server with a
   missing `DATABASE_URL` or the example `JWT_SECRET`, then **warns** about the
   half-configurations that break silently: SMTP without a postal address,
   `TRUST_PROXY` off, `REPLY_INGEST_SECRET` unset, and a messenger channel with a sender
   but no inbound verification (on those platforms the inbound leg is the only thing that
   can ever create permission, so a sender without it is a dead channel rather than an
   idle one). A warning at boot is cheaper than a campaign nobody received.
3. Point your uptime monitor at `GET /api/health`. It reads no database, so it can be
   polled as often as you like. It answers **503 in exactly one case**: the queue worker
   claims to be running and has gone silent — the one state a restart fixes. A deep
   queue, an empty queue and a paused platform are all 200, deliberately: alerting on
   queue depth takes a healthy node out of rotation.
4. Point your log alert at the string `[jobs] queue degraded`. The worker re-assesses
   itself every five minutes and writes one line per problem (a queued type with no
   handler, a runnable backlog, a job stuck past the reclaim window, a worker that
   stopped ticking, failures in the last 24 h). There is no external alerting service
   wired in — this is the alerting path.
5. Open `/app/admin` once and read the two verdicts in words: the autonomy card and the
   job queue card. The Admin page is where "is the loop alive?" is answered; the app
   shell banner is where every non-admin sees that it is not.

## 6. One full live rehearsal (P0.4)

Nothing below is verified until someone does it with real providers. Take notes; this is
also the moment the docs get corrected.

1. Platform autonomy **paused** (Admin → pull the switch).
2. Profile + ICP in the app (`/app/onboarding`), one campaign with the ICP linked.
3. **Run discovery**. Expect real companies with evidence-backed reasons. With no
   `SGAI_API_KEY` and no `DISCOVERY_PROVIDER=open` this returns demo data and the
   rehearsal proves nothing.
4. Open a prospect. If the second pass found nobody, add the contact by hand (a real
   address you are allowed to mail — your own mailbox is the safest choice) and confirm
   the MX check accepts it.
5. Generate a draft, edit it, **send**. Read it in the inbox: footer with unsubscribe
   line, postal address, `/privacy` link; `List-Unsubscribe` + `List-Unsubscribe-Post`
   headers present (show original); where it landed (inbox vs spam). Then deliberately
   send one with SMTP unset and confirm the app calls it simulated instead of sent.
6. Reply from that inbox. Expect the event to arrive at the pipeline within a minute:
   the thread on the prospect page updates and the reply is classified. The
   Conversation must show **both** halves in order — the message that was mailed and
   the answer. A thread that shows only the reply hides what the automation did.
7. With autonomy paused, expect **no follow-up job row created at all**. Confirm it in
   `job_runs` — this is the fact the app banner states, and the reason the inbox has to
   be read by hand during an incident.
8. Release autonomy. Reply again from the test address: now a `reply.followup` job is
   queued, claimed after the 60 s debounce, and the AI follow-up arrives with the
   tracked CTA rewritten to `/api/track/cta/…`.
9. Click the CTA → Calendly books on the test event → the webhook fires → the
   opportunity stage becomes `meeting_booked` **from the callback, not from the click**.
   Payment link → Stripe test mode → `checkout.session.completed` → `won`, with the
   amount from the event.
10. Send yourself one unsubscribe click and one one-click POST. Confirm the address is
    suppressed, that a later send attempt to it stops at status `suppressed` instead of
    delivering, and — in Settings → Data subject requests — that the export returns the
    rehearsal rows and the erasure deletes them while the suppression entry survives.
11. Only if a messenger channel is configured: put the plain `https://t.me/<bot>` link in a
    message to your own test address, click it, and press Start in Telegram. Then confirm
    the prospect page shows a Telegram row with the consent date, that the stage did **not**
    move, that sending without that row is refused in words, that `STOP` revokes it, and
    that the chat appears in the Conversation labelled as Telegram.

If step 9 shows a stage that came from anything other than a provider callback, stop:
the funnel is reporting theatre again.

## 7. Legal, before this is public

1. Fill `CONTROLLER` in `shared/legal.ts`: legal entity name, monitored privacy mailbox,
   EU representative (or the explicit words "not applicable"), governing law, hosting
   region. The `/privacy` and `/terms` pages carry a draft banner until every placeholder
   is gone — that is deliberate, and publishing them filled would be the failure mode this
   whole feature exists to prevent.
2. Trim `SUBPROCESSORS` to the providers actually configured, and keep it honest as the
   deployment changes.
3. Have the text reviewed by someone who can accept liability for the jurisdiction you
   send from and to. The documents state the basis the code is built around
   (Art 6(1)(f) legitimate interests, with the product's own restrictions as the
   balancing evidence); whether that basis holds for a given campaign is a legal
   question, not a software one.
4. Know the one asymmetry that is by design: an erasure keeps the suppression entry
   (forgetting an opt-out is what causes the next campaign to mail that person) and
   blocks automated re-collection of that address, while a human may still add the
   contact deliberately.

## 8. Then launch

Enable per-workspace autopilot for one campaign, at the smallest plan limit, and watch
the Admin queue card and the server log daily for the first week. The kill switch exists
because a sender reputation takes weeks to build and one bad burst to lose.

## Not covered by this runbook

- **Billing.** `BILLING_PROVIDER` is `mock` until the Platega credentials land; plans and
  entitlements are enforced locally either way. Handled separately.
- **Channels other than email, beyond the reply path.** Telegram and WhatsApp may only be
  written to after that person messaged us there (`docs/ai-agents.md`, "Answering on the
  prospect's terms"); nothing here can grant that permission from a stored number. SMS and
  ringless calls do not exist at all, and social profiles are stored but never posted to.
  Billing is listed above; these are the other things this runbook does not cover.
- **SES authenticity.** The inbound route authenticates possession of the shared secret,
  not that Amazon sent the request; verifying the SNS signature is still outstanding.
