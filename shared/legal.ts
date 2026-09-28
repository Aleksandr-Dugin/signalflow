// Legal document content, shared because the client renders it and the server may
// have to quote it (the unsubscribe footer link, the erasure confirmation text).
//
// READ THIS BEFORE SHIPPING IT. These documents describe what this code actually
// does, which is the only kind of privacy policy worth anything — but they cannot
// know who you are. The CONTROLLER block below is the part only you can fill in,
// and Legal.tsx refuses to render these pages quietly while it still says TODO:
// a policy that names nobody is not a policy, it is decoration.
//
// Nothing here is legal advice, and no text written by software makes a cold-email
// operation lawful in your jurisdiction. The lawful basis claimed below
// (legitimate interests for B2B outreach) is the one this product's design assumes;
// whether it holds where you send from and to is a question for a lawyer.

export interface LegalSection {
  heading: string;
  body: string[];
}

export interface LegalDocument {
  slug: "privacy" | "terms";
  title: string;
  summary: string;
  sections: LegalSection[];
}

const TODO_PREFIX = "TODO:";

/** Fill every value in. The pages show a warning banner while any still says TODO. */
export const CONTROLLER = {
  /** Registered name of the entity operating this deployment. */
  legalName: `${TODO_PREFIX} Legal entity name`,
  /** Where a data subject sends a request. Must be a monitored mailbox. */
  contactEmail: `${TODO_PREFIX}privacy@yourdomain.example`,
  /** EU representative, if you are not established in the EU but target the EU. */
  euRepresentative: `${TODO_PREFIX}EU representative, or "not applicable"`,
  /** Governing law for the terms of service. */
  governingLaw: `${TODO_PREFIX}Country/state whose law governs`,
  /** Where the database actually lives — decides whether a transfer is international. */
  hostingRegion: `${TODO_PREFIX}e.g. Frankfurt (AWS eu-central-1), or "self-hosted, see below"`,
};

/** True while any controller field is still a placeholder. */
export function legalIsUnfiled(): boolean {
  return Object.values(CONTROLLER).some((v) => v.startsWith(TODO_PREFIX));
}

export const UPDATED = `${TODO_PREFIX} date the document was last reviewed`;

// Third parties this build can talk to. Kept as data so the page and the code
// cannot drift apart: every name here corresponds to a provider selector in
// server/services or a route mounted in server/_core.
export const SUBPROCESSORS: { name: string; purpose: string; onlyIf: string }[] = [
  {
    name: "Groq",
    purpose: "drafts, qualification and reply classification; the prompt and the generated text leave your server",
    onlyIf: "GROQ_API_KEY is set (otherwise text is written locally with no provider)",
  },
  {
    name: "ScrapeGraphAI",
    purpose: "reading a target company's own public pages to find company and contact information",
    onlyIf: "SGAI_API_KEY is set",
  },
  {
    name: "Your SMTP / email service provider",
    purpose: "delivering outbound mail and forwarding inbound mail and delivery events back to us",
    onlyIf: "SMTP_* is configured",
  },
  {
    name: "Hunter.io or Apollo",
    purpose: "buying a verified business email address, and sometimes a phone number, for a company whose own pages name nobody",
    onlyIf: "ENRICHMENT_PROVIDER is set — never runs on its own initiative",
  },
  {
    name: "Calendly",
    purpose: "a booking callback that moves a deal to meeting_booked",
    onlyIf: "CALENDLY_URL is set",
  },
  {
    name: "Stripe",
    purpose: "a payment callback that moves a deal to won",
    onlyIf: "STRIPE_PAYMENT_LINK is set",
  },
  {
    name: "Platega",
    purpose: "billing for this software itself, not for prospect data",
    onlyIf: "BILLING_PROVIDER=platega",
  },
];

