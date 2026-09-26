import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "../_core/env";
import { getDb } from "../_core/database";
import * as schema from "../../drizzle/schema";
import type { PlanId } from "../../shared/plans";
import { getEntitlements } from "./entitlements";
import {
  activatePlan,
  claimBillingEvent,
  getSubscription,
  listPayments,
  markSubscriptionCanceled,
  recordPayment,
} from "./billingStore";
import { verifyMockCheckout } from "./billingService";
import type { PublicSubscription } from "../../shared/billing";

export function verifyPlategaSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!env.plategaSecret || !signatureHeader) return false;
  // Platega format: "t=<timestamp>,v0=<hex hmac>"
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k?.trim(), v?.trim()];
    }),
  );
  const t = parts.t;
  const v0 = parts.v0;
  if (!t || !v0) return false;
  const expected = createHmac("sha256", env.plategaSecret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(v0);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const VALID_PLANS: PlanId[] = ["free", "starter", "pro", "agency"];

async function resolveWorkspaceId(event: any): Promise<string | null> {
  const external = event?.externalReference ?? event?.subscription?.externalReference;
  if (typeof external === "string" && external) return external;
  const subId = event?.subscriptionId ?? event?.subscription?.id;
  if (subId) {
    const db = getDb();
    if (db) {
      const [row] = await db
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.providerSubscriptionId, String(subId)))
        .limit(1);
      if (row) return row.workspaceId;
    }
  }
  return null;
}

export interface WebhookResult {
  handled: boolean;
  reason?: string;
}

/** Process a verified Platega webhook event. Entitlement changes happen here only. */
export async function handlePlategaEvent(rawBody: string): Promise<WebhookResult> {
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { handled: false, reason: "invalid_json" };
  }
  const type: string = event?.type ?? event?.eventType ?? "";
  const workspaceId = await resolveWorkspaceId(event);
  if (!workspaceId) return { handled: false, reason: "unknown_workspace" };

  const providerEventId = String(event?.id ?? `${type}:${Date.now()}`);
  const claimed = await claimBillingEvent({
    provider: "platega",
    eventType: type,
    providerEventId,
    payload: event,
  });
  if (!claimed) return { handled: true, reason: "duplicate" };

  const db = getDb();
  if (!db) return { handled: false, reason: "no_db" };

  const success = /payment_succeeded|checkout_completed|subscription_activated|invoice_paid/i.test(type);
  const failure = /payment_failed|past_due/i.test(type);
  const canceled = /subscription_canceled|subscription_deleted|invoice_canceled/i.test(type);

  if (success) {
    const planId = normalizePlan(event?.planId ?? event?.metadata?.planId ?? event?.productItems?.[0]?.name);
    const periodEnd = event?.currentPeriodEnd ? new Date(event.currentPeriodEnd) : null;
    await activatePlan(db, workspaceId, planId, {
      provider: "platega",
      providerSubscriptionId: event?.subscriptionId ? String(event.subscriptionId) : null,
      currentPeriodEnd: periodEnd,
    });
    await recordPayment({
      workspaceId,
      provider: "platega",
      providerTransactionId: providerEventId,
      amountCents: Number(event?.amountPaid ?? event?.total ?? 0),
      status: "succeeded",
    });
  } else if (failure) {
    await db
      .update(schema.subscriptions)
      .set({ status: "past_due" })
      .where(eq(schema.subscriptions.workspaceId, workspaceId));
  } else if (canceled) {
    await markSubscriptionCanceled(workspaceId);
  }
  return { handled: true };
}

function normalizePlan(raw: unknown): PlanId {
  const s = String(raw ?? "").toLowerCase();
  const match = VALID_PLANS.find((p) => s.includes(p));
  return match ?? "pro";
}

/** Complete a mock checkout (dev/staging only) — mirrors the webhook effect. */
export async function completeMockCheckout(token: string): Promise<WebhookResult> {
  if (env.isProd) return { handled: false, reason: "prod_disabled" };
  const verified = verifyMockCheckout(token);
  if (!verified) return { handled: false, reason: "bad_token" };
  const db = getDb();
  if (!db) return { handled: false, reason: "no_db" };
  await claimBillingEvent({
    provider: "mock",
    eventType: "mock_checkout_completed",
    providerEventId: `${verified.workspaceId}:${verified.planId}:${Date.now()}`,
    payload: verified,
  });
  await activatePlan(db, verified.workspaceId, verified.planId, { provider: "mock" });
  await recordPayment({
    workspaceId: verified.workspaceId,
    provider: "mock",
    providerTransactionId: `mock_${Date.now()}`,
    amountCents: 0,
    status: "succeeded",
  });
  return { handled: true };
}

export async function getBillingStatus(workspaceId: string) {
  const db = getDb();
  const entitlements = await getEntitlements(workspaceId);
  const sub = db ? await getSubscription(workspaceId) : null;
  const payments = db ? await listPayments(workspaceId) : [];

  const subscription: PublicSubscription = {
    planId: entitlements.planId,
    status: (sub?.status as PublicSubscription["status"]) ?? "active",
    interval: "month",
    currentPeriodStart: sub?.currentPeriodStart ? sub.currentPeriodStart.toISOString() : null,
    currentPeriodEnd: sub?.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    provider: (sub?.provider as "platega" | "mock") ?? "mock",
  };

  return {
    subscription,
    entitlements,
    payments: payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      currency: p.currency,
      status: p.status,
      kind: p.kind,
      createdAt: p.createdAt?.toISOString?.() ?? new Date().toISOString(),
      providerReference: p.providerTransactionId ?? undefined,
    })),
  };
}
