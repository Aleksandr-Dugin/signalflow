// Free, keyless lead discovery: public open-data sources that name real companies
// without an API key, a subscription or a credit card.
//
// Why this exists: until now "live" discovery meant a ScrapeGraphAI key, and with no
// key the pipeline returned fictional companies. That is the right default for a
// demo and the wrong ceiling for a launch — the operator should be able to find real
// prospects before spending anything.
//
// What it is not: it is not a general web search. Each source here is a structured
// dataset with its own usage policy, and each covers a different kind of company:
//
//   hn   startups and tools announced on Hacker News (tech ICPs, small companies)
//   osm  businesses mapped in OpenStreetMap (local ICPs: clinics, agencies, shops),
//        which is also the only source here that carries a published phone number
//
// A source that cannot answer the campaign's ICP contributes nothing rather than
// guessing, and every candidate carries the URL it came from as evidence, so the
// same provenance rule holds as for the paid path.
//
// No LLM is involved in this file: descriptions are the page's own title and meta
// description, copied. An LLM asked to describe a company it has never seen will
// produce a confident paragraph about the wrong business.
import { env } from "../_core/env";
import {
  canonicalDomain,
  canonicalizeUrl,
  dedupeCandidates,
  isLikelyCompanyResult,
  type CompanyCandidate,
  type DiscoverInput,
  type LeadDiscoveryProvider,
} from "./providers";
import type { PageFetcher, ScrapedPage } from "./contactExtraction";

/** Injected so the parsing and selection policy are testable without a network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Both APIs ask to be identified rather than sent anonymous traffic, and a shared
 * "Mozilla/5.0" is what gets an operator's deployment rate-limited or blocked.
 */
export const DISCOVERY_USER_AGENT = `SignalFlow lead research (+${env.publicUrl || "self-hosted"})`;

const YEAR_SECONDS = 60 * 60 * 24 * 365;

// ── tiny HTTP layer: deadline, size cap, and an SSRF guard on every hop ──────
interface GetOptions {
  timeoutMs?: number;
  /**
   * True when a 404 here is an ordinary miss rather than a fault: most companies do
   * not have a /contact page. Left false, only "not there" statuses stay quiet, so
   * a 400 from a malformed query or a 429 from a rate limit is still reported.
   */
  expectMissing?: boolean;
}

const MAX_REDIRECTS = 4;

