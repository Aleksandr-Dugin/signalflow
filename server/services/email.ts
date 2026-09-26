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

function buildTextBody(email: OutboundEmail): string {
  if (!email.unsubscribeUrl) return email.text;
  return `${email.text}\n\n—\nNo longer want to hear from us? Reply "unsubscribe" or use: ${email.unsubscribeUrl}`;
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
      subject: email.subject,
      text: buildTextBody(email),
      html: email.html,
      headers: email.referenceId ? { "X-SignalFlow-Ref": email.referenceId } : undefined,
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
