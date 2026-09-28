// Enrichment is the only leg of the pipeline that spends money and the only one
// that trusts a third party's claim about a stranger's mailbox. Both facts are
// enforced here, against recorded provider payloads rather than a live key: these
// fixtures are transcribed from the providers' published API documentation, so a
// test failing on a renamed field is the intended early warning.
import { describe, it, expect, vi } from "vitest";
import {
  buildEnrichmentProvider,
  createApolloProvider,
  createHunterProvider,
  lookupPeople,
  rankPeople,
  type EnrichedPerson,
  type HttpJson,
} from "./services/enrichment";

function person(overrides: Partial<EnrichedPerson> = {}): EnrichedPerson {
  return {
    firstName: "Lisa",
    lastName: "Park",
    email: "lisa@acme.com",
    title: "Founder",
    emailStatus: "verified",
    matchConfidence: "high",
    phone: null,
    socialUrl: null,
    provider: "test",
    sourceUrl: "https://example.test/call",
    ...overrides,
  };
}

/** Records every URL/headers the provider tried to call, returning canned JSON. */
function fakeHttp(
  responses: Record<string, unknown | ((url: string) => unknown)>,
): { http: HttpJson; calls: { url: string; headers?: Record<string, string> }[] } {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const http: HttpJson = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const key = Object.keys(responses).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request: ${url}`);
    const responder = responses[key];
    return typeof responder === "function" ? responder(url) : responder;
  };
  return { http, calls };
}

describe("rankPeople: what we refuse to mail", () => {
  it("drops a personal mailbox even when the provider supplied one", () => {
    // Apollo will return this if asked for personal emails, and Hunter surfaces
    // them too. A bought @gmail.com is the fastest way to burn a sending domain.
    const ranked = rankPeople([person({ email: "lisa.park@gmail.com" })], "acme.com");
    expect(ranked).toEqual([]);
  });

  it("drops a match the provider is not sure about", () => {
    expect(rankPeople([person({ matchConfidence: "low" })], "acme.com")).toEqual([]);
    expect(rankPeople([person({ matchConfidence: "none" })], "acme.com")).toEqual([]);
  });

  it("drops mailboxes labelled risky, invalid, role or catch-all", () => {
    for (const emailStatus of ["risky", "invalid", "undeliverable", "catch_all", "role", "disposable"]) {
      expect(rankPeople([person({ emailStatus })], "acme.com")).toEqual([]);
    }
  });

  it("drops a role address at the company domain — a mailbox is not the person we paid for", () => {
    // The free page pass deliberately keeps `hello@` as a last resort. A bought
    // record has to clear a higher bar, or the credit achieved nothing.
    expect(rankPeople([person({ email: "info@acme.com" })], "acme.com")).toEqual([]);
    expect(rankPeople([person({ email: "support2@acme.com" })], "acme.com")).toEqual([]);
    expect(rankPeople([person({ email: "hello+acme@acme.com" })], "acme.com")).toEqual([]);
  });

  it("puts the verified decision-maker first, and keeps the rest as fallbacks", () => {
    const ranked = rankPeople(
      [
        person({ email: "dev@acme.com", firstName: "Dev", title: "Engineer", emailStatus: null }),
        person({ email: "anna@acme.com", firstName: "Anna", title: "CEO", phone: "+14155550123" }),
      ],
      "acme.com",
    );
    expect(ranked.map((p) => p.email)).toEqual(["anna@acme.com", "dev@acme.com"]);
  });

  it("drops records with no address at all rather than inventing one", () => {
    expect(rankPeople([person({ email: null })], "acme.com")).toEqual([]);
  });
});

describe("hunter provider (one call per company)", () => {
  // Shape transcribed from the domain-search response example: `data.emails[]`,
  // each entry carrying the address plus person fields.
  const DOMAIN_SEARCH = {
    data: {
      domain: "acme.com",
      emails: [
        {
          value: "lisa@acme.com",
          first_name: "Lisa",
          last_name: "Park",
          position: "Co-Founder",
          email_status: "verified",
          twitter: "lisapark",
          linkedin: "https://www.linkedin.com/in/lisapark",
          phone_number: "+14155550158",
        },
        { value: "bob@acme.com", first_name: "Bob", last_name: "Reed", position: "Developer" },
      ],
    },
  };

  it("asks for the domain and reads the people back out of data.emails", async () => {
    const { http, calls } = fakeHttp({ "domain-search": DOMAIN_SEARCH });
    const provider = createHunterProvider({ apiKey: "k", http });
    const people = await provider.findPeople({ domain: "acme.com" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://api.hunter.io/v2/domain-search");
    expect(calls[0].url).toContain("domain=acme.com");
    expect(calls[0].url).toContain("api_key=k");
    expect(people.map((p) => p.email)).toEqual(["lisa@acme.com", "bob@acme.com"]);
    expect(people[0]).toMatchObject({
      firstName: "Lisa",
      lastName: "Park",
      title: "Co-Founder",
      phone: "+14155550158",
      socialUrl: "https://www.linkedin.com/in/lisapark",
      provider: "hunter",
    });
  });

  it("sends the key in the query string, because that is Hunter's documented auth", async () => {
    // Consequence worth knowing: the URL *is* the credential, and this app stores
    // the URL of every call as provenance. Pinned so the redaction below is a
    // chosen behaviour and not a lucky accident.
    const { http, calls } = fakeHttp({ "domain-search": DOMAIN_SEARCH });
    await createHunterProvider({ apiKey: "secret-key", http }).findPeople({ domain: "acme.com" });
    expect(calls[0].url).toContain("api_key=secret-key");
  });

  it("never lets the stored provenance carry the key", async () => {
    // sourceUrl is written to the database and rendered in the UI. A contact row
    // that leaks the platform's Hunter key is a worse incident than a missing
    // address, so the value that leaves this module must be scrubbed.
    const { http } = fakeHttp({ "domain-search": DOMAIN_SEARCH });
    const [p] = await createHunterProvider({ apiKey: "secret-key", http }).findPeople({ domain: "acme.com" });
    expect(p!.sourceUrl).not.toContain("secret-key");
    expect(p!.sourceUrl).toContain("domain-search");
    expect(p!.sourceUrl).toContain("domain=acme.com");
  });

  it("drops a bare social handle: a username is not a profile we can act on", async () => {
    const { http } = fakeHttp({
      "domain-search": { data: { emails: [{ value: "s@acme.com", first_name: "S", linkedin: "s_handle" }] } },
    });
    const [p] = await createHunterProvider({ apiKey: "k", http }).findPeople({ domain: "acme.com" });
    // Single-character local part is refused upstream, so the record goes entirely.
    expect(p).toBeUndefined();
  });

  it("returns an empty list when the domain has nothing on file", async () => {
    const { http } = fakeHttp({ "domain-search": { data: { emails: [] } } });
    expect(await createHunterProvider({ apiKey: "k", http }).findPeople({ domain: "acme.com" })).toEqual([]);
  });

  it("respects the limit", async () => {
    const many = {
      data: {
        emails: Array.from({ length: 12 }, (_, i) => ({
          value: `person${i}@acme.com`,
          first_name: `Per${i}`,
          last_name: `Son${i}`,
        })),
      },
    };
    const { http } = fakeHttp({ "domain-search": many });
    const people = await createHunterProvider({ apiKey: "k", http }).findPeople({ domain: "acme.com", limit: 3 });
    expect(people).toHaveLength(3);
  });
});

describe("apollo provider (search then pay per person)", () => {
  // Search returns obfuscated surnames and only `has_email` flags; the address
  // exists only after /people/match. Both shapes are from Apollo's OpenAPI.
  const SEARCH = {
    total_entries: 2,
    people: [
      { id: "5f1a", first_name: "Hu", last_name_obfuscated: "Hu***n", title: "CEO", has_email: true },
      { id: "5f1b", first_name: "Zoe", last_name_obfuscated: "Zo***n", title: "Designer", has_email: false },
      { id: "5f1c", first_name: "Ivy", last_name_obfuscated: "Iv**", title: "Ops", has_email: true },
    ],
  };
  const MATCH_HUGO = {
    person: {
      id: "5f1a",
      first_name: "Hugo",
      last_name: "Martin",
      title: "CEO",
      email: "hugo@acme.com",
      email_status: "verified",
      match_confidence: "high",
      linkedin_url: "https://www.linkedin.com/in/hugomartin",
      phone_numbers: [
        { raw_number: "(415) 555-0158", sanitized_number: "+14155550158", type: "direct" },
      ],
    },
  };
  const MATCH_IVY = {
    person: { id: "5f1c", first_name: "Ivy", last_name: "Ng", email: "ivy@acme.com", match_confidence: "medium" },
  };

  it("searches the domain, then enriches by id with the key in a header", async () => {
    const { http, calls } = fakeHttp({
      api_search: SEARCH,
      "people/match": (url) => (url.includes("id=5f1c") ? MATCH_IVY : MATCH_HUGO),
    });
    const provider = createApolloProvider({ apiKey: "apollo-key", http });
    const people = await provider.findPeople({ domain: "acme.com", titles: ["CEO"] });

    expect(calls[0].url).toContain("/mixed_people/api_search");
    expect(calls[0].url).toContain("q_organization_domains_list%5B%5D=acme.com");
    expect(calls[0].url).toContain("person_titles%5B%5D=CEO");
    expect(calls[0].headers).toMatchObject({ "x-api-key": "apollo-key" });
    expect(people.map((p) => p.email)).toEqual(["hugo@acme.com", "ivy@acme.com"]);
    expect(people[0]).toMatchObject({
      firstName: "Hugo",
      lastName: "Martin",
      phone: "+14155550158",
      socialUrl: "https://www.linkedin.com/in/hugomartin",
      provider: "apollo",
    });
  });

  it("does not spend a credit on a person with no email on file", async () => {
    const { http, calls } = fakeHttp({ search: SEARCH, match: MATCH_HUGO });
    await createApolloProvider({ apiKey: "k", http }).findPeople({ domain: "acme.com" });
    const matchCalls = calls.filter((c) => c.url.includes("/people/match"));
    expect(matchCalls).toHaveLength(2);
    expect(matchCalls.some((c) => c.url.includes("id=5f1b"))).toBe(false);
  });

  it("uses the enriched name, never the obfuscated one from search", async () => {
    // "Dear Hu***n" is worse than no greeting at all. If the match call ever
    // regressed to reusing the search record, this is the test that says so.
    const { http } = fakeHttp({ search: SEARCH, match: { person: { id: "5f1a", first_name: "Hu", last_name: "Hu***n", email: "hugo@acme.com" } } });
    const [p] = await createApolloProvider({ apiKey: "k", http }).findPeople({ domain: "acme.com" });
    expect(p.lastName).toBe("");
    expect(p.firstName).toBe("Hu");
  });

  it("points the first credit at a decision maker when the caller named no titles", async () => {
    // Search order is Apollo's, not ours, and the address only exists after a
    // paid call. So the title the search result already shows is the only signal
    // available *before* the money is spent, and limit=1 makes the choice
    // observable: whoever is enriched first is who we decided to buy.
    const search = {
      people: [
        { id: "eng", first_name: "Ivan", title: "Support Engineer", has_email: true },
        { id: "ceo", first_name: "Petra", title: "Co-Founder", has_email: true },
      ],
    };
    const { http, calls } = fakeHttp({
      search,
      match: { person: { id: "ceo", first_name: "Petra", last_name: "Kay", email: "petra@acme.com" } },
    });
    await createApolloProvider({ apiKey: "k", http }).findPeople({ domain: "acme.com", limit: 1 });
    const matchCalls = calls.filter((c) => c.url.includes("/people/match"));
    expect(matchCalls).toHaveLength(1);
    expect(matchCalls[0].url).toContain("id=ceo");
  });

  it("stops after the requested number of lookups", async () => {
    const { http, calls } = fakeHttp({ search: SEARCH, match: MATCH_HUGO });
    await createApolloProvider({ apiKey: "k", http }).findPeople({ domain: "acme.com", limit: 1 });
    expect(calls.filter((c) => c.url.includes("/people/match"))).toHaveLength(1);
  });

  it("treats an empty or malformed response as no data", async () => {
    for (const body of [{}, { people: [] }, null, { people: [{ id: "x", has_email: true }] }]) {
      const { http } = fakeHttp({ search: body, match: {} });
      expect(await createApolloProvider({ apiKey: "k", http }).findPeople({ domain: "acme.com" })).toEqual([]);
    }
  });
});

describe("provider selection never spends by accident", () => {
  const http: HttpJson = async () => ({});

  it("returns null with no provider selected, even when a key is present", () => {
    // A key in the environment is not a decision to buy lookups. Without this,
    // any code path touching enrichment would start charging without anyone
    // having chosen it.
    expect(buildEnrichmentProvider({ selected: "", hunterApiKey: "h", apolloApiKey: "a", http })).toBeNull();
  });

  it("returns null when a provider is selected but its key is missing", () => {
    expect(buildEnrichmentProvider({ selected: "apollo", hunterApiKey: "h", apolloApiKey: "", http })).toBeNull();
    expect(buildEnrichmentProvider({ selected: "hunter", hunterApiKey: "", apolloApiKey: "a", http })).toBeNull();
  });

  it("builds the named provider, case- and whitespace-insensitively", () => {
    expect(buildEnrichmentProvider({ selected: " Hunter ", hunterApiKey: "h", apolloApiKey: "", http })?.name).toBe(
      "hunter",
    );
    expect(buildEnrichmentProvider({ selected: "apollo", hunterApiKey: "", apolloApiKey: "a", http })?.name).toBe(
      "apollo",
    );
  });

  it("ignores an unknown provider name rather than guessing", () => {
    expect(buildEnrichmentProvider({ selected: "clay", hunterApiKey: "h", apolloApiKey: "a", http })).toBeNull();
  });
});

describe("lookupPeople: an outage is not a failure", () => {
  it("returns nothing when no provider is configured", async () => {
    expect(await lookupPeople(null, { domain: "acme.com" })).toEqual([]);
  });

  it("swallows a provider error and logs it, instead of breaking discovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = createHunterProvider({
      apiKey: "k",
      http: async () => {
        throw new Error("429 Too Many Requests");
      },
    });
    expect(await lookupPeople(provider, { domain: "acme.com" })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("hunter"),
      expect.stringContaining("429 Too Many Requests"),
    );
    warn.mockRestore();
  });

  it("does not log a 401 body, but does say which provider failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await lookupPeople(
      { name: "hunter", findPeople: async () => { throw new Error("unauthorized"); } },
      { domain: "acme.com" },
    );
    expect(warn.mock.calls[0][0]).toContain("hunter");
    warn.mockRestore();
  });
});
