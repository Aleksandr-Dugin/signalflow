// Conversion signals: the only things allowed to move a deal past `responded`
// (docs/ai-agents.md). Three entry points, all idempotent:
//
//   recordCtaClick()     prospect followed a tracked link in one of our emails
//   handleCalendlyEvent() Calendly confirms a meeting exists   -> meeting_booked
//   handleStripeEvent()  Stripe confirms payment was captured  -> won
//
// Every signal is written to email_events under a deterministic dedupeKey first,
// so a replayed webhook changes nothing, and only then mapped onto a stage via
// applySignal(), which refuses to regress or resurrect terminal deals.
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../../drizzle/schema";
import { getDb } from "../_core/database";
import { env } from "../_core/env";
import { resolveOutreach, type InboundEmailInput } from "./replies";
import { applySignal, type ConversionSignal, type OpportunityStage } from "./opportunity";
import type { CtaKind } from "./cta";

export interface ConversionOutcome {
  handled: boolean;
  duplicate?: boolean;
  reason?: string;
  prospectId?: string | null;
  stage?: OpportunityStage | null;
}

const NO_DB: ConversionOutcome = { handled: false, reason: "db_unavailable" };

/** Minimal shape of a drizzle handle; keeps helpers testable without a pool. */
type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * Log funnel evidence and, if the signal authorises it, advance the deal.
 * Returns `duplicate: true` when this exact event was already recorded.
 */
async function recordConversion(
  db: Db,
  args: {
    workspaceId: string;
    prospectId: string;
    outreachId: string | null;
    fromAddress: string | null;
    eventType: "clicked" | "converted";
    providerEvent: string;
    /** One-line human-readable summary; the prospect timeline renders `subject`. */
    subject: string;
    dedupeKey: string;
    signal: ConversionSignal;
    metadata: Record<string, unknown>;
  },
): Promise<ConversionOutcome> {
  const [inserted] = await db
    .insert(schema.emailEvents)
    .ignore()
    .values({
      id: nanoid(),
      workspaceId: args.workspaceId,
      outreachId: args.outreachId,
      prospectId: args.prospectId,
      eventType: args.eventType,
      direction: "inbound",
      fromAddress: args.fromAddress,
      subject: args.subject.slice(0, 500),
      classification: args.providerEvent.slice(0, 40),
      dedupeKey: args.dedupeKey.slice(0, 128),
      metadata: args.metadata,
    });
  if ((inserted as unknown as { affectedRows?: number }).affectedRows === 0) {
    return { handled: false, duplicate: true, prospectId: args.prospectId };
  }

  const [opp] = await db
    .select()
    .from(schema.opportunities)
    .where(
      and(
        eq(schema.opportunities.workspaceId, args.workspaceId),
        eq(schema.opportunities.prospectId, args.prospectId),
      ),
    )
    .limit(1);

  const next = opp ? applySignal(opp.stage as OpportunityStage, args.signal) : null;
  if (next) {
    await db
      .update(schema.opportunities)
      .set({ stage: next as never })
      .where(eq(schema.opportunities.id, opp!.id));
    // Keep the prospect record consistent with the deal it belongs to.
    if (next === "won" || next === "lost") {
      await db
        .update(schema.prospects)
        .set({ status: next as never })
        .where(eq(schema.prospects.id, args.prospectId));
    }
  }

  return { handled: true, prospectId: args.prospectId, stage: next ?? opp?.stage ?? null };
}

/** Look up the message a conversion belongs to and gate on it being resolvable. */
async function ownerFromAddress(
  db: Db,
  address: string,
): Promise<{ workspaceId: string; prospectId: string; outreachId: string } | null> {
  const probe: InboundEmailInput = { fromAddress: address, eventType: "replied" };
  const outreach = await resolveOutreach(db, probe);
  if (!outreach) return null;
  return {
    workspaceId: outreach.workspaceId,
    prospectId: outreach.prospectId,
    outreachId: outreach.id,
  };
}

/** A prospect clicked a tracked CTA. `kind` decides whether a stage moves. */
export async function recordCtaClick(referenceId: string, kind: CtaKind): Promise<ConversionOutcome> {
  const db = getDb();
  if (!db) return NO_DB;
  const [msg] = await db
    .select()
    .from(schema.outreachMessages)
    .where(eq(schema.outreachMessages.referenceId, referenceId))
    .limit(1);
  if (!msg) return { handled: false, reason: "unknown_reference" };

  return recordConversion(db, {
    workspaceId: msg.workspaceId,
    prospectId: msg.prospectId,
    outreachId: msg.id,
    fromAddress: msg.recipientEmail,
    eventType: "clicked",
    providerEvent: `cta.clicked.${kind}`,
    subject:
      kind === "payment"
        ? "Clicked the self-serve pricing link"
        : "Clicked the meeting-booking link",
    // One row per (message, kind): the *first* click is the signal; a prospect
    // refreshing the page five times is not five negotiating events.
    dedupeKey: `cta:${referenceId}:${kind}`,
    signal: kind === "payment" ? "cta_clicked:payment" : "cta_clicked:booking",
    metadata: { kind, referenceId },
  });
}

