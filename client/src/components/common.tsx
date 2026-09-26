import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Moon, Sun, Activity } from "lucide-react";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function AppToaster() {
  return <Toaster position="top-center" richColors closeButton theme="dark" />;
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 font-mono text-sm font-bold uppercase tracking-tight", className)}>
      <span className="grid h-7 w-7 place-items-center rounded-[3px] border border-[var(--brutal-ink)] bg-primary text-primary-foreground shadow-[2px_2px_0_0_var(--brutal-ink)]">
        <Activity className="h-4 w-4" strokeWidth={2.5} />
      </span>
      <span>Signal<span className="text-primary">Flow</span></span>
    </span>
  );
}

// Technical backdrop: a faint blueprint grid, faded toward the edges. Decorative
// only (aria-hidden). No gradients, no blurred blobs — that was the "AI slop".
export function AmbientBackground({ className, parallax = false }: { className?: string; parallax?: boolean }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!parallax || reduced) return;
    let raf = 0;
    const run = () => {
      raf = 0;
      const el = gridRef.current;
      if (el) el.style.transform = `translate3d(0, ${window.scrollY * 0.12}px, 0)`;
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(run); };
    run();
    window.addEventListener("scroll", on, { passive: true });
    return () => { window.removeEventListener("scroll", on); if (raf) cancelAnimationFrame(raf); };
  }, [parallax, reduced]);
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}>
      <div ref={gridRef} className="absolute inset-x-0 -top-[25%] h-[150%] bg-blueprint bg-blueprint-fade opacity-70 will-change-transform" />
      <div className="absolute inset-x-0 top-0 h-px bg-[var(--brutal-line)]" />
    </div>
  );
}

const PIPELINE_STAGES = [
  { key: "offer", label: "Offer intake", value: "ICP" },
  { key: "icp", label: "Ideal customer", value: "profile" },
  { key: "discovery", label: "Web discovery", value: "ScrapeGraph" },
  { key: "signals", label: "Signal capture", value: "live" },
  { key: "score", label: "Intent scoring", value: "0–100" },
  { key: "research", label: "Grounded research", value: "sources" },
  { key: "outreach", label: "Draft outreach", value: "review" },
  { key: "reply", label: "Reply → deal", value: "autopilot" },
];

// Signature visual re-imagined as a system process monitor: the pipeline as a
// terminal log with hard borders, mono index and a blinking caret.
export function PipelineFlow({ className }: { className?: string }) {
  return (
    <div className={cn("brutal font-mono text-sm", className)}>
      <div className="flex items-center justify-between border-b border-[var(--brutal-line)] px-4 py-2.5">
        <span className="mono-label text-muted-foreground">pipeline.run</span>
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-success">
          <span className="h-1.5 w-1.5 rounded-full bg-success animate-barpulse" /> active
        </span>
      </div>
      <ol className="divide-y divide-[color-mix(in_oklab,var(--foreground)_10%,transparent)]">
        {PIPELINE_STAGES.map((s, i) => (
          <li
            key={s.key}
            className="flex items-center gap-3 px-4 py-2.5 animate-rise"
            style={{ animationDelay: `${i * 55}ms` }}
          >
            <span className="tabular w-6 shrink-0 text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
            <span className="flex-1 truncate text-foreground">{s.label}</span>
            <span className="mono-label shrink-0 rounded-[3px] border border-[var(--brutal-line)] px-1.5 py-0.5 text-muted-foreground">
              {s.value}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex items-center gap-2 border-t border-[var(--brutal-line)] px-4 py-2.5 text-muted-foreground">
        <span className="text-primary">$</span>
        <span className="caret text-xs">awaiting_reply</span>
      </div>
    </div>
  );
}

// Editorial section marker: [01] / FEATURE. Anchors the asymmetric layout.
export function SectionTag({ index, label, className, scramble = false }: { index: string; label: string; className?: string; scramble?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2 font-mono text-xs", className)}>
      <span className="text-primary tabular">[{index}]</span>
      {scramble ? (
        <ScrambleText text={label} className="mono-label text-muted-foreground" />
      ) : (
        <span className="mono-label text-muted-foreground">{label}</span>
      )}
    </div>
  );
}

// Reveal-on-scroll: fades/slides children up the first time they enter the
// viewport. Respects prefers-reduced-motion via a global CSS override.
function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          obs.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return { ref, inView };
}

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={cn("reveal", inView && "is-visible", className)}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}

// Counts up to `value` once visible. Falls back to the final number when
// motion is reduced (the global rule stops the rAF-driven transition feel).
export function AnimatedCounter({
  value,
  duration = 1100,
  format = (n) => String(n),
  className,
}: {
  value: number;
  duration?: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (!inView) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(eased * value));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, duration]);
  return (
    <span ref={ref} className={className}>
      {format(display)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Motion primitives — scroll choreography, technical animations, tactility.
// Every one degrades gracefully when prefers-reduced-motion is set.
// ---------------------------------------------------------------------------

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return reduced;
}

// Thin acid progress line pinned to the very top of the viewport.
export function ScrollProgress({ className }: { className?: string }) {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = document.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
      if (barRef.current) barRef.current.style.transform = `scaleX(${p})`;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <div aria-hidden className={cn("scroll-progress", className)}>
      <div ref={barRef} className="scroll-progress__bar" />
    </div>
  );
}

