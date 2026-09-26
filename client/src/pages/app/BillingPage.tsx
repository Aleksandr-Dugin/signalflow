import { useEffect } from "react";
import { toast } from "sonner";
import { Check, X, CreditCard } from "lucide-react";
import { trpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Spinner } from "@/components/common";
import type { Plan } from "@shared/plans";

const money = (cents: number) => `$${(cents / 100).toFixed(0)}`;

export default function BillingPage() {
  const utils = trpc.useUtils();
  const status = trpc.billing.status.useQuery();
  const meta = trpc.meta.plans.useQuery();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const s = params.get("status");
    if (s === "success") {
      toast.success("Payment received — plan activated");
      void utils.billing.status.invalidate();
      void utils.workspace.me.invalidate();
      window.history.replaceState({}, "", "/app/billing");
    } else if (s === "cancelled") {
      toast("Checkout cancelled");
      window.history.replaceState({}, "", "/app/billing");
    }
  }, [utils]);

  const checkout = trpc.billing.checkout.useMutation({
    onSuccess: (r) => {
      window.location.href = r.redirectUrl;
    },
    onError: (e) => toast.error(e.message),
  });

  const current = status.data?.entitlements.planId;
  const paidPlans: Plan[] = meta.data?.paid ?? [];

  return (
    <div>
      <PageHeader title="Billing" description="Manage your plan and payments." />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-6">
            <h2 className="mb-3 font-semibold">Current plan</h2>
            {status.isLoading ? (
              <Spinner />
            ) : status.data ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Plan</span>
                  <Badge variant="secondary">{status.data.entitlements.planId}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <Badge variant={status.data.subscription.status === "active" ? "success" : "warning"}>{status.data.subscription.status}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Provider</span>
                  <span>{status.data.subscription.provider}</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-center">
                  <div><div className="text-lg font-semibold tabular-nums">{status.data.entitlements.usage.aiRunsThisMonth}/{status.data.entitlements.limits.aiRunsPerMonth}</div><div className="text-xs text-muted-foreground">AI runs</div></div>
                  <div><div className="text-lg font-semibold tabular-nums">{status.data.entitlements.usage.outreachThisMonth}/{status.data.entitlements.limits.outreachPerMonth}</div><div className="text-xs text-muted-foreground">Outreach</div></div>
                  <div><div className="text-lg font-semibold tabular-nums">{status.data.entitlements.usage.campaigns}/{status.data.entitlements.limits.campaigns}</div><div className="text-xs text-muted-foreground">Campaigns</div></div>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <h2 className="mb-3 font-semibold">Payment history</h2>
            {(status.data?.payments ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments yet.</p>
            ) : (
              <div className="divide-y text-sm">
                {(status.data?.payments ?? []).map((p) => (
                  <div key={p.id} className="flex items-center justify-between py-2">
                    <span>{money(p.amountCents)} {p.currency}</span>
                    <span className="text-muted-foreground">{new Date(p.createdAt).toLocaleDateString()}</span>
                    <Badge variant={p.status === "succeeded" ? "success" : "muted"}>{p.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <h2 className="mb-3 mt-8 text-lg font-semibold">Plans</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {paidPlans.map((plan) => {
          const isCurrent = current === plan.id;
          return (
            <Card key={plan.id} className={isCurrent ? "ring-2 ring-primary" : ""}>
              <CardContent className="flex h-full flex-col p-6">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{plan.name}</h3>
                  {isCurrent ? <Badge variant="success">Current</Badge> : null}
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">{money(plan.priceCents)}<span className="text-sm font-normal text-muted-foreground">/mo</span></div>
                <p className="mt-1 text-sm text-muted-foreground">{plan.tagline}</p>
                <ul className="mt-4 flex-1 space-y-2 text-sm">
                  <li className="flex items-center gap-2"><Check className="h-4 w-4 text-success" /> {plan.limits.campaigns} campaigns</li>
                  <li className="flex items-center gap-2"><Check className="h-4 w-4 text-success" /> {plan.limits.prospectsPerCampaign} prospects/campaign</li>
                  <li className="flex items-center gap-2"><Check className="h-4 w-4 text-success" /> {plan.limits.aiRunsPerMonth} AI runs/mo</li>
                  <li className="flex items-center gap-2">{plan.features.outreach ? <Check className="h-4 w-4 text-success" /> : <X className="h-4 w-4 text-muted-foreground" />} {plan.limits.outreachPerMonth} outreach/mo</li>
                  <li className="flex items-center gap-2">{plan.features.advancedSignals ? <Check className="h-4 w-4 text-success" /> : <X className="h-4 w-4 text-muted-foreground" />} Advanced signals</li>
                </ul>
                <Button
                  className="mt-5 w-full"
                  variant={isCurrent ? "outline" : "default"}
                  disabled={isCurrent || checkout.isPending}
                  onClick={() => checkout.mutate({ planId: plan.id as "starter" | "pro" | "agency" })}
                >
                  {checkout.isPending && !isCurrent ? <Spinner /> : <CreditCard className="h-4 w-4" />}
                  {isCurrent ? "Current plan" : "Upgrade"}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
