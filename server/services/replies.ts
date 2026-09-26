import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";
import { REPLY_LABELS, FOLLOWUP_TRIGGER_LABELS, type ReplyLabel } from "../../shared/const";
import { canonicalDomain } from "./providers";
import { enqueueJob } from "./jobs";

export interface InboundEmailInput {
  // A workspace may be omitted when we can only resolve it from the reference.
  workspaceId?: string | null;
  referenceId?: string | null;
  fromAddress: string;
  toAddress?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  eventType: "replied" | "unsubscribed" | "bounced" | "opened" | "failed";
  dedupeKey?: string | null;
  metadata?: unknown;
}

export interface InboundResult {
  duplicate: boolean;
  outreachId: string | null;
  prospectId: string | null;
  classification: ReplyLabel | null;
  opportunityId: string | null;
  suppressed: boolean;
}

const POSITIVE_LABELS: ReplyLabel[] = ["positive", "interested"];

async function resolveOutreach(
  db: NonNullable<ReturnType<typeof getDb>>,
  input: InboundEmailInput,
) {
  if (input.referenceId) {
    const [byRef] = await db
      .select()
      .from(schema.outreachMessages)
      .where(eq(schema.outreachMessages.referenceId, input.referenceId))
      .limit(1);
    if (byRef) return byRef;
  }
  // Fall back to matching the recipient address within the workspace.
  const email = input.fromAddress.toLowerCase();
  const rows = await db
    .select()
    .from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.recipientEmail, email))
    .limit(1);
  return rows[0] ?? null;
}

export async function classifyReply(text: string): Promise<ReplyLabel> {
  // Imported lazily to avoid a hard dependency cycle with providers at module load.
  const { getAIProvider } = await import("./providers");
  try {
    const { label } = await getAIProvider().classify(text, REPLY_LABELS);
    return (REPLY_LABELS as readonly string[]).includes(label)
      ? (label as ReplyLabel)
      : "unknown";
  } catch {
    return "unknown";
  }
}

/** Ingest an inbound email/reply event: dedupe, classify, act on it. */
export async function ingestEmailEvent(input: InboundEmailInput): Promise<InboundResult> {
  const db = getDb();
  if (!db) throw new Error("Database unavailable.");

  const outreach = await resolveOutreach(db, input);
  const workspaceId =
    input.workspaceId ?? outreach?.workspaceId ?? null;
  if (!workspaceId) {
    return {
      duplicate: false,
      outreachId: null,
      prospectId: null,
      classification: null,
      opportunityId: null,
      suppressed: false,
    };
  }

  const dedupeKey = (
    input.dedupeKey ??
    `${input.eventType}:${input.fromAddress}:${outreach?.id ?? "x"}:${hashish(input.bodyText ?? "")}`
  ).slice(0, 128);

  const inserted = await db
    .insert(schema.emailEvents)
    .ignore()
    .values({
      id: nanoid(),
      workspaceId,
      outreachId: outreach?.id ?? null,
      prospectId: outreach?.prospectId ?? null,
      eventType: input.eventType,
      direction: "inbound",
      fromAddress: input.fromAddress,
      toAddress: input.toAddress ?? null,
      subject: input.subject ?? null,
      bodyText: input.bodyText ?? null, // full original body preserved (audit P1)
      dedupeKey,
      metadata: input.metadata ?? null,
    });
  if ((inserted[0] as { affectedRows?: number }).affectedRows === 0) {
    return {
      duplicate: true,
      outreachId: outreach?.id ?? null,
      prospectId: outreach?.prospectId ?? null,
      classification: null,
      opportunityId: null,
      suppressed: false,
    };
  }

  let classification: ReplyLabel | null = null;
  let suppressed = false;
  let opportunityId: string | null = null;

  if (input.eventType === "replied" && input.bodyText) {
    classification = await classifyReply(input.bodyText);
    await db
      .update(schema.emailEvents)
      .set({ classification })
      .where(and(eq(schema.emailEvents.workspaceId, workspaceId), eq(schema.emailEvents.dedupeKey, dedupeKey)));
  }

  if (outreach) {
    await db
      .update(schema.outreachMessages)
      .set({ status: input.eventType === "replied" ? "replied" : input.eventType === "bounced" ? "bounced" : "sent" })
      .where(eq(schema.outreachMessages.id, outreach.id));
  }

  const prospectId = outreach?.prospectId ?? null;
  if (prospectId) {
    // Unsubscribe / hard rejection → suppress and stop.
    if (input.eventType === "unsubscribed" || classification === "unsubscribe") {
      suppressed = true;
      await addSuppression(db, workspaceId, input.fromAddress, "unsubscribe");
      await db
        .update(schema.prospects)
        .set({ status: "suppressed" })
        .where(eq(schema.prospects.id, prospectId));
    } else if (classification === "not_interested") {
      await db
        .update(schema.prospects)
        .set({ status: "not_interested" })
        .where(eq(schema.prospects.id, prospectId));
    } else if (POSITIVE_LABELS.includes(classification!) || classification === "question") {
      opportunityId = await ensureOpportunity(db, workspaceId, prospectId, null);
      await db
        .update(schema.prospects)
        .set({ status: "opportunity" })
        .where(eq(schema.prospects.id, prospectId));
    } else if (classification) {
      await db
        .update(schema.prospects)
        .set({ status: "interested" })
        .where(eq(schema.prospects.id, prospectId));
    }

    // Autonomous follow-up. Only when the workspace opted in AND the reply
    // actually invites a next move. Never on unsubscribe / not_interested /
    // out_of_office. Debounced 60s so a burst of inbound events coalesces.
    if (
      input.eventType === "replied" &&
      classification &&
      (FOLLOWUP_TRIGGER_LABELS as readonly string[]).includes(classification)
    ) {
      const { isAutopilotEnabled } = await import("../db");
      if (await isAutopilotEnabled(workspaceId)) {
        await enqueueJob({
          workspaceId,
          type: "reply.followup",
          payload: {
            prospectId,
            outreachId: outreach?.id ?? null,
            lastReplyBody: input.bodyText ?? "",
            classification,
          },
          runAfter: new Date(Date.now() + 60_000),
        });
      }
    }
  }

  return {
    duplicate: false,
    outreachId: outreach?.id ?? null,
    prospectId,
    classification,
    opportunityId,
    suppressed,
  };
}

