// Data-subject rights, implemented as two operations rather than as a policy
// promise: produce everything this deployment holds about one email address, and
// delete it. The privacy policy is only credible because these exist — "write to us
// and we will look through the database" is a thirty-day project, while a subject
// that is one search away can be answered in the conversation that requests it.
//
// Scope rule used throughout: a row is included when it describes the *person*, not
// when it describes the company. Company-level research (industry, size, signals,
// research summaries) is not the data subject's personal data and is not touched —
// deleting it would destroy someone else's record to satisfy this one request, and
// "we also removed the company" would be a false claim about what erasure did.
import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";

/** Everything a request about one address can lawfully ask to see. */
export interface SubjectDossier {
  email: string;
  generatedAt: string;
  contacts: {
    id: string;
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
    socialUrl: string | null;
    verified: boolean;
    origin: string;
    sourceUrl: string | null;
    createdAt: string | null;
  }[];
  prospects: {
    id: string;
    campaignId: string;
    companyId: string;
    status: string;
    fitScore: number | null;
    intentScore: number | null;
    overallScore: number | null;
    confidence: number | null;
    reasons: unknown;
    disqualifiers: unknown;
    createdAt: string | null;
  }[];
  outreach: {
    id: string;
    subject: string;
    body: string;
    channel: string;
    status: string;
    providerMessageId: string | null;
    sentAt: string | null;
    createdAt: string | null;
  }[];
  emailEvents: {
    id: string;
    eventType: string;
    direction: string;
    fromAddress: string | null;
    toAddress: string | null;
    subject: string | null;
    bodyText: string | null;
    classification: string | null;
    metadata: unknown;
    createdAt: string | null;
  }[];
  personalizations: {
    id: string;
    subject: string;
    openingLine: string;
    body: string;
    cta: string;
    provider: string | null;
    createdAt: string | null;
  }[];
  opportunities: {
    id: string;
    stage: string;
    valueCents: number;
    notes: string | null;
    createdAt: string | null;
  }[];
  suppressions: { id: string; reason: string; createdAt: string | null }[];
  /**
   * Non-email channel permissions held about this person. Disclosed because a chat id
   * we may write to is personal data like any other, and erased because a record that
   * authorises future contact must not outlive the request that ended the relationship.
   */
  channels: {
    id: string;
    channel: string;
    externalId: string;
    handle: string | null;
    consentSource: string;
    consentAt: string | null;
    revokedAt: string | null;
    lastInboundAt: string | null;
  }[];
  /** Messages we sent on those channels, addressed by platform id rather than email. */
  channelMessages: {
    id: string;
    channel: string;
    recipient: string;
    body: string;
    status: string;
    sentAt: string | null;
  }[];
  /** Queued or in-flight jobs that would still act on this person. */
  pendingJobs: { id: string; type: string; status: string; payload: unknown }[];
  /**
   * Where each category came from, in the subject's own terms. An access request
   * answered as a bare row dump leaves them to work out who decided to mail them.
   */
  provenance: string[];
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * Has this address been suppressed in this workspace? Owned by this module so the
 * rule "a person who asked to be forgotten is not collected again" has one home: the
 * send path, the automated contact write and the erasure itself all have to agree,
 * and a rule duplicated in three places is a rule one of them will forget.
 */
export async function addressWasForgotten(workspaceId: string, email: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const lowered = normalize(email);
  if (!lowered) return false;
  const [row] = await db
    .select({ id: schema.suppressions.id })
    .from(schema.suppressions)
    .where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.email, lowered)))
    .limit(1);
  return Boolean(row);
}

/**
 * Addresses are written lowercased by every path that creates one, so an exact
 * match is the correct — and the only index-usable — predicate. Trimmed here because
 * a request typed by hand is allowed to have a stray space and still be honoured.
 */
function normalize(email: string): string {
  return email.trim().toLowerCase();
}

