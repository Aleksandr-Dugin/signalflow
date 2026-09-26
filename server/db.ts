import { and, count, desc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { promises as dns, type MxRecord } from "node:dns";
import { nanoid } from "nanoid";
import * as schema from "../drizzle/schema";
import { getDb } from "./_core/database";
import { env } from "./_core/env";
import type { IcpCriteria, ProspectCard, ProspectDetail, PersonalizationDraft, ContactRef } from "../shared/types";
import type { PlanId } from "../shared/plans";
import { getPlan } from "../shared/plans";
import { detectObjections } from "../shared/const";
import { ensureWorkspace } from "./services/auth";
import { isAutopilotGloballyPaused } from "./services/autonomyState";
import {
  enforceFeature,
  enforceLimit,
  getEffectivePlan,
  monthlyUsageCount,
  recordUsage,
} from "./services/entitlements";
import {
  dedupeCandidates,
  getAIProvider,
  getDiscoveryProvider,
  type CompanyCandidate,
  type QualificationResult,
  type SignalsResult,
  type ResearchResult,
} from "./services/providers";
import { scoreProspect } from "./services/opportunity";

// ── Workspace resolution ─────────────────────────────────────────────────────
export async function resolveWorkspace(userId: string): Promise<string> {
  const workspaceId = await ensureWorkspace(userId);
  if (!workspaceId) throw new Error("No workspace for user. Please sign up again.");
  return workspaceId;
}

// ── AI result cache (avoids re-paying for identical work, audit P1) ────────────
function cacheKeyFor(task: string, parts: unknown[]): string {
  const h = createHash("sha256").update(JSON.stringify({ task, parts }));
  return h.digest("hex").slice(0, 64);
}

async function aiCached<T>(opts: {
  workspaceId: string;
  task: string;
  parts: unknown[];
  ttlMs: number;
  paid: boolean;
  compute: () => Promise<T>;
}): Promise<T> {
  const db = getDb();
  const key = cacheKeyFor(opts.task, opts.parts);
  if (db) {
    const [hit] = await db.select().from(schema.aiCache).where(eq(schema.aiCache.key, key)).limit(1);
    if (hit && hit.expiresAt > new Date()) {
      if (db) {
        await db
          .insert(schema.aiRuns)
          .values({
            id: nanoid(),
            workspaceId: opts.workspaceId,
            task: opts.task,
            provider: "cache",
            status: "cached",
          })
          .catch(() => undefined);
      }
      return hit.value as T;
    }
  }
  const value = await opts.compute();
  if (db) {
    await db
      .insert(schema.aiCache)
      .values({
        key,
        value: value as object,
        task: opts.task,
        workspaceId: opts.workspaceId,
        expiresAt: new Date(Date.now() + opts.ttlMs),
      })
      .onDuplicateKeyUpdate({ set: { value: value as object, expiresAt: new Date(Date.now() + opts.ttlMs) } })
      .catch(() => undefined);
  }
  if (opts.paid) await recordUsage(opts.workspaceId, "ai_run", 1);
  return value;
}

async function ensureAiBudget(workspaceId: string, paid: boolean, need = 1): Promise<void> {
  if (!paid) return;
  const used = await monthlyUsageCount(workspaceId, "ai_run");
  await enforceLimit(workspaceId, "aiRunsPerMonth", used, need);
}

// ── Profile ───────────────────────────────────────────────────────────────────
export async function getProfile(workspaceId: string) {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(schema.profiles)
    .where(eq(schema.profiles.workspaceId, workspaceId))
    .limit(1);
  return row ?? null;
}

export async function upsertProfile(
  workspaceId: string,
  input: { serviceDescription: string; targetMarket: string; geography: string; goals?: string; websiteUrl?: string },
) {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const existing = await getProfile(workspaceId);
  if (existing) {
    await db
      .update(schema.profiles)
      .set(input)
      .where(eq(schema.profiles.id, existing.id));
    return { ...existing, ...input };
  }
  const id = nanoid();
  await db.insert(schema.profiles).values({ id, workspaceId, ...input });
  const [row] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, id)).limit(1);
  return row;
}

