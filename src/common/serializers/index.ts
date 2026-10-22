// The one place database rows become the JSON the frontend's types describe
// (lower-case enums, Decimal -> number, createdAt -> joinedAt / startedAt, ...).
import type { Plan, PlanCoupon, Subscription, User } from "@prisma/client";

/** `OUT_OF_STOCK` -> `"out_of_stock"` */
export const lower = <T extends string>(v: T) => v.toLowerCase() as Lowercase<T>;
type Decimalish = { toNumber(): number } | number | string;
export const num = (d: Decimalish): number => (typeof d === "number" ? d : typeof d === "string" ? Number(d) : d.toNumber());
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

export const toAuthUser = (u: Pick<User, "id" | "name" | "email" | "role" | "businessId" | "emailVerifiedAt">) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: lower(u.role),
  emailVerified: !!u.emailVerifiedAt,
  ...(u.businessId ? { businessId: u.businessId } : {}),
});

export const toPlan = (p: Plan) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  priceMonthly: num(p.priceMonthly),
  priceYearly: num(p.priceYearly),
  transactionFeePct: num(p.transactionFeePct),
  limits: { products: p.maxProducts, staff: p.maxStaff, ordersPerMonth: p.maxOrdersPerMonth, storageGb: p.maxStorageGb, smsPerMonth: p.maxSmsPerMonth },
  features: p.features,
  themes: allowedThemes(p.themes),
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
import type { Category, Product, ProductImage, ProductVariant, Service, ServiceImage, ServiceOption } from "@prisma/client";

export const toCategory = (c: Category & { _count?: { products: number; services?: number } }) => ({
  id: c.id,
  businessId: c.businessId,
  name: c.name,
  ...(c.imageUrl ? { image: c.imageUrl } : {}),
  createdAt: iso(c.createdAt)!,
  ...(c._count ? { productCount: c._count.products, serviceCount: c._count.services ?? 0 } : {}),
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

type ServiceRow = Service & { category?: Category | null; images?: ServiceImage[]; options?: ServiceOption[] };

export const toService = (s: ServiceRow) => {
  const images = [...(s.images ?? [])].sort((a, b) => a.position - b.position).map((i) => i.url);
  const options = [...(s.options ?? [])].sort((a, b) => a.position - b.position);
  return {
    id: s.id,
    businessId: s.businessId,
    name: s.name,
    category: s.category?.name ?? "",
    description: s.description,
    price: num(s.price),
    ...(s.durationMins ? { durationMins: s.durationMins } : {}),
    ...(s.bookable ? { bookable: true, maxConcurrent: s.maxConcurrent } : {}),
    status: lower(s.status),
    sold: s.sold,
    imageColor: s.imageColor,
    ...(images.length ? { image: images[0], images } : {}),
    ...(options.length ? { options: options.map((o) => ({ id: o.id, name: o.name, ...(o.price != null ? { price: num(o.price) } : {}) })) } : {}),
    ...(Array.isArray(s.specs) && s.specs.length ? { specs: s.specs } : {}),
    createdAt: iso(s.createdAt)!,
  };
};

// ---------- storefront, orders, customers ----------
import type { Booking, Business, Customer, Order, OrderItem } from "@prisma/client";

/** "classic" is the fallback theme, so every plan includes it. */
export const allowedThemes = (themes: string[] | null | undefined) => ["classic", ...(themes ?? []).filter((t) => t !== "classic")];

/** The theme a storefront actually renders: the saved one only while the plan still includes it. */
export const effectiveTheme = (theme: string | null | undefined, planThemes: string[] | null | undefined) =>
  theme && allowedThemes(planThemes).includes(theme) ? theme : null;

export const toPublicStore = (b: Business, plan?: { themes: string[] } | null) => ({
  id: b.id,
  name: b.name,
  slug: b.slug,
  category: b.category,
  description: b.description,
  phone: b.phone,
  city: b.city,
  country: b.country,
  brandColor: b.brandColor,
  ...((plan ? effectiveTheme(b.theme, plan.themes) : b.theme) ? { theme: plan ? effectiveTheme(b.theme, plan.themes)! : b.theme! } : {}),
  ...(b.logoUrl ? { logo: b.logoUrl } : {}),
  currency: b.currency,
  paymentMethods: b.paymentMethods,
  ...(b.bankDetails ? { bankDetails: b.bankDetails } : {}),
});

export const toOrder = (o: Order & { items?: OrderItem[] }, opts: { publicToken?: boolean } = {}) => ({
  id: o.id,
  businessId: o.businessId,
  number: o.number,
  customerId: o.customerId ?? "walk_in",
  customerName: o.customerName,
  items: (o.items ?? []).map((i) => ({
    productId: i.productId ?? "",
    ...(i.serviceId ? { serviceId: i.serviceId } : {}),
    ...(i.variantId ? { variantId: i.variantId } : {}),
    ...(i.optionId ? { optionId: i.optionId } : {}),
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
  paymentMethods: b.paymentMethods,
  bankDetails: b.bankDetails,
  description: b.description,
  status: lower(b.status),
  planId: b.planId,
  joinedAt: iso(b.createdAt)!,
  stats,
});

export const toBooking = (b: Booking, opts: { publicToken?: boolean; timezone?: string } = {}) => ({
  id: b.id,
  serviceId: b.serviceId ?? "",
  serviceName: b.serviceName,
  ...(b.variantName ? { variantName: b.variantName } : {}),
  price: num(b.price),
  startsAt: iso(b.startsAt)!,
  endsAt: iso(b.endsAt)!,
  durationMins: Math.round((b.endsAt.getTime() - b.startsAt.getTime()) / 60_000),
  status: lower(b.status),
  customerId: b.customerId ?? "",
  customerName: b.customerName,
  ...(b.customerEmail ? { customerEmail: b.customerEmail } : {}),
  ...(b.customerPhone ? { customerPhone: b.customerPhone } : {}),
  ...(b.notes ? { notes: b.notes } : {}),
  source: b.source,
  ...(opts.timezone ? { timezone: opts.timezone } : {}),
  ...(opts.publicToken ? { publicToken: b.publicToken } : {}),
  createdAt: iso(b.createdAt)!,
});
