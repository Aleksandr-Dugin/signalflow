import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyPlategaSignature } from "./services/billing";
import { signMockCheckout, verifyMockCheckout } from "./services/billingService";
import { env } from "./_core/env";

const SECRET = "test-platega-secret";

function makeHeader(rawBody: string, t: string, secret = SECRET) {
  const v0 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v0=${v0}`;
}

describe("verifyPlategaSignature", () => {
  let prev: string;
  beforeEach(() => {
    prev = env.plategaSecret;
    env.plategaSecret = SECRET;
  });
  afterEach(() => {
    env.plategaSecret = prev;
  });

  const body = JSON.stringify({ type: "payment_succeeded", externalReference: "ws_1" });
  const t = "1700000000";

  it("accepts a correctly signed payload", () => {
    expect(verifyPlategaSignature(body, makeHeader(body, t))).toBe(true);
  });
  it("rejects a tampered payload", () => {
    const header = makeHeader(body, t);
    const evil = JSON.stringify({ type: "payment_succeeded", externalReference: "ws_VICTIM" });
    expect(verifyPlategaSignature(evil, header)).toBe(false);
  });
  it("rejects a wrong-secret signature", () => {
    expect(verifyPlategaSignature(body, makeHeader(body, t, "wrong"))).toBe(false);
  });
  it("rejects a malformed or missing header", () => {
    expect(verifyPlategaSignature(body, undefined)).toBe(false);
    expect(verifyPlategaSignature(body, "garbage")).toBe(false);
  });
  it("rejects when no secret is configured", () => {
    env.plategaSecret = "";
    expect(verifyPlategaSignature(body, makeHeader(body, t))).toBe(false);
  });
});

describe("mock checkout token", () => {
  it("round-trips workspace + plan", () => {
    const token = signMockCheckout("ws_42", "pro");
    const verified = verifyMockCheckout(token);
    expect(verified).toEqual({ workspaceId: "ws_42", planId: "pro" });
  });
  it("rejects a tampered token", () => {
    const token = signMockCheckout("ws_42", "pro");
    const [payload] = token.split(".");
    expect(verifyMockCheckout(`${payload}.deadbeef`)).toBeNull();
  });
  it("rejects a structurally invalid token", () => {
    expect(verifyMockCheckout("no-separator-here-only-one-part")).toBeNull();
  });
});
