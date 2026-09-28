// Unit tests for the database connection resolver. Nothing here opens a socket:
// the point is the decision (encrypt or not, with which identity, sized how), and
// a decision that can only be observed against a live server is one that gets
// changed by accident. The live half — a real handshake against TiDB — is proved
// by `pnpm preflight`, which is run against the actual deployment.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../server/_core/env";
import {
  describeDatabaseUrl,
  hostRequiresTls,
  parseDatabaseUrl,
  poolConfig,
  resolveTls,
} from "../server/_core/dbConnection";

const TIDB = "mysql://27SD4moJ3TiETb4.root:s3cr3t@gateway01us-west-2.prod.aws.tidbcloud.com:4000/signalflow";
const LOCAL = "mysql://root@localhost:3306/signalflow";

const original = {
  databaseSsl: env.databaseSsl,
  databaseCaPath: env.databaseCaPath,
  databaseSslSkipVerify: env.databaseSslSkipVerify,
  databasePoolSize: env.databasePoolSize,
};

beforeEach(() => {
  env.databaseSsl = "";
  env.databaseCaPath = "";
  env.databaseSslSkipVerify = false;
  env.databasePoolSize = 10;
});

afterEach(() => {
  Object.assign(env, original);
});

describe("hostRequiresTls", () => {
  it("knows the endpoints that refuse a plain connection", () => {
    expect(hostRequiresTls("gateway01us-west-2.prod.aws.tidbcloud.com")).toBe(true);
    expect(hostRequiresTls("GATEWAY01.US-WEST-2.PROD.AWS.TIDBCLOUD.COM")).toBe(true);
  });

  it("does not encrypt a local or self-managed server it was never asked to", () => {
    expect(hostRequiresTls("localhost")).toBe(false);
    expect(hostRequiresTls("127.0.0.1")).toBe(false);
    expect(hostRequiresTls("db.internal")).toBe(false);
    // A suffix match must be a real subdomain, not a name that merely ends with the
    // same letters — otherwise `tidbcloud.com.attacker.example` would be trusted.
    expect(hostRequiresTls("tidbcloud.com.attacker.example")).toBe(false);
    expect(hostRequiresTls("nottidbcloud.com")).toBe(false);
  });
});

describe("parseDatabaseUrl", () => {
  it("reads host, port, user and database, and defaults the port", () => {
    expect(parseDatabaseUrl(TIDB)).toMatchObject({
      host: "gateway01us-west-2.prod.aws.tidbcloud.com",
      port: 4000,
      user: "27SD4moJ3TiETb4.root",
      password: "s3cr3t",
      database: "signalflow",
    });
    expect(parseDatabaseUrl("mysql://user:pw@db.example/sig").port).toBe(3306);
  });

  it("decodes a password that had to be percent-escaped", () => {
    // TiDB generates passwords full of `#` and `/`, which are URL structure
    // characters; a generator that copies the raw value out of the console gets
    // this, and the operator gets a confusing auth failure.
    expect(parseDatabaseUrl("mysql://u:p%23ss%2Fw@db.example:4000/sig").password).toBe("p#ss/w");
  });

  it("refuses a URL with no database rather than connecting to the server", () => {
    expect(() => parseDatabaseUrl("mysql://u:p@db.example:4000")).toThrow(/no database/);
  });
});

describe("resolveTls", () => {
  it("turns TLS on for TiDB without being told, and off for localhost", () => {
    expect(resolveTls(TIDB)?.servername).toBe("gateway01us-west-2.prod.aws.tidbcloud.com");
    expect(resolveTls(LOCAL)).toBeUndefined();
  });

  it("lets the operator override the host guess in both directions", () => {
    env.databaseSsl = "true";
    expect(resolveTls(LOCAL)).toBeTruthy();
    env.databaseSsl = "false";
    expect(resolveTls(TIDB)).toBeUndefined();
  });

  it("verifies the certificate unless explicitly told not to", () => {
    expect(resolveTls(TIDB)?.rejectUnauthorized).toBe(true);
    env.databaseSslSkipVerify = true;
    expect(resolveTls(TIDB)?.rejectUnauthorized).toBe(false);
  });

  it("loads a private CA from disk and fails loudly when the path is wrong", () => {
    const pem = join(tmpdir(), `sf-test-ca-${Date.now()}.pem`);
    writeFileSync(pem, "-----BEGIN CERTIFICATE-----\nnot-a-real-cert\n-----END CERTIFICATE-----\n");
    try {
      env.databaseCaPath = pem;
      expect(resolveTls(TIDB)?.ca).toContain("BEGIN CERTIFICATE");
    } finally {
      rmSync(pem, { force: true });
    }
    env.databaseCaPath = join(tmpdir(), `sf-missing-ca-${Date.now()}.pem`);
    // A silently ignored CA file would produce a verification error blamed on the
    // certificate, so this throws and names the path instead.
    expect(() => resolveTls(TIDB)).toThrow(/DATABASE_CA_PATH/);
  });
});

describe("poolConfig", () => {
  it("keeps idle connections shorter-lived than the endpoint's own idle cut", () => {
    const cfg = poolConfig(TIDB);
    expect(cfg.ssl).toBeTruthy();
    expect(cfg.idleTimeout).toBeGreaterThan(0);
    // TiDB Cloud documents ~340 s for a public AWS endpoint. A pool that keeps a
    // connection quieter than that hands out a dead socket at the next query.
    expect(cfg.idleTimeout).toBeLessThan(340_000);
    expect(cfg.enableKeepAlive).toBe(true);
  });

  it("never produces a pool that cannot run a query", () => {
    env.databasePoolSize = 0;
    expect(poolConfig(LOCAL).connectionLimit).toBeGreaterThanOrEqual(1);
    env.databasePoolSize = 1;
    expect(poolConfig(LOCAL).maxIdle).toBeGreaterThanOrEqual(1);
  });
});

describe("describeDatabaseUrl", () => {
  it("is safe to log", () => {
    const line = describeDatabaseUrl(TIDB);
    expect(line).not.toContain("s3cr3t");
    expect(line).toContain("gateway01us-west-2.prod.aws.tidbcloud.com");
    expect(line).toContain("(tls)");
    expect(describeDatabaseUrl(LOCAL)).toContain("(plain)");
    expect(describeDatabaseUrl("not a url")).toBe("an unparseable DATABASE_URL");
  });
});
