# Autonomous AI-SDR layer

This document is the contract referenced from `shared/const.ts`, `drizzle/schema.ts`,
`server/_core/env.ts` and `server/autonomy.test.ts`. Change the behaviour, change
this file.

## Operating model: cyborg, not autopilot

Every autonomous move is gated by a **per-workspace** switch, `workspaces.autopilot`
(see the column comment in `drizzle/schema.ts`). It is toggled by the operator on the
in-app Settings page — never by the AI, and never as a global default. A platform
operator can override all of them at once; see "The switch above the switch" below.

| `autopilot` | Behaviour |
| --- | --- |
| `false` (default) | The system drafts and classifies, but a human approves and sends each message. |
| `true` | Inbound replies may enqueue an AI-written follow-up without a human click. |

Autonomy is scoped to *sending the next message in an existing conversation*. It can
never create campaigns, change plans, edit entitlements, or reach the admin surface.

### The switch above the switch

`workspaces.autopilot` is a tenant's own preference. It is outranked by a **platform
master switch**, `system_state.autopilotPaused` (`server/services/autonomyState.ts`),
which an admin toggles on the in-app Admin page (`admin.autonomy` /
`admin.setAutonomy`). Two levels, two different jobs:

| Gate | Enforced in | What it cannot do alone |
| --- | --- | --- |
| `workspaces.autopilot` | `isAutopilotEnabled()` → reply ingest | Stop work already in the queue: the flag is read when a follow-up is *created*. |
| `system_state.autopilotPaused` | `runNextJob()` **and** `isAutopilotEnabled()` | Nothing on its own — it is the backstop for bursts that were queued before the lever was pulled. |

Properties that are load-bearing, and asserted by tests:

- **Persisted, not in memory.** A restart — including one caused by a crash — must not
  silently resume sending to real prospects.
- **Fails closed.** A switch that cannot be read (unapplied migration, dead pool,
  query error) counts as *paused*. `autonomyAllowed()` is pure so this polarity is a
  unit test, not a reading-comprehension exercise.
- **Queued work is held, not dropped.** It runs on resume, so pausing during an
  incident neither sends the burst nor loses the pipeline.
- **Two independent enforcement points.** Both are needed; see the table above.

## The one loop that runs unattended

```
inbound email (ESP webhook)
  -> ingestEmailEvent()            server/services/replies.ts
     -> dedupe on (workspaceId, dedupeKey)
     -> classifyReply()            8 labels, shared/const.ts REPLY_LABELS
     -> update prospect / opportunity
     -> IF autopilot ON and label is a FOLLOWUP_TRIGGER:
          enqueueJob("reply.followup", runAfter: now + 60s)
  -> job worker claims atomically   server/services/jobs.ts
  -> reply.followup handler         server/services/jobHandlers.ts
     -> getProspectThread()         multi-turn memory from email_events
     -> generatePersonalization()   objection-aware draft
     -> sendOutreachEmail()         same idempotent pipeline a human uses
```

The 60-second debounce is deliberate: a burst of inbound events for one prospect
coalesces into a single follow-up instead of a reply storm.

### Trigger labels

`FOLLOWUP_TRIGGER_LABELS` = `positive`, `interested`, `question`.

Everything else **stops** the sequence: `not_interested`, `unsubscribe`,
`out_of_office`, `neutral`, `unknown`. Adding a label to the trigger set is a
compliance decision, not a tuning knob — `server/autonomy.test.ts` asserts that
disengagement labels can never appear there.

### Bounding runaway sends

`sendOutreachEmail` enforces plan entitlements server-side (`enforceFeature` /
`enforceLimit` / `recordUsage` in `server/services/entitlements.ts`). Re-enabling the
same message is prevented by the unique `(workspaceId, idempotencyKey)` index on
`outreach_messages`. A retried job therefore never double-emails a prospect.

## Discovery cadence

`DISCOVERY_INTERVAL_HOURS` (default `0`) turns the job worker into a lightweight cron:
after `campaign.discovery` completes, a positive interval re-enqueues the same
campaign. `0` disables recurring discovery entirely — there is no scheduler dependency.
Note the asymmetry with the table above: the re-enqueue does **not** consult
`workspaces.autopilot` (a discovery run emails nobody, so the per-tenant sending
switch has never applied to it), but the master switch does stop it, because the
worker refuses to claim any job while autonomy is paused.

## Contact discovery: the second pass over the company's own pages

Search results describe companies; they rarely name a human. So after discovery
returns candidates that have no contact, `runDiscovery` (`server/db.ts`) makes a
second pass — `/contact`, `/contact-us`, `/team`, `/about`, `/about-us`,
`/company` — through `server/services/contactExtraction.ts`. Without it the
pipeline produced prospects that could be scored but never written to.

The rules that make this safe to run unattended:

| Rule | Why it is load-bearing |
| --- | --- |
| **No LLM anywhere in the email path.** Selection is regex + ranking over scraped text. | A model asked for "the decision maker's email" invents a plausible one. A fabricated address means cold-mailing a stranger with someone else's name — and no test would catch it. Every address returned appeared verbatim on a page we fetched. |
| Scrape with `formats: [{ type: "markdown", mode: "normal" }]`, no prompt, no schema | `reader` mode drops boilerplate, and on a contact page the footer *is* the content we want. Also keeps the call LLM-free and cheaper. |
| Pages fetched one at a time, stopping at the first named person on the company's own domain | Scraping is billed per call. Finding the owner on `/contact` must not be followed by five more requests. |
| Junk is dropped (`noreply@`, asset filenames, `example.com`, numeric ids); role mailboxes are **ranked last, not filtered** | `hello@` is the only published address for most five-person companies. It is returned with `name: ""` so the draft greets generically instead of writing "Dear Hello". `privacy@`/`legal@`/`dpo@` are kept deliberately. |
| Name source is recorded: `page` (the company printed it) beats `email` (derived from `jane.doe@`) beats `none` | The operator can tell a real name from a guess. |
| `sourceUrl` stored on the contact and shown in the UI | Provenance: click through to the page that published it before deciding to mail. |
| `MAX_CONTACT_ENRICHMENTS` (default 10) caps companies per run; `0` disables the pass | Budget control, not a target. |
| Mock/demo providers return **no pages at all** | An invented demo domain can be registered by a real business today; "finding" and mailing its owner would launder fake data into a live campaign. |
| Scraped addresses get the same MX check as manual ones | `verified` means "this domain can receive mail", no more and no less. It is *not* mailbox verification — we do not claim that. |

On demand: `contact.enrich` (tRPC, protected) runs the same pass for one prospect
from its detail page. It is capped twice — the plan's AI-run budget plus a
per-workspace 5-per-10-minutes wall-clock limit — because each click spends the
platform's scraper credits. It returns `null` ("they publish nothing") rather than
throwing, so the UI can report an honest empty result, and it refuses demo
prospects and unconfigured providers with a message instead of silence.

## Funnel stages are evidence-driven, never cosmetic

`opportunities.stage` advances only when something *external confirms it happened*.
The `reply.followup` handler used to promote a deal to `meeting_booked` merely because
it had sent a message; that was funnel theatre and it is gone.

Current authoritative mapping:

| Stage | Set by | Evidence class |
| --- | --- | --- |
| `open` | prospect created | — |
| `responded` | inbound reply classified engaged | real inbound email |
| `negotiating` | click on the payment-link CTA | tracked CTA click (`/api/track/cta`) |
| `meeting_booked` | Calendly `invitee.created` webhook (v2; `payload.resource.email`) | provider callback |
| `won` | Stripe `checkout.session.completed` with `payment_status=paid`, or an activated billing subscription | money moved |
| `lost` | human decision in the UI | operator |

Two rules enforced by `canAdvanceStage` / `isTerminalStage`
(`server/services/opportunity.ts`):

1. Terminal stages (`won`, `lost`) are irreversible from the pipeline.
2. Non-terminal stages only move forward.

A click on a *booking* CTA records an event but deliberately does **not** set
`meeting_booked` — clicking a scheduling page is intent, not a booked meeting. Only
the Calendly callback is trusted for that stage.

### Required operator configuration

Closing the loop needs these to be set *and* pointed at the deployed origin:

- `CALENDLY_URL` — set the event webhook to `POST /api/conversions/calendly`.
- `STRIPE_PAYMENT_LINK` — payment-link CTA is auto-wrapped for click tracking.
- `CALENDLY_SIGNING_SECRET` / `STRIPE_WEBHOOK_SECRET` — signature verification.
  **While a secret is unset the corresponding endpoint rejects everything** (503),
  so a misconfigured deployment cannot be spoofed into fake `won` deals.

## Integrations that are wired but NOT yet verified end-to-end

The loop above runs against a real MySQL in CI
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and
[docs/verification.md](./verification.md)): schema drift, the reply → follow-up job,
evidence-driven stage moves, webhook contracts and the master switch are all executed
there. What has never happened is a run against real third parties — a live SMTP
mailbox with SPF/DKIM/DMARC, a real Mailgun/SendGrid inbound route, real Calendly and
Stripe subscriptions, a real ScrapeGraph key. Execute the live checklist before
mailing actual prospects; that is not optional.

## Deliberate constraints

- Email is the **only outbound channel**. There is no phone/SMS, Telegram or WhatsApp
  sender, and `contactExtraction` does not mine social profiles — scraping LinkedIn
  and friends breaks their ToS, and an agent that gets its key revoked is worse than
  one that has fewer channels. Numbers and social handles can be stored and used only
  via a compliant enrichment provider.
- Outbound is text/plain (plus optional HTML) with a `List-Unsubscribe` header and the
  RFC 8058 one-click POST — see `server/services/email.ts`. This is a deliverability
  requirement for Gmail/Yahoo bulk senders, not a nicety.
- Every provider payload is stored under a deterministic `dedupeKey` so replayed
  webhooks are no-ops.
- Original inbound bodies are preserved in `email_events.body_text` for audit.