// ── ICP ───────────────────────────────────────────────────────────────────────
export async function generateIcpForWorkspace(
  workspaceId: string,
  input: { service: string; target: string; geography: string },
) {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const ai = getAIProvider();
  const paid = ai.name === "groq";
  await ensureAiBudget(workspaceId, paid);
  const criteria = await aiCached<IcpCriteria>({
    workspaceId,
    task: "icp",
    parts: [input.service, input.target, input.geography],
    ttlMs: env.aiCacheHours * 3600_000,
    paid,
    compute: () => ai.generateICP(input) as Promise<IcpCriteria>,
  });
  const id = nanoid();
  await db.insert(schema.icps).values({
    id,
    workspaceId,
    source: paid ? "ai" : "demo",
    criteria,
  });
  return { id, source: paid ? ("ai" as const) : ("demo" as const), criteria };
}

export async function saveManualIcp(workspaceId: string, criteria: IcpCriteria) {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const id = nanoid();
  await db.insert(schema.icps).values({ id, workspaceId, source: "manual", criteria });
  return { id, source: "manual" as const, criteria };
}

// ── Campaigns ───────────────────────────────────────────────────────────────
export async function createCampaign(
  workspaceId: string,
  input: {
    name: string;
    offerDescription: string;
    targetDescription: string;
    geography: string;
    industry: string;
    companySize?: string;
    prospectTarget?: number;
    icpId?: string | null;
  },
) {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const existing = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.workspaceId, workspaceId), inArray(schema.campaigns.status, ["draft", "discovering", "active"])));
  await enforceLimit(workspaceId, "campaigns", existing.length, 1);

  // A campaign must be bound to a real ICP so discovery is actually driven by it.
  let icpId = input.icpId ?? null;
  if (icpId) {
    const [icp] = await db
      .select({ id: schema.icps.id })
      .from(schema.icps)
      .where(and(eq(schema.icps.id, icpId), eq(schema.icps.workspaceId, workspaceId)))
      .limit(1);
    if (!icp) icpId = null;
  }

  const id = nanoid();
  await db.insert(schema.campaigns).values({
    id,
    workspaceId,
    icpId,
    name: input.name,
    offerDescription: input.offerDescription,
    targetDescription: input.targetDescription,
    geography: input.geography,
    industry: input.industry,
    companySize: input.companySize ?? "",
    prospectTarget: Math.max(1, Math.min(200, input.prospectTarget ?? 10)),
    status: "draft",
  });
  // Autonomy: if a re-check cadence is configured, kick off an initial discovery
  // job immediately (the handler will re-enqueue itself for the next tick).
  if (env.discoveryIntervalHours > 0) {
    const { enqueueJob } = await import("./services/jobs");
    await enqueueJob({
      workspaceId,
      type: "campaign.discovery",
      payload: { campaignId: id },
      runAfter: new Date(),
    }).catch((err) => console.warn("[campaign] failed to schedule discovery:", err));
  }
  const [row] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)).limit(1);
  return row;
}

export async function listCampaigns(workspaceId: string) {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.workspaceId, workspaceId))
    .orderBy(desc(schema.campaigns.createdAt));
}

async function loadCampaign(db: NonNullable<ReturnType<typeof getDb>>, workspaceId: string, campaignId: string) {
  const [campaign] = await db
    .select()
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.workspaceId, workspaceId)))
    .limit(1);
  return campaign ?? null;
}

// ── Discovery pipeline ────────────────────────────────────────────────────────
async function upsertCompany(
  db: NonNullable<ReturnType<typeof getDb>>,
  workspaceId: string,
  c: CompanyCandidate,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(schema.companies)
    .where(and(eq(schema.companies.workspaceId, workspaceId), eq(schema.companies.domain, c.domain)))
    .limit(1);
  if (existing) {
    await db
      .update(schema.companies)
      .set({ name: c.name, description: c.description, websiteUrl: c.websiteUrl, industry: c.industry ?? existing.industry, origin: c.origin })
      .where(eq(schema.companies.id, existing.id));
    return existing.id;
  }
  const id = nanoid();
  await db.insert(schema.companies).values({
    id,
    workspaceId,
    name: c.name,
    domain: c.domain,
    description: c.description,
    websiteUrl: c.websiteUrl,
    industry: c.industry ?? null,
    size: c.size ?? null,
    geography: c.geography ?? null,
    origin: c.origin,
  });
  return id;
}

