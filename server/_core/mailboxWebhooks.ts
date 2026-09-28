// OAuth callback for "connect your own mailbox". Kept beside espWebhooks.ts because
// it is the same shape: a provider redirects here, we verify a signed `state`, do the
// code->token exchange server-side, encrypt the tokens, and store the mailbox. The
// browser never sees a token and cannot name the workspace it is linking into — the
// state is what binds consent to one workspace+provider (see mailOAuth.parseState).
import type { Express } from "express";
import { env } from "./env";
import {
  exchangeCodeForTokens,
  fetchMailboxEmail,
  MailboxOAuthError,
  parseState,
  saveMailboxTokens,
} from "../services/mailOAuth";

function redirect(res: import("express").Response, result: string): void {
  res.redirect(`${env.publicUrl.replace(/\/$/, "")}/app/settings?mailbox=${result}`);
}

export function mountMailboxOAuth(app: Express): void {
  app.get("/api/mailbox/oauth/callback", async (req, res) => {
    const state = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const linked = parseState(state);
    if (!linked) {
      // A missing/bad state is the CSRF/link-hijack guard firing; do not proceed.
      return redirect(res, "error_state");
    }
    if (!code) return redirect(res, "error_no_code");

    try {
      const tokens = await exchangeCodeForTokens(linked.provider, code);
      // Prefer whatever the token endpoint echoed, otherwise ask the provider who
      // this account is. No address => nothing sane to key the mailbox by.
      const email = tokens.email || (await fetchMailboxEmail(linked.provider, tokens.accessToken));
      if (!email) return redirect(res, "error_no_email");
      await saveMailboxTokens({
        workspaceId: linked.workspaceId,
        provider: linked.provider,
        email,
        tokens,
      });
      // saveMailboxTokens stores status 'gated' unless MAILBOX_DELIVERY_VERIFIED, so
      // the message below is honest either way: linking succeeded, sending is a
      // separate gate the operator controls.
      return redirect(res, env.mailboxDeliveryVerified ? "connected" : "linked_gated");
    } catch (err) {
      console.error("[mailbox-oauth] callback failed:", err);
      const code = err instanceof MailboxOAuthError ? err.code : "error";
      return redirect(res, `failed_${code}`);
    }
  });
}
