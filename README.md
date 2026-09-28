# SignalFlow — AI Client Acquisition OS

> **Tell us what you can do. We'll find the businesses that need it.**

SignalFlow turns an offer and a target market into an ideal client profile, finds companies that match it, works out who at those companies to write to, drafts the message, sends it, reads the reply, and moves the deal through the funnel — with a human reviewing at every step it wants to, or an opt-in autopilot doing the walking.

## What works now

Landing page with a no-account demo, email/password access (optional Google and GitHub OAuth), conversational onboarding, editable ideal client profiles, bounded ScrapeGraphAI discovery, Groq qualification with evidence-bounded synthesis, a second discovery pass over each company's own `/contact`, `/team` and `/about` pages to find a real person, optional paid enrichment through a Hunter or Apollo adapter, manual contacts with MX verification, review-first outreach over your own SMTP account and per-workspace autopilot behind a platform-wide kill switch, inbound reply handling from Mailgun, SendGrid, Postmark or SES, reply classification and debounced AI follow-ups, opportunity stages that only move on external evidence (tracked CTA clicks, Calendly v2 callbacks, Stripe payment events), optional Telegram and WhatsApp reply channels that a prospect has to start themselves, queue health surfaced in `/api/health` and the admin panel, suppression list, RFC 8058 one-click unsubscribe, CAN-SPAM footer, subject-access export and erasure, published privacy and terms drafts, and a workspace-scoped relational schema guarded against drift at boot.

Demo companies are fictional and are explicitly labelled as demo data. Live discovery uses the official `scrapegraph-js` SDK against the ScrapeGraphAI v2 managed API only when `SGAI_API_KEY` is configured; live AI uses the Groq OpenAI-compatible API only when `GROQ_API_KEY` is configured, and `GROQ_MODEL` defaults to `openai/gpt-oss-20b`. Sending is real when the SMTP variables are set; without them the mock provider records the message as *simulated* and nothing leaves the machine, which the prospect page says out loud rather than reporting a send. **None of the external integrations has been exercised against a live provider yet** — see [Verification](docs/verification.md) and [Launch runbook](docs/launch.md).

## Technical stack

| Layer | Implementation |
| --- | --- |
| Frontend | React 19, TypeScript, Tailwind CSS, shadcn/ui, Wouter |
| Server | Express and tRPC |
| Data | MySQL or TiDB with Drizzle migrations and a schema drift check at boot |
| Authentication | Email and password (scrypt) in an HttpOnly JWT cookie, optional Google/GitHub OAuth |
| Background work | Database-backed job queue with a heartbeat, a queue report and a platform autonomy switch |
| AI and providers | Interface-based Groq AI adapter, ScrapeGraphAI v2 discovery, Hunter/Apollo enrichment adapter |
| Email | SMTP outbound with SPF/DKIM/DMARC expected on the sending domain; inbound via provider webhooks |
| Messenger | Telegram Bot API and WhatsApp Cloud API as **reply channels only** — permission is created solely by the prospect messaging us there, and stored with its date and source |
| Deployment | Managed Node runtime |

## Local development

```bash
pnpm install
pnpm dev
```

Run the quality checks before any release. Integration suites skip themselves (and say so) unless `DATABASE_URL` points at a real MySQL, so a green local run is not the same evidence as a green CI run.

```bash
pnpm check
pnpm test
pnpm build
pnpm smoke      # HTTP contracts of the webhook and CTA endpoints, no database needed
pnpm preflight  # graded configuration report for a launch; exits non-zero if blocking
```

## Database changes

1. Edit `drizzle/schema.ts`.
2. Generate a migration with `pnpm db:generate`.
3. Review the generated SQL in `drizzle/`.
4. Apply it with `pnpm db:migrate`, or the deployment’s reviewed migration process.
5. Run the quality checks. A database the code does not recognize is reported at boot, column by column, and autonomy fails closed rather than running half a schema.

## Configuration

Every variable the server reads is documented in [.env.example](.env.example); nothing has a secret value in it. Live behaviour is opt-in by configuration: no `GROQ_API_KEY` means demo text, no `SGAI_API_KEY` means demo companies, no SMTP settings means nothing can be sent, and no enrichment provider selected means no contact data is ever bought. `GROQ_MODEL` defaults to `openai/gpt-oss-20b`, `RESEARCH_CACHE_HOURS` to 72, `AI_CACHE_HOURS` to 24, and `MAX_CONTACT_ENRICHMENTS` to 10 companies per discovery run. `pnpm preflight` reads the real `.env` and reports what is missing for a launch. Never commit actual secrets.

## Documentation

- [Launch runbook](docs/launch.md) — the order in which this goes live and what each step proves
- [Verification](docs/verification.md) — what CI actually covers, and what has never been run against a live provider
- [AI agents](docs/ai-agents.md) — how the autonomous loop thinks, and the limits it will not cross
- [Database](docs/database.md) — schema and migration history
- [`.env.example`](.env.example) — every configuration variable

Billing is present but runs against a mock provider (`BILLING_PROVIDER`); plans and entitlements are enforced locally either way.

## Product guardrails

SignalFlow prioritizes qualified opportunities rather than lead volume. Opportunity scores are decision aids, not claims of scientific precision. Generated copy must be based on available evidence, and a stage in the funnel may only come from something a third party actually did — a reply, a clicked link, a booking, a payment — never from the software having sent a message. An address is used only if it was read from a page, bought under a licence, or typed by a person; nothing is constructed from a name and a domain pattern. Unsubscribes are honoured permanently, data-subject requests are operations rather than mailto links, autonomy is off unless a workspace asks for it and the platform allows it, and a messenger thread may only ever be started by the person on the other end — a stored phone number grants nothing. No mass sending, no list purchase, no platform-evasion behaviour.

## References

[1]: https://orm.drizzle.team/docs/overview "Drizzle ORM documentation"
[2]: https://trpc.io/docs "tRPC documentation"
