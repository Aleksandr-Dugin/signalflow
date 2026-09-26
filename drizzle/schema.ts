import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const ts = (name: string) =>
  timestamp(name, { mode: "date" })
    .defaultNow()
    .$onUpdateFn(() => new Date());

// ── Auth ────────────────────────────────────────────────────────────────────
export const users = mysqlTable(
  "users",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    email: varchar("email", { length: 320 }),
    name: varchar("name", { length: 200 }).notNull().default(""),
    passwordHash: varchar("password_hash", { length: 255 }),
    avatarUrl: varchar("avatar_url", { length: 1024 }),
    role: mysqlEnum("role", ["user", "admin"]).notNull().default("user"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    emailIdx: uniqueIndex("users_email_unique").on(t.email),
  }),
);

// Linked OAuth identities (Google / GitHub / local). A user can have several.
export const oauthAccounts = mysqlTable(
  "oauth_accounts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: mysqlEnum("provider", ["google", "github", "email"]).notNull(),
    providerAccountId: varchar("provider_account_id", { length: 191 }).notNull(),
    email: varchar("email", { length: 320 }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    providerIdx: uniqueIndex("oauth_provider_unique").on(t.provider, t.providerAccountId),
    userIdx: index("oauth_user_idx").on(t.userId),
  }),
);

// Server-side sessions so logout can actually revoke tokens (audit P1 fix).
export const sessions = mysqlTable(
  "sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(), // jti embedded in the JWT
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userAgent: varchar("user_agent", { length: 512 }),
    ip: varchar("ip", { length: 64 }),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { mode: "date" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    userIdx: index("session_user_idx").on(t.userId),
    expiresIdx: index("session_expires_idx").on(t.expiresAt),
  }),
);

export const verifications = mysqlTable(
  "verifications",
  {
    identifier: varchar("identifier", { length: 191 }).notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.identifier] }),
  }),
);

// ── Workspace / tenancy ──────────────────────────────────────────────────────
export const workspaces = mysqlTable(
  "workspaces",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 200 }).notNull(),
    ownerId: varchar("owner_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: mysqlEnum("plan_id", ["free", "starter", "pro", "agency"])
      .notNull()
      .default("free"),
    // Autonomy switch (docs/ai-agents.md). When true the reply pipeline may
    // enqueue AI follow-ups and scheduled discovery without a human click.
    autopilot: boolean("autopilot").notNull().default(false),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    slugIdx: uniqueIndex("workspaces_slug_unique").on(t.slug),
  }),
);

export const workspaceMembers = mysqlTable(
  "workspace_members",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 36 })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", ["owner", "member"]).notNull().default("member"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    uniqueMember: uniqueIndex("workspace_members_unique").on(t.workspaceId, t.userId),
  }),
);

export const profiles = mysqlTable(
  "profiles",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serviceDescription: text("service_description").notNull().default(""),
    targetMarket: text("target_market").notNull().default(""),
    geography: text("geography").notNull().default(""),
    goals: text("goals").notNull().default(""),
    websiteUrl: varchar("website_url", { length: 1024 }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    workspaceIdx: uniqueIndex("profiles_workspace_unique").on(t.workspaceId),
  }),
);

// ── ICP ──────────────────────────────────────────────────────────────────────
export const icps = mysqlTable(
  "icps",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: mysqlEnum("source", ["ai", "manual", "demo"]).notNull().default("manual"),
    criteria: json("criteria").notNull(),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    workspaceIdx: index("icps_workspace_idx").on(t.workspaceId),
  }),
);

// ── Campaign ─────────────────────────────────────────────────────────────────
export const campaigns = mysqlTable(
  "campaigns",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // A campaign references a persisted ICP (audit P0 fix: ICP drives discovery).
    icpId: varchar("icp_id", { length: 36 }).references(() => icps.id, { onDelete: "set null" }),
    name: varchar("name", { length: 200 }).notNull(),
    offerDescription: text("offer_description").notNull().default(""),
    targetDescription: text("target_description").notNull().default(""),
    geography: text("geography").notNull().default(""),
    industry: varchar("industry", { length: 200 }).notNull().default(""),
    companySize: varchar("company_size", { length: 120 }).notNull().default(""),
    signalPreferences: json("signal_preferences"),
    prospectTarget: int("prospect_target").notNull().default(10),
    status: mysqlEnum("status", [
      "draft",
      "discovering",
      "active",
      "completed",
      "partial",
      "failed",
      "archived",
    ])
      .notNull()
      .default("draft"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    workspaceIdx: index("campaigns_workspace_idx").on(t.workspaceId),
    icpIdx: index("campaigns_icp_idx").on(t.icpId),
  }),
);

