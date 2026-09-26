// Registers all background job handlers. Imported once from server boot so the
// worker's `handlers` map is populated before the first tick. Mirrors the
// "AI SDR agent" pattern used by SalesGPT and b2b-sdr-agent-template: an event
// (inbound reply, timer, campaign creation) turns into an AI-written draft that
// is then sent through the same idempotent outreach pipeline a human would use.
import { getDb } from "../_core/database";
import { env } from "../_core/env";
import { eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { enqueueJob, registerJob } from "./jobs";
import { generatePersonalization, getProspectThread, runDiscovery } from "../db";
import { makeIdempotencyKey, sendOutreachEmail } from "./outreach";

registerJob("reply.followup", async (payload: any, job) => {
  const prospectId = String(payload?.prospectId ?? "");
  const lastReplyBody = String(payload?.lastReplyBody ?? "");
  if (!prospectId) throw new Error("reply.followup: missing prospectId");

  // 1) Pull the thread so the AI writer sees prior turns (SalesGPT-style
  //    conversation memory).
  const thread = await getProspectThread(job.workspaceId, prospectId, 10);
  const history = thread
    .map((m) => `${m.direction === "inbound" ? "Prospect" : "Us"}: ${(m.body ?? "").slice(0, 500)}`)
    .join("\n")
    .slice(-3500);

  // 2) Generate a thread-aware, objection-aware draft. If the prospect raised a
  //    "price" objection and STRIPE_PAYMENT_LINK is set, the CTA will include
  //    a self-serve checkout link (SalesGPT's Stripe tool equivalent).
  const draft = await generatePersonalization(job.workspaceId, prospectId, {
    history,
    lastReplyBody,
  });

  // 3) Send through the same outreach service the UI uses. Idempotency is
  //    keyed off the personalization id, so re-running the job never double-sends.
  const body = `${draft.openingLine}\n\n${draft.body}\n\n${draft.cta}`.trim();
  const result = await sendOutreachEmail({
    workspaceId: job.workspaceId,
    prospectId,
    subject: draft.subject,
    body,
    personalizationId: draft.id ?? null,
    idempotencyKey: makeIdempotencyKey(job.workspaceId, prospectId, draft.id ?? null),
  });

  // 4) Advance the opportunity a stage — from "responded" to "meeting_booked"
  //    on the first follow-up we send. Terminal stages are guarded by the
  //    opportunity service.
  const db = getDb();
  if (db) {
    const [opp] = await db
      .select()
      .from(schema.opportunities)
      .where(eq(schema.opportunities.prospectId, prospectId))
      .limit(1);
    if (opp && opp.stage === "responded") {
      await db
        .update(schema.opportunities)
        .set({ stage: "meeting_booked" })
        .where(eq(schema.opportunities.id, opp.id));
    }
  }

  return { outreachId: result.outreachId, status: result.status, personalizationId: draft.id };
});

registerJob("campaign.discovery", async (payload: any, job) => {
  const campaignId = String(payload?.campaignId ?? "");
  if (!campaignId) throw new Error("campaign.discovery: missing campaignId");
  const outcome = await runDiscovery(job.workspaceId, campaignId);

  // Recurring discovery: if the operator configured a cadence, re-enqueue this
  // campaign's job. Acts as a lightweight cron without a scheduler dependency
  // (same pattern b2b-sdr-agent-template uses with HEARTBEAT.md + cron jobs).
  if (env.discoveryIntervalHours > 0) {
    await enqueueJob({
      workspaceId: job.workspaceId,
      type: "campaign.discovery",
      payload: { campaignId },
      runAfter: new Date(Date.now() + env.discoveryIntervalHours * 3600_000),
    });
  }
  return outcome;
});
