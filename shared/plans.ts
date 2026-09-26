// Plan & entitlement definitions. This is the single source of truth used by
// BOTH the UI (to display limits) and the server (to enforce them).

export type PlanId = "free" | "starter" | "pro" | "agency";

export type LimitKey =
  | "campaigns"
  | "prospectsPerCampaign"
  | "aiRunsPerMonth"
  | "outreachPerMonth";

export type FeatureKey =
  | "outreach"
  | "personalization"
  | "advancedSignals"
  | "priorityProcessing";

export interface Plan {
  id: PlanId;
  name: string;
  priceCents: number;
  interval: "month";
  tagline: string;
  limits: Record<LimitKey, number>;
  features: Record<FeatureKey, boolean>;
}

function price(key: string, fallback: number): number {
  const raw =
    typeof process !== "undefined" && process.env ? process.env[key] : undefined;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    interval: "month",
    tagline: "Try the full workflow on a small scale.",
    limits: {
      campaigns: 1,
      prospectsPerCampaign: 10,
      aiRunsPerMonth: 40,
      outreachPerMonth: 0,
    },
    features: {
      outreach: false,
      personalization: true,
      advancedSignals: false,
      priorityProcessing: false,
    },
  },
  starter: {
    id: "starter",
    name: "Starter",
    priceCents: price("BILLING_PRICE_STARTER", 2900),
    interval: "month",
    tagline: "For solo operators landing their first clients.",
    limits: {
      campaigns: 3,
      prospectsPerCampaign: 25,
      aiRunsPerMonth: 300,
      outreachPerMonth: 100,
    },
    features: {
      outreach: true,
      personalization: true,
      advancedSignals: false,
      priorityProcessing: false,
    },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCents: price("BILLING_PRICE_PRO", 7900),
    interval: "month",
    tagline: "For consultants and freelancers running real pipelines.",
    limits: {
      campaigns: 10,
      prospectsPerCampaign: 60,
      aiRunsPerMonth: 1500,
      outreachPerMonth: 1000,
    },
    features: {
      outreach: true,
      personalization: true,
      advancedSignals: true,
      priorityProcessing: true,
    },
  },
  agency: {
    id: "agency",
    name: "Agency",
    priceCents: price("BILLING_PRICE_AGENCY", 19900),
    interval: "month",
    tagline: "For teams running acquisition for multiple clients.",
    limits: {
      campaigns: 50,
      prospectsPerCampaign: 150,
      aiRunsPerMonth: 8000,
      outreachPerMonth: 10000,
    },
    features: {
      outreach: true,
      personalization: true,
      advancedSignals: true,
      priorityProcessing: true,
    },
  },
};

export const DEFAULT_PLAN_ID: PlanId = "free";

export function getPlan(id: string | null | undefined): Plan {
  return PLANS[(id as PlanId) ?? DEFAULT_PLAN_ID] ?? PLANS[DEFAULT_PLAN_ID];
}

export function getActivePaidPlans(): Plan[] {
  return [PLANS.starter, PLANS.pro, PLANS.agency];
}

export function withinLimit(plan: Plan, key: LimitKey, current: number, add = 1): boolean {
  return current + add <= plan.limits[key];
}

export function hasFeature(plan: Plan, key: FeatureKey): boolean {
  return plan.features[key];
}