async function upsertContact(
  db: NonNullable<ReturnType<typeof getDb>>,
  workspaceId: string,
  companyId: string,
  c: CompanyCandidate,
): Promise<string | null> {
  if (!c.contact?.email) return null;
  const [existing] = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.companyId, companyId), eq(schema.contacts.email, c.contact.email.toLowerCase())))
    .limit(1);
  if (existing) return existing.id;
  const id = nanoid();
  await db.insert(schema.contacts).values({
    id,
    workspaceId,
    companyId,
    name: c.contact.name,
    title: c.contact.title ?? null,
    email: c.contact.email.toLowerCase(),
    verified: false,
    sourceUrl: c.contact.sourceUrl ?? c.sourceUrl,
  });
  return id;
}

export interface DiscoveryOutcome {
  campaignId: string;
  created: number;
  qualified: number;
  origin: "live" | "demo";
  provider: string;
}

export async function runDiscovery(workspaceId: string, campaignId: string): Promise<DiscoveryOutcome> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const campaign = await loadCampaign(db, workspaceId, campaignId);
  if (!campaign) throw new Error("Campaign not found.");

  // Load the campaign's ICP (the whole point: it must drive discovery).
  let criteria: IcpCriteria | null = null;
  if (campaign.icpId) {
    const [icp] = await db.select().from(schema.icps).where(eq(schema.icps.id, campaign.icpId)).limit(1);
    criteria = (icp?.criteria as IcpCriteria) ?? null;
  }

  const plan = getPlan(await getEffectivePlan(workspaceId));
  const cap = Math.min(campaign.prospectTarget, plan.limits.prospectsPerCampaign);

  await db.update(schema.campaigns).set({ status: "discovering" }).where(eq(schema.campaigns.id, campaignId));

  const discovery = getDiscoveryProvider();
  const ai = getAIProvider();
  const paid = ai.name === "groq";
  const origin = discovery.name === "scrapegraph" ? "live" : "demo";

  const candidates = dedupeCandidates(
    await discovery.discoverProspects({
      offer: campaign.offerDescription,
      targetDescription: campaign.targetDescription,
      geography: campaign.geography,
      industry: campaign.industry,
      icp: criteria,
      prospectTarget: cap,
    }),
  ).slice(0, cap);

  const existingProspects = await db
    .select({ id: schema.prospects.id })
    .from(schema.prospects)
    .where(eq(schema.prospects.campaignId, campaignId));

  let created = 0;
  let qualified = 0;
  let errors = 0;

  for (const c of candidates) {
    if (existingProspects.length + created >= cap) break;
    try {
      const companyId = await upsertCompany(db, workspaceId, c);
      const contactId = await upsertContact(db, workspaceId, companyId, c);

      const [prospect] = await db
        .select()
        .from(schema.prospects)
        .where(and(eq(schema.prospects.campaignId, campaignId), eq(schema.prospects.companyId, companyId)))
        .limit(1);
      let prospectId: string;
      if (prospect) {
        prospectId = prospect.id;
      } else {
        prospectId = nanoid();
        await db.insert(schema.prospects).values({
          id: prospectId,
          workspaceId,
          campaignId,
          companyId,
          contactId,
          origin: c.origin,
          status: "new",
        });
        created += 1;
      }

      await ensureAiBudget(workspaceId, paid, 3);

      const qualification = await aiCached<QualificationResult>({
        workspaceId,
        task: "qualify",
        parts: [c.domain, campaign.offerDescription, criteria],
        ttlMs: env.aiCacheHours * 3600_000,
        paid,
        compute: () =>
          ai.qualifyCompany({
            offer: campaign.offerDescription,
            criteria: criteria ?? {},
            company: { name: c.name, description: c.description, industry: c.industry ?? null },
            evidence: c.evidence,
          }),
      });

      const signalsResult = await aiCached<SignalsResult>({
        workspaceId,
        task: "signals",
        parts: [c.domain, campaign.offerDescription],
        ttlMs: env.aiCacheHours * 3600_000,
        paid,
        compute: () =>
          ai.detectSignals({
            offer: campaign.offerDescription,
            company: { name: c.name, description: c.description },
            evidence: c.evidence,
          }),
      });

      const research = await aiCached<ResearchResult>({
        workspaceId,
        task: "research",
        parts: [c.domain],
        ttlMs: env.researchCacheHours * 3600_000,
        paid,
        compute: () =>
          ai.synthesizeResearch({
            company: { name: c.name, description: c.description },
            evidence: c.evidence,
          }),
      });

      // Persist signals with grounded evidence.
      for (const s of signalsResult.signals) {
        const evidenceItems = s.evidenceIndexes
          .map((i) => c.evidence[i])
          .filter(Boolean)
          .map((e) => ({ claim: e.claim, sourceUrl: e.sourceUrl }));
        const sourceUrl = evidenceItems[0]?.sourceUrl ?? c.sourceUrl;
        await db.insert(schema.signals).values({
          id: nanoid(),
          workspaceId,
          companyId,
          type: s.type,
          importance: s.importance,
          evidence: evidenceItems.length ? evidenceItems : [{ claim: s.whyNow, sourceUrl }],
          sourceUrl,
          detectedAt: new Date(),
        });
      }

      await db.insert(schema.researchResults).values({
        id: nanoid(),
        workspaceId,
        companyId,
        summary: research.summary,
        evidence: c.evidence,
        confidence: research.confidence,
        staleAfter: new Date(Date.now() + env.researchCacheHours * 3600_000),
      });
      await db
        .update(schema.companies)
        .set({ lastResearchedAt: new Date() })
        .where(eq(schema.companies.id, companyId));

      const scored = scoreProspect({
        fitScore: qualification.fitScore,
        confidence: Math.min(qualification.confidence, research.confidence),
        signals: signalsResult.signals.map((s) => ({ importance: s.importance })),
        lastActivityAt: new Date(),
        hasContact: Boolean(contactId),
        outreachEnabled: plan.features.outreach,
      });

      const status: schema.Prospect["status"] = qualification.fit && scored.qualified ? "qualified" : "disqualified";
      if (status === "qualified") qualified += 1;
      await db
        .update(schema.prospects)
        .set({
          fitScore: qualification.fitScore,
          intentScore: scored.intentScore,
          confidence: Math.min(qualification.confidence, research.confidence),
          overallScore: scored.overallScore,
          reasons: qualification.reasons,
          disqualifiers: qualification.disqualifiers,
          status,
        })
        .where(eq(schema.prospects.id, prospectId));
    } catch (err) {
      errors += 1;
      console.error("[discovery] candidate failed:", err);
    }
  }

  const finalStatus = errors > 0 && created === 0 ? "failed" : origin === "demo" ? "partial" : "active";
  await db.update(schema.campaigns).set({ status: finalStatus }).where(eq(schema.campaigns.id, campaignId));

  return { campaignId, created, qualified, origin, provider: discovery.name };
}

