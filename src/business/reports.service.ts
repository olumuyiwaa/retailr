import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { lower, num, toOrder, toProduct } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";

export const REPORT_DAYS = [7, 30, 90, 365] as const;
const DAY = 86_400_000;
const STATUSES = ["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"] as const;
const LOW_STOCK = 6;
const pct = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 0) : ((a - b) / b) * 100);
const sum = (xs: { total: Prisma.Decimal }[]) => xs.reduce((s, o) => s + num(o.total), 0);
const label = (d: Date, monthOnly = false) =>
  d.toLocaleDateString("en-US", monthOnly ? { month: "short", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" });
/** True when `at` falls in the window that starts `fromDaysAgo` days before `now` and ends `toDaysAgo` days before it. */
const inRange = (now: number, at: Date, fromDaysAgo: number, toDaysAgo: number) => {
  const age = now - at.getTime();
  return age >= toDaysAgo * DAY && age < fromDaysAgo * DAY;
};

/** Revenue counts paid orders only. Windows are measured back from now, so "30 days" is the last 720 hours. */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(businessId: string) {
    const db = this.prisma.forBusiness(businessId);
    const now = Date.now();
    const since = new Date(now - 60 * DAY);
    const [paid, byStatus, customers, newCustomers, topProducts, lowStock, recent, live, products, team] = await Promise.all([
      db.order.findMany({ where: { paymentStatus: "PAID", placedAt: { gte: since } }, select: { placedAt: true, total: true } }),
      db.order.groupBy({ by: ["status"], _count: { _all: true } }),
      db.customer.count(),
      db.customer.count({ where: { createdAt: { gte: new Date(now - 30 * DAY) } } }),
      db.product.findMany({ orderBy: [{ sold: "desc" }, { createdAt: "desc" }], take: 5, include: PRODUCT_INCLUDE }),
      db.product.findMany({ where: { status: { not: "DRAFT" }, stock: { lte: LOW_STOCK } }, orderBy: [{ stock: "asc" }, { createdAt: "desc" }], take: 5, include: PRODUCT_INCLUDE }),
      db.order.findMany({ orderBy: { placedAt: "desc" }, take: 6, include: { items: true } }),
      db.order.findMany({ where: { status: { notIn: ["CANCELLED", "REFUNDED"] } }, select: { status: true, paymentStatus: true, total: true } }),
      db.product.findMany({ select: { status: true, stock: true } }),
      db.teamMember.count(),
    ]);
    const cur = paid.filter((o) => inRange(now, o.placedAt, 30, 0));
    const prev = paid.filter((o) => inRange(now, o.placedAt, 60, 30));
    const revenue = sum(cur);

    const revenueSeries = [];
    for (let d = 29; d >= 0; d--) {
      revenueSeries.push({ label: label(new Date(now - d * DAY)), value: sum(paid.filter((o) => inRange(now, o.placedAt, d + 1, d))) });
    }
    const counts = new Map(byStatus.map((r) => [r.status, r._count._all]));
    const totalOrders = [...counts.values()].reduce((a, b) => a + b, 0);
    const unpaid = live.filter((o) => o.paymentStatus === "UNPAID");
    const sellable = products.filter((p) => p.status !== "DRAFT");

    return {
      revenue30d: revenue,
      revenueChangePct: pct(revenue, sum(prev)),
      orders30d: cur.length,
      ordersChangePct: pct(cur.length, prev.length),
      customers,
      newCustomers30d: newCustomers,
      avgOrderValue: cur.length ? revenue / cur.length : 0,
      revenueSeries,
      ordersByStatus: STATUSES.map((s) => ({ status: lower(s), count: counts.get(s) ?? 0 })),
      topProducts: topProducts.map(toProduct),
      lowStock: lowStock.map(toProduct),
      recentOrders: recent.map((o) => toOrder(o)),
      pendingOrders: counts.get("PENDING") ?? 0,
      unpaidOrders: unpaid.length,
      unpaidAmount: sum(unpaid),
      fulfilmentRatePct: live.length ? (live.filter((o) => o.status === "DELIVERED").length / live.length) * 100 : 0,
      cancelRatePct: totalOrders ? ((counts.get("CANCELLED") ?? 0) / totalOrders) * 100 : 0,
      outOfStock: sellable.filter((p) => p.stock <= 0).length,
      lowStockCount: sellable.filter((p) => p.stock > 0 && p.stock <= LOW_STOCK).length,
      totalOrders,
      productsTotal: products.length,
      activeProducts: products.filter((p) => p.status === "ACTIVE").length,
      teamSize: team,
    };
  }

  async sales(businessId: string, days: number) {
    const db = this.prisma.forBusiness(businessId);
    const now = Date.now();
    const start = new Date(now - days * DAY);
    const paid = await db.order.findMany({
      where: { paymentStatus: "PAID", placedAt: { gte: new Date(now - days * 2 * DAY) } },
      select: { placedAt: true, total: true, channel: true, paymentMethod: true, customerId: true, customerName: true },
    });
    const cur = paid.filter((o) => inRange(now, o.placedAt, days, 0));
    const prev = paid.filter((o) => inRange(now, o.placedAt, days * 2, days));
    const revenue = sum(cur);

    // chart buckets: daily up to 30 days, weekly for 90, roughly monthly for a year
    const size = days <= 30 ? 1 : days <= 90 ? 7 : 30;
    const series = [];
    for (let b = Math.ceil(days / size) - 1; b >= 0; b--) {
      const from = Math.min(days, (b + 1) * size), to = b * size;
      series.push({ label: label(new Date(now - to * DAY), size >= 30), value: sum(cur.filter((o) => inRange(now, o.placedAt, from, to))) });
    }

    const group = <K extends string>(keyOf: (o: (typeof cur)[number]) => K) => {
      const map = new Map<K, { orders: number; revenue: number }>();
      for (const o of cur) {
        const k = keyOf(o);
        const g = map.get(k) ?? { orders: 0, revenue: 0 };
        g.orders += 1; g.revenue += num(o.total);
        map.set(k, g);
      }
      return [...map].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.revenue - a.revenue);
    };

    const customers = new Map<string, { id: string; name: string; orders: number; revenue: number }>();
    for (const o of cur) {
      if (!o.customerId) continue; // walk-ins
      const g = customers.get(o.customerId) ?? { id: o.customerId, name: o.customerName, orders: 0, revenue: 0 };
      g.orders += 1; g.revenue += num(o.total);
      customers.set(o.customerId, g);
    }

    const [outstanding, newCustomers, items, topProducts] = await Promise.all([
      db.order.aggregate({ where: { status: { notIn: ["CANCELLED", "REFUNDED"] }, paymentStatus: "UNPAID", placedAt: { gte: start } }, _sum: { total: true } }),
      db.customer.count({ where: { createdAt: { gte: start } } }),
      this.prisma.orderItem.aggregate({ where: { order: { businessId, paymentStatus: "PAID", placedAt: { gte: start } } }, _sum: { qty: true } }),
      // by product (variants roll up into their product); products deleted since keep their snapshot name
      this.prisma.$queryRaw<{ name: string; qty: bigint; revenue: Prisma.Decimal }[]>`
        SELECT COALESCE(p."name", MIN(oi."name")) AS name, SUM(oi."qty") AS qty, SUM(oi."qty" * oi."price") AS revenue
        FROM "OrderItem" oi
        JOIN "Order" o ON o."id" = oi."orderId"
        LEFT JOIN "Product" p ON p."id" = oi."productId"
        WHERE o."businessId" = ${businessId} AND o."paymentStatus" = 'PAID' AND o."placedAt" >= ${start}
        GROUP BY COALESCE(oi."productId", oi."name"), p."name"
        ORDER BY revenue DESC, name ASC
        LIMIT 8`,
    ]);

    return {
      days,
      revenue,
      revenueChangePct: pct(revenue, sum(prev)),
      orders: cur.length,
      ordersChangePct: pct(cur.length, prev.length),
      avgOrderValue: cur.length ? revenue / cur.length : 0,
      outstanding: outstanding._sum.total ? num(outstanding._sum.total) : 0,
      itemsSold: items._sum.qty ?? 0,
      newCustomers,
      series,
      byChannel: group((o) => lower(o.channel)).map((g) => ({ channel: g.key, orders: g.orders, revenue: g.revenue })),
      byPayment: group((o) => (o.paymentMethod ? lower(o.paymentMethod) : "unknown")).map((g) => ({ method: g.key, orders: g.orders, revenue: g.revenue })),
      topProducts: topProducts.map((r) => ({ name: r.name, qty: Number(r.qty), revenue: num(r.revenue) })),
      topCustomers: [...customers.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    };
  }
}

const PRODUCT_INCLUDE = { category: true, images: { orderBy: { position: "asc" } }, variants: { orderBy: { position: "asc" } } } satisfies Prisma.ProductInclude;
