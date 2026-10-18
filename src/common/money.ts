/** Rough fixed rates (units of currency per 1 USD), the same ones the frontend uses; swap for a rates feed when real FX matters. */
export const PER_USD: Record<string, number> = { USD: 1, NGN: 1500, GHS: 15, KES: 150 };
export const toUsd = (amount: number, currency: string) => amount / (PER_USD[currency] ?? 1);
