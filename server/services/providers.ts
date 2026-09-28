import { ScrapeGraphAI } from "scrapegraph-js";
import { z } from "zod";
import { env } from "../_core/env";
import type { IcpCriteria } from "../../shared/types";
import {
  ChatCompletionProvider,
  forBackend,
  type qualificationSchema,
  type researchSchema,
  type signalsSchema,
  type personalizationSchema,
} from "./groq";
import { icpSchema } from "./groq";
import type { PageFetcher, ScrapedPage } from "./contactExtraction";
import { OpenWebDiscovery } from "./openDiscovery";
import { demoProspects, DEMO_DISCLOSURE } from "../../shared/demo";

export type QualificationResult = z.infer<typeof qualificationSchema>;
export type SignalsResult = z.infer<typeof signalsSchema>;
export type ResearchResult = z.infer<typeof researchSchema>;
export type PersonalizationResult = z.infer<typeof personalizationSchema>;
export type IcpResult = z.infer<typeof icpSchema>;

export interface CompanyCandidate {
  name: string;
  domain: string;
  description: string;
  websiteUrl: string;
  industry?: string;
  size?: string;
  geography?: string;
  sourceUrl: string;
  origin: "live" | "demo";
  evidence: { claim: string; sourceUrl: string }[];
  contact?: { name: string; title?: string; email: string; sourceUrl?: string };
}

// ── URL / domain hygiene ─────────────────────────────────────────────────────
/**
 * Addresses that are never a company's public website. This function is the guard
 * in front of every fetch the system makes at a URL a page or a source supplied, so
 * the interesting cases are the ones that look like nothing: the cloud metadata
 * endpoint at 169.254.169.254, the carrier-grade range a private cluster hides in,
 * and the numeric spellings of 127.0.0.1 that a naive prefix check waves through.
 */
export function isPrivateAddress(input: string): boolean {
  const h = input.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true; // unique-local, link-local
  if (h.startsWith("::ffff:")) return isPrivateAddress(h.slice(7)); // IPv4-mapped IPv6
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    if ([a, b, c, d].some((v) => v > 255)) return true; // malformed is not fetchable either
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud instance metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && (b === 168 || b === 0)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking, routes like private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT: where private clusters live
    if (a >= 224) return true; // multicast and reserved
    return false;
  }
  // `http://2130706433/` and `http://0x7f.1/` are 127.0.0.1 in other spellings, and a
  // hostname with no dot cannot be a public site from inside this system's point of view.
  if (/^\d+$/.test(h) || /^0[xX][0-9a-f]+$/.test(h)) return true;
  if (!h.includes(".") && h !== "localhost") return true;
  return false;
}

