import type { DataOrigin, ProspectStatus } from "./const";

export type ProviderMode = "live" | "demo";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

export interface ProfileSummary {
  serviceDescription: string;
  targetMarket: string;
  geography: string;
  goals?: string;
}

export interface IcpCriteria {
  industries: string[];
  companyTypes: string[];
  companySize: string[];
  geographies: string[];
  businessModels: string[];
  technologies: string[];
  likelyProblems: string[];
  buyingSignals: string[];
  exclusions: string[];
  narrative: string;
}

export interface ProspectCard {
  id: string;
  campaignId: string;
  company: string;
  domain: string;
  description: string;
  status: ProspectStatus;
  fitScore: number;
  overallScore: number;
  confidence: number;
  topSignal?: string;
  hasContact: boolean;
  origin: DataOrigin;
  sourceUrl?: string | null;
}

export interface SignalCard {
  id: string;
  type: string;
  importance: number;
  evidence: string[];
  sourceUrl: string;
  detectedAt: string;
}

export interface ResearchEvidence {
  claim: string;
  sourceUrl: string;
  confidence: number;
}

export interface PersonalizationDraft {
  id?: string;
  subject: string;
  openingLine: string;
  body: string;
  cta: string;
  evidence: string[];
  provider: ProviderMode;
}

/**
 * How a contact entered the system. Not decoration: the answer changes what you
 * may do with it. A `page` address was published by the company itself; a
 * `provider` address was bought from a data vendor, which is lawful but is a
 * different GDPR story and a different expectation of accuracy; `manual` came
 * from an operator, who presumably knows the person.
 */
export type ContactOrigin = "manual" | "page" | "provider";

export interface ContactRef {
  id: string;
  name: string;
  title?: string | null;
  email: string;
  verified: boolean;
  origin: ContactOrigin;
  /**
   * Collected but not sendable: email is still the only outbound channel, so a
   * phone number or profile link is a coordinate for a human to act on, not a
   * thing the pipeline may dial. It is stored because the lookup was paid for.
   */
  phone: string | null;
  socialUrl: string | null;
  /**
   * Where the address was published, when we know. Provenance is not decoration:
   * an operator deciding whether to cold-mail this person needs to see the page
   * that printed it.
   */
  sourceUrl?: string | null;
}

export interface ProspectDetail extends ProspectCard {
  contact?: ContactRef | null;
  signals: SignalCard[];
  evidence: ResearchEvidence[];
  researchSummary?: string | null;
  reasons: string[];
  disqualifiers: string[];
  latestDraft?: PersonalizationDraft | null;
}
