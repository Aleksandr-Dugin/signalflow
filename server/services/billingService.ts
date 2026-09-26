import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../_core/env";
import { getPlan, type PlanId } from "../../shared/plans";

export interface CheckoutInput {
  workspaceId: string;
  planId: PlanId;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  provider: "platega" | "mock";
  redirectUrl: string;
  providerSubscriptionId: string | null;
}

export interface BillingProvider {
  readonly name: "platega" | "mock";
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signed, self-contained token for the mock checkout handoff. */
export function signMockCheckout(workspaceId: string, planId: PlanId): string {
  const payload = `${workspaceId}.${planId}`;
  const sig = b64url(
    createHmac("sha256", env.mockBillingWebhookSecret).update(payload).digest(),
  );
  return `${b64url(Buffer.from(payload))}.${sig}`;
}

export function verifyMockCheckout(token: string): { workspaceId: string; planId: PlanId } | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64").toString("utf8");
  } catch {
    return null;
  }
  const expected = b64url(
    createHmac("sha256", env.mockBillingWebhookSecret).update(payload).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const [workspaceId, planId] = payload.split(".");
  if (!workspaceId || !planId) return null;
  return { workspaceId, planId: planId as PlanId };
}

class MockBillingProvider implements BillingProvider {
  readonly name = "mock" as const;
  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const token = signMockCheckout(input.workspaceId, input.planId);
    const base = env.publicUrl.replace(/\/$/, "");
    return {
      provider: "mock",
      // A tiny hosted "checkout" that immediately completes (dev/staging only).
      redirectUrl: `${base}/api/billing/mock/complete?token=${encodeURIComponent(token)}`,
      providerSubscriptionId: `mock_sub_${input.workspaceId}`,
    };
  }
}

class PlategaBillingProvider implements BillingProvider {
  readonly name = "platega" as const;

  private authHeader(): string {
    const raw = `${env.plategaMerchantId}:${env.plategaSecret}`;
    return `Basic ${Buffer.from(raw).toString("base64")}`;
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const plan = getPlan(input.planId);
    const apiBase = env.plategaApiUrl.replace(/\/$/, "");
    const body = {
      payerEmail: input.customerEmail ?? undefined,
      currency: env.billingCurrency,
      interval: "MONTHLY",
      intervalCount: 1,
      trialPeriodInDays: 0,
      externalReference: input.workspaceId,
      paymentPageBillingDetailsUrl: input.successUrl,
      merchantAmountOverride: plan.priceCents,
      name: `SignalFlow ${plan.name}`,
      productItems: [
        {
          name: `SignalFlow ${plan.name}`,
          unitPrice: plan.priceCents,
          quantity: 1,
          taxRate: 0,
        },
      ],
    };

    const res = await fetch(`${apiBase}/invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: this.authHeader(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Platega checkout failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as any;
    const redirectUrl =
      json?.paymentPageUrl ?? json?.redirectUrl ?? json?.paymentPageRedirectUrl ?? input.successUrl;
    const providerSubscriptionId = json?.subscriptionId ?? json?.id ?? null;
    return {
      provider: "platega",
      redirectUrl: String(redirectUrl),
      providerSubscriptionId: providerSubscriptionId ? String(providerSubscriptionId) : null,
    };
  }
}

export function plategaConfigured(): boolean {
  return Boolean(env.plategaMerchantId && env.plategaSecret);
}

export function getBillingProvider(): BillingProvider {
  const forced = env.billingProvider.toLowerCase();
  if (forced === "platega" || (forced === "" && plategaConfigured())) {
    if (!plategaConfigured()) {
      throw new Error("BILLING_PROVIDER=platega but Platega credentials are missing.");
    }
    return new PlategaBillingProvider();
  }
  if (forced === "mock" || forced === "") {
    if (env.isProd) {
      // Audit fix: never let a fake payment provider grant real entitlements.
      throw new Error("Mock billing is not allowed in production. Configure Platega credentials.");
    }
    return new MockBillingProvider();
  }
  throw new Error(`Unknown BILLING_PROVIDER "${env.billingProvider}".`);
}
