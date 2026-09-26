// Boot-time schema drift guard.
//
// Why this exists: `drizzle/` carries a single loose SQL file (0007_autopilot.sql)
// and no `meta/_journal.json`. Without a journal `drizzle-kit migrate` applies
// *nothing*, so a database provisioned that way is missing every table, and even
// one built by `drizzle-kit push` at an earlier point can lag behind
// `drizzle/schema.ts`. The runtime symptom is an opaque "Unknown column" or a
// truncated enum deep inside a background job. Checking once at boot turns that
// into a precise, actionable message.
//
// This is deliberately a *check*, not a migrator: it never mutates the schema.
import mysql, { type RowDataPacket } from "mysql2/promise";
import { env } from "./env";

interface ColumnRequirement {
  table: string;
  column: string;
  /** For enum columns: values that must all be present. */
  enumContains?: string[];
  /** SQL to run when the requirement is unmet. */
  fix: string;
}

const REQUIRED: ColumnRequirement[] = [
  {
    table: "workspaces",
    column: "autopilot",
    fix: "ALTER TABLE `workspaces` ADD COLUMN `autopilot` boolean NOT NULL DEFAULT false;",
  },
  {
    table: "outreach_messages",
    column: "referenceId",
    fix: "ALTER TABLE `outreach_messages` ADD COLUMN `reference_id` varchar(64);",
  },
  {
    table: "outreach_messages",
    column: "idempotencyKey",
    fix: "ALTER TABLE `outreach_messages` ADD COLUMN `idempotency_key` varchar(64);",
  },
  {
    table: "outreach_messages",
    column: "providerMessageId",
    fix: "ALTER TABLE `outreach_messages` ADD COLUMN `provider_message_id` varchar(255);",
  },
  {
    table: "outreach_messages",
    column: "error",
    fix: "ALTER TABLE `outreach_messages` ADD COLUMN `error` text;",
  },
  {
    table: "email_events",
    column: "eventType",
    enumContains: ["clicked", "converted"],
    fix: "ALTER TABLE `email_events` MODIFY COLUMN `eventType` enum('sent','delivered','bounced','opened','clicked','replied','converted','unsubscribed','failed') NOT NULL;",
  },
  {
    table: "opportunities",
    column: "stage",
    enumContains: ["open", "responded", "meeting_booked", "negotiating", "won", "lost"],
    fix: "ALTER TABLE `opportunities` MODIFY COLUMN `stage` enum('open','responded','meeting_booked','negotiating','won','lost') NOT NULL DEFAULT 'open';",
  },
  {
    table: "prospects",
    column: "status",
    enumContains: ["won", "lost", "suppressed", "not_interested", "opportunity"],
    fix: "ALTER TABLE `prospects` MODIFY COLUMN `status` enum('new','qualified','disqualified','contacted','interested','not_interested','opportunity','suppressed','won','lost') NOT NULL DEFAULT 'new';",
  },
  {
    // The master autonomy switch. A missing table here is not a missing feature:
    // autonomyState() fails closed, so an un-migrated database runs with all
    // autonomy silently paused — loud reporting is the only way that is visible.
    table: "system_state",
    column: "autopilotPaused",
    fix:
      "CREATE TABLE `system_state` (`id` varchar(36) NOT NULL, `autopilot_paused` boolean NOT NULL DEFAULT false, " +
      "`paused_reason` varchar(300) NOT NULL DEFAULT '', `paused_by` varchar(36), `paused_at` timestamp, " +
      "`created_at` timestamp DEFAULT (now()), `updated_at` timestamp DEFAULT (now()), " +
      "CONSTRAINT `system_state_id` PRIMARY KEY(`id`));",
  },
];

function parseEnum(columnType: string): string[] {
  const inner = /enum\((.*)\)/s.exec(columnType)?.[1];
  if (!inner) return [];
  return inner
    .split(",")
    .map((v) => v.trim().replace(/^'|'$/g, "").replace(/''/g, "'"));
}

