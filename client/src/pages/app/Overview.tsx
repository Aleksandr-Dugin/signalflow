import { Link } from "wouter";
import { Megaphone, Trophy, Users, CheckCircle2, Circle, ArrowRight } from "lucide-react";
import { trpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, OriginBadge } from "@/components/common";

export default function Overview() {
  const { user } = useAuth();
  const me = trpc.workspace.me.useQuery();
  const campaigns = trpc.campaign.list.useQuery();
  const prospects = trpc.prospect.list.useQuery({});
  const opportunities = trpc.opportunity.list.useQuery();

  const profile = trpc.workspace.profile.useQuery();
  const icps = trpc.icp.list.useQuery();

  const hasProfile = Boolean(profile.data?.serviceDescription);
  const hasIcp = (icps.data?.length ?? 0) > 0;
  const hasCampaign = (campaigns.data?.length ?? 0) > 0;

  const steps = [
    { done: hasProfile, label: "Describe your offer & target", href: "/app/onboarding" },
    { done: hasIcp, label: "Generate or save an ICP", href: "/app/onboarding" },
    { done: hasCampaign, label: "Create a campaign", href: "/app/campaigns" },
  ];

  const qualified = (prospects.data ?? []).filter((p) => p.status === "qualified").length;

  return (
    <div>
      <PageHeader title={`Welcome, ${user?.name || "there"}`} description="Your acquisition pipeline at a glance." />

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Campaigns", value: campaigns.data?.length ?? 0, icon: Megaphone },
          { label: "Qualified leads", value: qualified, icon: Users },
          { label: "Opportunities", value: opportunities.data?.length ?? 0, icon: Trophy },
        ].map((s) => (
          <Card key={s.label}>
            <CardContent className="flex items-center gap-4 p-5">
              <span className="grid h-11 w-11 place-items-center rounded-lg bg-primary/10 text-primary">
                <s.icon className="h-5 w-5" />
              </span>
              <div>
                <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
                <div className="text-sm text-muted-foreground">{s.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardContent className="p-6">
          <h2 className="font-semibold">Get started</h2>
          <div className="mt-4 space-y-2">
            {steps.map((step) => (
              <div key={step.label} className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm">
                  {step.done ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
                  {step.label}
                </span>
                <Button asChild variant="ghost" size="sm">
                  <Link href={step.href}>{step.done ? "Edit" : "Do this"} <ArrowRight className="h-3 w-3" /></Link>
                </Button>
              </div>
            ))}
          </div>
          {me.data ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Workspace plan: <Badge variant="secondary">{me.data.entitlements.planId}</Badge>
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold">Top leads</h2>
            <Button asChild variant="outline" size="sm"><Link href="/app/campaigns">View campaigns</Link></Button>
          </div>
          {(prospects.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No prospects yet — create a campaign and run discovery.</p>
          ) : (
            <div className="divide-y">
              {(prospects.data ?? []).slice(0, 6).map((p) => (
                <div key={p.id} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{p.company}</span>
                    <OriginBadge origin={p.origin} />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">{p.status}</span>
                    <span className="tabular-nums font-semibold text-success">{p.overallScore}</span>
                    <Button asChild size="sm" variant="ghost"><Link href={`/app/prospects/${p.id}`}>Open</Link></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