async function getText(fetchImpl: FetchLike, url: string, accept: string, opts: GetOptions = {}): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? env.httpTimeoutMs);
  try {
    let next = url;
    // Redirects are followed by hand rather than by the client, because every hop
    // has to pass the SSRF check: `redirect: "follow"` would let a public site point
    // us at the cloud metadata address. Homepages do move (http→https, www→apex), so
    // refusing to follow at all is how a live company reads as "no homepage".
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      const safe = canonicalizeUrl(next);
      if (!safe) return null;
      const res = await fetchImpl(safe, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": DISCOVERY_USER_AGENT, Accept: accept },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers?.get("location");
        if (!location) return noteFailure(safe, res.status, undefined, opts.expectMissing);
        next = new URL(location, safe).toString();
        continue;
      }
      if (!res.ok) return noteFailure(safe, res.status, undefined, opts.expectMissing);
      const text = await res.text();
      // Truncate rather than reject: a 5 MB marketing page still has its first
      // hundred kilobytes, which is where a contact page keeps its addresses.
      return text.slice(0, env.httpMaxBytes);
    }
    return noteFailure(url, 0, new Error(`redirected more than ${MAX_REDIRECTS} times`), opts.expectMissing);
  } catch (err) {
    return noteFailure(url, 0, err, opts.expectMissing);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A source that answers 504, or one we aborted at 12 s, looks exactly like a source
 * with nothing useful in it if the failure is swallowed. Silent "zero candidates" is
 * how a working feature gets deleted by someone reading a runbook — the first live
 * run of this engine "returned no dentists in Berlin" for a query Overpass had
 * rejected with a 400. Degrade the run, but say so.
 */
function noteFailure(url: string, status: number, err?: unknown, expectMissing = false): null {
  const missing = expectMissing && (status === 404 || status === 410 || status === 403);
  if (missing) return null;
  const cause = status >= 400 ? `HTTP ${status}` : describeError(err);
  console.warn(`[discovery] ${url.split("/").slice(0, 3).join("/")} failed: ${cause}`);
  return null;
}

/**
 * `fetch failed` on its own is not actionable: undici hides the real reason on
 * `err.cause` (TLS handshake, connection refused, DNS, body timeout), and those are
 * four different diagnoses for an operator reading a log line.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "no response";
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${err.message} (${detail})` : err.message;
}

async function getJson<T>(fetchImpl: FetchLike, url: string): Promise<T | null> {
  const raw = await getText(fetchImpl, url, "application/json");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A 200 that is not JSON is usually an HTML error page from a proxy or a rate
    // limiter, which reads as "the source returned nothing" if this stays silent.
    console.warn(`[discovery] ${url.split("/").slice(0, 3).join("/")} answered with something that is not JSON`);
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── HTML → text, for reading a company's own pages without a scraper service ──
const DROP_ELEMENTS = /<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi;

/**
 * Deliberately not a parser: contact extraction wants the visible words, and the
 * difference between "real text" and "text inside a script tag" is the difference
 * between a published address and a hard-coded one in someone's analytics snippet.
 */
export function htmlToText(html: string): string {
  return html
    .replace(DROP_ELEMENTS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&(lt|gt);/gi, (_, t) => (t.toLowerCase() === "lt" ? "<" : ">"))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITY_RE = /&(nbsp|amp|lt|gt|#\d+|#[xX][0-9a-f]+);/i;

/** Decode the entities a meta tag can contain, twice if the page double-escaped. */
function decodeEntities(value: string): string {
  let out = value;
  for (let pass = 0; pass < 2 && ENTITY_RE.test(out); pass++) {
    out = htmlToText(out);
  }
  return out;
}

function metaContent(html: string, key: string, min = 8): string | null {
  // `og:` values live in `property=`, a plain description in `name=` — and plenty
  // of real pages get that backwards, so a bare `description` accepts either.
  const prop = key.startsWith("og:") ? "property" : "(?:name|property)";
  const pattern = new RegExp(`<meta[^>]+${prop}\\s*=\\s*["']${key}["'][^>]*\\bcontent\\s*=\\s*["']([^"']{${min},})["']`, "i");
  const alt = new RegExp(`<meta[^>]+\\bcontent\\s*=\\s*["']([^"']{${min},})["'][^>]*${prop}\\s*=\\s*["']${key}["']`, "i");
  const raw = pattern.exec(html)?.[1]?.trim() ?? alt.exec(html)?.[1]?.trim();
  // Decoded, because a meta value is raw HTML attribute text: a live run produced a
  // prospect described as "Spielautomaten &amp;amp; Live Casino".
  return raw ? decodeEntities(raw).slice(0, 300) : null;
}

export function pageTitle(html: string): string | null {
  const og = metaContent(html, "og:title");
  if (og) return og;
  const title = /<title[^>]*>([\s\S]{3,300}?)<\/title>/i.exec(html)?.[1];
  return title ? htmlToText(title).slice(0, 200) : null;
}

/**
 * What a site calls itself, in its own words. Short by nature ("Kailo", "Aclif"),
 * hence the lower minimum than a description gets.
 */
function siteName(html: string): string | null {
  const og = metaContent(html, "og:site_name", 2);
  if (og) return og.slice(0, 60);
  // JSON-LD `{"@type":"Organization","name":"…"}` is the other place a brand is
  // stated explicitly, and marketing sites put it in the head far more than in a meta.
  const ld = /"@type"\s*:\s*"(?:Organization|LocalBusiness|Corporation)"[\s\S]{0,200}?"name"\s*:\s*"([^"\n]{2,60})"/i.exec(html);
  return ld?.[1]?.trim() ?? null;
}

// ── naming a company, from what it says about itself ─────────────────────────
/**
 * A Show HN headline is a sentence written to be clicked, not a company name: a
 * live run produced "I made a free list of 100 places to promote your SaaS" and
 * "The agent that builds and operates its own SaaS tools" as prospect names, which
 * would then be printed in the operator's pipeline and in the draft's greeting.
 * Names that pass are short and do not begin with somebody talking about themselves.
 */
const SENTENCE_LIKE = /^(?:i|we|my|our|how|why|what|this|that|one|building|built|made|created|open(?:ing)?[- ]?sourc\w*)\b/i;

export function looksLikeSentence(title: string): boolean {
  return SENTENCE_LIKE.test(title.trim()) || title.trim().length > 48;
}

/** `launchdirectories.com` -> `Launchdirectories`; a label, not a brand claim. */
function domainLabel(domain: string): string {
  const label = (domain || "").split(".").slice(0, -1).join(".") || domain;
  const words = label.split(/[-_.]/).filter(Boolean);
  const joined = words.map((w) => (w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join("");
  return joined.slice(0, 60);
}

/**
 * Best available name at announcement time: the headline's leading segment when it
 * reads as a name, otherwise the domain's own label. Never a sentence.
 */
export function brandFromTitle(title: string, domain: string): string {
  const first = title.split(/[|—–]|\s-\s/).map((s) => s.trim()).filter(Boolean)[0] ?? "";
  const cleaned = first.replace(/^(?:show|ask)\s+hn\s*[:—-]?\s*/i, "").trim();
  if (cleaned && !looksLikeSentence(cleaned)) return cleaned.slice(0, 60);
  return domainLabel(domain);
}

/**
 * A candidate that came from the map, as opposed to from an announcement. Only the
 * map asserts that a given domain belongs to a given named business, so only the map
 * can be contradicted by reading that domain.
 */
const isMappedBusiness = (c: CompanyCandidate): boolean => /openstreetmap\.org/.test(c.sourceUrl || "");

/**
 * Does the page say anything the name says? A shared word of four letters or more
 * ("Hartfiel" in "Zahnarztpraxis Hartfiel") is the weakest possible confirmation that
 * the domain still belongs to the business mapped on it. When the name has no
 * distinctive word at all there is nothing to compare, and the candidate is kept with
 * its evidence rather than guessed about.
 */
export function sharesNameToken(name: string, pageText: string): boolean {
  const tokens = (name || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 4);
  if (!tokens.length) return true;
  const hay = (pageText || "").toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

// ── source: Hacker News ───────────────────────────────────────────────────────
interface HnHit {
  title?: string;
  url?: string;
  story_text?: string;
  created_at?: string;
  objectID?: string;
  _tags?: string[];
}

/** Keywords worth searching HN with, from the campaign and its ICP. */
function hnQueries(input: DiscoverInput): string[] {
  const out = [input.industry, input.targetDescription, ...(input.icp?.industries ?? [])]
    .filter((s): s is string => Boolean(s && s.trim().length > 2))
    .map((s) => s.trim().slice(0, 60));
  return [...new Set(out)].slice(0, 3);
}

/**
 * `tags=show_hn`, not `tags=story`. A live run against the latter for "B2B SaaS"
 * returned nytimes.com and lemonde.fr — matching titles matches journalism about a
 * topic, while Show HN is the place where the people building that topic announce
 * what they made. Only the second kind can become a prospect.
 */
async function fromHackerNews(fetchImpl: FetchLike, input: DiscoverInput, limit: number): Promise<CompanyCandidate[]> {
  const since = Math.floor(Date.now() / 1000) - YEAR_SECONDS;
  const found: CompanyCandidate[] = [];
  for (const query of hnQueries(input)) {
    const url =
      "https://hn.algolia.com/api/v1/search?query=" +
      encodeURIComponent(query) +
      "&tags=show_hn&numericFilters=created_at_i%3E" +
      since +
      `&hitsPerPage=${Math.min(30, limit * 3)}`;
    const body = await getJson<{ hits?: HnHit[] }>(fetchImpl, url);
    for (const hit of body?.hits ?? []) {
      const target = hit.url;
      if (!target || !isLikelyCompanyResult(target)) continue;
      const title = (hit.title ?? "").replace(/^(Show HN|Ask HN)\s*[:—-]\s*/i, "").trim();
      if (!title) continue;
      const domain = canonicalDomain(target);
      found.push({
        name: brandFromTitle(title, domain) || domain,
        domain,
        description: title.slice(0, 300),
        websiteUrl: canonicalizeUrl(target) ?? target,
        industry: input.industry,
        // Not `geography: input.geography`: a Show HN announcement says nothing about
        // where the company is, and stamping the campaign's city onto it makes a
        // French directory look like the Berlin clinic the operator asked for.
        sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID ?? ""}`,
        origin: "live",
        evidence: [
          {
            claim: `Announced on Hacker News as "${title}"${hit.created_at ? ` on ${hit.created_at.slice(0, 10)}` : ""}`,
            sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID ?? ""}`,
          },
        ],
      });
      if (found.length >= limit) break;
    }
    if (found.length >= limit) break;
    await sleep(env.politenessMs);
  }
  return found;
}

// ── source: OpenStreetMap (Overpass) ──────────────────────────────────────────
/**
 * ICP wording → Overpass tag selectors. Only listed categories are searched:
 * guessing a tag for an unmapped industry would return businesses that sell
 * something else entirely, which is worse than returning nothing.
 */
const OSM_SELECTORS: { matches: RegExp; selectors: string[] }[] = [
  { matches: /dent|oral care/i, selectors: ['"amenity"="dentist"', '"healthcare"="dentist"'] },
  {
    matches: /clinic|medical|health care|physio/i,
    selectors: ['"amenity"="clinic"', '"amenity"="doctors"', '"healthcare"="clinic"'],
  },
  { matches: /gym|fitness|studio/i, selectors: ['"leisure"="fitness_centre"', '"leisure"="sports_centre"'] },
  { matches: /restaurant|cafe|coffee|food|catering/i, selectors: ['"amenity"="restaurant"', '"amenity"="cafe"'] },
  { matches: /real estate|property|estate agent/i, selectors: ['"office"="estate_agent"'] },
  { matches: /law|legal|attorney|solicitor/i, selectors: ['"office"="lawyer"'] },
  { matches: /salon|barber|beauty|spa/i, selectors: ['"shop"="hairdresser"', '"shop"="beauty"'] },
  {
    matches: /plumb|electric|hvac|repair|trades|construction/i,
    selectors: ['"craft"="electrician"', '"craft"="plumber"', '"shop"="hardware"'],
  },
  { matches: /school|tutor|training|kindergarten/i, selectors: ['"amenity"="school"', '"amenity"="language_school"'] },
  { matches: /software|saas|tech|digital|startup|agency|marketing|design|consult/i, selectors: ['"office"="company"'] },
  { matches: /hotel|hostel|travel|tourism/i, selectors: ['"tourism"="hotel"', '"tourism"="guest_house"'] },
];

function osmSelectors(input: DiscoverInput): string[] | null {
  const haystack = [input.industry, input.targetDescription, input.offer, ...(input.icp?.industries ?? [])].join(" ");
  for (const entry of OSM_SELECTORS) {
    if (entry.matches.test(haystack)) return entry.selectors;
  }
  return null;
}

/**
 * Overpass area lookup needs a place, not a market: "US" and "Global" are not
 * administrative boundaries, so this returns null and the source sits out rather
 * than querying the whole planet.
 */
function osmArea(geography: string): string | null {
  const g = geography.trim();
  if (!g || g.length > 60) return null;
  if (/^(us|usa|uk|eu|europe|global|world|north america|remote|dACH|emea)$/i.test(g)) return null;
  if (/[,;|/]/.test(g)) return null;
  return g;
}

interface OverpassElement {
  type?: string;
  id?: number;
  tags?: Record<string, string>;
}

/** "Listed in OpenStreetMap as a dentist, Berlin" — what the map actually asserts. */
function osmDescription(name: string, tags: Record<string, string>): string {
  const kind = [tags["shop"], tags["amenity"], tags.office, tags.craft, tags.leisure, tags.tourism, tags.healthcare]
    .filter(Boolean)
    .join(", ");
  const city = tags["addr:city"] ? `, ${tags["addr:city"]}` : "";
  return (kind ? `Listed in OpenStreetMap as ${kind}${city}` : `Listed in OpenStreetMap as ${name}`).slice(0, 300);
}

/** Overpass string literals are double-quoted with backslash escapes. */
const qlLiteral = (value: string) => '"' + value.replace(/[\\"]/g, "\\$&") + '"';

/**
 * Build the query. Every selector goes inside ONE parenthesised union, terminated by
 * a semicolon — which is what the first live run taught me twice over: the previous
 * shape opened a parenthesis per selector and closed one overall, and even the fixed
 * union lacked the statement's terminating semicolon, so Overpass answered both with
 * a 400. A rejected query and an empty region look identical from the outside until
 * the status is logged.
 */
export function overpassQuery(area: string, selectors: string[], limit: number, timeoutMs: number): string {
  const serverTimeout = Math.max(15, Math.floor(timeoutMs / 1000) - 5);
  // Asked for far more rows than `limit`, because most mapped businesses carry no
  // website and are dropped before they can become a lead: a live run for "dentists,
  // Berlin" got 12 rows and only about half of them were reachable. Overpass returns
  // them in one request either way, so the surplus costs bandwidth, not politeness.
  const outCount = Math.min(200, Math.max(25, limit * 8));
  const union = `(${selectors.map((s) => `nwr[${s}](area.searchArea);`).join("")})`;
  // Admin areas are matched by their local name, so "Lisbon" only works if the
  // relation happens to carry name:en. Search both spellings — quoted, because an
  // unquoted `name:en` is a parse error (Overpass reads the colon as an operator).
  const areas =
    `(area["name"=${qlLiteral(area)}]["boundary"="administrative"];` +
    `area["name:en"=${qlLiteral(area)}]["boundary"="administrative"];)`;
  return (
    `[out:json][timeout:${serverTimeout}];` + `${areas}->.searchArea;` + union + `;out tags ${outCount};`
  );
}

/**
 * One query, tried against each mirror in order and then once more through the list.
 * Live behaviour this is written against: overpass-api.de answered 200 in 5 s on one
 * run and 504 on the next two, while every community mirror hung past our deadline
 * from the same network. A refused request is a property of one server at one moment,
 * so stopping at the first refusal would report an empty city.
 *
 * The whole lookup runs on a budget, and the reason it gave up is stated: "no
 * candidates" and "no server would answer" are different facts.
 */
async function runOverpass(fetchImpl: FetchLike, ql: string): Promise<OverpassElement[]> {
  const endpoints = env.overpassEndpoints
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const deadline = Date.now() + env.overpassBudgetMs;
  for (let pass = 0; pass < 2; pass++) {
    for (const endpoint of endpoints) {
      if (Date.now() >= deadline) {
        console.warn(
          `[discovery] OpenStreetMap skipped: no endpoint answered within ${env.overpassBudgetMs} ms. ` +
            "This is the source being busy, not the city being empty.",
        );
        return [];
      }
      const body = await postForm(fetchImpl, endpoint, ql, deadline);
      if (body) return body.elements ?? [];
      await sleep(env.politenessMs);
    }
  }
  return [];
}

async function fromOpenStreetMap(fetchImpl: FetchLike, input: DiscoverInput, limit: number): Promise<CompanyCandidate[]> {
  const selectors = osmSelectors(input);
  const area = osmArea(input.geography);
  if (!selectors || !area) return [];
  const ql = overpassQuery(area, selectors, limit, env.overpassTimeoutMs);
  const elements = await runOverpass(fetchImpl, ql);
  const found: CompanyCandidate[] = [];
  let phoneOnly = 0;
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags.name?.trim();
    if (!name) continue;
    const website = tags.website || tags["contact:website"];
    const sourceUrl = `https://www.openstreetmap.org/${el.type ?? "node"}/${el.id ?? 0}`;
    const evidence: { claim: string; sourceUrl: string }[] = [];
    const phone = tags.phone || tags["contact:phone"];
    if (website) evidence.push({ claim: `Mapped in OpenStreetMap with website ${website}`, sourceUrl });
    if (phone) evidence.push({ claim: `Phone published on its OpenStreetMap entry: ${phone}`, sourceUrl });
    if (!evidence.length) continue; // a name with no way to reach or verify it is not a lead
    const domain = website ? canonicalDomain(website) : "";
    if (!domain) {
      // A mapped phone number is a lead for a channel this product does not have
      // yet (a candidate is identified by its company domain, and there is no phone
      // field to carry the number). Counted and reported, never quietly discarded.
      phoneOnly++;
      continue;
    }
    found.push({
      name: name.slice(0, 60),
      domain,
      description: osmDescription(name, tags),
      websiteUrl: website ? canonicalizeUrl(website) ?? "" : "",
      geography: tags["addr:city"] || area,
      sourceUrl,
      origin: "live",
      evidence,
    });
    if (found.length >= limit) break;
  }
  if (phoneOnly) {
    console.warn(
      `[discovery] OpenStreetMap named ${phoneOnly} business(es) in ${area} with a phone but no website; ` +
        "a prospect is keyed by its domain, so they were not carried forward.",
    );
  }
  return found;
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  data: string,
  deadline?: number,
): Promise<{ elements?: OverpassElement[] } | null> {
  const safe = canonicalizeUrl(url);
  if (!safe) return null;
  const controller = new AbortController();
  const remaining = deadline ? Math.max(1_000, deadline - Date.now()) : env.overpassTimeoutMs;
  const timer = setTimeout(() => controller.abort(), Math.min(env.overpassTimeoutMs, remaining));
  try {
    const res = await fetchImpl(safe, {
      method: "POST",
      signal: controller.signal,
      redirect: "manual",
      headers: {
        "User-Agent": DISCOVERY_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "data=" + encodeURIComponent(data),
    });
    if (!res.ok) return noteFailure(url, res.status);
    return JSON.parse(await res.text()) as { elements?: OverpassElement[] };
  } catch (err) {
    return noteFailure(url, 0, err);
  } finally {
    clearTimeout(timer);
  }
}

// ── the provider ──────────────────────────────────────────────────────────────
const SOURCES: Record<string, (f: FetchLike, i: DiscoverInput, l: number) => Promise<CompanyCandidate[]>> = {
  hn: fromHackerNews,
  osm: fromOpenStreetMap,
};

export class OpenWebDiscovery implements LeadDiscoveryProvider {
  readonly name = "open" as const;

  constructor(private readonly fetchImpl: FetchLike = globalThis.fetch) {}

  /** Sources the operator asked for, minus anything that is not implemented. */
  private enabled(): string[] {
    return env.openDiscoverySources
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s in SOURCES);
  }

  async discoverProspects(input: DiscoverInput): Promise<CompanyCandidate[]> {
    const perSource = Math.max(1, Math.ceil(Math.min(input.prospectTarget * 2, env.openDiscoveryLimit) / Math.max(1, this.enabled().length)));
    const collected: CompanyCandidate[] = [];
    for (const source of this.enabled()) {
      const part = await SOURCES[source]!(this.fetchImpl, input, perSource).catch(() => [] as CompanyCandidate[]);
      collected.push(...part);
      await sleep(env.politenessMs);
    }
    const deduped = dedupeCandidates(collected.filter((c) => c.domain));
    const described = await this.describeFromOwnSite(deduped.slice(0, env.openDiscoveryHomepageReads));
    // Candidates beyond the homepage-read budget keep whatever the source said about
    // them; being unverified is a limitation to report, not a reason to invent text.
    return described.slice(0, Math.max(1, input.prospectTarget));
  }

  /**
   * A source that only names a company is a weak lead: qualification has nothing to
   * work with. Reading the homepage's own title and description costs one plain HTTP
   * GET and no credits, so the free path still produces evidence rather than a shell.
   *
   * The read is also the last honest check available: a mapped business whose domain
   * now serves something else is not a lead, it is a bounce (or worse, a complaint).
   * Returns the candidates that survived, dropping the contradicted ones with a word
   * about why.
   */
  private async describeFromOwnSite(candidates: CompanyCandidate[]): Promise<CompanyCandidate[]> {
    const kept: CompanyCandidate[] = [];
    for (const c of candidates) {
      // The root, not the URL the source happened to point at: a Show HN link is
      // often a blog post or a repo page, and its title describes that article.
      const url = c.domain ? canonicalizeUrl(`https://${c.domain}`) : null;
      if (!url) {
        kept.push(c);
        continue;
      }
      const html = await getText(this.fetchImpl, url, "text/html", { expectMissing: true });
      if (!html) {
        c.evidence.push({
          claim: `Its website at ${url} did not answer, so nothing published there could be verified`,
          sourceUrl: url,
        });
        kept.push(c);
        continue;
      }
      const title = pageTitle(html);
      const summary = metaContent(html, "description") ?? metaContent(html, "og:description");
      const text = [title, summary].filter(Boolean).join(" — ").slice(0, 300);
      if (!text) {
        kept.push(c);
        continue;
      }
      if (isMappedBusiness(c) && !sharesNameToken(c.name, text)) {
        // Only OpenStreetMap is checked this way: a map entry asserts a name for that
        // domain, whereas a Hacker News headline is a product announcement whose title
        // need not appear on the site at all.
        console.warn(
          `[discovery] dropped ${c.domain}: OpenStreetMap calls it "${c.name}" but the site at ${url} says "${text.slice(0, 90)}". ` +
            "The domain has almost certainly changed hands since it was mapped.",
        );
        continue;
      }
      c.description = text;
      // The site's own name beats the announcement's headline, and beats the domain
      // label too: "Kailo" is written in its own HTML, while getfast.ai only says
      // `getfast`. Adopt it only when nothing better is already known.
      const own = siteName(html);
      if (own && (looksLikeSentence(c.name) || c.name.toLowerCase() === domainLabel(c.domain).toLowerCase())) {
        c.name = own;
      }
      c.evidence.push({ claim: `Its own homepage says: ${text}`, sourceUrl: url });
      kept.push(c);
      await sleep(env.politenessMs);
    }
    return kept;
  }

  /**
   * The second pass over /contact|/team|/about, with no scraper service in front of
   * it. Only what the server renders is visible here — a contact form wired up in
   * JavaScript will not be found, and that is a limit to state, not to hide.
   */
  async fetchPages(urls: string[]): Promise<ScrapedPage[]> {
    const pages: ScrapedPage[] = [];
    for (const raw of urls) {
      const url = canonicalizeUrl(raw);
      if (!url) continue;
      const html = await getText(this.fetchImpl, url, "text/html,application/xhtml+xml", { expectMissing: true });
      if (!html) continue;
      const text = htmlToText(html);
      if (text.length > 40) pages.push({ url, text });
      await sleep(env.politenessMs);
    }
    return pages;
  }

  /** Exposed for the page-fetch contract used by contact extraction. */
  get pageFetcher(): PageFetcher {
    return (urls) => this.fetchPages(urls);
  }
}

export function openDiscoveryConfigured(): boolean {
  return env.discoveryProvider.trim().toLowerCase() === "open";
}