/** Column names as declared in schema.ts, plus the snake_case the DB actually uses. */
function candidateDbNames(column: string): string[] {
  const snake = column.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return [...new Set([column.toLowerCase(), snake])];
}

export interface SchemaDrift {
  missing: { table: string; column: string; fix: string }[];
  unknownTables: string[];
}

interface DbNameRow extends RowDataPacket {
  db: string | null;
}
interface TableNameRow extends RowDataPacket {
  TABLE_NAME: string;
}
interface ColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
}

/** Compare the live database against what the code assumes. Pure-ish: needs a DB. */
export async function detectSchemaDrift(): Promise<SchemaDrift | null> {
  if (!env.databaseUrl) return null;
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection(env.databaseUrl);
    const [dbRows] = await conn.query<DbNameRow[]>("SELECT DATABASE() AS db");
    const schemaName = dbRows[0]?.db;
    if (!schemaName) return null;

    const [tableRows] = await conn.query<TableNameRow[]>(
      ["SELECT DISTINCT TABLE_NAME FROM information_schema.COLUMNS", "WHERE TABLE_SCHEMA = ?"].join(" "),
      [schemaName],
    );
    const present = new Set(tableRows.map((r) => r.TABLE_NAME));
    const unknownTables = [
      ...new Set(REQUIRED.map((r) => r.table).filter((t) => !present.has(t))),
    ];

    const [columns] = await conn.query<ColumnRow[]>(
      ["SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS", "WHERE TABLE_SCHEMA = ?"].join(" "),
      [schemaName],
    );
    const byTable = new Map<string, Map<string, string>>();
    for (const c of columns) {
      if (!byTable.has(c.TABLE_NAME)) byTable.set(c.TABLE_NAME, new Map());
      byTable.get(c.TABLE_NAME)!.set(c.COLUMN_NAME.toLowerCase(), c.COLUMN_TYPE);
    }

    const missing: SchemaDrift["missing"] = [];
    for (const req of REQUIRED) {
      if (!present.has(req.table)) continue; // reported once via unknownTables
      const tableCols = byTable.get(req.table)!;
      const found = candidateDbNames(req.column).find((n) => tableCols.has(n));
      if (!found) {
        missing.push({ table: req.table, column: req.column, fix: req.fix });
        continue;
      }
      if (req.enumContains) {
        const values = parseEnum(tableCols.get(found)!);
        const absent = req.enumContains.filter((v) => !values.includes(v));
        if (absent.length) {
          missing.push({
            table: req.table,
            column: `${req.column} (missing: ${absent.join(", ")})`,
            fix: req.fix,
          });
        }
      }
    }
    return { missing, unknownTables };
  } catch (err) {
    console.error("[schema] drift check could not run (not fatal):", err);
    return null;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/**
 * Log any drift found at boot. Called once after the pool is known to exist.
 * Does not exit: a partially-working server is more debuggable than a silent one,
 * and dev/demo setups legitimately have no database at all.
 */
export async function assertSchemaReady(): Promise<void> {
  const drift = await detectSchemaDrift();
  if (!drift) return;
  if (drift.unknownTables.length) {
    console.error(
      `[schema] tables the code requires but the database does not have: ${drift.unknownTables.join(", ")}.\n` +
        "  Apply the journaled migrations with `pnpm db:migrate` — drizzle/ is " +
        "journal-driven, so anything generated before the journal exists must be " +
        "recreated from 0000_baseline. See docs/database.md.",
    );
  }
  if (drift.missing.length) {
    console.error(
      `[schema] ${drift.missing.length} column/enum drift problem(s) between drizzle/schema.ts and the live database:`,
    );
    for (const m of drift.missing) {
      console.error(`  - ${m.table}.${m.column}\n    fix: ${m.fix}`);
    }
    console.error(
      "  Do not enable per-workspace autopilot until these are resolved. The master " +
        "autonomy switch reads the same database and fails closed, so an unreadable " +
        "state also holds queued jobs instead of running them.",
    );
  }
}
