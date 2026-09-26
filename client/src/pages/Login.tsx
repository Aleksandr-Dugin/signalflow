import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Github, Mail, ArrowLeft } from "lucide-react";
import { trpc } from "@/lib/api";
import { useAuth, startOAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/input";
import { Logo, ThemeToggle, Spinner, AmbientBackground, BootSequence } from "@/components/common";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="currentColor" d="M21.35 11.1H12v3.83h5.35c-.5 2.4-2.55 3.77-5.35 3.77a6.2 6.2 0 1 1 0-12.4c1.56 0 2.98.57 4.08 1.5l2.85-2.85A10 10 0 1 0 12 22c5.79 0 9.6-4.06 9.6-9.78 0-.36-.03-.7-.08-1.02Z" />
    </svg>
  );
}

export default function Login() {
  const { login, register } = useAuth();
  const providers = trpc.auth.providers.useQuery();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "register") await register(email, password, name);
      else await login(email, password);
      toast.success(mode === "register" ? "Account created" : "Welcome back");
      window.location.href = "/app";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  const oauthEnabled = providers.data;

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-[var(--brutal-line)] bg-card/40 p-12 lg:flex">
        <AmbientBackground />
        <Link href="/"><Logo /></Link>
        <div className="relative max-w-md">
          <div className="mb-6 inline-flex items-center gap-2 rounded-[3px] border border-[var(--brutal-line)] bg-card px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-barpulse" /> autonomous client acquisition
          </div>
          <h1 className="font-grotesk text-4xl font-black leading-[1.02] tracking-tight">
            Your pipeline,<br /><span className="text-primary">offer to opportunity.</span>
          </h1>
          <p className="mt-4 text-muted-foreground">
            Discover real companies, score their buying intent, and let an agent follow up — every claim tied to a
            source, nothing sent without your rules.
          </p>
          <BootSequence
            className="mt-8"
            lines={["signalflow init", "connect discovery engine", "load scoring model", "arm autopilot"]}
          />
        </div>
        <p className="relative font-mono text-xs uppercase tracking-wider text-muted-foreground">© {new Date().getFullYear()} SignalFlow · your data, your keys</p>
      </aside>

      {/* Form panel */}
      <main className="relative flex flex-col bg-background">
        <header className="flex items-center justify-between border-b border-[var(--brutal-line)] px-6 py-4">
          <Link href="/" className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <div className="lg:hidden"><Logo /></div>
          <ThemeToggle />
        </header>
        <div className="flex flex-1 items-center justify-center px-6 py-16">
          <div className="brutal w-full max-w-md">
            <div className="border-b border-[var(--brutal-line)] px-7 py-4">
              <h2 className="font-grotesk text-xl font-black tracking-tight">
                {mode === "login" ? "Sign in" : "Create your account"}
              </h2>
              <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                {mode === "login" ? "email or provider below" : "start free — no credit card"}
              </p>
            </div>
            <div className="p-7">
              <div className="space-y-2.5">
                <Button type="button" variant="outline" className="btn-oauth h-12 w-full rounded-[3px] text-xs" disabled={!oauthEnabled?.google} onClick={() => startOAuth("google")}>
                  <GoogleIcon /> Continue with Google
                </Button>
                <Button type="button" variant="outline" className="btn-oauth h-12 w-full rounded-[3px] text-xs" disabled={!oauthEnabled?.github} onClick={() => startOAuth("github")}>
                  <Github className="h-4 w-4" /> Continue with GitHub
                </Button>
              </div>

              <div className="my-6 flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                <span className="h-px flex-1 bg-[var(--brutal-line)]" /> or with email <span className="h-px flex-1 bg-[var(--brutal-line)]" />
              </div>

              <form onSubmit={onSubmit} className="space-y-4">
                {mode === "register" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="name" className="mono-label text-muted-foreground">Name</Label>
                    <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" required className="rounded-[3px] border-[var(--brutal-line)]" />
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor="email" className="mono-label text-muted-foreground">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required className="rounded-[3px] border-[var(--brutal-line)]" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="password" className="mono-label text-muted-foreground">Password</Label>
                  <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={8} className="rounded-[3px] border-[var(--brutal-line)]" />
                </div>
                <Button type="submit" className="btn-acid h-11 w-full rounded-[3px] text-sm" disabled={busy}>
                  {busy ? <Spinner /> : <Mail className="h-4 w-4" />}
                  {mode === "login" ? "Sign in" : "Create account"}
                </Button>
              </form>

              <p className="mt-6 text-center text-sm text-muted-foreground">
                {mode === "login" ? "New here? " : "Already have an account? "}
                <button type="button" className="font-bold text-primary hover:underline" onClick={() => setMode(mode === "login" ? "register" : "login")}>
                  {mode === "login" ? "Create an account" : "Sign in"}
                </button>
              </p>
              {oauthEnabled && !oauthEnabled.google && !oauthEnabled.github && (
                <p className="mt-4 text-center font-mono text-[11px] leading-relaxed text-muted-foreground">
                  OAuth isn't configured on this server. Set GOOGLE_/GITHUB_ credentials to enable it.
                </p>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