// ── Prospects ─────────────────────────────────────────────────────────────────
export async function listProspects(workspaceId: string, campaignId?: string | null): Promise<ProspectCard[]> {
  const db = getDb();
  if (!db) return [];
  const where = campaignId
    ? and(eq(schema.prospects.workspaceId, workspaceId), eq(schema.prospects.campaignId, campaignId))
    : eq(schema.prospects.workspaceId, workspaceId);
  const rows = await db.select().from(schema.prospects).where(where).orderBy(desc(schema.prospects.overallScore));
  return mapToCards(db, rows);
}

async function mapToCards(
  db: NonNullable<ReturnType<typeof getDb>>,
  rows: schema.Prospect[],
): Promise<ProspectCard[]> {
  if (!rows.length) return [];
  const companyIds = [...new Set(rows.map((r) => r.companyId))];
  const companies = await db.select().from(schema.companies).where(inArray(schema.companies.id, companyIds));
  const companyMap = new Map(companies.map((c) => [c.id, c]));
  const contactIds = rows.map((r) => r.contactId).filter(Boolean) as string[];
  const contacts = contactIds.length
    ? await db.select().from(schema.contacts).where(inArray(schema.contacts.id, contactIds))
    : [];
  const contactMap = new Map(contacts.map((c) => [c.id, c]));
  return rows.map((r) => {
    const company = companyMap.get(r.companyId);
    const contact = r.contactId ? contactMap.get(r.contactId) : undefined;
    return {
      id: r.id,
      campaignId: r.campaignId,
      company: company?.name ?? "Unknown",
      domain: company?.domain ?? "",
      description: company?.description ?? "",
      status: r.status,
      fitScore: r.fitScore,
      overallScore: r.overallScore,
      confidence: r.confidence,
      hasContact: Boolean(contact?.email),
      origin: r.origin,
      sourceUrl: company?.websiteUrl ?? null,
    };
  });
}

