import { useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import { Megaphone, Plus, ArrowRight } from "lucide-react";
import { trpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Spinner, EmptyState } from "@/components/common";

const statusVariant: Record<string, "success" | "warning" | "secondary" | "muted" | "destructive"> = {
  active: "success",
  discovering: "warning",
  draft: "secondary",
  partial: "warning",
  archived: "muted",
  failed: "destructive",
};

export default function Campaigns() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const campaigns = trpc.campaign.list.useQuery();
  const icps = trpc.icp.list.useQuery();
  const profile = trpc.workspace.profile.useQuery();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [offer, setOffer] = useState("");
  const [target, setTarget] = useState("");
  const [geography, setGeography] = useState("");
  const [industry, setIndustry] = useState("");
  const [icpId, setIcpId] = useState<string>("");

  const create = trpc.campaign.create.useMutation({
    onSuccess: (c) => {
      toast.success("Campaign created");
      void utils.campaign.list.invalidate();
      setOpen(false);
      navigate(`/app/campaigns/${c.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  function prefill() {
    const p = profile.data;
    if (!p) return;
    setOffer((prev) => prev || p.serviceDescription || "");
    setTarget((prev) => prev || p.targetMarket || "");
    setGeography((prev) => prev || p.geography || "");
    const firstIcp = icps.data?.[0];
    if (firstIcp && !icpId) setIcpId(firstIcp.id);
    if (!industry) {
      const inds = (firstIcp?.criteria as { industries?: string[] })?.industries;
      if (inds?.length) setIndustry(inds[0]);
    }
  }

  const list = campaigns.data ?? [];

  return (
    <div>
      <PageHeader
        title="Campaigns"
        description="Each campaign is bound to an ICP and drives lead discovery."
        action={
          <Button onClick={() => setOpen((o) => !o)}>
            <Plus className="h-4 w-4" /> New campaign
          </Button>
        }
      />

      {open && (
        <Card className="mb-6">
          <CardContent className="space-y-4 p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="c-name">Campaign name</Label>
                <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 SaaS CFO outreach" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="c-offer">Offer description</Label>
                <Textarea id="c-offer" value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="What you're selling and to whom" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-target">Target description</Label>
                <Input id="c-target" value={target} onChange={(e) => setTarget(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-ind">Industry</Label>
                <Input id="c-ind" value={industry} onChange={(e) => setIndustry(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-geo">Geography</Label>
                <Input id="c-geo" value={geography} onChange={(e) => setGeography(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="c-icp">Link an ICP</Label>
                <select
                  id="c-icp"
                  value={icpId}
                  onChange={(e) => setIcpId(e.target.value)}
                  className="flex h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">— none —</option>
                  {(icps.data ?? []).map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.source} · {((i.criteria as { narrative?: string })?.narrative || (i.criteria as { industries?: string[] })?.industries?.[0] || i.id).toString().slice(0, 40)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => create.mutate({ name, offerDescription: offer, targetDescription: target, geography, industry, icpId: icpId || null })}
                disabled={!name || !offer || !target || !geography || !industry || create.isPending}
              >
                {create.isPending ? <Spinner /> : <Plus className="h-4 w-4" />} Create
              </Button>
              <Button variant="ghost" onClick={prefill}>Prefill from profile</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
            {(icps.data?.length ?? 0) === 0 && (
              <p className="text-xs text-muted-foreground">
                Tip: <Link href="/app/onboarding" className="text-primary underline">generate an ICP</Link> and link it so discovery is targeted.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState title="No campaigns yet" description="Create your first campaign to start discovering leads." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((c) => (
            <Card key={c.id}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Megaphone className="h-5 w-5" />
                    </span>
                    <div>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.industry} · {c.geography}</div>
                    </div>
                  </div>
                  <Badge variant={statusVariant[c.status] ?? "secondary"}>{c.status}</Badge>
                </div>
                <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                  <span>Target: {c.prospectTarget} prospects</span>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/app/campaigns/${c.id}`}>Open <ArrowRight className="h-3 w-3" /></Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
