import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Radar, Archive, ArrowLeft, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Spinner, EmptyState, OriginBadge, ScorePill } from "@/components/common";

export default function CampaignDetail({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const campaigns = trpc.campaign.list.useQuery();
  const campaign = (campaigns.data ?? []).find((c) => c.id === id);
  const prospects = trpc.prospect.list.useQuery({ campaignId: id });

  const [result, setResult] = useState<string | null>(null);

  const runDiscovery = trpc.campaign.runDiscovery.useMutation({
    onSuccess: (r) => {
      setResult(`Discovered ${r.created} new · ${r.qualified} qualified · source: ${r.origin} (${r.provider})`);
      toast.success("Discovery complete");
      void utils.prospect.list.invalidate();
      void utils.campaign.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const archive = trpc.campaign.archive.useMutation({
    onSuccess: () => {
      toast.success("Campaign archived");
      void utils.campaign.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (campaigns.isLoading) {
    return <div className="grid place-items-center py-20"><Spinner className="h-6 w-6 text-primary" /></div>;
  }
  if (!campaign) {
    return (
      <div>
        <Link href="/app/campaigns" className="text-sm text-muted-foreground"><ArrowLeft className="mr-1 inline h-3 w-3" />Back to campaigns</Link>
        <EmptyState title="Campaign not found" />
      </div>
    );
  }

  const rows = prospects.data ?? [];

  return (
    <div>
      <Link href="/app/campaigns" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to campaigns
      </Link>
      <PageHeader
        title={campaign.name}
        description={`${campaign.industry} · ${campaign.geography}`}
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => archive.mutate({ campaignId: id })} disabled={archive.isPending}>
              <Archive className="h-4 w-4" /> Archive
            </Button>
            <Button onClick={() => runDiscovery.mutate({ campaignId: id })} disabled={runDiscovery.isPending || campaign.status === "archived"}>
              {runDiscovery.isPending ? <Spinner /> : <Radar className="h-4 w-4" />} Run discovery
            </Button>
          </div>
        }
      />

      <Card className="mb-6">
        <CardContent className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-4">
          <div className="col-span-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{campaign.status}</Badge>
            {campaign.icpId ? <Badge variant="success">ICP linked</Badge> : <Badge variant="warning">No ICP — discovery untargeted</Badge>}
          </div>
          <ScorePill label="Prospects" value={rows.length} />
          <ScorePill label="Target" value={campaign.prospectTarget} />
        </CardContent>
      </Card>

      {result && <div className="mb-4 rounded-lg border bg-muted/40 p-3 text-sm">{result}</div>}

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-4 font-semibold">Discovered prospects</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No prospects yet. Run discovery to populate this campaign.</p>
          ) : (
            <div className="divide-y">
              {rows.map((p) => (
                <div key={p.id} className="flex items-center justify-between py-2">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{p.company}</span>
                    <OriginBadge origin={p.origin} />
                    {p.hasContact ? <Badge variant="muted">contact</Badge> : null}
                    {p.sourceUrl ? (
                      <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm text-muted-foreground">{p.status}</span>
                    <span className="tabular-nums font-semibold text-success">{p.overallScore}</span>
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/app/prospects/${p.id}`}>Open</Link>
                    </Button>
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