export async function getProspectDetail(workspaceId: string, prospectId: string): Promise<ProspectDetail | null> {
  const db = getDb();
  if (!db) return null;
  const [prospect] = await db
    .select()
    .from(schema.prospects)
    .where(and(eq(schema.prospects.id, prospectId), eq(schema.prospects.workspaceId, workspaceId)))
    .limit(1);
  if (!prospect) return null;
  const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, prospect.companyId)).limit(1);
  let contact = null as null | ProspectDetail["contact"];
  if (prospect.contactId) {
    const [row] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, prospect.contactId)).limit(1);
    if (row) contact = { id: row.id, name: row.name, title: row.title, email: row.email ?? "", verified: row.verified };
  }
  const signalRows = await db.select().from(schema.signals).where(eq(schema.signals.companyId, prospect.companyId));
  const researchRows = await db
    .select()
    .from(schema.researchResults)
    .where(eq(schema.researchResults.companyId, prospect.companyId))
    .orderBy(desc(schema.researchResults.createdAt))
    .limit(1);
  const [latestDraft] = await db
    .select()
    .from(schema.personalizations)
    .where(eq(schema.personalizations.prospectId, prospect.id))
    .orderBy(desc(schema.personalizations.createdAt))
    .limit(1);

  const [card] = await mapToCards(db, [prospect]);
  const evidence = (researchRows[0]?.evidence as { claim: string; sourceUrl: string; confidence?: number }[]) ?? [];
  return {
    ...card,
    contact,
    signals: signalRows.map((s) => ({
      id: s.id,
      type: s.type,
      importance: s.importance,
      evidence: ((s.evidence as { claim: string }[]) ?? []).map((e) => e.claim),
      sourceUrl: s.sourceUrl,
      detectedAt: s.detectedAt.toISOString(),
    })),
    evidence: evidence.map((e) => ({ claim: e.claim, sourceUrl: e.sourceUrl, confidence: e.confidence ?? 0 })),
    researchSummary: researchRows[0]?.summary ?? null,
    reasons: (prospect.reasons as string[]) ?? [],
    disqualifiers: (prospect.disqualifiers as string[]) ?? [],
    latestDraft: latestDraft
      ? {
          id: latestDraft.id,
          subject: latestDraft.subject,
          openingLine: latestDraft.openingLine,
          body: latestDraft.body,
          cta: latestDraft.cta,
          evidence: [],
          provider: latestDraft.provider === "groq" ? "live" : "demo",
        }
      : null,
  };
}

// ── Contact authoring (manual add/edit — unblocks outreach for real leads) ──────
// Live discovery surfaces companies but not people, so a human must be able to
// attach a decision-maker's email. Every path is workspace-scoped (IDOR-safe):
// the prospect is resolved under the caller's workspaceId before we touch it.
function isValidEmailFormat(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// MX lookup with a hard timeout so a slow resolver can't hang the request.
async function domainHasMailRecords(domain: string, timeoutMs = 3000): Promise<boolean> {
  if (!domain) return false;
  try {
    const mx = await Promise.race<MxRecord[] | null>([
      dns.resolveMx(domain),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

export async function listContacts(workspaceId: string, prospectId: string): Promise<ContactRef[]> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const [prospect] = await db
    .select({ companyId: schema.prospects.companyId })
    .from(schema.prospects)
    .where(and(eq(schema.prospects.id, prospectId), eq(schema.prospects.workspaceId, workspaceId)))
    .limit(1);
  if (!prospect) return [];
  const rows = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.companyId, prospect.companyId), eq(schema.contacts.workspaceId, workspaceId)))
    .orderBy(desc(schema.contacts.createdAt));
  return rows.map((r) => ({ id: r.id, name: r.name, title: r.title ?? null, email: r.email ?? "", verified: r.verified }));
}

export async function upsertManualContact(
  workspaceId: string,
  input: { prospectId: string; name: string; title?: string; email: string },
): Promise<ContactRef> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const email = input.email.trim().toLowerCase();
  if (!isValidEmailFormat(email)) throw new Error("Enter a valid email address.");
  const [prospect] = await db
    .select({ companyId: schema.prospects.companyId })
    .from(schema.prospects)
    .where(and(eq(schema.prospects.id, input.prospectId), eq(schema.prospects.workspaceId, workspaceId)))
    .limit(1);
  if (!prospect) throw new Error("Prospect not found.");

  const verified = await domainHasMailRecords(email.split("@")[1] ?? "");
  const name = input.name.trim();
  const title = input.title?.trim() || null;

  const [existing] = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.companyId, prospect.companyId), eq(schema.contacts.email, email)))
    .limit(1);

  let contactId: string;
  if (existing) {
    await db
      .update(schema.contacts)
      .set({ name, title, verified })
      .where(eq(schema.contacts.id, existing.id));
    contactId = existing.id;
  } else {
    contactId = nanoid();
    await db.insert(schema.contacts).values({
      id: contactId,
      workspaceId,
      companyId: prospect.companyId,
      name,
      title,
      email,
      verified,
    });
  }
  await db.update(schema.prospects).set({ contactId }).where(eq(schema.prospects.id, input.prospectId));
  return { id: contactId, name, title, email, verified };
}

