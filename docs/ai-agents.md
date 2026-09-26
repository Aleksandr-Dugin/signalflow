# Autonomous AI-SDR layer

This document is the contract referenced from `shared/const.ts`, `drizzle/schema.ts`,
`server/_core/env.ts` and `server/autonomy.test.ts`. Change the behaviour, change
this file.

## Operating model: cyborg, not autopilot

Every autonomous move is gated by a **per-workspace** switch, `workspaces.autopilot`
(see the column comment in `drizzle/schema.ts`). It is toggled by the operator on the
in-app Settings page — never by the AI, and never as a global default.

| `autopilot` | Behaviour |
| --- | --- |
| `false` (default) | The system drafts and classifies, but a human approves and sends each message. |
| `true` | Inbound replies may enqueue an AI-written follow-up without a human click. |

Autonomy is scoped to *sending the next message in an existing conversation*. It can
never create campaigns, change plans, edit entitlements, or reach the admin surface.

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

The whole loop above is written but has never run against a live database and a real
mailbox. Before trusting it in production, execute the checklist in
[docs/verification.md](./verification.md). Sending mail to real prospects without
having passed it is not acceptable.

## Deliberate constraints

- Outbound is text/plain (plus optional HTML) with a `List-Unsubscribe` header and the
  RFC 8058 one-click POST — see `server/services/email.ts`. This is a deliverability
  requirement for Gmail/Yahoo bulk senders, not a nicety.
- Every provider payload is stored under a deterministic `dedupeKey` so replayed
  webhooks are no-ops.
- Original inbound bodies are preserved in `email_events.body_text` for audit.
