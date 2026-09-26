# Pre-launch verification

CI proves the logic. It cannot prove the integrations, because a GitHub Actions
container has no mailbox, no Calendly account and no Stripe live mode. **Nothing in
the "must verify live" list below has ever been executed for this project.** Until it
has, do not enable per-workspace autopilot against real prospects.

What CI already covers (`.github/workflows/ci.yml`):

- `pnpm check` — TypeScript over server, client and shared code.
- `pnpm test` — unit tests, plus `server/integration.test.ts` against a real MySQL 8
  container: baseline migration matches `schema.ts`, outreach send + idempotent retry,
  reply ingest → classification → opportunity → follow-up job claimed and completed by
  the worker, the full CTA → Calendly → Stripe walk to `won`, webhook replay inertness,
  and the cross-tenant address-collision refusal.
- `pnpm build` — Vite client bundle + esbuild server bundle.
- `pnpm smoke` (`scripts/smoke.mjs`) — boots the real server with no database and
  asserts the HTTP edge: tracked CTA clicks redirect to the configured Calendly/Stripe
  targets, an unknown CTA kind is a `404` with no `Location` (so the endpoint cannot be
  abused as an open redirect), unsigned / wrong-secret / tampered-body / stale-timestamp
  provider callbacks are all `401`, a validly-signed callback that cannot be persisted
  answers `503` so the provider retries instead of losing the signal, and both the
  one-click `POST` and the `GET` landing page of the unsubscribe route work.

> **Status: executed and green.** CI run #3
> (`161b133`) passed both jobs on real MySQL 8: migrations applied from the
> baseline journal, and the integration suite ran to completion. The
> `REQUIRE_INTEGRATION_TESTS` flag set in the integration job is what makes that
> statement meaningful — without it the suite could have reported success from 9
> silent skips, which is exactly how run #1 nearly fooled us. Two real bugs were
> found by this suite on its first execution: the `CI`-scoped skip guard breaking
> the `checks` job, and `applyStripeValue` writing `valueCents = 0` for every
> Stripe Payment Link sale. Run `pnpm smoke` also passes locally and on the
> runner. What remains genuinely unverified is everything below, which no
> container can cover.

## Must verify live

Run each of these once, against a deployed instance with real credentials. Record the
date and the outcome in the PR that enables autopilot.

### 1. Database and migrations

- [ ] `pnpm db:migrate` against the target MySQL/TiDB succeeds on an empty database.
- [ ] Boot logs contain **no** `[schema]` lines. Any that appear name the exact
      `ALTER TABLE` to run — see [database.md](./database.md).
- [ ] `/api/health` returns `{"ok":true,"hasDb":true}`.

### 2. Outbound deliverability

- [ ] Send to a Mail-Tester style address; confirm SPF, DKIM and DMARC all pass.
- [ ] Confirm the received message carries `List-Unsubscribe: <https…>` and
      `List-Unsubscribe-Post: List-Unsubscribe=One-Click` in the raw headers
      (`server/services/email.ts`). Gmail and Yahoo reject bulk mail without them.
- [ ] Click the footer unsubscribe link → prospect becomes `suppressed`, and a
      subsequent send to that address returns `status: "suppressed"` without mailing.
- [ ] POST to the same URL with body `List-Unsubscribe=One-Click` → `200 Unsubscribed.`
      (the one-click path mail clients use without asking the user).

### 3. Inbound loop

- [ ] Configure the ESP's inbound webhook to `POST /api/replies/webhook/<provider>`
      with `REPLY_INGEST_SECRET` set, then reply to a sent message from the prospect
      mailbox.
- [ ] A row appears in `email_events` for that workspace with `eventType = "replied"`,
      `bodyText` = the full original body, and a non-null `classification`.
- [ ] Reply with "I'm not interested" → prospect becomes `not_interested` and **no**
      `reply.followup` job is queued. This is the compliance-critical direction.
- [ ] Reply with "unsubscribe" → prospect suppressed, no follow-up queued.
- [ ] Send the same webhook payload twice → second call returns `duplicate: true`
      and produces no second classification or job.
- [ ] With `CALENDLY_URL`/`STRIPE_PAYMENT_LINK` set, the URL inside a delivered
      message points at `/api/track/cta/<ref>/<kind>`, and clicking it lands on the
      real Calendly/Stripe page (`server/services/cta.ts`).

### 4. Autopilot loop, end to end

- [ ] Turn autopilot on for a throwaway workspace. Send an invite, reply "Sounds
      good, let's talk" and wait past the 60-second debounce.
- [ ] `job_runs` shows the `reply.followup` row go `queued` → `completed`, and a
      second `outreach_messages` row appears for the prospect.
- [ ] The opportunity stage stays `responded` after that follow-up. If it moved to
      `meeting_booked`, the cosmetic-advancement bug is back — that is a blocker.
- [ ] Kill the server mid-job and restart; the stuck `running` row is reclaimed after
      10 minutes (`runNextJob` crash recovery) rather than being lost.

### 5. Conversion callbacks

The `401`/`503` status contract for both endpoints is already asserted by `pnpm smoke`.
What CI **cannot** check is that our assumptions about the real providers hold — the
signature scheme (`t=…,v0=…` for Calendly, `t=…,v1=…` for Stripe), the event names, and
the JSON paths to the invitee email and the amount are all read from documentation, not
from a captured payload. Verify them against a live delivery before trusting a `won`.

- [ ] Trigger a real Calendly webhook and confirm the signature header our
      `verifySignedHeader` parses matches what Calendly actually sends (compare against
      the raw body in a log, not just a `200`).
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

## Known limitation: Stripe Payment Links join on email

A Stripe Payment Link is one static URL, so it cannot carry per-contact metadata.
The `won` callback therefore matches the payer's `customer_email` back to an outreach
message, which fails if the prospect checks out with a different address than the one
we emailed. `client_reference_id` is honoured when present — switch to server-created
Checkout Sessions if this matters for the real offer.
