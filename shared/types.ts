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

export interface ContactRef {
  id: string;
  name: string;
  title?: string | null;
  email: string;
  verified: boolean;
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
