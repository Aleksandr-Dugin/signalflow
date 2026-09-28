import { describe, it, expect, afterEach } from "vitest";
import {
  canonicalDomain,
  canonicalizeUrl,
  isLikelyCompanyResult,
  dedupeCandidates,
  SearchQueryGenerator,
  getAIProvider,
  getDiscoveryProvider,
  type CompanyCandidate,
} from "./services/providers";
import { ChatCompletionProvider, forBackend } from "./services/groq";
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

// The mock provider is what runs when no ScrapeGraph key is configured, and its
// companies are fictional. It must never fetch a page: an invented domain can be
// registered by a real business, and mailing whoever owns it now is precisely the
// failure the demo-provenance guard exists to prevent.
describe.skipIf(Boolean(env.sgaiApiKey))("MockDiscovery", () => {
  const discovery = getDiscoveryProvider();

  it("reports mock", () => expect(discovery.name).toBe("mock"));

  it("fetches no page for a fictional company", async () => {
    expect(await discovery.fetchPages(["https://acme-does-not-exist.example/contact"])).toEqual([]);
  });

  it("returns demo candidates that carry no scraped contact", async () => {
    const found = await discovery.discoverProspects({
      offer: "ops",
      targetDescription: "",
      geography: "",
      industry: "",
      prospectTarget: 3,
    });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((c) => !c.contact)).toBe(true);
  });
});

// The mock provider is only used when no live AI backend is configured.
const liveBackendConfigured = () => forBackend() !== null;
describe.skipIf(liveBackendConfigured())("MockAIProvider", () => {
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

describe("ChatCompletionProvider", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to the configured baseUrl and sends the auth header only when a key exists", async () => {
    const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ label: "positive" }) } }] }),
      };
    }) as any;

    const hosted = new ChatCompletionProvider({
      baseUrl: "https://api.example.com/v1",
      model: "some-model",
      apiKey: "secret-key",
      label: "openai-compatible",
    });
    const res = await hosted.classify("great news", ["positive", "negative"]);
    expect(res.label).toBe("positive");
    expect(calls[0].url).toBe("https://api.example.com/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer secret-key");
    expect(calls[0].body.model).toBe("some-model");

    // A local server on loopback has no key: no Authorization header is sent.
    const local = new ChatCompletionProvider({
      baseUrl: "http://127.0.0.1:8000/v1/",
      model: "bonsai",
      apiKey: "",
      label: "local",
    });
    await local.classify("great news", ["positive"]);
    expect(calls[1].url).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(calls[1].headers.Authorization).toBeUndefined();
  });
});

describe("forBackend precedence", () => {
  const snapshot = {
    aiBaseUrl: env.aiBaseUrl,
    aiModel: env.aiModel,
    aiApiKey: env.aiApiKey,
    groqApiKey: env.groqApiKey,
    groqModel: env.groqModel,
  };
  afterEach(() => Object.assign(env, snapshot));

  it("prefers a self-hosted AI_BASE_URL over the Groq key", () => {
    env.aiBaseUrl = "http://127.0.0.1:8000/v1";
    env.aiModel = "bonsai-27b";
    env.groqApiKey = "gsk_should-be-ignored";
    const b = forBackend();
    expect(b?.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(b?.model).toBe("bonsai-27b");
    expect(b?.label).toBe("openai-compatible");
  });

  it("falls back to Groq when only the key is set", () => {
    env.aiBaseUrl = "";
    env.groqApiKey = "gsk_present";
    env.groqModel = "openai/gpt-oss-20b";
    const b = forBackend();
    expect(b?.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(b?.label).toBe("groq");
  });

  it("returns null (so the caller mocks) when neither is configured", () => {
    env.aiBaseUrl = "";
    env.groqApiKey = "";
    expect(forBackend()).toBeNull();
  });
});