/**
 * Calendly v2 delivers the booked person as an Invitee *resource*:
 *
 *   { "event": "invitee.created", "event_uuid": "...",
 *     "payload": { "resource": { "email": "...", "status": "active",
 *                   "scheduled_event": { "name": "30min", ... } } } }
 *
 * The superseded v1 subscription shape carried the same facts at payload.invitee
 * and payload.event, so both are read and a host still on the old format keeps
 * converting. Note that `event.created` is not a valid v2 event name at all —
 * the v2 set is invitee.created / invitee.canceled / invitee_no_show.created.
 */
export interface CalendlyPayload {
  event?: string;
  event_uuid?: string;
  payload?: {
    resource?: {
      email?: string;
      status?: string;
      scheduled_event?: { name?: string; status?: string } | null;
      cancellation?: { canceled_by?: string } | null;
    } | null;
    invitee?: { email?: string; status?: string; created_at?: string } | null;
    event?: { name?: string; status?: string } | null;
    canceler?: { email?: string } | null;
    recipient?: { email?: string } | null;
  };
}

/**
 * Read the invitee address and meeting state out of a Calendly payload.
 *
 * Deliberately separated from handleCalendlyEvent(): that one needs a database,
 * so a wrong field path is only observable against live MySQL and stays invisible
 * to CI. As a pure function this is covered by the no-database unit suite, which
 * is the only reason the `payload.invitee` read (v1) versus the real
 * `payload.resource.email` (v2) is fixed now rather than by a customer asking
 * why no meeting ever appeared.
 */
export function parseCalendlyPayload(body: CalendlyPayload): {
  inviteeEmail: string | null;
  eventName: string | null;
  eventStatus: string | null;
  canceled: boolean;
  noShow: boolean;
} {
  const name = String(body?.event ?? "");
  const resource = body?.payload?.resource;
  const legacy = body?.payload?.invitee;
  const status = resource?.status ?? legacy?.status ?? resource?.scheduled_event?.status ?? null;
  return {
    inviteeEmail: resource?.email ?? legacy?.email ?? null,
    eventName: resource?.scheduled_event?.name ?? body?.payload?.event?.name ?? null,
    eventStatus: status ?? body?.payload?.event?.status ?? null,
    // The resource status is authoritative; the event name is the fallback for a
    // payload that omits it, so a cancellation is never mistaken for a booking.
    canceled:
      status === "canceled" ||
      body?.payload?.canceler?.email !== undefined ||
      /cancel/i.test(name),
    noShow: /no_show/i.test(name),
  };
}

/**
 * Calendly invitee.created -> meeting_booked.
 *
 * Cancellations and no-shows are recorded but never move a deal backwards or
 * re-confirm it; the operator decides what a no-show means for the pipeline.
 */
export async function handleCalendlyEvent(body: CalendlyPayload): Promise<ConversionOutcome> {
  const db = getDb();
  if (!db) return NO_DB;
  const name = String(body?.event ?? "");
  const { inviteeEmail, eventName, eventStatus, canceled, noShow } = parseCalendlyPayload(body);
  if (!name || !inviteeEmail) return { handled: false, reason: "malformed_payload" };

  const owner = await ownerFromAddress(db, inviteeEmail);
  if (!owner) return { handled: false, reason: "unmatched_invitee" };

  // A withdrawal must not emit the signal that advances the deal, otherwise a
  // cancellation would (re)confirm the meeting it just removed.
  const withdrawn = canceled || noShow;
  return recordConversion(db, {
    ...owner,
    fromAddress: inviteeEmail,
    eventType: "converted",
    providerEvent: `calendly.${name}`.slice(0, 40),
    subject: `Calendly meeting ${canceled ? "cancelled" : noShow ? "missed (no-show)" : "scheduled"} (${name})`,
    dedupeKey: `calendly:${body.event_uuid ?? name}:${name}`,
    signal: withdrawn ? "cta_clicked:booking" : "meeting_confirmed",
    metadata: {
      provider: "calendly",
      calendlyEvent: name,
      eventUuid: body.event_uuid ?? null,
      eventName,
      eventStatus,
    },
  });
}

