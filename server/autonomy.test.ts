// Unit tests for the autonomous SDR layer: the trigger/objection constants and
// the polarity of the master autonomy switch (docs/ai-agents.md).
import { describe, expect, it } from "vitest";
import {
  detectObjections,
  FOLLOWUP_TRIGGER_LABELS,
  OBJECTION_KEYWORDS,
  REPLY_LABELS,
} from "../shared/const";
import {
  autonomyAllowed,
  type GlobalAutonomyState,
} from "./services/autonomyState";

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

describe("global autonomy switch", () => {
  const state = (over: Partial<GlobalAutonomyState> = {}): GlobalAutonomyState => ({
    autopilotPaused: false,
    pausedReason: "",
    pausedBy: null,
    pausedAt: null,
    ...over,
  });

  it("allows autonomy only for an explicitly un-paused state", () => {
    expect(autonomyAllowed(state())).toBe(true);
  });

  it("blocks when the switch reads paused", () => {
    expect(autonomyAllowed(state({ autopilotPaused: true, pausedReason: "incident" }))).toBe(false);
  });

  it("blocks when the switch cannot be read at all", () => {
    // A table that was never migrated, a dead connection and a failed query all
    // surface as null. Unknown must never be read as "allowed to send".
    expect(autonomyAllowed(null)).toBe(false);
  });

  it("does not treat a missing or non-boolean flag as un-paused", () => {
    // Pins the strict `=== false`. A refactor to !state?.autopilotPaused would
    // pass the two obvious cases above and then fail open the moment a row comes
    // back with the column undefined — which is exactly the shape a partially
    // applied migration produces.
    expect(autonomyAllowed({ ...state(), autopilotPaused: undefined as never })).toBe(false);
    expect(autonomyAllowed({ ...state(), autopilotPaused: "false" as never })).toBe(false);
    expect(autonomyAllowed({} as unknown as GlobalAutonomyState)).toBe(false);
  });
});
