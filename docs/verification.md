# Pre-launch verification

CI proves the logic. It cannot prove the integrations, because a GitHub Actions
container has no mailbox, no Calendly account and no Stripe live mode. **Nothing in
the "must verify live" list below has ever been executed for this project.** Until it
has, do not enable per-workspace autopilot against real prospects.

This page is the checklist; [launch.md](./launch.md) is the runbook that puts these items
in the order they can actually be done, and `pnpm preflight` automates every
configuration reading of steps 1–4.

What CI already covers (`.github/workflows/ci.yml`):

- `pnpm check` — TypeScript over server, client and shared code.
- `pnpm test` — unit tests (`server/jobs.test.ts` for the queue report and the
  heartbeat arithmetic, `server/gdpr.test.ts` for which job rows an erasure is allowed
  to cancel and for the factual claims the privacy policy makes about the code,
  `server/channels.test.ts` for the messenger consent rules — what may grant permission,
  what must refuse a send, the 24 h window arithmetic and its cap, and the exact shape of
  each provider request), plus
  `server/integration.test.ts` against a real MySQL 8
  container: baseline migration matches `schema.ts`, outreach send + idempotent retry,
  reply ingest → classification → opportunity → follow-up job claimed and completed by
  the worker, the full CTA → Calendly → Stripe walk to `won`, webhook replay inertness,
  the cross-tenant address-collision refusal, the master autonomy switch holding a
  queued job, blocking new queuing, surviving a read-back, and releasing on resume,
  the contact search refusing a prospect that belongs to another workspace, a queue
  report that names a job type nothing handles instead of calling it healthy, a
  messenger permission that only an inbound event can create and only the prospect can
  revoke, and a subject-access export followed by an erasure that leaves the suppression
  entry and detaches the prospect.
- Contact selection itself is pure string work and is covered by `server/contacts.test.ts`
  against fixture markdown: no fabricated address can appear, `noreply@`/asset
  filenames/documentation placeholders are refused, role mailboxes rank last instead of
  being dropped, page-printed names win over names guessed from the local part, and the
  page walk stops as soon as it has a named company-domain contact (and returns nothing
  at all for demo companies).