// ── Companies (workspace-scoped: fixes cross-workspace bleed, audit P1) ──────
export const companies = mysqlTable(
  "companies",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    domain: varchar("domain", { length: 255 }),
    description: text("description"),
    websiteUrl: varchar("website_url", { length: 1024 }),
    industry: varchar("industry", { length: 200 }),
    size: varchar("size", { length: 120 }),
    geography: varchar("geography", { length: 200 }),
    // Persisted provenance so demo rows can NEVER masquerade as live (audit P0).
    origin: mysqlEnum("origin", ["live", "demo"]).notNull().default("live"),
    lastResearchedAt: timestamp("last_researched_at", { mode: "date" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    domainIdx: uniqueIndex("companies_workspace_domain_unique").on(t.workspaceId, t.domain),
    nameIdx: index("companies_workspace_name_idx").on(t.workspaceId, t.name),
  }),
);

// ── Contacts (real now — outreach needs a recipient, audit P0) ────────────────
export const contacts = mysqlTable(
  "contacts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    companyId: varchar("company_id", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull().default(""),
    title: varchar("title", { length: 200 }),
    email: varchar("email", { length: 320 }),
    verified: boolean("verified").notNull().default(false),
    sourceUrl: varchar("source_url", { length: 1024 }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    companyIdx: index("contacts_company_idx").on(t.companyId),
    emailIdx: index("contacts_email_idx").on(t.email),
  }),
);

// ── Prospects ─────────────────────────────────────────────────────────────────
export const prospects = mysqlTable(
  "prospects",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: varchar("campaign_id", { length: 36 })
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    companyId: varchar("company_id", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    contactId: varchar("contact_id", { length: 36 }).references(() => contacts.id, {
      onDelete: "set null",
    }),
    status: mysqlEnum(
      "status",
      [
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
      ],
    )
      .notNull()
      .default("new"),
    fitScore: int("fit_score").notNull().default(0),
    intentScore: int("intent_score").notNull().default(0),
    confidence: int("confidence").notNull().default(0),
    overallScore: int("overall_score").notNull().default(0),
    reasons: json("reasons"),
    disqualifiers: json("disqualifiers"),
    origin: mysqlEnum("origin", ["live", "demo"]).notNull().default("live"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    campaignCompanyUnique: uniqueIndex("prospects_campaign_company_unique").on(
      t.campaignId,
      t.companyId,
    ),
    workspaceIdx: index("prospects_workspace_idx").on(t.workspaceId),
    scoreIdx: index("prospects_score_idx").on(t.overallScore),
  }),
);

// ── Signals ───────────────────────────────────────────────────────────────────
export const signals = mysqlTable(
  "signals",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: varchar("company_id", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 120 }).notNull(),
    importance: int("importance").notNull().default(50),
    evidence: json("evidence").notNull(),
    sourceUrl: varchar("source_url", { length: 1024 }).notNull(),
    detectedAt: timestamp("detected_at", { mode: "date" }).notNull().defaultNow(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    companyIdx: index("signals_company_idx").on(t.companyId),
    workspaceIdx: index("signals_workspace_idx").on(t.workspaceId),
  }),
);

// ── Research ──────────────────────────────────────────────────────────────────
export const researchResults = mysqlTable(
  "research_results",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    companyId: varchar("company_id", { length: 36 })
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    evidence: json("evidence").notNull(),
    confidence: int("confidence").notNull().default(0),
    staleAfter: timestamp("stale_after", { mode: "date" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    companyIdx: index("research_company_idx").on(t.companyId),
    workspaceIdx: index("research_workspace_idx").on(t.workspaceId),
  }),
);

// ── Personalization ─────────────────────────────────────────────────────────
export const personalizations = mysqlTable(
  "personalizations",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: varchar("prospect_id", { length: 36 })
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    subject: varchar("subject", { length: 500 }).notNull().default(""),
    openingLine: text("opening_line").notNull().default(""),
    body: text("body").notNull().default(""),
    cta: text("cta").notNull().default(""),
    evidence: json("evidence"),
    provider: mysqlEnum("provider", ["groq", "mock"]).notNull().default("groq"),
    // cache key so identical personalization is not re-paid (audit P1)
    cacheKey: varchar("cache_key", { length: 64 }),
    approvedAt: timestamp("approved_at", { mode: "date" }),
    createdAt: ts("created_at"),
  },
  (t) => ({
    prospectIdx: index("personalization_prospect_idx").on(t.prospectId),
    cacheIdx: uniqueIndex("personalization_cache_unique").on(t.cacheKey),
  }),
);

