import { describe, it, expect } from "vitest";
import {
  computeSignalStrength,
  computeFreshness,
  computeIntentScore,
  scoreProspect,
  canAdvanceStage,
  isTerminalStage,
} from "./services/opportunity";

const DAY = 1000 * 60 * 60 * 24;

describe("signal strength", () => {
  it("is 0 with no signals", () => {
    expect(computeSignalStrength([])).toBe(0);
  });
  it("top signal dominates, support adds 10% each", () => {
    expect(computeSignalStrength([{ importance: 80 }, { importance: 50 }])).toBe(85);
  });
  it("clamps to 100", () => {
    expect(computeSignalStrength([{ importance: 100 }, { importance: 100 }, { importance: 100 }])).toBe(100);
  });
});

describe("freshness", () => {
  const now = new Date("2026-01-30T00:00:00Z");
  it("is 0 when unknown", () => expect(computeFreshness(null, now)).toBe(0));
  it("is 100 when detected now", () => expect(computeFreshness(now, now)).toBe(100));
  it("decays toward 0 at 45 days", () => expect(computeFreshness(new Date(now.getTime() - 45 * DAY), now)).toBe(0));
  it("halves around 22-23 days", () => {
    const v = computeFreshness(new Date(now.getTime() - 22.5 * DAY), now);
    expect(v).toBeGreaterThanOrEqual(49);
    expect(v).toBeLessThanOrEqual(51);
  });
});

describe("intent score", () => {
  it("weights strength over freshness (0.72 / 0.28)", () => {
    expect(computeIntentScore(100, 100)).toBe(100);
    expect(computeIntentScore(0, 0)).toBe(0);
    expect(computeIntentScore(70, 0)).toBe(50);
  });
});

describe("scoreProspect", () => {
  const base = {
    fitScore: 80,
    confidence: 80,
    signals: [{ importance: 80 }],
    lastActivityAt: new Date(),
    hasContact: true,
    outreachEnabled: true,
  };
  it("qualifies a strong, contactable, recent lead", () => {
    const r = scoreProspect(base);
    expect(r.qualified).toBe(true);
    expect(r.overallScore).toBeGreaterThanOrEqual(50);
  });
  it("reduces score without a contact", () => {
    const withContact = scoreProspect(base).overallScore;
    const without = scoreProspect({ ...base, hasContact: false }).overallScore;
    expect(without).toBeLessThan(withContact);
  });
  it("reduces score when outreach is disabled", () => {
    const on = scoreProspect(base).overallScore;
    const off = scoreProspect({ ...base, outreachEnabled: false }).overallScore;
    expect(off).toBeLessThan(on);
  });
  it("never qualifies a low-fit lead regardless of other factors", () => {
    const r = scoreProspect({ ...base, fitScore: 30 });
    expect(r.qualified).toBe(false);
  });
});

describe("opportunity stages", () => {
  it("flags terminal stages", () => {
    expect(isTerminalStage("won")).toBe(true);
    expect(isTerminalStage("lost")).toBe(true);
    expect(isTerminalStage("negotiating")).toBe(false);
  });
  it("only advances forward", () => {
    expect(canAdvanceStage("open", "responded")).toBe(true);
    expect(canAdvanceStage("responded", "open")).toBe(false);
  });
  it("allows closing to won/lost from any non-terminal stage", () => {
    expect(canAdvanceStage("open", "won")).toBe(true);
    expect(canAdvanceStage("negotiating", "lost")).toBe(true);
  });
  it("cannot move out of a terminal stage", () => {
    expect(canAdvanceStage("won", "negotiating")).toBe(false);
    expect(canAdvanceStage("lost", "open")).toBe(false);
  });
});