async function collect(db: NonNullable<ReturnType<typeof getDb>>, workspaceId: string, email: string) {
  const contacts = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.workspaceId, workspaceId), eq(schema.contacts.email, email)));
  const contactIds = contacts.map((c) => c.id);
  const prospects = contactIds.length
    ? await db
        .select()
        .from(schema.prospects)
        .where(inArray(schema.prospects.contactId, contactIds))
    : [];
  const prospectIds = prospects.map((p) => p.id);

  const [outreach, events, personalizations, opportunities, suppressionRows, jobs, channels, channelOutreach] = await Promise.all([
    db.select().from(schema.outreachMessages).where(
      and(eq(schema.outreachMessages.workspaceId, workspaceId), eq(schema.outreachMessages.recipientEmail, email)),
    ),
    db.select().from(schema.emailEvents).where(
      and(
        eq(schema.emailEvents.workspaceId, workspaceId),
        or(eq(schema.emailEvents.fromAddress, email), eq(schema.emailEvents.toAddress, email)),
      ),
    ),
    prospectIds.length
      ? db.select().from(schema.personalizations).where(inArray(schema.personalizations.prospectId, prospectIds))
      : Promise.resolve([]),
    prospectIds.length
      ? db.select().from(schema.opportunities).where(inArray(schema.opportunities.prospectId, prospectIds))
      : Promise.resolve([]),
    db
      .select()
      .from(schema.suppressions)
      .where(and(eq(schema.suppressions.workspaceId, workspaceId), eq(schema.suppressions.email, email))),
    // Payloads are JSON of our own shape, so the ones that name this person are
    // found by reading them, not by pattern-matching a column.
    db
      .select()
      .from(schema.jobRuns)
      .where(
        and(
          eq(schema.jobRuns.workspaceId, workspaceId),
          inArray(schema.jobRuns.status, ["queued", "running"]),
        ),
      ),
    // A Telegram or WhatsApp conversation is addressed to a platform id, so the email
    // predicate above never sees it. It is reached through the prospect instead, which
    // is exactly how it was created — and an erasure that quietly skipped those rows
    // would leave both the messages and the permission to write again.
    prospectIds.length
      ? db.select().from(schema.channelIdentities).where(inArray(schema.channelIdentities.prospectId, prospectIds))
      : Promise.resolve([]),
    prospectIds.length
      ? db
          .select()
          .from(schema.outreachMessages)
          .where(
            and(
              eq(schema.outreachMessages.workspaceId, workspaceId),
              inArray(schema.outreachMessages.prospectId, prospectIds),
              notInArray(schema.outreachMessages.channel, ["email"]),
            ),
          )
      : Promise.resolve([]),
  ]);

  const jobIds = new Set(jobRunsMentioning(jobs, { prospectIds, email }));

  return {
    contacts,
    prospects,
    outreach,
    events,
    personalizations,
    opportunities,
    suppressionRows,
    jobs,
    jobIds,
    channels,
    channelOutreach,
  };
}

/**
 * Which queued/in-flight jobs are about this person. A follow-up that is waiting to
 * run is the most dangerous category in an erasure: everything else is history, but
 * that row sends mail tomorrow. Matched by prospect id *and* by the address itself,
 * because a payload carries the reply body as free text too.
 */
export function jobRunsMentioning(
  jobs: { id: string; payload: unknown }[],
  subject: { prospectIds: string[]; email: string },
): string[] {
  const ids = new Set(subject.prospectIds);
  return jobs
    .filter((job) => {
      const payload = job.payload;
      if (payload && typeof payload === "object") {
        const p = payload as { prospectId?: unknown };
        if (typeof p.prospectId === "string" && ids.has(p.prospectId)) return true;
      }
      try {
        return JSON.stringify(payload ?? "").toLowerCase().includes(subject.email);
      } catch {
        return false;
      }
    })
    .map((job) => job.id);
}

