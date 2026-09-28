// Unit tests for automatic contact discovery (server/services/contactExtraction.ts).
// Every fixture below is literal markdown of the shape the scraper returns — the
// point of these tests is that we never invent an address, so the string work has
// to be pinned exactly. No network, no API key.
import { describe, expect, it } from "vitest";
import {
  contactPageUrls,
  enrichCandidateWithContact,
  extractEmails,
  isUsableEmail,
  nameFromLocalPart,
  nameFromPageContext,
  pickBestContact,
} from "./services/contactExtraction";
import type { CompanyCandidate } from "./services/providers";

const candidate = (over: Partial<CompanyCandidate> = {}): CompanyCandidate => ({
  name: "Acme Corp",
  domain: "acme-corp.com",
  description: "Data migration services",
  websiteUrl: "https://acme-corp.com",
  sourceUrl: "https://acme-corp.com",
  origin: "live",
  evidence: [],
  ...over,
});

describe("extractEmails", () => {
  it("finds a plain address and lowercases it", () => {
    expect(extractEmails("Ping us at Maria.Kova@Acme-Corp.com anytime.")).toEqual([
      "maria.kova@acme-corp.com",
    ]);
  });

  it("reads addresses out of markdown links and mailto:", () => {
    const md = "Talk to [Jane Doe](mailto:Jane.Doe@acme-corp.com) or jane@acme-corp.com.";
    expect(extractEmails(md)).toEqual(["jane.doe@acme-corp.com", "jane@acme-corp.com"]);
  });

  it("strips sentence punctuation instead of storing it", () => {
    expect(extractEmails("write to ops@acme-corp.com.")).toEqual(["ops@acme-corp.com"]);
    expect(extractEmails("<contact@acme-corp.com>")).toEqual(["contact@acme-corp.com"]);
  });

  it("dedupes while preserving first-appearance order", () => {
    expect(extractEmails("anna@acme-corp.com bob@acme-corp.com ANNA@ACME-CORP.COM")).toEqual([
      "anna@acme-corp.com",
      "bob@acme-corp.com",
    ]);
  });

  it("rejects asset filenames that survive a markdown rewrite", () => {
    expect(extractEmails("![logo@2x.png](/img)")).toEqual([]);
    expect(isUsableEmail("sprite@2x.png")).toBe(false);
  });

  it("rejects documentation placeholders and telemetry domains", () => {
    for (const bad of ["anna@example.com", "you@yourdomain.com", "id@sentry.io", "x@company.com"]) {
      expect(isUsableEmail(bad)).toBe(false);
    }
  });

  it("rejects addresses nobody answers, but keeps privacy and legal", () => {
    expect(isUsableEmail("noreply@acme-corp.com")).toBe(false);
    expect(isUsableEmail("no-reply@acme-corp.com")).toBe(false);
    expect(isUsableEmail("postmaster@acme-corp.com")).toBe(false);
    expect(isUsableEmail("privacy@acme-corp.com")).toBe(true);
    expect(isUsableEmail("legal@acme-corp.com")).toBe(true);
    expect(isUsableEmail("dpo@acme-corp.com")).toBe(true);
  });

  it("rejects numeric ids and one-character local parts", () => {
    expect(isUsableEmail("123456@acme-corp.com")).toBe(false);
    expect(isUsableEmail("j@acme-corp.com")).toBe(false);
  });
});

describe("nameFromLocalPart", () => {
  it("expands dotted and separated names", () => {
    expect(nameFromLocalPart("jane.doe@acme-corp.com")).toBe("Jane Doe");
    expect(nameFromLocalPart("m.petrova@acme-corp.com")).toBe("M Petrova");
    expect(nameFromLocalPart("jane-doe@acme-corp.com")).toBe("Jane Doe");
    expect(nameFromLocalPart("maria@acme-corp.com")).toBe("Maria");
  });

  it("drops tracking tags and trailing digits", () => {
    expect(nameFromLocalPart("jane.doe+2024@acme-corp.com")).toBe("Jane Doe");
  });

  it("returns null when the local part is not a human", () => {
    expect(nameFromLocalPart("hello@acme-corp.com")).toBeNull();
    expect(nameFromLocalPart("jd@acme-corp.com")).toBeNull();
    expect(nameFromLocalPart("support@acme-corp.com")).toBeNull();
    expect(nameFromLocalPart("sales2@acme-corp.com")).toBeNull();
  });
});