// ── Outreach ────────────────────────────────────────────────────────────────
export const outreachMessages = mysqlTable(
  "outreach_messages",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: varchar("prospect_id", { length: 36 })
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    recipientEmail: varchar("recipient_email", { length: 320 }).notNull(),
    recipientName: varchar("recipient_name", { length: 200 }),
    subject: varchar("subject", { length: 500 }).notNull().default(""),
    body: text("body").notNull().default(""),
    status: mysqlEnum("status", [
      "draft",
      "approved",
      "queued",
      "sending",
      "sent",
      "delivered",
      "bounced",
      "replied",
      "suppressed",
      "failed",
      "cancelled",
    ])
      .notNull()
      .default("draft"),
    personalizationId: varchar("personalization_id", { length: 36 }).references(
      () => personalizations.id,
      { onDelete: "set null" },
    ),
    idempotencyKey: varchar("idempotency_key", { length: 64 }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    error: text("error"),
    referenceId: varchar("reference_id", { length: 64 }),
    approvedAt: timestamp("approved_at", { mode: "date" }),
    sentAt: timestamp("sent_at", { mode: "date" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    idempotencyIdx: uniqueIndex("outreach_idempotency_unique").on(t.workspaceId, t.idempotencyKey),
    prospectIdx: index("outreach_prospect_idx").on(t.prospectId),
    referenceIdx: index("outreach_reference_idx").on(t.referenceId),
  }),
);

// ── Email events / replies (full original body preserved, audit P1) ───────────
// Lifecycle log. Beyond mail traffic it also carries funnel evidence written by
// the conversion callbacks (docs/ai-agents.md):
//   clicked   - prospect followed a tracked CTA link (see services/cta.ts)
//   converted - an external system confirmed an outcome; `classification` keeps
//               the provider event name (calendly.invitee.created, stripe.
//               checkout.session.completed, ...) and `metadata` the raw payload
export const emailEvents = mysqlTable(
  "email_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    outreachId: varchar("outreach_id", { length: 36 }).references(() => outreachMessages.id, {
      onDelete: "cascade",
    }),
    prospectId: varchar("prospect_id", { length: 36 }).references(() => prospects.id, {
      onDelete: "cascade",
    }),
    eventType: mysqlEnum("eventType", [
      "sent",
      "delivered",
      "bounced",
      "opened",
      "clicked",
      "replied",
      "converted",
      "unsubscribed",
      "failed",
    ]).notNull(),
    direction: mysqlEnum("direction", ["outbound", "inbound"]).notNull().default("outbound"),
    fromAddress: varchar("from_address", { length: 320 }),
    toAddress: varchar("to_address", { length: 320 }),
    subject: varchar("subject", { length: 500 }),
    bodyText: text("body_text"),
    classification: varchar("classification", { length: 40 }),
    dedupeKey: varchar("dedupe_key", { length: 128 }),
    metadata: json("metadata"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    dedupeIdx: uniqueIndex("email_events_dedupe_unique").on(t.workspaceId, t.dedupeKey),
    prospectIdx: index("email_events_prospect_idx").on(t.prospectId),
  }),
);

// ── Opportunities (real entity now, audit P0) ─────────────────────────────────
export const opportunities = mysqlTable(
  "opportunities",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    prospectId: varchar("prospect_id", { length: 36 })
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    stage: mysqlEnum("stage", [
      "open",
      "responded",
      "meeting_booked",
      "negotiating",
      "won",
      "lost",
    ])
      .notNull()
      .default("open"),
    valueCents: int("value_cents").notNull().default(0),
    notes: text("notes"),
    sourceReplyId: varchar("source_reply_id", { length: 36 }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    prospectIdx: index("opportunities_prospect_idx").on(t.prospectId),
    workspaceIdx: index("opportunities_workspace_idx").on(t.workspaceId),
  }),
);

// ── Suppressions ──────────────────────────────────────────────────────────────
export const suppressions = mysqlTable(
  "suppressions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 320 }),
    domain: varchar("domain", { length: 255 }),
    reason: varchar("reason", { length: 120 }).notNull().default("unsubscribe"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    emailIdx: uniqueIndex("suppressions_email_unique").on(t.workspaceId, t.email),
  }),
);

// ── AI cache & observability ────────────────────────────────────────────────
export const aiCache = mysqlTable(
  "ai_cache",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    value: json("value").notNull(),
    task: varchar("task", { length: 60 }).notNull(),
    workspaceId: varchar("workspace_id", { length: 36 }),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    expiresIdx: index("ai_cache_expires_idx").on(t.expiresAt),
  }),
);

