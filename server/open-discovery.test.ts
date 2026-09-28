// The free discovery path, tested without a network. Every assertion here is about
// the selection and labelling policy — which URLs become leads, what evidence they
// carry, which pages are never fetched — and that policy is exactly the part that
// cannot be re-checked by eye once real traffic is flowing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../server/_core/env";
import {
  OpenWebDiscovery,
  brandFromTitle,
  htmlToText,
  looksLikeSentence,
  overpassQuery,
  pageTitle,
  sharesNameToken,
} from "../server/services/openDiscovery";
import { getDiscoveryProvider, type CompanyCandidate, type DiscoverInput } from "../server/services/providers";
import { enrichCandidatesWithContacts } from "../server/services/contactExtraction";

type Recorded = { url: string; init?: RequestInit };

function fakeFetch(routes: Array<{ match: RegExp; body: string; ok?: boolean; status?: number }>) {
  const calls: Recorded[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes.find((r) => r.match.test(url));
    if (!route) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    return {
      ok: route.ok !== false,
      status: route.status ?? 200,
      text: async () => route.body,
    } as unknown as Response;
  };
  return Object.assign(fn, { calls });
}

const INPUT: DiscoverInput = {
  offer: "managed data migrations",
  targetDescription: "B2B SaaS",
  geography: "Berlin",
  industry: "SaaS",
  icp: null,
  prospectTarget: 5,
};

const HN_RESPONSE = JSON.stringify({
  hits: [
    {
      title: "Show HN: Migraflow — zero-downtime Postgres upgrades",
      url: "https://migraflow.example/pricing",
      objectID: "111",
      created_at: "2026-03-01T10:00:00.000Z",
    },
    {
      // A discussion link, not a company: must never become a prospect.
      title: "Show HN: a thread about migrations",
      url: "https://news.ycombinator.com/item?id=222",
      objectID: "222",
      created_at: "2026-02-01T10:00:00.000Z",
    },
    {
      title: "Ask HN: Who is hiring?",
      url: "https://www.linkedin.com/jobs/view/333",
      objectID: "333",
      created_at: "2026-01-01T10:00:00.000Z",
    },
    { title: "", url: "https://untitled.example", objectID: "444" },
  ],
});

const OVERPASS_RESPONSE = JSON.stringify({
  elements: [
    {
      type: "node",
      id: 10,
      tags: { name: "Zahnclinic Mitte", website: "https://zahnclinic-mitte.example", phone: "+49 30 1234" },
    },
    { type: "node", id: 11, tags: { name: "No Contact Salon" } }, // unreachable: skipped
    { type: "way", id: 12, tags: { name: "Studio ohne Web", amenity: "studio" } }, // no website, no phone
    { type: "node", id: 13, tags: { website: "https://nameless.example" } }, // unnamed: skipped
    { type: "node", id: 14, tags: { name: "Migraflow", "contact:website": "https://migraflow.example" } },
  ],
});

beforeEach(() => {
  env.politenessMs = 0;
  env.httpTimeoutMs = 5_000;
  env.httpMaxBytes = 100_000;
  env.overpassTimeoutMs = 5_000;
  env.overpassBudgetMs = 45_000;
  env.overpassEndpoints = "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter";
  env.openDiscoverySources = "hn,osm";
  env.openDiscoveryLimit = 25;
  env.openDiscoveryHomepageReads = 10;
});

describe("htmlToText / pageTitle", () => {
  it("keeps the visible words and drops what a person never reads", () => {
    const html =
      "<html><head><style>a{color:red}</style><script>var email='hidden@injected.example';</script>" +
      "<title>Migraflow &mdash; Postgres &#8203;upgrades</title></head>" +
      "<body><h1>Migrations without downtime</h1><p>Contact us at hello@migraflow.example</p></body></html>";
    const text = htmlToText(html);
    expect(text).toContain("hello@migraflow.example");
    expect(text).not.toContain("hidden@injected.example");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Contact us at");
    expect(pageTitle(html)).toContain("Postgres");
    expect(pageTitle(html)).not.toContain("<");
  });

  it("returns pages with enough visible text, and drops the empty shells", async () => {
    const real =
      "<html><body><h1>Our team</h1><p>Priya Raman runs migrations for SaaS teams. Reach us at priya@migraflow.example or on the contact page.</p></body></html>";
    const shell = "<html><body>Redirecting…</body></html>";
    const fetchImpl = fakeFetch([
      { match: /team\.example/, body: real },
      { match: /shell\.example/, body: shell },
    ]);
    const pages = await new OpenWebDiscovery(fetchImpl).fetchPages([
      "https://team.example/team",
      "https://shell.example/about",
    ]);
    expect(pages.map((p) => p.url)).toEqual(["https://team.example/team"]);
    expect(pages[0]!.text).toContain("priya@migraflow.example");
  });
});

