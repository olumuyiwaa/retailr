import { createHmac, timingSafeEqual } from "crypto";
import { ChargeStatus, PaymentProvider, VerifiedCharge, WebhookHeaders } from "./payment.provider";

/** The few Paystack endpoints we call. A real HTTP client and an in-memory fake both implement it. */
export interface PaystackApi {
  request<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
}

export class HttpPaystackApi implements PaystackApi {
  constructor(private readonly secret: string, private readonly baseUrl = "https://api.paystack.co") {}
  async request<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string };
    if (!res.ok || json.status === false) throw new Error(`Paystack ${method} ${path} failed (${res.status}): ${json.message ?? "no message"}`);
    return json as T;
  }
}

const mapStatus = (s: string | undefined): ChargeStatus => (s === "success" ? "success" : s === "failed" || s === "abandoned" || s === "reversed" ? "failed" : "pending");
const toCharge = (d: any): VerifiedCharge => ({
  status: mapStatus(d?.status),
  amount: Number(d?.amount ?? 0),
  currency: String(d?.currency ?? ""),
  ...(d?.authorization?.authorization_code && d.authorization.reusable ? { authorizationCode: String(d.authorization.authorization_code) } : {}),
  ...(d?.customer?.customer_code ? { customerCode: String(d.customer.customer_code) } : {}),
});

export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack";
  constructor(readonly api: PaystackApi, private readonly secret: string) {}

  async initialize(i: Parameters<PaymentProvider["initialize"]>[0]) {
    const r = await this.api.request("POST", "/transaction/initialize", { email: i.email, amount: i.amount, currency: i.currency, reference: i.reference, callback_url: i.callbackUrl, metadata: i.metadata });
    return { authorizationUrl: String(r.data.authorization_url) };
  }
  async verify(reference: string) {
    return toCharge((await this.api.request("GET", `/transaction/verify/${encodeURIComponent(reference)}`)).data);
  }
  async chargeAuthorization(i: Parameters<PaymentProvider["chargeAuthorization"]>[0]) {
    return toCharge((await this.api.request("POST", "/transaction/charge_authorization", { authorization_code: i.authorizationCode, email: i.email, amount: i.amount, currency: i.currency, reference: i.reference })).data);
  }
  /** Paystack signs the raw request body with HMAC-SHA512 using the secret key. */
  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders) {
    const signature = headers["x-paystack-signature"];
    if (typeof signature !== "string" || !signature) return false;
    const want = Buffer.from(createHmac("sha512", this.secret).update(rawBody).digest("hex"));
    const got = Buffer.from(signature);
    return want.length === got.length && timingSafeEqual(want, got);
  }
  webhookReference(body: any) {
    return body?.event === "charge.success" && typeof body?.data?.reference === "string" ? body.data.reference : null;
  }
}

/** An in-memory stand-in for Paystack, for tests and local development (PAYMENTS_DRIVER=fake). Never allowed in production. */
export class FakePaystackApi implements PaystackApi {
  readonly transactions = new Map<string, { amount: number; currency: string; email: string; status: string; authorization?: { authorization_code: string; reusable: boolean } }>();
  /** What the next charge_authorization call returns. */
  nextCharge: "success" | "failed" | "pending" = "success";
  failInitialize = false;
  private n = 0;

  /** Simulates the customer finishing (or abandoning) the hosted checkout. */
  complete(reference: string, outcome: "success" | "failed" = "success", reusable = true) {
    const t = this.transactions.get(reference);
    if (!t) throw new Error(`unknown reference ${reference}`);
    t.status = outcome;
    if (outcome === "success") t.authorization = { authorization_code: `AUTH_${++this.n}`, reusable };
  }
  async request<T = any>(method: "GET" | "POST", path: string, body?: any): Promise<T> {
    if (method === "POST" && path === "/transaction/initialize") {
      if (this.failInitialize) throw new Error("fake provider down");
      this.transactions.set(body.reference, { amount: body.amount, currency: body.currency, email: body.email, status: "pending" });
      return { status: true, data: { authorization_url: `https://checkout.fake/${body.reference}`, reference: body.reference } } as T;
    }
    if (method === "GET" && path.startsWith("/transaction/verify/")) {
      const ref = decodeURIComponent(path.slice("/transaction/verify/".length));
      const t = this.transactions.get(ref);
      if (!t) throw new Error("Transaction reference not found");
      return { status: true, data: { status: t.status, amount: t.amount, currency: t.currency, reference: ref, authorization: t.authorization, customer: { customer_code: "CUS_fake", email: t.email } } } as T;
    }
    if (method === "POST" && path === "/transaction/charge_authorization") {
      const status = this.nextCharge;
      this.transactions.set(body.reference, { amount: body.amount, currency: body.currency, email: body.email, status, authorization: { authorization_code: body.authorization_code, reusable: true } });
      return { status: true, data: { status, amount: body.amount, currency: body.currency, reference: body.reference, authorization: { authorization_code: body.authorization_code, reusable: true } } } as T;
    }
    throw new Error(`fake paystack: unhandled ${method} ${path}`);
  }
}