export const aiRuns = mysqlTable(
  "ai_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    campaignId: varchar("campaign_id", { length: 36 }),
    prospectId: varchar("prospect_id", { length: 36 }),
    task: varchar("task", { length: 60 }).notNull(),
    provider: varchar("provider", { length: 40 }).notNull(),
    model: varchar("model", { length: 80 }),
    status: mysqlEnum("status", ["ok", "error", "cached"]).notNull(),
    latencyMs: int("latency_ms"),
    promptTokens: int("prompt_tokens"),
    completionTokens: int("completion_tokens"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    workspaceIdx: index("ai_runs_workspace_idx").on(t.workspaceId),
    createdIdx: index("ai_runs_created_idx").on(t.createdAt),
  }),
);

export const jobRuns = mysqlTable(
  "job_runs",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 60 }).notNull(),
    status: mysqlEnum("status", ["queued", "running", "completed", "failed"])
      .notNull()
      .default("queued"),
    payload: json("payload"),
    result: json("result"),
    error: text("error"),
    attempts: int("attempts").notNull().default(0),
    runAfter: timestamp("run_after", { mode: "date" }).defaultNow(),
    claimedAt: timestamp("claimed_at", { mode: "date" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    statusIdx: index("job_runs_status_idx").on(t.status, t.runAfter),
  }),
);

// ── Usage (for entitlement accounting) ────────────────────────────────────────
export const usageEvents = mysqlTable(
  "usage_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 60 }).notNull(), // ai_run | outreach_sent | research | ...
    quantity: int("quantity").notNull().default(1),
    period: varchar("period", { length: 7 }).notNull(), // YYYY-MM
    createdAt: ts("created_at"),
  },
  (t) => ({
    periodIdx: index("usage_workspace_period_idx").on(t.workspaceId, t.kind, t.period),
  }),
);

// ── Billing ─────────────────────────────────────────────────────────────────
export const subscriptions = mysqlTable(
  "subscriptions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: mysqlEnum("provider", ["platega", "mock"]).notNull().default("mock"),
    planId: mysqlEnum("plan_id", ["free", "starter", "pro", "agency"]).notNull().default("free"),
    status: mysqlEnum("status", [
      "incomplete",
      "active",
      "past_due",
      "canceled",
      "expired",
    ])
      .notNull()
      .default("incomplete"),
    providerSubscriptionId: varchar("provider_subscription_id", { length: 191 }),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    amountCents: int("amount_cents").notNull().default(0),
    interval: varchar("interval", { length: 16 }).notNull().default("month"),
    currentPeriodStart: timestamp("current_period_start", { mode: "date" }),
    currentPeriodEnd: timestamp("current_period_end", { mode: "date" }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { mode: "date" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => ({
    workspaceIdx: uniqueIndex("subscriptions_workspace_unique").on(t.workspaceId),
    providerSubIdx: index("subscriptions_provider_idx").on(t.providerSubscriptionId),
  }),
);

export const payments = mysqlTable(
  "payments",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    workspaceId: varchar("workspace_id", { length: 36 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: varchar("subscription_id", { length: 36 }).references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    provider: mysqlEnum("provider", ["platega", "mock"]).notNull().default("mock"),
    providerTransactionId: varchar("provider_transaction_id", { length: 191 }),
    amountCents: int("amount_cents").notNull().default(0),
    currency: varchar("currency", { length: 8 }).notNull().default("USD"),
    status: mysqlEnum("status", ["pending", "succeeded", "failed", "refunded", "chargeback"])
      .notNull()
      .default("pending"),
    kind: mysqlEnum("kind", ["initial", "recurring"]).notNull().default("initial"),
    rawProviderReference: json("raw_provider_reference"),
    createdAt: ts("created_at"),
  },
  (t) => ({
    txIdx: uniqueIndex("payments_provider_tx_unique").on(t.provider, t.providerTransactionId),
    workspaceIdx: index("payments_workspace_idx").on(t.workspaceId),
  }),
);

export const billingEvents = mysqlTable(
  "billing_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    provider: varchar("provider", { length: 40 }).notNull(),
    eventType: varchar("event_type", { length: 80 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 191 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }),
    processedAt: timestamp("processed_at", { mode: "date" }).defaultNow(),
    createdAt: ts("created_at"),
  },
  (t) => ({
    idemIdx: uniqueIndex("billing_events_unique").on(t.provider, t.eventType, t.providerEventId),
  }),
);

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Prospect = typeof prospects.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;

export const _schemaMeta = { now: sql`now()` };
