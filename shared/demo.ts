import type { ProspectCard } from "./types";

// FICTIONAL demo data. Never presented as real user data. Every record uses the
// reserved .example TLD (RFC 2606) and is explicitly labelled origin: "demo".
// These exist only so the no-account landing demo can show the product shape.

export const DEMO_DISCLOSURE =
  "These are fictional sample companies for demonstration only. They are not real businesses and no data was fetched from the web.";

export const demoProspects: ProspectCard[] = [
  {
    id: "demo-1",
    campaignId: "demo",
    company: "CloudPilot Analytics",
    domain: "cloudpilot.example",
    description:
      "Fictional B2B analytics SaaS. Sample 'hiring' signal suggests they may need automation help.",
    status: "qualified",
    fitScore: 94,
    overallScore: 92,
    confidence: 91,
    topSignal: "Hiring for RevOps (demo)",
    hasContact: false,
    origin: "demo",
    sourceUrl: "https://cloudpilot.example/about",
  },
  {
    id: "demo-2",
    campaignId: "demo",
    company: "Northwind Logistics",
    domain: "northwind.example",
    description: "Fictional regional freight company opening a new route (demo signal).",
    status: "qualified",
    fitScore: 81,
    overallScore: 78,
    confidence: 74,
    topSignal: "New market expansion (demo)",
    hasContact: false,
    origin: "demo",
    sourceUrl: "https://northwind.example/news",
  },
  {
    id: "demo-3",
    campaignId: "demo",
    company: "Lumen Health Clinics",
    domain: "lumenhealth.example",
    description: "Fictional multi-location clinic group launching an online booking flow (demo).",
    status: "new",
    fitScore: 69,
    overallScore: 66,
    confidence: 63,
    topSignal: "New product launch (demo)",
    hasContact: false,
    origin: "demo",
    sourceUrl: "https://lumenhealth.example/blog",
  },
];
