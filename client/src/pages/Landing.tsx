import { Link } from "wouter";
import {
  ArrowRight,
  Radar,
  Brain,
  Send,
  TrendingUp,
  ShieldCheck,
  Gauge,
  Globe2,
  Lock,
  Zap,
} from "lucide-react";
import { trpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Logo, ThemeToggle, OriginBadge, AmbientBackground, PipelineFlow, SectionTag, Reveal, AnimatedCounter, ScrollProgress, CursorLayer, Magnetic, ScoreBar, useScrollTickerSpeed, useActiveIndex, spotlightMove } from "@/components/common";
import { cn } from "@/lib/utils";

const features = [
  { icon: Radar, title: "ICP-driven discovery", body: "Describe the offer. We crawl the live web for companies that actually match it — not a purchased list." },
  { icon: Brain, title: "Grounded research", body: "Every claim is tied to a source. No fabricated facts, no generic filler paragraphs." },
  { icon: TrendingUp, title: "Intent scoring", body: "Fit, intent and confidence are scored from live buying signals and how fresh they are." },
  { icon: Send, title: "Review-first outreach", body: "Drafts wait for your approval. Suppression and idempotency are built into the send path." },
];

const pillars = [
  { icon: Gauge, label: "Autonomous SDR", body: "Thread-aware follow-ups on autopilot" },
  { icon: Globe2, label: "Real web discovery", body: "ScrapeGraphAI + Groq, provenance-tagged" },
  { icon: Lock, label: "Your keys, your data", body: "Standalone — nobody else owns your pipeline" },
];

const ticker = [
  "OFFER → ICP", "LIVE WEB DISCOVERY", "INTENT SCORING", "GROUNDED RESEARCH",
  "AUTOPILOT FOLLOW-UPS", "REVIEW-FIRST OUTREACH", "REPLY DETECTION", "ZERO CARDS STORED",
];