export const PRIVACY: LegalDocument = {
  slug: "privacy",
  title: "Privacy policy",
  summary:
    "What this software records about business contacts, where it gets it, who it shows it to, and how a person gets it removed.",
  sections: [
    {
      heading: "Who is responsible, and in what role",
      body: [
        `${CONTROLLER.legalName} operates this deployment and is the controller of the personal data it holds. Requests about your data go to ${CONTROLLER.contactEmail}.`,
        "SignalFlow is software that runs on the operator's own infrastructure with the operator's own API keys. It does not send anything anywhere by itself: discovery, generation, enrichment and delivery each happen only if the operator configured that provider. Where the operator is a different company from the one running this server, the operator is the controller and this server acts on their instructions.",
        "This policy covers natural persons whose data appears in the pipeline: named contacts at target companies, and the people who reply to a message. Companies are not data subjects; the information recorded about a company (industry, size, signals) becomes personal data only where it identifies a person.",
      ],
    },
    {
      heading: "What is recorded about you",
      body: [
        "A contact record: name, job title, business email address, and — where a licensed data provider supplied them — a business phone number and a link to a professional profile. Each record also stores where it came from: a page your own company published, a purchased lookup, or something a person typed in by hand.",
        "Every message sent to you: subject, body, the time it was sent and its delivery status.",
        "Everything you send back. The original body of an inbound reply is kept verbatim, as sent, because a later dispute about what was said cannot be settled from a summary. Machine classification of your reply (interested, not interested, unsubscribe) is stored alongside it.",
        "Interaction events: delivery, bounce, a click on a link we generated, a meeting booked through a link we gave you, a payment made through a link we gave you.",
        "Derived assessments: a fit score, an intent score, the reasons a prospect was qualified or disqualified, and any opportunity record built from the above. These are the software's own guesses about a business, and the operator can override them at any time.",
        "What is never recorded: your password is stored as a hash and is not readable by the operator; we place no advertising or analytics cookies, and the tracking links we generate are first-party and resolve to this server only.",
      ],
    },
    {
      heading: "Where it comes from",
      body: [
        "Three routes, in order of preference. First, the target company's own published pages — the contact, team and about pages of their own website. Second, a licensed data provider the operator pays, used only when the company's pages name nobody. Third, a person at the operator who types in an address they know.",
        "We do not scrape social networks. Their terms forbid it, and a provider that gets its key revoked loses the ability to find anyone at all, so professional profile links reach a record only when a data vendor licenses them.",
        "Nothing on this page was obtained by guessing a person's habits, interests or location outside their working life.",
      ],
    },
    {
      heading: "Why it is processed, and on what legal basis",
      body: [
        "Purpose: to start a business conversation about a specific service the operator provides. The claimed basis is Article 6(1)(f) — legitimate interests: B2B outreach to a person whose role makes the offer relevant, limited to what their published professional identity already exposes.",
        "That basis has to survive a balancing test, which is why the software restricts itself. An address reaches a record only from a page this system actually read, from a vendor licence the operator paid for, or from a human who typed it in; this software never constructs an address from a name and a domain pattern. A purchased record is dropped when the vendor labels it risky, invalid or uncertain, and a purchased personal-mailbox or shared role mailbox is dropped outright. On the free route a named person at the company's own domain always outranks a shared mailbox, which is used only where the company published nothing else — and no message goes out at all if the address is on the suppression list.",
        "A legitimate-interests assessment cannot be done in code, only decided, so the operator's own written assessment is what authorises sending. This policy states the basis the product is built around; it does not establish that the basis applies to your campaign.",
        "Separate rules govern the act of sending itself — ePrivacy in the EU, CAN-SPAM in the US, and their equivalents elsewhere. Those sit with the operator and are conditions of the terms of service, not covered by this policy.",
      ],
    },
    {
      heading: "Automated scoring and its effect on you",
      body: [
        "Prospects are ranked automatically: the software estimates how well a company fits the operator's offer and how promising the timing looks, and that ranking influences who gets written to.",
        "This is profiling as defined by Article 4(4). It is not a decision with legal or similarly significant effect under Article 22: no one is denied a service, priced, hired or fired by it. It decides who receives a commercial message, and a message can be refused at no cost to you.",
        "The inputs are business facts, and the reasons behind any score are stored in plain language and shown to the operator, who can disagree with them and change the record.",
      ],
    },
    {
      heading: "Who else sees it",
      body: [
        "Data is disclosed to the processors the operator has configured, and to no others:",
        ...SUBPROCESSORS.map((s) => `${s.name} — ${s.purpose}, when ${s.onlyIf}.`),
        "Each of those providers is a separate controller of the data it receives and has its own terms and retention. The operator's own account with them is what governs, not this software.",
      ],
    },
    {
      heading: "Transfers outside your region",
      body: [
        `This deployment stores its database in ${CONTROLLER.hostingRegion}. Most of the providers listed above are established in the United States, so configuring one of them means personal data leaves the region where it was collected.`,
        "For transfers out of the EEA or UK, the operator is responsible for putting the lawful transfer mechanism in place (standard contractual clauses, or a UK addendum) with that provider, and for checking whether an adequacy decision covers what they send.",
      ],
    },
    {
      heading: "How long it is kept",
      body: [
        "Contact records, messages and replies are kept while the campaign that produced them exists, and are deleted on request. Nothing here is kept because it might be useful someday: an erasure request removes the rows, it does not archive them.",
        "One record survives an erasure: your address stays on the suppression list. Forgetting it would make the next campaign mail you again, so keeping the single fact 'do not contact this address' is the obligation that outlives the rest of the file. It is stored with the reason and the date it was requested, and nothing else.",
        "Billing records for the software itself are kept as long as tax and accounting law requires, which applies to the operator's invoices, not to prospect data.",
      ],
    },
    {
      heading: "What you can ask for, and how",
      body: [
        "Access, rectification, erasure, restriction of processing, objection to processing (including objection to direct marketing, which is absolute), and portability of the data described above.",
        `Write to ${CONTROLLER.contactEmail}. The operator also has a built-in path for both requests — a single search on an email address returns everything this deployment holds about it, and erasing from the same screen deletes it across contacts, messages, replies and derived records — so a request can be fulfilled in one sitting rather than in thirty days of digging.`,
        "No fee, and no proof of identity beyond what is needed to be sure the request is genuine.",
        `If you are in the EEA or UK and consider the processing unlawful, you can complain to your supervisory authority, or to ${CONTROLLER.euRepresentative} as the representative in the Union.`,
      ],
    },
    {
      heading: "Security, and the limits of this page",
      body: [
        "Access is scoped by workspace: every query in this software is filtered by the requesting account's workspace before it touches a row, and an attempt to read another tenant's record by guessing an id fails rather than leaking. Secrets are never written to logs, and the API key a data vendor passes in a URL is stripped before that URL is stored.",
        "This is a description of the software, not a security certification. No audit report, penetration test or certification is claimed here, and none should be inferred.",
      ],
    },
  ],
};

