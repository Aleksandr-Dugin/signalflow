import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Sparkles, Send, ArrowLeft, ExternalLink, Mail } from "lucide-react";
import { trpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Spinner, EmptyState, OriginBadge, ScorePill } from "@/components/common";

function ContactCard({
  prospectId,
  contact,
}: {
  prospectId: string;
  contact?: { name: string; title?: string | null; email: string; verified: boolean } | null;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(!contact);
  const [name, setName] = useState(contact?.name ?? "");
  const [title, setTitle] = useState(contact?.title ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");

  useEffect(() => {
    setName(contact?.name ?? "");
    setTitle(contact?.title ?? "");
    setEmail(contact?.email ?? "");
    setEditing(!contact);
  }, [contact]);

  const save = trpc.contact.upsert.useMutation({
    onSuccess: (c) => {
      toast.success(c.verified ? "Contact saved · domain verified" : "Contact saved · domain not verified");
      setEditing(false);
      void utils.prospect.detail.invalidate();
      void utils.opportunity.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (!editing && contact) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Contact</h3>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
          </div>
          <div className="text-sm">{contact.name}{contact.title ? ` — ${contact.title}` : ""}</div>
          <div className="text-sm text-muted-foreground">{contact.email || "No email"}</div>
          <Badge variant={contact.verified ? "success" : "muted"} className="mt-2">{contact.verified ? "verified" : "unverified"}</Badge>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <h3 className="font-semibold">{contact ? "Edit contact" : "Add contact"}</h3>
        <p className="text-xs text-muted-foreground">
          Live discovery finds companies, not people yet — add the decision-maker's email to unlock outreach.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="c-name">Name</Label>
          <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="c-title">Title (optional)</Label>
          <Input id="c-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Head of Sales" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="c-email">Email</Label>
          <Input id="c-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@company.com" />
        </div>
        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            onClick={() => save.mutate({ prospectId, name: name.trim(), title: title.trim() || undefined, email: email.trim() })}
            disabled={!name.trim() || !email.trim() || save.isPending}
          >
            {save.isPending ? <Spinner /> : <Mail className="h-4 w-4" />} Save contact
          </Button>
          {contact ? <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProspectDetail({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const detail = trpc.prospect.detail.useQuery({ prospectId: id });
  const thread = trpc.prospect.thread.useQuery({ prospectId: id, limit: 30 });

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);

  useEffect(() => {
    const d = detail.data?.latestDraft;
    if (d && !subject) {
      setSubject(d.subject);
      setBody(`${d.openingLine}\n\n${d.body}\n\n${d.cta}`);
      setDraftId(d.id ?? null);
    }
  }, [detail.data, subject]);

  const personalize = trpc.prospect.personalize.useMutation({
    onSuccess: (p) => {
      setSubject(p.subject);
      setBody(`${p.openingLine}\n\n${p.body}\n\n${p.cta}`);
      setDraftId(p.id ?? null);
      toast.success(`Draft ready (${p.provider})`);
      void utils.prospect.detail.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const outreach = trpc.prospect.outreach.useMutation({
    onSuccess: () => {
      toast.success("Outreach sent");
      void utils.prospect.detail.invalidate();
      void utils.opportunity.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (detail.isLoading) {
    return <div className="grid place-items-center py-20"><Spinner className="h-6 w-6 text-primary" /></div>;
  }
  const p = detail.data;
  if (!p) {
    return (
      <div>
        <Link href="/app/campaigns" className="text-sm text-muted-foreground"><ArrowLeft className="mr-1 inline h-3 w-3" />Back</Link>
        <EmptyState title="Prospect not found" />
      </div>
    );
  }

  return (
    <div>
      <Link href={`/app/campaigns/${p.campaignId}`} className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3 w-3" /> Back to campaign
      </Link>
      <PageHeader
        title={p.company}
        description={p.domain}
        action={<OriginBadge origin={p.origin} />}
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <div className="space-y-4">
          <Card>
            <CardContent className="grid grid-cols-3 gap-4 p-6">
              <ScorePill label="Fit" value={p.fitScore} />
              <ScorePill label="Overall" value={p.overallScore} />
              <ScorePill label="Confidence" value={p.confidence} />
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-6">
              <h3 className="mb-2 font-semibold">About</h3>
              <p className="text-sm text-muted-foreground">{p.description || "No description."}</p>
              {p.sourceUrl ? (
                <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline">
                  <ExternalLink className="h-3 w-3" /> Source
                </a>
              ) : null}
            </CardContent>
          </Card>

          <ContactCard prospectId={id} contact={p.contact ?? null} />

          {p.signals.length > 0 && (
            <Card>
              <CardContent className="p-6">
                <h3 className="mb-3 font-semibold">Buying signals</h3>
                <div className="space-y-3">
                  {p.signals.map((s) => (
                    <div key={s.id} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-sm">{s.type}</span>
                        <Badge variant="muted">imp. {s.importance}</Badge>
                      </div>
                      <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                        {s.evidence.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {p.reasons.length > 0 && (
            <Card>
              <CardContent className="p-6">
                <h3 className="mb-2 font-semibold">Why it qualifies</h3>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {p.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <Card>
          <CardContent className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold">Outreach</h3>
              <Button size="sm" variant="secondary" onClick={() => personalize.mutate({ prospectId: id })} disabled={personalize.isPending}>
                {personalize.isPending ? <Spinner /> : <Sparkles className="h-4 w-4" />} Personalize
              </Button>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="subj">Subject</Label>
                <Input id="subj" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Email subject" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="body">Message</Label>
                <Textarea id="body" value={body} onChange={(e) => setBody(e.target.value)} rows={12} placeholder="Your personalized message" />
              </div>
              <Button
                className="w-full"
                onClick={() => outreach.mutate({ prospectId: id, subject, body, personalizationId: draftId })}
                disabled={!subject || !body || !p.contact?.email || outreach.isPending}
              >
                {outreach.isPending ? <Spinner /> : <Send className="h-4 w-4" />} Send outreach
              </Button>
              {!p.contact?.email && <p className="text-xs text-muted-foreground">A contact email is required to send outreach.</p>}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardContent className="p-6">
            <h3 className="mb-3 font-semibold">Conversation</h3>
            {(thread.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No messages yet. Personalize + send to start the thread.</p>
            ) : (
              <ol className="space-y-3">
                {(thread.data ?? []).map((m, i) => (
                  <li key={i} className={"rounded-lg border p-3 " + (m.direction === "inbound" ? "bg-muted/30" : "bg-card")}>
                    <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{m.direction === "inbound" ? "Prospect" : "You"} · {m.subject ?? "(no subject)"}</span>
                      <span>{new Date(m.at).toLocaleString()}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-sm">{(m.body ?? "").slice(0, 1500)}</div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
