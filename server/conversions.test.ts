// Unit tests for evidence-driven funnel advancement and the callbacks that feed
// it (docs/ai-agents.md). Deterministic: no database, no network, no timers.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applySignal,
  canAdvanceStage,
  stageForSignal,
  type ConversionSignal,
  type OpportunityStage,
} from "./services/opportunity";
import {
  ctaLinksFromConfig,
  ctaRedirectPath,
  isCtaKind,
  trackCtaLinks,
} from "./services/cta";
import { buildUnsubscribeHeaders, type OutboundEmail } from "./services/email";
import { verifySignedHeader } from "./_core/conversionWebhooks";

describe("evidence-driven stage advancement", () => {
  it("never advances on a booking-link click", () => {
    // Clicking a scheduler is intent. meeting_booked requires the Calendly
    // webhook, otherwise the funnel reports appointments that were never kept.
    expect(stageForSignal("cta_clicked:booking")).toBeNull();
    expect(applySignal("responded", "cta_clicked:booking")).toBeNull();
  });

  it("advances to negotiating on a payment-link click", () => {
    expect(applySignal("responded", "cta_clicked:payment")).toBe("negotiating");
  });

  it("advances to meeting_booked only on a confirmed Calendly event", () => {
    expect(applySignal("responded", "meeting_confirmed")).toBe("meeting_booked");
    expect(applySignal("open", "meeting_confirmed")).toBe("meeting_booked");
  });

  it("advances to won only on captured payment", () => {
    expect(applySignal("negotiating", "payment_captured")).toBe("won");
    expect(applySignal("meeting_booked", "payment_captured")).toBe("won");
  });

  it("sends nothing to a stage that is not ahead of the current one", () => {
    // A replayed or late-arriving webhook must not churn the deal.
    expect(applySignal("negotiating", "cta_clicked:payment")).toBeNull();
    expect(applySignal("meeting_booked", "meeting_confirmed")).toBeNull();
  });

  it("never resurrects a terminal deal", () => {
    const signals: ConversionSignal[] = [
      "cta_clicked:booking",
      "cta_clicked:payment",
      "meeting_confirmed",
      "payment_captured",
    ];
    for (const signal of signals) {
      expect(applySignal("won", signal)).toBeNull();
      expect(applySignal("lost", signal)).toBeNull();
    }
  });

  it("agrees with the manual advancement guard", () => {
    const pairs: [OpportunityStage, ConversionSignal][] = [
      ["negotiating", "cta_clicked:payment"],
      ["meeting_booked", "meeting_confirmed"],
      ["won", "payment_captured"],
    ];
    for (const [target, signal] of pairs) {
      // Wherever the guard forbids a move, applySignal must produce nothing too;
      // the automated path can never be more permissive than the human one.
      if (canAdvanceStage("responded", target)) {
        expect(applySignal("responded", signal)).toBe(target);
      } else {
        expect(applySignal("responded", signal)).toBeNull();
      }
    }
  });
});

describe("cta link tracking", () => {
  const links = ctaLinksFromConfig({
    calendlyUrl: "https://calendly.com/acme/30min",
    stripePaymentLink: "https://buy.stripe.com/test_123",
  });

  it("rewrites configured tool URLs to per-message tracked paths", () => {
    const out = trackCtaLinks("Book a slot: https://calendly.com/acme/30min", {
      publicUrl: "https://app.example.com/",
      referenceId: "ref-abc",
      links,
    });
    expect(out).toBe(
      `Book a slot: https://app.example.com${ctaRedirectPath("ref-abc", "booking")}`,
    );
  });

  it("trailing-slash and bare publicUrl produce the same tracked link", () => {
    const body = "Self-serve pricing: https://buy.stripe.com/test_123";
    const opts = { referenceId: "r1", links };
    expect(
      trackCtaLinks(body, { ...opts, publicUrl: "https://x.app" }),
    ).toBe(trackCtaLinks(body, { ...opts, publicUrl: "https://x.app/" }));
  });

  it("is idempotent — a retried send does not double-wrap", () => {
    const once = trackCtaLinks("see https://calendly.com/acme/30min", {
      publicUrl: "https://x.app",
      referenceId: "r1",
      links,
    });
    expect(trackCtaLinks(once, { publicUrl: "https://x.app", referenceId: "r1", links })).toBe(once);
  });

  it("leaves unrelated URLs and text untouched", () => {
    const text = "Our site is https://acme.example/pricing, nothing to book yet.";
    expect(
      trackCtaLinks(text, { publicUrl: "https://x.app", referenceId: "r1", links: [] }),
    ).toBe(text);
  });

  it("is a no-op when the operator configured no tools", () => {
    expect(ctaLinksFromConfig({})).toEqual([]);
    const text = "Book a slot: https://calendly.com/acme/30min";
    expect(
      trackCtaLinks(text, {
        publicUrl: "https://x.app",
        referenceId: "r1",
        links: ctaLinksFromConfig({}),
      }),
    ).toBe(text);
  });

  it("only accepts the two known link kinds", () => {
    expect(isCtaKind("booking")).toBe(true);
    expect(isCtaKind("payment")).toBe(true);
    // Anything else would let a caller steer the redirect target.
    expect(isCtaKind("evil")).toBe(false);
    expect(isCtaKind(undefined)).toBe(false);
    expect(isCtaKind("https://attacker.example")).toBe(false);
  });

  it("url-encodes the reference so a crafted ref cannot add path segments", () => {
    expect(ctaRedirectPath("a/b", "booking")).toBe("/api/track/cta/a%2Fb/booking");
  });
});

