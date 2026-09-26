import { Route, Switch, Link, useLocation } from "wouter";
import { LayoutDashboard, UserCog, Megaphone, Trophy, CreditCard, Settings as SettingsIcon, ShieldCheck, LogOut, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Logo, ThemeToggle, Spinner, ScrollProgress } from "@/components/common";
import Overview from "@/pages/app/Overview";
import Onboarding from "@/pages/app/Onboarding";
import Campaigns from "@/pages/app/Campaigns";
import CampaignDetail from "@/pages/app/CampaignDetail";
import ProspectDetail from "@/pages/app/ProspectDetail";
import Opportunities from "@/pages/app/Opportunities";
import BillingPage from "@/pages/app/BillingPage";
import Settings from "@/pages/app/Settings";
import Admin from "@/pages/app/Admin";

const nav = [
  { href: "/app", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/app/onboarding", label: "Setup", icon: UserCog },
  { href: "/app/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/app/opportunities", label: "Opportunities", icon: Trophy },
  { href: "/app/billing", label: "Billing", icon: CreditCard },
  { href: "/app/settings", label: "Settings", icon: SettingsIcon },
];

const adminNav = { href: "/app/admin", label: "Admin", icon: ShieldCheck };

function NavLink({ href, label, icon: Icon, exact }: (typeof nav)[number]) {
  const [location] = useLocation();
  const active = exact ? location === href : location.startsWith(href);
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-[3px] px-3 py-2 font-mono text-xs uppercase tracking-wider transition-colors",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </Link>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const me = trpc.workspace.me.useQuery();
  const [loc, navigate] = useLocation();

  if (me.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner className="h-6 w-6 text-primary" />
      </div>
    );
  }

  const ent = me.data?.entitlements;
  const isAdmin = me.data?.user?.role === "admin";
  const items = isAdmin ? [...nav, adminNav] : nav;

  async function onLogout() {
    await logout();
    toast.success("Signed out");
    navigate("/");
  }

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[240px_1fr]">
      <ScrollProgress />
      <aside className="hidden flex-col border-r border-[var(--brutal-line)] bg-card/40 p-4 md:flex">
        <div className="px-2 py-3">
          <Logo />
        </div>
        <nav className="mt-2 flex flex-col gap-1">
          {items.map((item) => (
            <NavLink key={item.href} {...item} />
          ))}
          <Link href="/" className="flex items-center gap-3 rounded-[3px] px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted-foreground hover:bg-accent hover:text-foreground">
            <ExternalLink className="h-4 w-4" /> Public site
          </Link>
        </nav>
        <div className="mt-auto space-y-2 rounded-[3px] border border-[var(--brutal-line)] bg-card p-3 font-mono text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Plan</span>
            <Badge variant="default" className="rounded-[3px] font-mono uppercase">{ent?.planId ?? "free"}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">AI runs</span>
            <span>{ent?.usage.aiRunsThisMonth ?? 0} / {ent?.limits.aiRunsPerMonth ?? 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Outreach</span>
            <span>{ent?.usage.outreachThisMonth ?? 0} / {ent?.limits.outreachPerMonth ?? 0}</span>
          </div>
        </div>
      </aside>

      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between border-b border-[var(--brutal-line)] bg-card/30 px-6 py-3">
          <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{user?.email}</span>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={onLogout} className="rounded-[3px] border border-[var(--brutal-line)] font-mono text-xs uppercase tracking-wider">
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 p-6">
          <div key={loc} className="route-enter">
          <Switch>
            <Route path="/" component={Overview} />
            <Route path="/onboarding" component={Onboarding} />
            <Route path="/campaigns" component={Campaigns} />
            <Route path="/campaigns/:id">{(p) => <CampaignDetail id={p.id} />}</Route>
            <Route path="/prospects/:id">{(p) => <ProspectDetail id={p.id} />}</Route>
            <Route path="/opportunities" component={Opportunities} />
            <Route path="/billing" component={BillingPage} />
            <Route path="/settings" component={Settings} />
            <Route path="/admin" component={Admin} />
            <Route component={Overview} />
          </Switch>
          </div>
        </main>
      </div>
    </div>
  );
}
