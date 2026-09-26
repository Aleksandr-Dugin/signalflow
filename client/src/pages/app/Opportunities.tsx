import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Trophy, Save } from "lucide-react";
import { trpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Spinner, EmptyState } from "@/components/common";

const STAGES = ["open", "responded", "meeting_booked", "negotiating", "won", "lost"] as const;
type Stage = (typeof STAGES)[number];

const stageVariant: Record<Stage, "secondary" | "warning" | "success" | "destructive" | "muted"> = {
  open: "secondary",
  responded: "warning",
  meeting_booked: "warning",
  negotiating: "warning",
  won: "success",
  lost: "destructive",
};

const money = (cents: number) => `$${(cents / 100).toFixed(0)}`;

export default function Opportunities() {
  const utils = trpc.useUtils();
  const list = trpc.opportunity.list.useQuery();
  const update = trpc.opportunity.update.useMutation({
    onSuccess: () => {
      toast.success("Opportunity updated");
      void utils.opportunity.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [notes, setNotes] = useState("");

  const rows = list.data ?? [];
  const pipeline = rows.filter((r) => r.stage !== "won" && r.stage !== "lost").reduce((a, r) => a + r.valueCents, 0);
  const won = rows.filter((r) => r.stage === "won").reduce((a, r) => a + r.valueCents, 0);

  function startEdit(r: (typeof rows)[number]) {
    setEditing(r.id);
    setValue(String(r.valueCents / 100));
    setNotes(r.notes ?? "");
  }

  if (list.isLoading) {
    return <div className="grid place-items-center py-20"><Spinner className="h-6 w-6 text-primary" /></div>;
  }

  return (
    <div>
      <PageHeader title="Opportunities" description="Replies that turned into real deals." />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="p-5"><div className="text-sm text-muted-foreground">Open pipeline</div><div className="text-2xl font-semibold tabular-nums">{money(pipeline)}</div></CardContent></Card>
        <Card><CardContent className="p-5"><div className="text-sm text-muted-foreground">Won</div><div className="text-2xl font-semibold tabular-nums text-success">{money(won)}</div></CardContent></Card>
        <Card><CardContent className="p-5"><div className="text-sm text-muted-foreground">Deals</div><div className="text-2xl font-semibold tabular-nums">{rows.length}</div></CardContent></Card>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No opportunities yet" description="Send outreach and replies here will convert discovered leads into opportunities." action={<Button asChild><Link href="/app/campaigns">Go to campaigns</Link></Button>} />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id}>
              <CardContent className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary"><Trophy className="h-4 w-4" /></span>
                    <div>
                      <div className="font-medium">{r.company || r.prospectId}</div>
                      <Link href={`/app/prospects/${r.prospectId}`} className="text-xs text-primary hover:underline">View prospect</Link>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={stageVariant[r.stage as Stage] ?? "secondary"}>{r.stage}</Badge>
                    <span className="tabular-nums font-medium">{money(r.valueCents)}</span>
                    <Button size="sm" variant="ghost" onClick={() => (editing === r.id ? setEditing(null) : startEdit(r))}>
                      {editing === r.id ? "Close" : "Edit"}
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {STAGES.map((s) => (
                    <button
                      key={s}
                      onClick={() => update.mutate({ id: r.id, stage: s })}
                      disabled={update.isPending || r.stage === s}
                      className={
                        "rounded-full border px-3 py-1 text-xs transition-colors " +
                        (r.stage === s ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")
                      }
                    >
                      {s.replace("_", " ")}
                    </button>
                  ))}
                </div>

                {editing === r.id && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr_auto]">
                    <Input type="number" min={0} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value USD" />
                    <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" />
                    <Button
                      onClick={() => update.mutate({ id: r.id, valueCents: Math.round(Number(value || 0) * 100), notes })}
                      disabled={update.isPending}
                    >
                      {update.isPending ? <Spinner /> : <Save className="h-4 w-4" />} Save
                    </Button>
                  </div>
                )}
                {r.notes && editing !== r.id ? <p className="mt-3 text-sm text-muted-foreground">{r.notes}</p> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
