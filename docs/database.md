# Database & migrations

MySQL 8 wire protocol throughout. `DATABASE_URL` is a `mysql://…` connection string
consumed by `mysql2` (`server/_core/database.ts`) and by drizzle-kit
(`drizzle.config.ts`).

## Three states the database can be in

| `DATABASE_URL` | Effect |
| --- | --- |
| unset | Server boots, `/api/health` reports `hasDb: false`. Auth and every `/app` route fail soft — **no fake writes**, no in-memory pretend persistence. Job worker never starts. |
| set, schema applied | Full product: discovery, outreach, autopilot loop, billing. |
| set, schema stale | Runtime `Unknown column` / truncated-enum errors from inside background jobs. This is the state that historically bit this project; see the guard below. |

`assertRuntimeConfig()` (`server/_core/env.ts`) refuses to boot in production
without `JWT_SECRET`/`DATABASE_URL`.

## Migration history: what happened to `drizzle/`

Until Sept 2026 this directory contained **one loose SQL file** (`0007_autopilot.sql`)
and **no `meta/_journal.json`**. Two consequences, both non-obvious:

1. `drizzle-kit migrate` reads the journal to decide what to apply. With no journal
   it applied **nothing, silently** — so the number `0007` implied six earlier
   migrations that never existed anywhere.
2. A fresh environment therefore had no path to a working schema except
   `drizzle-kit push`, which is intentionally not recorded in the repo.

Fixed by generating a real journal and a `0000_baseline.sql` containing the complete
`CREATE TABLE` set for all 26 tables as declared in `drizzle/schema.ts`. The two
hand-written files were moved to `drizzle/legacy/` — they are **superseded by the
baseline**, kept only as historical record, and must not be applied on top of it
(`0007_autopilot.sql` will fail with a duplicate-column error).

The journal is load-bearing now, not decoration: `0001_clever_ultimo.sql` adds
`system_state`, the master autonomy switch (27th table). It came from
`drizzle-kit generate` after editing `drizzle/schema.ts`, and `pnpm db:migrate` applies
baseline **and** 0001 in journal order. That is the workflow from here on: change the
schema, generate, review the SQL, commit `drizzle/` including `meta/` — never hand-edit
a journaled migration.

## Setting up a database from scratch

```bash
# local MySQL 8 (needs Docker; this project's TiDB path skips this)
docker compose up -d

# apply the baseline
pnpm db:migrate

# confirm schema.ts and the live DB agree
# (the same check runs on every boot and logs actionable ALTERs)
```

For TiDB Serverless the same `mysql://` URL and the same baseline work; the schema
uses only `varchar`/`int`/`boolean`/`enum`/`json`/`timestamp` and no generated
columns or FK-on-delete features TiDB lacks.

### Verify an existing database before enabling autopilot

`server/_core/schemaCheck.ts` runs at boot whenever a pool exists and reports:

- tables the code needs that the DB does not have;
- columns present in `schema.ts` but missing in the DB;
- enum columns missing values the code writes.

Each problem is printed with the exact `ALTER TABLE` to run. It never mutates
anything, and never aborts startup — a partially working server is more debuggable
than a quiet one, and demo mode legitimately has no database.

Extend the `REQUIRED` list in that file whenever you add a column that background
jobs depend on. It is the only automated defence against the drift class that has
already bitten this project.

## Local development without Docker

If Docker is unavailable, either run in demo mode (leave `DATABASE_URL` empty and
use the landing/login pages only) or point `DATABASE_URL` at a hosted MySQL-compatible
server. There is no SQLite path — the schema uses MySQL enums and `INSERT IGNORE`
dedupe semantics that the ingest and billing idempotency rely on.

## Conventions

- Column names are declared explicitly in `drizzle/schema.ts` (`varchar("recipient_email", …)`),
  so the physical name can differ from the TS property. `schemaCheck` accounts for
  both spellings; prefer the declared one when hand-writing SQL.
- Idempotency is expressed as a unique index plus `INSERT IGNORE`, checked via
  `affectedRows === 0` — not as a read-then-write, which races under the job worker.
- `drizzle-kit generate` after editing `schema.ts`; review the emitted SQL before
  committing it. Never edit a journaled migration by hand — generate a new one.