// ── Personalization ─────────────────────────────────────────────────────────
export async function generatePersonalization(
  workspaceId: string,
  prospectId: string,
  opts: { history?: string; lastReplyBody?: string } = {},
): Promise<PersonalizationDraft> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  await enforceFeature(workspaceId, "personalization");
  const detail = await getProspectDetail(workspaceId, prospectId);
  if (!detail) throw new Error("Prospect not found.");
  const [campaign] = await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, detail.campaignId)).limit(1);
  const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, (await prospectCompanyId(db, prospectId)))).limit(1);

  const ai = getAIProvider();
  const paid = ai.name === "groq";
  await ensureAiBudget(workspaceId, paid);
  const evidence = detail.evidence.map((e) => ({ claim: e.claim, sourceUrl: e.sourceUrl }));
  const objections = opts.lastReplyBody ? detectObjections(opts.lastReplyBody) : [];
  const objectionNote = objections.length ? ` [prospect raised: ${objections.join(", ")} objection]` : "";
  const threadTail = opts.history ? ` Recent thread:\n${opts.history}` : "";
  const signal =
    (detail.signals[0]?.evidence[0] ?? detail.topSignal ?? null) +
    objectionNote +
    threadTail;

  const result = await aiCached({
    workspaceId,
    task: "personalization",
    parts: [prospectId, campaign?.offerDescription, signal],
    ttlMs: env.aiCacheHours * 3600_000,
    paid,
    compute: () =>
      ai.generatePersonalization({
        offer: campaign?.offerDescription ?? "",
        company: company?.name ?? detail.company,
        contactName: detail.contact?.name ?? null,
        signal,
        evidence,
      }),
  });

  // SalesGPT-style tool injection: append meeting/payment links when the
  // operator configured them and the AI didn't already include a URL.
  const withTools = appendTools(result, objections);

  const cacheKey = cacheKeyFor("personalization:v2", [prospectId, campaign?.offerDescription, signal]);
  const [existing] = await db
    .select()
    .from(schema.personalizations)
    .where(eq(schema.personalizations.cacheKey, cacheKey))
    .limit(1);
  if (existing) {
    return { id: existing.id, subject: existing.subject, openingLine: existing.openingLine, body: existing.body, cta: existing.cta, evidence: evidence.map((e) => e.claim), provider: paid ? "live" : "demo" };
  }
  const id = nanoid();
  await db.insert(schema.personalizations).values({
    id,
    workspaceId,
    prospectId,
    subject: withTools.subject,
    openingLine: withTools.openingLine,
    body: withTools.body,
    cta: withTools.cta,
    evidence,
    provider: paid ? "groq" : "mock",
    cacheKey,
  });
  return { id, subject: withTools.subject, openingLine: withTools.openingLine, body: withTools.body, cta: withTools.cta, evidence: evidence.map((e) => e.claim), provider: paid ? "live" : "demo" };
}

// Append booking / payment links when configured. Mirrors SalesGPT's Stripe
// payment-link tool (see filip-michalsky/SalesGPT). Only fires on stages where
// a link makes sense: after an objection was raised or when the reply is
// clearly positive/interested (handled by the caller's `objections` arg).
function appendTools<T extends { cta: string; body: string }>(
  draft: T,
  objections: readonly string[],
): T {
  const extras: string[] = [];
  if (env.calendlyUrl) extras.push(`Book a slot: ${env.calendlyUrl}`);
  if (env.stripePaymentLink && objections.includes("price")) {
    extras.push(`Self-serve pricing: ${env.stripePaymentLink}`);
  }
  if (!extras.length) return draft;
  const line = "\n\n" + extras.join("  \n");
  return { ...draft, cta: draft.cta + line };
}

