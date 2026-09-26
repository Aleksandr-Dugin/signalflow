import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import * as schema from "../../drizzle/schema";
import { env } from "./env";

export type DB = MySql2Database<typeof schema>;

let _db: DB | null | undefined;
let _pool: mysql.Pool | null = null;

/**
 * Returns the Drizzle DB instance, or null when DATABASE_URL is not configured.
 * A failed connect is retried on the next call (audit fix: previously a single
 * transient failure was cached forever and wedged the process into demo mode).
 */
export function getDb(): DB | null {
  if (_db !== undefined) return _db;
  if (!env.databaseUrl) {
    _db = null;
    return null;
  }
  try {
    _pool = mysql.createPool(env.databaseUrl);
    _db = drizzle(_pool, { mode: "default" });
  } catch (err) {
    console.error("[db] connection failed, will retry on next call:", err);
    return null; // do not cache the failure
  }
  return _db;
}

export function hasDb(): boolean {
  return getDb() !== null;
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _db = undefined;
  }
}
