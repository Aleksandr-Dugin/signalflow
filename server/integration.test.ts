// Integration tests against a real MySQL — the gap that mattered most: every
// other file in server/*.test.ts is pure unit logic, so the autonomous loop
// (outreach -> reply -> follow-up job -> conversion -> stage) had never been
// executed end to end, and the SQL in drizzle/ had never been applied.
//
// Skipped entirely when DATABASE_URL is unset, so `pnpm test` stays runnable
// offline. CI (`.github/workflows/ci.yml`) provisions a MySQL service, applies
// `pnpm db:migrate`, and therefore really executes this file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../drizzle/schema";
import { closeDb, getDb } from "./_core/database";
import { env } from "./_core/env";
import { detectSchemaDrift } from "./_core/schemaCheck";
import { getJob, runNextJob } from "./services/jobs";
// Side-effect import: registers reply.followup / campaign.discovery handlers.
import "./services/jobHandlers";
import { makeIdempotencyKey, sendOutreachEmail } from "./services/outreach";
import { ingestEmailEvent } from "./services/replies";
import { handleCalendlyEvent, handleStripeEvent, applyStripeValue, recordCtaClick } from "./services/conversions";

const databaseConfigured = Boolean(process.env.DATABASE_URL);

// Deliberately NOT keyed on process.env.CI. The workflow runs two jobs with
// opposite contracts: `checks` has no database by design and must skip cleanly,
// while `integration` exists only to exercise a real database. Gating on CI made
// the first real run fail in `checks` — see run #1, which cited this line.
// So the requirement is declared explicitly by whichever job owns it.
const databaseRequired = Boolean(process.env.REQUIRE_INTEGRATION_TESTS);

if (!databaseConfigured) {
  if (databaseRequired) {
    // Fail loudly rather than exiting 0 from a skip. A green job that silently
    // omitted the only database-backed tests would *claim* the autonomous loop was
    // verified when nothing ran — strictly worse than a red one, and the exact
    // failure mode this suite exists to close.
    throw new Error(
      "REQUIRE_INTEGRATION_TESTS is set but DATABASE_URL is not. Refusing to report " +
        "success from a skipped integration suite — check the env block of the " +
        "integration job in .github/workflows/ci.yml.",
    );
  }
  console.warn(
    "[integration] DATABASE_URL unset — skipping the 8 database-backed tests.",
  );
}
const suite = databaseConfigured ? describe : describe.skip;

/** Everything is namespaced by this suffix so concurrent/repeated runs cannot collide. */
const run = nanoid(8);

