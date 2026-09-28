import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Bot, Download, Mail, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAutonomy } from "@/components/autonomy";
import { cn } from "@/lib/utils";
import { PageHeader, ThemeToggle } from "@/components/common";

export default function Settings() {
  const { user, logout } = useAuth();
  const utils = trpc.useUtils();
  const me = trpc.workspace.me.useQuery();
  const profile = trpc.workspace.profile.useQuery();
  const providers = trpc.auth.providers.useQuery();
  const autopilot = useAutonomy();
  const setAutopilot = trpc.workspace.setAutopilot.useMutation({
    onSuccess: (r) => {
      // Wording has to survive the global pause: promising that AI "will send"
      // while an operator has halted the platform would be a lie the next
      // screen contradicts.
      toast.success(r.enabled ? "Autopilot ON for this workspace" : "Autopilot OFF — nothing sends without your click");
      void utils.workspace.autopilot.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // This workspace's own choice, and what the platform is doing above it — kept
  // apart deliberately. Collapsing the two would make an operator's pause look like
  // this workspace had switched itself off, inviting the owner to "fix" a toggle
  // that is not why nothing is sending.
  const ownAutopilot = autopilot.data?.enabled ?? false;
  // `undefined` until the query answers, and `"unreadable"` is not the same fact as
  // `"paused"`: one is a person holding a lever, the other is a deployment that
  // cannot read anything and is not fixed by going to find that person. Defaulting
  // any of this would label the workspace "live" for a moment on every page load,
  // and "live" is the claim this line exists to withhold while the truth is unknown.
  const autonomy = autopilot.data?.autonomy;

  // Data-subject requests. Kept here rather than on each prospect page because the
  // request arrives as an email address, not as one of our ids — and the answer has
  // to cover every row that address touches, across campaigns.
  const [subjectEmail, setSubjectEmail] = useState("");
  const [eraseArmed, setEraseArmed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const erase = trpc.gdpr.erase.useMutation({
    onSuccess: (r) => {
      const gone = Object.values(r.deleted).reduce((a, b) => a + b, 0);
      toast.success(gone ? `Erased ${gone} record(s) for ${r.email}` : `Nothing was held for ${r.email}`);
      setEraseArmed(false);
    },
    onError: (e) => {
      toast.error(e.message);
      setEraseArmed(false);
    },
  });

  async function runExport() {
    const email = subjectEmail.trim();
    if (!email) return toast.error("Enter the address the request is about.");
    setExporting(true);
    try {
      const { dossier } = await utils.gdpr.export.fetch({ email });
      if (!dossier) {
        toast.info("Nothing is held for that address — which is itself the answer to give them.");
        return;
      }
      const blob = new Blob([JSON.stringify(dossier, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `subject-access-${dossier.email}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Structured copy downloaded — send it to the person who asked.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

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
              <div className="flex flex-col items-end gap-1.5">
                <Button
                  variant={ownAutopilot ? "default" : "outline"}
                  onClick={() => setAutopilot.mutate({ enabled: !ownAutopilot })}
                  disabled={setAutopilot.isPending || !providers.data?.email /* outreach needs email path */}
                >
                  {ownAutopilot ? <ShieldCheck className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
                  {ownAutopilot ? "ON" : "OFF"}
                </Button>
                {/* Still editable while paused: recording a preference costs nothing, and
                    blocking it would make owners re-enter a setting that was never wrong. */}
                <span
                  className={cn(
                    "font-mono text-[10px] uppercase tracking-wider",
                    autonomy === "paused"
                      ? "text-amber-500"
                      : autonomy === "unreadable"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {autonomy === undefined
                    ? "checking…"
                    : autonomy === "unreadable"
                      ? "status unreadable"
                      : autonomy === "paused"
                        ? "paused by operator"
                        : ownAutopilot
                          ? "live"
                          : "off"}
                </span>
              </div>
            </div>
            {autonomy === "paused" ? (
              <p className="mb-2 text-xs text-amber-500">
                A platform operator has paused all autonomy. This workspace's choice is saved and
                takes effect again the moment autonomy resumes — nothing sends meanwhile, and a
                reply that arrives during the pause will not be followed up automatically
                afterwards either.
              </p>
            ) : null}
            {autonomy === "unreadable" ? (
              <p className="mb-2 text-xs text-destructive">
                The autonomy switch itself cannot be read — no database, or migrations that have
                not been applied. Autonomy fails closed, so nothing is sending; releasing the pause
                in Admin will not help until the deployment can be read again.
              </p>
            ) : null}
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

        <Card className="sm:col-span-2">
          <CardContent className="p-6">
            <h2 className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4 text-primary" /> Data subject requests
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              When someone asks what you hold about them, or asks you to delete it, search their
              address here. The export is the complete answer — contact record, every message sent to
              them, everything they wrote back, and the scores derived from it — as one file you can
              send on. Erasing removes those rows from this workspace.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input
                value={subjectEmail}
                onChange={(e) => {
                  setSubjectEmail(e.target.value);
                  setEraseArmed(false);
                }}
                placeholder="person@company.com"
                className="max-w-xs"
                aria-label="Email address the request concerns"
              />
              <Button variant="outline" size="sm" onClick={runExport} disabled={exporting || !subjectEmail.trim()}>
                <Download className="mr-1.5 h-4 w-4" /> {exporting ? "Preparing…" : "Export their data"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={!subjectEmail.trim() || erase.isPending}
                onClick={() => {
                  // Two clicks, because the second one cannot be undone and the first
                  // one is cheap: an erasure executed by accident is itself a breach.
                  if (!eraseArmed) {
                    setEraseArmed(true);
                    return;
                  }
                  erase.mutate({ email: subjectEmail.trim(), confirm: true });
                }}
              >
                <Trash2 className="mr-1.5 h-4 w-4" />
                {erase.isPending
                  ? "Erasing…"
                  : eraseArmed
                    ? `Confirm erase ${subjectEmail.trim()}`
                    : "Erase their data"}
              </Button>
            </div>
            {eraseArmed ? (
              <p className="mt-2 text-xs text-destructive">
                This deletes rows and cannot be undone. The first click changed nothing.
              </p>
            ) : null}
            {/* Only this address's own result: a report left on screen after the
                field was changed would describe a different person's deletion. */}
            {erase.data && erase.data.email === subjectEmail.trim().toLowerCase() ? (
              <div className="mt-3 space-y-2 text-xs">
                <p className="font-mono">
                  deleted: {Object.entries(erase.data.deleted)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${k} ${n}`)
                    .join(", ") || "nothing was held"}
                </p>
                {erase.data.retained.map((r) => (
                  <p key={r.what} className="rounded-md border border-[var(--brutal-line)] bg-card p-2 text-muted-foreground">
                    <span className="font-medium text-foreground">Kept: {r.what}.</span> {r.why}
                  </p>
                ))}
              </div>
            ) : null}
            <p className="mt-3 text-xs text-muted-foreground">
              A suppression entry survives an erasure on purpose — forgetting an opt-out is what makes
              the next campaign mail them again. See the <Link href="/privacy" className="underline">privacy policy</Link>{" "}
              and <Link href="/terms" className="underline">terms</Link> for what this deployment claims.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
