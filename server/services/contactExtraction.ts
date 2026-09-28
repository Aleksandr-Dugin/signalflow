// Automatic contact discovery: given a company domain, find a *real* person's
// email on their own public pages. This is the "само находит контакты" leg of the
// original vision (docs/ai-agents.md), which until now only existed for manually
// typed contacts.
//
// Deliberate design choices:
//
// 1. No LLM in this path. Everything here is string work over scraped text. An
//    LLM asked for "the decision maker's email" will happily invent one that looks
//    plausible, and a fabricated address means cold-mailing a stranger with
//    someone else's name in the greeting — a deliverability and trust disaster
//    that no test would catch. Every email returned by these functions appeared,
//    verbatim, on a page we fetched.
// 2. The network lives behind an injected `PageFetcher` so the whole selection
//    policy is unit-testable without an API key, and so a dead or rate-limited
//    scraper degrades to "no contact found" rather than failing discovery.
// 3. Ranking, not filtering, for role addresses. `hello@` is a weak target but a
//    real one, and for most small companies it is the only published address — so
//    it is returned last rather than discarded, with an empty name so the draft
//    greets generically instead of writing "Dear Hello". `noreply@` and friends
//    are excluded outright. And `privacy@`, `legal@`, `dpo@` are deliberately not
//    blocked: for some offers they are exactly the right person, and silently
//    dropping them would hide that from the operator.
import { canonicalizeUrl, type CompanyCandidate } from "./providers";

export interface ScrapedPage {
  url: string;
  text: string;
}

export type PageFetcher = (urls: string[]) => Promise<ScrapedPage[]>;

/** Paths that carry contact data on most company sites, cheapest signal first. */
export const CONTACT_PATHS = ["/contact", "/contact-us", "/team", "/about", "/about-us", "/company"];

// Emails scraped out of markdown frequently turn out to be asset filenames
// (`logo@2x.png` survives an `img` alt-text rewrite) or telemetry endpoints.
const ASSET_SUFFIX =
  /\.(png|jpe?g|gif|webp|svg|ico|avif|css|js|json|xml|woff2?|ttf|eot|mp4|webm|pdf|zip)$/i;

// Addresses that appear in documentation and templates. Persisting one of these
// as a prospect's contact is worse than finding nothing: it guarantees a bounce.
const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "example.io",
  "email.com",
  "yourdomain.com",
  "your-domain.com",
  "domain.com",
  "mydomain.com",
  "company.com",
  "website.com",
  "test.com",
  "testing.com",
  "sentry.io",
  "sentry-next.wixpress.com",
  "wixpress.com",
  "schema.org",
  "w3.org",
]);

// Nobody answers these. They are excluded outright, unlike role addresses below.
const UNREACHABLE_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "noreply-",
  "donotreply",
  "do-not-reply",
  "postmaster",
  "hostmaster",
  "mailer-daemon",
  "abuse",
  "root",
  "daemon",
  "uucp",
  "webmaster",
]);

// Read, but by whoever is on duty — usable, just not the best first target.
const ROLE_LOCAL_PARTS = new Set([
  "hello",
  "hi",
  "info",
  "inf",
  "contact",
  "sales",
  "support",
  "help",
  "office",
  "team",
  "admin",
  "bookings",
  "careers",
  "jobs",
]);

// Free mailboxes are real for micro-businesses but say nothing about the company
// domain, so they rank below any address on the company's own domain.
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
]);

const EMAIL_PATTERN = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,24}/g;

// Trailing punctuation is part of the sentence, not the address; markdown can
// also leave a `mailto:` prefix or a `>` quote marker attached.
function cleanEmail(raw: string): string {
  let e = raw.trim();
  e = e.replace(/^mailto:/i, "");
  e = e.replace(/[.,;:!?')\]}<>"'“”’]+$/g, "");
  return e.toLowerCase();
}

function splitEmail(email: string): { local: string; domain: string } {
  const [local = "", domain = ""] = email.split("@");
  return { local, domain };
}

