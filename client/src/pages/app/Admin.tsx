import { toast } from "sonner";
import {
  Activity,
  Database,
  ShieldAlert,
  Users as UsersIcon,
  Building2,
  Workflow,
  CheckCircle2,
  XCircle,
  Lock,
} from "lucide-react";
import { trpc } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader, Spinner, AnimatedCounter } from "@/components/common";
import { cn } from "@/lib/utils";

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <Card className="brutal-sm">
      <CardContent className="p-5">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="mt-1 font-grotesk text-3xl font-black tabular">{typeof value === "number" ? <AnimatedCounter value={value} /> : value}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function StatusChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-[3px] border px-2.5 py-1 text-xs font-mono uppercase", ok ? "border-success/50 bg-success/10 text-success" : "border-[var(--brutal-line)] bg-card text-muted-foreground")}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

const jobTone: Record<string, string> = {
  queued: "text-muted-foreground",
  running: "text-primary",
  completed: "text-success",
  failed: "text-destructive",
};

export default function Admin() {
  const me = trpc.workspace.me.useQuery();
  const isAdmin = me.data?.user?.role === "admin";

  const status = trpc.admin.status.useQuery(undefined, { enabled: isAdmin });
  const overview = trpc.admin.overview.useQuery(undefined, { enabled: isAdmin, refetchInterval: 15000 });
  const users = trpc.admin.users.useQuery({ limit: 200 }, { enabled: isAdmin });
  const workspaces = trpc.admin.workspaces.useQuery({ limit: 200 }, { enabled: isAdmin });
  const jobs = trpc.admin.recentJobs.useQuery({ limit: 30 }, { enabled: isAdmin });
  const utils = trpc.useUtils();
  const setRole = trpc.admin.setRole.useMutation({
    onSuccess: () => {
      toast.success("Role updated");
      void utils.admin.users.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (me.isLoading) {
    return (
      <div className="grid place-items-center py-24">
        <Spinner className="h-6 w-6 text-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <Card className="brutal mx-auto mt-16 max-w-md">
        <CardContent className="p-8 text-center">
          <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-destructive/15 text-destructive"><Lock className="h-6 w-6" /></span>
          <h2 className="font-grotesk text-xl font-black">Admins only</h2>
          <p className="mt-2 text-sm text-muted-foreground">You don't have access to this area. Ask an administrator to grant your account the admin role.</p>
        </CardContent>
      </Card>
    );
  }

  const c = overview.data?.counts;
  const j = overview.data?.jobs;

  return (
    <div>
      <PageHeader title="Admin" description="System health, tenants and job pipeline — visible to administrators only." />

      {/* Health */}
      <Card className="brutal-sm mb-4">
        <CardContent className="flex flex-wrap items-center gap-2 p-5">
          <span className="mr-2 inline-flex items-center gap-1.5 text-sm font-medium"><Activity className="h-4 w-4 text-primary" /> Integrations</span>
          <StatusChip ok={Boolean(status.data?.dbConnected)} label={status.data?.dbConnected ? "Database" : "No database"} />
          <StatusChip ok={status.data?.ai === "groq"} label={status.data?.ai === "groq" ? "Groq AI" : "AI: mock"} />
          <StatusChip ok={status.data?.discovery === "scrapegraph-live"} label="ScrapeGraph" />
          <StatusChip ok={Boolean(status.data?.smtp)} label="SMTP" />
          <StatusChip ok={Boolean(status.data?.replyWebhook)} label="Reply webhook" />
          <StatusChip ok label={`Billing: ${status.data?.billing ?? "mock"}`} />
          <StatusChip ok={Boolean(status.data?.oauth?.google)} label="Google OAuth" />
          <StatusChip ok={Boolean(status.data?.oauth?.github)} label="GitHub OAuth" />
          <span className="ml-auto text-xs text-muted-foreground">env: <span className="font-mono">{status.data?.environment}</span></span>
        </CardContent>
      </Card>

      {/* Counts */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Users" value={c?.users ?? 0} />
        <Stat label="Workspaces" value={c?.workspaces ?? 0} />
        <Stat label="Campaigns" value={c?.campaigns ?? 0} />
        <Stat label="Prospects" value={c?.prospects ?? 0} />
        <Stat label="Opportunities" value={c?.opportunities ?? 0} />
        <Stat label="Outreach sent" value={c?.outreachSent ?? 0} />
        <Stat label="Email events" value={c?.repliesInbound ?? 0} hint="inbound + outbound" />
        <Stat label="Recurring discovery" value={status.data?.discoveryIntervalHours ? `every ${status.data?.discoveryIntervalHours}h` : "off"} />
      </div>

      {/* Jobs */}
      <Card className="brutal-sm mb-4">
        <CardContent className="p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Workflow className="h-4 w-4 text-primary" /> Job queue</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["queued", "running", "completed", "failed"] as const).map((k) => (
              <div key={k} className="rounded-[3px] border border-[var(--brutal-line)] bg-card p-3">
                <p className="text-xs uppercase tracking-wider text-muted-foreground">{k}</p>
                <p className={cn("font-grotesk text-2xl font-black tabular", jobTone[k])}><AnimatedCounter value={j?.[k] ?? 0} /></p>
              </div>
            ))}
          </div>
          {overview.data?.recentFailures?.length ? (
            <div className="mt-4 space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-destructive"><ShieldAlert className="h-3.5 w-3.5" /> Recent failures</p>
              {overview.data.recentFailures.map((f) => (
                <div key={f.id} className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
                  <span className="font-mono text-destructive">{f.type}</span> · {f.attempts} attempts · <span className="text-muted-foreground">{(f.error ?? "—").slice(0, 160)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Users */}
        <Card className="brutal-sm">
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium"><UsersIcon className="h-4 w-4 text-primary" /> Users</div>
            <div className="max-h-[24rem] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 text-left text-xs text-muted-foreground">
                  <tr><th className="py-1.5 font-medium">User</th><th className="py-1.5 font-medium">Plan</th><th className="py-1.5 font-medium">Role</th></tr>
                </thead>
                <tbody>
                  {(users.data ?? []).map((u) => (
                    <tr key={u.id} className="row-hover border-t border-[var(--brutal-line)]">
                      <td className="py-2">
                        <div className="font-medium">{u.name || u.email || "—"}</div>
                        <div className="text-xs text-muted-foreground">{u.email}</div>
                      </td>
                      <td className="py-2"><Badge variant="muted">{u.planId ?? "—"}</Badge></td>
                      <td className="py-2">
                        <div className="flex items-center gap-1">
                          <Badge variant={u.role === "admin" ? "success" : "muted"}>{u.role}</Badge>
                          {u.id !== me.data?.user?.id ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs"
                              disabled={setRole.isPending}
                              onClick={() => setRole.mutate({ userId: u.id, role: u.role === "admin" ? "user" : "admin" })}
                            >
                              {u.role === "admin" ? "Demote" : "Promote"}
                            </Button>
                          ) : <span className="text-[10px] text-muted-foreground">(you)</span>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Workspaces */}
        <Card className="brutal-sm">
          <CardContent className="p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Building2 className="h-4 w-4 text-primary" /> Workspaces</div>
            <div className="max-h-[24rem] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 text-left text-xs text-muted-foreground">
                  <tr><th className="py-1.5 font-medium">Workspace</th><th className="py-1.5 font-medium">Plan</th><th className="py-1.5 font-medium">Autopilot</th></tr>
                </thead>
                <tbody>
                  {(workspaces.data ?? []).map((w) => (
                    <tr key={w.id} className="row-hover border-t border-[var(--brutal-line)]">
                      <td className="py-2">
                        <div className="font-medium">{w.name}</div>
                        <div className="text-xs text-muted-foreground">{w.ownerEmail ?? w.slug}</div>
                      </td>
                      <td className="py-2"><Badge variant="muted">{w.planId}</Badge></td>
                      <td className="py-2">{w.autopilot ? <Badge variant="success">on</Badge> : <Badge variant="muted">off</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent jobs */}
      <Card className="brutal-sm mt-4">
        <CardContent className="p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium"><Database className="h-4 w-4 text-primary" /> Recent jobs</div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="py-1.5 font-medium">Type</th><th className="py-1.5 font-medium">Status</th><th className="py-1.5 font-medium">Att.</th><th className="py-1.5 font-medium">Workspace</th><th className="py-1.5 font-medium">Updated</th></tr>
              </thead>
              <tbody>
                {(jobs.data ?? []).map((job) => (
                  <tr key={job.id} className="row-hover border-t border-[var(--brutal-line)]">
                    <td className="py-2 font-mono text-xs">{job.type}</td>
                    <td className={cn("py-2 text-xs font-medium", jobTone[job.status])}>{job.status}</td>
                    <td className="py-2 tabular-nums text-muted-foreground">{job.attempts}</td>
                    <td className="py-2 font-mono text-xs text-muted-foreground">{job.workspaceId.slice(0, 10)}</td>
                    <td className="py-2 text-xs text-muted-foreground">{job.updatedAt ? new Date(job.updatedAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
                {(jobs.data ?? []).length === 0 ? (
                  <tr><td colSpan={5} className="py-6 text-center text-sm text-muted-foreground">No jobs yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
