// Shared constants used by both client and server.

export const APP_NAME = "SignalFlow";
export const APP_TAGLINE = "Tell us what you can do. We'll find the businesses that need it.";

// Session cookie used for the local JWT auth.
export const SESSION_COOKIE_NAME = "signalflow_session";

// Canonical UNAUTHORIZED message the client uses to detect a needed re-login.
export const UNAUTHED_ERR_MSG = "AUTH_UNAUTHORIZED";

export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// Reply classification labels (goal §13).
export const REPLY_LABELS = [
  "positive",
  "interested",
  "question",
  "neutral",
  "not_interested",
  "unsubscribe",
  "out_of_office",
  "unknown",
] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];

// Reply classifications that should trigger an autonomous AI follow-up when the
// workspace has `autopilot` enabled (see docs/ai-agents.md). Anything else
// (not_interested, unsubscribe, out_of_office) stops the sequence.
export const FOLLOWUP_TRIGGER_LABELS: readonly ReplyLabel[] = [
  "positive",
  "interested",
  "question",
] as const;

// Lightweight keyword detector for common objections inside a "question"/"neutral"
// body. Used by the AI writer to pick the right rebuttal template. Not persisted
// as its own ReplyLabel — that would require a MySQL enum migration.
export const OBJECTION_KEYWORDS = {
  price: [/expensive|price|budget|cost|too much|quote/i],
  timing: [/later|next quarter|not now|busy|revisit|check back|wait/i],
  competitor: [/already using|we use|other tool|competitor|switch/i],
  trust: [/reference|case study|reviews|proof|security|soc2|gdpr/i],
} as const;
export type ObjectionKind = keyof typeof OBJECTION_KEYWORDS;

export function detectObjections(text: string): ObjectionKind[] {
  const hits: ObjectionKind[] = [];
  for (const kind of Object.keys(OBJECTION_KEYWORDS) as ObjectionKind[]) {
    if (OBJECTION_KEYWORDS[kind].some((re) => re.test(text))) hits.push(kind);
  }
  return hits;
}

// Prospect lifecycle status.
export const PROSPECT_STATUSES = [
  "new",
  "qualified",
  "disqualified",
  "contacted",
  "interested",
  "not_interested",
  "opportunity",
  "suppressed",
  "won",
  "lost",
] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

// Where a persisted record came from — persisted so demo/live is never confused.
export const DATA_ORIGINS = ["live", "demo"] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];
