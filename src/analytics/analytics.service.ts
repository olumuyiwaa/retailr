import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const DAY = 86_400_000;
type Counts = Record<string, number>;
interface Day { visitors: number; sessions: number; pageViews: number; productViews: number; addToCart: number; checkouts: number; orders: number; sources: Counts; devices: Counts; countries: Counts; pages: Counts; products: Counts }
const empty = (): Day => ({ visitors: 0, sessions: 0, pageViews: 0, productViews: 0, addToCart: 0, checkouts: 0, orders: 0, sources: {}, devices: {}, countries: {}, pages: {}, products: {} });
const key = (d: Date) => d.toISOString().slice(0, 10);
const daysAgoKey = (n: number, now: number) => key(new Date(now - n * DAY));
const change = (a: number, b: number) => (b === 0 ? (a > 0 ? 100 : 0) : ((a - b) / b) * 100);
const PAGE_LABELS: Record<string, string> = { "/": "Home", "/shop": "Shop", "/product": "Product pages", "/cart": "Cart", "/checkout": "Checkout", "/get-started": "Get started (sign-up)", "/pricing": "Pricing", "/features": "Features", other: "Other pages" };

/** The days a window covers: today minus (from-1) through today minus `to`. Windows are counted back from today (UTC). */
function windowOf(days: Map<string, Day>, from: number, to: number, now: number): Day {
  const t = empty();
  for (let n = from; n > to; n--) {
    const d = days.get(daysAgoKey(n - 1, now));
    if (!d) continue;
    t.visitors += d.visitors; t.sessions += d.sessions; t.pageViews += d.pageViews; t.productViews += d.productViews;
    t.addToCart += d.addToCart; t.checkouts += d.checkouts; t.orders += d.orders;
    for (const f of ["sources", "devices", "countries", "pages", "products"] as const) for (const [k, v] of Object.entries(d[f])) t[f][k] = (t[f][k] ?? 0) + v;
  }
  return t;
}
const ranked = (rec: Counts) => Object.entries(rec).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Stored daily roll-ups for one scope, plus the order (or sign-up) count per day. */
  private async load(scope: string, days: number, orders: "online-orders" | "signups", now: number) {
    const since = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (days * 2 - 1) * DAY);
    const rows = await this.prisma.analyticsDay.findMany({ where: { scope, date: { gte: since } } });
    const out = new Map<string, Day>();
    for (const r of rows) {
      out.set(key(r.date), { visitors: r.visitors, sessions: r.sessions, pageViews: r.pageViews, productViews: r.productViews, addToCart: r.addToCart, checkouts: r.checkouts, orders: 0,
        sources: r.sources as Counts, devices: r.devices as Counts, countries: r.countries as Counts, pages: r.pages as Counts, products: r.products as Counts });
    }
    const counted = orders === "online-orders"
      ? await this.prisma.$queryRaw<{ d: Date; n: bigint }[]>`SELECT ("placedAt" AT TIME ZONE 'UTC')::date AS d, COUNT(*) AS n FROM "Order" WHERE "businessId" = ${scope} AND "channel" = 'ONLINE' AND "placedAt" >= ${since} GROUP BY 1`
      : await this.prisma.$queryRaw<{ d: Date; n: bigint }[]>`SELECT ("createdAt" AT TIME ZONE 'UTC')::date AS d, COUNT(*) AS n FROM "Business" WHERE "createdAt" >= ${since} GROUP BY 1`;
    for (const c of counted) { const k = key(c.d); const d = out.get(k) ?? empty(); d.orders = Number(c.n); out.set(k, d); }
    return out;
  }

  private report(days: Map<string, Day>, range: number, labels: [string, string, string, string, string], now: number) {
    const cur = windowOf(days, range, 0, now), prev = windowOf(days, range * 2, range, now);
    const conv = (t: Day) => (t.sessions ? (t.orders / t.sessions) * 100 : 0);
    const size = range <= 30 ? 1 : range <= 90 ? 7 : 30;
    const series = [];
    for (let b = Math.ceil(range / size) - 1; b >= 0; b--) {
      const t = windowOf(days, Math.min(range, (b + 1) * size), b * size, now);
      series.push({ label: new Date(now - b * size * DAY).toLocaleDateString("en-US", size >= 30 ? { month: "short", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" }), visitors: t.visitors, pageViews: t.pageViews });
    }
    return {
      cur,
      body: {
        days: range,
        visitors: { value: cur.visitors, changePct: change(cur.visitors, prev.visitors) },
        sessions: { value: cur.sessions, changePct: change(cur.sessions, prev.sessions) },
        pageViews: { value: cur.pageViews, changePct: change(cur.pageViews, prev.pageViews) },
        conversionRate: { value: conv(cur), changePct: change(conv(cur), conv(prev)) },
        series,
        funnel: [[labels[0], cur.sessions], [labels[1], cur.productViews], [labels[2], cur.addToCart], [labels[3], cur.checkouts], [labels[4], cur.orders]].map(([label, count]) => ({ label, count })),
        pages: ranked(cur.pages).map(([k, v]) => ({ label: PAGE_LABELS[k] ?? k, views: v })),
        sources: ranked(cur.sources).map(([source, sessions]) => ({ source, sessions })),
        devices: ranked(cur.devices).map(([device, sessions]) => ({ device, sessions })),
        countries: ranked(cur.countries).slice(0, 6).map(([country, sessions]) => ({ country, sessions })),
      },
    };
  }

  async business(businessId: string, range: number, now = Date.now()) {
    const days = await this.load(businessId, range, "online-orders", now);
    const { cur, body } = this.report(days, range, ["Visits", "Viewed a product", "Added to cart", "Started checkout", "Placed an order"], now);
    const since = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (range - 1) * DAY);
    const top = ranked(cur.products).slice(0, 8);
    const ids = top.map(([id]) => id);
    const [names, sold] = await Promise.all([
      ids.length ? this.prisma.forBusiness(businessId).product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [],
      ids.length ? this.prisma.orderItem.groupBy({ by: ["productId"], where: { productId: { in: ids }, order: { businessId, channel: "ONLINE", placedAt: { gte: since } } }, _sum: { qty: true } }) : [],
    ]);
    const name = new Map(names.map((p) => [p.id, p.name])), qty = new Map(sold.map((s) => [s.productId, s._sum.qty ?? 0]));
    return { ...body, topProducts: top.map(([id, views]) => ({ id, name: name.get(id) ?? "Removed product", views, orders: qty.get(id) ?? 0 })) };
  }

  async platform(range: number, now = Date.now()) {
    const days = await this.load("platform", range, "signups", now);
    const { body } = this.report(days, range, ["Site visits", "Looked at features or pricing", "Opened sign-up", "Started registration", "Signed up"], now);
    const since = new Date(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (range - 1) * DAY);
    const [traffic, orders, businesses] = await Promise.all([
      this.prisma.analyticsDay.groupBy({ by: ["scope"], where: { scope: { not: "platform" }, date: { gte: since } }, _sum: { visitors: true, sessions: true } }),
      this.prisma.order.groupBy({ by: ["businessId"], where: { channel: "ONLINE", placedAt: { gte: since } }, _count: { _all: true } }),
      this.prisma.business.findMany({ where: { status: { not: "PENDING" } }, select: { id: true, name: true, slug: true } }),
    ]);
    const t = new Map(traffic.map((r) => [r.scope, r._sum])), o = new Map(orders.map((r) => [r.businessId, r._count._all]));
    const rows = businesses.map((b) => {
      const sessions = t.get(b.id)?.sessions ?? 0, n = o.get(b.id) ?? 0;
      return { id: b.id, name: b.name, slug: b.slug, visitors: t.get(b.id)?.visitors ?? 0, sessions, orders: n, conversionRate: sessions ? (n / sessions) * 100 : 0 };
    });
    const tot = rows.reduce((a, x) => ({ visitors: a.visitors + x.visitors, sessions: a.sessions + x.sessions, orders: a.orders + x.orders }), { visitors: 0, sessions: 0, orders: 0 });
    return {
      ...body,
      stores: { ...tot, conversionRate: tot.sessions ? (tot.orders / tot.sessions) * 100 : 0 },
      topStores: rows.sort((a, b) => b.visitors - a.visitors || a.name.localeCompare(b.name)).slice(0, 8),
    };
  }
}
