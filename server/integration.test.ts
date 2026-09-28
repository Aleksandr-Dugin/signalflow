// Integration tests against a real MySQL — the gap that mattered most: every
// other file in server/*.test.ts is pure unit logic, so the autonomous loop
// (outreach -> reply -> follow-up job -> conversion -> stage) had never been
// executed end to end, and the SQL in drizzle/ had never been applied.
//
// Skipped entirely when DATABASE_URL is unset, so `pnpm test` stays runnable
// offline. CI (`.github/workflows/ci.yml`) provisions a MySQL service, applies
// `pnpm db:migrate`, and therefore really executes this file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../drizzle/schema";
import { closeDb, getDb } from "./_core/database";
import { env } from "./_core/env";
import { detectSchemaDrift } from "./_core/schemaCheck";
import { enqueueJob, getJob, queueReport, runNextJob } from "./services/jobs";
import {
  isAutopilotGloballyPaused,
  readGlobalAutonomyState,
  setAutopilotGloballyPaused,
} from "./services/autonomyState";
// Side-effect import: registers reply.followup / campaign.discovery handlers.
import "./services/jobHandlers";
import { makeIdempotencyKey, sendOutreachEmail } from "./services/outreach";
import { ingestEmailEvent } from "./services/replies";
import { handleCalendlyEvent, handleStripeEvent, applyStripeValue, recordCtaClick } from "./services/conversions";
import { enrichProspectContact, getProspectThread, listContacts, upsertManualContact } from "./db";
import { smtpConfigured } from "./services/email";
import {
  listProspectIdentities,
  permissionToSend,
  recordChannelInbound,
  sendChannelMessage,
  type ChannelInbound,
} from "./services/channels";
import { addressWasForgotten, eraseSubjectData, exportSubjectData, jobRunsMentioning } from "./services/gdpr";

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
    "[integration] DATABASE_URL unset — the database-backed tests in this file are skipping.",
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

  it("shows both halves of the conversation, with the outcome of ours", async () => {
    // The thread used to read email_events alone, so the mail we sent never appeared:
    // an operator could not see what the autopilot had written to a person, and the
    // follow-up writer had no memory of its own previous messages.
    const thread = await getProspectThread(workspaceId, prospectId, 50);
    const outbound = thread.filter((m) => m.direction === "outbound");
    const inbound = thread.filter((m) => m.direction === "inbound");
    expect(outbound.length).toBeGreaterThanOrEqual(2); // the invite and the AI follow-up
    expect(inbound.length).toBeGreaterThanOrEqual(1); // the reply that triggered it

    // Chronological: a history printed out of order is a history nobody can read.
    const times = thread.map((m) => m.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));

    // Every message we sent says what became of it; messages we received have no
    // outcome of ours to report.
    for (const m of outbound) expect(m.status).toMatch(/^(sent|delivered|replied|failed|suppressed|cancelled|queued|sending|approved)(: .*)?$/);
    for (const m of inbound) expect(m.status).toBeNull();

    // The case this really protects: with no SMTP configured the send is a
    // simulation, and "sent" printed over it would be a claim about an email that
    // never left the machine.
    if (!smtpConfigured()) {
      expect(outbound[0]!.status).toContain("simulated");
    }
  });

  it("walks the funnel on real external evidence only", async () => {
    // 1. Booking-link click: recorded, deliberately no stage change.
    const booking = await recordCtaClick(firstReferenceId, "booking");
    expect(booking.handled).toBe(true);
    expect(booking.stage).toBe("responded");

    // 2. Calendly confirms the event -> meeting_booked. Sent in the v2 wire
    // shape (payload.resource) rather than the retired v1 payload.invitee, so
    // this walks the funnel the way the provider actually posts to it.
    const calendly = await handleCalendlyEvent({
      event: "invitee.created",
      event_uuid: `cal_${run}`,
      payload: { resource: { email, status: "active", scheduled_event: { name: "30min", status: "active" } } },
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

  // Automatic contact search is the one read path that ends up scraping the
  // public internet with a user-supplied id, so its access control is worth
  // pinning against a real database rather than reasoning about it.
  it("refuses to search for a contact that is not the caller's", async () => {
    await expect(enrichProspectContact(`ws_x_${run}`, prospectId)).rejects.toThrow(/Prospect not found/);
    await expect(enrichProspectContact(workspaceId, "p_missing")).rejects.toThrow(/Prospect not found/);
    if (!env.sgaiApiKey) {
      // No scraper configured: say so, instead of reporting "no address found",
      // which an operator would read as a result about the company.
      await expect(enrichProspectContact(workspaceId, prospectId)).rejects.toThrow(/SGAI_API_KEY/);
    }
  });

  // The paid leg is the only contact path that spends money, so the way it fails
  // matters: "no provider configured" is an operator error to fix, while "no
  // address found" would be silently believed as a fact about the prospect.
  if (!env.enrichmentProvider) {
    it("refuses to buy a lookup when no enrichment provider is configured", async () => {
      await expect(enrichProspectContact(workspaceId, prospectId, { paid: true })).rejects.toThrow(
        /ENRICHMENT_PROVIDER/,
      );
    });
  }

  // The columns added in 0002 are only real once something writes and reads them
  // through actual SQL: this is that proof, and it is also the drift test for the
  // migration (a database without them fails here, loudly, not in a job).
  it("records where a contact came from, and keeps what a human typed", async () => {
    const saved = await upsertManualContact(workspaceId, {
      prospectId,
      name: "Ada Lovelace",
      title: "CTO",
      email: `ada-${run}@acme-corp.example`,
      phone: "+1 415 555 0158",
    });
    expect(saved.origin).toBe("manual");
    expect(saved.phone).toBe("+1 415 555 0158");
    expect(saved.socialUrl).toBeNull();
    const listed = await listContacts(workspaceId, prospectId);
    expect(listed.map((c) => c.id)).toContain(saved.id);

    // And the send path states the channel it used instead of inheriting a
    // default. The messenger test below depends on that column being real: it is
    // how a chat reply is told apart from an emailed one in the same table.
    const [sent] = await db!
      .select({ channel: schema.outreachMessages.channel })
      .from(schema.outreachMessages)
      .where(eq(schema.outreachMessages.id, firstOutreachId))
      .limit(1);
    expect(sent?.channel).toBe("email");

    // Hand the prospect back to the contact the rest of the loop is built around.
    await db!.update(schema.prospects).set({ contactId }).where(eq(schema.prospects.id, prospectId));
    await db!.delete(schema.contacts).where(eq(schema.contacts.id, saved.id));
  });

  // The consent model is the whole point of the messenger layer, and it is a property
  // of the database rather than of the platforms: an inbound event creates permission,
  // the absence of one refuses a send, and a STOP removes it. Nothing here reaches the
  // network — the fetch is injected, and CI holds no bot token at all.
  it("grants messenger permission only to someone who writes to us first", async () => {
    const chatId = `7${Buffer.from(run).toString("hex").slice(0, 9)}`;
    const event = (over: Partial<ChannelInbound> = {}): ChannelInbound => ({
      channel: "telegram",
      externalId: chatId,
      handle: "@smoke_peer",
      text: "hello",
      startParam: null,
      revoking: false,
      at: new Date(),
      dedupeKey: `int:${run}:${nanoid(6)}`,
      ...over,
    });

    // Nothing is sendable before an inbound event, whatever we happen to know about
    // this person's phone number or username.
    expect(await listProspectIdentities(workspaceId, prospectId)).toEqual([]);
    await expect(sendChannelMessage({ workspaceId, prospectId, channel: "telegram", text: "cold open" })).rejects.toThrow(
      /never written to us/i,
    );

    // An event we cannot attribute must not create a permission either: a row with no
    // owner would be a licence to message a stranger discovered later.
    const orphan = await recordChannelInbound(event({ startParam: "reference_we_never_issued" }));
    expect(orphan).toMatchObject({ handled: true, attributed: false });
    expect(await listProspectIdentities(workspaceId, prospectId)).toEqual([]);

    // The tracked chat link in the email they clicked is what ties them to the prospect.
    const start = await recordChannelInbound(event({ startParam: firstReferenceId, text: "/start" }));
    expect(start).toMatchObject({ handled: true, attributed: true, prospectId });

    const [identity] = await listProspectIdentities(workspaceId, prospectId);
    expect(identity).toBeTruthy();
    expect(identity!.consentSource).toBe("telegram.start");
    expect(identity!.externalId).toBe(chatId);
    expect(permissionToSend(identity!, { channel: "telegram", now: new Date() }).allowed).toBe(true);

    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const stubFetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 4242 } }) };
    }) as unknown as typeof fetch;

    const sent = await sendChannelMessage({
      workspaceId,
      prospectId,
      channel: "telegram",
      text: "Good to meet you here — what does your migration timeline look like?",
      fetchImpl: stubFetch,
    });
    if (env.telegramBotToken) {
      // A developer running this with a real bot configured must still not reach the
      // platform: the injected fetch is the only transport, and it records the call.
      expect(sent).toMatchObject({ delivered: true, simulated: false });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.body.chat_id).toBe(chatId);
    } else {
      // Unconfigured sender: recorded, and admitted as a simulation rather than a delivery.
      expect(sent).toMatchObject({ delivered: false, simulated: true });
      expect(calls).toHaveLength(0);
    }

    // The conversation shows both halves and names the medium of each, so a chat reply
    // is never mistaken for an email the autopilot may answer however it likes.
    const thread = await getProspectThread(workspaceId, prospectId, 50);
    const chat = thread.filter((m) => m.channel === "telegram");
    expect(chat.map((m) => m.direction)).toContain("inbound");
    expect(chat.map((m) => m.direction)).toContain("outbound");
    const outboundChat = chat.find((m) => m.direction === "outbound")!;
    // A simulated send must still read as simulated in the history it wrote.
    if (sent.simulated) expect(outboundChat.status).toMatch(/^sent: simulated/);
    else expect(outboundChat.status).toBe("sent");

    // They ask to stop. The event both revokes and records it.
    const stop = await recordChannelInbound(event({ text: "STOP", revoking: true }));
    expect(stop).toMatchObject({ attributed: true, revoked: true });
    const afterStop = await listProspectIdentities(workspaceId, prospectId);
    expect(afterStop[0]!.revokedAt).toBeTruthy();
    const refusal = permissionToSend(afterStop[0]!, { channel: "telegram", now: new Date() });
    expect(refusal.allowed).toBe(false);
    await expect(sendChannelMessage({ workspaceId, prospectId, channel: "telegram", text: "one more?" })).rejects.toThrow(
      /asked to stop/i,
    );

    // Writing again is theirs to do, and it is what reopens the conversation.
    await recordChannelInbound(event({ text: "actually, still interested" }));
    const revived = await listProspectIdentities(workspaceId, prospectId);
    expect(revived[0]!.revokedAt).toBeNull();

    // The platform that cannot be attributed by a link of ours refuses cross-tenant
    // guesses: this number belongs to no prospect here, so nothing is stored.
    const waStranger = await recordChannelInbound(
      event({ channel: "whatsapp", externalId: `1555${Buffer.from(run).toString("hex").slice(0, 7)}` }),
    );
    expect(waStranger).toMatchObject({ handled: true, attributed: false });

    // Clean up: the channel rows hang off this prospect, and later tests count events.
    await db!.delete(schema.channelIdentities).where(eq(schema.channelIdentities.prospectId, prospectId));
    await db!
      .delete(schema.emailEvents)
      .where(and(eq(schema.emailEvents.workspaceId, workspaceId), eq(schema.emailEvents.fromAddress, `telegram:${chatId}`)));
    await db!
      .delete(schema.outreachMessages)
      .where(and(eq(schema.outreachMessages.prospectId, prospectId), eq(schema.outreachMessages.channel, "telegram")));
  });

  // Monitoring has to be proved against the real table: the aggregates behind it
  // are GROUP BY / MIN / COUNT over columns this file otherwise only ever writes.
  it("names queued work the worker cannot run, instead of reporting it as healthy", async () => {
    const ghostId = await enqueueJob({ workspaceId, type: "integration.ghost", payload: {} });
    const report = await queueReport();
    expect(report).not.toBeNull();
    expect(report!.unhandled.map((u) => u.type)).toContain("integration.ghost");
    expect(report!.queuedByType.map((q) => q.type)).toContain("integration.ghost");
    expect(report!.health).toBe("degraded");
    expect(report!.problems.join(" ")).toMatch(/no handler/i);
    // Unrunnable work is diagnosed as unrunnable, never as a slow queue.
    expect(report!.problems.join(" ")).not.toMatch(/Backlog/);

    await db!.delete(schema.jobRuns).where(eq(schema.jobRuns.id, ghostId));
    const after = await queueReport();
    expect(after!.unhandled.map((u) => u.type)).not.toContain("integration.ghost");
  });

  // A subject access request and an erasure are the two operations the privacy page
  // promises; the "we will look through the database" version is a promise nobody can
  // keep in one sitting, so it is tested here against real rows. Uses its own second
  // company as well as its own second person, because a campaign is allowed exactly one
  // prospect per company—the constraint, not the test, decides that.
  it("answers and honours a request about one email address", async () => {
    const subject = `erasure-${run}@acme-corp.example`;
    const secondProspectId = `p_erased_${run}`;
    const secondContactId = `ct_erased_${run}`;
    const secondCompanyId = `co2_${run}`;
    await db!.insert(schema.companies).values({
      id: secondCompanyId,
      workspaceId,
      name: `Erase Me Ltd ${run}`,
      domain: `erasure-${run}.example`,
      industry: "SaaS",
      origin: "live",
    });
    await db!.insert(schema.contacts).values({
      id: secondContactId,
      workspaceId,
      companyId: secondCompanyId,
      name: "Erase Me",
      title: "Ops Lead",
      email: subject,
      origin: "page",
      sourceUrl: `https://erasure-${run}.example/team`,
    });
    await db!.insert(schema.prospects).values({
      id: secondProspectId,
      workspaceId,
      campaignId,
      companyId: secondCompanyId,
      contactId: secondContactId,
      status: "qualified",
      origin: "live",
      reasons: ["fits the offer"],
    });
    // Recipient is resolved from the prospect's contact, which is exactly the
    // linkage the export has to follow.
    const sent = await sendOutreachEmail({
      workspaceId,
      prospectId: secondProspectId,
      subject: "Migrations without downtime",
      body: "One line about your pipeline.",
      idempotencyKey: `gdpr:${run}`,
    });
    await ingestEmailEvent({
      fromAddress: subject,
      eventType: "replied",
      bodyText: "Not interested, please remove me.",
      subject: "Re: Migrations without downtime",
      dedupeKey: `int:${run}:gdpr`,
    });
    const jobId = await enqueueJob({ workspaceId, type: "reply.followup", payload: { prospectId: secondProspectId } });

    const dossier = await exportSubjectData(workspaceId, `  ${subject.toUpperCase()}  `);
    expect(dossier).not.toBeNull();
    // The dossier answers for the normalised address, because that is the form the
    // lookup and the suppression entry both use. Replying with the caller's casing
    // would be a document about an address the database does not key on.
    expect(dossier!.email).toBe(subject.toLowerCase());
    expect(dossier!.contacts.map((c) => c.id)).toContain(secondContactId);
    expect(dossier!.outreach.map((m) => m.id)).toContain(sent.outreachId);
    expect(dossier!.emailEvents.some((e) => e.bodyText?.includes("remove me"))).toBe(true);
    // A queued follow-up is a future send, so the answer must disclose it — and the
    // erasure must cancel it, or "deleted" would be a lie with a send scheduled.
    expect(dossier!.pendingJobs.map((j) => j.id)).toContain(jobId);
    expect(dossier!.provenance.join(" ")).toMatch(/typed in by a person|page|manual|provider/);

    const result = await eraseSubjectData(workspaceId, subject);
    expect(result.deleted.contacts).toBe(1);
    expect(result.deleted.outreach).toBe(1);
    expect(result.deleted.jobs).toBeGreaterThanOrEqual(1);
    expect(result.deleted.emailEvents).toBeGreaterThanOrEqual(1);

    const [contactRow] = await db!.select().from(schema.contacts).where(eq(schema.contacts.id, secondContactId)).limit(1);
    expect(contactRow).toBeUndefined();
    const [jobRow] = await db!.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, jobId)).limit(1);
    expect(jobRow).toBeUndefined();
    // The stronger version of that check, and the one that matters: not merely the job
    // this test happened to enqueue by hand, but *no* queued work naming this person
    // survived - including the follow-up the reply ingest scheduled on its own.
    const stillQueued = await db!
      .select({ id: schema.jobRuns.id, payload: schema.jobRuns.payload })
      .from(schema.jobRuns)
      .where(and(eq(schema.jobRuns.workspaceId, workspaceId), eq(schema.jobRuns.status, "queued")));
    expect(
      jobRunsMentioning(stillQueued, { prospectIds: [secondProspectId], email: subject.toLowerCase() }),
    ).toEqual([]);
    // An erasure is not a blank page, and pretending otherwise would break the promise.
    // The address stays on the suppression list - the only thing standing between this
    // request and the next discovery run - so the export afterwards must show precisely
    // that and nothing else about them.
    const after = await exportSubjectData(workspaceId, subject);
    expect(after).not.toBeNull();
    expect(after!.contacts).toEqual([]);
    expect(after!.outreach).toEqual([]);
    expect(after!.emailEvents).toEqual([]);
    expect(after!.prospects).toEqual([]);
    expect(after!.channels).toEqual([]);
    expect(after!.pendingJobs).toEqual([]);
    expect(after!.suppressions.map((s) => s.reason)).toEqual(["unsubscribe"]);

    // The company record survives, detached from the person: erasing one data subject
    // must not destroy research about somebody else.
    const [detached] = await db!.select().from(schema.prospects).where(eq(schema.prospects.id, secondProspectId)).limit(1);
    expect(detached).toBeTruthy();
    expect(detached!.contactId).toBeNull();
    expect(detached!.reasons).toBeNull();

    // And the same address is not collected again afterwards — the rule that makes
    // the erasure last longer than the next discovery run.
    // Nothing is inserted to set this up: the "remove me" reply earlier in this test is
    // what put the address on the list, and that is the path that has to hold. Writing a
    // second row here would trip the unique index - which is itself the guarantee.
    expect(await addressWasForgotten(workspaceId, subject)).toBe(true);
    expect(await addressWasForgotten(`ws_other_${run}`, subject)).toBe(false);

    await db!.delete(schema.prospects).where(eq(schema.prospects.id, secondProspectId));
    await db!.delete(schema.suppressions).where(eq(schema.suppressions.email, subject));
    await db!.delete(schema.companies).where(eq(schema.companies.id, secondCompanyId));
  });

  // Kept last: it flips a global switch, so it must not overlap with any test
  // that expects autonomy to be live.
  it("the master switch holds queued work and releases it on resume", async () => {
    // Queue real work first, while the system is live.
    const queued = await ingestEmailEvent({
      fromAddress: email,
      eventType: "replied",
      bodyText: "Great — let's talk again next week.",
      subject: "Re: Zero-downtime migrations",
      dedupeKey: `int:${run}:killswitch`,
    });
    expect(queued.duplicate).toBe(false);

    // Snapshot everything queued right now rather than assuming the queue belongs to
    // this test. Earlier cases legitimately leave work behind, so what is being proved
    // is "the pause moved nothing, and the second reply created nothing" - a statement
    // about a set, not "job X is the only job in existence".
    const queuedBefore = await db!
      .select({ id: schema.jobRuns.id })
      .from(schema.jobRuns)
      .where(
        and(eq(schema.jobRuns.workspaceId, workspaceId), eq(schema.jobRuns.status, "queued")),
      )
      .orderBy(asc(schema.jobRuns.runAfter));
    expect(queuedBefore.length).toBeGreaterThan(0);
    const heldId = queuedBefore[0]!.id;
    const queuedIds = queuedBefore.map((j) => j.id);

    await setAutopilotGloballyPaused({ paused: true, reason: "integration test", actorId: userId });
    try {
      expect(await isAutopilotGloballyPaused()).toBe(true);

      // The case isAutopilotEnabled() structurally cannot cover: work that was
      // already in the queue when the lever was pulled must not go out.
      expect(await runNextJob(new Date(Date.now() + 120_000))).toBe(false);
      expect((await getJob(heldId))!.status).toBe("queued");

      // And no *new* follow-up gets queued either, so the queue cannot grow behind
      // the operator's back and all fire at once on resume.
      await ingestEmailEvent({
        fromAddress: email,
        eventType: "replied",
        bodyText: "One more thing — what does pricing look like?",
        dedupeKey: `int:${run}:killswitch2`,
      });
      const stillQueued = await db!
        .select({ id: schema.jobRuns.id })
        .from(schema.jobRuns)
        .where(
          and(eq(schema.jobRuns.workspaceId, workspaceId), eq(schema.jobRuns.status, "queued")),
        );
      expect(stillQueued.map((j) => j.id).sort()).toEqual([...queuedIds].sort());

      // Read back through the path the admin UI uses: the pause has to be
      // persisted state, not a flag living in this process.
      const persisted = await readGlobalAutonomyState();
      expect(persisted?.autopilotPaused).toBe(true);
      expect(persisted?.pausedReason).toBe("integration test");
      expect(persisted?.pausedBy).toBe(userId);
      expect(persisted?.pausedAt).toBeInstanceOf(Date);
    } finally {
      // Under no circumstances leave the platform paused for everything that
      // runs after this file, including a run that fails an assertion midway.
      await setAutopilotGloballyPaused({ paused: false });
    }

    expect(await isAutopilotGloballyPaused()).toBe(false);
    expect(await runNextJob(new Date(Date.now() + 120_000))).toBe(true);
    // Which row the worker picked is its own business, and so is whether the handler
    // then completed or failed - that is the handler's test. What this proves is that
    // releasing the lever let the queue consume work it had been holding.
    const afterResume = await db!
      .select({ id: schema.jobRuns.id, status: schema.jobRuns.status })
      .from(schema.jobRuns)
      .where(inArray(schema.jobRuns.id, queuedIds));
    expect(afterResume.some((j) => j.status !== "queued")).toBe(true);

    // Resuming clears the audit fields: "paused by X, since ..." sitting next to
    // a live system would make the switch contradict itself on screen.
    const after = await readGlobalAutonomyState();
    expect(after?.autopilotPaused).toBe(false);
    expect(after?.pausedAt).toBeNull();
    expect(after?.pausedBy).toBeNull();
  });
});
