import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import {
  getPlan,
  hasFeature,
  withinLimit,
  type FeatureKey,
  type LimitKey,
  type Plan,
  type PlanId,
} from "../../shared/plans";
import { getDb } from "../_core/database";

function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getEffectivePlan(workspaceId: string): Promise<PlanId> {
  const db = getDb();
  if (!db) return "free";
  const [ws] = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  const fallback = (ws?.planId ?? "free") as PlanId;
  const [sub] = await db
    .select()
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.workspaceId, workspaceId))
    .limit(1);
  if (sub && (sub.status === "active" || sub.status === "past_due")) {
    return sub.planId as PlanId;
  }
  return fallback;
}

export async function getUsage(workspaceId: string): Promise<{
  aiRunsThisMonth: number;
  outreachThisMonth: number;
  campaigns: number;
}> {
  const db = getDb();
  const period = currentPeriod();
  if (!db) return { aiRunsThisMonth: 0, outreachThisMonth: 0, campaigns: 0 };
  const ai = await db
    .select({ total: schema.usageEvents.quantity })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.workspaceId, workspaceId),
        eq(schema.usageEvents.kind, "ai_run"),
        eq(schema.usageEvents.period, period),
      ),
    );
  const out = await db
    .select({ total: schema.usageEvents.quantity })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.workspaceId, workspaceId),
        eq(schema.usageEvents.kind, "outreach_sent"),
        eq(schema.usageEvents.period, period),
      ),
    );
  const campaignRows = await db
    .select({ id: schema.campaigns.id })
    .from(schema.campaigns)
    .where(
      and(
        eq(schema.campaigns.workspaceId, workspaceId),
        // archived campaigns do not count toward the active limit
        eq(schema.campaigns.status, "draft"),
      ),
    );
  return {
    aiRunsThisMonth: sumQuantities(ai),
    outreachThisMonth: sumQuantities(out),
    campaigns: campaignRows.length,
  };
}

function sumQuantities(rows: { total: number }[]): number {
  return rows.reduce((acc, r) => acc + (r.total ?? 0), 0);
}

export async function getEntitlements(workspaceId: string) {
  const plan = getPlan(await getEffectivePlan(workspaceId));
  const usage = await getUsage(workspaceId);
  return { planId: plan.id, limits: plan.limits, features: plan.features, usage };
}

/** Enforce a plan limit server-side. Throws if exceeded (audit P0 fix). */
export async function enforceLimit(
  workspaceId: string,
  key: LimitKey,
  currentCount: number,
  add = 1,
): Promise<void> {
  const plan = getPlan(await getEffectivePlan(workspaceId));
  if (!withinLimit(plan, key, currentCount, add)) {
    throw new Error(
      `Your ${plan.name} plan limit for "${key}" has been reached. Upgrade to continue.`,
    );
  }
}

/** Enforce that the plan includes a feature. Throws otherwise. */
export async function enforceFeature(workspaceId: string, key: FeatureKey): Promise<void> {
  const plan = getPlan(await getEffectivePlan(workspaceId));
  if (!hasFeature(plan, key)) {
    throw new Error(`The "${key}" feature is not included in your ${plan.name} plan.`);
  }
}

export async function recordUsage(
  workspaceId: string,
  kind: "ai_run" | "outreach_sent" | "research",
  quantity = 1,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db.insert(schema.usageEvents).values({
    id: nanoid(),
    workspaceId,
    kind,
    quantity,
    period: currentPeriod(),
  });
}

export async function monthlyUsageCount(workspaceId: string, kind: string): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db
    .select({ quantity: schema.usageEvents.quantity })
    .from(schema.usageEvents)
    .where(
      and(
        eq(schema.usageEvents.workspaceId, workspaceId),
        eq(schema.usageEvents.kind, kind),
        eq(schema.usageEvents.period, currentPeriod()),
      ),
    );
  return rows.reduce((acc, r) => acc + (r.quantity ?? 0), 0);
}

export function planForId(id: string): Plan {
  return getPlan(id);
}

export function periodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
