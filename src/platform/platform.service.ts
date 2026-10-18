import { Injectable } from "@nestjs/common";
import { BusinessStatus, Prisma, Subscription } from "@prisma/client";
import { AppError } from "../common/errors";
import { toUsd } from "../common/money";
import { pageArgs } from "../common/paging";
import { num, toBusiness, toInvoice, toPlan, toSubscription, toTeamMember } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { BusinessesQuery, InvoicesQuery, SubscriptionsQuery } from "./dto/platform.dto";

const DAY = 86_400_000;
type Stats = { products: number; orders: number; customers: number; revenue: number };
type Sub = Pick<Subscription, "createdAt" | "status" | "cycle" | "amount" | "cancelledAt">;
const monthlyValue = (s: Pick<Sub, "cycle" | "amount">) => (s.cycle === "YEARLY" ? num(s.amount) / 12 : num(s.amount));
const monthName = (d: Date) => d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

/** Everything the platform owner sees across all businesses. This is the one place that deliberately reads across tenants. */
@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lifetime counts and paid revenue for a set of businesses, in four grouped queries. */
  private async statsFor(ids: string[]): Promise<Map<string, Stats>> {
    const where = { businessId: { in: ids } };
    const [products, orders, customers, revenue] = await Promise.all([
      this.prisma.product.groupBy({ by: ["businessId"], where, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ["businessId"], where, _count: { _all: true } }),
      this.prisma.customer.groupBy({ by: ["businessId"], where, _count: { _all: true } }),
      this.prisma.order.groupBy({ by: ["businessId"], where: { ...where, paymentStatus: "PAID" }, _sum: { total: true } }),
    ]);
    const out = new Map<string, Stats>(ids.map((id) => [id, { products: 0, orders: 0, customers: 0, revenue: 0 }]));
    for (const r of products) out.get(r.businessId)!.products = r._count._all;
    for (const r of orders) out.get(r.businessId)!.orders = r._count._all;
    for (const r of customers) out.get(r.businessId)!.customers = r._count._all;
    for (const r of revenue) out.get(r.businessId)!.revenue = r._sum.total ? num(r._sum.total) : 0;
    return out;
  }

  private async businessesWithStats(rows: Prisma.BusinessGetPayload<object>[]) {
    const stats = await this.statsFor(rows.map((b) => b.id));
    return rows.map((b) => toBusiness(b, stats.get(b.id)!));
  }

  // ---------- overview ----------

  /** MRR at a moment: paying (not trialing), not yet cancelled subscriptions that had started, yearly amounts spread over 12 months. */
  private mrrAt(subs: Sub[], at: Date) {
    return subs
      .filter((s) => s.createdAt <= at && s.status !== "TRIALING" && !(s.cancelledAt && s.cancelledAt < at) && !(at.getTime() >= Date.now() && s.status === "CANCELLED"))
      .reduce((sum, s) => sum + monthlyValue(s), 0);
  }

  async overview() {
    const now = new Date();
    const thirtyAgo = new Date(now.getTime() - 30 * DAY);
    const [subs, businesses, plans, gmvRows, recentBiz, recentInv] = await Promise.all([
      this.prisma.subscription.findMany({ select: { createdAt: true, status: true, cycle: true, amount: true, cancelledAt: true } }),
      this.prisma.business.findMany({ select: { createdAt: true, status: true, planId: true } }),
      this.prisma.plan.findMany({ orderBy: [{ priceMonthly: "asc" }, { createdAt: "asc" }] }),
      this.prisma.$queryRaw<{ currency: string; total: Prisma.Decimal }[]>`
        SELECT b."currency"::text AS currency, SUM(o."total") AS total
        FROM "Order" o JOIN "Business" b ON b."id" = o."businessId"
        WHERE o."paymentStatus" = 'PAID' GROUP BY b."currency"`,
      this.prisma.business.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
      this.prisma.invoice.findMany({ orderBy: { issuedAt: "desc" }, take: 6 }),
    ]);

    const mrrSeries = [], signupSeries = [];
    for (let m = 11; m >= 0; m--) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m + 1, 0, 23, 59, 59));
      mrrSeries.push({ label: monthName(start), value: Math.round(this.mrrAt(subs, m === 0 ? now : end)) });
      signupSeries.push({ label: monthName(start), value: businesses.filter((b) => b.createdAt >= start && b.createdAt <= end).length });
    }
    const mrr = mrrSeries[11].value, prev = mrrSeries[10].value || 1;
    const count = (s: BusinessStatus) => businesses.filter((b) => b.status === s).length;
    const cancelled30 = subs.filter((s) => s.cancelledAt && s.cancelledAt > thirtyAgo).length;
    const payingBase = subs.filter((s) => s.status !== "TRIALING").length || 1;

    return {
      mrr,
      mrrChangePct: ((mrr - prev) / prev) * 100,
      activeBusinesses: count("ACTIVE"),
      trialBusinesses: count("TRIAL"),
      suspendedBusinesses: count("SUSPENDED"),
      newSignups30d: businesses.filter((b) => b.createdAt > thirtyAgo).length,
      churnRatePct: (cancelled30 / payingBase) * 100,
      gmv: Math.round(gmvRows.reduce((s, r) => s + toUsd(num(r.total), r.currency), 0)),
      mrrSeries,
      signupSeries,
      planDistribution: plans.map((p) => ({ planId: p.id, name: p.name, count: businesses.filter((b) => b.planId === p.id && b.status !== "CANCELLED" && b.status !== "PENDING").length })),
      recentSignups: await this.businessesWithStats(recentBiz),
      recentInvoices: recentInv.map(toInvoice),
    };
  }

  // ---------- businesses ----------

  async businesses(q: BusinessesQuery) {
    const where: Prisma.BusinessWhereInput = {
      ...(q.status ? { status: q.status.toUpperCase() as BusinessStatus } : {}),
      ...(q.planId ? { planId: q.planId } : {}),
      ...(q.q?.trim() ? { OR: ["name", "slug", "ownerName", "ownerEmail"].map((f) => ({ [f]: { contains: q.q!.trim(), mode: "insensitive" } })) } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.business.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(q), include: { plan: { select: { name: true } }, subscription: true } }),
      this.prisma.business.count({ where }),
    ]);
    const withStats = await this.businessesWithStats(rows);
    return {
      total,
      items: rows.map((b, i) => ({
        ...withStats[i],
        planName: b.plan.name,
        mrr: b.subscription && b.subscription.status !== "TRIALING" && b.subscription.status !== "CANCELLED" ? monthlyValue(b.subscription) : 0,
      })),
    };
  }

  async businessDetail(id: string) {
    const b = await this.prisma.business.findUnique({ where: { id }, include: { plan: true, subscription: { include: { planCoupon: { select: { code: true } } } } } });
    if (!b) throw AppError.notFound("Business not found.");
    const since = new Date(Date.now() - 30 * DAY);
    const [invoices, team, recent, [business]] = await Promise.all([
      this.prisma.invoice.findMany({ where: { businessId: id }, orderBy: { issuedAt: "desc" } }),
      this.prisma.teamMember.findMany({ where: { businessId: id }, orderBy: { createdAt: "asc" } }),
      this.prisma.order.aggregate({ where: { businessId: id, paymentStatus: "PAID", placedAt: { gt: since } }, _count: { _all: true }, _sum: { total: true } }),
      this.businessesWithStats([b]),
    ]);
    return {
      business,
      plan: toPlan(b.plan),
      ...(b.subscription ? { subscription: toSubscription(b.subscription) } : {}),
      invoices: invoices.map(toInvoice),
      team: team.map(toTeamMember),
      orders30d: recent._count._all,
      revenue30d: recent._sum.total ? num(recent._sum.total) : 0,
    };
  }

  /** Suspending or cancelling takes effect at once: the auth guard checks the business status on every request, and the storefront goes offline. */
  async setStatus(id: string, status: string) {
    const next = status.toUpperCase() as BusinessStatus;
    const b = await this.prisma.$transaction(async (tx) => {
      if (!(await tx.business.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Business not found.");
      const biz = await tx.business.update({ where: { id }, data: { status: next } });
      const sub = await tx.subscription.findUnique({ where: { businessId: id }, select: { id: true } });
      if (sub) {
        if (next === "SUSPENDED") await tx.subscription.update({ where: { businessId: id }, data: { status: "PAST_DUE" } });
        else if (next === "ACTIVE") await tx.subscription.update({ where: { businessId: id }, data: { status: "ACTIVE", cancelledAt: null } }); // reinstating clears an earlier cancellation
        else if (next === "CANCELLED") await tx.subscription.update({ where: { businessId: id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
      }
      return biz;
    });
    const [out] = await this.businessesWithStats([b]);
    return out;
  }

  // ---------- subscriptions and invoices ----------

  async subscriptions(q: SubscriptionsQuery) {
    const where: Prisma.SubscriptionWhereInput = {
      ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
      ...(q.q?.trim() ? { business: { name: { contains: q.q.trim(), mode: "insensitive" } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.subscription.findMany({ where, orderBy: { createdAt: "desc" }, ...pageArgs(q), include: { business: { select: { name: true } }, plan: { select: { name: true } }, planCoupon: { select: { code: true } } } }),
      this.prisma.subscription.count({ where }),
    ]);
    return { total, items: rows.map((s) => ({ ...toSubscription(s), businessName: s.business.name, planName: s.plan.name })) };
  }

  async invoices(q: InvoicesQuery) {
    const t = q.q?.trim();
    const where: Prisma.InvoiceWhereInput = {
      ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
      ...(t ? { OR: [{ business: { name: { contains: t, mode: "insensitive" } } }, { description: { contains: t, mode: "insensitive" } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({ where, orderBy: { issuedAt: "desc" }, ...pageArgs(q), include: { business: { select: { name: true } } } }),
      this.prisma.invoice.count({ where }),
    ]);
    return { total, items: rows.map((i) => ({ ...toInvoice(i), businessName: i.business.name })) };
  }
}
