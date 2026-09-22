# SignalFlow — AI Client Acquisition OS

> **Tell us what you can do. We'll find the businesses that need it.**

SignalFlow is a global, signal-led client acquisition MVP for independent professionals and small agencies. It turns an offer and target market into a focused ideal client profile, campaign briefs, explainable opportunity cards, research-aware personalization drafts, and review-first outreach.

## What works now

The app includes a premium landing page with a no-account demo, secure Manus OAuth access to the workspace, conversational onboarding, editable ideal client profile generation, bounded ScrapeGraphAI discovery, real Groq qualification and evidence-bounded synthesis with demo fallback, server-side prospect filters and pagination, source-aware prospect detail research and personalization review, signals, analytics and billing foundations, settings, provider health, AI caching/observability, and a workspace-scoped relational schema.

Demo companies are fictional and are explicitly labelled as demo data. Live discovery uses the official `scrapegraph-js` 2.2.1 SDK against the ScrapeGraphAI v2 managed API only when `SGAI_API_KEY` is configured. Live AI mode uses the official Groq OpenAI-compatible API only when `GROQ_API_KEY` is configured; `GROQ_MODEL` defaults to `openai/gpt-oss-20b`. External sending remains disabled and review-first.

## Technical stack

| Layer | Implementation |
| --- | --- |
| Frontend | React 19, TypeScript, Tailwind CSS, shadcn/ui, Wouter |
| Server | Express and tRPC |
| Data | MySQL/TiDB with Drizzle migrations |
| Authentication | Manus OAuth in the managed project runtime |
| AI and providers | Interface-based Groq AI adapter plus verified ScrapeGraphAI v2 discovery |
| Deployment | Managed Node runtime |

## Local development

```bash
pnpm install
pnpm dev
```

Run the required quality checks before any release.

```bash
pnpm check
pnpm test
pnpm build
```

## Database changes

1. Edit `drizzle/schema.ts`.
2. Generate a migration with `pnpm drizzle-kit generate`.
3. Review the generated SQL in `drizzle/migrations`.
4. Apply it using the deployment’s reviewed database migration process.
5. Run the quality checks.

## Configuration

The supplied platform runtime provides database, authentication, and server-only credentials. Set `SGAI_API_KEY` through the secure project secret manager to enable live discovery and set `GROQ_API_KEY` to enable Live AI Mode; omit either key to keep that provider in explicit demo mode. `GROQ_MODEL` defaults to `openai/gpt-oss-20b`, `RESEARCH_CACHE_HOURS` defaults to 72, and `AI_CACHE_HOURS` defaults to 24. Never commit actual secrets; see [environment variables](docs/environment-variables.md).

## Documentation

- [Architecture](docs/architecture.md)
- [AI agents](docs/ai-agents.md)
- [Providers](docs/providers.md)
- [Database](docs/database.md)
- [Deployment](docs/deployment.md)
- [Security](docs/security.md)

## Product guardrails

SignalFlow prioritizes qualified opportunities rather than lead volume. Opportunity scores are decision aids, not claims of scientific precision. Generated copy must be based on available evidence. Users review messages before they can be approved, and no mass sending or platform-evasion behavior is included.

## References

[1]: https://orm.drizzle.team/docs/overview "Drizzle ORM documentation"
[2]: https://trpc.io/docs "tRPC documentation"
