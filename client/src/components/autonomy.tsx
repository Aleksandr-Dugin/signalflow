import { Link } from "wouter";
import { AlertTriangle, PauseCircle, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/api";

/**
 * Autonomy state for any screen that could otherwise imply the loop is running.
 *
 * Three answers, and the one that matters most is the absence of one: while the
 * query is in flight there is no state, and nothing here may render "live" on the
 * strength of a default. The claim this makes is narrow — whether work is currently
 * being done without a human pressing a button — and it is the claim a growing queue
 * silently contradicts when the master switch is pulled.
 */
export function useAutonomy() {
  return trpc.workspace.autopilot.useQuery(undefined, {
    // Half a minute, not an hour: the lever can be pulled at any moment, and a
    // screen still saying "live" two minutes later is a screen someone acts on.
    refetchInterval: 30_000,
  });
}

/**
 * Shown once, in the app shell, rather than on the pages that happen to mention
 * autonomy: held work shows up everywhere at once — a reply nobody answers, a
 * discovery run that never re-runs, a campaign marked active — and an operator
 * who has to find the right page to learn why will conclude the software is broken.
 */
export function AutonomyHoldBanner({ isAdmin }: { isAdmin: boolean }) {
  const q = useAutonomy();
  const state = q.data?.autonomy;
  if (state !== "paused" && state !== "unreadable") return null;

  const paused = state === "paused";
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-[3px] border-2 px-4 py-3",
        paused ? "border-amber-500/60 bg-amber-500/10" : "border-destructive bg-destructive/10",
      )}
      role="status"
    >
      {paused ? (
        <PauseCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
      ) : (
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
      )}
      <div className="text-sm">
        <p className={cn("font-semibold", paused ? "text-amber-500" : "text-destructive")}>
          {paused ? "Autonomy is paused across the whole platform" : "Autonomy status cannot be read"}
        </p>
        {paused ? (
          <>
            <p className="mt-1 text-muted-foreground">
              No AI follow-up and no scheduled discovery will run, and they will not restart on their
              own — whoever operates this deployment is holding the master switch.
              {q.data?.pausedReason ? ` Reason given: ${q.data.pausedReason}.` : ""}
              {q.data?.pausedAt
                ? ` Since ${new Date(q.data.pausedAt).toLocaleString()}.`
                : ""}
            </p>
            {/* The part an operator most often learns too late: pausing does not only delay
                the follow-up, it stops the follow-up from ever being created, so a reply that
                arrives during the pause is still unanswered after the resume. */}
            <p className="mt-1 text-muted-foreground">
              Work already queued is kept and runs when autonomy is released. But a reply that
              arrives <span className="text-foreground">now</span> gets no automatic follow-up
              later either — read and answer your inbox while this is up. Pressing send on a
              prospect page is manual and still works.
            </p>
            {isAdmin ? (
              <Link
                href="/app/admin"
                className="mt-1 inline-block font-mono text-xs uppercase tracking-wider text-amber-500 underline"
              >
                Resume it in Admin
              </Link>
            ) : (
              <p className="mt-1 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                Only a platform operator can resume it
              </p>
            )}
          </>
        ) : (
          <>
            <p className="mt-1 text-muted-foreground">
              The switch itself is unreadable — the database is down, or this deployment has not run
              the migrations yet. Autonomy fails closed, so nothing is being sent on its own; that is
              the safe half. The unsafe half is that a queue you cannot read is also a queue you
              cannot resume.
            </p>
            <p className="mt-1 font-mono text-xs uppercase tracking-wider text-destructive">
              Not fixed by releasing the pause — fix the deployment. The server log names which one it is.
            </p>
          </>
        )}
      </div>
      {paused ? <ShieldOff className="ml-auto hidden h-4 w-4 shrink-0 self-end text-amber-500/70 sm:block" /> : null}
    </div>
  );
}
