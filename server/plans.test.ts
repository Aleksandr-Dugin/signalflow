import { describe, it, expect } from "vitest";
import { PLANS, getPlan, getActivePaidPlans, withinLimit, hasFeature, DEFAULT_PLAN_ID } from "../shared/plans";
import { makeIdempotencyKey } from "./services/outreach";

describe("plans", () => {
  it("exposes a free plan as the default", () => {
    expect(getPlan(undefined).id).toBe(DEFAULT_PLAN_ID);
    expect(getPlan("does-not-exist").id).toBe(DEFAULT_PLAN_ID);
  });
  it("free plan blocks outreach", () => {
    expect(PLANS.free.features.outreach).toBe(false);
    expect(PLANS.free.limits.outreachPerMonth).toBe(0);
    expect(hasFeature(PLANS.free, "outreach")).toBe(false);
  });
  it("paid tiers enable outreach & personalization", () => {
    for (const plan of getActivePaidPlans()) {
      expect(plan.features.outreach).toBe(true);
      expect(plan.features.personalization).toBe(true);
      expect(plan.priceCents).toBeGreaterThan(0);
    }
  });
  it("only returns paid plans from getActivePaidPlans", () => {
    const ids = getActivePaidPlans().map((p) => p.id);
    expect(ids).toEqual(["starter", "pro", "agency"]);
    expect(ids).not.toContain("free");
  });
  it("withinLimit respects capacity incl. the item being added", () => {
    expect(withinLimit(PLANS.free, "campaigns", 0, 1)).toBe(true);
    expect(withinLimit(PLANS.free, "campaigns", 1, 1)).toBe(false);
    expect(withinLimit(PLANS.pro, "campaigns", 9, 1)).toBe(true);
    expect(withinLimit(PLANS.pro, "campaigns", 10, 1)).toBe(false);
  });
  it("higher tiers grant strictly greater limits", () => {
    expect(PLANS.agency.limits.aiRunsPerMonth).toBeGreaterThan(PLANS.pro.limits.aiRunsPerMonth);
    expect(PLANS.pro.limits.prospectsPerCampaign).toBeGreaterThan(PLANS.starter.limits.prospectsPerCampaign);
  });
});

describe("makeIdempotencyKey", () => {
  it("is stable for the same inputs", () => {
    const a = makeIdempotencyKey("ws1", "p1", "personalization-1");
    const b = makeIdempotencyKey("ws1", "p1", "personalization-1");
    expect(a).toBe(b);
  });
  it("differs when prospect or personalization differ", () => {
    const base = makeIdempotencyKey("ws1", "p1", "dr1");
    expect(base).not.toBe(makeIdempotencyKey("ws1", "p2", "dr1"));
    expect(base).not.toBe(makeIdempotencyKey("ws1", "p1", "dr2"));
    expect(base).not.toBe(makeIdempotencyKey("ws1", "p1", null));
  });
  it("caps at 64 chars for long ids", () => {
    const key = makeIdempotencyKey("w".repeat(50), "p".repeat(50), null);
    expect(key.length).toBeLessThanOrEqual(64);
  });
});
