import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../_core/env";
import { getUsableMailbox, type UsableMailbox } from "./mailOAuth";

export interface OutboundEmail {
  toName: string;
  toEmail: string;
  subject: string;
  text: string;
  html?: string;
  // Reference id used to correlate replies/events back to the outreach message.
  referenceId?: string;
  unsubscribeUrl?: string;
}

export interface SendResult {
  provider: "smtp" | "mock" | "mailbox";
  providerMessageId: string;
  delivered: boolean;
  // Mock never actually sends; callers must surface this to the user (audit:
  // do not pretend an email went out when it did not).
  simulated: boolean;
}

export interface EmailProvider {
  readonly name: "smtp" | "mock" | "mailbox";
  send(email: OutboundEmail): Promise<SendResult>;
}

/**
 * The compliance block appended to every outbound message.
 *
 * Three lines, each answering a different legal requirement rather than one
 * generic disclaimer: a way to stop (unsubscribe by link *and* by reply, because a
 * reply is the form a human can always perform), who is sending and where they can
 * be reached physically (CAN-SPAM's valid postal address), and why this person is
 * being written to at all (the privacy policy, which is where the claimed lawful
 * basis and the erasure route live).
 *
 * The postal address is only printed when configured. A footer that promised an
 * address nobody set would be a false statement inside a message whose whole purpose
 * is legal identification, so the boot warning in `_core/env.ts` is what nags instead.
 */
export function buildFooter(email: OutboundEmail): string {
  const lines: string[] = [];
  if (email.unsubscribeUrl) {
    lines.push(`No longer want to hear from us? Reply "unsubscribe" or use: ${email.unsubscribeUrl}`);
  }
  if (env.senderPostalAddress) lines.push(env.senderPostalAddress.trim());
  lines.push(`${env.publicUrl.replace(/\/$/, "")}/privacy`);
  return lines.join("\n");
}

function buildTextBody(email: OutboundEmail): string {
  const footer = buildFooter(email);
  if (!footer) return email.text;
  return `${email.text}\n\n—\n${footer}`;
}

/**
 * RFC 8058 unsubscribe headers. Gmail and Yahoo require a one-click
 * `List-Unsubscribe` on bulk mail as a deliverability precondition; a plain text
 * footer link alone is not enough. Both URIs are offered so clients that cannot
 * POST still have the mailto route.
 */
export function buildUnsubscribeHeaders(
  email: OutboundEmail,
): Record<string, string> | undefined {
  if (!email.unsubscribeUrl) return undefined;
  const uris = [`<${email.unsubscribeUrl}>`];
  if (env.smtpReplyTo) uris.push(`<mailto:${env.smtpReplyTo}?subject=unsubscribe>`);
  return {
    "List-Unsubscribe": uris.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp" as const;
  private transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      auth: env.smtpUser ? { user: env.smtpUser, pass: env.smtpPassword } : undefined,
    });
  }

  async send(email: OutboundEmail): Promise<SendResult> {
    const info = await this.transporter.sendMail({
      from: env.smtpFrom,
      to: `"${email.toName}" <${email.toEmail}>`,
      replyTo: env.smtpReplyTo || undefined,
      subject: email.subject,
      text: buildTextBody(email),
      html: email.html,
      headers: {
        ...(email.referenceId ? { "X-SignalFlow-Ref": email.referenceId } : {}),
        ...buildUnsubscribeHeaders(email),
      },
    });
    return {
      provider: "smtp",
      providerMessageId: String(info.messageId ?? "").replace(/[<>]/g, ""),
      delivered: true,
      simulated: false,
    };
  }
}

class MockEmailProvider implements EmailProvider {
  readonly name = "mock" as const;

  async send(email: OutboundEmail): Promise<SendResult> {
    // eslint-disable-next-line no-console
    console.log(
      `[email:mock] Would send to ${email.toEmail} — subject: "${email.subject}". Configure SMTP_* to send real email.`,
    );
    return {
      provider: "mock",
      providerMessageId: `mock-${Date.now()}`,
      delivered: false,
      simulated: true,
    };
  }
}

export function smtpConfigured(): boolean {
  return Boolean(env.smtpHost);
}