export interface StripeCheckoutSession {
  id?: string;
  customer_email?: string | null;
  client_reference_id?: string | null;
  payment_status?: string | null;
  amount_total?: number | null;
  currency?: string | null;
}

export interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: StripeCheckoutSession };
}

/**
 * Resolve which outreach a Stripe checkout belongs to. Prefers the
 * `client_reference_id` stamped on a server-created Checkout Session, and falls
 * back to the payer's email through the same ambiguity-guarded lookup used for
 * inbound replies — a Payment Link is one static URL and cannot carry metadata.
 *
 * Both the stage transition and the deal value must go through this one
 * resolver. When applyStripeValue understood only `client_reference_id`, every
 * Payment Link purchase advanced the deal to `won` while writing valueCents = 0,
 * so the funnel reported closed revenue as zero. Caught by the first real run of
 * server/integration.test.ts against MySQL.
 */
async function resolveStripeOwner(
  db: Db,
  session: StripeCheckoutSession,
): Promise<{ workspaceId: string; prospectId: string; outreachId: string } | null> {
  const ref = session?.client_reference_id ?? null;
  if (ref) {
    const [msg] = await db
      .select()
      .from(schema.outreachMessages)
      .where(eq(schema.outreachMessages.referenceId, ref))
      .limit(1);
    return msg
      ? { workspaceId: msg.workspaceId, prospectId: msg.prospectId, outreachId: msg.id }
      : null;
  }
  const address = session?.customer_email ?? null;
  return address ? ownerFromAddress(db, address) : null;
}

/**
 * Stripe `checkout.session.completed` / `checkout.session.async_payment_succeeded`
 * with payment_status=paid -> won. Anything else is stored for the timeline only.
 *
 * Caveat worth knowing: a Stripe *Payment Link* is a single static URL, so we
 * cannot stamp it with per-contact metadata. The join is the payer's email
 * address, which `ownerFromAddress` resolves under the same ambiguity guard as
 * inbound replies. Operators needing a guaranteed join should switch to
 * Checkout Sessions created server-side with `client_reference_id` set — that
 * branch is honoured below if the field is ever present.
 */
export async function handleStripeEvent(event: StripeEvent): Promise<ConversionOutcome> {
  const db = getDb();
  if (!db) return NO_DB;
  const type = String(event?.type ?? "");
  const session = event?.data?.object;
  if (!type || !session) return { handled: false, reason: "malformed_payload" };

  const address = session.customer_email ?? null;
  const owner = await resolveStripeOwner(db, session);
  if (!owner) return { handled: false, reason: "unmatched_payer" };

  const paid = session.payment_status === "paid";
  const success = /checkout\.session\.(completed|async_payment_succeeded)/.test(type);
  return recordConversion(db, {
    ...owner,
    fromAddress: address,
    eventType: "converted",
    providerEvent: `stripe.${type}`.slice(0, 40),
    subject: `${type === "checkout.session.completed" ? "Checkout completed" : "Stripe event"} (${type}${session.payment_status ? `, ${session.payment_status}` : ""})`,
    dedupeKey: `stripe:${event.id ?? type}:${session.id ?? ""}`,
    signal: success && paid ? "payment_captured" : "cta_clicked:booking",
    metadata: {
      provider: "stripe",
      stripeEvent: type,
      sessionId: session.id ?? null,
      paymentStatus: session.payment_status ?? null,
      amountTotal: session.amount_total ?? null,
      currency: session.currency ?? null,
    },
  });
}

/**
 * Value captured by a paid checkout, in minor units — feeds opportunity.valueCents.
 * Restricted to payment_status "paid": an abandoned or still-open Checkout also
 * carries an amount_total, and recording that as closed revenue would inflate the
 * pipeline with money that was never received.
 */
export async function applyStripeValue(event: StripeEvent): Promise<void> {
  const db = getDb();
  if (!db) return;
  const session = event?.data?.object;
  if (session?.payment_status !== "paid") return;
  const amount = session?.amount_total;
  if (typeof amount !== "number" || amount <= 0) return;
  const owner = await resolveStripeOwner(db, session);
  if (!owner) return;
  await db
    .update(schema.opportunities)
    .set({ valueCents: amount })
    .where(
      and(
        eq(schema.opportunities.workspaceId, owner.workspaceId),
        eq(schema.opportunities.prospectId, owner.prospectId),
      ),
    );
}

/** Human-readable target for a tracked click, resolved from config only. */
export function ctaTargetFor(kind: CtaKind): string | null {
  if (kind === "booking") return env.calendlyUrl || null;
  return env.stripePaymentLink || null;
}