// Ref for an .animate-ticker element; speeds it up with scroll velocity.
export function useScrollTickerSpeed<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    const base = parseFloat(getComputedStyle(el).animationDuration) || 28;
    let lastY = window.scrollY;
    let reset = 0;
    const onScroll = () => {
      const y = window.scrollY;
      const v = Math.min(80, Math.abs(y - lastY));
      lastY = y;
      el.style.animationDuration = `${Math.max(6, base - v * 0.4)}s`;
      window.clearTimeout(reset);
      reset = window.setTimeout(() => { el.style.animationDuration = `${base}s`; }, 260);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); window.clearTimeout(reset); };
  }, [reduced]);
  return ref;
}

// Magnetic wrapper: nudges its child toward the cursor on fine-pointer devices.
export function Magnetic({ children, strength = 0.3, className }: { children: ReactNode; strength?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    if (!window.matchMedia?.("(pointer: fine)").matches) return;
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      el.style.transform = `translate(${(e.clientX - (r.left + r.width / 2)) * strength}px, ${(e.clientY - (r.top + r.height / 2)) * strength}px)`;
    };
    const onLeave = () => { el.style.transform = ""; };
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => { el.removeEventListener("mousemove", onMove); el.removeEventListener("mouseleave", onLeave); };
  }, [strength, reduced]);
  return <span ref={ref} className={cn("magnetic inline-block", className)}>{children}</span>;
}

// Custom acid cursor: a square dot + a trailing ring. Fine pointers only.
export function CursorLayer() {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.matchMedia?.("(pointer: fine)").matches) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let mx = window.innerWidth / 2, my = window.innerHeight / 2, rx = mx, ry = my;
    let raf = 0, shown = false;
    const move = (e: MouseEvent) => {
      mx = e.clientX; my = e.clientY;
      if (!shown) {
        shown = true;
        document.body.classList.add("has-custom-cursor");
        if (dotRef.current) dotRef.current.style.opacity = "1";
        if (ringRef.current) ringRef.current.style.opacity = "1";
      }
      if (dotRef.current) dotRef.current.style.transform = `translate(${mx}px, ${my}px)`;
      const t = e.target as HTMLElement | null;
      const hot = !!t?.closest("a,button,[role='button'],input,textarea,select,label,.magnetic,.tile,.hoverable");
      ringRef.current?.classList.toggle("is-hot", hot);
    };
    const loop = () => {
      rx += (mx - rx) * 0.2; ry += (my - ry) * 0.2;
      if (ringRef.current) ringRef.current.style.transform = `translate(${rx}px, ${ry}px)`;
      raf = requestAnimationFrame(loop);
    };
    const leave = () => {
      shown = false;
      document.body.classList.remove("has-custom-cursor");
      if (dotRef.current) dotRef.current.style.opacity = "0";
      if (ringRef.current) ringRef.current.style.opacity = "0";
    };
    window.addEventListener("mousemove", move);
    document.addEventListener("mouseleave", leave);
    raf = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("mousemove", move);
      document.removeEventListener("mouseleave", leave);
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <>
      <div ref={ringRef} aria-hidden className="cursor-ring" />
      <div ref={dotRef} aria-hidden className="cursor-dot" />
    </>
  );
}

const SCRAMBLE_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>_[]#*+=.:";

// Decode effect: glyphs resolve into the real text once the element is seen.
export function ScrambleText({ text, className, speed = 24 }: { text: string; className?: string; speed?: number }) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const reduced = useReducedMotion();
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (reduced || !inView) { setOut(text); return; }
    let raf = 0, last = 0, frame = 0;
    const total = text.length;
    const tick = (t: number) => {
      if (t - last >= speed) {
        last = t;
        frame += 1;
        const revealed = Math.floor(frame / 2);
        if (revealed >= total) { setOut(text); return; }
        let s = "";
        for (let i = 0; i < total; i += 1) {
          const ch = text[i];
          s += ch === " " ? " " : (i < revealed ? ch : SCRAMBLE_GLYPHS[(Math.random() * SCRAMBLE_GLYPHS.length) | 0]);
        }
        setOut(s);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, reduced, text, speed]);
  return <span ref={ref} className={className}>{out}</span>;
}

