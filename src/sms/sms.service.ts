import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface Sms { to: string; text: string }

/** International dialling codes for the countries we sell in. */
const DIAL: Record<string, string> = { nigeria: "234", ghana: "233", kenya: "254" };

/**
 * Turns a number as a customer would write it into the international digits SMS providers want (no "+"), or null if it can't be one.
 * "0801 234 5678" in Nigeria → "2348012345678"; "+233 24 123 4567" stays as it is.
 */
export function normalizePhone(raw: string, country: string): string | null {
  let d = raw.replace(/[^\d+]/g, "");
  const plus = d.startsWith("+");
  d = d.replace(/\D/g, "");
  if (!plus && d.startsWith("00")) d = d.slice(2);
  else if (!plus && d.startsWith("0")) {
    const code = DIAL[country.trim().toLowerCase()];
    if (!code) return null; // a local number in a country we don't know the code for
    d = code + d.slice(1);
  }
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/**
 * Sends text messages. SMS_DRIVER=log only logs them (development and tests, which read `outbox`); SMS_DRIVER=termii sends through Termii.
 * `send` throws when the provider refuses, so the caller can count the failure.
 */
@Injectable()
export class SmsService {
  private readonly log = new Logger("Sms");
  readonly outbox: Sms[] = [];
  /** The HTTP client; tests replace it. */
  http: typeof fetch = (...a) => fetch(...a);
  private readonly driver: string;

  constructor(private readonly config: ConfigService) {
    this.driver = config.get<string>("SMS_DRIVER") ?? "log";
  }

  get enabled() { return this.driver !== "off"; }

  async send(sms: Sms): Promise<void> {
    if (this.driver === "termii") return this.termii(sms);
    this.log.log(`(not sent, SMS_DRIVER=${this.driver}) to=${sms.to} text="${sms.text.slice(0, 60)}"`);
    this.outbox.push(sms);
    if (this.outbox.length > 500) this.outbox.shift();
  }

  private async termii({ to, text }: Sms) {
    const res = await this.http(`${this.config.get<string>("TERMII_BASE_URL") ?? "https://api.ng.termii.com"}/api/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, from: this.config.get<string>("SMS_SENDER") ?? "Retailr", sms: text, type: "plain", channel: this.config.get<string>("TERMII_CHANNEL") ?? "dnd", api_key: this.config.getOrThrow<string>("TERMII_API_KEY") }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { message_id?: string; message?: string };
    // success is an HTTP 2xx that names the message; anything else is a refusal
    if (!res.ok || !json.message_id) throw new Error(`Termii refused the message (${res.status}): ${json.message ?? "no reason given"}`);
  }
}
