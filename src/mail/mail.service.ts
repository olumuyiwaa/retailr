import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, Transporter } from "nodemailer";

export interface Mail { to: string; subject: string; text: string; html?: string }

/**
 * Sends email. MAIL_DRIVER=log (default) only logs, and in tests keeps what was "sent" in `outbox`;
 * MAIL_DRIVER=smtp sends through SMTP_URL (any provider: SES, Resend, Postmark, Mailgun... all speak SMTP).
 */
@Injectable()
export class MailService {
  private readonly log = new Logger("Mail");
  private readonly smtp?: Transporter;
  private readonly from: string;
  /** Test helper: the last mails "sent" by the log driver. */
  readonly outbox: Mail[] = [];

  constructor(private readonly config: ConfigService) {
    this.from = config.get("MAIL_FROM") ?? "Retailr <noreply@retailr.com>";
    if ((config.get("MAIL_DRIVER") ?? "log") === "smtp") this.smtp = createTransport(config.getOrThrow<string>("SMTP_URL"));
  }

  /** Throws when delivery fails, so callers decide whether that matters (a receipt does, a courtesy mail doesn't). */
  async send(mail: Mail): Promise<void> {
    if (!this.smtp) {
      this.log.log(`(not sent, MAIL_DRIVER=log) to=${mail.to} subject="${mail.subject}"`);
      // local development only: show the links in the mail (invite, reset...) so they can be opened without an inbox
      if (this.config.get("NODE_ENV") === "development") for (const l of mail.text.match(/https?:\/\/\S+/g) ?? []) this.log.log(`  link: ${l}`);
      this.outbox.push(mail);
      if (this.outbox.length > 500) this.outbox.shift();
      return;
    }
    await this.smtp.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  }

  /** For fire-and-forget mails: never throws, logs the failure. */
  async trySend(mail: Mail): Promise<boolean> {
    try { await this.send(mail); return true; }
    catch (e) { this.log.warn(`Could not send "${mail.subject}" to ${mail.to}: ${(e as Error).message}`); return false; }
  }

  get appUrl() { return (this.config.get<string>("APP_PUBLIC_URL") ?? "http://localhost:3000").replace(/\/$/, ""); }
}