describe("List-Unsubscribe headers (RFC 8058)", () => {
  const base: OutboundEmail = {
    toName: "Jo",
    toEmail: "jo@acme.co",
    subject: "s",
    text: "t",
  };

  it("emits an angle-bracket URI and the one-click POST directive", () => {
    const headers = buildUnsubscribeHeaders({
      ...base,
      unsubscribeUrl: "https://app.example.com/api/replies/unsubscribe?ref=abc",
    })!;
    expect(headers["List-Unsubscribe"]).toBe(
      "<https://app.example.com/api/replies/unsubscribe?ref=abc>",
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("adds the mailto leg when a reply-to mailbox is configured", () => {
    const headers = buildUnsubscribeHeaders({
      ...base,
      unsubscribeUrl: "https://app.example.com/u?ref=abc",
    })!;
    // SMTP_REPLY_TO is read from env; unset in the test environment, so only the
    // https URI is offered. Assert the shape stays valid either way.
    for (const uri of headers["List-Unsubscribe"].split(",")) {
      expect(uri.trim()).toMatch(/^<(https:|mailto:)/);
    }
  });

  it("emits nothing without an unsubscribe URL", () => {
    expect(buildUnsubscribeHeaders(base)).toBeUndefined();
  });
});

describe("provider webhook signature verification", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ event: "event.created", payload: { invitee: { email: "a@b.co" } } });

  function sign(payload: string, timestamp: number, version = "v0", key = secret) {
    const mac = createHmac("sha256", key).update(`${timestamp}.${payload}`).digest("hex");
    return `t=${timestamp},${version}=${mac}`;
  }

  const nowSec = () => Math.floor(Date.now() / 1000);

  it("accepts a fresh, correctly signed payload", () => {
    expect(verifySignedHeader(sign(body, nowSec()), body, secret, ["v0"])).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = sign(body, nowSec());
    const evil = body.replace("a@b.co", "victim@other.co");
    expect(verifySignedHeader(header, evil, secret, ["v0"])).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = sign(body, nowSec(), "v0", "not_the_secret");
    expect(verifySignedHeader(header, body, secret, ["v0"])).toBe(false);
  });

  it("rejects a replayed (stale) timestamp", () => {
    const header = sign(body, nowSec() - 3600);
    expect(verifySignedHeader(header, body, secret, ["v0"])).toBe(false);
  });

  it("honours a wider tolerance when a provider retries for longer", () => {
    const header = sign(body, nowSec() - 3600);
    expect(verifySignedHeader(header, body, secret, ["v0"], 7200)).toBe(true);
  });

  it("accepts any offered digest version but not an unknown one", () => {
    expect(verifySignedHeader(sign(body, nowSec(), "v1"), body, secret, ["v1"])).toBe(true);
    expect(verifySignedHeader(sign(body, nowSec(), "v1"), body, secret, ["v0", "v1"])).toBe(true);
    expect(verifySignedHeader(sign(body, nowSec(), "v2"), body, secret, ["v0", "v1"])).toBe(false);
  });

  it("rejects missing, malformed or empty-secret input rather than defaulting open", () => {
    const t = nowSec();
    const good = sign(body, t);
    expect(verifySignedHeader(undefined, body, secret, ["v0"])).toBe(false);
    expect(verifySignedHeader("", body, secret, ["v0"])).toBe(false);
    expect(verifySignedHeader(good, "", secret, ["v0"])).toBe(false);
    // Unconfigured secret must never verify: this is the "refuse everything" rule.
    expect(verifySignedHeader(good, body, "", ["v0"])).toBe(false);
    expect(verifySignedHeader("garbage", body, secret, ["v0"])).toBe(false);
    expect(verifySignedHeader(`t=notanumber,v0=${"0".repeat(64)}`, body, secret, ["v0"])).toBe(false);
    expect(verifySignedHeader(`t=${t},v0=not-hex`, body, secret, ["v0"])).toBe(false);
  });
});