// Terminal boot lines that type themselves out, then settle on "ready".
export function BootSequence({ lines, className }: { lines: string[]; className?: string }) {
  const reduced = useReducedMotion();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (reduced) { setCount(lines.length); return; }
    setCount(0);
    let i = 0;
    let timer = 0;
    const step = () => {
      i += 1; setCount(i);
      if (i < lines.length) timer = window.setTimeout(step, 360 + Math.random() * 260);
    };
    timer = window.setTimeout(step, 280);
    return () => window.clearTimeout(timer);
  }, [lines, reduced]);
  const done = count >= lines.length;
  return (
    <div className={cn("font-mono text-xs", className)}>
      {lines.slice(0, count).map((l, idx) => (
        <div key={idx} className="flex animate-rise items-center gap-2">
          <span className="text-primary">$</span>
          <span className="text-muted-foreground">{l}</span>
        </div>
      ))}
      {done ? (
        <div className="mt-1 flex items-center gap-2 text-success">
          <span>✓</span><span className="caret">ready</span>
        </div>
      ) : (
        <span className="caret text-muted-foreground" />
      )}
    </div>
  );
}

// Animated score meter that fills to `value`% when scrolled into view.
export function ScoreBar({ label, value, tone = "primary", className }: { label: string; value: number; tone?: "primary" | "success" | "signal"; className?: string }) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const varName = tone === "success" ? "--success" : tone === "signal" ? "--signal" : "--primary";
  const textColor = tone === "success" ? "text-success" : tone === "signal" ? "text-signal" : "text-primary";
  return (
    <div ref={ref} className={cn("w-full", className)}>
      <div className="flex items-center justify-between">
        <span className="mono-label text-muted-foreground">{label}</span>
        <span className={cn("font-mono text-xs font-semibold tabular", textColor)}>{pct}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-[2px] border border-[var(--brutal-line)] bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)]">
        <div className="scorebar__fill h-full" style={{ width: inView ? `${pct}%` : "0%", background: `var(${varName})` }} />
      </div>
    </div>
  );
}

// On-brand loading block: a hard-edged pulsing tile (no gradient shimmer).
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skel", className)} />;
}

// Tracks which of N elements is nearest the viewport centre (for sticky steps).
export function useActiveIndex(count: number) {
  const refs = useRef<Array<HTMLElement | null>>([]);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let raf = 0;
    const compute = () => {
      raf = 0;
      const mid = window.innerHeight * 0.45;
      let best = 0, bd = Infinity;
      refs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bd) { bd = d; best = i; }
      });
      setActive((p) => (p === best ? p : best));
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(compute); };
    compute();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on); window.removeEventListener("resize", on); if (raf) cancelAnimationFrame(raf); };
  }, [count]);
  const setRefs = useMemo(
    () => Array.from({ length: count }, (_, i) => (el: HTMLElement | null) => { refs.current[i] = el; }),
    [count],
  );
  return { active, setRefs };
}

// Pointer-tracking helper for the .spotlight hover glow.
export function spotlightMove(e: ReactMouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}

function getInitialTheme(): "dark" | "light" {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem("sf-theme");
  return stored === "light" ? "light" : "dark";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">(getInitialTheme());
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("sf-theme", theme);
  }, [theme]);
  function toggle() {
    const root = document.documentElement;
    root.classList.add("theme-anim");
    window.setTimeout(() => root.classList.remove("theme-anim"), 420);
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      className="rounded-[3px] border border-[var(--brutal-line)]"
      onClick={toggle}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-grotesk text-2xl font-extrabold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function OriginBadge({ origin }: { origin: "live" | "demo" }) {
  return origin === "demo" ? (
    <Badge variant="warning" className="rounded-[3px] font-mono uppercase" title="Fictional sample data — not fetched from the web">
      Demo data
    </Badge>
  ) : (
    <Badge variant="success" className="rounded-[3px] font-mono uppercase" title="Sourced from live web discovery">
      Live
    </Badge>
  );
}

export function ScorePill({ label, value }: { label: string; value: number }) {
  const tone = value >= 75 ? "text-success" : value >= 50 ? "text-amber-500" : "text-muted-foreground";
  return (
    <div className="flex flex-col">
      <span className="mono-label text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-lg font-semibold tabular", tone)}>{value}</span>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
      aria-label="Loading"
    />
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="brutal-flat grid place-items-center p-12 text-center">
      <h3 className="font-grotesk text-lg font-bold">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
