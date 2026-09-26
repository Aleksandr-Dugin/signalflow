-- 0008: funnel evidence from conversion callbacks (docs/ai-agents.md)
--
-- Adds the two email_events.eventType values the conversion pipeline writes:
--   clicked   - prospect followed a tracked Calendly/Stripe CTA
--   converted - Calendly or Stripe confirmed an outcome
--
-- MySQL requires the FULL value list when widening an enum. The ordering below
-- matches drizzle/schema.ts exactly. Values are appended rather than reordered
-- so existing rows keep their numeric encoding.
--
-- NOTE: drizzle/ has no meta/_journal.json, so `drizzle-kit migrate` will NOT
-- pick this file up. Apply it by hand (or fix the journal first) — see
-- docs/database.md.

ALTER TABLE `email_events`
  MODIFY COLUMN `eventType`
  enum('sent','delivered','bounced','opened','clicked','replied','converted','unsubscribed','failed')
  NOT NULL;
