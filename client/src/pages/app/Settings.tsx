import { Link } from "wouter";
import { toast } from "sonner";
import { Bot, Mail, ShieldCheck, ShieldOff } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, ThemeToggle } from "@/components/common";

export default function Settings() {
  const { user, logout } = useAuth();
  const utils = trpc.useUtils();
  const me = trpc.workspace.me.useQuery();
  const profile = trpc.workspace.profile.useQuery();
  const providers = trpc.auth.providers.useQuery();
  const autopilot = trpc.workspace.autopilot.useQuery();
  const setAutopilot = trpc.workspace.setAutopilot.useMutation({
    onSuccess: (r) => {
      toast.success(r.enabled ? "Autopilot ON — AI will draft and send replies automatically" : "Autopilot OFF — nothing sends without your click");
      void utils.workspace.autopilot.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader title="Settings" description="Your account and workspace." />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardContent className="p-6">
            <h2 className="mb-3 font-semibold">Account</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Name</span><span>{user?.name || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Email</span><span>{user?.email || "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Sign-in</span><span>{providers.data?.email ? "Email" : ""}{providers.data?.google ? " · Google" : ""}{providers.data?.github ? " · GitHub" : ""}</span></div>
            </div>
            <div className="mt-4 flex gap-2">
              <ThemeToggle />
              <Button variant="outline" size="sm" onClick={() => void logout()}>Sign out</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <h2 className="mb-3 font-semibold">Workspace & plan</h2>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Plan</span><Badge variant="secondary">{me.data?.entitlements.planId ?? "free"}</Badge></div>
              <div className="flex justify-between"><span className="text-muted-foreground">AI runs this month</span><span>{me.data?.entitlements.usage.aiRunsThisMonth ?? 0} / {me.data?.entitlements.limits.aiRunsPerMonth ?? 0}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Outreach this month</span><span>{me.data?.entitlements.usage.outreachThisMonth ?? 0} / {me.data?.entitlements.limits.outreachPerMonth ?? 0}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Outreach feature</span><Badge variant={me.data?.entitlements.features.outreach ? "success" : "muted"}>{me.data?.entitlements.features.outreach ? "enabled" : "locked"}</Badge></div>
            </div>
            <Button asChild variant="ghost" size="sm" className="mt-4"><Link href="/app/billing">Manage billing</Link></Button>
          </CardContent>
        </Card>

        <Card className="sm:col-span-2">
          <CardContent className="p-6">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h2 className="flex items-center gap-2 font-semibold"><Bot className="h-4 w-4 text-primary" /> Autopilot</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  When enabled, inbound replies classified as positive / interested / question
                  trigger an AI-written follow-up (thread-aware, objection-aware) that is sent
                  through the same idempotent outreach pipeline. Unsubscribe and not-interested
                  never auto-send.
                </p>
              </div>
              <Button
                variant={autopilot.data?.enabled ? "default" : "outline"}
                onClick={() => setAutopilot.mutate({ enabled: !autopilot.data?.enabled })}
                disabled={setAutopilot.isPending || !providers.data?.email /* outreach needs email path */}
              >
                {autopilot.data?.enabled ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
                {autopilot.data?.enabled ? "ON" : "OFF"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Requires <code>SMTP_*</code> and <code>REPLY_INGEST_SECRET</code>. Wire your ESP to
              <code> /api/replies/webhook/&lt;provider&gt;</code> so inbound mail reaches the pipeline.
            </p>
          </CardContent>
        </Card>

        <Card className="sm:col-span-2">
          <CardContent className="p-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Profile</h2>
              <Button asChild variant="ghost" size="sm"><Link href="/app/onboarding">Edit</Link></Button>
            </div>
            {profile.data ? (
              <div className="space-y-1 text-sm">
                <p><span className="text-muted-foreground">Service:</span> {profile.data.serviceDescription}</p>
                <p><span className="text-muted-foreground">Target:</span> {profile.data.targetMarket}</p>
                <p><span className="text-muted-foreground">Geography:</span> {profile.data.geography}</p>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No profile set — <Link href="/app/onboarding" className="text-primary underline">complete setup</Link>.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