suite("autonomous loop against a real database", () => {
  const db = getDb();
  const workspaceId = `ws_${run}`;
  const userId = `u_${run}`;
  const prospectId = `p_${run}`;
  const campaignId = `c_${run}`;
  const companyId = `co_${run}`;
  const contactId = `ct_${run}`;
  const email = `prospect-${run}@acme-corp.example`;

  let firstOutreachId = "";
  let firstReferenceId = "";

  beforeAll(async () => {
    if (!db) throw new Error("getDb() returned null despite DATABASE_URL");
    await db.insert(schema.users).values({
      id: userId,
      email: `owner-${run}@acme-corp.example`,
      name: "Integration Owner",
    });
    // planId pro so outreach entitlements do not block the send path (free = 0/mo).
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      name: `Integration ${run}`,
      slug: `integration-${run}`,
      ownerId: userId,
      planId: "pro",
      autopilot: true,
    });
    await db.insert(schema.profiles).values({
      id: `pf_${run}`,
      workspaceId,
      serviceDescription: "Done-for-you data migrations",
      targetMarket: "B2B SaaS",
      geography: "US",
      goals: "10 discovery calls a month",
    });
    await db.insert(schema.campaigns).values({
      id: campaignId,
      workspaceId,
      name: `Integration campaign ${run}`,
      offerDescription: "Zero-downtime data migrations",
      targetDescription: "B2B SaaS",
      geography: "US",
      industry: "SaaS",
      status: "active",
    });
    await db.insert(schema.companies).values({
      id: companyId,
      workspaceId,
      name: `Acme Corp ${run}`,
      domain: `acme-corp-${run}.example`,
      industry: "SaaS",
      origin: "live",
    });
    await db.insert(schema.contacts).values({
      id: contactId,
      workspaceId,
      companyId,
      name: "Acme Prospect",
      email,
      verified: true,
    });
    await db.insert(schema.prospects).values({
      id: prospectId,
      workspaceId,
      campaignId,
      companyId,
      contactId,
      status: "qualified",
      origin: "live",
    });
  });

  afterAll(async () => {
    if (!db) return;
    // ai_cache has no FK to workspaces, so clear it explicitly before the cascade.
    await db.delete(schema.aiCache).where(eq(schema.aiCache.workspaceId, workspaceId));
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await closeDb();
  });

  it("drizzle/0000_baseline.sql produces a schema that matches schema.ts", async () => {
    // The highest-value assertion here: this repo shipped for months with a
    // single loose SQL file and no migration journal, so `db:migrate` applied
    // nothing while the code assumed the full schema.
    const drift = await detectSchemaDrift();
    expect(drift).not.toBeNull();
    expect(drift!.unknownTables).toEqual([]);
    expect(drift!.missing).toEqual([]);
  });

  it("sends an outreach email and dedupes a retry on the idempotency key", async () => {
    const key = makeIdempotencyKey(workspaceId, prospectId, null);
    const first = await sendOutreachEmail({
      workspaceId,
      prospectId,
      subject: `Zero-downtime migrations for Acme`,
      body: `Hi — worth a quick chat?\n\nBook a slot: ${env.calendlyUrl || "https://calendly.com/acme/30min"}`,
      idempotencyKey: key,
    });
    expect(first.status).toBe("sent");
    expect(first.alreadyProcessed).toBe(false);
    firstOutreachId = first.outreachId;

    const second = await sendOutreachEmail({
      workspaceId,
      prospectId,
      subject: `Zero-downtime migrations for Acme`,
      body: "identical retry",
      idempotencyKey: key,
    });
    expect(second.alreadyProcessed).toBe(true);
    expect(second.outreachId).toBe(first.outreachId);

    const rows = await db!
      .select({ id: schema.outreachMessages.id })
      .from(schema.outreachMessages)
      .where(eq(schema.outreachMessages.prospectId, prospectId));
    expect(rows).toHaveLength(1);

    const [stored] = await db!
      .select()
      .from(schema.outreachMessages)
      .where(eq(schema.outreachMessages.id, first.outreachId))
      .limit(1);
    expect(stored.status).toBe("sent");
    expect(stored.recipientEmail).toBe(email);
    firstReferenceId = stored.referenceId!;
    expect(stored.referenceId).toBeTruthy();
  });

  // Meaningless without a configured booking URL: there would be nothing to rewrite.
  it.skipIf(!env.calendlyUrl)(
    "rewrites configured tool URLs into per-message tracked links at send time",
    async () => {
      const key = `${workspaceId}:tracked:${run}`.slice(0, 64);
      const result = await sendOutreachEmail({
        workspaceId,
        prospectId,
        subject: "tracked",
        body: `Book a slot: ${env.calendlyUrl}`,
        idempotencyKey: key,
      });
      const [msg] = await db!
        .select({ body: schema.outreachMessages.body, referenceId: schema.outreachMessages.referenceId })
        .from(schema.outreachMessages)
        .where(eq(schema.outreachMessages.id, result.outreachId))
        .limit(1);
      // The stored record must match what the prospect actually received.
      expect(msg!.body).not.toContain(env.calendlyUrl);
      expect(msg!.body).toMatch(new RegExp(`/api/track/cta/${msg!.referenceId}/booking$`, "m"));
    },
  );

  it("ingests a reply, classifies it, opens an opportunity and queues a follow-up", async () => {
    const result = await ingestEmailEvent({
      fromAddress: email,
      eventType: "replied",
      bodyText: "Sounds good, let's set up a meeting.",
      subject: "Re: Zero-downtime migrations",
      dedupeKey: `int:${run}:reply1`,
    });
    expect(result.duplicate).toBe(false);
    expect(result.outreachId).toBeTruthy();
    expect(result.classification).toBe("interested");
    expect(result.opportunityId).toBeTruthy();
    expect(result.suppressed).toBe(false);

    const [prospect] = await db!
      .select({ status: schema.prospects.status })
      .from(schema.prospects)
      .where(eq(schema.prospects.id, prospectId))
      .limit(1);
    expect(prospect!.status).toBe("opportunity");

    const jobs = await db!
      .select({ id: schema.jobRuns.id, type: schema.jobRuns.type, status: schema.jobRuns.status })
      .from(schema.jobRuns)
      .where(
        and(
          eq(schema.jobRuns.workspaceId, workspaceId),
          inArray(schema.jobRuns.type, ["reply.followup"]),
        ),
      );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");

    // Same dedupeKey must be inert.
    const replay = await ingestEmailEvent({
      fromAddress: email,
      eventType: "replied",
      bodyText: "Sounds good, let's set up a meeting.",
      dedupeKey: `int:${run}:reply1`,
    });
    expect(replay.duplicate).toBe(true);
  });

  it("runs the follow-up job through the worker without inflating the funnel", async () => {
    // The job is debounced 60s ahead; advance the clock past it.
    const processed = await runNextJob(new Date(Date.now() + 120_000));
    expect(processed).toBe(true);

    const [job] = await db!
      .select({ id: schema.jobRuns.id })
      .from(schema.jobRuns)
      .where(
        and(eq(schema.jobRuns.workspaceId, workspaceId), eq(schema.jobRuns.type, "reply.followup")),
      );
    const final = await getJob(job!.id);
    expect(final!.status).toBe("completed");
    expect(final!.error).toBeNull();

    const rows = await db!
      .select({ id: schema.outreachMessages.id, status: schema.outreachMessages.status })
      .from(schema.outreachMessages)
      .where(eq(schema.outreachMessages.prospectId, prospectId));
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // Regression guard for the old cosmetic behaviour: sending our own follow-up
    // must NOT move the deal to meeting_booked.
    const [opp] = await db!
      .select({ stage: schema.opportunities.stage })
      .from(schema.opportunities)
      .where(eq(schema.opportunities.prospectId, prospectId))
      .limit(1);
    expect(opp!.stage).toBe("responded");
  });

  it("walks the funnel on real external evidence only", async () => {
    // 1. Booking-link click: recorded, deliberately no stage change.
    const booking = await recordCtaClick(firstReferenceId, "booking");
    expect(booking.handled).toBe(true);
    expect(booking.stage).toBe("responded");

    // 2. Calendly confirms the event -> meeting_booked.
    const calendly = await handleCalendlyEvent({
      event: "event.created",
      event_uuid: `cal_${run}`,
      payload: { invitee: { email }, event: { name: "30min", status: "active" } },
    });
    expect(calendly.handled).toBe(true);
    expect(calendly.stage).toBe("meeting_booked");

    // 3. Payment-link click -> negotiating.
    const payment = await recordCtaClick(firstReferenceId, "payment");
    expect(payment.handled).toBe(true);
    expect(payment.stage).toBe("negotiating");

    // 4. Stripe captures payment -> won, and the deal value is recorded.
    const stripeEvent = {
      id: `evt_${run}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${run}`,
          customer_email: email,
          payment_status: "paid",
          amount_total: 4900,
          currency: "usd",
        },
      },
    };
    const won = await handleStripeEvent(stripeEvent);
    expect(won.handled).toBe(true);
    expect(won.stage).toBe("won");
    // The route calls both; mirror it so deal value is recorded too.
    await applyStripeValue(stripeEvent);

    const [opp] = await db!
      .select({ stage: schema.opportunities.stage, valueCents: schema.opportunities.valueCents })
      .from(schema.opportunities)
      .where(eq(schema.opportunities.prospectId, prospectId))
      .limit(1);
    expect(opp!.stage).toBe("won");
    expect(opp!.valueCents).toBe(4900);

    const [prospect] = await db!
      .select({ status: schema.prospects.status })
      .from(schema.prospects)
      .where(eq(schema.prospects.id, prospectId))
      .limit(1);
    expect(prospect!.status).toBe("won");
  });

  it("does not record deal value for a checkout that was never paid", async () => {
    // Runs after the funnel walk, which leaves the deal at won / 4900. An
    // abandoned Checkout still carries amount_total, so recording it would
    // inflate closed revenue with money that never arrived.
    const [before] = await db!
      .select({ valueCents: schema.opportunities.valueCents })
      .from(schema.opportunities)
      .where(eq(schema.opportunities.prospectId, prospectId))
      .limit(1);
    expect(before!.valueCents).toBe(4900);

    await applyStripeValue({
      id: `evt_open_${run}`,
      type: "checkout.session.created",
      data: {
        object: {
          id: `cs_open_${run}`,
          customer_email: email,
          payment_status: "open",
          amount_total: 999_999,
          currency: "usd",
        },
      },
    });

    const [after] = await db!
      .select({ valueCents: schema.opportunities.valueCents })
      .from(schema.opportunities)
      .where(eq(schema.opportunities.prospectId, prospectId))
      .limit(1);
    expect(after!.valueCents).toBe(4900);
  });

  it("treats a replayed provider webhook as inert", async () => {
    const replay = await handleStripeEvent({
      id: `evt_${run}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${run}`,
          customer_email: email,
          payment_status: "paid",
          amount_total: 4900,
          currency: "usd",
        },
      },
    });
    expect(replay.duplicate).toBe(true);

    const [opp] = await db!
      .select({ stage: schema.opportunities.stage })
      .from(schema.opportunities)
      .where(eq(schema.opportunities.prospectId, prospectId))
      .limit(1);
    expect(opp!.stage).toBe("won");

    const clickReplay = await recordCtaClick(firstReferenceId, "payment");
    expect(clickReplay.duplicate).toBe(true);
  });

  it("refuses to attribute a reply to an address owned by two workspaces", async () => {
    // Second tenant that emailed the *same* address: the fallback resolver must
    // decline rather than attach this reply to an arbitrary tenant.
    const otherWs = `ws2_${run}`;
    await db!.insert(schema.workspaces).values({
      id: otherWs,
      name: `Second Tenant ${run}`,
      slug: `second-tenant-${run}`,
      ownerId: userId,
      planId: "pro",
    });
    await db!.insert(schema.outreachMessages).values({
      id: `om2_${run}`,
      workspaceId: otherWs,
      prospectId,
      recipientEmail: email,
      subject: "cross-tenant probe",
      body: "probe",
      status: "sent",
      idempotencyKey: `probe:${run}`.slice(0, 64),
      referenceId: `ref2_${run}`,
    });

    const result = await ingestEmailEvent({
      fromAddress: email,
      eventType: "replied",
      bodyText: "hello?",
      dedupeKey: `int:${run}:ambiguous`,
    });
    // No workspace could be established, so nothing is written at all.
    expect(result.outreachId).toBeNull();
    expect(result.prospectId).toBeNull();
    expect(result.opportunityId).toBeNull();
    expect(result.classification).toBeNull();

    await db!.delete(schema.workspaces).where(eq(schema.workspaces.id, otherWs));
  });
});
