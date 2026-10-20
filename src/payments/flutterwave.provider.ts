import { timingSafeEqual } from "crypto";
import { ChargeStatus, PaymentProvider, VerifiedCharge, WebhookHeaders } from "./payment.provider";

/** The few Flutterwave v3 endpoints we call. A real HTTP client and an in-memory fake both implement it. */
export interface FlutterwaveApi {
  request<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
}

export class HttpFlutterwaveApi implements FlutterwaveApi {
  constructor(private readonly secret: string, private readonly baseUrl = "https://api.flutterwave.com") {}
  async request<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
    if (!res.ok || json.status !== "success") throw new Error(`Flutterwave ${method} ${path} failed (${res.status}): ${json.message ?? "no message"}`);
    return json as T;
  }
}

/** Flutterwave works in major units (naira, cedis); our billing code works in minor units (kobo, pesewas). */
const toMajor = (minor: number) => Math.round(minor) / 100;
const toMinor = (major: unknown) => Math.round(Number(major ?? 0) * 100);

/** Tokenised charges need the card's country. */
const COUNTRY: Record<string, string> = { NGN: "NG", GHS: "GH", KES: "KE", ZAR: "ZA", UGX: "UG", TZS: "TZ", USD: "US", GBP: "GB", EUR: "DE" };

const mapStatus = (s: string | undefined): ChargeStatus => {
  const v = (s ?? "").toLowerCase();
  return v === "successful" || v === "success" ? "success" : v === "failed" || v === "cancelled" || v === "reversed" ? "failed" : "pending";
};
const toCharge = (d: any): VerifiedCharge => ({
  status: mapStatus(d?.status),
  amount: toMinor(d?.amount),
  currency: String(d?.currency ?? ""),
  ...(d?.card?.token ? { authorizationCode: String(d.card.token) } : {}),
  ...(d?.customer?.id ? { customerCode: String(d.customer.id) } : {}),
});

export class FlutterwaveProvider implements PaymentProvider {
  readonly name = "flutterwave";
  /** `secretHash` is the value set under Settings → Webhooks; Flutterwave sends it back in the `verif-hash` header. */
  constructor(readonly api: FlutterwaveApi, private readonly secretHash: string) {}

  async initialize(i: Parameters<PaymentProvider["initialize"]>[0]) {
    const r = await this.api.request("POST", "/v3/payments", {
      tx_ref: i.reference, amount: toMajor(i.amount), currency: i.currency, redirect_url: i.callbackUrl,
      customer: { email: i.email }, meta: i.metadata, customizations: { title: "Retailr subscription" },
    });
    return { authorizationUrl: String(r.data.link) };
  }
  async verify(reference: string) {
    return toCharge((await this.api.request("GET", `/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`)).data);
  }
  async chargeAuthorization(i: Parameters<PaymentProvider["chargeAuthorization"]>[0]) {
    const r = await this.api.request("POST", "/v3/tokenized-charges", {
      token: i.authorizationCode, currency: i.currency, country: COUNTRY[i.currency] ?? "NG", amount: toMajor(i.amount), email: i.email, tx_ref: i.reference,
    });
    // An immediate answer can be "pending" (e.g. the bank wants 3-D Secure); the job that resolves stale payments checks again later.
    const c = toCharge(r.data);
    return c.currency ? c : { ...c, currency: i.currency };
  }
  /** Flutterwave has no body signature: it echoes the secret hash you configured in the `verif-hash` header. */
  verifyWebhook(_raw: Buffer, headers: WebhookHeaders) {
    const h = headers["verif-hash"];
    const got = Buffer.from(typeof h === "string" ? h : "");
    const want = Buffer.from(this.secretHash);
    return got.length > 0 && got.length === want.length && timingSafeEqual(got, want);
  }
  webhookReference(body: any) {
    return body?.event === "charge.completed" && typeof body?.data?.tx_ref === "string" ? body.data.tx_ref : null;
  }
}

/** An in-memory stand-in for Flutterwave (PAYMENTS_DRIVER includes `fake-flutterwave`). Never allowed in production. */
export class FakeFlutterwaveApi implements FlutterwaveApi {
  /** Amounts here are in major units, exactly as Flutterwave reports them. */
  readonly transactions = new Map<string, { amount: number; currency: string; email: string; status: string; token?: string }>();
  nextCharge: "successful" | "failed" | "pending" = "successful";
  failInitialize = false;
  private n = 0;

  complete(reference: string, outcome: "successful" | "failed" = "successful") {
    const t = this.transactions.get(reference);
    if (!t) throw new Error(`unknown reference ${reference}`);
    t.status = outcome;
    if (outcome === "successful") t.token = `flw-t1nf-${++this.n}`;
  }
  async request<T = any>(method: "GET" | "POST", path: string, body?: any): Promise<T> {
    if (method === "POST" && path === "/v3/payments") {
      if (this.failInitialize) throw new Error("fake flutterwave down");
      this.transactions.set(body.tx_ref, { amount: body.amount, currency: body.currency, email: body.customer.email, status: "pending" });
      return { status: "success", data: { link: `https://checkout.fake-flw/${body.tx_ref}` } } as T;
    }
    if (method === "GET" && path.startsWith("/v3/transactions/verify_by_reference?tx_ref=")) {
      const ref = decodeURIComponent(path.split("tx_ref=")[1]);
      const t = this.transactions.get(ref);
      if (!t || t.status === "pending") throw new Error("No transaction was found for this reference");
      return { status: "success", data: { status: t.status, amount: t.amount, currency: t.currency, tx_ref: ref, card: t.token ? { token: t.token } : undefined, customer: { id: 4242, email: t.email } } } as T;
    }
    if (method === "POST" && path === "/v3/tokenized-charges") {
      const status = this.nextCharge;
      this.transactions.set(body.tx_ref, { amount: body.amount, currency: body.currency, email: body.email, status, token: body.token });
      return { status: "success", data: { status, amount: body.amount, currency: body.currency, tx_ref: body.tx_ref, customer: { id: 4242, email: body.email } } } as T;
    }
    throw new Error(`fake flutterwave: unhandled ${method} ${path}`);
  }
}
