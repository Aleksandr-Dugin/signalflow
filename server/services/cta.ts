// Click attribution for the links the AI drops into follow-up CTAs.
//
// Before this module, CALENDLY_URL / STRIPE_PAYMENT_LINK were pasted into the
// message as bare URLs: the system could never learn that a prospect acted on
// them, so the funnel had no way to reach `negotiating`, `meeting_booked` or
// `won` without a human noticing in another tab.
//
// The rewrite is done at *send* time, not draft time, because the outreach
// reference id (our per-message correlation key) only exists inside
// `sendOutreachEmail`. Drafts keep the plain URL in `personalizations`, so a
// preview is never a tracking URL the operator can't read.
//
// Security note: the redirect target is always resolved server-side from env
// config for the given kind. The path parameter is a classification, never a
// URL — so this endpoint cannot be turned into an open redirect.
export type CtaKind = "booking" | "payment";

export interface CtaLink {
  kind: CtaKind;
  url: string;
}

export const CTA_KINDS: readonly CtaKind[] = ["booking", "payment"];

export function isCtaKind(value: unknown): value is CtaKind {
  return value === "booking" || value === "payment";
}

/** Where a click on `kind` for message `referenceId` should be sent. */
export function ctaRedirectPath(referenceId: string, kind: CtaKind): string {
  return `/api/track/cta/${encodeURIComponent(referenceId)}/${kind}`;
}

/**
 * Replace every configured tool URL in an outgoing body with its tracked
 * equivalent. Idempotent: already-rewritten text contains no bare tool URL, so
 * a re-run (job retry, replayed send) changes nothing.
 */
export function trackCtaLinks(
  text: string,
  opts: {
    publicUrl: string;
    referenceId: string;
    links?: CtaLink[];
  },
): string {
  const base = opts.publicUrl.replace(/\/$/, "");
  let out = text;
  for (const { kind, url } of opts.links ?? []) {
    // Only rewrite occurrences that are not already our own redirect.
    if (!url || !url.includes("://")) continue;
    const tracked = `${base}${ctaRedirectPath(opts.referenceId, kind)}`;
    if (out.includes(tracked)) continue;
    out = out.split(url).join(tracked);
  }
  return out;
}

/**
 * Build the `links` array from raw configuration. Returns [] when nothing is
 * configured, which makes `trackCtaLinks` a no-op — the correct behaviour for a
 * deployment that has not wired up Calendly/Stripe yet.
 */
export function ctaLinksFromConfig(config: {
  calendlyUrl?: string;
  stripePaymentLink?: string;
}): CtaLink[] {
  const links: CtaLink[] = [];
  if (config.calendlyUrl) links.push({ kind: "booking", url: config.calendlyUrl });
  if (config.stripePaymentLink) links.push({ kind: "payment", url: config.stripePaymentLink });
  return links;
}
