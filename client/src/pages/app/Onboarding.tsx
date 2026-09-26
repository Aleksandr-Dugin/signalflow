import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkles, Save, Plus } from "lucide-react";
import { trpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Spinner } from "@/components/common";
import type { IcpCriteria } from "@shared/types";

const EMPTY_CRITERIA: IcpCriteria = {
  industries: [],
  companyTypes: [],
  companySize: [],
  geographies: [],
  businessModels: [],
  technologies: [],
  likelyProblems: [],
  buyingSignals: [],
  exclusions: [],
  narrative: "",
};

// Comma-separated text <-> string[] helpers for the editable arrays.
const toField = (arr: string[]) => arr.join(", ");
const fromField = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

type ListField = keyof Omit<IcpCriteria, "narrative">;

const LIST_FIELDS: { key: ListField; label: string }[] = [
  { key: "industries", label: "Target industries" },
  { key: "companyTypes", label: "Company types" },
  { key: "companySize", label: "Company sizes" },
  { key: "geographies", label: "Geographies" },
  { key: "businessModels", label: "Business models" },
  { key: "technologies", label: "Technologies" },
  { key: "likelyProblems", label: "Likely problems" },
  { key: "buyingSignals", label: "Buying signals" },
  { key: "exclusions", label: "Exclusions" },
];

export default function Onboarding() {
  const utils = trpc.useUtils();
  const profile = trpc.workspace.profile.useQuery();

  const [service, setService] = useState("");
  const [target, setTarget] = useState("");
  const [geography, setGeography] = useState("");
  const [goals, setGoals] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");

  useEffect(() => {
    const p = profile.data;
    if (!p) return;
    setService(p.serviceDescription ?? "");
    setTarget(p.targetMarket ?? "");
    setGeography(p.geography ?? "");
    setGoals((p as { goals?: string }).goals ?? "");
    setWebsiteUrl((p as { websiteUrl?: string }).websiteUrl ?? "");
  }, [profile.data]);

  const saveProfile = trpc.workspace.setProfile.useMutation({
    onSuccess: () => {
      toast.success("Profile saved");
      void utils.workspace.profile.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const generate = trpc.icp.generate.useMutation({
    onSuccess: (data) => {
      setCriteria(data.criteria);
      toast.success(`ICP generated (${data.source})`);
      void utils.icp.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const saveIcp = trpc.icp.save.useMutation({
    onSuccess: () => {
      toast.success("ICP saved");
      void utils.icp.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const icps = trpc.icp.list.useQuery();
  const [criteria, setCriteria] = useState<IcpCriteria>(EMPTY_CRITERIA);

  function patch<K extends ListField>(key: K, value: string) {
    setCriteria((c) => ({ ...c, [key]: fromField(value) }) as IcpCriteria);
  }

  return (
    <div>
      <PageHeader title="Setup" description="Describe your offer and let SignalFlow build your ideal customer profile." />

      <Card>
        <CardContent className="space-y-4 p-6">
          <h2 className="font-semibold">Your offer</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="service">What service do you provide?</Label>
              <Textarea id="service" value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. Fractional CFO services for Series A SaaS startups" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="target">Target market</Label>
              <Input id="target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. B2B SaaS, seed to Series B" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="geo">Geography</Label>
              <Input id="geo" value={geography} onChange={(e) => setGeography(e.target.value)} placeholder="e.g. United States, Remote" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="goals">Goals (optional)</Label>
              <Input id="goals" value={goals} onChange={(e) => setGoals(e.target.value)} placeholder="e.g. 5 qualified demos per month" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="site">Your website (optional)</Label>
              <Input id="site" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://youragency.com" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => saveProfile.mutate({ serviceDescription: service, targetMarket: target, geography, goals, websiteUrl })}
              disabled={!service || !target || !geography || saveProfile.isPending}
            >
              {saveProfile.isPending ? <Spinner /> : <Save className="h-4 w-4" />} Save profile
            </Button>
            <Button
              variant="secondary"
              onClick={() => generate.mutate({ service, target, geography })}
              disabled={!service || !target || !geography || generate.isPending}
            >
              {generate.isPending ? <Spinner /> : <Sparkles className="h-4 w-4" />} Generate ICP
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Ideal Customer Profile</h2>
            <Button size="sm" variant="outline" onClick={() => saveIcp.mutate({ criteria })} disabled={saveIcp.isPending}>
              {saveIcp.isPending ? <Spinner /> : <Plus className="h-4 w-4" />} Save as ICP
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="narrative">Narrative</Label>
            <Textarea id="narrative" value={criteria.narrative} onChange={(e) => setCriteria((c) => ({ ...c, narrative: e.target.value }))} placeholder="A short description of who you win with" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {LIST_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={f.key}>{f.label}</Label>
                <Input id={f.key} value={toField(criteria[f.key] as string[])} onChange={(e) => patch(f.key, e.target.value)} placeholder="comma, separated, values" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardContent className="p-6">
          <h2 className="mb-3 font-semibold">Saved ICPs</h2>
          {(icps.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">No ICPs yet — generate or save one above.</p>
          ) : (
            <div className="space-y-2">
              {(icps.data ?? []).map((icp) => (
                <div key={icp.id} className="flex items-center justify-between rounded-lg border p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Badge variant="muted">{icp.source}</Badge>
                    <span className="text-muted-foreground">
                      {((icp.criteria as IcpCriteria)?.industries ?? []).slice(0, 4).join(", ") || "No industries set"}
                    </span>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setCriteria(icp.criteria as IcpCriteria)}>Edit</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