export const TERMS: LegalDocument = {
  slug: "terms",
  title: "Terms of service",
  summary: "What you may do with this software, and what you take on by using it.",
  sections: [
    {
      heading: "What this is",
      body: [
        "Software that finds companies matching a description you write, drafts outreach, and runs the follow-up loop. It comes with no hosted service implied: it runs where you put it, on your credentials.",
        "It is not legal advice, and the deliverability of your mail is not a feature it can guarantee. Nothing in this product makes a campaign lawful — that depends on where you are, where recipients are, and what you sell.",
      ],
    },
    {
      heading: "Your obligations",
      body: [
        "You are the controller of prospect data and of everything sent from your account. Specifically, you take on:",
        "A lawful basis for the processing you do, recorded in writing before you send — the product is built around legitimate interests for B2B outreach, and that assessment is yours to make, not ours to assume for you.",
        "Compliance with anti-spam law where you send: accurate sender identity, a real physical address in the footer, a working unsubscribe that you honour, and no sending to addresses you have no basis to write to.",
        "Honouring opt-outs. The suppression list is enforced in the send path and in contact writes, so an address that opted out cannot be mailed again even by accident — but adding someone back is something you can do deliberately, and doing so is your responsibility.",
        "Review of generated text. Drafts are written by a model you configured; you are accountable for the claims made in an email that carries your name, whatever produced the sentence.",
        "Respecting the terms of every provider you connect. This includes the scraping and data-vendor terms — the product deliberately does not scrape social networks, and routing around that restriction is a breach of these terms.",
        "Not using the software for unlawful, deceptive or discriminatory purposes; not sending to consumers where a basis is required and absent; not reselling, exporting or publishing purchased enrichment data, which is licensed to you for contacting, not for owning.",
      ],
    },
    {
      heading: "Licence, and what stays yours",
      body: [
        "You may use, run, modify and deploy this software for your own business. Your data is yours: prospect records, drafts, sent messages and replies stay in your deployment and are removed when you remove them.",
        "Text produced by a model you configured is subject to that model provider's terms as well as these.",
      ],
    },
    {
      heading: "Acceptable use of the infrastructure",
      body: [
        "Do not use the software to send bulk mail through a shared or third-party domain you do not control, to forge headers, or to circumvent a recipient's filtering. Sending reputation is a shared resource in practice even when the software is not shared, and the product implements unsubscribe, suppression and rate limits because ignoring them harms people who have nothing to do with your campaign.",
        "Autonomy features are capped by design: sending limits per plan, bounded discovery runs, a per-workspace autopilot switch, and a platform-wide kill switch. Removing those caps in a fork is your decision; the resulting volume is your liability.",
      ],
    },
    {
      heading: "No warranty, and who bears the loss",
      body: [
        "The software is provided as is, without warranty of any kind. It can be wrong: about whether a company fits your offer, about an address, about what a reply meant.",
        "You are responsible for claims made in messages you send, for the consequences of campaigns you run, and for any action taken by a provider (including a sending domain being blocked or an account being suspended). The operator of this deployment is not liable for lost revenue, damaged sender reputation, or penalties arising from your use.",
        "Where these terms ask you to indemnify, that covers claims brought against the deployment operator by a third party because of your campaigns.",
      ],
    },
    {
      heading: "Termination, changes, and governing law",
      body: [
        "These terms end when you stop using the software; obligations that by their nature survive (lawful basis, confidentiality of purchased data, liability for what you sent) do survive.",
        "Changes to these terms take effect when the updated document is served at /terms. If a change is material and this deployment has accounts to notify, they are notified before it applies.",
        `These terms are governed by the law of ${CONTROLLER.governingLaw}, without regard to conflict-of-law rules, and disputes go to the courts there, except where mandatory consumer or data-protection law gives you another forum.`,
      ],
    },
    {
      heading: "Contact",
      body: [`Operator: ${CONTROLLER.legalName}. For anything under these terms, including data requests: ${CONTROLLER.contactEmail}.`],
    },
  ],
};

export const LEGAL_DOCS: Record<LegalDocument["slug"], LegalDocument> = {
  privacy: PRIVACY,
  terms: TERMS,
};
