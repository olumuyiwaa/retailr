import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, PaymentMethod, SalesChannel, OrderStatus, PaymentStatus } from "@prisma/client";
import { AppError } from "../common/errors";
import { PrismaService } from "../prisma/prisma.service";

type Client = ReturnType<PrismaService["forBusiness"]>;
export type Tx = Parameters<Parameters<Client["$transaction"]>[0]>[0];

export type OrderSource = "store" | "sale";

export interface LineInput { productId: string; variantId?: string; qty: number; /** only honoured for recorded sales */ price?: number }

export interface NewOrder {
  source: OrderSource;
  businessId: string;
  items: LineInput[];
  /** An existing customer, or details to find-or-create one, or neither for a walk-in. */
  customer: { id?: string; name?: string; email?: string; phone?: string } | null;
  channel: SalesChannel;
  paymentMethod: PaymentMethod;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  couponCode?: string;
  /** Flat amount off, recorded sales only. */
  flatDiscount?: number;
  shippingAddress?: string;
  notes?: string;
}

// what the UI says in each situation; the store and the merchant's "record a sale" screen word a few of them differently
const MSG = {
  store: {
    gone: "One of the items in your cart is no longer available.",
    qty: () => "Invalid quantity.",
    option: (n: string) => `Please choose an option for ${n}.`,
    limit: "This store isn't taking new orders right now. Please try again later.",
    inactive: "This store isn't available right now.",
    empty: "Your cart is empty.",
  },
  sale: {
    gone: "One of the products no longer exists.",
    qty: (n: string) => `Enter a whole quantity for ${n}.`,
    option: (n: string) => `Choose an option for ${n}.`,
    limit: "You've reached this month's order limit on your plan. Upgrade to record more sales.",
    inactive: "Your store isn't active, so new sales can't be recorded.",
    empty: "Add at least one product to the sale.",
  },
} as const;

