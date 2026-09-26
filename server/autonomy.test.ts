// Unit tests for the autonomous SDR layer constants (docs/ai-agents.md).
import { describe, expect, it } from "vitest";
import {
  detectObjections,
  FOLLOWUP_TRIGGER_LABELS,
  OBJECTION_KEYWORDS,
  REPLY_LABELS,
} from "../shared/const";

describe("follow-up trigger labels", () => {
  it("are a subset of REPLY_LABELS", () => {
    for (const label of FOLLOWUP_TRIGGER_LABELS) {
      expect(REPLY_LABELS).toContain(label);
    }
  });

  it("never auto-follow-up on disengagement labels", () => {
    expect(FOLLOWUP_TRIGGER_LABELS).not.toContain("not_interested");
    expect(FOLLOWUP_TRIGGER_LABELS).not.toContain("unsubscribe");
    expect(FOLLOWUP_TRIGGER_LABELS).not.toContain("out_of_office");
  });

  it("trigger on engagement labels", () => {
    expect(FOLLOWUP_TRIGGER_LABELS).toContain("positive");
    expect(FOLLOWUP_TRIGGER_LABELS).toContain("interested");
    expect(FOLLOWUP_TRIGGER_LABELS).toContain("question");
  });
});

describe("detectObjections", () => {
  it("detects price objections case-insensitively", () => {
    expect(detectObjections("Honestly, it looks EXPENSIVE for our budget.")).toContain("price");
  });

  it("detects timing objections", () => {
    expect(detectObjections("Let's revisit this next quarter.")).toContain("timing");
  });

  it("detects competitor and trust objections together", () => {
    const hits = detectObjections(
      "We already use another tool for this. Do you have any case studies or SOC2 proof?",
    );
    expect(hits).toContain("competitor");
    expect(hits).toContain("trust");
  });

  it("returns [] for neutral text", () => {
    expect(detectObjections("Sounds interesting, tell me more.")).toEqual([]);
  });

  it("keyword patterns are regexes (usable directly by the writer)", () => {
    for (const patterns of Object.values(OBJECTION_KEYWORDS)) {
      for (const p of patterns) expect(p).toBeInstanceOf(RegExp);
    }
  });
});
