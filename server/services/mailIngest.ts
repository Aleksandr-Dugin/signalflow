import { and, eq } from "drizzle-orm";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";
import { env } from "../_core/env";
import { enqueueJob } from "./jobs";
import { getUsableMailbox } from "./mailOAuth";
import { ingestEmailEvent, type InboundEmailInput } from "./replies";

/**
 * Inbound polling for linked mailboxes (the Gmail/Microsoft equivalent of an ESP
 * inbound webhook). There is no push here the way there is for an ESP: Gmail and
 * Graph only hand us new mail when we ask, so this runs as a periodic job.
 *
 * It is inert by construction: a mailbox only reaches status `connected` once the
 * operator has verified the OAuth app (MAILBOX_DELIVERY_VERIFIED), and this polls
 * connected mailboxes. Everything below maps a provider message into the same
 * canonical InboundEmailInput the ESP webhooks use, so dedupe, classification and
 * opportunity advance all live in one place (replies.ingestEmailEvent) rather than
 * being re-implemented per channel.
 */

type FetchLike = typeof fetch;

function headerValue(headers: { name?: string; value?: string }[] | undefined, wanted: string): string | null {
  if (!Array.isArray(headers)) return null;
  const found = headers.find((h) => (h.name ?? "").toLowerCase() === wanted.toLowerCase());
  return found?.value ? String(found.value) : null;
}

/** Pull a bare address out of a `Name <addr>` header; fall back to the raw value. */
function extractAddress(value: string | null): string | null {
  if (!value) return null;
  const m = /<([^>]+)>/.exec(value);
  return (m ? m[1] : value).trim() || null;
}

function decodeB64Url(data: string | null | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/** Gmail `users.messages.get` (format=full) payload → canonical inbound input. */
export function parseGmailMessage(json: any): InboundEmailInput | null {
  const headers: { name?: string; value?: string }[] = json?.payload?.headers ?? [];
  const from = extractAddress(headerValue(headers, "From"));
  if (!from) return null;
  let bodyText = decodeB64Url(json?.payload?.body?.data);
  if (!bodyText) {
    const plain = (json?.payload?.parts ?? []).find((p: any) => p.mimeType === "text/plain");
    bodyText = decodeB64Url(plain?.body?.data) || decodeB64Url(json?.snippet);
  }
  const unsub = headerValue(headers, "List-Unsubscribe");
  const isUnsub = /^unsubscribe$/i.test(bodyText.trim()) || Boolean(unsub && /one-click/i.test(headerValue(headers, "List-Unsubscribe-Post") ?? ""));
  return {
    workspaceId: null, // resolved from referenceId / sender inside ingest
    referenceId: headerValue(headers, "X-SignalFlow-Ref"),
    fromAddress: from,
    toAddress: extractAddress(headerValue(headers, "To")),
    subject: headerValue(headers, "Subject"),
    bodyText: bodyText.slice(0, 200_000),
    eventType: isUnsub ? "unsubscribed" : "replied",
    dedupeKey: json?.id ? `gmail:${json.id}` : null,
    metadata: { provider: "mailbox-gmail" },
  };
}

/** Microsoft Graph message JSON → canonical inbound input. */
export function parseGraphMessage(json: any): InboundEmailInput | null {
  const from = json?.from?.emailAddress?.address ?? null;
  if (!from) return null;
  const headers: { name?: string; value?: string }[] = json?.internetMessageHeaders ?? [];
  const body: string = json?.body?.content ?? "";
  const isUnsub = /^unsubscribe$/i.test(body.trim());
  return {
    workspaceId: null,
    referenceId: headerValue(headers, "X-SignalFlow-Ref"),
    fromAddress: from,
    toAddress: json?.toRecipients?.[0]?.emailAddress?.address ?? null,
    subject: json?.subject ?? null,
    bodyText: body.slice(0, 200_000),
    eventType: isUnsub ? "unsubscribed" : "replied",
    dedupeKey: json?.id ? `graph:${json.id}` : null,
    metadata: { provider: "mailbox-graph" },
  };
}

async function pollGmail(accessToken: string, fetchImpl: FetchLike): Promise<InboundEmailInput[]> {
  const listUrl =
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?includeSpamTrash=false&maxResults=25&q=" +
    encodeURIComponent("is:unread");
  const listRes = await fetchImpl(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!listRes.ok) throw new Error(`Gmail list failed (${listRes.status})`);
  const list: any = await listRes.json();
  const ids: string[] = (list?.messages ?? []).map((m: any) => m.id).filter(Boolean);
  const inputs: InboundEmailInput[] = [];
  for (const id of ids) {
    const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) continue; // skip one unreadable message rather than abort the batch
    const parsed = parseGmailMessage(await res.json());
    if (parsed) inputs.push(parsed);
  }
  return inputs;
}

