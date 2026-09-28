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

### The paid route to a person: enrichment

Reading a company's own pages finds only what that company chose to print. When it
prints nothing, or only `hello@`, the remaining *lawful* route to a named person —
and to a phone number or profile, which scraping LinkedIn would otherwise have to
get by breaking its terms of service — is a vendor that licenses the data.
`server/services/enrichment.ts` speaks to Hunter.io (`domain-search`) and Apollo
(`mixed_people/api_search` then `people/match`). Clay is not wired: it has no public,
transcribable API, and writing an adapter for it would be a guess dressed as a feature.

| Rule | Why it is load-bearing |
| --- | --- |
| **Nothing is bought unless `ENRICHMENT_PROVIDER` names the provider.** A key in the environment is not consent. | Otherwise any code path that happens to touch enrichment starts charging money, and the deployment owner learns about it from an invoice. |
| The paid leg runs only when the operator clicked "Buy a lookup", and only when the free pass failed to name a *person* | Spending is a deliberate act, and it should be spent where free reading came back empty — not on a name the company already published. |
| Unattended discovery buys nothing unless `ENRICHMENT_AUTO_DISCOVER=true` — a second switch, on top of `ENRICHMENT_PROVIDER` | This is the same rule the autopilot follows everywhere: autonomy may spend effort, never money by surprise. When it is on, the bought lookups share the `MAX_CONTACT_ENRICHMENTS` budget, so one knob still bounds what a run can cost. |
| Before anything is stored, a record is refused if it is a personal mailbox, a role mailbox (`info@`, `support…`), a `low`/`none` match, or labelled `risky`/`invalid`/`catch_all`/`role` | We are paying for a named human at the company's own domain. Anything else is a stranger with a bought address — and a bad mailbox damages the sending domain, not merely this one message. |
| An obfuscated name (`Hu***n`) is never used as a name | Apollo's search results hide surnames until the paid enrichment; greeting "Dear Hu***n" is worse than greeting nobody. |
| `reveal_personal_emails` and `reveal_phone_number` are never requested | The first is exactly what the rule above refuses; the second costs 8 credits and arrives on a webhook this app does not have. Numbers are taken only when the synchronous response already carries them. |
| Phones and profile URLs are stored but never sent | `outreach_messages.channel` is an enum with the single value `email`. A phone number is a coordinate for a human to act on, and the UI labels it "recorded only". |
| `contacts.origin` ∈ `manual` \| `page` \| `provider`; a re-run fills empty fields and overwrites nothing | Provenance decides what you may lawfully do with a record and how much to trust it. An operator typing an address outranks a scrape; a scrape outranks a bought guess. |
| The request URL is scrubbed of `api_key` before it is stored as `sourceUrl` | Hunter authenticates in the query string and `sourceUrl` is a column the browser renders. Without this, every contact row is a credential leak. |
| A provider that is down degrades to "no data" plus a warning; a provider that is *not configured* throws | "They are not in the database" is a fact about the prospect; "you have not set ENRICHMENT_PROVIDER" is a fact about the deployment. Only the second should look like an error. |
| `ENRICHMENT_MAX_PEOPLE` caps records per lookup | Apollo bills per person, and its two-call shape (search, then match) means the cheap filter has to run before the spend, not after. |

Field-name honesty, stated because it changes how much these tests are worth: the
Apollo mapping is transcribed from Apollo's published OpenAPI, the Hunter mapping from
the examples in their docs — whose site could not be reached from the network this was
written on. Every Hunter field is therefore read through an alias list, and the first
live call must be diffed against a logged raw body (`docs/verification.md`, §8).

## Watching the loop: worker and queue monitoring

A queue that stops moving is the worst failure this system has, because it fails
quietly: HTTP keeps answering, nothing throws, and no follow-up is ever sent.
`queueReport()` ([server/services/jobs.ts](../server/services/jobs.ts)) exists to make
five specific silent failures loud. `summarizeQueue()` is deliberately pure — the SQL
only counts rows — so every verdict an operator relies on is testable
([server/jobs.test.ts](../server/jobs.test.ts)) instead of a reading exercise over SQL.

| Signal | The failure it detects | Why it is not covered elsewhere |
| --- | --- | --- |
| Queued type with no handler in this process | work that waits forever | the row is perfectly valid; only this build cannot run it |
| Runnable job older than 15 minutes | throughput collapse | count-only views show "12 queued" as neutral |
| `running` rows past the reclaim window | a worker that died mid-job | they are invisible until the window expires |
| Worker running but not ticking | a wedged loop or a blocked event loop | the process is up, so liveness probes pass |
| Failures in the last 24 h | slow rot | a queue that drains *and* fails looks healthy |

Three separations the code insists on:

- **Liveness is not queue depth.** `/api/health` answers 503 only when the worker claims
  to be running and has stopped ticking — the one state a restart fixes. A backlog never
  makes an instance look down, because a backlog is normal and dropping a node over one
  turns an inconvenience into an outage. It reads process state only, no database query,
  so a monitor may poll it as often as it likes.
- **Held is not stalled.** While the master autonomy switch is pulled, waiting work is the
  switch doing its job and is reported as `heldMinutes`, not as a problem. The exception is
  a worker that is not running at all: pausing cannot disguise a dead worker, because
  nothing would drain the queue on resume either.
- **Unrunnable is not slow.** Work with no handler is diagnosed as impossible, and is
  excluded from the backlog measure — telling an operator "the oldest job has waited 3
  days" when the real answer is "nobody here can run this type" sends them to the wrong
  lever.

Alerting, without an alerting service: the worker assesses itself every 5 minutes and
writes one `[jobs] queue degraded: …` warning per problem into the process log, which is
the string to point a hosting provider's log alert at. The heartbeat is stamped at the
*start* of each tick, so a discovery job that runs for minutes is not mistaken for a
wedged loop; the grace period is five ticks, floored at one minute, and the stuck-job
window shares one constant with the reclaim path so the two can never disagree.

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

## The person on the other end: legal basis and data-subject rights

An agent that finds strangers and writes to them is doing processing of personal data,
so the law is part of the loop rather than a page footer. Two things are true here, and
both are enforced in code before they are claimed in text.

**The basis is legitimate interests (Art 6(1)(f)), and the restrictions *are* the
balancing test.** A recorded assessment that the recipient would expect this message is
worthless if the product does whatever it can get away with, so the controls below are
what the privacy policy points at — `shared/legal.ts` and `server/gdpr.test.ts` bind the
policy sentences to real code behaviour:

| Control | Where |
| --- | --- |
| Role mailboxes (`info@`, `support@`) rank last on the free page pass, and a bought one is refused outright | `server/services/contactExtraction.ts`, `rankPeople` in `server/services/enrichment.ts` |
| Buying contacts is opt-in per deployment *and* per run; a key alone spends nothing | `ENRICHMENT_PROVIDER` / `ENRICHMENT_AUTO_DISCOVER` |
| Suppressed addresses cannot be sent to, checked at send time | `isSuppressed` in `server/services/outreach.ts` |
| A forgotten address cannot be re-collected by an automated write | `addressWasForgotten` in `server/services/gdpr.ts`, called by `upsertContact` |
| Unsubscribe is one click both ways: the RFC 8058 headers and the `POST /api/replies/unsubscribe` they point at (unguessable `ref` token, idempotent) | `buildUnsubscribeHeaders` in `server/services/email.ts`, `server/_core/conversionWebhooks.ts` |
| Every outbound message carries unsubscribe, postal address and the policy link | `buildFooter` in `server/services/email.ts` |
| No social-network scraping | `server/services/contactExtraction.ts` |

**Rights are operations, not promises.** `server/services/gdpr.ts` implements
`exportSubjectData` (everything held about one address, plus `provenance` lines
explaining where it came from) and `eraseSubjectData`, exposed as `gdpr.export` /
`gdpr.erase` and driven from Settings → Data subject requests. Answering in the
conversation that asks is only possible because a subject is one query away.

Two erasure decisions are deliberate and should not be "fixed":

1. **The suppression entry survives.** Forgetting an opt-out is precisely what makes the
   next campaign mail that person again, so Art 17(3)(b) applies and the retained row is
   reported to the operator with its reason instead of being quietly kept.
2. **The company record survives, detached.** A prospect row is a company's place in a
   campaign; wiping it destroys someone else's research and lets the build claim more
   than it did. Erasure nulls `contactId`, `reasons` and `disqualifiers` on it — the part
   that was an assessment of the person — and cancels queued jobs, because a follow-up
   waiting to run is the only row in an erasure that can still send mail tomorrow.

The policy and terms are shipped as drafts: `CONTROLLER` in `shared/legal.ts` holds the
operator's legal name, contact address, EU representative, governing law and hosting
region, all of it `TODO:` until filled, and `client/src/pages/Legal.tsx` prints a loud
"not yet fit to publish" banner while any placeholder remains. The code can write the
structure; only the operator can sign the statement.

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
  requirement for Gmail/Yahoo cold mail, not a nicety. The body footer adds the postal
  address (`SENDER_POSTAL_ADDRESS`, a CAN-SPAM requirement) and a link to `/privacy`.
- Every provider payload is stored under a deterministic `dedupeKey` so replayed
  webhooks are no-ops.
- Original inbound bodies are preserved in `email_events.body_text` for audit.
