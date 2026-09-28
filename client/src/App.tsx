import { useState } from "react";
import { Router, Route, Switch, Redirect } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { trpc, createTRPCClient, queryClient } from "@/lib/api";
import { AuthProvider, useAuth } from "@/lib/auth";
import { AppToaster } from "@/components/common";
import { Spinner } from "@/components/common";
import Landing from "@/pages/Landing";
import Login from "@/pages/Login";
import Legal from "@/pages/Legal";
import AppShell from "@/pages/AppShell";

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner className="h-6 w-6 text-primary" />
      </div>
    );
  }
  if (!user) return <Redirect to="/login" />;
  return <>{children}</>;
}

function Routes() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      {/* Public, and outside /app: a data subject must be able to reach the policy
          without an account, and a prospect who received an email has neither. */}
      <Route path="/privacy" component={() => <Legal slug="privacy" />} />
      <Route path="/terms" component={() => <Legal slug="terms" />} />
      <Route path="/login" component={Login} />
      <Route path="/app/*">
        <Protected>
          <AppShell />
        </Protected>
      </Route>
      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}

export function App() {
  const [trpcClient] = useState(() => createTRPCClient());
  return (
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <AuthProvider>
          <Router>
            <Routes />
          </Router>
          <AppToaster />
        </AuthProvider>
      </trpc.Provider>
    </QueryClientProvider>
  );
}