describe("OpenWebDiscovery: Hacker News source", () => {
  it("turns announcements into companies, and refuses to turn links into companies", async () => {
    const fetchImpl = fakeFetch([{ match: /hn\.algolia\.com/, body: HN_RESPONSE }]);
    const provider = new OpenWebDiscovery(fetchImpl);
    const found = await provider.discoverProspects({ ...INPUT, geography: "Global" });

    expect(found).toHaveLength(1);
    const [candidate] = found;
    expect(candidate!.domain).toBe("migraflow.example");
    expect(candidate!.origin).toBe("live");
    expect(candidate!.name).toBe("Migraflow");
    expect(candidate!.description).toMatch(/zero-downtime Postgres upgrades/);
    // The evidence names where the claim came from, not just the company's own site.
    expect(candidate!.evidence[0]!.sourceUrl).toBe("https://news.ycombinator.com/item?id=111");
    expect(candidate!.evidence[0]!.claim).toMatch(/Hacker News/);
    expect(fetchImpl.calls.some((c) => /linkedin\.com/.test(c.url))).toBe(false);
  });

  it("asks only for the last year, so a stale announcement is not sold as a signal", async () => {
    const fetchImpl = fakeFetch([{ match: /hn\.algolia\.com/, body: HN_RESPONSE }]);
    await new OpenWebDiscovery(fetchImpl).discoverProspects(INPUT);
    const query = fetchImpl.calls.find((c) => /hn\.algolia\.com/.test(c.url))!.url;
    expect(query).toMatch(/numericFilters=created_at_i%3E\d{10}/);
    const since = Number(/created_at_i%3E(\d+)/.exec(query)![1]);
    const aYearAgo = (Date.now() / 1000 - 60 * 60 * 24 * 366) | 0;
    expect(since).toBeGreaterThanOrEqual(aYearAgo - 60);
  });

  it("asks for announcements, not for articles about the topic", async () => {
    // `tags=story` was live-tested and answered a B2B SaaS query with news sites.
    const fetchImpl = fakeFetch([{ match: /hn\.algolia\.com/, body: '{"hits":[]}' }]);
    await new OpenWebDiscovery(fetchImpl).discoverProspects(INPUT);
    const query = fetchImpl.calls.find((c) => /hn\.algolia\.com/.test(c.url))!.url;
    expect(query).toContain("tags=show_hn");
  });
});

describe("overpassQuery", () => {
  it("emits one balanced union however many tags a category maps to", () => {
    const ql = overpassQuery("Berlin", ['"amenity"="dentist"', '"healthcare"="dentist"'], 4, 60_000);
    const open = (ql.match(/\(/g) ?? []).length;
    expect(open).toBe((ql.match(/\)/g) ?? []).length);
    // Both spellings of the place, quoted: an unquoted `name:en` is a parse error,
    // which is exactly how a live run managed to report zero Berlin dentists.
    expect(ql).toContain('area["name"="Berlin"]["boundary"="administrative"]');
    expect(ql).toContain('area["name:en"="Berlin"]["boundary"="administrative"]');
    expect(ql).toContain('nwr["amenity"="dentist"](area.searchArea);');
    expect(ql).toContain("->.searchArea;");
    expect(ql).toContain(";);"); // the union itself is a terminated statement
    // The server gives up five seconds before we do, so the answer arrives as a
    // readable 504 rather than as an abort we would have to guess about.
    expect(ql).toContain("[out:json][timeout:55];");
  });

  it("asks for more rows than it needs, because most mapped businesses are unreachable", () => {
    // Live run: 12 rows for "dentists, Berlin", about half with a website of their
    // own. Asking for exactly `limit` would silently halve the yield.
    const ql = overpassQuery("Berlin", ['"amenity"="dentist"'], 4, 60_000);
    expect(ql).toMatch(/out tags 32;/);
    expect(overpassQuery("Berlin", ['"amenity"="dentist"'], 100, 60_000)).toMatch(/out tags 200;/);
  });

  it("escapes a place name instead of letting it rewrite the query", () => {
    const ql = overpassQuery('Berlin"],->.x;out body;', ['"amenity"="dentist"'], 2, 60_000);
    expect(ql).not.toContain('area["name"="Berlin"]');
    expect(ql).toContain('\\"');
  });
});