describe("nameFromPageContext", () => {
  const email = "jane.doe@acme-corp.com";

  it("reads the RFC display form", () => {
    expect(nameFromPageContext(`Jane Doe <${email}>`, email)?.name).toBe("Jane Doe");
  });

  it("reads markdown link text", () => {
    expect(nameFromPageContext(`[Jane Doe](mailto:${email})`, email)?.name).toBe("Jane Doe");
  });

  it("reads a bolded team-page name", () => {
    expect(nameFromPageContext(`**Jane Doe**\n${email}`, email)?.name).toBe("Jane Doe");
  });

  it("captures the printed job title with the name", () => {
    const page = `Jane Doe, Head of Operations — ${email} — we migrate data.`;
    const hit = nameFromPageContext(page, email);
    expect(hit?.name).toBe("Jane Doe");
    expect(hit?.title).toMatch(/Operations/i);
  });

  it("returns null for a bare address", () => {
    expect(nameFromPageContext(`reach us at ${email}`, email)).toBeNull();
  });
});

describe("pickBestContact", () => {
  it("prefers a named person on the company domain over a role mailbox", () => {
    const best = pickBestContact(
      [{ url: "https://acme-corp.com/contact", text: "hello@acme-corp.com — Jane Doe <jane.doe@acme-corp.com>" }],
      "acme-corp.com",
    );
    expect(best?.email).toBe("jane.doe@acme-corp.com");
    expect(best?.name).toBe("Jane Doe");
    expect(best?.sameDomain).toBe(true);
  });

  it("falls back to the role address, but without inventing a name for it", () => {
    const best = pickBestContact(
      [{ url: "https://acme-corp.com/contact", text: "Say hello@acme-corp.com" }],
      "acme-corp.com",
    );
    expect(best?.email).toBe("hello@acme-corp.com");
    // The greeting has to stay generic. "Dear Hello" is what a fabricated name
    // costs the sender's credibility.
    expect(best?.name).toBe("");
    expect(best?.nameSource).toBe("none");
    expect(best?.role).toBe(true);
  });

  it("picks the named person even when the role mailbox appears first", () => {
    const best = pickBestContact(
      [
        {
          url: "https://acme-corp.com/contact",
          text: `General enquiries: hello@acme-corp.com\n\n**Nikol Petrov**\nnikol@acme-corp.com`,
        },
      ],
      "acme-corp.com",
    );
    expect(best?.email).toBe("nikol@acme-corp.com");
    expect(best?.name).toBe("Nikol Petrov");
  });

  it("ranks a company-domain address above a gmail one for the same person", () => {
    const best = pickBestContact(
      [
        { url: "https://acme-corp.com/team", text: "Maria Kova (maria@gmail.com) maria.kova@acme-corp.com" },
      ],
      "acme-corp.com",
    );
    expect(best?.email).toBe("maria.kova@acme-corp.com");
  });

  it("keeps a free-mailbox contact rather than finding nothing", () => {
    const best = pickBestContact(
      [{ url: "https://acme-corp.com/contact", text: "Ivan Petrov <ivan.petrov@gmail.com>" }],
      "acme-corp.com",
    );
    expect(best?.email).toBe("ivan.petrov@gmail.com");
    expect(best?.freeMail).toBe(true);
    expect(best?.sameDomain).toBe(false);
  });

  it("records where the address was found", () => {
    const best = pickBestContact(
      [{ url: "https://acme-corp.com/team", text: `Jane Doe <jane.doe@acme-corp.com>` }],
      "acme-corp.com",
    );
    expect(best?.sourceUrl).toBe("https://acme-corp.com/team");
    expect(best?.nameSource).toBe("page");
  });

  it("is deterministic for identical input", () => {
    const pages = [
      { url: "https://acme-corp.com/a", text: "a.b@acme-corp.com c.d@acme-corp.com" },
      { url: "https://acme-corp.com/b", text: "e.f@acme-corp.com" },
    ];
    expect(pickBestContact(pages, "acme-corp.com")?.email).toBe(
      pickBestContact(pages, "acme-corp.com")?.email,
    );
  });

  it("finds nothing in an empty or irrelevant page", () => {
    expect(pickBestContact([], "acme-corp.com")).toBeNull();
    expect(pickBestContact([{ url: "x", text: "no addresses here" }], "acme-corp.com")).toBeNull();
  });
});

describe("contactPageUrls", () => {
  it("builds absolute candidate URLs for the company domain", () => {
    const urls = contactPageUrls("acme-corp.com");
    expect(urls).toContain("https://acme-corp.com/contact");
    expect(urls).toContain("https://acme-corp.com/team");
    expect(urls.length).toBeGreaterThan(3);
    expect(urls.every((u) => u.startsWith("https://acme-corp.com/"))).toBe(true);
    // Last, not first: the front page is the fallback when the named paths 404,
    // and it is where a footer address lives.
    expect(urls.at(-1)).toBe("https://acme-corp.com/");
  });

  it("refuses to build urls for a junk domain", () => {
    expect(contactPageUrls("")).toEqual([]);
    expect(contactPageUrls("not a domain")).toEqual([]);
  });
});

