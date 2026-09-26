// Opportunity scoring. The audit found the original engine hard-coded freshness
// and ignored whether a contact exists. Here every factor is derived from real
// inputs so a prospect can only rank high when the data actually supports it.

export interface ScoringSignal {
  importance: number;
  detectedAt?: Date | null;
}

export interface ScoringInput {
  fitScore: number; // 0..100
  confidence: number; // 0..100
  signals: ScoringSignal[];
  lastActivityAt?: Date | null; // most recent signal/research
  hasContact: boolean;
  outreachEnabled: boolean;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Strongest single signal dominates, a couple of supporting signals add up. */
export function computeSignalStrength(signals: ScoringSignal[]): number {
  if (!signals.length) return 0;
  const sorted = [...signals].sort((a, b) => b.importance - a.importance);
  const top = sorted[0].importance;
  const support = sorted.slice(1).reduce((acc, s) => acc + s.importance * 0.1, 0);
  return clamp(Math.round(top + support));
}

/** 100 = detected now, decaying toward 0 after ~45 days. */
export function computeFreshness(when: Date | null | undefined, now = new Date()): number {
  if (!when) return 0;
  const ageDays = (now.getTime() - new Date(when).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 100;
  if (ageDays >= 45) return 0;
  return clamp(Math.round(100 * (1 - ageDays / 45)));
}

/** Intent = mostly "how strong + how recent is the buying signal". */
export function computeIntentScore(signalStrength: number, freshness: number): number {
  return clamp(Math.round(signalStrength * 0.72 + freshness * 0.28));
}

export interface ScoredOutcome {
  signalStrength: number;
  freshness: number;
  intentScore: number;
  overallScore: number;
  qualified: boolean;
}

export function scoreProspect(input: ScoringInput, now = new Date()): ScoredOutcome {
  const signalStrength = computeSignalStrength(input.signals);
  const freshness = computeFreshness(input.lastActivityAt, now);
  const intentScore = computeIntentScore(signalStrength, freshness);

  let overall = input.fitScore * 0.45 + intentScore * 0.35 + input.confidence * 0.2;
  // A lead you cannot actually contact is worth far less as an action target.
  if (!input.hasContact) overall *= 0.7;
  if (!input.outreachEnabled) overall *= 0.85;
  const overallScore = clamp(Math.round(overall));

  return {
    signalStrength,
    freshness,
    intentScore,
    overallScore,
    qualified: input.fitScore >= 55 && overallScore >= 50,
  };
}

// ── Opportunity lifecycle helpers ─────────────────────────────────────────────
export type OpportunityStage =
  | "open"
  | "responded"
  | "meeting_booked"
  | "negotiating"
  | "won"
  | "lost";

const STAGE_ORDER: OpportunityStage[] = [
  "open",
  "responded",
  "meeting_booked",
  "negotiating",
  "won",
  "lost",
];

export function isTerminalStage(stage: OpportunityStage): boolean {
  return stage === "won" || stage === "lost";
}

/** Only allow forward moves on the non-terminal part of the funnel. */
export function canAdvanceStage(from: OpportunityStage, to: OpportunityStage): boolean {
  if (isTerminalStage(from)) return false;
  if (to === "won" || to === "lost") return true;
  return STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from);
}

// ── Evidence-driven stage advancement (docs/ai-agents.md) ────────────────────
// A stage may only be entered when an external fact proves it happened. Nothing
// here fires because *we* performed an action (sent a mail, ran a job) — that is
// our own activity, not the prospect's, and using it inflated the funnel.
export type ConversionSignal =
  | "cta_clicked:booking"
  | "cta_clicked:payment"
  | "meeting_confirmed"
  | "payment_captured";

const SIGNAL_TARGET: Record<ConversionSignal, OpportunityStage | null> = {
  // Opening the scheduler is intent, not an appointment. Recorded, never promoted.
  "cta_clicked:booking": null,
  // Engaging the checkout link is a commercial conversation. Real click, real intent.
  "cta_clicked:payment": "negotiating",
  // Calendly told us an event exists.
  meeting_confirmed: "meeting_booked",
  // Money moved.
  payment_captured: "won",
};

/** The stage a signal authorises, or null when it carries no stage implication. */
export function stageForSignal(signal: ConversionSignal): OpportunityStage | null {
  return SIGNAL_TARGET[signal] ?? null;
}

/**
 * Resolve the stage to write for a signal, or null for "leave it alone". Never
 * regresses and never resurrects a terminal deal, so replayed webhooks are inert.
 */
export function applySignal(
  current: OpportunityStage,
  signal: ConversionSignal,
): OpportunityStage | null {
  const target = stageForSignal(signal);
  if (!target) return null;
  return canAdvanceStage(current, target) ? target : null;
}
