/** What the billing code needs from a payment provider. Paystack and Flutterwave are the adapters; Stripe would be another. */
export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");
/** Every enabled provider, default first. */
export const PAYMENT_PROVIDERS = Symbol("PAYMENT_PROVIDERS");

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export type ChargeStatus = "success" | "failed" | "pending";

export interface VerifiedCharge {
  status: ChargeStatus;
  /** In minor units (kobo, pesewas, cents). */
  amount: number;
  currency: string;
  /** Reusable card token, present on a successful card payment that the customer allowed to be reused. */
  authorizationCode?: string;
  customerCode?: string;
}

export interface PaymentProvider {
  readonly name: string;
  /** Starts a hosted checkout; the customer is sent to `authorizationUrl` and back to `callbackUrl`. */
  initialize(i: { reference: string; email: string; amount: number; currency: string; callbackUrl: string; metadata?: Record<string, unknown> }): Promise<{ authorizationUrl: string }>;
  /** Asks the provider what really happened to a transaction. Never trust a webhook body on its own; confirm with this. */
  verify(reference: string): Promise<VerifiedCharge>;
  /** Charges a saved card without the customer present (renewals). */
  chargeAuthorization(i: { authorizationCode: string; email: string; amount: number; currency: string; reference: string }): Promise<VerifiedCharge>;
  /** True when the webhook really came from the provider. */
  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): boolean;
  /** The transaction reference a webhook is about, or null for events we don't act on. */
  webhookReference(body: unknown): string | null;
}