export async function exportSubjectData(
  workspaceId: string,
  rawEmail: string,
): Promise<SubjectDossier | null> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const email = normalize(rawEmail);
  const found = await collect(db, workspaceId, email);
  if (
    !found.contacts.length &&
    !found.outreach.length &&
    !found.events.length &&
    !found.channels.length &&
    !found.suppressionRows.length
  ) {
    return null;
  }
  const origins = [...new Set(found.contacts.map((c) => c.origin ?? "manual"))];
  const sourceUrls = [...new Set(found.contacts.map((c) => c.sourceUrl).filter((u): u is string => Boolean(u)))];

  return {
    email,
    generatedAt: new Date().toISOString(),
    contacts: found.contacts.map((c) => ({
      id: c.id,
      name: c.name,
      title: c.title ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
      socialUrl: c.socialUrl ?? null,
      verified: c.verified,
      origin: c.origin ?? "manual",
      sourceUrl: c.sourceUrl ?? null,
      createdAt: iso(c.createdAt),
    })),
    prospects: found.prospects.map((p) => ({
      id: p.id,
      campaignId: p.campaignId,
      companyId: p.companyId,
      status: p.status,
      fitScore: p.fitScore ?? null,
      intentScore: p.intentScore ?? null,
      overallScore: p.overallScore ?? null,
      confidence: p.confidence ?? null,
      reasons: p.reasons ?? null,
      disqualifiers: p.disqualifiers ?? null,
      createdAt: iso(p.createdAt),
    })),
    outreach: found.outreach.map((m) => ({
      id: m.id,
      subject: m.subject,
      body: m.body,
      channel: m.channel,
      status: m.status,
      providerMessageId: m.providerMessageId ?? null,
      sentAt: iso(m.sentAt),
      createdAt: iso(m.createdAt),
    })),
    emailEvents: found.events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      direction: e.direction,
      fromAddress: e.fromAddress ?? null,
      toAddress: e.toAddress ?? null,
      subject: e.subject ?? null,
      bodyText: e.bodyText ?? null,
      classification: e.classification ?? null,
      metadata: e.metadata ?? null,
      createdAt: iso(e.createdAt),
    })),
    personalizations: found.personalizations.map((d) => ({
      id: d.id,
      subject: d.subject,
      openingLine: d.openingLine,
      body: d.body,
      cta: d.cta,
      provider: d.provider ?? null,
      createdAt: iso(d.createdAt),
    })),
    opportunities: found.opportunities.map((o) => ({
      id: o.id,
      stage: o.stage,
      valueCents: o.valueCents,
      notes: o.notes ?? null,
      createdAt: iso(o.createdAt),
    })),
    channels: found.channels.map((c) => ({
      id: c.id,
      channel: c.channel,
      externalId: c.externalId,
      handle: c.handle ?? null,
      consentSource: c.consentSource,
      consentAt: iso(c.consentAt),
      revokedAt: iso(c.revokedAt),
      lastInboundAt: iso(c.lastInboundAt),
    })),
    channelMessages: found.channelOutreach.map((m) => ({
      id: m.id,
      channel: m.channel,
      recipient: m.recipientEmail,
      body: m.body,
      status: m.status,
      sentAt: iso(m.sentAt),
    })),
    suppressions: found.suppressionRows.map((s) => ({
      id: s.id,
      reason: s.reason,
      createdAt: iso(s.createdAt),
    })),
    pendingJobs: found.jobs
      .filter((j) => found.jobIds.has(j.id))
      .map((j) => ({ id: j.id, type: j.type, status: j.status, payload: j.payload ?? null })),
    provenance: [
      origins.length
        ? `Contact records present, sourced as: ${origins.join(", ")} ("page" = printed on the company's own site, "provider" = bought from a data vendor, "manual" = typed in by a person at the sender).`
        : "No contact record is held for this address; any data below was recorded against a message or a reply.",
      sourceUrls.length
        ? `Source pages/documents kept for these records: ${sourceUrls.join(", ")}.`
        : "No source URL was recorded, so the address was entered by hand.",
      found.events.some((e) => e.direction === "inbound")
        ? "The original text of your inbound replies is stored verbatim, as sent, for audit."
        : "No inbound reply text is stored.",
      found.channels.length
        ? `We also hold a chat identity on ${[...new Set(found.channels.map((c) => c.channel))].join(" and ")}, which you started yourself on ${found.channels
            .map((c) => iso(c.consentAt))
            .filter(Boolean)
            .join(", ")}. That record is what allows messages on that channel, and it is deleted with the rest of this answer.`
        : "No non-email channel identity is held about you.",
      "Company-level research (industry, size, public signals) is held about the organisation, not about you, and is outside this answer.",
    ],
  };
}

