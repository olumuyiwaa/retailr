import { AppError } from "./errors";

export interface DeliveryZone {
  id: string;
  /** "local" zones are areas (a state, a neighbourhood); "international" zones are countries. */
  kind: "local" | "international";
  name: string;
  fee: number;
  note?: string;
}
export interface PickupConfig { enabled: boolean; address?: string; hours?: string; instructions?: string }
export interface DeliveryConfig {
  pickup: PickupConfig;
  zones: DeliveryZone[];
  /** Orders at or above this (after discounts) ship free. Paid plans only. */
  freeShippingThreshold: number | null;
  /** Shown at checkout, e.g. "Rates cover up to 2kg". */
  note?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Normalises whatever is stored (or null) into a full config. Never throws. */
export function readDelivery(raw: unknown): DeliveryConfig {
  const r = (raw ?? {}) as Record<string, any>;
  const p = (r.pickup ?? {}) as Record<string, unknown>;
  const zones: DeliveryZone[] = Array.isArray(r.zones)
    ? r.zones.filter((z: any) => z && str(z.id) && str(z.name) && Number.isFinite(Number(z.fee))).map((z: any) => ({
        id: str(z.id), kind: z.kind === "international" ? "international" : "local", name: str(z.name), fee: Number(z.fee),
        ...(str(z.note) ? { note: str(z.note) } : {}),
      }))
    : [];
  const t = Number(r.freeShippingThreshold);
  return {
    pickup: { enabled: p.enabled === true && !!str(p.address), ...(str(p.address) ? { address: str(p.address) } : {}), ...(str(p.hours) ? { hours: str(p.hours) } : {}), ...(str(p.instructions) ? { instructions: str(p.instructions) } : {}) },
    zones,
    freeShippingThreshold: r.freeShippingThreshold != null && Number.isFinite(t) && t > 0 ? t : null,
    ...(str(r.note) ? { note: str(r.note) } : {}),
  };
}

/** Free shipping is a paid-plan feature: the stored threshold is ignored on a free plan. */
export const paidPlan = (plan?: { priceMonthly?: unknown } | null) => !!plan && Number(plan.priceMonthly) > 0;

/** What shoppers are shown: the saved config with the plan's rules applied. */
export function publicDelivery(raw: unknown, plan?: { priceMonthly?: unknown } | null): DeliveryConfig & { configured: boolean } {
  const d = readDelivery(raw);
  if (!paidPlan(plan)) d.freeShippingThreshold = null;
  return { ...d, configured: d.pickup.enabled || d.zones.length > 0 };
}

export interface DeliveryChoice { method?: "delivery" | "pickup"; zoneId?: string }
export interface DeliveryResult { method: "delivery" | "pickup"; zone: string | null; fee: number }

/**
 * The shipping charge for an order, worked out on the server so the shopper's browser can't set it.
 * A business with no delivery options set up keeps the old behaviour: free delivery, address required.
 */
export function priceDelivery(raw: unknown, plan: { priceMonthly?: unknown } | null, choice: DeliveryChoice, netSubtotal: number): DeliveryResult {
  const d = publicDelivery(raw, plan);
  if (!d.configured) return { method: "delivery", zone: null, fee: 0 };
  const method = choice.method ?? (d.zones.length ? "delivery" : "pickup");
  if (method === "pickup") {
    if (!d.pickup.enabled) throw AppError.badRequest("This store doesn't offer pickup.", "PICKUP_UNAVAILABLE");
    return { method, zone: "Pickup", fee: 0 };
  }
  const zone = d.zones.find((z) => z.id === choice.zoneId);
  if (!zone) throw AppError.badRequest("Choose where we should deliver to.", "DELIVERY_ZONE_REQUIRED");
  const free = d.freeShippingThreshold !== null && netSubtotal >= d.freeShippingThreshold;
  return { method, zone: zone.name, fee: free ? 0 : zone.fee };
}