describe("brandFromTitle", () => {
  it("keeps a headline that names the product", () => {
    expect(brandFromTitle("Show HN: ReadyKit | Your Python SaaS starts here", "readykit.dev")).toBe("ReadyKit");
    expect(brandFromTitle("MetrIQ – An AI fitness coach", "metriq.fitness")).toBe("MetrIQ");
  });

  it("refuses a headline that is somebody telling a story", () => {
    expect(looksLikeSentence("I made a free list of 100 places to promote your SaaS")).toBe(true);
    expect(brandFromTitle("I made a free list of 100 places to promote your SaaS", "launchdirectories.com")).toBe(
      "Launchdirectories",
    );
  });
});

describe("OpenWebDiscovery: OpenStreetMap source", () => {
  it("uses the mapped phone and website, and drops entries nobody can be reached at", async () => {
    const fetchImpl = fakeFetch([
      { match: /overpass-api\.de/, body: OVERPASS_RESPONSE },
      { match: /hn\.algolia\.com/, body: '{"hits":[]}' },
    ]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "dental clinics",
      targetDescription: "dentists",
    });
    expect(found.map((c) => c.domain).sort()).toEqual(["migraflow.example", "zahnclinic-mitte.example"]);
    const clinic = found.find((c) => c.domain === "zahnclinic-mitte.example")!;
    expect(clinic.evidence.map((e) => e.claim).join(" ")).toMatch(/\+49 30 1234/);
    expect(clinic.sourceUrl).toBe("https://www.openstreetmap.org/node/10");
    const body = decodeURIComponent(fetchImpl.calls.find((c) => /overpass/.test(c.url))!.init!.body as string);
    expect(body).toContain('area["name"="Berlin"]');
    expect(body).toContain('"amenity"="dentist"');
  });

  it("tries the next mirror when one instance is busy", async () => {
    // Live run: overpass-api.de answered 504 twice while the data was plainly there.
    // One saturated server must not be reported as an empty city.
    const fetchImpl = fakeFetch([
      { match: /overpass-api\.de/, body: "too busy", ok: false, status: 504 },
      { match: /kumi\.systems/, body: OVERPASS_RESPONSE },
      { match: /hn\.algolia\.com/, body: '{"hits":[]}' },
    ]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "dental clinics",
      targetDescription: "dentists",
    });
    expect(fetchImpl.calls.some((c) => /kumi\.systems/.test(c.url))).toBe(true);
    expect(found.map((c) => c.domain)).toContain("zahnclinic-mitte.example");
  });

  it("says when the source is busy, which is not the same as the city being empty", async () => {
    env.overpassBudgetMs = 0;
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => warned.push(args.join(" ")));
    const fetchImpl = fakeFetch([{ match: /hn\.algolia\.com/, body: '{"hits":[]}' }]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "dental clinics",
      targetDescription: "dentists",
    });
    expect(found).toEqual([]);
    expect(fetchImpl.calls.some((c) => /overpass/.test(c.url))).toBe(false); // budget spent before asking
    expect(warned.join("\n")).toMatch(/no endpoint answered within 0 ms. This is the source being busy, not the city being empty/);
    spy.mockRestore();
  });

  it("reports a mapped business it cannot carry forward, instead of dropping it silently", async () => {
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => warned.push(args.join(" ")));
    const fetchImpl = fakeFetch([
      {
        match: /overpass-api\.de/,
        body: JSON.stringify({ elements: [{ type: "node", id: 9, tags: { name: "Barbershop Kottbus", phone: "+49 30 5555" } }] }),
      },
      { match: /hn\.algolia\.com/, body: '{"hits":[]}' },
    ]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "dental clinics",
      targetDescription: "dentists",
    });
    expect(found).toEqual([]);
    expect(warned.join("\n")).toMatch(/1 business\(es\) in Berlin with a phone but no website/);
    spy.mockRestore();
  });

  it("sits out a market it cannot express as a place", async () => {
    const fetchImpl = fakeFetch([{ match: /hn\.algolia\.com/, body: '{"hits":[]}' }]);
    await new OpenWebDiscovery(fetchImpl).discoverProspects({ ...INPUT, geography: "US" });
    expect(fetchImpl.calls.some((c) => /overpass/.test(c.url))).toBe(false);
  });

  it("sits out an industry with no tag of its own rather than guessing one", async () => {
    const fetchImpl = fakeFetch([{ match: /hn\.algolia\.com/, body: '{"hits":[]}' }]);
    await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "obscure widget fabrication",
      targetDescription: "widgets",
      offer: "widgets",
    });
    expect(fetchImpl.calls.some((c) => /overpass/.test(c.url))).toBe(false);
  });

  it("refuses a mapped business whose domain now serves something else", async () => {
    // Live run, real case: OpenStreetMap still points "Zahnärzte Nicolas Weiss, Volker
    // Landmann" at a domain that now serves an online casino. Mailing a dental offer
    // there is not a weak lead, it is a wrong one.
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => warned.push(args.join(" ")));
    const fetchImpl = fakeFetch([
      {
        match: /overpass-api\.de/,
        body: JSON.stringify({
          elements: [
            {
              type: "node",
              id: 20,
              tags: { name: "Zahnärzte Weiss und Landmann", website: "https://praxis-lichtenrade.example", amenity: "dentist" },
            },
          ],
        }),
      },
      { match: /hn\.algolia\.com/, body: '{"hits":[]}' },
      {
        match: /praxis-lichtenrade\.example/,
        body: '<html><head><title>Spinboss Casino &mdash; Spielautomaten &amp; Live Casino</title></head><body>gambling</body></html>',
      },
    ]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "dental clinics",
      targetDescription: "dentists",
    });
    expect(found).toEqual([]);
    expect(warned.join("\n")).toMatch(/dropped praxis-lichtenrade\.example/);
    spy.mockRestore();
  });

  it("says when a mapped business's website simply did not answer", async () => {
    const fetchImpl = fakeFetch([
      {
        match: /overpass-api\.de/,
        body: JSON.stringify({ elements: [{ type: "node", id: 21, tags: { name: "Praxis Lengert", website: "https://lengert.example" } }] }),
      },
      { match: /hn\.algolia\.com/, body: '{"hits":[]}' },
    ]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "dental clinics",
      targetDescription: "dentists",
    });
    expect(found[0]!.evidence.map((e) => e.claim).join(" ")).toMatch(/did not answer/);
  });
});