async function pollGraph(accessToken: string, fetchImpl: FetchLike): Promise<InboundEmailInput[]> {
  const url =
    "https://graph.microsoft.com/v1.0/me/messages?$top=25&" +
    encodeURIComponent("$filter=isRead eq false") +
    "&$select=id,from,toRecipients,subject,body,internetMessageHeaders";
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Microsoft list failed (${res.status})`);
  const json: any = await res.json();
  const inputs: InboundEmailInput[] = [];
  for (const m of json?.value ?? []) {
    const parsed = parseGraphMessage(m);
    if (parsed) inputs.push(parsed);
  }
  return inputs;
}

/**
 * Poll one workspace's connected mailbox and feed every new message into the shared
 * reply pipeline. Returns how many were ingested. A workspace with no connected
 * mailbox is a silent no-op (returns 0) — this runs on a timer and must not log an
 * error for the normal case of "nothing linked yet".
 */
export async function pollMailbox(workspaceId: string, fetchImpl: FetchLike = fetch): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const [mailboxRow] = await db
    .select({ id: schema.workspaceMailboxes.id })
    .from(schema.workspaceMailboxes)
    .where(and(eq(schema.workspaceMailboxes.workspaceId, workspaceId), eq(schema.workspaceMailboxes.status, "connected")))
    .limit(1);
  if (!mailboxRow) return 0;

  // Reuse the send path's token resolution so refresh logic lives in one place; a
  // mailbox that just became un-usable races to 0 rather than throwing on the timer.
  const usable = await getUsableMailbox(workspaceId, fetchImpl).catch(() => null);
  if (!usable) return 0;

  const inputs = usable.provider === "gmail" ? await pollGmail(usable.accessToken, fetchImpl) : await pollGraph(usable.accessToken, fetchImpl);
  let ingested = 0;
  for (const input of inputs) {
    await ingestEmailEvent({ ...input, workspaceId });
    ingested++;
  }
  if (inputs.length) {
    await db
      .update(schema.workspaceMailboxes)
      .set({ lastInboundCursor: new Date().toISOString(), updatedAt: new Date() })
      .where(eq(schema.workspaceMailboxes.id, mailboxRow.id));
  }
  return ingested;
}

/** Workspaces that currently have a pollable (connected) mailbox, for the scheduler. */
export async function listPollableWorkspaceIds(): Promise<string[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .selectDistinct({ workspaceId: schema.workspaceMailboxes.workspaceId })
    .from(schema.workspaceMailboxes)
    .where(eq(schema.workspaceMailboxes.status, "connected"));
  return rows.map((r) => r.workspaceId);
}

// A lightweight cron for mailbox replies, matching how recurring discovery re-enqueues
// itself: a single interval enqueues one job per workspace that has a connected
// mailbox, and the job worker runs them. Enqueue is per-workspace so an autopilot
// pause still holds this work (runNextJob checks the switch), and a deployment with no
// verified mailboxes has nothing to enqueue — the list query returns empty.
let pollTimer: NodeJS.Timeout | null = null;

export async function enqueueMailboxPolls(): Promise<number> {
  const ids = await listPollableWorkspaceIds();
  for (const workspaceId of ids) {
    await enqueueJob({ workspaceId, type: "mailbox.poll", payload: {} });
  }
  return ids.length;
}

export function startMailboxPoller(): void {
  if (pollTimer) return;
  const ms = Math.max(1, env.mailboxPollIntervalMinutes) * 60_000;
  const tick = () => {
    enqueueMailboxPolls().catch((err) => console.error("[mailbox] poll enqueue failed:", err));
  };
  tick();
  pollTimer = setInterval(tick, ms);
  pollTimer.unref?.();
}

export function stopMailboxPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
