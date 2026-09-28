// Paid enrichment providers: the legal, reliable route to a *named* decision
// maker (and, where the provider holds it, a phone number and a social profile).
//
// Why this exists next to contactExtraction.ts, which is free:
//
// - Page scraping finds whatever a company chose to print. Small companies print
//   `hello@`, and agencies print nothing at all. A data provider holds the
//   founder's direct address, a seniority label, and often a mobile number.
// - It is also the only compliant route to non-email coordinates. Scraping
//   LinkedIn breaks LinkedIn's terms of service; buying from a provider that
//   licenses the data is the same lookup without the legal exposure.
//
// What this module deliberately does NOT do:
//
// - It never invents a value. Every field is read from a provider response, and
//   anything the provider did not return stays null.
// - It never returns a personal mailbox. A work address at the company's own
//   domain is the only acceptable email, whatever the provider offers. Cold
//   mailing a bought `@gmail.com` is the behaviour that gets domains burned, and
//   providers do surface personal emails when asked (`reveal_personal_emails`).
//   We do not ask, and we drop them if they arrive anyway.
// - It never requests phone numbers asynchronously. Apollo's `reveal_phone_number`
//   costs 8 credits and is delivered to a webhook that this app does not have, so
//   we take only numbers the synchronous response already carries.
//
// Field-name note, stated honestly because it matters: the Apollo mapping below is
// transcribed from the providers' published OpenAPI definitions. The Hunter mapping
// is transcribed from the response examples in their public docs; their docs site
// could not be reached from the network this was written on, so every Hunter field
// is read through `str()` with the known aliases, and the first live call must be
// diffed against a logged raw body (docs/verification.md, "Contact discovery").
import { env } from "../_core/env";
import { canonicalDomain } from "./providers";
import { isRoleMailbox, isUsableEmail } from "./contactExtraction";

/** A person as returned by an enrichment provider, with nothing invented. */
export interface EnrichedPerson {
  firstName: string;
  lastName: string;
  /** Null when the provider has no address for this person. */
  email: string | null;
  title: string | null;
  /** Provider's own deliverability label, passed through verbatim. */
  emailStatus: string | null;
  /** Provider's match confidence. Low/none means "we guessed who you meant". */
  matchConfidence: "high" | "medium" | "low" | "none" | "unknown";
  phone: string | null;
  /** Profile URL only — a bare handle is not something we can act on. */
  socialUrl: string | null;
  provider: string;
  /**
   * The API call this record came from: provenance for the GDPR answer later.
   * Credential-free by construction — see `redactCredential`. The alternative
   * (storing the URL as called) would put an API key in a database row that the
   * UI then renders.
   */
  sourceUrl: string;
}

export interface EnrichmentQuery {
  domain: string;
  /** Job titles worth preferring, from the campaign's ICP. Optional. */
  titles?: string[];
  /** Maximum people to look up. Providers charge per record. */
  limit?: number;
}

/**
 * Minimal HTTP seam. Injected so the mapping is unit-testable without a key and
 * so a provider outage degrades to "no data" instead of failing discovery.
 */
export interface HttpJson {
  (url: string, init?: { headers?: Record<string, string> }): Promise<unknown>;
}

export interface EnrichmentProvider {
  readonly name: string;
  findPeople(query: EnrichmentQuery): Promise<EnrichedPerson[]>;
}

// ── Defensive readers ────────────────────────────────────────────────────────
// Provider JSON is third-party data whose shape changes without telling us.
// Reading by alias list, and returning null rather than throwing, keeps a
// renamed field from taking down the pipeline.
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((r) => Object.keys(r).length > 0)
    : [];
}