export function canonicalizeUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname;
    if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
    if (isPrivateAddress(hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function canonicalDomain(input: string): string {
  try {
    const s = (input || "").trim();
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const url = new URL(withProto);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return (input || "").replace(/^https?:\/\//i, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}

const NON_COMPANY_DOMAINS = [
  // Profiles and aggregators: a page here describes a company, it is not one.
  "linkedin.com",
  "crunchbase.com",
  "indeed.com",
  "glassdoor.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "instagram.com",
  "wikipedia.org",
  "reddit.com",
  "news.ycombinator.com",
  "medium.com",
  // Hosting: the page belongs to the platform, so the domain would name the wrong
  // company and no contact could ever be found on it. Live runs turned up github.com
  // and apps.apple.com as "companies" once the query started matching announcements.
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "sourceforge.net",
  "apps.apple.com",
  "play.google.com",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "railway.app",
];

export function isLikelyCompanyResult(url: string): boolean {
  const good = canonicalizeUrl(url);
  if (!good) return false;
  const domain = canonicalDomain(url);
  if (NON_COMPANY_DOMAINS.some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`))) {
    return false;
  }
  // Reject obvious list/directory aggregation pages.
  const lower = url.toLowerCase();
  if (/(\/(top|best|list|directory|compare|reviews)\b)/.test(lower)) return false;
  return true;
}

export function dedupeCandidates(items: CompanyCandidate[]): CompanyCandidate[] {
  const seen = new Set<string>();
  const out: CompanyCandidate[] = [];
  for (const item of items) {
    const key = item.domain || item.name.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// ── Search query generation, driven by the campaign AND its ICP ───────────────
export interface SearchContext {
  offer: string;
  targetDescription: string;
  geography: string;
  industry: string;
  icp?: IcpCriteria | null;
}

export class SearchQueryGenerator {
  generate(ctx: SearchContext): string[] {
    const parts: string[] = [];
    const industries = ctx.icp?.industries?.length ? ctx.icp.industries : [ctx.industry].filter(Boolean);
    const geo = ctx.icp?.geographies?.length ? ctx.icp.geographies : [ctx.geography].filter(Boolean);
    const problems = ctx.icp?.likelyProblems ?? [];

    if (industries[0]) parts.push(`${industries[0]} companies hiring that need ${ctx.offer}`);
    if (ctx.targetDescription) parts.push(`${ctx.targetDescription} companies`);
    for (const problem of problems.slice(0, 2)) {
      parts.push(`${industries[0] ?? "companies"} looking for help with ${problem}`);
    }
    for (const g of geo.slice(0, 2)) {
      parts.push(`${industries[0] ?? "B2B"} companies in ${g}`);
    }
    const queries = parts
      .map((q) => q.replace(/\s+/g, " ").trim())
      .filter((q) => q.length > 8)
      .slice(0, 5);
    return queries.length ? queries : [`${ctx.offer} companies`.slice(0, 80)];
  }
}

// ── AI provider facade (a live OpenAI-compatible backend when configured, honest
// Mock otherwise) ────────────────────────────────────────────────────────────────
export interface AiProvider {
  readonly name: "live" | "mock";
  generateICP(input: { service: string; target: string; geography: string }): Promise<IcpResult>;
  qualifyCompany(input: {
    offer: string;
    criteria: unknown;
    company: { name: string; description?: string | null; industry?: string | null };
    evidence: { claim: string; sourceUrl?: string }[];
  }): Promise<QualificationResult>;
  detectSignals(input: {
    offer: string;
    company: { name: string; description?: string | null };
    evidence: { claim: string; sourceUrl?: string }[];
  }): Promise<SignalsResult>;
  synthesizeResearch(input: {
    company: { name: string; description?: string | null };
    evidence: { claim: string; sourceUrl?: string }[];
  }): Promise<ResearchResult>;
  generatePersonalization(input: {
    offer: string;
    company: string;
    contactName?: string | null;
    signal?: string | null;
    evidence: { claim: string; sourceUrl?: string }[];
  }): Promise<PersonalizationResult>;
  classify(text: string, labels: readonly string[]): Promise<{ label: string }>;
}

class MockAIProvider implements AiProvider {
  readonly name = "mock" as const;

  async generateICP(input: { service: string; target: string; geography: string }): Promise<IcpResult> {
    return {
      industries: [input.target || "General B2B"],
      companyTypes: ["Small and mid-sized businesses"],
      companySize: ["11-50", "51-200"],
      geographies: [input.geography || "Global"],
      businessModels: ["B2B services", "SaaS"],
      technologies: [],
      likelyProblems: ["Manual lead sourcing", "No consistent outbound pipeline"],
      buyingSignals: ["Hiring", "Recently funded", "Launching a new product"],
      exclusions: ["Non-profits", "Enterprise > 2000 employees"],
      narrative: `Companies that match "${input.service}" for "${input.target}". Configure GROQ_API_KEY for AI-generated ICP detail.`,
    };
  }

  async qualifyCompany(input: {
    evidence: { claim: string }[];
    company: { name: string };
    criteria: unknown;
  }): Promise<QualificationResult> {
    const haystack = `${input.company.name} ${input.evidence.map((e) => e.claim).join(" ")}`.toLowerCase();
    const keywords = ["saas", "b2b", "software", "clinic", "logistics", "agency", "startup", "ecommerce"];
    const matched = keywords.filter((k) => haystack.includes(k));
    const fit = matched.length > 0;
    return {
      fit,
      fitScore: fit ? 60 + matched.length * 5 : 20,
      confidence: input.evidence.length ? 35 : 20,
      reasons: matched.length ? [`Keyword match: ${matched.join(", ")}`] : ["No strong fit signals"],
      disqualifiers: fit ? [] : ["No matching criteria in collected evidence"],
    };
  }

  async detectSignals(input: {
    company: { name: string; description?: string | null };
    evidence: { claim: string; sourceUrl?: string }[];
  }): Promise<SignalsResult> {
    const found = input.evidence
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => /hiring|funding|expansion|launch|new product|opens|growing/i.test(e.claim))
      .slice(0, 3)
      .map(({ e, i }) => ({
        type: e.claim.slice(0, 40),
        importance: 60,
        evidenceIndexes: [i],
        whyNow: e.claim.slice(0, 160),
      }));
    return { signals: found };
  }

  async synthesizeResearch(input: {
    company: { name: string; description?: string | null };
    evidence: { claim: string; sourceUrl: string }[];
  }): Promise<ResearchResult> {
    return {
      summary: `${input.company.name}: ${input.company.description ?? "no description"} (demo synthesis of ${input.evidence.length} evidence items).`,
      confidence: 30,
      keyFacts: input.evidence.slice(0, 3).map((e) => e.claim),
    };
  }

  async generatePersonalization(input: {
    offer: string;
    company: string;
    signal?: string | null;
  }): Promise<PersonalizationResult> {
    return {
      subject: `A quick idea for ${input.company}`,
      openingLine: `Hi ${input.company} team,`,
      body: `We noticed ${input.signal ?? "some recent activity"} and think our work on "${input.offer}" could be relevant. (Demo draft — configure GROQ_API_KEY for real personalization.)`,
      cta: "Worth a quick chat?",
    };
  }

  async classify(text: string, labels: readonly string[]): Promise<{ label: string }> {
    const t = text.toLowerCase();
    const pick = (label: string) => (labels.includes(label) ? { label } : { label: "unknown" });
    if (/unsubscribe|remove me|stop emailing/.test(t)) return pick("unsubscribe");
    if (/not interested|no thanks|no, thank/.test(t)) return pick("not_interested");
    if (/out of office|vacation|ofo|on leave/.test(t)) return pick("out_of_office");
    if (/(interested|sounds good|let'?s|more info|reply|call|meeting)/.test(t)) return pick("interested");
    if (/\?$/.test(t.trim())) return pick("question");
    return pick("neutral");
  }
}

let _ai: AiProvider | null = null;
export function getAIProvider(): AiProvider {
  const backend = forBackend();
  if (backend) {
    // ChatCompletionProvider implements the AiProvider method set for any
    // OpenAI-compatible server (self-hosted model or Groq).
    _ai = _ai instanceof ChatCompletionProvider ? _ai : new ChatCompletionProvider(backend);
    return _ai;
  }
  return new MockAIProvider();
}

// ── Discovery providers ─────────────────────────────────────────────────────
const COMPANY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    industry: { type: "string" },
    size: { type: "string" },
    geography: { type: "string" },
  },
} as const;

export interface DiscoverInput {
  offer: string;
  targetDescription: string;
  geography: string;
  industry: string;
  icp?: IcpCriteria | null;
  prospectTarget: number;
}

export interface LeadDiscoveryProvider {
  readonly name: "scrapegraph" | "open" | "mock";
  discoverProspects(input: DiscoverInput): Promise<CompanyCandidate[]>;
  /**
   * Raw public-page text, used by the contact-extraction second pass
   * (services/contactExtraction). Returns nothing for pages that failed or were
   * refused — callers must treat "no pages" as "no contact found", never as an
   * error. Type-only import, so this does not create a module cycle.
   */
  fetchPages: PageFetcher;
}

class ScrapeGraphDiscovery implements LeadDiscoveryProvider {
  readonly name = "scrapegraph" as const;

  private client() {
    return ScrapeGraphAI({ apiKey: env.sgaiApiKey });
  }

  async discoverProspects(input: DiscoverInput): Promise<CompanyCandidate[]> {
    const queries = new SearchQueryGenerator().generate(input);
    const client = this.client();
    const collected: CompanyCandidate[] = [];

    for (const query of queries) {
      const search = await client.search({
        query,
        numResults: 5,
        format: "markdown",
        timeRange: "past_year",
        allowedTypes: ["text/html"],
      });
      if (search.status !== "success" || !Array.isArray(search.data)) continue;
      for (const hit of search.data.slice(0, 20)) {
        const url = (hit as any).url;
        if (!url || !isLikelyCompanyResult(String(url))) continue;
        const candidate = await this.extractCompany(String(url), input.offer).catch(() => null);
        if (candidate) collected.push(candidate);
        if (collected.length >= input.prospectTarget * 2) break;
      }
      if (collected.length >= input.prospectTarget * 2) break;
    }
    return dedupeCandidates(collected).slice(0, Math.max(1, input.prospectTarget));
  }

  private async extractCompany(url: string, offer: string): Promise<CompanyCandidate | null> {
    const res = await this.client().extract({
      url,
      mode: "reader",
      prompt: `Extract the company name, a one-sentence description, industry, approximate size, geography, and any current signal relevant to "${offer}".`,
      schema: COMPANY_SCHEMA,
    });
    if (res.status !== "success" || !res.data) return null;
    const data = res.data as any;
    const domain = canonicalDomain(url);
    const evidence = [{ claim: data.description || `${domain} company page`, sourceUrl: url }];
    return {
      name: data.name || domain,
      domain,
      description: data.description || "",
      websiteUrl: url,
      industry: data.industry,
      size: data.size,
      geography: data.geography,
      sourceUrl: url,
      origin: "live",
      evidence,
    };
  }

  /**
   * Plain markdown scrape — no prompt, no schema, so no LLM in this path and no
   * chance of the model inventing an address that was never printed.
   *
   * `mode: "normal"` rather than "reader": reader mode keeps the article and
   * drops boilerplate, and on a contact page the boilerplate is often precisely
   * where the address lives (footer). We would rather pay for more text than
   * silently scrape away the thing we are looking for.
   */
  async fetchPages(urls: string[]): Promise<ScrapedPage[]> {
    const client = this.client();
    const pages: ScrapedPage[] = [];
    for (const raw of urls) {
      // Re-checked here rather than trusting the caller: this is the one place
      // where an attacker-supplied address could turn our scraper into an
      // internal-network probe (canonicalizeUrl refuses localhost/private IPs).
      const url = canonicalizeUrl(raw);
      if (!url) continue;
      const res = await client
        .scrape({ url, formats: [{ type: "markdown", mode: "normal" }] })
        .catch(() => null);
      if (!res || res.status !== "success") continue;
      const text = res.data?.results?.markdown?.data?.[0];
      if (text) pages.push({ url, text });
    }
    return pages;
  }
}

class MockDiscovery implements LeadDiscoveryProvider {
  readonly name = "mock" as const;
  // Demo companies are fictional. Fetching their invented domains would either
  // return nothing or reach some unrelated real business that happens to own the
  // name — and attaching that stranger's address to a demo prospect, then mailing
  // it, is exactly the failure this whole guard exists to prevent.
  async fetchPages(): Promise<ScrapedPage[]> {
    return [];
  }
  async discoverProspects(_input: DiscoverInput): Promise<CompanyCandidate[]> {
    // Explicitly demo-origin, fictional, and clearly labelled — never persisted
    // as if they were real, sourced companies (audit P0 provenance fix).
    return demoProspects.map((p) => ({
      name: p.company,
      domain: p.domain,
      description: `${p.description} ${DEMO_DISCLOSURE}`,
      websiteUrl: p.sourceUrl ?? `https://${p.domain}`,
      sourceUrl: p.sourceUrl ?? `https://${p.domain}`,
      origin: "demo" as const,
      evidence: [{ claim: p.description, sourceUrl: p.sourceUrl ?? `https://${p.domain}` }],
    }));
  }
}

let _discovery: LeadDiscoveryProvider | null = null;

/**
 * Which engine a discovery run will use.
 *
 * The default is unchanged from before the free sources existed — live only when a
 * ScrapeGraph key is present, demo data otherwise — because reaching out to third
 * party public APIs is a decision the operator makes, not a side effect of pulling
 * the code. `DISCOVERY_PROVIDER=open` makes that decision explicitly.
 *
 * A named-but-unavailable choice falls back to demo data and says so once: the
 * alternative is a campaign that quietly mails fictional companies.
 */
export function getDiscoveryProvider(): LeadDiscoveryProvider {
  const choice = env.discoveryProvider.trim().toLowerCase();
  if (choice === "mock") return new MockDiscovery();
  if (choice === "open") {
    _discovery = _discovery instanceof OpenWebDiscovery ? _discovery : new OpenWebDiscovery();
    return _discovery;
  }
  if (choice === "scrapegraph" && !env.sgaiApiKey) {
    console.warn(
      "[discovery] DISCOVERY_PROVIDER=scrapegraph but no SGAI_API_KEY is set; falling back to labelled demo data instead of pretending discovery is live.",
    );
    return new MockDiscovery();
  }
  if (env.sgaiApiKey) {
    _discovery = _discovery instanceof ScrapeGraphDiscovery ? _discovery : new ScrapeGraphDiscovery();
    return _discovery;
  }
  return new MockDiscovery();
}

/** What the health check and the Admin page show: the engine, and whether it is real. */
export function discoveryMode(): "scrapegraph" | "open" | "mock" {
  return getDiscoveryProvider().name;
}

export { ChatCompletionProvider as GroqProvider };