describe("sharesNameToken", () => {
  it("recognises the same business across the two spellings of a name", () => {
    expect(sharesNameToken("Serpil Hartfiel", "Zahnarztpraxis Hartfiel — Ein gesundes Lächeln")).toBe(true);
    expect(sharesNameToken("Zahnärzte Weiss und Landmann", "Spinboss Casino — Live Casino")).toBe(false);
    // Nothing distinctive to compare: reported as unverifiable rather than guessed at.
    expect(sharesNameToken("Dr. K", "anything at all")).toBe(true);
  });
});

describe("OpenWebDiscovery: fetching other people's websites", () => {
  it("never fetches an internal address, whatever a source claimed", async () => {
    const fetchImpl = fakeFetch([{ match: /.*/, body: "<html><body>nothing</body></html>" }]);
    const provider = new OpenWebDiscovery(fetchImpl);
    const pages = await provider.fetchPages([
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:3306/",
      "file:///etc/passwd",
      "https://example.com/team",
    ]);
    expect(fetchImpl.calls.map((c) => c.url)).toEqual(["https://example.com/team"]);
    expect(pages).toEqual([]); // the one allowed page is too short to be a contact page
  });

  it("degrades to no pages when a site is down, instead of failing the run", async () => {
    const fetchImpl = fakeFetch([]);
    const pages = await new OpenWebDiscovery(fetchImpl).fetchPages(["https://down.example/contact"]);
    expect(pages).toEqual([]);
  });

  it("says so when a source fails, rather than reporting it as empty", async () => {
    // A swallowed 5xx is how "OpenStreetMap has no dentists in Berlin" gets written
    // into a runbook about a server that was rate-limiting us.
    const warned: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warned.push(args.join(" "));
    });
    const fetchImpl = fakeFetch([{ match: /overpass-api\.de/, body: "Rate limited", ok: false, status: 429 }]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "dental clinics",
      targetDescription: "dentists",
    });
    expect(found).toEqual([]);
    expect(warned.join("\n")).toMatch(/overpass-api\.de failed: HTTP 429/);
    spy.mockRestore();
  });

  it("reads a homepage once and quotes it, rather than describing the company itself", async () => {
    const fetchImpl = fakeFetch([
      { match: /hn\.algolia\.com/, body: HN_RESPONSE },
      {
        match: /migraflow\.example/, 
        body: '<html><head><title>Migraflow</title><meta property="og:site_name" content="Migraflow"><meta property="og:description" content="Managed Postgres upgrades &amp; rollbacks for teams without a DBA."></head><body>irrelevant</body></html>',
      },
    ]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects(INPUT);
    const candidate = found.find((c) => c.domain === "migraflow.example")!;
    expect(candidate.description).toMatch(/teams without a DBA/);
    // Decoded once, not left as markup noise for the operator to read.
    expect(candidate.description).toContain("& rollbacks");
    expect(candidate.description).not.toContain("&amp;");
    expect(candidate.evidence.some((e) => /Its own homepage says/.test(e.claim))).toBe(true);
    // Read at the root, so a deep link in the source URL cannot masquerade as the
    // company's front page.
    expect(fetchImpl.calls.some((c) => /migraflow\.example\/pricing/.test(c.url))).toBe(false);
  });

  it("takes the name a site gives itself over the headline written about it", async () => {
    const fetchImpl = fakeFetch([
      {
        match: /hn\.algolia\.com/,
        body: JSON.stringify({
          hits: [
            {
              title: "I made a free list of 100 places to promote your SaaS",
              url: "https://launchdirectories.com/launch-directories", // a sentence, and a deep path
              objectID: "900",
              created_at: "2026-05-01T10:00:00.000Z",
            },
          ],
        }),
      },
      {
        match: /launchdirectories\.example|launchdirectories\.com/,
        body: '<html><head><meta property="og:site_name" content="LaunchDirectories"><meta name="description" content="100+ places to list a product."></head><body>x</body></html>',
      },
    ]);
    const found = await new OpenWebDiscovery(fetchImpl).discoverProspects({
      ...INPUT,
      industry: "SaaS directories",
      geography: "Global",
    });
    expect(found[0]!.name).toBe("LaunchDirectories");
  });
});

