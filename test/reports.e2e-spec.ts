import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant } from "./helpers";

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY - 60_000);

describe("Overview and sales report", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  let t: Tenant, empty: Tenant;
  const get = (x: Tenant, p: string) => api().get(`/api/v1${p}`).set(...x.auth);

  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    t = await newTenant(api); empty = await newTenant(api);
    const biz = t.businessId;
    const prod = (name: string, over: Record<string, unknown>) => prisma.product.create({ data: { businessId: biz, name, price: 500, stock: 10, status: "ACTIVE", ...over } as never });
    const [p1, , p3, p4] = [
      await prod("Alpha", { sold: 7 }), await prod("Draft", { status: "DRAFT", stock: 0 }), await prod("Gone", { stock: 0, status: "OUT_OF_STOCK" }), await prod("Beta", { stock: 3, sold: 2 }),
    ];
    const c1 = await prisma.customer.create({ data: { businessId: biz, name: "Cee One", email: `c1.${run}@x.com`, createdAt: ago(100) } });
    const c2 = await prisma.customer.create({ data: { businessId: biz, name: "Cee Two", email: `c2.${run}@x.com` } });
    let n = 0;
    const order = (o: Record<string, unknown>, items: { productId: string; name: string; qty: number; price: number }[] = []) =>
      prisma.order.create({ data: { businessId: biz, number: `#T${++n}`, customerName: "x", subtotal: o.total, discount: 0, items: { create: items }, ...o } as never });
    await order({ total: 1000, status: "DELIVERED", paymentStatus: "PAID", channel: "ONLINE", paymentMethod: "CARD", customerId: c1.id, customerName: "Cee One", placedAt: ago(2) }, [{ productId: p1.id, name: "Alpha", qty: 2, price: 500 }]);
    await order({ total: 400, status: "DELIVERED", paymentStatus: "PAID", channel: "IN_STORE", paymentMethod: "CASH", customerId: null, placedAt: ago(40) }, [{ productId: p1.id, name: "Alpha (Large)", qty: 1, price: 400 }]);
    await order({ total: 300, status: "PENDING", paymentStatus: "UNPAID", channel: "ONLINE", paymentMethod: "COD", customerId: c1.id, customerName: "Cee One", placedAt: ago(1) });
    await order({ total: 200, status: "CANCELLED", paymentStatus: "UNPAID", channel: "ONLINE", paymentMethod: "COD", customerId: c1.id, customerName: "Cee One", placedAt: ago(0.5) });
    await order({ total: 600, status: "PROCESSING", paymentStatus: "PAID", channel: "WHATSAPP", paymentMethod: "BANK", customerId: c2.id, customerName: "Cee Two", placedAt: ago(10) }, [{ productId: p4.id, name: "Beta", qty: 3, price: 200 }]);
    void p3;
  });
  afterAll(async () => { await app.close(); });

  it("overview: revenue, trends, status counts and attention signals", async () => {
    const o = (await get(t, "/business/overview").expect(200)).body;
    expect(o).toMatchObject({
      revenue30d: 1600, revenueChangePct: 300, orders30d: 2, ordersChangePct: 100, avgOrderValue: 800,
      customers: 2, newCustomers30d: 1,
      pendingOrders: 1, unpaidOrders: 1, unpaidAmount: 300, fulfilmentRatePct: 50, cancelRatePct: 20, totalOrders: 5,
      outOfStock: 1, lowStockCount: 1, productsTotal: 4, activeProducts: 2, teamSize: 1,
    });
    expect(o.ordersByStatus).toEqual([
      { status: "pending", count: 1 }, { status: "processing", count: 1 }, { status: "shipped", count: 0 },
      { status: "delivered", count: 2 }, { status: "cancelled", count: 1 }, { status: "refunded", count: 0 },
    ]);
    expect(o.revenueSeries).toHaveLength(30);
    expect(o.revenueSeries.reduce((s: number, p: any) => s + p.value, 0)).toBe(1600);
    expect(o.revenueSeries[29].label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(o.topProducts.map((p: any) => p.name)).toEqual(["Alpha", "Beta", "Gone", "Draft"]); // by units sold; ties newest first
    expect(o.topProducts[0]).toMatchObject({ name: "Alpha", sold: 7 });
    expect(o.lowStock.map((p: any) => p.name)).toEqual(["Gone", "Beta"]); // drafts are never "low"
    expect(o.recentOrders).toHaveLength(5);
    expect(o.recentOrders[0].placedAt >= o.recentOrders[1].placedAt).toBe(true);
    expect(o.recentOrders[0].items).toBeDefined();
  });

  it("overview of a brand-new store is all zeros, never NaN", async () => {
    const o = (await get(empty, "/business/overview").expect(200)).body;
    expect(o).toMatchObject({ revenue30d: 0, revenueChangePct: 0, orders30d: 0, avgOrderValue: 0, customers: 0, fulfilmentRatePct: 0, cancelRatePct: 0, totalOrders: 0, teamSize: 1, topProducts: [], lowStock: [], recentOrders: [] });
    expect(JSON.stringify(o)).not.toMatch(/null|NaN/);
  });

  it("sales report (30 days): totals, splits and leaders", async () => {
    const r = (await get(t, "/business/reports/sales").expect(200)).body; // defaults to 30
    expect(r).toMatchObject({ days: 30, revenue: 1600, revenueChangePct: 300, orders: 2, avgOrderValue: 800, outstanding: 300, itemsSold: 5, newCustomers: 1 });
    expect(r.byChannel).toEqual([{ channel: "online", orders: 1, revenue: 1000 }, { channel: "whatsapp", orders: 1, revenue: 600 }]);
    expect(r.byPayment).toEqual([{ method: "card", orders: 1, revenue: 1000 }, { method: "bank", orders: 1, revenue: 600 }]);
    expect(r.topProducts).toEqual([{ name: "Alpha", qty: 2, revenue: 1000 }, { name: "Beta", qty: 3, revenue: 600 }]);
    expect(r.topCustomers).toEqual([expect.objectContaining({ name: "Cee One", orders: 1, revenue: 1000 }), expect.objectContaining({ name: "Cee Two", orders: 1, revenue: 600 })]);
    expect(r.series).toHaveLength(30);
    expect(r.series.reduce((s: number, p: any) => s + p.value, 0)).toBe(1600);
  });

  it("sales report (90 days) picks up older sales, rolls variants into products and skips walk-ins as customers", async () => {
    const r = (await get(t, "/business/reports/sales?days=90").expect(200)).body;
    expect(r).toMatchObject({ days: 90, revenue: 2000, orders: 3, revenueChangePct: 100, itemsSold: 6 });
    expect(r.topProducts[0]).toEqual({ name: "Alpha", qty: 3, revenue: 1400 });
    expect(r.topCustomers.map((c: any) => c.name)).toEqual(["Cee One", "Cee Two"]);
    expect(r.byChannel.map((c: any) => c.channel)).toContain("in_store");
    expect(r.series).toHaveLength(13); // weekly buckets
    expect(r.series.reduce((s: number, p: any) => s + p.value, 0)).toBe(2000);
  });

  it("buckets the other ranges and rejects unsupported ones", async () => {
    expect((await get(t, "/business/reports/sales?days=7").expect(200)).body.series).toHaveLength(7);
    const year = (await get(t, "/business/reports/sales?days=365").expect(200)).body;
    expect(year.series).toHaveLength(13);
    expect(year.revenue).toBe(2000);
    expect((await get(t, "/business/reports/sales?days=45").expect(400)).body.message).toBe("Choose 7, 30, 90 or 365 days.");
    expect((await get(t, "/business/reports/sales?days=abc").expect(400))).toBeTruthy();
  });

  it("only ever reports on the caller's own business", async () => {
    const r = (await get(empty, "/business/reports/sales?days=365").expect(200)).body;
    expect(r).toMatchObject({ revenue: 0, orders: 0, outstanding: 0, itemsSold: 0, topProducts: [], topCustomers: [], byChannel: [] });
    await api().get("/api/v1/business/overview").expect(401);
    await api().get("/api/v1/business/reports/sales").expect(401);
  });
});