- `pnpm build` — Vite client bundle + esbuild server bundle.
- `pnpm smoke` (`scripts/smoke.mjs`) — boots the real server with no database and
  asserts the HTTP edge: tracked CTA clicks redirect to the configured Calendly/Stripe/Telegram
  targets (the Telegram one carrying our reference as the bot's `start` parameter), an
  unknown CTA kind is a `404` with no `Location` (so the endpoint cannot be
  abused as an open redirect), unsigned / wrong-secret / tampered-body / stale-timestamp
  provider callbacks are all `401`, a validly-signed callback that cannot be persisted
  answers `503` so the provider retries instead of losing the signal, and both the
  one-click `POST` and the `GET` landing page of the unsubscribe route work. The messenger
  endpoints are checked twice over: with their secrets configured (a missing or forged
  Telegram secret and a missing, forged or mis-paired WhatsApp signature are each `401`,
  the `hub.challenge` handshake only answers the configured token, and an update from a bot
  is acknowledged rather than stored), and in a second boot with no channel credentials at
  all, where every inbound route answers `503`.

> **Status: runs #12-#15 were red, and this page said "green" through all of them.**
> The failure mode was not a flaky test; it was a claim nobody checked. This machine
> cannot run Docker at all (`wsl -l` reports that Windows Subsystem for Linux is not
> installed, so the Linux engine answers `request returned 500`), which means
> `server/integration.test.ts` has been skipping itself on every local run since then
> while still printing a reassuring "214 passed". Five things were wrong in that file,
> and the runner found them one at a time, each hidden behind the last:
>
> 1. The subject-access test inserted its second prospect on the *shared* fixture
>    company, which `prospects_campaign_company_unique` forbids - a campaign holds
>    exactly one prospect per company. The test now gives that data subject their own
>    company. The constraint is right and is what the product needs; the fixture was
>    quietly pretending otherwise.
> 2. The messenger test proved a real defect rather than a bad assertion: attribution
>    accepted only our own `start` reference (or a WhatsApp phone match), but a
>    follow-up message in an existing chat carries neither. So **"STOP" could never be
>    tied to the person who sent it** - revocation was unreachable in production. An
>    existing `channel_identities` row is now also an attribution path, with ambiguous
>    matches still refused. See `knownIdentities()`.
> 3. The subject-access test compared the dossier's address against the mixed-case string
>    it had passed in. The dossier answers in the normalised form every row is keyed on,
>    so the assertion was written by someone who had never watched that line execute.
> 4. The master-switch case assumed it owned the entire queue (`toEqual([jobId])`). That
>    only appeared to hold because failure 1 aborted the erasure test before it could
>    leave a queued job behind. It now compares against a snapshot of what was already
>    queued when the lever was pulled - which is the claim it meant to make anyway.
> 5. The same test asserted the post-erasure export was `null`. It is not, and must not
>    be: the "remove me" reply puts the address on the suppression list, and that entry
>    is the only thing which outlives the erasure and keeps the next discovery run from
>    collecting the person again. The assertion contradicted this page's own description
>    of the case, and a duplicate suppression insert queued behind it would then have
>    tripped the unique index. Both now assert what the promise actually is.
>
> `REQUIRE_INTEGRATION_TESTS` on the runner is what makes "the suite ran" mean "the
> suite executed": without it a file of silent skips reports success, which is how
> run #1 nearly fooled us - and runs #12-#15 fooled us one level higher up, at the
> summary line. The rule this leaves behind: after any push that touches
> `integration.test.ts`, open the run on GitHub and read it before writing a word about
> it being green. Run #18 carries all five fixes; confirm it before repeating any claim
> on this page. `pnpm smoke` passes locally and on the runner either way - it needs no
> database, so it proves the HTTP edge and nothing about the schema. Note the shape of
> this failure: fixing two red tests revealed three more that had never been reached, so
> "I fixed the two bugs" is not the same statement as "CI is green", and only the second
> one is worth writing down. What remains genuinely unverified is everything below, which
> no container can cover.

## Must verify live

Run each of these once, against a deployed instance with real credentials. Record the
date and the outcome in the PR that enables autopilot.

### 1. Database and migrations

- [ ] `pnpm db:migrate` against the target MySQL/TiDB succeeds on an empty database.
- [ ] Boot logs contain **no** `[schema]` lines. Any that appear name the exact
      `ALTER TABLE` to run — see [database.md](./database.md).
- [ ] `/api/health` returns `{"ok":true,"hasDb":true,"worker":{"running":true,…}}`.
      It answers 503 only when the job worker claims to be running and has stopped
      ticking — see [9. Worker and queue monitoring](#9-worker-and-queue-monitoring).
- [ ] `/api/health` with no database at all returns 200 and `"hasDb":false` (a dev box
      that never started a worker is not an incident).
- [ ] `system_state` exists. A deployment that has not applied `0001_*.sql` reads as
      **paused everywhere**: `autonomyAllowed()` treats an unreadable switch as
      stopped, so nothing autonomous happens *and* nothing errors. That silence is the
      fail-closed rule working, not a bug report — so confirm the Admin page renders
      the switch as unreadable rather than as "live", and treat applying the migration
      as the decision to re-enable autonomy, not as an unattended deploy step.

### 2. Outbound deliverability

- [ ] Send to a Mail-Tester style address; confirm SPF, DKIM and DMARC all pass.
- [ ] Confirm the received message carries `List-Unsubscribe: <https…>` and
      `List-Unsubscribe-Post: List-Unsubscribe=One-Click` in the raw headers
      (`server/services/email.ts`). Gmail and Yahoo reject bulk mail without them.
- [ ] Click the footer unsubscribe link → prospect becomes `suppressed`, and a
      subsequent send to that address returns `status: "suppressed"` without mailing.
- [ ] POST to the same URL with body `List-Unsubscribe=One-Click` → `200 Unsubscribed.`
      (the one-click path mail clients use without asking the user).
- [ ] Open the prospect afterwards: the Conversation must contain **the message that was
      sent**, not only what came back. `outreach_messages` and `email_events` are joined
      in `getProspectThread()`; a thread that hides the outbound half is how a sender that
      delivers nothing passes for a working one.
- [ ] With SMTP deliberately unset, send once: the message must be recorded, the provider
      note must say it was simulated, and both the toast and the thread entry must refuse
      to call it delivered.

### 3. Inbound loop

- [ ] Configure the ESP's inbound webhook to `POST /api/replies/webhook/<provider>`
      with `REPLY_INGEST_SECRET` set, then reply to a sent message from the prospect
      mailbox. SES arrives via SNS, which cannot carry an HMAC of our choosing, so
      register the subscription as `/api/replies/webhook/ses?key=<secret>` — that
      proves the sender holds the secret but **not** that Amazon sent the request;
      SNS certificate verification is still to be implemented.
- [ ] A row appears in `email_events` for that workspace with `eventType = "replied"`,
      `bodyText` = the full original body, and a non-null `classification`.
- [ ] Reply with "I'm not interested" → prospect becomes `not_interested` and **no**
      `reply.followup` job is queued. This is the compliance-critical direction.
- [ ] Reply with "unsubscribe" → prospect suppressed, no follow-up queued.
- [ ] Send the same webhook payload twice → second call returns `duplicate: true`
      and produces no second classification or job.
- [ ] Stop MySQL, then deliver a correctly-authenticated webhook: the endpoint must
      answer `500` and the server must **stay up**. It used to throw out of an async
      handler, which Express does not catch, so the unhandled rejection killed the
      process and the provider's retry killed the replacement — one database blip
      became a crash loop. `pnpm smoke` asserts this shape without a database.
- [ ] With `CALENDLY_URL`/`STRIPE_PAYMENT_LINK` set, the URL inside a delivered
      message points at `/api/track/cta/<ref>/<kind>`, and clicking it lands on the
      real Calendly/Stripe page (`server/services/cta.ts`).

### 4. Autopilot loop, end to end

- [ ] Turn autopilot on for a throwaway workspace. Send an invite, reply "Sounds
      good, let's talk" and wait past the 60-second debounce.
- [ ] `job_runs` shows the `reply.followup` row go `queued` → `completed`, and a
      second `outreach_messages` row appears for the prospect.
- [ ] Read that follow-up: it has to answer what was actually said. The writer's history
      now includes our own outbound messages, so a follow-up that ignores the first email
      or repeats it verbatim means the memory join broke.
- [ ] The opportunity stage stays `responded` after that follow-up. If it moved to
      `meeting_booked`, the cosmetic-advancement bug is back — that is a blocker.
- [ ] Kill the server mid-job and restart; the stuck `running` row is reclaimed after
      10 minutes (`runNextJob` crash recovery) rather than being lost.
- [ ] Pull the **master autonomy switch** mid-burst (Admin page, or
      `admin.setAutonomy`): follow-ups already queued must not go out, a new inbound
      reply must not queue anything, and resuming must complete the held job. Then
      restart the server *while paused* and confirm it comes back paused — the state
      lives in `system_state` precisely because an in-memory flag would be forgotten
      by the crash you pulled the lever during.

### 5. Conversion callbacks

The `401`/`503` status contract for both endpoints is already asserted by `pnpm smoke`.
What CI **cannot** check is that a real delivery resembles the fixtures we wrote.
Two assumptions have now been corrected against the providers' own documentation
instead of inference: Calendly signs `t=…,v1=…` (**not** `v0`) on the
`Calendly-Webhook-Signature` header, and its v2 payload carries the invitee at
`payload.resource.email` under an `invitee.created` event — `event.created` and
`payload.invitee` were the retired v1 shape, which the handler alone read, so no
live booking could ever have converted. Stripe's `t=…,v1=…` scheme and its
`checkout.session.completed`, `client_reference_id`, `customer_email`,
`amount_total` and `payment_status` fields were already right.

What remains unproven is a captured payload, since documentation can still be
wrong about a specific account's subscription version:

- [ ] Trigger a real Calendly webhook and diff the raw logged body against what
      `parseCalendlyPayload` expects (compare the body in a log, not just a `200`).
- [ ] Book a real Calendly event with the webhook attached → deal reaches
      `meeting_booked`, and a `converted` row appears in `email_events`.
- [ ] Cancel the event → recorded, but the stage does **not** move backwards.
- [ ] Stripe: complete a live test-mode Payment Link purchase with the webhook
      attached → deal reaches `won`, `valueCents` matches, prospect becomes `won`.
- [ ] Confirm the payer's `customer_email` actually resolves back to the outreach row —
      see the Payment Link limitation at the bottom of this file.
- [ ] Re-send a stored provider event id → `duplicate: true`, stage unchanged.

### 6. Tenancy

- [ ] Two workspaces emailing the **same** address: an inbound reply must be refused
      rather than attributed arbitrarily (`resolveOutreach` returns null and nothing
      is written). Covered in CI; re-check on production data volumes.
- [ ] A non-admin session cannot reach any `admin.*` tRPC procedure, and cannot read
      another workspace's prospects by guessing ids.

### 7. Contact discovery

The selection rules are unit-tested; what no test can prove is that a real company
website produces a real, correctly-attributed address rather than nothing.

- [ ] Run discovery on a known company whose team page prints an email. Confirm the
      `contacts` row has that exact address, a `sourceUrl` that opens on the page
      printing it, and a name the company actually published — not a plausible guess.
- [ ] Run it on a site that publishes only `hello@`. The contact must be stored with an
      empty name (the draft then greets generically), never with "Hello" as a person.
- [ ] Run it on a site with no published address. Discovery must still complete and the
      prospect must simply have no contact — a failed enrichment may not lose the run.
- [ ] Click "Search their site" on a prospect five times in ten minutes: the sixth must
      be refused with a rate-limit message, not silently spend more scraper credits.
- [ ] Confirm a demo/free-plan workspace can never trigger a search (the button is not
      offered, and `contact.enrich` refuses server-side).
- [ ] Check `MAX_CONTACT_ENRICHMENTS` in the logs: a run of 20 candidates must not
      scrape more than the configured number of companies.

### 8. Paid enrichment (Hunter / Apollo)

Nothing here is verifiable offline: the fixtures in `server/enrichment.test.ts` are
transcribed from the providers' published API docs, and a provider can rename a
field without telling anyone. So the first live call must be *compared*, not just
observed to succeed.

- [ ] With `ENRICHMENT_PROVIDER` unset and only a key in the environment, confirm no
      lookup is bought: "Buy a lookup" must not appear, and `contact.enrich` must
      refuse. A key present is not consent to spend.
- [ ] First live call: log the raw response body and diff it against the field names
      the mapping reads (`data.emails[]` for Hunter; `people[]` then `person` for
      Apollo). Hunter's mapping is the less certain one — its docs site was not
      reachable when this was written, so every field is read through an alias list.
- [ ] Confirm the stored contact is a person at the company's own domain: never a
      `@gmail.com`, never `info@`, never a `low`/`none` match, never a mailbox the
      provider labelled `risky`/`invalid`/`catch_all`. Each is refused on purpose and
      each refusal is unit-tested — but only a live call shows whether the provider
      puts those values where we expect them.
- [ ] Check `contacts.origin` is `provider` and the UI says "bought lookup" instead of
      offering a "Published on this page" link for something no page printed.
- [ ] Verify the stored `sourceUrl` contains no API key (Hunter authenticates in the
      query string, and this column is rendered in the browser).
- [ ] Confirm a phone number returned by the provider is displayed as "recorded only"
      and that no code path attempts to send to it: `outreach_messages.channel` allows
      exactly one value.
- [ ] Trigger a provider failure (bad key, or disconnect) and confirm the click reports
      "no data" while an unconfigured provider still reports the configuration error —
      different sentences for different facts.
- [ ] Watch the provider's credit meter for one lookup: it must not exceed
      `ENRICHMENT_MAX_PEOPLE` records (Apollo bills per person, and its search results
      carry obfuscated names and no address, so each address costs a second call).

### 9. Worker and queue monitoring

The failure this covers is the one nothing else shows: the site keeps answering while
the queue stops moving, so no follow-up is ever sent and no error is ever raised.

- [ ] Load the Admin page and read the **Job queue** card without touching the numbers:
      it must state a verdict ("Queue healthy" / the problems it found) in words.
- [ ] Poll `/api/health`; confirm `worker.running` is true and `lastTickMinutesAgo`
      stays small (it is written on every tick, including while a long discovery job runs,
      so minutes of silence mean the loop is genuinely wedged).
- [ ] Restart only the process, not MySQL, and confirm the Admin card returns to
      "worker not running" within ~15 s and recovers on its own — the worker is started
      by the app, so a deployment that runs the web process without it will show here.
- [ ] Queue work for a type this build does not know (a row inserted by hand, or an old
      row left from a previous version) and confirm the report names it as having no
      handler. This is the silent case: the job waits forever and every count still looks
      plausible. Delete the row afterwards.
- [ ] Pull the master autonomy switch with work queued and confirm the card says the
      work is *held*, lists no backlog problem, and still warns if the worker itself is
      not running. "Paused" must never be able to disguise a dead worker.
- [ ] Watch the server log for five minutes: the worker re-assesses itself on that
      interval and writes `[jobs] queue degraded: …` per problem. Point the hosting
      provider's log alert at that string — this is the alerting path, there is no
      external alerting service wired in.
- [ ] Leave a job `running` and kill the worker; confirm the reclaim path returns it to
      `queued` within ~10 minutes and that the stuck count in the report agrees with the
      window (they read the same constant, so change one only with the other).

### 10. Legal pages and data-subject requests

Nothing here is a checkbox the code can close: the documents are drafted, but they are
the operator's legal statement, and until `CONTROLLER` in `shared/legal.ts` is filled in
the pages render with a "Draft — not yet fit to publish" banner (`/privacy`, `/terms`).

- [ ] Open `/privacy` and confirm the banner is present on this build, then remove every
      `TODO:` in `CONTROLLER` (legal name, contact email, EU representative, governing
      law, hosting region) and confirm the banner disappears. A policy that names no
      controller is not a policy.
- [ ] Read the subprocessor list against the accounts actually paid for: a provider
      listed but not used is a false disclosure, and one used but not listed is a
      missing one. The list is conditional (enrichment vendor, Calendly, Stripe) —
      delete the rows that do not apply to this deployment.
- [ ] Have the text reviewed by a person who can accept liability. The code encodes the
      lawful basis the product is actually built around (Art 6(1)(f) plus the
      restrictions in this repo: role-mailbox refusal, enrichment opt-in, suppression
      gate); a lawyer may still require changes for the real entity and territory.
- [ ] In Settings → Data subject requests, export a real address and confirm the JSON
      answers *where it came from* (`provenance`: origin, source URLs, and the fact that
      inbound reply bodies are stored verbatim) and not only row dumps. An address
      nothing is held about must come back as "nothing held", not as an empty file.
- [ ] Erase that same address twice (two-click confirm) and read the retention note: the
      suppression entry and the company record stay, the person's scores and contact go.
      Confirm the prospect row still exists with no contact and no reasons.
- [ ] After an erasure, run discovery/enrichment over the same company and confirm the
      forgotten address is not written back automatically (`upsertContact` refuses it).
      Then confirm a human can still add a contact deliberately — that asymmetry is
      intended, because nothing in the UI lets you delete a suppression row.
- [ ] Send a message to a live address and read the footer: unsubscribe line, the
      `SENDER_POSTAL_ADDRESS` value, and a link to `/privacy`. Set the variable before
      the first real campaign; a production boot warns when SMTP is configured without it.
- [ ] Confirm the rate limits bite: 30 exports / 10 erasures per 10 minutes per workspace.
      These endpoints read the whole subject graph, so they are the one user-facing path
      worth hammering on purpose.

### 11. What a paused platform says about itself

The failure this covers is a screen that is quietly untrue: autonomy is held, and every
page still looks like a system that is working.

- [ ] Pull the master switch in Admin, then open Overview, a campaign, a prospect and
      Settings as a **non-admin** member. The banner must be on all of them within ~30 s
      without a manual reload (the query refetches on that interval), and it must contain
      the reply-during-pause consequence, not just "paused".
- [ ] Check the Settings chip reads "paused by operator" and the workspace's own toggle is
      still where the owner left it. If it flipped to "off", the two facts have collapsed
      back into one and the owner will go "fix" a setting that was never wrong.
- [ ] While paused, send a real reply to the inbox and confirm in `job_runs` that **no row
      was created** — not a queued row that is merely held. Resume afterwards and confirm
      the work queued *before* the pause runs, while that reply still gets nothing. That
      asymmetry is what the banner promises, and it is the reason the inbox must be read by
      hand during an incident.
- [ ] Break the database on purpose (wrong `DATABASE_URL`, or drop `system_state`) and load
      the app: the banner must switch to "Autonomy status cannot be read" and say the
      deployment is what needs fixing. If it still says "paused", it is sending the operator
      to look for a lever that does not exist.
- [ ] Confirm a non-admin sees "Only a platform operator can resume it" and no Admin link.
- [ ] On Admin, confirm the *Recurring discovery* tile carries the "held" hint while the
      switch is out — a schedule that is not firing must not be printed as a bare interval.

### 12. Messenger channels and their consent model

The failure this covers is a channel that quietly becomes a cold-messaging tool, or that
is wired half-way and looks idle when it is actually dead. Unit and integration tests
prove the decision logic and the request shapes; only a real bot can prove the platform
agrees.

- [ ] Register the Telegram webhook and send a message to a test prospect that contains
      the plain `https://t.me/<bot>` link. Confirm it reaches them as
      `/api/track/cta/<ref>/telegram` (the stored `outreach_messages.body` shows the
      tracked form) and that clicking it opens the bot with our reference attached.
- [ ] Press Start in Telegram. Confirm a `channel_identities` row appears on the prospect
      page with `consentSource = telegram.start`, dated now, and that the **opportunity
      stage did not move** — opening a chat is recorded as evidence, never as a buying
      signal.
- [ ] Send from the channel card. Check the platform actually receives it, and that the
      Conversation shows the outbound message labelled `via telegram` — a chat reply must
      not look like an email reply.
- [ ] On a prospect with **no** channel row, confirm the send is refused in words that say
      what to do ("never written to us … link in your email"), and that the refusal is
      shown to the user, not just logged. Nothing may be sent to a number you merely stored.
- [ ] Send `STOP` to the bot as a bare message, carrying no `start` parameter - which is
      what a reply in an existing chat actually looks like, and the live form of the CI case
      that found the attribution bug: nothing but the identity row can tie such a message to
      a person, so if that path is broken, revocation is unreachable. Confirm the row is
      revoked, that the send box is disabled with the revocation date, and that writing
      again reopens it. Then block the bot and send:
      the platform's `bot was blocked` error must be recorded as a revocation and a `failed`
      message, never as `sent`.
- [ ] With only `TELEGRAM_BOT_TOKEN` set and no webhook secret, boot the server and read the
      log: it must warn that the channel can never gain permission. The same for a WhatsApp
      sender without `WHATSAPP_APP_SECRET`. A half-configured channel is not "no takers yet".
- [ ] On WhatsApp, wait past `MESSENGER_WINDOW_HOURS` (set it to 1 for the test) and confirm
      a send is refused with the reply-window reason, then message the business number and
      confirm the same send is now allowed. Set it to `48` and confirm the effective window
      is still 24 — the setting shortens our window, it cannot exceed Meta's.
- [ ] Have a person who is *not* a prospect press Start. Confirm nothing is stored for them
      (`attributed: false`) — an unattributable event must never become a future licence.
- [ ] Ask for erasure on a prospect with a channel history (Settings → Data subject
      requests). Confirm the export lists the channel and its consent provenance, and that
      the erasure removes the identity and the channel messages.

## Known limitation: Stripe Payment Links join on email

A Stripe Payment Link is one static URL, so it cannot carry per-contact metadata.
The `won` callback therefore matches the payer's `customer_email` back to an outreach
message, which fails if the prospect checks out with a different address than the one
we emailed. `client_reference_id` is honoured when present — switch to server-created
Checkout Sessions if this matters for the real offer.
