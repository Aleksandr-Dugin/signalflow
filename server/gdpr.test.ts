// Unit tests for the data-subject rights layer: the job-payload matcher that decides
// what an erasure must also cancel, and the invariants of the legal documents that
// `shared/legal.ts` renders. Neither touches a database.
import { describe, expect, it } from "vitest";
import { jobRunsMentioning } from "./services/gdpr";
import { CONTROLLER, LEGAL_DOCS, SUBPROCESSORS, legalIsUnfiled } from "../shared/legal";

const PROSPECT = "pros_123";
const EMAIL = "maria@acme-corp.com";

describe("jobRunsMentioning", () => {
  it("finds the queued job that would mail this person tomorrow", () => {
    // The point of the whole function: everything else an erasure deletes is history,
    // but a queued follow-up is a future send. Matching only by address would miss it,
    // because the payload carries an id, not the email.
    const jobs = [
      { id: "job_1", payload: { prospectId: PROSPECT } },
      { id: "job_2", payload: { campaignId: "camp_1" } },
    ];
    expect(jobRunsMentioning(jobs, { prospectIds: [PROSPECT], email: EMAIL })).toEqual(["job_1"]);
  });

  it("finds a job that names the address without naming the prospect", () => {
    // Reply bodies are copied into payloads, so an address can appear as free text.
    const jobs = [{ id: "job_3", payload: { lastReplyBody: `Write to ${EMAIL.toUpperCase()} if interested` } }];
    expect(jobRunsMentioning(jobs, { prospectIds: ["other"], email: EMAIL })).toEqual(["job_3"]);
  });

  it("is case-insensitive about the address it is hunting", () => {
    const jobs = [{ id: "job_4", payload: { note: "replied from Maria@Acme-Corp.com" } }];
    expect(jobRunsMentioning(jobs, { prospectIds: [], email: EMAIL })).toEqual(["job_4"]);
  });

  it("leaves jobs about someone else alone", () => {
    const jobs = [
      { id: "job_5", payload: { prospectId: "pros_999" } },
      { id: "job_6", payload: null },
      { id: "job_7", payload: "not an object" },
    ];
    expect(jobRunsMentioning(jobs, { prospectIds: [PROSPECT], email: EMAIL })).toEqual([]);
  });

  it("survives a payload that cannot be serialised", () => {
    // A JSON column should never contain this, but erasure must not be the operation
    // that throws because one row was weird — a failed erasure is a compliance breach.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(jobRunsMentioning([{ id: "job_8", payload: circular }], { prospectIds: [], email: EMAIL })).toEqual([]);
  });

  it("returns nothing when there are no prospect ids and no rows", () => {
    expect(jobRunsMentioning([], { prospectIds: [], email: EMAIL })).toEqual([]);
  });
});

describe("legal documents", () => {
  it("ship unfiled, so the pages warn instead of pretending", () => {
    // If this ever flips without a human filling in the controller block, the draft
    // banner disappears from a deployment that is still naming nobody.
    expect(legalIsUnfiled()).toBe(true);
    expect(Object.values(CONTROLLER).every((v) => v.startsWith("TODO:"))).toBe(true);
  });

  it("describes both documents completely", () => {
    for (const doc of Object.values(LEGAL_DOCS)) {
      expect(doc.sections.length).toBeGreaterThan(4);
      for (const section of doc.sections) {
        expect(section.heading.length).toBeGreaterThan(3);
        expect(section.body.length).toBeGreaterThan(0);
        for (const paragraph of section.body) expect(paragraph.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it("names every provider the policy promises to disclose", () => {
    const privacy = LEGAL_DOCS.privacy.sections.map((s) => s.body.join(" ")).join(" ");
    // The subprocessor list is the part an operator could forget to update, so the
    // page has to render it, and saying "the operator's configured providers" in
    // prose would let a new integration ship undisclosed.
    for (const s of SUBPROCESSORS) expect(privacy).toContain(s.name);
    expect(SUBPROCESSORS.map((s) => s.name)).toContain("Hunter.io or Apollo");
  });

  it("keeps the promises the code actually implements", () => {
    const privacy = LEGAL_DOCS.privacy.sections.map((s) => s.body.join(" ")).join(" ");
    // Each of these sentences is only true because of a specific feature; if the
    // feature goes, this test is where the policy gets corrected.
    expect(privacy).toContain("suppression list"); // outreach refuses suppressed addresses
    expect(privacy).toContain("origin"); // contacts.origin records where an address came from
    expect(privacy).toContain("do not scrape social networks"); // ToS boundary
    expect(privacy).toContain("never constructs an address from a name and a domain pattern"); // contactExtraction reads pages only
    expect(privacy).toContain("no advertising or analytics cookies");
    expect(privacy).toContain("erasure"); // the Settings path this file tests alongside
  });
});