// Return the last N messages of a prospect thread so the AI writer has real
// conversational memory (SalesGPT/B2B-SDR-agent pattern).
export async function getProspectThread(
  workspaceId: string,
  prospectId: string,
  limit = 10,
): Promise<{ direction: "inbound" | "outbound"; subject: string | null; body: string | null; at: Date }[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(schema.emailEvents)
    .where(and(eq(schema.emailEvents.workspaceId, workspaceId), eq(schema.emailEvents.prospectId, prospectId)))
    .orderBy(desc(schema.emailEvents.createdAt))
    .limit(limit);
  return rows
    .reverse()
    .map((r) => ({
      direction: r.direction,
      subject: r.subject ?? null,
      body: r.bodyText ?? null,
      at: r.createdAt ?? new Date(),
    }));
}

async function prospectCompanyId(db: NonNullable<ReturnType<typeof getDb>>, prospectId: string): Promise<string> {
  const [p] = await db.select({ companyId: schema.prospects.companyId }).from(schema.prospects).where(eq(schema.prospects.id, prospectId)).limit(1);
  return p?.companyId ?? "";
}

// ── Opportunities ───────────────────────────────────────────────────────────
export async function listOpportunities(workspaceId: string) {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(schema.opportunities)
    .where(eq(schema.opportunities.workspaceId, workspaceId))
    .orderBy(desc(schema.opportunities.updatedAt));
  const prospectIds = [...new Set(rows.map((r) => r.prospectId))];
  const prospects = prospectIds.length
    ? await db.select().from(schema.prospects).where(inArray(schema.prospects.id, prospectIds))
    : [];
  const pMap = new Map(prospects.map((p) => [p.id, p]));
  const cards = await mapToCards(db, prospects);
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  return rows.map((r) => ({
    id: r.id,
    prospectId: r.prospectId,
    stage: r.stage,
    valueCents: r.valueCents,
    notes: r.notes,
    company: cardMap.get(r.prospectId)?.company ?? pMap.get(r.prospectId)?.companyId ?? "",
    createdAt: r.createdAt?.toISOString?.() ?? new Date().toISOString(),
    updatedAt: r.updatedAt?.toISOString?.() ?? new Date().toISOString(),
  }));
}

export async function updateOpportunity(workspaceId: string, id: string, patch: { stage?: string; valueCents?: number; notes?: string }) {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const [opp] = await db
    .select()
    .from(schema.opportunities)
    .where(and(eq(schema.opportunities.id, id), eq(schema.opportunities.workspaceId, workspaceId)))
    .limit(1);
  if (!opp) throw new Error("Opportunity not found.");
  await db
    .update(schema.opportunities)
    .set({
      ...(patch.stage ? { stage: patch.stage as never } : {}),
      ...(typeof patch.valueCents === "number" ? { valueCents: patch.valueCents } : {}),
      ...(typeof patch.notes === "string" ? { notes: patch.notes } : {}),
    })
    .where(eq(schema.opportunities.id, id));
  return { ok: true };
}

export async function getWorkspacePlan(workspaceId: string): Promise<PlanId> {
  return getEffectivePlan(workspaceId);
}

// ── Autopilot ────────────────────────────────────────────────────────────────
/**
 * Per-workspace autonomy, outranked by the global kill switch. Reply ingest
 * consults this predicate before *queueing* a follow-up, so pausing prevents new
 * autonomous work from being created at all — `runNextJob()` separately holds
 * work that was already in the queue. Recurring discovery does not consult it:
 * that job emails nobody and is stopped at the worker instead.
 */
export async function isAutopilotEnabled(workspaceId: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  if (await isAutopilotGloballyPaused()) return false;
  const [ws] = await db
    .select({ autopilot: schema.workspaces.autopilot })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return Boolean(ws?.autopilot);
}

export async function setAutopilot(workspaceId: string, enabled: boolean): Promise<boolean> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  await db.update(schema.workspaces).set({ autopilot: enabled }).where(eq(schema.workspaces.id, workspaceId));
  return enabled;
}

/**
 * The two facts the Settings screen needs, kept apart on purpose.
 *
 * Returning only the *effective* state would make an operator's global pause
 * look like the workspace had switched itself off, and the owner would then
 * "fix" a toggle that was never the problem — while the platform stayed paused.
 */
export async function autopilotState(
  workspaceId: string,
): Promise<{ enabled: boolean; globalPaused: boolean }> {
  const db = getDb();
  if (!db) return { enabled: false, globalPaused: true };
  const [ws] = await db
    .select({ autopilot: schema.workspaces.autopilot })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  return { enabled: Boolean(ws?.autopilot), globalPaused: await isAutopilotGloballyPaused() };
}