describe("the free path end to end", () => {
  // This is the claim that matters for the launch: automatic contact discovery used
  // to need a paid scraper. Here it needs one HTTPS GET and nothing else.
  it("finds a published address on the company's own page with no scraper service", async () => {
    const fetchImpl = fakeFetch([
      {
        match: /migraflow\.example\/contact/,
        body:
          "<html><body><h1>Contact us</h1><p>Talk to our founder, Priya Raman, about a migration: priya@migraflow.example. " +
          "For anything else write to hello@migraflow.example and someone will pick it up.</p></body></html>",
      },
    ]);
    const provider = new OpenWebDiscovery(fetchImpl);
    const candidate: CompanyCandidate = {
      name: "Migraflow",
      domain: "migraflow.example",
      description: "Managed Postgres upgrades",
      websiteUrl: "https://migraflow.example",
      sourceUrl: "https://news.ycombinator.com/item?id=111",
      origin: "live",
      evidence: [],
    };
    const [enriched] = await enrichCandidatesWithContacts((urls) => provider.fetchPages(urls), [candidate], 1);
    expect(enriched!.contact?.email).toBe("priya@migraflow.example");
    // The named person, not the shared mailbox: contactExtraction attaches the
    // closest capitalised word before the address, which here is the founder's
    // first name. A partial name is still a better greeting than no name at all.
    expect(enriched!.contact?.name).toMatch(/Priya/);
    expect(enriched!.contact!.sourceUrl).toBe("https://migraflow.example/contact");
  });
});

describe("provider selection", () => {
  const original = { provider: env.discoveryProvider, sgai: env.sgaiApiKey };
  afterEach(() => {
    env.discoveryProvider = original.provider;
    env.sgaiApiKey = original.sgai;
  });

  it("stays on labelled demo data until the free sources are opted into", () => {
    env.discoveryProvider = "";
    env.sgaiApiKey = "";
    expect(getDiscoveryProvider().name).toBe("mock");
  });

  it("uses the free sources only when asked", () => {
    env.discoveryProvider = "open";
    expect(getDiscoveryProvider().name).toBe("open");
  });

  it("does not claim a paid engine it has no key for", () => {
    env.discoveryProvider = "scrapegraph";
    env.sgaiApiKey = "";
    expect(getDiscoveryProvider().name).toBe("mock");
  });
});