export async function handleUnsubscribeByRef(ref: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const [outreach] = await db
    .select()
    .from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.referenceId, ref))
    .limit(1);
  if (!outreach) return false;
  await addSuppression(db, outreach.workspaceId, outreach.recipientEmail, "unsubscribe_link");
  await db
    .update(schema.prospects)
    .set({ status: "suppressed" })
    .where(eq(schema.prospects.id, outreach.prospectId));
  await db
    .insert(schema.emailEvents)
    .ignore()
    .values({
      id: nanoid(),
      workspaceId: outreach.workspaceId,
      outreachId: outreach.id,
      prospectId: outreach.prospectId,
      eventType: "unsubscribed",
      direction: "inbound",
      fromAddress: outreach.recipientEmail,
      dedupeKey: `unsub:${outreach.id}`.slice(0, 128),
    });
  return true;
}

async function addSuppression(
  db: NonNullable<ReturnType<typeof getDb>>,
  workspaceId: string,
  email: string,
  reason: string,
): Promise<void> {
  const lowered = email.toLowerCase();
  await db
    .insert(schema.suppressions)
    .ignore()
    .values({
      id: nanoid(),
      workspaceId,
      email: lowered,
      domain: canonicalDomain(lowered.split("@")[1] ?? ""),
      reason,
    });
}

async function ensureOpportunity(
  db: NonNullable<ReturnType<typeof getDb>>,
  workspaceId: string,
  prospectId: string,
  sourceReplyId: string | null,
): Promise<string> {
  const [existing] = await db
    .select()
    .from(schema.opportunities)
    .where(
      and(
        eq(schema.opportunities.workspaceId, workspaceId),
        eq(schema.opportunities.prospectId, prospectId),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(schema.opportunities)
      .set({ stage: existing.stage === "open" ? "responded" : existing.stage })
      .where(eq(schema.opportunities.id, existing.id));
    return existing.id;
  }
  const id = nanoid();
  await db.insert(schema.opportunities).values({
    id,
    workspaceId,
    prospectId,
    stage: "responded",
    sourceReplyId,
  });
  return id;
}

function hashish(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