/** First non-empty string among `keys`, trimmed. */
function str(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function lowerBool(obj: Record<string, unknown>, key: string): boolean | null {
  const v = obj[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (/^(true|yes|1)$/i.test(v)) return true;
    if (/^(false|no|0)$/i.test(v)) return false;
  }
  return null;
}

/** Accept a profile only as a URL; a bare `twitter: "handle"` is dropped. */
function asUrl(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * Providers return phone numbers in several shapes: a plain string, an array of
 * objects with `raw_number`/`sanitized_number`, or an array of strings.
 */
function firstPhone(obj: Record<string, unknown>): string | null {
  const direct = str(obj, ["phone_number", "phone", "direct_phone", "mobile"]);
  if (direct) return direct.slice(0, 40);
  const list = Array.isArray(obj["phone_numbers"]) ? obj["phone_numbers"] : [];
  for (const entry of list) {
    if (typeof entry === "string" && entry.trim()) return entry.slice(0, 40);
    const rec = asRecord(entry);
    // `sanitized_number` (E.164) beats `raw_number` ("(415) 555-0158") because it
    // is dialable without guessing the country code.
    const value = str(rec, ["sanitized_number", "raw_number", "value", "number"]);
    if (value) return value.slice(0, 40);
  }
  return null;
}

function emailList(obj: Record<string, unknown>): Record<string, unknown>[] {
  return asList(obj["emails"]);
}

/** Email + its status, taken from the record itself or its `emails[]` array. */
function readEmail(obj: Record<string, unknown>): { email: string | null; status: string | null } {
  const candidates: Record<string, unknown>[] = [obj, ...emailList(obj)];
  for (const entry of candidates) {
    const email = str(entry, ["email", "value", "work_email"]);
    if (email) {
      const verification = asRecord(entry["verification"]);
      return {
        email,
        status: str(entry, ["email_status", "status"]) ?? str(verification, ["status", "result"]),
      };
    }
  }
  return { email: null, status: null };
}

function matchConfidence(obj: Record<string, unknown>): EnrichedPerson["matchConfidence"] {
  const raw = str(obj, ["match_confidence"])?.toLowerCase();
  return raw === "high" || raw === "medium" || raw === "low" || raw === "none" ? raw : "unknown";
}

/**
 * Hunter authenticates with `api_key` in the query string, so the URL of the call
 * *is* a credential. Provenance is stored on every contact and shown in the UI,
 * so the key is replaced before the URL leaves this module.
 */
export function redactCredential(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of ["api_key", "apikey", "key"]) {
      if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString();
  } catch {
    // Not a parseable URL: the path alone is still the honest answer.
    return url.split("?")[0] ?? url;
  }
}

function buildPerson(
  raw: unknown,
  opts: { provider: string; sourceUrl: string; domain: string },
): EnrichedPerson | null {
  const obj = asRecord(raw);
  const fullName = str(obj, ["name", "full_name"]);
  const firstName = str(obj, ["first_name"]) ?? (fullName ? fullName.split(" ")[0] ?? "" : "");
  // Apollo search results obfuscate the surname (`Hu***n`) until the record is
  // enriched. An obfuscated name is not a name: greeting "Dear Hu***n" is worse
  // than no greeting, so such a record is dropped unless enrichment filled it in.
  const lastNameRaw = str(obj, ["last_name"]);
  const lastName = lastNameRaw && !lastNameRaw.includes("*") ? lastNameRaw : "";
  const { email, status } = readEmail(obj);
  if (!firstName && !lastName && !email) return null;

  return {
    firstName,
    lastName,
    email: email ? email.toLowerCase() : null,
    title: str(obj, ["title", "position"]),
    emailStatus: status,
    matchConfidence: matchConfidence(obj),
    phone: firstPhone(obj),
    socialUrl: asUrl(str(obj, ["linkedin_url", "linkedin", "linked_in"]) ?? null),
    provider: opts.provider,
    sourceUrl: opts.sourceUrl,
  };
}

// ── Selection policy ─────────────────────────────────────────────────────────
const DECISION_MAKER =
  /founder|co-?founder|\bceo\b|\bcto\b|\bcoo\b|\bcfo\b|\bcmo\b|president|owner|principal|partner|head of|director|vp\b|vice president|general manager|lead\b/i;

const isDecisionMaker = (title: string | null): boolean => Boolean(title && DECISION_MAKER.test(title));

/**
 * Which of the provider's people is worth emailing first.
 *
 * Ordering is a policy, not a preference: a decision-maker we can address by
 * name, at the company's own domain, with a verified mailbox and a confident
 * match. Anything else is a stranger with a bought address.
 */
export function rankPeople(people: EnrichedPerson[], domain: string): EnrichedPerson[] {
  const base = canonicalDomain(domain || "");
  const usable = people.filter((p): p is EnrichedPerson => {
    if (!p.email || !isUsableEmail(p.email)) return false;
    // A shared mailbox is not a person, and paying for one is the clearest way
    // to waste the credit: Hunter and Apollo both surface `info@`-class addresses
    // when a domain has no better record. The free page pass may still keep such
    // an address as a last resort; a bought one has to be worth writing to.
    if (isRoleMailbox(p.email)) return false;
    // Work address at this company only. Personal mailboxes are excluded even
    // when the provider supplies them, and even though that throws away paid
    // data: cold-mailing a bought personal address is how senders get flagged,
    // and it is the part of this industry that deserves its reputation.
    if (canonicalDomain(p.email.split("@")[1] ?? "") !== base) return false;
    // A low/none match means the provider is not sure this is the person asked
    // for. Mailing on that guess reaches a stranger.
    if (p.matchConfidence === "low" || p.matchConfidence === "none") return false;
    // Explicit "risky"/"invalid"/"catch_all" labels are refused: a bad mailbox
    // hurts the domain we are trying to warm up, not just this message.
    const status = (p.emailStatus ?? "").toLowerCase();
    if (/^(risky|invalid|undeliverable|unavailable|unknown|disposable|role|catch_all|catch-all)$/.test(status)) {
      // `catch_all` and `role` are deliberately refused too: they describe a
      // mailbox that may not be a person, which is the same deliverability risk.
      return false;
    }
    return true;
  });

  const score = (p: EnrichedPerson): number => {
    let s = 0;
    if (p.title && isDecisionMaker(p.title)) s += 6;
    if (p.emailStatus?.toLowerCase() === "verified") s += 4;
    if (p.matchConfidence === "high") s += 3;
    else if (p.matchConfidence === "medium") s += 1;
    if (p.firstName && p.lastName) s += 2;
    if (p.phone) s += 1;
    if (p.socialUrl) s += 1;
    return s;
  };
  return [...usable].sort((a, b) => score(b) - score(a));
}

// ── Hunter.io ────────────────────────────────────────────────────────────────
// One call per company: `domain-search` returns the people Hunter has seen at
// that domain, each with an address we can then use directly. `email-finder`
// (one credit per named person) is not used here because we start from a company,
// not a person, and because it returns a *predicted* address rather than an
// observed one — the difference matters when the prediction is wrong.
export function createHunterProvider(opts: {
  apiKey: string;
  http: HttpJson;
  baseUrl?: string;
}): EnrichmentProvider {
  const base = opts.baseUrl ?? "https://api.hunter.io/v2";
  return {
    name: "hunter",
    async findPeople({ domain, limit = 10 }) {
      const target = new URL(`${base}/domain-search`);
      target.searchParams.set("domain", domain);
      target.searchParams.set("api_key", opts.apiKey);
      // Deliberately no `verification=1`: it is a separate paid meter and the
      // MX check we already run answers the only question we act on.
      const body = asRecord(await opts.http(target.toString()));
      const data = asRecord(body["data"]);
      const records = asList(data["emails"]);
      const people = records
        .map((r) =>
          buildPerson(r, { provider: "hunter", sourceUrl: redactCredential(target.toString()), domain }),
        )
        .filter((p): p is EnrichedPerson => p !== null);
      return rankPeople(people, domain).slice(0, Math.max(1, limit));
    },
  };
}

// ── Apollo.io ────────────────────────────────────────────────────────────────
// Two calls per person, and that is not laziness: search results carry an
// obfuscated surname and only `has_email` flags, so the address itself only
// exists after the enrichment call. `person_seniorities`/`person_titles` narrow
// the search so we pay to enrich people we would actually write to.
export function createApolloProvider(opts: {
  apiKey: string;
  http: HttpJson;
  baseUrl?: string;
}): EnrichmentProvider {
  const base = opts.baseUrl ?? "https://api.apollo.io/api/v1";
  const headers = { "content-type": "application/json", "x-api-key": opts.apiKey };
  return {
    name: "apollo",
    async findPeople({ domain, titles = [], limit = 5 }) {
      const search = new URL(`${base}/mixed_people/api_search`);
      search.searchParams.set("q_organization_domains_list[]", domain);
      for (const title of titles.slice(0, 5)) search.searchParams.set("person_titles[]", title);
      search.searchParams.set("per_page", String(Math.min(10, Math.max(1, limit))));
      search.searchParams.set("page", "1");

      const body = asRecord(await opts.http(search.toString(), { headers }));
      // Apollo also exposes `/people/search` with the same parameter names; both
      // return `people[]`, so the reader does not care which one was called.
      const found = asList(body["people"]);
      // When the caller named no titles, order by the title the *search* result
      // already shows. The surname and address only exist after a paid call, so
      // this ordering is the one chance to point the spend at a decision maker
      // rather than at whoever Apollo happened to list first.
      const ordered =
        titles.length > 0
          ? found
          : [...found].sort(
              (a, b) =>
                Number(isDecisionMaker(str(b, ["title", "position"]))) -
                Number(isDecisionMaker(str(a, ["title", "position"]))),
            );
      const out: EnrichedPerson[] = [];
      for (const person of ordered) {
        if (out.length >= Math.max(1, limit)) break;
        // Skip before spending a credit: no email on file, or Apollo is not sure
        // this is even the right company.
        if (lowerBool(person, "has_email") === false) continue;
        const id = str(person, ["id", "person_id"]);
        if (!id) continue;

        const match = new URL(`${base}/people/match`);
        match.searchParams.set("id", id);
        // Parameters go in the query string even though the method is POST — that
        // is how Apollo's own OpenAPI declares this endpoint.
        const enriched = asRecord(await opts.http(match.toString(), { headers }));
        const record = asRecord(enriched["person"]);
        if (Object.keys(record).length === 0) continue;
        const built = buildPerson(record, {
          provider: "apollo",
          sourceUrl: redactCredential(match.toString()),
          domain,
        });
        if (built) out.push(built);
      }
      return rankPeople(out, domain);
    },
  };
}

// ── Configuration ────────────────────────────────────────────────────────────
/**
 * Call a provider and never let it break the caller. A 429, an expired key, or a
 * provider that is down are all ordinary Tuesday events, and none of them is a
 * reason for discovery or a contact lookup to fail: the honest answer to "who
 * can we write to" is then the empty list, plus a warning line.
 */
export async function lookupPeople(
  provider: EnrichmentProvider | null,
  query: EnrichmentQuery,
): Promise<EnrichedPerson[]> {
  if (!provider) return [];
  try {
    return await provider.findPeople(query);
  } catch (err) {
    console.warn(
      `[enrichment] ${provider.name} lookup failed for ${query.domain} (continuing without paid data):`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * The configured provider, or null. `null` is the common case (no key) and every
 * caller must treat it as "this leg does not run", never as an error.
 *
 * The default fetcher is kept out of the module's import graph until asked for,
 * so unit tests can never reach the network by accident.
 */
let _provider: EnrichmentProvider | null = null;
let _providerKey = "";

export function getEnrichmentProvider(): EnrichmentProvider | null {
  const selected = env.enrichmentProvider || "";
  const key = `${selected}|${env.hunterApiKey}|${env.apolloApiKey}`;
  if (_provider && _providerKey === key) return _provider;
  _providerKey = key;
  _provider = buildEnrichmentProvider({
    selected,
    hunterApiKey: env.hunterApiKey,
    apolloApiKey: env.apolloApiKey,
    http: defaultHttp,
  });
  return _provider;
}

/** Pure factory, so the choice is testable without touching env. */
export function buildEnrichmentProvider(creds: {
  selected: string;
  hunterApiKey: string;
  apolloApiKey: string;
  http: HttpJson;
}): EnrichmentProvider | null {
  const selected = (creds.selected || "").trim().toLowerCase();
  if (selected === "hunter" && creds.hunterApiKey) {
    return createHunterProvider({ apiKey: creds.hunterApiKey, http: creds.http });
  }
  if (selected === "apollo" && creds.apolloApiKey) {
    return createApolloProvider({ apiKey: creds.apolloApiKey, http: creds.http });
  }
  // No implicit pick: spending money should be a decision someone made on
  // purpose, not a fallback that engages because a key happened to be present.
  return null;
}

async function defaultHttp(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<unknown> {
  const method = url.includes("/mixed_people/") || url.includes("/people/match") ? "POST" : "GET";
  const res = await fetch(url, {
    method,
    headers: init?.headers,
    // Apollo documents an empty JSON body for the POST endpoints; parameters
    // themselves stay in the query string, which is what their OpenAPI declares.
    body: method === "POST" ? "{}" : undefined,
    // A hung provider must not hang a job: bounded wait, then the same
    // "continuing without paid data" path any other outage takes.
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${url.split("?")[0]} responded ${res.status}`);
  return await res.json();
}