// ── Admin / system health ──────────────────────────────────────────────────
// Everything here is cross-workspace and MUST only be reachable through an
// adminProcedure. Normal users never call these.

// Which integrations are wired up — booleans only, never the secret values.
export function systemStatus() {
  return {
    dbConnected: getDb() !== null,
    environment: env.nodeEnv,
    ai: env.groqApiKey ? "groq" : "mock",
    discovery: env.sgaiApiKey ? "scrapegraph-live" : "mock",
    smtp: Boolean(env.smtpHost),
    replyWebhook: Boolean(env.replyIngestSecret),
    billing: env.billingProvider || (env.plategaMerchantId && env.plategaSecret ? "platega" : "mock"),
    oauth: { google: Boolean(env.googleClientId && env.googleClientSecret), github: Boolean(env.githubClientId && env.githubClientSecret) },
    discoveryIntervalHours: env.discoveryIntervalHours,
  };
}

async function total(db: NonNullable<ReturnType<typeof getDb>>, table: any): Promise<number> {
  const [row] = await db.select({ n: count() }).from(table);
  return Number(row?.n ?? 0);
}

export async function adminOverview() {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  const [users, workspaces, campaigns, prospects, opportunities, outreachSent, repliesInbound] = await Promise.all([
    total(db, schema.users),
    total(db, schema.workspaces),
    total(db, schema.campaigns),
    total(db, schema.prospects),
    total(db, schema.opportunities),
    total(db, schema.outreachMessages),
    total(db, schema.emailEvents),
  ]);
  const jobRows = await db
    .select({ status: schema.jobRuns.status, n: count() })
    .from(schema.jobRuns)
    .groupBy(schema.jobRuns.status);
  const jobs: Record<string, number> = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const r of jobRows) jobs[r.status] = Number(r.n);
  const recentFailures = await db
    .select({ id: schema.jobRuns.id, type: schema.jobRuns.type, error: schema.jobRuns.error, attempts: schema.jobRuns.attempts, updatedAt: schema.jobRuns.updatedAt })
    .from(schema.jobRuns)
    .where(eq(schema.jobRuns.status, "failed"))
    .orderBy(desc(schema.jobRuns.updatedAt))
    .limit(5);
  return {
    counts: { users, workspaces, campaigns, prospects, opportunities, outreachSent, repliesInbound },
    jobs,
    recentFailures: recentFailures.map((f) => ({ ...f, updatedAt: f.updatedAt?.toISOString?.() ?? null })),
  };
}

export async function adminListUsers(limit = 100) {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      role: schema.users.role,
      createdAt: schema.users.createdAt,
      workspaceId: schema.workspaces.id,
      planId: schema.workspaces.planId,
      autopilot: schema.workspaces.autopilot,
    })
    .from(schema.users)
    .leftJoin(schema.workspaces, eq(schema.workspaces.ownerId, schema.users.id))
    .orderBy(desc(schema.users.createdAt))
    .limit(Math.min(500, Math.max(1, limit)));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt?.toISOString?.() ?? null }));
}

export async function adminListWorkspaces(limit = 100) {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select({
      id: schema.workspaces.id,
      name: schema.workspaces.name,
      slug: schema.workspaces.slug,
      planId: schema.workspaces.planId,
      autopilot: schema.workspaces.autopilot,
      ownerEmail: schema.users.email,
      createdAt: schema.workspaces.createdAt,
    })
    .from(schema.workspaces)
    .leftJoin(schema.users, eq(schema.users.id, schema.workspaces.ownerId))
    .orderBy(desc(schema.workspaces.createdAt))
    .limit(Math.min(500, Math.max(1, limit)));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt?.toISOString?.() ?? null }));
}

export async function adminRecentJobs(limit = 50) {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(schema.jobRuns)
    .orderBy(desc(schema.jobRuns.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspaceId,
    type: r.type,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    createdAt: r.createdAt?.toISOString?.() ?? null,
    updatedAt: r.updatedAt?.toISOString?.() ?? null,
  }));
}

export async function adminSetRole(actorUserId: string, targetUserId: string, role: "user" | "admin") {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");
  // Guard: an admin cannot change their own role (prevents self-lockout / last-admin removal).
  if (actorUserId === targetUserId) throw new Error("You cannot change your own role.");
  await db.update(schema.users).set({ role }).where(eq(schema.users.id, targetUserId));
  return { ok: true };
}