/** True for anything we would rather not store as a prospect's address. */
export function isUsableEmail(email: string): boolean {
  const { local, domain } = splitEmail(email);
  if (!local || !domain) return false;
  if (local.length > 64 || email.length > 320) return false;
  if (ASSET_SUFFIX.test(domain)) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (UNREACHABLE_LOCAL_PARTS.has(local.replace(/[-_]?\d+$/, ""))) return false;
  // A numeric local part ("123456@facebookmail.com"-style ids) or a single
  // character is never a person we can greet.
  if (/^\d+$/.test(local)) return false;
  if (local.length < 2) return false;
  return true;
}

/** Every distinct, usable address in a page, in order of appearance. */
export function extractEmails(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(EMAIL_PATTERN)) {
    const email = cleanEmail(match[0]);
    if (!email || seen.has(email) || !isUsableEmail(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function titleCase(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word;
}

/**
 * A shared mailbox: somebody reads it, but no particular person does. Worth
 * keeping as a last resort when it is all a company has printed on its own site;
 * never worth paying an enrichment provider for, because the entire point of that
 * call is a named human.
 */
export function isRoleMailbox(email: string): boolean {
  const { local } = splitEmail(email);
  return ROLE_LOCAL_PARTS.has(local.split("+")[0].replace(/\d+$/, ""));
}

/**
 * "jane.doe" / "m.petrova" / "jdoe" -> a display name, `null` when the local part
 * says nothing about a human ("hello", "support2", "1234").
 */
export function nameFromLocalPart(email: string): string | null {
  const { local } = splitEmail(email);
  const base = local.split("+")[0].replace(/\d+$/, "");
  if (!base || ROLE_LOCAL_PARTS.has(base) || UNREACHABLE_LOCAL_PARTS.has(base)) return null;
  if (!/^[a-z][a-z.-]{1,40}$/.test(base)) return null;
  const parts = base.split(/[._-]+/).filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  // A single token ("maria") is plausible; two initials plus nothing ("jd") is not.
  if (parts.length === 1 && parts[0].length < 3) return null;
  if (parts.some((p) => p.length > 20)) return null;
  return parts.map(titleCase).join(" ");
}

const NAME_TITLE_CASE = "([A-ZÀ-Þ][\\p{L}'’.-]{1,30}(?:\\s+[A-ZÀ-Þ][\\p{L}'’.-]{1,30}){1,3})";
const TITLE_WORDS =
  "Founder|Co-?Founder|CEO|CTO|CFO|COO|CMO|CIO|President|Director|Head|Lead|Manager|VP|Owner|Principal|Partner|Officer|Counsel|Advocate|Administrator|Coordinator|Specialist|Engineer|Architect|Analyst|Consultant|Representative";

/** `Jane Doe <jane@…` — the RFC 5322 display form, the strongest signal there is. */
function rfcDisplayName(before: string): string | null {
  const m = new RegExp(`${NAME_TITLE_CASE}\\s*<\\s*$`, "u").exec(before);
  return m?.[1]?.trim() ?? null;
}

/** `[Jane Doe](mailto:…` — markdown link text bound to this exact address. */
function linkTextName(before: string): string | null {
  const m = new RegExp(`\\[\\s*${NAME_TITLE_CASE}\\s*\\]\\([^)]*$`, "u").exec(before);
  return m?.[1]?.trim() ?? null;
}

/** `**Jane Doe**` immediately above the address, the usual team-page shape. */
function boldedName(before: string): string | null {
  const m = new RegExp(`\\*\\*\\s*${NAME_TITLE_CASE}\\s*\\*\\*\\s*(?:[–—:-]*\\s*)?$`, "u").exec(before);
  return m?.[1]?.trim() ?? null;
}

/** `Jane Doe, Head of Operations —` / `Jane Doe — CTO`. Name *and* printed role. */
function nameWithRole(before: string): string | null {
  const m = new RegExp(`${NAME_TITLE_CASE}\\s*(?:[,–—-]|\\bin\\b|\\|)\\s*[^\\n]{2,80}$`, "u").exec(before);
  if (!m?.[1]) return null;
  // Refuse "Based in Boston"-style prose: the tail has to actually contain a role
  // word, or this is just a sentence that happens to start with capitals.
  if (!new RegExp(TITLE_WORDS, "i").test(m[0])) return null;
  return m[1].trim();
}

/**
 * The role printed on the same or preceding line, e.g. "Head of Operations".
 * Kept separate from the name rules because most pages print it once and the
 * address appears on the next line.
 */
function titleNear(text: string, emailIndex: number): string | null {
  const lineStart = text.lastIndexOf("\n", Math.max(0, emailIndex - 1)) + 1;
  const prevLineStart = text.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
  const window = text.slice(prevLineStart, Math.min(text.length, emailIndex + 200));
  const m = new RegExp(
    `(?:${TITLE_WORDS})(?:\\s+(?:of|for|and|in)\\b[^\\n,;|]{0,40})?`,
    "i",
  ).exec(window);
  return m ? m[0].trim().slice(0, 60) : null;
}

/**
 * A name (and title) printed next to the address on the page itself. Stronger
 * evidence than anything derived from the local part, because the company wrote
 * it. Returns null when the page never names a human.
 */
export function nameFromPageContext(
  text: string,
  email: string,
): { name: string; title: string | null; source: "page" } | null {
  const index = text.toLowerCase().indexOf(email.toLowerCase());
  if (index < 0) return null;
  const before = text.slice(Math.max(0, index - 320), index);
  const name =
    rfcDisplayName(before) ?? linkTextName(before) ?? boldedName(before) ?? nameWithRole(before);
  if (!name) return null;
  return { name, title: titleNear(text, index), source: "page" };
}

export interface ContactCandidate {
  /** Empty when the page never names a human (a bare `hello@`). */
  name: string;
  title: string | null;
  email: string;
  sourceUrl: string;
  /** Where the display name came from: printed on the page, or the local part. */
  nameSource: "page" | "email" | "none";
  role: boolean;
  sameDomain: boolean;
  freeMail: boolean;
}

/**
 * Rank every address found across the fetched pages and take the best.
 * Ordering is the whole policy: a named human on the company's own domain beats a
 * role mailbox, which beats a free-mailbox human, which beats an anonymous role
 * address — and that last one is still returned, because for a five-person company
 * `hello@` *is* the front door. Sending to it is a legitimate choice; inventing a
 * name for it is not, which is why `name` is left empty instead of "Hello".
 */
export function pickBestContact(pages: ScrapedPage[], companyDomain: string): ContactCandidate | null {
  const candidates: ContactCandidate[] = [];
  const domain = companyDomain.toLowerCase();

  for (const page of pages) {
    for (const email of extractEmails(page.text)) {
      const { local, domain: mailDomain } = splitEmail(email);
      const pageName = nameFromPageContext(page.text, email);
      const derived = pageName ? null : nameFromLocalPart(email);
      candidates.push({
        name: pageName?.name ?? derived ?? "",
        title: pageName?.title ?? null,
        email,
        sourceUrl: page.url,
        nameSource: pageName ? "page" : derived ? "email" : "none",
        role: ROLE_LOCAL_PARTS.has(local),
        sameDomain: mailDomain === domain || mailDomain.endsWith(`.${domain}`),
        freeMail: FREE_MAIL_DOMAINS.has(mailDomain),
      });
    }
  }
  if (!candidates.length) return null;

  const score = (c: ContactCandidate): number => {
    let s = 0;
    if (c.name) s += 8;
    if (c.sameDomain) s += 6;
    if (c.freeMail) s -= 5;
    if (!c.role) s += 4;
    if (c.nameSource === "page") s += 3;
    if (c.title) s += 1;
    return s;
  };
  // Stable sort keeps first-appearance order as the tie-break, so the same input
  // always selects the same contact.
  return [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Absolute, de-duplicated URLs to try for one company. Empty for junk domains. */
export function contactPageUrls(domain: string): string[] {
  const root = canonicalizeUrl(`https://${(domain || "").trim()}`);
  if (!root) return [];
  const urls: string[] = [];
  for (const path of CONTACT_PATHS) {
    const url = canonicalizeUrl(new URL(path, root).toString());
    if (url) urls.push(url);
  }
  // The homepage last: most small companies put `hello@` in a footer that appears on
  // every page, and a live run of the free path walked six invented paths on a site
  // whose only published address was on its own front page.
  urls.push(root);
  return urls;
}

/**
 * Fill in `candidate.contact` from the company's own pages.
 *
 * Pages are fetched one at a time, cheapest signal first, and we stop as soon as
 * we have a named person on the company's own domain. Scraping costs money per
 * call, so "found the owner on /contact" must not be followed by five more
 * requests for the same company.
 *
 * Never throws and never replaces a contact we already have (a manually typed
 * address beats anything scraped), because discovery must not fail — or spend
 * twice — over a broken enrichment step.
 */
export async function enrichCandidateWithContact(
  fetchPages: PageFetcher,
  candidate: CompanyCandidate,
): Promise<CompanyCandidate> {
  if (candidate.contact?.email) return candidate;
  const urls = contactPageUrls(candidate.domain);

  const pages: ScrapedPage[] = [];
  const seenBodies = new Set<string>();
  for (const url of urls) {
    let catchAllSite = false;
    try {
      const fetched = (await fetchPages([url])) ?? [];
      for (const page of fetched) {
        if (typeof page?.text !== "string" || page.text.length === 0) continue;
        // A single-page app, or a site that answers every path with HTTP 200 and the
        // same body, is one page pretending to be seven. Live run: six paths, six
        // identical 5249-character bodies. Read it once and stop paying for it.
        if (seenBodies.has(page.text)) {
          console.debug?.(`[contacts] ${candidate.domain} answers every path with the same page; stopping the walk`);
          catchAllSite = true;
          break;
        }
        seenBodies.add(page.text);
        pages.push(page);
      }
    } catch (err) {
      // A dead scraper, a 429, a site behind Cloudflare: degrade to "nothing
      // found" and keep whatever the earlier pages already gave us.
      console.warn(
        `[contacts] enrichment stopped for ${candidate.domain}:`,
        err instanceof Error ? err.message : err,
      );
      break;
    }
    if (catchAllSite) break;
    const best = pickBestContact(pages, candidate.domain);
    if (best && isStrongContact(best)) return attachContact(candidate, best);
  }

  const best = pickBestContact(pages, candidate.domain);
  return best ? attachContact(candidate, best) : candidate;
}

/**
 * A contact worth stopping the page walk for. A role mailbox or a gmail address
 * can always get better on /team, so those keep us reading; a named human at the
 * company's own domain is the answer we were looking for.
 */
function isStrongContact(c: ContactCandidate): boolean {
  return Boolean(c.name) && c.sameDomain && !c.freeMail;
}

function attachContact(candidate: CompanyCandidate, best: ContactCandidate): CompanyCandidate {
  return {
    ...candidate,
    contact: {
      name: best.name,
      title: best.title ?? undefined,
      email: best.email,
      sourceUrl: best.sourceUrl,
    },
    // Provenance is the point: the operator must be able to click through and
    // see the company publishing this address before trusting it enough to mail.
    evidence: [
      ...candidate.evidence,
      { claim: `Contact ${best.email} published on ${best.sourceUrl}`, sourceUrl: best.sourceUrl },
    ],
  };
}

/**
 * Batch form of {@link enrichCandidateWithContact}, bounded by `limit` and run
 * one company at a time. Sequential on purpose: scrapers rate-limit aggressively
 * and a parallel fan-out over a whole discovery batch is the fastest way to lose
 * the API key for the rest of the hour.
 *
 * Candidates beyond the limit are returned untouched, and everything already
 * enriched is kept — this must never cost us a discovery run.
 */
export async function enrichCandidatesWithContacts(
  fetchPages: PageFetcher,
  candidates: CompanyCandidate[],
  limit: number,
): Promise<CompanyCandidate[]> {
  const out = [...candidates];
  if (!(limit > 0)) return out;
  const upto = Math.min(out.length, Math.floor(limit));
  for (let i = 0; i < upto; i++) {
    const c = out[i];
    if (!c || c.contact?.email) continue;
    out[i] = await enrichCandidateWithContact(fetchPages, c);
  }
  return out;
}
