import type { FeatureKey, LimitKey, PlanId } from "./plans";

export type SubscriptionStatus =
  | "incomplete"
  | "active"
  | "past_due"
  | "canceled"
  | "expired";

export interface PublicSubscription {
  planId: PlanId;
  status: SubscriptionStatus;
  interval: "month";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  provider: "platega" | "mock";
}

export interface Entitlements {
  planId: PlanId;
  limits: Record<LimitKey, number>;
  features: Record<FeatureKey, boolean>;
  usage: {
    aiRunsThisMonth: number;
    outreachThisMonth: number;
    campaigns: number;
  };
}

export interface PaymentRecord {
  id: string;
  amountCents: number;
  currency: string;
  status: "succeeded" | "failed" | "refunded" | "chargeback";
  kind: "initial" | "recurring";
  createdAt: string;
  providerReference?: string;
}

export interface CheckoutResult {
  redirectUrl: string;
  subscriptionId: string;
}
