import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant } from "./helpers";

const DAY = 86_400_000;
const midnight = (daysAgo = 0) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - daysAgo * DAY); };

describe("Tracking and analytics", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  let n = 0;
  const id = (p: string) => `${p}-${++n}-${run}-xxxx`;
  const track = (body: object, ua = "Mozilla/5.0 (iPhone)") => api().post("/api/v1/track").set("User-Agent", ua).send(body);
  const mine = (x: Tenant, days = 30) => api().get(`/api/v1/business/analytics?days=${days}`).set(...x.auth);
  const admin = async () => {
    const r = await api().post("/api/v1/auth/login").send({ email: process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@retailr.com", password: process.env.SEED_SUPER_ADMIN_PASSWORD }).expect(200);
    return r.body.accessToken as string;
  };
  const store = async (x: Tenant) => {
    const b = await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } });
    return { id: b.id, slug: b.slug };
  };
  const product = async (x: Tenant, over: Record<string, unknown> = {}) =>
    (await api().post("/api/v1/business/products").set(...x.auth).send({ name: `Item ${++n}`, sku: "", category: "", description: "", price: 100, stock: 50, status: "active", ...over }).expect(201)).body;
  const hit = (scope: string, visitor: string, session: string, events: object[]) => track({ scope, visitorId: visitor, sessionId: session, events });

  beforeAll(async () => { ({ app, prisma, api } = await boot()); });
  afterAll(async () => { await app.close(); });

  it("records a visit and shows it in the dashboard numbers", async () => {
    const x = await newTenant(api); const s = await store(x); const p = await product(x, { name: "Seen product" });
    await hit(s.id, id("v"), id("s"), [
      { type: "page", path: `/s/${s.slug}`, source: "whatsapp", device: "mobile", country: "Nigeria" },
      { type: "page", path: `/s/${s.slug}/shop?sort=new` },
      { type: "product", productId: p.id },
      { type: "add_to_cart" }, { type: "checkout" },
    ]).expect(202);
    const a = (await mine(x, 7).expect(200)).body;
    expect(a).toMatchObject({ days: 7, visitors: { value: 1, changePct: 100 }, sessions: { value: 1 }, pageViews: { value: 2 }, conversionRate: { value: 0 } });
    expect(a.funnel).toEqual([{ label: "Visits", count: 1 }, { label: "Viewed a product", count: 1 }, { label: "Added to cart", count: 1 }, { label: "Started checkout", count: 1 }, { label: "Placed an order", count: 0 }]);
    expect(a.pages).toEqual([{ label: "Home", views: 1 }, { label: "Shop", views: 1 }]);
    expect(a.sources).toEqual([{ source: "whatsapp", sessions: 1 }]);
    expect(a.devices).toEqual([{ device: "mobile", sessions: 1 }]);
    expect(a.countries).toEqual([{ country: "Nigeria", sessions: 1 }]);
    expect(a.topProducts).toEqual([{ id: p.id, name: "Seen product", views: 1, orders: 0 }]);
    expect(a.series).toHaveLength(7);
    expect(a.series[6].visitors).toBe(1);
  });

  it("counts a visitor once a day and a session once, however many batches arrive", async () => {
    const x = await newTenant(api); const s = await store(x);
    const v1 = id("v"), s1 = id("s");
    const page = [{ type: "page", path: "/", source: "direct", device: "desktop", country: "Ghana" }];
    await hit(s.id, v1, s1, page).expect(202);
    await hit(s.id, v1, s1, page).expect(202);                 // same session again
    await hit(s.id, v1, id("s"), page).expect(202);            // same visitor, new session
    await hit(s.id, id("v"), id("s"), page).expect(202);       // a second visitor
    const a = (await mine(x).expect(200)).body;
    expect(a).toMatchObject({ visitors: { value: 2 }, sessions: { value: 3 }, pageViews: { value: 4 } });
    expect(a.sources).toEqual([{ source: "direct", sessions: 3 }]);
  });

  it("doesn't lose or double count when batches arrive at the same moment", async () => {
    const x = await newTenant(api); const s = await store(x);
    const page = [{ type: "page", path: "/shop", source: "search", device: "desktop", country: "Kenya" }, { type: "add_to_cart" }];
    await Promise.all(Array.from({ length: 12 }, () => hit(s.id, id("v"), id("s"), page).expect(202)));
    const sameV = id("v"), sameS = id("s");
    await Promise.all(Array.from({ length: 6 }, () => hit(s.id, sameV, sameS, page).expect(202)));
    const a = (await mine(x).expect(200)).body;
    expect(a.visitors.value).toBe(13);
    expect(a.sessions.value).toBe(13);
    expect(a.pageViews.value).toBe(18); // every page event counts, only visitors and sessions are de-duplicated
    expect(a.funnel[2].count).toBe(18);
    expect(a.pages).toEqual([{ label: "Shop", views: 18 }]);
    expect(a.sources).toEqual([{ source: "search", sessions: 13 }]);
  });

  it("ignores what it shouldn't: unknown or closed stores, bots, other stores' or draft products", async () => {
    const x = await newTenant(api); const s = await store(x); const other = await newTenant(api);
    const draft = await product(x, { status: "draft" }); const foreign = await product(other); const real = await product(x);
    await hit("clzzzzzzzzzzzzzzzzzzzzzzz", id("v"), id("s"), [{ type: "page", path: "/" }]).expect(202);
    await hit(s.id, id("v"), id("s"), [{ type: "page", path: "/" }]);
    await track({ scope: s.id, visitorId: id("v"), sessionId: id("s"), events: [{ type: "page", path: "/" }] }, "Googlebot/2.1").expect(202);
    await hit(s.id, id("v"), id("s"), [{ type: "product", productId: draft.id }, { type: "product", productId: foreign.id }, { type: "product", productId: "nope" }, { type: "product", productId: real.id }]).expect(202);
    const a = (await mine(x).expect(200)).body;
    expect(a.sessions.value).toBe(2); // the real visit and the product visit; the bot and the unknown store left no trace
    expect(a.funnel[1].count).toBe(1);
    expect(a.topProducts.map((t: any) => t.id)).toEqual([real.id]);
    expect((await mine(other).expect(200)).body.sessions.value).toBe(0);
    await prisma.business.update({ where: { id: x.businessId }, data: { status: "SUSPENDED" } });
    await prisma.business.update({ where: { id: other.businessId }, data: { status: "SUSPENDED" } });
    await hit(other.businessId, id("v"), id("s"), [{ type: "page", path: "/" }]).expect(202);
    expect(await prisma.analyticsDay.count({ where: { scope: other.businessId } })).toBe(0);
  });

  it("keeps the stored data bounded: unknown pages become 'Other', odd countries become 'Other'", async () => {
    const x = await newTenant(api); const s = await store(x);
    await hit(s.id, id("v"), id("s"), [
      { type: "page", path: "/random/thing/123", source: "other", device: "tablet", country: "<script>alert(1)</script>" },
      { type: "page", path: "/product/abc" }, { type: "page", path: "/CART/" },
    ]).expect(202);
    const a = (await mine(x).expect(200)).body;
    expect(a.pages.map((p: any) => p.label).sort()).toEqual(["Cart", "Other pages", "Product pages"]);
    expect(a.countries).toEqual([{ country: "Other", sessions: 1 }]);
    const row = await prisma.analyticsDay.findFirstOrThrow({ where: { scope: s.id } });
    expect(JSON.stringify(row.pages)).not.toMatch(/random|123/);
  });

  it("rejects malformed batches", async () => {
    const x = await newTenant(api); const s = await store(x);
    const base = { scope: s.id, visitorId: id("v"), sessionId: id("s") };
    await track({ ...base, events: [] }).expect(400);
    await track({ ...base, events: Array.from({ length: 51 }, () => ({ type: "page" })) }).expect(400);
    await track({ ...base, events: [{ type: "explode" }] }).expect(400);
    await track({ ...base, events: [{ type: "page", source: "tv" }] }).expect(400);
    await track({ ...base, events: [{ type: "page", device: "fridge" }] }).expect(400);
    await track({ ...base, visitorId: "x", events: [{ type: "page" }] }).expect(400);
    await track({ events: [{ type: "page" }] }).expect(400);
    await track({ ...base, events: Array.from({ length: 50 }, () => ({ type: "page" })) }).expect(202);
  });

  it("measures conversion from real online orders, and top products by units sold online", async () => {
    const x = await newTenant(api); const s = await store(x); const p = await product(x, { name: "Hot item" });
    const v = id("v");
    for (let i = 0; i < 4; i++) await hit(s.id, i ? id("v") : v, id("s"), [{ type: "page", path: "/" }, { type: "product", productId: p.id }]).expect(202);
    const buy = (qty: number) => api().post(`/api/v1/store/${s.slug}/orders`).send({ customer: { name: "A B", email: `ab${++n}@example.com`, phone: "1" }, shippingAddress: "x", paymentMethod: "cod", items: [{ productId: p.id, qty }] }).expect(201);
    await buy(2); await buy(1);
    await api().post("/api/v1/business/sales").set(...x.auth).send({ items: [{ productId: p.id, qty: 5 }], channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true }).expect(201); // not an online order
    const a = (await mine(x).expect(200)).body;
    expect(a.funnel[4]).toEqual({ label: "Placed an order", count: 2 });
    expect(a.conversionRate.value).toBe(50); // 2 orders / 4 sessions
    expect(a.topProducts[0]).toEqual({ id: p.id, name: "Hot item", views: 4, orders: 3 });
  });

  it("compares with the previous period and buckets the series", async () => {
    const x = await newTenant(api);
    const day = (ago: number, visitors: number, sessions: number, pageViews: number) => prisma.analyticsDay.create({ data: { scope: x.businessId, date: midnight(ago), visitors, sessions, pageViews, sources: { direct: sessions }, countries: { Nigeria: sessions } } });
    await day(3, 10, 12, 30);   // this week
    await day(10, 5, 6, 10);    // the week before
    await day(20, 100, 100, 100); // outside a 7-day view and its comparison
    const w = (await mine(x, 7).expect(200)).body;
    expect(w.visitors).toEqual({ value: 10, changePct: 100 });
    expect(w.sessions.changePct).toBe(100);
    expect(w.pageViews.changePct).toBe(200);
    expect(w.series.reduce((s: number, p: any) => s + p.visitors, 0)).toBe(10);
    const m = (await mine(x, 30).expect(200)).body;
    expect(m.visitors.value).toBe(115);
    expect(m.series).toHaveLength(30);
    expect((await mine(x, 90).expect(200)).body.series).toHaveLength(13);
    expect((await mine(x, 365).expect(200)).body.series).toHaveLength(13);
    expect((await mine(x, 90).expect(200)).body.series.reduce((s: number, p: any) => s + p.visitors, 0)).toBe(115);
    expect((await mine(x).expect(200)).body.days).toBe(30);
    expect((await mine(x, 45).expect(400)).body.message).toBe("Choose 7, 30, 90 or 365 days.");
    const empty = (await mine(await newTenant(api), 30).expect(200)).body;
    expect(empty).toMatchObject({ visitors: { value: 0, changePct: 0 }, conversionRate: { value: 0 }, pages: [], sources: [], topProducts: [] });
    await api().get("/api/v1/business/analytics").expect(401);
  });

  describe("platform", () => {
    it("tracks the marketing site and counts real sign-ups as the last funnel step", async () => {
      const token = await admin(); const get = (d = 30) => api().get(`/api/v1/platform/analytics?days=${d}`).set("Authorization", `Bearer ${token}`);
      const before = (await get().expect(200)).body;
      await hit("platform", id("v"), id("s"), [{ type: "page", path: "/", source: "search", device: "desktop", country: "Nigeria" }, { type: "page", path: "/pricing" }, { type: "product" }, { type: "page", path: "/get-started" }]).expect(202);
      await newTenant(api);
      const after = (await get().expect(200)).body;
      expect(after.visitors.value).toBe(before.visitors.value + 1);
      expect(after.funnel.map((f: any) => f.label)).toEqual(["Site visits", "Looked at features or pricing", "Opened sign-up", "Started registration", "Signed up"]);
      expect(after.funnel[4].count).toBe(before.funnel[4].count + 1);
      expect(after.pages.find((p: any) => p.label === "Pricing").views).toBe((before.pages.find((p: any) => p.label === "Pricing")?.views ?? 0) + 1);
      expect(after.series).toHaveLength(30);
    });

    it("totals every storefront and lists the busiest, leaving out stores that never opened", async () => {
      const token = await admin(); const get = () => api().get("/api/v1/platform/analytics?days=30").set("Authorization", `Bearer ${token}`);
      const busy = await newTenant(api), pending = await newTenant(api);
      await prisma.business.update({ where: { id: pending.businessId }, data: { status: "PENDING" } });
      await prisma.analyticsDay.create({ data: { scope: busy.businessId, date: midnight(1), visitors: 900000, sessions: 1000000, pageViews: 1 } });
      await prisma.analyticsDay.create({ data: { scope: pending.businessId, date: midnight(1), visitors: 1, sessions: 1, pageViews: 1 } });
      const a = (await get().expect(200)).body;
      expect(a.topStores[0]).toMatchObject({ id: busy.businessId, visitors: 900000, sessions: 1000000, orders: 0, conversionRate: 0 });
      expect(a.topStores.some((s: any) => s.id === pending.businessId)).toBe(false);
      expect(a.stores.sessions).toBeGreaterThanOrEqual(1000000);
      expect(a.topStores.length).toBeLessThanOrEqual(8);
      await prisma.analyticsDay.deleteMany({ where: { scope: busy.businessId } }); // keep other tests' totals tidy
    });

    it("is for the platform owner only", async () => {
      const x = await newTenant(api);
      await api().get("/api/v1/platform/analytics").set(...x.auth).expect(403);
      await api().get("/api/v1/platform/analytics").expect(401);
      const token = await admin();
      await api().get("/api/v1/platform/analytics?days=3").set("Authorization", `Bearer ${token}`).expect(400);
    });
  });
});