export default function Landing() {
  const { user } = useAuth();
  const demo = trpc.meta.demoLeads.useQuery();
  const plans = trpc.meta.plans.useQuery();
  const tickerRef = useScrollTickerSpeed<HTMLDivElement>();
  const { active, setRefs } = useActiveIndex(features.length);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      <ScrollProgress />
      <CursorLayer />
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-[var(--brutal-line)] bg-background">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <Logo />
          <nav className="hidden items-center gap-7 font-mono text-xs uppercase tracking-wider text-muted-foreground md:flex">
            <a href="#machine" className="navlink transition-colors hover:text-foreground">Machine</a>
            <a href="#pipeline" className="navlink transition-colors hover:text-foreground">Pipeline</a>
            <a href="#pricing" className="navlink transition-colors hover:text-foreground">Pricing</a>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {user ? (
              <Link href="/app" className="btn-acid inline-flex h-9 items-center gap-1.5 rounded-[3px] px-4 text-xs">Open app <ArrowRight className="h-3.5 w-3.5" /></Link>
            ) : (
              <>
                <Link href="/login" className="hidden h-9 items-center rounded-[3px] px-3 font-mono text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground sm:inline-flex">Sign in</Link>
                <Link href="/login" className="btn-acid inline-flex h-9 items-center gap-1.5 rounded-[3px] px-4 text-xs">Get started</Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero — asymmetric split */}
      <section id="product" className="relative border-b border-[var(--brutal-line)]">
        <AmbientBackground parallax />
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 sm:py-20 lg:grid-cols-[1.15fr_0.85fr]">
          <div>
            <div className="animate-rise mb-6 inline-flex items-center gap-2 rounded-[3px] border border-[var(--brutal-line)] bg-card px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-barpulse" /> autonomous client-acquisition engine
            </div>
            <h1 className="animate-rise font-grotesk text-[2.6rem] font-black leading-[1.04] tracking-tight sm:text-6xl" style={{ animationDelay: "80ms" }}>
              Find the businesses that need you.
              <span className="mt-1 block text-primary">Then reach out first.</span>
            </h1>
            <p className="animate-rise mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg" style={{ animationDelay: "160ms" }}>
              Describe what you sell once. SignalFlow discovers real companies on the live web, scores their
              buying intent, researches them with sources, and — on autopilot — follows up. You step in to close.
            </p>
            <div className="animate-rise mt-8 flex flex-col gap-3 sm:flex-row" style={{ animationDelay: "240ms" }}>
              <Magnetic><Link href="/login" className="btn-acid inline-flex h-12 items-center justify-center gap-2 rounded-[3px] px-6 text-sm">Start free <ArrowRight className="h-4 w-4" /></Link></Magnetic>
              <a href="#machine" className="btn-outline-brutal inline-flex h-12 items-center justify-center gap-2 rounded-[3px] px-6 text-sm">See the machine</a>
            </div>
            <p className="mt-4 font-mono text-xs text-muted-foreground">FREE PLAN · NO CARD · GOOGLE / GITHUB / EMAIL</p>

            <dl className="animate-rise mt-10 grid max-w-lg grid-cols-3 gap-px overflow-hidden rounded-[3px] border border-[var(--brutal-line)] bg-[var(--brutal-line)]" style={{ animationDelay: "320ms" }}>
              <div className="bg-card px-4 py-3">
                <dt className="mono-label text-muted-foreground">Engines</dt>
                <dd className="font-grotesk text-2xl font-extrabold tabular"><AnimatedCounter value={8} format={(n) => String(n).padStart(2, "0")} /></dd>
              </div>
              <div className="bg-card px-4 py-3">
                <dt className="mono-label text-muted-foreground">Setup</dt>
                <dd className="font-grotesk text-2xl font-extrabold tabular">~4 min</dd>
              </div>
              <div className="bg-card px-4 py-3">
                <dt className="mono-label text-muted-foreground">Cards stored</dt>
                <dd className="font-grotesk text-2xl font-extrabold tabular"><AnimatedCounter value={0} /></dd>
              </div>
            </dl>
          </div>

          <div className="lg:pl-4">
            <Reveal delay={200}><PipelineFlow /></Reveal>
          </div>
        </div>
      </section>

      {/* Ticker */}
      <div className="flex overflow-hidden border-b border-[var(--brutal-line)] bg-primary py-2 text-primary-foreground">
        <div ref={tickerRef} className="flex w-max shrink-0 animate-ticker items-center">
          {[...ticker, ...ticker].map((t, i) => (
            <span key={i} className="flex items-center gap-6 px-6 font-mono text-xs font-semibold uppercase tracking-wider">
              {t} <Zap className="h-3.5 w-3.5" />
            </span>
          ))}
        </div>
      </div>

      {/* Pillars strip */}
      <section className="mx-auto max-w-6xl px-5 py-6">
        <Reveal className="grid gap-px overflow-hidden rounded-[3px] border border-[var(--brutal-line)] bg-[var(--brutal-line)] sm:grid-cols-3">
          {pillars.map((p) => (
            <div key={p.label} className="tile flex items-center gap-3 bg-card p-4">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[3px] border border-[var(--brutal-line)] bg-primary/10 text-primary"><p.icon className="h-5 w-5" /></span>
              <div className="text-left">
                <p className="text-sm font-bold">{p.label}</p>
                <p className="text-xs text-muted-foreground">{p.body}</p>
              </div>
            </div>
          ))}
        </Reveal>
      </section>

      {/* The machine — asymmetric editorial + brutal tiles */}
      <section id="machine" className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <SectionTag index="01" label="the machine" scramble />
            <h2 className="mt-4 font-grotesk text-3xl font-black leading-tight tracking-tight sm:text-4xl">
              Four engines, one flow.
            </h2>
            <p className="mt-4 max-w-md text-muted-foreground">
              From a blank offer to a scored, researched shortlist you can act on — with an agent that keeps the
              thread warm while you're busy.
            </p>
            <div className="mt-6 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
              <span className="tabular text-primary">{String(active + 1).padStart(2, "0")}</span>
              <span className="tabular">/ {String(features.length).padStart(2, "0")}</span>
              <span className="mx-1 h-px w-6 bg-[var(--brutal-line)]" />
              <span className="truncate normal-case tracking-normal">{features[active]?.title}</span>
            </div>
            <div className="mt-6 brutal-flat p-4">
              <p className="mono-label text-primary">autopilot</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Turn it on and SignalFlow re-runs discovery on a schedule, drafts thread-aware follow-ups, and only
                sends what clears your rules.
              </p>
            </div>
          </div>

          <Reveal className="grid gap-px overflow-hidden rounded-[3px] border border-[var(--brutal-line)] bg-[var(--brutal-line)] sm:grid-cols-2">
            {features.map((f, i) => (
              <div key={f.title} ref={setRefs[i]} onMouseMove={spotlightMove} className={cn("tile spotlight bg-card p-6", active === i && "is-active")}>
                <div className="flex items-center justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-[3px] border border-[var(--brutal-line)] bg-card text-primary shadow-[3px_3px_0_0_var(--brutal-ink)]">
                    <f.icon className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-xs tabular text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                </div>
                <h3 className="mt-5 font-grotesk text-lg font-bold">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* Pipeline preview */}
      <section id="pipeline" className="border-y border-[var(--brutal-line)] bg-card/30">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-3">
            <div>
              <SectionTag index="02" label="pipeline preview" scramble />
              <h2 className="mt-4 font-grotesk text-3xl font-black tracking-tight sm:text-4xl">What a scored shortlist looks like</h2>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{demo.data?.disclosure ?? "Loading sample leads…"}</p>
            </div>
            <span className="rounded-[3px] border border-amber-500/50 bg-amber-500/10 px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-amber-500">Fictional sample</span>
          </div>
          <Reveal className="grid gap-4 md:grid-cols-3">
            {(demo.data?.prospects ?? []).map((p) => (
              <div key={p.id} onMouseMove={spotlightMove} className="brutal-sm hoverable spotlight flex flex-col overflow-hidden">
                <div className="flex items-center justify-between border-b border-[var(--brutal-line)] px-4 py-3">
                  <h3 className="font-bold">{p.company}</h3>
                  <OriginBadge origin={p.origin} />
                </div>
                <p className="line-clamp-3 flex-1 px-4 py-3 text-sm text-muted-foreground">{p.description}</p>
                <div className="space-y-2.5 border-t border-[var(--brutal-line)] px-4 py-3">
                  <ScoreBar label="Fit" value={p.fitScore} tone="success" />
                  <ScoreBar label="Score" value={p.overallScore} tone="primary" />
                </div>
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="mx-auto max-w-6xl px-5 py-16 sm:py-20">
        <div className="mb-10 text-center">
          <SectionTag index="03" label="pricing" className="justify-center" scramble />
          <h2 className="mt-4 font-grotesk text-3xl font-black tracking-tight sm:text-4xl">Priced for pipelines that close</h2>
          <p className="mt-3 text-muted-foreground">Start free. Upgrade when the replies start coming in.</p>
        </div>
        <Reveal className="grid gap-4 md:grid-cols-4">
          {(plans.data?.plans ?? []).map((plan) => {
            const featured = plan.id === "pro";
            return (
              <div key={plan.id} onMouseMove={spotlightMove} className={featured ? "brutal brutal-accent hoverable spotlight flex h-full flex-col overflow-hidden" : "brutal-flat hoverable spotlight flex h-full flex-col overflow-hidden"}>
                <div className="flex items-center justify-between border-b border-[var(--brutal-line)] px-5 py-3">
                  <h3 className="font-grotesk text-lg font-bold">{plan.name}</h3>
                  {featured ? <span className="rounded-[3px] bg-primary px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase text-primary-foreground">Popular</span> : null}
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <div className="font-grotesk text-4xl font-black tabular tracking-tight">
                    ${Math.round(plan.priceCents / 100)}
                    <span className="font-mono text-sm font-normal text-muted-foreground">/mo</span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{plan.tagline}</p>
                  <ul className="mt-5 flex-1 space-y-2 font-mono text-xs text-muted-foreground">
                    <li className="flex items-center gap-2"><Check /> {plan.limits.campaigns} campaigns</li>
                    <li className="flex items-center gap-2"><Check /> {plan.limits.prospectsPerCampaign} prospects/campaign</li>
                    <li className="flex items-center gap-2"><Check /> {plan.limits.aiRunsPerMonth} AI runs/mo</li>
                    <li className="flex items-center gap-2"><Check /> {plan.features.outreach ? "Outreach included" : "Read-only (no outreach)"}</li>
                  </ul>
                  <Link href="/login" className={featured ? "btn-acid mt-6 inline-flex h-11 items-center justify-center rounded-[3px] text-sm" : "btn-outline-brutal mt-6 inline-flex h-11 items-center justify-center rounded-[3px] text-sm"}>
                    {plan.id === "free" ? "Current" : "Choose"}
                  </Link>
                </div>
              </div>
            );
          })}
        </Reveal>
      </section>

      {/* CTA band — acid panel */}
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <Reveal className="brutal-acid overflow-hidden p-8 sm:p-12">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div>
              <p className="font-mono text-xs uppercase tracking-wider opacity-70">// put it on autopilot</p>
              <h2 className="mt-2 font-grotesk text-3xl font-black tracking-tight sm:text-4xl">Describe your offer once. Let it run.</h2>
            </div>
            <Link href="/login" className="btn-ink inline-flex h-12 shrink-0 items-center gap-2 rounded-[3px] px-6 text-sm">
              Get started <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </Reveal>
      </section>

      {/* Footer */}
      <footer className="border-t border-[var(--brutal-line)] bg-card/30">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-8 text-sm sm:flex-row">
          <Logo />
          <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-success" /> Standalone · your data, your keys
          </div>
          <p className="font-mono text-xs text-muted-foreground">© {new Date().getFullYear()} SIGNALFLOW</p>
        </div>
      </footer>
    </div>
  );
}

function Check() {
  return <span className="text-primary">›</span>;
}
