# Do not apply these

Both files are superseded by `drizzle/0000_baseline.sql`, which is generated from
`drizzle/schema.ts` and recorded in `drizzle/meta/_journal.json`.

They survived here because they are the only record of how the schema drifted: they
were hand-written next to a directory that had no migration journal at all, so
`drizzle-kit migrate` applied none of them while the code assumed all of them.
See [../../docs/database.md](../../docs/database.md).

| File | Status |
| --- | --- |
| `0007_autopilot.sql` | Already in the baseline. Re-applying it fails: duplicate `autopilot` column. |
| `0008_conversion_events.sql` | Already in the baseline. Re-applying it is a harmless no-op. |

Nothing in the build or migration path reads this directory.