// ── Sending from a user's own linked mailbox ────────────────────────────────
function encodeMimeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects; ASCII passes through.
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatAddr(name: string | null | undefined, addr: string): string {
  const display = name ? `"${name.replace(/["]/g, "")}"` : "";
  return display ? `${display} <${addr}>` : addr;
}

/**
 * Assemble a full RFC 2822 message so Gmail can send it as an opaque blob. This is
 * where the compliance footer and the RFC 8058 unsubscribe headers get folded into
 * the message itself — the same guarantees the SMTP path adds, because a message
 * sent from a personal mailbox still has to be unsubscribable and identified.
 */
export function buildRfc2822(email: OutboundEmail, mailbox: UsableMailbox): string {
  const headers: string[] = [`From: ${formatAddr(mailbox.fromName, mailbox.email)}`];
  const replyTo = mailbox.replyTo || env.smtpReplyTo;
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  headers.push(`To: ${formatAddr(email.toName, email.toEmail)}`);
  headers.push(`Subject: ${encodeMimeHeader(email.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  if (email.referenceId) headers.push(`X-SignalFlow-Ref: ${email.referenceId}`);
  const unsub = buildUnsubscribeHeaders(email);
  if (unsub) {
    headers.push(`List-Unsubscribe: ${unsub["List-Unsubscribe"]}`);
    headers.push(`List-Unsubscribe-Post: ${unsub["List-Unsubscribe-Post"]}`);
  }
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 7bit");
  return `${headers.join("\r\n")}\r\n\r\n${buildTextBody(email)}`;
}

class MailboxEmailProvider implements EmailProvider {
  readonly name = "mailbox" as const;
  constructor(private readonly mailbox: UsableMailbox) {}

  async send(email: OutboundEmail): Promise<SendResult> {
    return this.mailbox.provider === "gmail"
      ? this.sendGmail(email)
      : this.sendGraph(email);
  }

  private async sendGmail(email: OutboundEmail): Promise<SendResult> {
    const raw = Buffer.from(buildRfc2822(email, this.mailbox), "utf8").toString("base64url");
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.mailbox.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      throw new Error(`Gmail send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const json: any = await res.json();
    return {
      provider: "mailbox",
      providerMessageId: String(json?.id ?? `gmail-${Date.now()}`),
      delivered: true,
      simulated: false,
    };
  }

  private async sendGraph(email: OutboundEmail): Promise<SendResult> {
    const headers: { name: string; value: string }[] = [];
    if (email.referenceId) headers.push({ name: "X-SignalFlow-Ref", value: email.referenceId });
    const unsub = buildUnsubscribeHeaders(email);
    if (unsub) {
      headers.push({ name: "List-Unsubscribe", value: unsub["List-Unsubscribe"] });
      headers.push({ name: "List-Unsubscribe-Post", value: unsub["List-Unsubscribe-Post"] });
    }
    const replyTo = this.mailbox.replyTo || env.smtpReplyTo;
    const body = {
      message: {
        subject: email.subject,
        body: { contentType: "text", content: buildTextBody(email) },
        toRecipients: [{ emailAddress: { address: email.toEmail, name: email.toName } }],
        ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
        ...(headers.length ? { internetMessageHeaders: headers } : {}),
      },
      saveToSentItems: true,
    };
    const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.mailbox.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Microsoft send failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    // Graph's sendMail returns 202 with no id; the reference is our own correlation
    // handle, so use it rather than invent a provider id we were never given.
    return {
      provider: "mailbox",
      providerMessageId: email.referenceId ? `graph-${email.referenceId}` : `graph-${Date.now()}`,
      delivered: true,
      simulated: false,
    };
  }
}

/**
 * The provider a send should use. A workspace with a connected mailbox wins (its own
 * address is what the user chose to send from); a gated/linked mailbox throws rather
 * than silently falling back to the shared server. With no mailbox, this is the
 * historical global behaviour: real SMTP when configured, honest mock otherwise.
 */
export async function resolveEmailProvider(workspaceId?: string | null): Promise<EmailProvider> {
  if (workspaceId) {
    const mailbox = await getUsableMailbox(workspaceId);
    if (mailbox) return new MailboxEmailProvider(mailbox);
  }
  return getEmailProvider();
}

let _provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (smtpConfigured()) {
    _provider = _provider instanceof SmtpEmailProvider ? _provider : new SmtpEmailProvider();
    return _provider;
  }
  return new MockEmailProvider();
}
