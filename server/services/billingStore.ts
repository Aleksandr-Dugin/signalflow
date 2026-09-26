import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import { getDb, type DB } from "../_core/database";
import { getPlan, type PlanId } from "../../shared/plans";

function hash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function getSubscription(workspaceId: string) {
  const db = getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.workspaceId, workspaceId))
    .limit(1);
  return row ?? null;
}

export async function ensureSubscriptionRow(
  workspaceId: string,
  planId: PlanId = "free",
): Promise<string> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable");
  const existing = await getSubscription(workspaceId);
  if (existing) return existing.id;
  const id = nanoid();
  await db.insert(schema.subscriptions).values({
    id,
    workspaceId,
    planId,
    status: planId === "free" ? "active" : "incomplete",
    provider: "mock",
  });
  return id;
}

/**
 * Activate a plan for a workspace. Only ever called from a verified webhook
 * (audit fix: entitlement is granted by the payment provider, not the client).
 */
export async function activatePlan(
  db: DB,
  workspaceId: string,
  planId: PlanId,
  opts: {
    provider: "platega" | "mock";
    providerSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
  },
): Promise<void> {
  const plan = getPlan(planId);
  const [existing] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.workspaceId, workspaceId))
    .limit(1);
  const values = {
    planId,
    provider: opts.provider,
    status: "active" as const,
    providerSubscriptionId: opts.providerSubscriptionId ?? existing?.providerSubscriptionId ?? null,
    currency: envCurrency(),
    amountCents: plan.priceCents,
    currentPeriodStart: new Date(),
    currentPeriodEnd: opts.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: false,
  };
  if (existing) {
    await db
      .update(schema.subscriptions)
      .set(values)
      .where(eq(schema.subscriptions.id, existing.id));
  } else {
    await db.insert(schema.subscriptions).values({ id: nanoid(), workspaceId, ...values });
  }
  // Reflect the plan on the workspace row too (used when no subscription row).
  await db
    .update(schema.workspaces)
    .set({ planId })
    .where(eq(schema.workspaces.id, workspaceId));
}

function envCurrency(): string {
  return process.env.BILLING_CURRENCY || "USD";
}

export async function markSubscriptionCanceled(workspaceId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  const [sub] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.workspaceId, workspaceId))
    .limit(1);
  if (!sub) return;
  await db
    .update(schema.subscriptions)
    .set({ status: "canceled", cancelAtPeriodEnd: false, canceledAt: new Date(), planId: "free" })
    .where(eq(schema.subscriptions.id, sub.id));
  await db
    .update(schema.workspaces)
    .set({ planId: "free" })
    .where(eq(schema.workspaces.id, workspaceId));
}

export async function recordPayment(input: {
  workspaceId: string;
  subscriptionId?: string | null;
  provider: "platega" | "mock";
  providerTransactionId: string;
  amountCents: number;
  status: "pending" | "succeeded" | "failed" | "refunded" | "chargeback";
  kind?: "initial" | "recurring";
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .insert(schema.payments)
    .ignore()
    .values({
      id: nanoid(),
      workspaceId: input.workspaceId,
      subscriptionId: input.subscriptionId ?? null,
      provider: input.provider,
      providerTransactionId: input.providerTransactionId,
      amountCents: input.amountCents,
      currency: envCurrency(),
      status: input.status,
      kind: input.kind ?? "initial",
    });
}

/**
 * Idempotent webhook processing. Returns false when this event was already
 * handled (unique provider/eventType/eventId), so callers skip side effects.
 */
export async function claimBillingEvent(input: {
  provider: string;
  eventType: string;
  providerEventId: string;
  payload: unknown;
}): Promise<boolean> {
  const db = getDb();
  if (!db) return true;
  const [res] = await db
    .insert(schema.billingEvents)
    .ignore()
    .values({
      id: nanoid(),
      provider: input.provider,
      eventType: input.eventType,
      providerEventId: input.providerEventId,
      payloadHash: hash(input.payload),
    });
  return (res as { affectedRows?: number }).affectedRows !== 0;
}

export async function listPayments(workspaceId: string) {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.workspaceId, workspaceId))
    .orderBy(schema.payments.createdAt);
}
