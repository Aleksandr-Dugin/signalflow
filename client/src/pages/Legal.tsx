import { Link } from "wouter";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { LEGAL_DOCS, legalIsUnfiled, UPDATED, type LegalDocument } from "@shared/legal";
import { Logo } from "@/components/common";

/**
 * One component for both documents, because they must look identical: a privacy
 * policy and a terms of service that render differently is how a legal page ends up
 * reading like marketing copy. Deliberately plain — no animation, no accent blocks.
 * The only persuasion here should be the content.
 */
function LegalArticle({ doc }: { doc: LegalDocument }) {
  return (
    <article className="mx-auto max-w-3xl px-5 py-14">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Home
      </Link>

      <h1 className="mt-6 font-grotesk text-4xl font-black">{doc.title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{doc.summary}</p>
      <p className="mt-1 font-mono text-xs text-muted-foreground">Last updated: {UPDATED}</p>

      {doc.sections.map((section) => (
        <section key={section.heading} className="mt-10">
          <h2 className="font-grotesk text-xl font-black">{section.heading}</h2>
          {section.body.map((paragraph, i) => (
            <p key={i} className="mt-3 text-sm leading-relaxed">
              {paragraph}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}

export default function Legal({ slug }: { slug: LegalDocument["slug"] }) {
  const doc = LEGAL_DOCS[slug];
  const unfiled = legalIsUnfiled();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-[var(--brutal-line)] bg-card/40">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <Logo />
          <nav className="flex items-center gap-4 font-mono text-xs uppercase tracking-wider">
            <Link href="/privacy" className={slug === "privacy" ? "text-primary" : "navlink text-muted-foreground"}>
              Privacy
            </Link>
            <Link href="/terms" className={slug === "terms" ? "text-primary" : "navlink text-muted-foreground"}>
              Terms
            </Link>
          </nav>
        </div>
      </header>

      {/* Loud, on purpose, and on both documents. Publishing a policy whose operator
          fields still say TODO would be the exact failure this whole feature exists to
          avoid: text that looks compliant while naming nobody. */}
      {unfiled ? (
        <div className="mx-auto max-w-3xl px-5 pt-6">
          <div className="flex items-start gap-3 rounded-[3px] border-2 border-destructive bg-destructive/10 p-4">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="text-sm">
              <p className="font-semibold text-destructive">Draft — not yet fit to publish</p>
              <p className="mt-1 text-muted-foreground">
                The operator fields in <code>shared/legal.ts</code> are still placeholders, so the
                controller, contact address and hosting region named below are not real. Fill them in
                and have the text reviewed for the jurisdictions you send to before this page is
                linked from a live deployment.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <LegalArticle doc={doc} />
    </div>
  );
}
