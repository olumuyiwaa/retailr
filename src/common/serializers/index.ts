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

export const toSubscription = (s: Subscription & { planCoupon?: { code: string } | null }) => ({
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
  ...(s.planCouponId && s.planCoupon ? { couponCode: s.planCoupon.code } : {}),
  // kept even if the code was later deleted: the discount already in the price stays
  ...(s.discount != null ? { discount: num(s.discount) } : {}),
});

export const toInvoice = (i: Invoice) => ({
  id: i.id,
  businessId: i.businessId,
  planId: i.planId,
  description: i.description,
  amount: num(i.amount),
  status: lower(i.status),
  issuedAt: iso(i.issuedAt)!,
  ...(i.paidAt ? { paidAt: iso(i.paidAt) } : {}),
});

// ---------- catalogue ----------
import type { Category, Product, ProductImage, ProductVariant } from "@prisma/client";

export const toCategory = (c: Category & { _count?: { products: number } }) => ({
  id: c.id,
  businessId: c.businessId,
  name: c.name,
  ...(c.imageUrl ? { image: c.imageUrl } : {}),
  createdAt: iso(c.createdAt)!,
  ...(c._count ? { productCount: c._count.products } : {}),
});

type ProductRow = Product & {
  category?: Category | null;
  images?: ProductImage[];
  variants?: ProductVariant[];
};

export const toProduct = (p: ProductRow) => {
  const images = [...(p.images ?? [])].sort((a, b) => a.position - b.position).map((i) => i.url);
  const variants = [...(p.variants ?? [])].sort((a, b) => a.position - b.position);
  return {
    id: p.id,
    businessId: p.businessId,
    name: p.name,
    sku: p.sku,
    category: p.category?.name ?? "",
    description: p.description,
    price: num(p.price),
    stock: p.stock,
    status: lower(p.status),
    sold: p.sold,
    imageColor: p.imageColor,
    ...(images.length ? { image: images[0], images } : {}),
    ...(variants.length
      ? { variants: variants.map((v) => ({ id: v.id, name: v.name, ...(v.price != null ? { price: num(v.price) } : {}), stock: v.stock })) }
      : {}),
    ...(Array.isArray(p.specs) && p.specs.length ? { specs: p.specs } : {}),
    createdAt: iso(p.createdAt)!,
  };
};

// ---------- storefront, orders, customers ----------
import type { Business, Customer, Order, OrderItem } from "@prisma/client";

export const toPublicStore = (b: Business) => ({
  id: b.id,
  name: b.name,
  slug: b.slug,
  category: b.category,
  description: b.description,
  phone: b.phone,
  city: b.city,
  country: b.country,
  brandColor: b.brandColor,
  ...(b.theme ? { theme: b.theme } : {}),
  ...(b.logoUrl ? { logo: b.logoUrl } : {}),
  currency: b.currency,
});

export const toOrder = (o: Order & { items?: OrderItem[] }, opts: { publicToken?: boolean } = {}) => ({
  id: o.id,
  businessId: o.businessId,
  number: o.number,
  customerId: o.customerId ?? "walk_in",
  customerName: o.customerName,
  items: (o.items ?? []).map((i) => ({
    productId: i.productId ?? "",
    ...(i.variantId ? { variantId: i.variantId } : {}),
    name: i.name,
    qty: i.qty,
    price: num(i.price),
  })),
  total: num(o.total),
  status: lower(o.status),
  paymentStatus: lower(o.paymentStatus),
  placedAt: iso(o.placedAt)!,
  ...(o.customerEmail ? { customerEmail: o.customerEmail } : {}),
  ...(o.customerPhone ? { customerPhone: o.customerPhone } : {}),
  ...(o.shippingAddress ? { shippingAddress: o.shippingAddress } : {}),
  ...(o.notes ? { notes: o.notes } : {}),
  ...(o.paymentMethod ? { paymentMethod: lower(o.paymentMethod) } : {}),
  channel: lower(o.channel),
  ...(o.couponCode ? { couponCode: o.couponCode } : {}),
  ...(num(o.discount) > 0 ? { discount: num(o.discount) } : {}),
  ...(o.receiptSentAt ? { receiptSentAt: iso(o.receiptSentAt) } : {}),
  ...(opts.publicToken ? { publicToken: o.publicToken } : {}),
});

export const toCustomer = (c: Customer) => ({
  id: c.id,
  businessId: c.businessId,
  name: c.name,
  email: c.email ?? "",
  phone: c.phone,
  city: c.city,
  orders: c.ordersCount,
  totalSpent: num(c.totalSpent),
  joinedAt: iso(c.createdAt)!,
});

// ---------- business extras ----------
import type { Invoice, Coupon, CustomerGroup, Message, TeamMember } from "@prisma/client";

export const toCoupon = (c: Coupon) => ({
  id: c.id,
  businessId: c.businessId,
  code: c.code,
  type: lower(c.type),
  value: num(c.value),
  ...(c.minOrder != null ? { minOrder: num(c.minOrder) } : {}),
  ...(c.maxUses != null ? { maxUses: c.maxUses } : {}),
  usedCount: c.usedCount,
  ...(c.expiresAt ? { expiresAt: iso(c.expiresAt) } : {}),
  status: lower(c.status),
  createdAt: iso(c.createdAt)!,
});

export const toGroup = (g: CustomerGroup & { members?: { customerId: string }[] }, memberCount?: number) => ({
  id: g.id,
  businessId: g.businessId,
  name: g.name,
  ...(g.description ? { description: g.description } : {}),
  kind: lower(g.kind),
  memberIds: g.kind === "MANUAL" ? (g.members ?? []).map((m) => m.customerId) : [],
  ...(g.kind === "AUTO" && g.ruleType && g.ruleValue != null ? { rule: { type: lower(g.ruleType), value: num(g.ruleValue) } } : {}),
  createdAt: iso(g.createdAt)!,
  ...(memberCount !== undefined ? { memberCount } : {}),
});

export const toMessage = (m: Message) => ({
  id: m.id,
  businessId: m.businessId,
  channel: lower(m.channel),
  ...(m.channel === "EMAIL" && m.subject ? { subject: m.subject } : {}),
  body: m.body,
  audienceLabel: m.audienceLabel,
  recipientCount: m.recipientCount,
  delivered: m.sentCount,
  failed: m.failedCount,
  sentAt: iso(m.sentAt)!,
});

export const toTeamMember = (t: TeamMember) => ({
  id: t.id,
  businessId: t.businessId,
  name: t.name,
  email: t.email,
  role: lower(t.role),
  status: lower(t.status),
  joinedAt: iso(t.createdAt)!,
});

export const toBusiness = (b: Business, stats: { products: number; orders: number; customers: number; revenue: number }) => ({
  id: b.id,
  name: b.name,
  slug: b.slug,
  category: b.category,
  ownerName: b.ownerName,
  ownerEmail: b.ownerEmail,
  phone: b.phone,
  country: b.country,
  city: b.city,
  brandColor: b.brandColor,
  ...(b.theme ? { theme: b.theme } : {}),
  ...(b.logoUrl ? { logo: b.logoUrl } : {}),
  currency: b.currency,
  description: b.description,
  status: lower(b.status),
  planId: b.planId,
  joinedAt: iso(b.createdAt)!,
  stats,
});