const D = (n: Prisma.Decimal.Value) => new Prisma.Decimal(n);
const cents = (d: Prisma.Decimal) => d.toDecimalPlaces(2);
const fmtMoney = (amount: Prisma.Decimal, currency: string) => {
  const n = amount.toNumber();
  const symbol: Record<string, string> = { NGN: "₦", GHS: "GH₵", KES: "KSh", USD: "$" };
  return `${symbol[currency] ?? ""}${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
};
const RELEASED: OrderStatus[] = ["CANCELLED", "REFUNDED"]; // statuses that don't hold stock
export const holdsStock = (s: OrderStatus) => !RELEASED.includes(s);

/**
 * Everything that changes stock, coupons, customer totals or order numbers lives here so the
 * storefront checkout and the merchant's "record a sale" can't drift apart. Callers run it
 * inside `inTenantTransaction`, which takes a per-business lock first.
 */
@Injectable()
export class OrderEngine {
  readonly demoCardPayments: boolean;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    // No payment provider is wired up yet. When true, a card order counts as paid immediately (demo behaviour).
    this.demoCardPayments = process.env.DEMO_CARD_PAYMENTS === "true"; // raw env: implicit conversion would turn "false" into true
  }

  /** One transaction per business at a time for anything that moves stock or numbers orders. */
  inTenantTransaction<T>(businessId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.forBusiness(businessId).$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${businessId}))`;
      return fn(tx);
    }, { timeout: 15_000 });
  }

  async createOrder(tx: Tx, o: NewOrder) {
    const msg = MSG[o.source];
    const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: o.businessId }, include: { plan: true } });
    if (biz.status !== "ACTIVE" && biz.status !== "TRIAL") throw AppError.forbidden(msg.inactive, "STORE_UNAVAILABLE");
    if (o.items.length === 0) throw AppError.badRequest(msg.empty, "EMPTY");

    if (biz.plan.maxOrdersPerMonth !== -1) {
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      if ((await tx.order.count({ where: { placedAt: { gte: monthStart } } })) >= biz.plan.maxOrdersPerMonth) {
        throw AppError.forbidden(msg.limit, "PLAN_LIMIT_ORDERS");
      }
    }

    // the same product listed twice must not slip past the stock check, so merge lines first
    const merged = new Map<string, LineInput>();
    for (const it of o.items) {
      if (!Number.isInteger(it.qty) || it.qty < 1) {
        const p = await tx.product.findUnique({ where: { id: it.productId }, select: { name: true } });
        throw AppError.badRequest(msg.qty(p?.name ?? "this item"), "BAD_QUANTITY");
      }
      const key = `${it.productId}|${it.variantId ?? ""}`;
      const prev = merged.get(key);
      merged.set(key, prev ? { ...prev, qty: prev.qty + it.qty } : { ...it });
    }
    const lines = Array.from(merged.values());

    const products = await tx.product.findMany({ where: { id: { in: lines.map((l) => l.productId) } }, include: { variants: true } });
    const byId = new Map(products.map((p) => [p.id, p]));

    const resolved = lines.map((l) => {
      const p = byId.get(l.productId);
      if (!p || (o.source === "store" && p.status === "DRAFT")) throw AppError.badRequest(msg.gone, "ITEM_GONE");
      if (o.source === "store" && p.bookable) throw AppError.badRequest(`${p.name} has to be booked for a time slot, not bought through the cart.`, "BOOKING_REQUIRED");
      if (o.source === "sale" && l.price !== undefined && !(l.price >= 0)) throw AppError.badRequest(`Enter a valid price for ${p.name}.`);
      let variant = undefined as (typeof p.variants)[number] | undefined;
      if (p.variants.length) {
        variant = p.variants.find((v) => v.id === l.variantId);
        if (!variant) throw AppError.badRequest(msg.option(p.name), "OPTION_REQUIRED");
      }
      const label = variant ? `${p.name} (${variant.name})` : p.name;
      if (p.kind === "PRODUCT") {
        const available = variant ? variant.stock : p.stock;
        // storefront: a sold-out status also blocks the sale even if a stale stock number says otherwise
        if (available <= 0 || (!variant && o.source === "store" && p.status === "OUT_OF_STOCK")) throw AppError.badRequest(`${label} is sold out.`, "SOLD_OUT");
        if (l.qty > available) throw AppError.badRequest(`Only ${available} of ${label} left in stock.`, "STOCK_INSUFFICIENT");
      }
      const price = D(o.source === "sale" && l.price !== undefined ? l.price : variant?.price ?? p.price);
      return { product: p, variant, label, qty: l.qty, price };
    });

    const subtotal = cents(resolved.reduce((s, r) => s.add(r.price.mul(r.qty)), D(0)));

    // discounts: a shopper's coupon at checkout, or a flat amount on a recorded sale
    let discount = D(0);
    let couponCode: string | undefined;
    if (o.source === "store" && o.couponCode?.trim()) {
      const coupon = await tx.coupon.findFirst({ where: { code: o.couponCode.trim().toUpperCase() } });
      discount = this.evaluateCoupon(coupon, subtotal, biz.currency);
      couponCode = coupon!.code;
      // guarded increment so the last use can't be taken twice
      const used = await tx.$executeRaw`UPDATE "Coupon" SET "usedCount" = "usedCount" + 1 WHERE id = ${coupon!.id} AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`;
      if (used === 0) throw AppError.badRequest("That code has been fully used.", "COUPON_USED_UP");
    } else if (o.source === "sale" && o.flatDiscount && o.flatDiscount > 0) {
      discount = D(o.flatDiscount);
      if (discount.gt(subtotal)) throw AppError.badRequest("The discount can't be more than the sale total.");
    }
    const total = cents(subtotal.sub(discount));

    const customer = await this.resolveCustomer(tx, o);

    for (const r of resolved) await this.takeStock(tx, r.product.id, r.variant?.id, r.qty, r.label);

    // atomic counter: "#AD1180" = two letters of the slug + a per-business sequence
    const { orderSeq, slug } = await this.prisma.business.update({ where: { id: biz.id }, data: { orderSeq: { increment: 1 } }, select: { orderSeq: true, slug: true } });
    const prefix = (slug.replace(/[^a-z0-9]/gi, "").slice(0, 2) || "OR").toUpperCase();

    const order = await tx.order.create({
      data: {
        number: `#${prefix}${orderSeq}`,
        customerId: customer?.id ?? null,
        customerName: o.source === "store" ? o.customer?.name?.trim() ?? customer?.name ?? "Customer" : customer?.name ?? "Walk-in customer",
        customerEmail: customer?.email ?? null,
        customerPhone: customer?.phone || null,
        shippingAddress: o.shippingAddress?.trim() || null,
        notes: o.notes?.trim() || null,
        channel: o.channel,
        paymentMethod: o.paymentMethod,
        status: o.status,
        paymentStatus: o.paymentStatus,
        subtotal, discount, total, couponCode: couponCode ?? null,
        items: { create: resolved.map((r) => ({ productId: r.product.id, variantId: r.variant?.id ?? null, name: r.label, qty: r.qty, price: r.price })) },
      } as never,
      include: { items: true },
    });

    if (customer && o.paymentStatus === "PAID") await this.recomputeCustomer(tx, customer.id);
    return order;
  }

  private evaluateCoupon(c: { status: string; expiresAt: Date | null; maxUses: number | null; usedCount: number; minOrder: Prisma.Decimal | null; type: string; value: Prisma.Decimal } | null, subtotal: Prisma.Decimal, currency: string) {
    const bad = (m: string, code: string) => AppError.badRequest(m, code);
    if (!c || c.status !== "ACTIVE") throw bad("That code isn't valid.", "COUPON_INVALID");
    if (c.expiresAt && c.expiresAt.getTime() < Date.now()) throw bad("That code has expired.", "COUPON_EXPIRED");
    if (c.maxUses != null && c.usedCount >= c.maxUses) throw bad("That code has been fully used.", "COUPON_USED_UP");
    if (c.minOrder && subtotal.lt(c.minOrder)) throw bad(`Spend at least ${fmtMoney(c.minOrder, currency)} to use this code.`, "COUPON_MIN_ORDER");
    const raw = c.type === "PERCENT" ? subtotal.mul(c.value).div(100) : c.value;
    return cents(Prisma.Decimal.min(raw, subtotal));
  }

  /** What a coupon would take off a subtotal, without using it up. */
  async previewCoupon(businessId: string, currency: string, code: string, subtotal: number) {
    const c = await this.prisma.forBusiness(businessId).coupon.findFirst({ where: { code: code.trim().toUpperCase() } });
    return { code: c?.code ?? code, discount: this.evaluateCoupon(c, D(subtotal), currency).toNumber() };
  }

  private async resolveCustomer(tx: Tx, o: NewOrder) {
    const c = o.customer;
    if (c?.id) {
      const found = await tx.customer.findUnique({ where: { id: c.id } });
      if (!found) throw AppError.badRequest("That customer no longer exists.");
      return found;
    }
    if (!c?.name?.trim()) return null; // walk-in
    const email = c.email?.trim().toLowerCase() || null;
    const phone = c.phone?.trim() ?? "";
    if (o.source === "sale" && email && !/^\S+@\S+\.\S+$/.test(email)) throw AppError.badRequest("Enter a valid customer email, or leave it blank.");
    // find by email (and, for recorded sales, by phone); otherwise create
    const matches: Prisma.CustomerWhereInput[] = [];
    if (email) matches.push({ email });
    if (o.source === "sale" && phone) matches.push({ phone });
    const existing = matches.length ? await tx.customer.findFirst({ where: { OR: matches } }) : null;
    if (existing) return existing;
    return tx.customer.create({ data: { name: c.name.trim(), email, phone } as never });
  }

  /** Orders and spend are derived from paid orders, so they can't drift when an order changes later. */
  async recomputeCustomer(tx: Tx, customerId: string) {
    const agg = await tx.order.aggregate({ where: { customerId, paymentStatus: "PAID" }, _count: true, _sum: { total: true } });
    await tx.customer.update({ where: { id: customerId }, data: { ordersCount: agg._count, totalSpent: agg._sum.total ?? 0 } });
  }

  /** Guarded decrement: the update only succeeds while enough stock is left, so two shoppers can't both buy the last item. */
  async takeStock(tx: Tx, productId: string, variantId: string | undefined, qty: number, label: string) {
    // services have no stock to take; they only count towards "sold"
    const kind = (await tx.product.findUnique({ where: { id: productId }, select: { kind: true } }))?.kind;
    if (kind === "SERVICE") {
      await tx.product.updateMany({ where: { id: productId }, data: { sold: { increment: qty } } });
      return;
    }
    const short = async () => {
      const left = variantId
        ? (await tx.productVariant.findUnique({ where: { id: variantId }, select: { stock: true } }))?.stock ?? 0
        : (await tx.product.findUnique({ where: { id: productId }, select: { stock: true } }))?.stock ?? 0;
      return AppError.badRequest(left <= 0 ? `${label} is sold out.` : `Only ${left} of ${label} left in stock.`, left <= 0 ? "SOLD_OUT" : "STOCK_INSUFFICIENT");
    };
    if (variantId) {
      const v = await tx.productVariant.updateMany({ where: { id: variantId, productId, stock: { gte: qty } }, data: { stock: { decrement: qty } } });
      if (v.count === 0) throw await short();
    }
    const p = await tx.product.updateMany({ where: { id: productId, stock: { gte: qty } }, data: { stock: { decrement: qty }, sold: { increment: qty } } });
    if (p.count === 0) throw await short();
    await tx.product.updateMany({ where: { id: productId, stock: { lte: 0 }, status: "ACTIVE" }, data: { status: "OUT_OF_STOCK" } });
  }

  /** Puts stock back (cancelled or refunded order) and takes `sold` down with it. */
  async returnStock(tx: Tx, productId: string, variantId: string | null, qty: number) {
    const kind = (await tx.product.findUnique({ where: { id: productId }, select: { kind: true } }))?.kind;
    if (kind === "SERVICE") {
      await tx.$executeRaw`UPDATE "Product" SET "sold" = GREATEST("sold" - ${qty}, 0) WHERE id = ${productId}`;
      return;
    }
    if (variantId) await tx.productVariant.updateMany({ where: { id: variantId, productId }, data: { stock: { increment: qty } } });
    await tx.$executeRaw`UPDATE "Product" SET "stock" = "stock" + ${qty}, "sold" = GREATEST("sold" - ${qty}, 0) WHERE id = ${productId}`;
    await tx.product.updateMany({ where: { id: productId, stock: { gt: 0 }, status: "OUT_OF_STOCK" }, data: { status: "ACTIVE" } });
  }
}
