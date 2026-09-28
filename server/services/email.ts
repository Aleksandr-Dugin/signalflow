import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../_core/env";

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
  provider: "smtp" | "mock";
  providerMessageId: string;
  delivered: boolean;
  // Mock never actually sends; callers must surface this to the user (audit:
  // do not pretend an email went out when it did not).
  simulated: boolean;
}

export interface EmailProvider {
  readonly name: "smtp" | "mock";
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

let _provider: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (smtpConfigured()) {
    _provider = _provider instanceof SmtpEmailProvider ? _provider : new SmtpEmailProvider();
    return _provider;
  }
  return new MockEmailProvider();
}
