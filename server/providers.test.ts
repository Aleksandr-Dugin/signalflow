import { describe, it, expect } from "vitest";
import {
  canonicalDomain,
  canonicalizeUrl,
  isLikelyCompanyResult,
  dedupeCandidates,
  SearchQueryGenerator,
  getAIProvider,
  type CompanyCandidate,
} from "./services/providers";
import { env } from "./_core/env";

describe("canonicalDomain", () => {
  it("strips protocol, www and path", () => {
    expect(canonicalDomain("https://www.acme.com/about")).toBe("acme.com");
    expect(canonicalDomain("acme.com")).toBe("acme.com");
  });
  it("lowercases", () => expect(canonicalDomain("HTTPS://ACME.COM")).toBe("acme.com"));
});

describe("canonicalizeUrl", () => {
  it("accepts public http(s) urls", () => {
    expect(canonicalizeUrl("https://acme.com")).toBe("https://acme.com/");
  });
  it("rejects localhost and private IPs (SSRF guard)", () => {
    expect(canonicalizeUrl("http://localhost:3000")).toBeNull();
    expect(canonicalizeUrl("http://127.0.0.1/x")).toBeNull();
    expect(canonicalizeUrl("http://192.168.1.1/")).toBeNull();
    expect(canonicalizeUrl("http://10.0.0.5/")).toBeNull();
  });
  it("rejects non-http protocols and junk", () => {
    expect(canonicalizeUrl("ftp://acme.com")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
  });
});

describe("isLikelyCompanyResult", () => {
  it("blocks aggregator/social domains", () => {
    expect(isLikelyCompanyResult("https://linkedin.com/company/x")).toBe(false);
    expect(isLikelyCompanyResult("https://x.com")).toBe(false);
  });
  it("blocks list/directory pages", () => {
    expect(isLikelyCompanyResult("https://acme.com/top-tools")).toBe(false);
    expect(isLikelyCompanyResult("https://acme.com/directory")).toBe(false);
  });
  it("accepts a plausible company page", () => {
    expect(isLikelyCompanyResult("https://widgets.io/product")).toBe(true);
  });
});

const cand = (over: Partial<CompanyCandidate>): CompanyCandidate => ({
  name: "Acme",
  domain: "acme.com",
  description: "",
  websiteUrl: "https://acme.com",
  sourceUrl: "https://acme.com",
  origin: "demo",
  evidence: [],
  ...over,
});

describe("dedupeCandidates", () => {
  it("keeps first per domain", () => {
    const out = dedupeCandidates([cand({ domain: "a.com" }), cand({ domain: "a.com" }), cand({ domain: "b.com" })]);
    expect(out.map((c) => c.domain)).toEqual(["a.com", "b.com"]);
  });
});

describe("SearchQueryGenerator", () => {
  it("uses ICP industries/geographies/problems when present", () => {
    const queries = new SearchQueryGenerator().generate({
      offer: "bookkeeping",
      targetDescription: "dental clinics",
      geography: "US",
      industry: "Healthcare",
      icp: {
        industries: ["Dental"],
        geographies: ["Texas"],
        likelyProblems: ["messy books"],
      } as any,
      prospectTarget: 5,
    });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((q) => q.length > 8)).toBe(true);
    expect(queries.some((q) => q.includes("Dental"))).toBe(true);
  });
  it("always returns at least one query", () => {
    const queries = new SearchQueryGenerator().generate({ offer: "x", targetDescription: "", geography: "", industry: "", prospectTarget: 3 });
    expect(queries.length).toBeGreaterThanOrEqual(1);
  });
});

// The mock provider is only used when no Groq key is configured.
describe.skipIf(Boolean(env.groqApiKey))("MockAIProvider", () => {
  const ai = getAIProvider();

  it("reports mock", () => expect(ai.name).toBe("mock"));

  it("qualifies on keyword evidence", async () => {
    const r = await ai.qualifyCompany({
      offer: "ops",
      criteria: {},
      company: { name: "Acme SaaS" },
      evidence: [{ claim: "B2B software startup" }],
    });
    expect(r.fit).toBe(true);
    expect(r.fitScore).toBeGreaterThan(55);
  });

  it("returns no fit without signals", async () => {
    const r = await ai.qualifyCompany({ offer: "ops", criteria: {}, company: { name: "Zzz" }, evidence: [] });
    expect(r.fit).toBe(false);
  });

  it("detects hiring/funding signals from evidence", async () => {
    const r = await ai.detectSignals({
      offer: "ops",
      company: { name: "Acme" },
      evidence: [{ claim: "We are hiring 10 engineers", sourceUrl: "https://acme.com" }],
    });
    expect(r.signals.length).toBe(1);
  });

  it("classifies replies", async () => {
    expect((await ai.classify("Please unsubscribe", ["unsubscribe"])).label).toBe("unsubscribe");
    expect((await ai.classify("Sounds good, let's talk", ["interested"])).label).toBe("interested");
    expect((await ai.classify("?", ["question"])).label).toBe("question");
  });
});
