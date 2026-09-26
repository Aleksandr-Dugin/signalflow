import { and, eq, or } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";
import { env } from "../_core/env";
import { enforceFeature, enforceLimit, monthlyUsageCount, recordUsage } from "./entitlements";
import { getEmailProvider, type SendResult } from "./email";
import { canonicalDomain } from "./providers";

export class OutreachError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export interface SendOutreachInput {
  workspaceId: string;
  prospectId: string;
  subject: string;
  body: string;
  personalizationId?: string | null;
  idempotencyKey: string;
}

export interface SendOutreachResult {
  outreachId: string;
  status: "sent" | "queued" | "suppressed" | "failed";
  simulated: boolean;
  alreadyProcessed: boolean;
}

function unsubscribeUrl(referenceId: string): string {
  const base = env.publicUrl.replace(/\/$/, "");
  return `${base}/api/replies/unsubscribe?ref=${encodeURIComponent(referenceId)}`;
}

export async function isSuppressed(workspaceId: string, email: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const domain = canonicalDomain(email.split("@")[1] ?? "");
  const rows = await db
    .select({ id: schema.suppressions.id })
    .from(schema.suppressions)
    .where(
      and(
        eq(schema.suppressions.workspaceId, workspaceId),
        or(
          eq(schema.suppressions.email, email.toLowerCase()),
          domain ? eq(schema.suppressions.domain, domain) : undefined,
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function sendOutreachEmail(
  input: SendOutreachInput,
): Promise<SendOutreachResult> {
  const db = getDb();
  if (!db) throw new OutreachError("Database unavailable.", "DB_UNAVAILABLE");

  // Server-side entitlement enforcement (audit P0 fix): the client cannot skip it.
  await enforceFeature(input.workspaceId, "outreach");
  const sentThisMonth = await monthlyUsageCount(input.workspaceId, "outreach_sent");
  await enforceLimit(input.workspaceId, "outreachPerMonth", sentThisMonth, 1);

  const [prospect] = await db
    .select()
    .from(schema.prospects)
    .where(
      and(eq(schema.prospects.id, input.prospectId), eq(schema.prospects.workspaceId, input.workspaceId)),
    )
    .limit(1);
  if (!prospect) throw new OutreachError("Prospect not found.", "NOT_FOUND");

  let email: string | null = null;
  let toName = prospect.companyId;
  if (prospect.contactId) {
    const [contact] = await db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.id, prospect.contactId))
      .limit(1);
    if (contact?.email) {
      email = contact.email;
      toName = contact.name || contact.email;
    }
  }
  if (!email) {
    throw new OutreachError(
      "This prospect has no verified contact email. Add a contact before outreach.",
      "NO_CONTACT",
    );
  }

  const referenceId = nanoid(16);

  // Idempotent insert: a retried send with the same key never double-emails.
  const outreachId = nanoid();
  const inserted = await db
    .insert(schema.outreachMessages)
    .ignore()
    .values({
      id: outreachId,
      workspaceId: input.workspaceId,
      prospectId: input.prospectId,
      recipientEmail: email,
      recipientName: toName,
      subject: input.subject,
      body: input.body,
      status: "sending",
      personalizationId: input.personalizationId ?? null,
      idempotencyKey: input.idempotencyKey,
      referenceId,
    });
  if ((inserted[0] as { affectedRows?: number }).affectedRows === 0) {
    const [existing] = await db
      .select()
      .from(schema.outreachMessages)
      .where(
        and(
          eq(schema.outreachMessages.workspaceId, input.workspaceId),
          eq(schema.outreachMessages.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    return {
      outreachId: existing?.id ?? outreachId,
      status: (existing?.status as SendOutreachResult["status"]) ?? "sent",
      simulated: existing?.status === "sent" ? false : false,
      alreadyProcessed: true,
    };
  }

  if (await isSuppressed(input.workspaceId, email)) {
    await db
      .update(schema.outreachMessages)
      .set({ status: "suppressed" })
      .where(eq(schema.outreachMessages.id, outreachId));
    await db
      .update(schema.prospects)
      .set({ status: "suppressed" })
      .where(eq(schema.prospects.id, input.prospectId));
    return { outreachId, status: "suppressed", simulated: false, alreadyProcessed: false };
  }

  try {
    const result: SendResult = await getEmailProvider().send({
      toName,
      toEmail: email,
      subject: input.subject,
      text: input.body,
      referenceId,
      unsubscribeUrl: unsubscribeUrl(referenceId),
    });
    await db
      .update(schema.outreachMessages)
      .set({
        status: "sent",
        providerMessageId: result.providerMessageId,
        sentAt: new Date(),
        approvedAt: new Date(),
        error: result.simulated ? "simulated (mock email provider)" : null,
      })
      .where(eq(schema.outreachMessages.id, outreachId));
    await db
      .update(schema.prospects)
      .set({ status: "contacted" })
      .where(eq(schema.prospects.id, input.prospectId));
    await recordUsage(input.workspaceId, "outreach_sent", 1);
    return {
      outreachId,
      status: "sent",
      simulated: result.simulated,
      alreadyProcessed: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "send failed";
    await db
      .update(schema.outreachMessages)
      .set({ status: "failed", error: message })
      .where(eq(schema.outreachMessages.id, outreachId));
    throw new OutreachError(message, "SEND_FAILED");
  }
}

export function makeIdempotencyKey(workspaceId: string, prospectId: string, personalizationId?: string | null): string {
  return `${workspaceId}:${prospectId}:${personalizationId ?? "manual"}:v1`.slice(0, 64);
}
