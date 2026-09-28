// One place that turns DATABASE_URL into connection options, used by the ORM pool,
// by drizzle-kit (migrations) and by `pnpm preflight`. They must agree: a database
// that the app can reach but the migrator cannot is a deployment that quietly stops
// being migrateable, and the reverse is a schema drift nobody can fix.
//
// Why this exists at all: TiDB Cloud's public endpoints accept *only* TLS
// connections, and a mysql:// URL has no way to say so. Handing the raw URL to
// mysql2 produces an authentication failure that reads like a wrong password,
// which is the most misleading possible error for "you forgot to encrypt".
import { readFileSync } from "node:fs";
import { env } from "./env";

export interface DbCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface TlsOptions {
  rejectUnauthorized: boolean;
  /** PEM contents, not a path — drizzle-kit and mysql2 both want the text. */
  ca?: string;
  /** SNI name. Always the host, never the CNAME in front of it. */
  servername: string;
}

export interface PoolConfig extends DbCredentials {
  ssl?: TlsOptions;
  connectionLimit: number;
  maxIdle: number;
  /**
   * Milliseconds an idle connection may live in the pool. Set explicitly rather
   * than inherited: a public-endpoint TiDB drops connections that go quiet, and a
   * pool that hands out a dead connection surfaces it as a query error in the
   * middle of a campaign, not as a configuration problem.
   */
  idleTimeout: number;
  enableKeepAlive: boolean;
}

/**
 * Hosts whose documented contract is "TLS or nothing". Matched on the registered
 * domain rather than a full hostname so a region change does not silently turn
 * encryption off.
 */
const TLS_REQUIRED_HOSTS = ["tidbcloud.com", "tidb-serverless.cloud", "planetscale.com", "neon.tech"];

export function hostRequiresTls(host: string): boolean {
  const h = host.toLowerCase();
  return TLS_REQUIRED_HOSTS.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

export function parseDatabaseUrl(url: string): DbCredentials {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL has no database in its path");
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

/**
 * Resolve the TLS settings for a URL, or `undefined` to connect in the clear.
 *
 * `DATABASE_SSL` wins over the host heuristic in both directions, because an
 * operator inside a VPC may legitimately reach the same host without encryption
 * while their laptop cannot.
 */
export function resolveTls(url: string): TlsOptions | undefined {
  const { host } = parseDatabaseUrl(url);
  const forced = env.databaseSsl.trim().toLowerCase();
  const wantsTls = forced === "true" || forced === "require" || (forced === "" && hostRequiresTls(host));
  if (!wantsTls) return undefined;

  const rejectUnauthorized = !env.databaseSslSkipVerify;
  const ca = env.databaseCaPath ? readCa(env.databaseCaPath) : undefined;
  if (!rejectUnauthorized) {
    // Encryption without verification is a transport that an on-path attacker can
    // terminate, so it is a debugging mode and never a production one.
    // `assertRuntimeConfig()` refuses it when NODE_ENV=production.
    console.warn(
      "[db] DATABASE_SSL_SKIP_VERIFY is on: the server certificate is not checked, so this connection is encrypted but not authenticated. Never deploy like this.",
    );
  }
  return { rejectUnauthorized, ...(ca ? { ca } : {}), servername: host };
}

function readCa(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `DATABASE_CA_PATH points at ${path}, which cannot be read (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

export function poolConfig(url: string = env.databaseUrl): PoolConfig {
  const base = parseDatabaseUrl(url);
  const limit = Math.max(1, Math.floor(env.databasePoolSize) || 1);
  return {
    ...base,
    ssl: resolveTls(url),
    connectionLimit: limit,
    maxIdle: Math.max(1, Math.floor(limit / 2)),
    idleTimeout: 60_000,
    enableKeepAlive: true,
  };
}

/** Password redacted, for logs and for `pnpm preflight`. */
export function describeDatabaseUrl(url: string): string {
  try {
    const { host, port, user, database } = parseDatabaseUrl(url);
    const tls = resolveTls(url) ? "tls" : "plain";
    return `${user}@${host}:${port}/${database} (${tls})`;
  } catch {
    return "an unparseable DATABASE_URL";
  }
}
