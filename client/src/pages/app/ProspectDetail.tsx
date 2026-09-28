import { useEffect, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Sparkles, Send, ArrowLeft, ExternalLink, Mail, Phone, Search, UserCheck, Ban } from "lucide-react";
import { trpc } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader, Spinner, EmptyState, OriginBadge, ScorePill } from "@/components/common";

function ContactCard({
  prospectId,
  contact,
  live,
}: {
  prospectId: string;
  contact?: {
    name: string;
    title?: string | null;
    email: string;
    verified: boolean;
    origin?: "manual" | "page" | "provider";
    phone?: string | null;
    socialUrl?: string | null;
    sourceUrl?: string | null;
  } | null;
  // Only a real company has real pages to read. Demo prospects must never be
  // offered a search that would "find" an address belonging to whoever now owns
  // the invented domain.
  live: boolean;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(!contact);
  const [name, setName] = useState(contact?.name ?? "");
  const [title, setTitle] = useState(contact?.title ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");

  useEffect(() => {
    setName(contact?.name ?? "");
    setTitle(contact?.title ?? "");
    setEmail(contact?.email ?? "");
    setPhone(contact?.phone ?? "");
    setEditing(!contact);
  }, [contact]);

  // Asked rather than assumed: the two searches cost different things (scraper
  // credits vs a per-record vendor bill), and a button that can only throw an
  // error is worse than no button at all.
  const capabilities = trpc.contact.capabilities.useQuery(undefined, { staleTime: 60_000 });
  // Used only for the phone field's wording here; the channel card queries it too.
  const channelCaps = trpc.channel.capabilities.useQuery(undefined, { staleTime: 60_000 });

  const save = trpc.contact.upsert.useMutation({
    onSuccess: (c) => {
      toast.success(c.verified ? "Contact saved · domain verified" : "Contact saved · domain not verified");
      setEditing(false);
      void utils.prospect.detail.invalidate();
      void utils.opportunity.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const search = trpc.contact.enrich.useMutation({
    onSuccess: (r) => {
      if (r.contact) {
        toast.success(
          r.contact.name
            ? `Found ${r.contact.name} · ${r.contact.email}`
            : `Found ${r.contact.email} (a shared mailbox — no person named on the page)`,
        );
        setEditing(false);
        void utils.prospect.detail.invalidate();
        void utils.opportunity.list.invalidate();
      } else {
        // Say so plainly. "Nothing found" is information, and hiding it behind a
        // spinner or a silent no-op is how an operator ends up trusting a contact
        // that was never there.
        toast.info("They publish no address we can use — add one below.");
      }
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
          <div className="text-sm">
            {contact.name || "Shared mailbox"}{contact.title ? ` — ${contact.title}` : ""}
          </div>
          <div className="text-sm text-muted-foreground">{contact.email || "No email"}</div>
          {contact.phone ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <Phone className="h-3.5 w-3.5 shrink-0" />
              <span className="font-mono">{contact.phone}</span>
              {/* Honest about the gap: recorded, but nothing here can dial it unprompted. */}
              <span className="text-xs">recorded only - we can reply here on WhatsApp only if they message us first</span>
            </div>
          ) : null}
          {contact.socialUrl ? (
            <a
              href={contact.socialUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" /> Profile
            </a>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant={contact.verified ? "success" : "muted"}>{contact.verified ? "verified" : "unverified"}</Badge>
            {contact.origin === "provider" ? <Badge variant="outline">bought lookup</Badge> : null}
          </div>
          {/* Provenance differs by origin and the difference matters: a page link can
              be opened and checked by eye, the API call behind a bought address cannot,
              so the two must not wear the same label. */}
          {contact.origin === "provider" ? (
            <p className="mt-2 text-xs text-muted-foreground">
              From a paid data provider - the vendor's claim about this address, not a page we read.
            </p>
          ) : contact.sourceUrl ? (
            <a
              href={contact.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" /> Published on this page
            </a>
          ) : contact.origin === "manual" ? (
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <UserCheck className="h-3 w-3" /> Added by hand
            </p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <h3 className="font-semibold">{contact ? "Edit contact" : "Add contact"}</h3>
        <p className="text-xs text-muted-foreground">
          {live
            ? "Discovery reads this company's own contact and team pages. If it came back empty, add the decision-maker here."
            : "This is a demo company with no real website, so a contact can only be typed in."}
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
        <div className="space-y-1.5">
          <Label htmlFor="c-phone">Phone (optional)</Label>
          <Input
            id="c-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+1 415 555 0158"
          />
          {channelCaps.data?.whatsapp.sender ? (
            <p className="text-xs text-muted-foreground">
              Also the number WhatsApp is looked up by, if this person messages us there first.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">Kept for reference - WhatsApp messaging is not configured.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            onClick={() =>
              save.mutate({
                prospectId,
                name: name.trim(),
                title: title.trim() || undefined,
                email: email.trim(),
                phone: phone.trim() || undefined,
              })
            }
            disabled={!name.trim() || !email.trim() || save.isPending}
          >
            {save.isPending ? <Spinner /> : <Mail className="h-4 w-4" />} Save contact
          </Button>
          {live && capabilities.data?.pages ? (
            <Button
              variant="outline"
              onClick={() => search.mutate({ prospectId })}
              disabled={search.isPending}
              title="Search their /contact, /team and /about pages for a published address (uses scraper credits)"
            >
              {search.isPending ? <Spinner /> : <Search className="h-4 w-4" />} Search their site
            </Button>
          ) : null}
          {live && capabilities.data?.enrichment ? (
            <Button
              variant="outline"
              onClick={() => search.mutate({ prospectId, paid: true })}
              disabled={search.isPending}
              title={`Ask ${capabilities.data.enrichment} for a named decision-maker. Billed per record by your own provider key.`}
            >
              {search.isPending ? <Spinner /> : <Search className="h-4 w-4" />}
              Buy a lookup ({capabilities.data.enrichment})
            </Button>
          ) : null}
          {contact ? <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * How a channel permission came to exist, in the words the operator needs: a row
 * here is evidence that a person chose this channel, so its provenance is shown
 * next to it rather than hidden. Unknown sources are printed verbatim rather than
 * dressed up.
 */
const CONSENT_LABELS: Record<string, string> = {
  "telegram.start": "Opened the chat link we sent",
  "telegram.inbound": "Messaged the bot first",
  "whatsapp.inbound": "Messaged our number first",
};

type ChannelIdentityRow = {
  id: string;
  channel: "telegram" | "whatsapp";
  handle: string | null;
  consentSource: string;
  consentAt: string;
  revokedAt: string | null;
  lastInboundAt: string | null;
  canSend: boolean;
  whyNot: string | null;
  senderConfigured: boolean;
};

function ChannelRow({ prospectId, row }: { prospectId: string; row: ChannelIdentityRow }) {
  const utils = trpc.useUtils();
  const [text, setText] = useState("");

  const send = trpc.channel.send.useMutation({
    onSuccess: (res) => {
      // Three outcomes, three sentences. The provider records a message it could
      // not deliver, so the toast has to be the place where that distinction survives.
      if (res.error) toast.error(`Not delivered - ${res.error}`);
      else if (res.simulated) toast.warning(`Logged, not delivered - this server has no ${row.channel} sender configured.`);
      else toast.success(`Sent on ${row.channel}`);
      setText("");
      void utils.prospect.thread.invalidate();
      void utils.channel.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const revoke = trpc.channel.revoke.useMutation({
    onSuccess: () => {
      toast.success("Permission removed - we will not write there again.");
      void utils.channel.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium capitalize">{row.channel}</span>
        {row.canSend ? (
          <Badge variant="success">{row.channel === "whatsapp" ? "In their window" : "They opened this"}</Badge>
        ) : (
          <Badge variant="warning">Cannot send</Badge>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {CONSENT_LABELS[row.consentSource] ?? row.consentSource} · {new Date(row.consentAt).toLocaleDateString()}
        {row.lastInboundAt ? ` · last wrote ${new Date(row.lastInboundAt).toLocaleDateString()}` : ""}
        {row.handle ? ` · ${row.handle}` : ""}
      </p>
      {row.whyNot ? (
        <p className="mt-2 rounded-[3px] border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-xs text-amber-500">{row.whyNot}</p>
      ) : null}
      {row.canSend && !row.senderConfigured ? (
        <p className="mt-2 rounded-[3px] border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-xs text-amber-500">
          Nothing is configured to deliver on {row.channel}, so sending here will be recorded as a simulation.
        </p>
      ) : null}
      <div className="mt-2 space-y-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder={`Reply on ${row.channel} - this is a conversation, not a campaign`}
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="flex-1"
            disabled={!text.trim() || !row.canSend || send.isPending}
            onClick={() => send.mutate({ prospectId, channel: row.channel, text })}
          >
            {send.isPending ? <Spinner /> : <Send className="h-4 w-4" />} Send
          </Button>
          <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ identityId: row.id })}>
            <Ban className="h-4 w-4" /> Revoke
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Neither Telegram nor WhatsApp allows cold messaging, so this card can only ever
 * show channels a person already chose. It reports permission and where it came
 * from; it deliberately offers no way to start a conversation with someone who has
 * not written to us there.
 */
function ChannelsCard({ prospectId }: { prospectId: string }) {
  const caps = trpc.channel.capabilities.useQuery(undefined, { staleTime: 60_000 });
  const identities = trpc.channel.list.useQuery({ prospectId });
  const rows = identities.data ?? [];

  const telegram = caps.data?.telegram;
  const whatsapp = caps.data?.whatsapp;
  const configured = Boolean(
    telegram && whatsapp && (telegram.sender || telegram.inbound || telegram.entryPoint || whatsapp.sender || whatsapp.inbound || whatsapp.entryPoint),
  );
  // No channel credentials and no permissions: messenger outreach does not exist in
  // this deployment, so say nothing rather than advertise an empty section.
  if (!configured && rows.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-6">
        <h3 className="mb-1 font-semibold">Messenger channels</h3>
        <p className="text-xs text-muted-foreground">
          Telegram and WhatsApp only allow messaging a person who contacted us first. A channel appears here when they do.
        </p>
        <div className="mt-3 space-y-3">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No one has written to us on a messenger yet. Send an email first - a tracked chat link in it is what creates this.
            </p>
          ) : (
            rows.map((r) => <ChannelRow key={r.id} prospectId={prospectId} row={r} />)
          )}
          {configured && telegram && !telegram.inbound && telegram.sender ? (
            <p className="rounded-[3px] border border-destructive/60 bg-destructive/10 px-2 py-1 text-xs text-destructive">
              Telegram can send but cannot receive: no webhook secret is set, so nobody can ever grant permission and this channel will stay empty.
            </p>
          ) : null}
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
    onSuccess: (res) => {
      // Say which of these happened. A suppressed send and a send through the mock
      // provider are recorded with the same "sent" status as a delivered one, so a
      // single success toast here would claim an email nobody ever received.
      if (res.status === "suppressed") {
        toast.warning("Not sent - this address asked not to be contacted again.");
      } else if (res.simulated) {
        toast.warning("Not delivered - SMTP is not configured, so this send was simulated.");
      } else {
        toast.success("Outreach sent");
      }
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

          <ContactCard prospectId={id} contact={p.contact ?? null} live={p.origin === "live"} />

          <ChannelsCard prospectId={id} />

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
                {(thread.data ?? []).map((m, i) => {
                  // A message that simply went out needs no label. Anything else -
                  // blocked by the suppression list, rejected by the provider, or
                  // never attempted because SMTP is not configured - is a fact about
                  // what the loop did, and has to be readable in the history.
                  const delivered = m.status === "sent" || m.status === "delivered" || m.status === "replied";
                  const flagged = m.direction === "outbound" && !delivered;
                  // A chat message and an email are different permissions with different
                  // rules, so the timeline names the medium it happened on.
                  const via = m.channel === "email" ? "" : ` via ${m.channel}`;
                  const headline = m.subject || (m.channel === "email" ? "(no subject)" : "(chat message)");
                  return (
                    <li key={i} className={"rounded-lg border p-3 " + (m.direction === "inbound" ? "bg-muted/30" : "bg-card")}>
                      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                        <span>{m.direction === "inbound" ? "Prospect" : "You"}{via} · {headline}</span>
                        <span>{new Date(m.at).toLocaleString()}</span>
                      </div>
                      <div className="whitespace-pre-wrap text-sm">{(m.body ?? "").slice(0, 1500)}</div>
                      {flagged && (
                        <p className="mt-2 rounded-[3px] border border-amber-500/60 bg-amber-500/10 px-2 py-1 text-xs text-amber-500">
                          Did not go out as a normal send - logged as {m.status ?? "unknown"}.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