describe("enrichCandidateWithContact", () => {
  it("attaches the best published contact and records provenance", async () => {
    const out = await enrichCandidateWithContact(async () => [
      { url: "https://acme-corp.com/team", text: `Jane Doe, CTO <jane.doe@acme-corp.com>` },
    ], candidate());
    expect(out.contact?.email).toBe("jane.doe@acme-corp.com");
    expect(out.contact?.name).toBe("Jane Doe");
    expect(out.evidence.at(-1)?.sourceUrl).toBe("https://acme-corp.com/team");
  });

  it("never overwrites a contact we already have", async () => {
    let called = 0;
    const out = await enrichCandidateWithContact(
      async () => {
        called += 1;
        return [{ url: "https://acme-corp.com/team", text: "Other Person <other@acme-corp.com>" }];
      },
      candidate({ contact: { name: "Typed By Owner", email: "owner@acme-corp.com" } }),
    );
    expect(out.contact?.email).toBe("owner@acme-corp.com");
    expect(called).toBe(0); // and no credits spent finding out
  });

  it("leaves the candidate untouched when the scraper fails", async () => {
    const boom = async () => {
      throw new Error("429 rate limited");
    };
    const out = await enrichCandidateWithContact(boom, candidate());
    expect(out.contact).toBeUndefined();
    expect(out.evidence).toEqual([]);
  });

  it("leaves the candidate untouched when the pages hold nothing usable", async () => {
    const out = await enrichCandidateWithContact(
      async () => [{ url: "https://acme-corp.com/contact", text: "logo@2x.png noreply@acme-corp.com" }],
      candidate(),
    );
    expect(out.contact).toBeUndefined();
  });

  it("stores a nameless role contact with an empty name rather than a fake one", async () => {
    const out = await enrichCandidateWithContact(
      async () => [{ url: "https://acme-corp.com/contact", text: "hello@acme-corp.com" }],
      candidate(),
    );
    expect(out.contact?.email).toBe("hello@acme-corp.com");
    expect(out.contact?.name).toBe("");
  });

  // Scraping is billed per call, so the page walk has to stop when the answer is
  // already in hand — and keep going when it plainly is not.
  it("stops fetching once it has a named person on the company domain", async () => {
    const asked: string[] = [];
    const out = await enrichCandidateWithContact(async (urls) => {
      asked.push(...urls);
      return [{ url: urls[0]!, text: `Jane Doe <jane.doe@acme-corp.com>` }];
    }, candidate());
    expect(out.contact?.email).toBe("jane.doe@acme-corp.com");
    expect(asked).toEqual(["https://acme-corp.com/contact"]);
  });

  it("keeps reading past a role mailbox and takes the person found on /team", async () => {
    const asked: string[] = [];
    const out = await enrichCandidateWithContact(async (urls) => {
      const url = urls[0]!;
      asked.push(url);
      if (url.endsWith("/contact")) return [{ url, text: "hello@acme-corp.com" }];
      if (url.endsWith("/team")) return [{ url, text: "**Petra Vale**\npetra@acme-corp.com" }];
      return [];
    }, candidate());
    expect(out.contact?.email).toBe("petra@acme-corp.com");
    expect(asked).toContain("https://acme-corp.com/team");
    // …and it stopped there instead of finishing the list.
    expect(asked.length).toBeLessThan(6);
  });

  it("stops walking a site that answers every path with the same page", async () => {
    // Live run against a real single-page site: /contact, /contact-us, /team, /about,
    // /about-us and /company all returned HTTP 200 with one identical 5249-character
    // body. Six requests, one page, and on a paid scraper six times the spend.
    const asked: string[] = [];
    const sameBody = "Acme Corp — we migrate databases. " + "x".repeat(200);
    const out = await enrichCandidateWithContact(async (urls) => {
      asked.push(...urls);
      return [{ url: urls[0]!, text: sameBody }];
    }, candidate());
    expect(out.contact).toBeUndefined();
    expect(asked).toEqual(["https://acme-corp.com/contact", "https://acme-corp.com/contact-us"]);
  });

  it("keeps what the earlier pages gave when a later page blows up", async () => {
    const out = await enrichCandidateWithContact(async (urls) => {
      const url = urls[0]!;
      if (url.endsWith("/contact")) return [{ url, text: "hello@acme-corp.com" }];
      throw new Error("timeout");
    }, candidate());
    expect(out.contact?.email).toBe("hello@acme-corp.com");
  });
});
