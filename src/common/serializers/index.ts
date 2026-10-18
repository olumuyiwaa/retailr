// The one place database rows become the JSON the frontend's types describe
// (lower-case enums, Decimal -> number, createdAt -> joinedAt / startedAt, ...).
import type { Plan, PlanCoupon, Subscription, User } from "@prisma/client";

/** `OUT_OF_STOCK` -> `"out_of_stock"` */
export const lower = <T extends string>(v: T) => v.toLowerCase() as Lowercase<T>;
type Decimalish = { toNumber(): number } | number | string;
export const num = (d: Decimalish): number => (typeof d === "number" ? d : typeof d === "string" ? Number(d) : d.toNumber());
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

export const toAuthUser = (u: Pick<User, "id" | "name" | "email" | "role" | "businessId">) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: lower(u.role),
  ...(u.businessId ? { businessId: u.businessId } : {}),
});

export const toPlan = (p: Plan) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  priceMonthly: num(p.priceMonthly),
  priceYearly: num(p.priceYearly),
  transactionFeePct: num(p.transactionFeePct),
  limits: { products: p.maxProducts, staff: p.maxStaff, ordersPerMonth: p.maxOrdersPerMonth, storageGb: p.maxStorageGb },
  features: p.features,
  ...(p.highlighted ? { highlighted: true } : {}),
  isActive: p.isActive,
  ...(p.localPrices ? { localPrices: p.localPrices } : {}),
});

export const toPlanCoupon = (c: PlanCoupon & { plans?: { planId: string }[]; _count?: { redemptions: number } }) => ({
  id: c.id,
  code: c.code,
  type: lower(c.type),
  value: num(c.value),
  ...(c.plans?.length ? { planIds: c.plans.map((p) => p.planId) } : {}),
  ...(c.businessId ? { businessId: c.businessId } : {}),
  ...(c.maxUses != null ? { maxUses: c.maxUses } : {}),
  usedCount: c._count?.redemptions ?? 0,
  ...(c.expiresAt ? { expiresAt: iso(c.expiresAt) } : {}),
  status: lower(c.status),
  ...(c.note ? { note: c.note } : {}),
  createdAt: iso(c.createdAt)!,
});

export const toSubscription = (s: Subscription) => ({
  id: s.id,
  businessId: s.businessId,
  planId: s.planId,
  status: lower(s.status),
  cycle: lower(s.cycle),
  amount: num(s.amount),
  startedAt: iso(s.createdAt)!,
  currentPeriodEnd: iso(s.currentPeriodEnd)!,
  ...(s.trialEndsAt ? { trialEndsAt: iso(s.trialEndsAt) } : {}),
  ...(s.cancelledAt ? { cancelledAt: iso(s.cancelledAt) } : {}),
});