export interface ErasureResult {
  email: string;
  deleted: {
    contacts: number;
    outreach: number;
    emailEvents: number;
    personalizations: number;
    opportunities: number;
    jobs: number;
    channels: number;
    channelMessages: number;
  };
  /** Rows deliberately left in place, with the reason shown to the operator. */
  retained: { what: string; why: string }[];
}

/**
 * Erase a person. Two things make this more than a DELETE: order matters (child rows
 * are removed before the rows that reference them, and no FK cascade is trusted,
 * because a database built from the loose SQL files in drizzle/ may not carry them),
 * and one record is *kept* on purpose — the suppression entry. Deleting the fact that
 * someone objected would mean the next campaign mails them again, so Article 17(3)(b)
 * (keeping it is necessary to comply with a legal obligation not to contact them) is
 * the only defensible answer, and it is stated in the result rather than hidden.
 */
export async function eraseSubjectData(workspaceId: string, rawEmail: string): Promise<ErasureResult> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const email = normalize(rawEmail);
  const found = await collect(db, workspaceId, email);
  const prospectIds = found.prospects.map((p) => p.id);
  const contactIds = found.contacts.map((c) => c.id);
  const eventIds = found.events.map((e) => e.id);
  const outreachIds = found.outreach.map((m) => m.id);
  const personalizationIds = found.personalizations.map((d) => d.id);
  const opportunityIds = found.opportunities.map((o) => o.id);
  const jobIds = [...found.jobIds];
  const channelIds = found.channels.map((c) => c.id);
  const channelMessageIds = found.channelOutreach.map((m) => m.id);

  // Events first: they reference both outreach rows and prospect rows.
  if (eventIds.length) {
    await db.delete(schema.emailEvents).where(inArray(schema.emailEvents.id, eventIds));
  }
  if (jobIds.length) {
    await db.delete(schema.jobRuns).where(inArray(schema.jobRuns.id, jobIds));
  }
  // The permission to write on Telegram/WhatsApp goes before the messages it
  // authorised and before the prospect it belongs to. Nothing here is left behind: a
  // surviving identity row would be a licence to contact this person again.
  if (channelMessageIds.length) {
    await db.delete(schema.outreachMessages).where(inArray(schema.outreachMessages.id, channelMessageIds));
  }
  if (channelIds.length) {
    await db.delete(schema.channelIdentities).where(inArray(schema.channelIdentities.id, channelIds));
  }
  if (outreachIds.length) {
    await db.delete(schema.outreachMessages).where(inArray(schema.outreachMessages.id, outreachIds));
  }
  if (personalizationIds.length) {
    await db.delete(schema.personalizations).where(inArray(schema.personalizations.id, personalizationIds));
  }
  if (opportunityIds.length) {
    await db.delete(schema.opportunities).where(inArray(schema.opportunities.id, opportunityIds));
  }
  // The prospect row is the company's place in a campaign, so it survives — but it
  // must stop pointing at a person who asked to be forgotten, and stop carrying the
  // scores that were only ever an assessment of them.
  if (prospectIds.length) {
    await db
      .update(schema.prospects)
      .set({ contactId: null, reasons: null, disqualifiers: null })
      .where(inArray(schema.prospects.id, prospectIds));
  }
  if (contactIds.length) {
    await db.delete(schema.contacts).where(inArray(schema.contacts.id, contactIds));
  }

  const retained: ErasureResult["retained"] = [];
  if (found.suppressionRows.length) {
    retained.push({
      what: `${found.suppressionRows.length} suppression entry(ies) for ${email}`,
      why: "Kept because forgetting an opt-out is what causes the next campaign to mail this address again. It stores the address, the reason and the date, and nothing else.",
    });
  }
  if (prospectIds.length) {
    retained.push({
      what: `${prospectIds.length} prospect row(s) and the company record behind them`,
      why: "Company-level research is not this person's data. Their contact id, scoring reasons and disqualifiers have been removed from it.",
    });
  }

  return {
    email,
    deleted: {
      contacts: contactIds.length,
      outreach: outreachIds.length,
      emailEvents: eventIds.length,
      personalizations: personalizationIds.length,
      opportunities: opportunityIds.length,
      jobs: jobIds.length,
      channels: channelIds.length,
      channelMessages: channelMessageIds.length,
    },
    retained,
  };
}
