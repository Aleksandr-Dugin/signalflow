// The master autonomy switch — one boolean that outranks every per-workspace
// `autopilot` setting. See drizzle/schema.ts (`systemState`) for why it lives in
// the database rather than in memory.
//
// This module is deliberately dependency-light (schema + pool only) so that both
// the queue worker and the workspace helpers can import it without creating a
// cycle through db.ts.
import { eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";

const SINGLETON_ID = "singleton";

export interface GlobalAutonomyState {
  autopilotPaused: boolean;
  pausedReason: string;
  pausedBy: string | null;
  pausedAt: Date | null;
}

/**
 * Decide whether autonomous work may proceed, given the persisted switch.
 *
 * Pure and exported so the polarity is unit-testable with no database: an
 * unreadable or absent state counts as *paused*. The alternative would mean a
 * schema that failed to migrate, a dropped connection, or a typo in a column
 * name silently re-enabling sending to real prospects — a fail-open default on
 * the one control whose entire purpose is to stop things.
 */
export function autonomyAllowed(state: GlobalAutonomyState | null): boolean {
  return state !== null && state.autopilotPaused === false;
}

/**
 * What the interface is allowed to claim, as three answers rather than one boolean.
 *
 * `autonomyAllowed()` collapses null and paused because the *worker* must stop in both
 * cases and does not care why. An operator does: "a person pulled the lever" is fixed
 * by going and asking, "the switch cannot be read" (no database, or a deployment that
 * has not run the migration) is fixed by deploying. Reporting the second as the first
 * sends someone looking for a lever that does not exist — and a paused platform that
 * reads as merely paused is how a broken deployment mails nobody for a week.
 */
export type AutonomyStatus = "live" | "paused" | "unreadable";

export function autonomyStatus(state: GlobalAutonomyState | null): AutonomyStatus {
  if (state === null) return "unreadable";
  // The same strict reading as autonomyAllowed(), and for the same reason: anything
  // that is not an explicit `false` is not live. A truthy test here would show
  // "live" for a row whose column came back undefined — the shape of a partially
  // applied migration — while the worker was refusing to run any of it, which is
  // precisely the discrepancy an operator is supposed to be told about.
  return state.autopilotPaused === false ? "live" : "paused";
}

function toState(row: typeof schema.systemState.$inferSelect): GlobalAutonomyState {
  return {
    autopilotPaused: row.autopilotPaused,
    pausedReason: row.pausedReason,
    pausedBy: row.pausedBy ?? null,
    pausedAt: row.pausedAt ?? null,
  };
}

// Latch for the log line below: the job worker asks before every claim.
let readFailureLogged = false;

/**
 * Read the switch, or null when it cannot be read. Never throws: callers decide
 * through autonomyAllowed(), which treats null as "stop".
 */
export async function readGlobalAutonomyState(): Promise<GlobalAutonomyState | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const [row] = await db
      .select()
      .from(schema.systemState)
      .where(eq(schema.systemState.id, SINGLETON_ID))
      .limit(1);
    // No row yet simply means nobody has ever pressed the button.
    readFailureLogged = false;
    return row ? toState(row) : { autopilotPaused: false, pausedReason: "", pausedBy: null, pausedAt: null };
  } catch (err) {
    // A missing table is the common case: a deployment that has not run the
    // migration yet. Failing closed there is the safe reading, and is worth
    // logging loudly enough that it is not mistaken for a broken switch — but
    // only once, because the job worker asks every few seconds and an
    // un-migrated database would otherwise flood the log. Boot-time
    // `assertSchemaReady()` already prints the same problem with the SQL to run.
    if (!readFailureLogged) {
      readFailureLogged = true;
      console.error("[autonomy] cannot read the global switch — treating autopilot as paused:", err);
    }
    return null;
  }
}

export async function isAutopilotGloballyPaused(): Promise<boolean> {
  return !autonomyAllowed(await readGlobalAutonomyState());
}

/** Write the switch. Upserts so the very first press works on an empty table. */
export async function setAutopilotGloballyPaused(input: {
  paused: boolean;
  reason?: string;
  actorId?: string | null;
}): Promise<GlobalAutonomyState> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const values = {
    autopilotPaused: input.paused,
    pausedReason: (input.reason ?? "").slice(0, 300),
    pausedBy: input.paused && input.actorId ? input.actorId : null,
    pausedAt: input.paused ? new Date() : null,
  };
  await db
    .insert(schema.systemState)
    .values({ id: SINGLETON_ID, ...values })
    .onDuplicateKeyUpdate({ set: values });
  return values;
}
