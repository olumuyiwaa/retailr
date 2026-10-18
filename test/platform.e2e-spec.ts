import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant } from "./helpers";

describe("Platform admin", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  let admin: Tenant;
  let n = 0;
  const A = {
    get: (p: string) => api().get(`/api/v1${p}`).set(...admin.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...admin.auth).send(b),
    put: (p: string, b: object) => api().put(`/api/v1${p}`).set(...admin.auth).send(b),
    patch: (p: string, b: object) => api().patch(`/api/v1${p}`).set(...admin.auth).send(b),
    del: (p: string) => api().delete(`/api/v1${p}`).set(...admin.auth),
  };
  const B = (x: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...x.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...x.auth).send(b),
  });
  const slugOf = async (x: Tenant) => (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
  const nameOf = async (x: Tenant) => (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).name;

  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    const r = await api().post("/api/v1/auth/login").send({ email: process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@retailr.com", password: process.env.SEED_SUPER_ADMIN_PASSWORD }).expect(200);
    admin = { businessId: "", token: r.body.accessToken, auth: ["Authorization", `Bearer ${r.body.accessToken}`], email: "" };
  });
  afterAll(async () => { await app.close(); });

  it("is for the platform owner only", async () => {
    const biz = await newTenant(api);
    for (const p of ["/platform/overview", "/platform/businesses", "/platform/subscriptions", "/platform/invoices", "/platform/plans", "/platform/plan-coupons"]) {
      await B(biz).get(p).expect(403);
      await api().get(`/api/v1${p}`).expect(401);
    }
    await B(biz).post("/platform/plan-coupons", { code: "HACK", type: "percent", value: 100 }).expect(403);
    await api().patch("/api/v1/platform/businesses/x/status").set(...biz.auth).send({ status: "active" }).expect(403);
  });

  describe("overview", () => {
    it("moves with real businesses, subscriptions and sales", async () => {
      const before = (await A.get("/platform/overview").expect(200)).body;
      expect(before.mrrSeries).toHaveLength(12);
      expect(before.signupSeries).toHaveLength(12);
      expect(before.mrrSeries[11].label).toBe(new Date().toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }));

      const x = await newTenant(api, { planId: "plan_scale" }); // trialing: not in MRR yet
      const afterSignup = (await A.get("/platform/overview").expect(200)).body;
      expect(afterSignup.mrr).toBe(before.mrr);
      expect(afterSignup.trialBusinesses).toBe(before.trialBusinesses + 1);
      expect(afterSignup.newSignups30d).toBe(before.newSignups30d + 1);
      expect(afterSignup.signupSeries[11].value).toBe(before.signupSeries[11].value + 1);
      expect(afterSignup.recentSignups[0]).toMatchObject({ id: x.businessId, status: "trial", stats: { products: 0, orders: 0, customers: 0, revenue: 0 } });
      expect(afterSignup.recentSignups.length).toBeLessThanOrEqual(6);

      await A.patch(`/platform/businesses/${x.businessId}/status`, { status: "active" }).expect(200); // now paying
      const paying = (await A.get("/platform/overview").expect(200)).body;
      expect(paying.mrr).toBe(before.mrr + 15);
      expect(paying.activeBusinesses).toBe(before.activeBusinesses + 1);
      expect(paying.trialBusinesses).toBe(before.trialBusinesses);
      expect(paying.mrrSeries[11].value).toBe(before.mrrSeries[11].value + 15);
      const dist = (o: any) => o.planDistribution.find((p: any) => p.planId === "plan_scale").count;
      expect(dist(paying)).toBe(dist(before) + 1);

      // sales count toward GMV in USD (NGN at 1500 per USD)
      await prisma.order.create({ data: { businessId: x.businessId, number: "#GM1", customerName: "A", subtotal: 15000, total: 15000, paymentStatus: "PAID", status: "DELIVERED" } as never });
      expect((await A.get("/platform/overview").expect(200)).body.gmv).toBe(before.gmv + 10);

      await A.patch(`/platform/businesses/${x.businessId}/status`, { status: "cancelled" }).expect(200);
      const gone = (await A.get("/platform/overview").expect(200)).body;
      expect(gone.mrr).toBe(before.mrr);
      expect(gone.churnRatePct).toBeGreaterThan(0);
      expect(dist(gone)).toBe(dist(before));
    });

    it("lists the latest invoices", async () => {
      const x = await newTenant(api);
      await prisma.invoice.create({ data: { businessId: x.businessId, planId: "plan_growth", description: `Latest ${run}`, amount: 6, status: "PAID", paidAt: new Date() } });
      const o = (await A.get("/platform/overview").expect(200)).body;
      expect(o.recentInvoices[0]).toMatchObject({ description: `Latest ${run}`, status: "paid" });
      expect(o.recentInvoices.length).toBeLessThanOrEqual(6);
    });
  });

  describe("businesses", () => {
    it("lists with filters, paging and the plan, mrr and stats of each row", async () => {
      const x = await newTenant(api, { planId: "plan_growth", businessName: `Findable ${run}` });
      const y = await newTenant(api, { planId: "plan_starter", businessName: `Findable ${run} Two` });
      await A.patch(`/platform/businesses/${x.businessId}/status`, { status: "active" }).expect(200);
      const r = await A.get(`/platform/businesses?q=findable%20${run}`).expect(200);
      expect(r.headers["x-total-count"]).toBe("2");
      const row = r.body.find((b: any) => b.id === x.businessId);
      expect(row).toMatchObject({ planName: "Growth", mrr: 6, status: "active", stats: { products: 0, orders: 0, customers: 0, revenue: 0 } });
      expect(r.body.find((b: any) => b.id === y.businessId)).toMatchObject({ planName: "Starter", mrr: 0, status: "trial" }); // trials aren't revenue yet
      expect((await A.get(`/platform/businesses?q=${run}&status=trial`).expect(200)).body.some((b: any) => b.id === x.businessId)).toBe(false);
      expect((await A.get(`/platform/businesses?q=${run}&planId=plan_starter`).expect(200)).body.map((b: any) => b.id)).toEqual([y.businessId]);
      expect((await A.get(`/platform/businesses?q=${run}&limit=1&page=2`).expect(200)).body).toHaveLength(1);
      expect((await A.get(`/platform/businesses?q=${(await slugOf(x)).slice(0, 12)}`).expect(200)).body.some((b: any) => b.id === x.businessId)).toBe(true);
      expect((await A.get("/platform/businesses?status=weird").expect(400))).toBeTruthy();
      expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|orderSeq/);
    });

    it("shows a business's detail with its plan, subscription, team and last 30 days", async () => {
      const x = await newTenant(api);
      const slug = await slugOf(x);
      const p = (await B(x).post("/business/products", { name: "P", sku: "", category: "", description: "", price: 100, stock: 5, status: "active" }).expect(201)).body;
      await api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "A B", email: "ab@example.com", phone: "1" }, shippingAddress: "x", paymentMethod: "card", items: [{ productId: p.id, qty: 2 }] }).expect(201);
      await prisma.order.updateMany({ where: { businessId: x.businessId }, data: {} });
      await prisma.order.create({ data: { businessId: x.businessId, number: "#OLD1", customerName: "Old", subtotal: 500, total: 500, paymentStatus: "PAID", placedAt: new Date(Date.now() - 45 * 86_400_000) } as never });
      const d = (await A.get(`/platform/businesses/${x.businessId}`).expect(200)).body;
      expect(d.business).toMatchObject({ id: x.businessId, ownerEmail: x.email, stats: { products: 1, orders: 2, customers: 1, revenue: 700 } });
      expect(d.plan.id).toBe("plan_growth");
      expect(d.subscription).toMatchObject({ planId: "plan_growth", status: "trialing" });
      expect(d.team).toEqual([expect.objectContaining({ role: "owner" })]);
      expect(d).toMatchObject({ orders30d: 1, revenue30d: 200, invoices: [] }); // the 45-day-old sale is outside the window
      await A.get("/platform/businesses/nope").expect(404);
    });

    it("suspending cuts access at once, reinstating restores it, and cancelling is recorded", async () => {
      const x = await newTenant(api);
      const email = x.email;
      const slug = await slugOf(x);
      await B(x).get("/business/profile").expect(200);
      const s = (await A.patch(`/platform/businesses/${x.businessId}/status`, { status: "suspended" }).expect(200)).body;
      expect(s.status).toBe("suspended");
      expect((await prisma.subscription.findUniqueOrThrow({ where: { businessId: x.businessId } })).status).toBe("PAST_DUE");
      await B(x).get("/business/profile").expect(403); // the token they already hold stops working
      await api().get(`/api/v1/store/${slug}`).expect(404);
      await api().post("/api/v1/auth/login").send({ email, password: "password123" }).expect(403);

      await A.patch(`/platform/businesses/${x.businessId}/status`, { status: "cancelled" }).expect(200);
      const cancelled = await prisma.subscription.findUniqueOrThrow({ where: { businessId: x.businessId } });
      expect(cancelled.status).toBe("CANCELLED"); expect(cancelled.cancelledAt).toBeTruthy();

      const back = (await A.patch(`/platform/businesses/${x.businessId}/status`, { status: "active" }).expect(200)).body;
      expect(back.status).toBe("active");
      const re = await prisma.subscription.findUniqueOrThrow({ where: { businessId: x.businessId } });
      expect(re.status).toBe("ACTIVE"); expect(re.cancelledAt).toBeNull();
      await api().post("/api/v1/auth/login").send({ email, password: "password123" }).expect(200);
      await api().get(`/api/v1/store/${slug}`).expect(200);
      await A.patch(`/platform/businesses/${x.businessId}/status`, { status: "bogus" }).expect(400);
      await A.patch("/platform/businesses/nope/status", { status: "active" }).expect(404);
    });
  });

  describe("subscriptions and invoices", () => {
    it("lists subscriptions with business, plan and discount", async () => {
      const x = await newTenant(api, { businessName: `Subs ${run}` });
      const code = `SUB${run}`.toUpperCase();
      await prisma.planCoupon.create({ data: { code, type: "FIXED", value: 2 } });
      await B(x).post("/business/billing/change-plan", { planId: "plan_growth", cycle: "monthly", couponCode: code }).expect(200);
      const r = await A.get(`/platform/subscriptions?q=subs%20${run}`).expect(200);
      expect(r.headers["x-total-count"]).toBe("1");
      expect(r.body[0]).toMatchObject({ businessName: `Subs ${run}`, planName: "Growth", couponCode: code, discount: 2, amount: 4, status: "trialing", cycle: "monthly" });
      expect((await A.get(`/platform/subscriptions?q=subs%20${run}&status=active`).expect(200)).body).toEqual([]);
      await A.get("/platform/subscriptions?status=odd").expect(400);
    });

    it("lists invoices with the business name, filterable by status and text", async () => {
      const x = await newTenant(api, { businessName: `Inv ${run}` });
      const mk = (status: string, description: string) => prisma.invoice.create({ data: { businessId: x.businessId, planId: "plan_growth", description, amount: 6, status: status as never } });
      await mk("PAID", `Paid one ${run}`); await mk("FAILED", `Failed one ${run}`);
      const all = await A.get(`/platform/invoices?q=inv%20${run}`).expect(200);
      expect(all.body).toHaveLength(2);
      expect(all.body[0].businessName).toBe(`Inv ${run}`);
      expect((await A.get(`/platform/invoices?q=${run}&status=failed`).expect(200)).body.map((i: any) => i.description)).toEqual([`Failed one ${run}`]);
      expect((await A.get(`/platform/invoices?q=paid%20one%20${run}`).expect(200)).body).toHaveLength(1);
      expect(all.headers["x-total-count"]).toBe("2");
    });
  });

  describe("plans", () => {
    const plan = (over: Record<string, unknown> = {}) => ({
      name: `Plan ${run}`, description: " Nice ", priceMonthly: 10, priceYearly: 100, transactionFeePct: 1.5,
      limits: { products: 100, staff: 3, ordersPerMonth: -1, storageGb: 5 }, features: [" One ", "", "Two"], highlighted: true, isActive: true,
      localPrices: { NGN: { monthly: 15000, yearly: 150000 } }, ...over,
    });

    it("lists plans with their subscriber counts", async () => {
      const list = (await A.get("/platform/plans").expect(200)).body;
      expect(list.filter((p: any) => p.id.startsWith("plan_")).map((p: any) => p.id)).toEqual(["plan_basic", "plan_starter", "plan_growth", "plan_scale"]);
      const growth = list.find((p: any) => p.id === "plan_growth");
      expect(growth).toMatchObject({ limits: { products: 1500 }, subscribers: expect.any(Number) });
      const x = await newTenant(api, { planId: "plan_growth" });
      const after = (await A.get("/platform/plans").expect(200)).body.find((p: any) => p.id === "plan_growth");
      expect(after.subscribers).toBe(growth.subscribers + 1);
      await A.patch(`/platform/businesses/${x.businessId}/status`, { status: "cancelled" }).expect(200);
      expect((await A.get("/platform/plans").expect(200)).body.find((p: any) => p.id === "plan_growth").subscribers).toBe(growth.subscribers);
    });

    it("creates a plan, edits it, and leaves existing subscriptions' prices alone", async () => {
      const id = `plat_${run}`;
      const c = (await A.put(`/platform/plans/${id}`, plan()).expect(200)).body;
      expect(c).toMatchObject({ id, name: `Plan ${run}`, description: "Nice", priceMonthly: 10, priceYearly: 100, transactionFeePct: 1.5, features: ["One", "Two"], highlighted: true, isActive: true, limits: { products: 100, staff: 3, ordersPerMonth: -1, storageGb: 5 }, localPrices: { NGN: { monthly: 15000, yearly: 150000 } } });
      expect((await api().get("/api/v1/plans").expect(200)).body.some((p: any) => p.id === id)).toBe(true); // public pricing now shows it
      const x = await newTenant(api, { planId: id });
      const u = (await A.put(`/platform/plans/${id}`, plan({ priceMonthly: 20, isActive: false })).expect(200)).body;
      expect(u).toMatchObject({ priceMonthly: 20, isActive: false });
      expect((await api().get("/api/v1/plans").expect(200)).body.some((p: any) => p.id === id)).toBe(false);
      expect(Number((await prisma.subscription.findUniqueOrThrow({ where: { businessId: x.businessId } })).amount)).toBe(10);
    });

    it("refuses nonsense in the UI's words", async () => {
      const bad = async (over: Record<string, unknown>, id = `plat_${run}`) => (await A.put(`/platform/plans/${id}`, plan(over)).expect(400)).body.message;
      expect(await bad({ name: "   " })).toBe("Enter a plan name.");
      expect(await bad({ priceMonthly: -1 })).toBe("Prices can't be negative.");
      expect(await bad({ priceYearly: -5 })).toBe("Prices can't be negative.");
      expect(await bad({ limits: { products: 1.5, staff: 1, ordersPerMonth: 1, storageGb: 1 } })).toBe("Limits must be whole numbers, or -1 for unlimited.");
      expect(await bad({ limits: { products: -2, staff: 1, ordersPerMonth: 1, storageGb: 1 } })).toBe("Limits must be whole numbers, or -1 for unlimited.");
      expect(await bad({ transactionFeePct: 101 })).toBe("The transaction fee must be between 0 and 100%.");
      expect(await bad({ localPrices: { EUR: { monthly: 1, yearly: 1 } } })).toBe("Enter valid local prices.");
      expect(await bad({}, "Bad Id!")).toMatch(/plan id/);
    });
  });

  describe("discount codes", () => {
    const code = (s: string) => `${s}${++n}${run}`.toUpperCase();
    const body = (over: Record<string, unknown> = {}) => ({ code: code("PC"), type: "percent", value: 20, ...over });

    it("creates, edits, disables and deletes codes", async () => {
      const biz = await newTenant(api, { businessName: `Target ${run}` });
      const c = (await A.post("/platform/plan-coupons", body({ code: ` ${code("lo")} `, planIds: ["plan_growth", "plan_scale"], businessId: biz.businessId, maxUses: 3, note: " Launch ", expiresAt: new Date(Date.now() + 86_400_000).toISOString() })).expect(201)).body;
      expect(c).toMatchObject({ type: "percent", value: 20, maxUses: 3, usedCount: 0, redeemed: 0, discountPerMonth: 0, status: "active", note: "Launch", businessId: biz.businessId, businessName: `Target ${run}`, planNames: ["Growth", "Scale"].sort((a, b) => 0) });
      expect(c.planIds.sort()).toEqual(["plan_growth", "plan_scale"]);
      expect(c.code).toBe(c.code.toUpperCase());

      const u = (await A.put(`/platform/plan-coupons/${c.id}`, { code: c.code, type: "fixed", value: 3 }).expect(200)).body;
      expect(u).toMatchObject({ type: "fixed", value: 3, planNames: [] });
      expect(u.planIds).toBeUndefined(); expect(u.businessId).toBeUndefined(); expect(u.maxUses).toBeUndefined(); // PUT replaces
      expect((await A.patch(`/platform/plan-coupons/${c.id}/status`, { status: "disabled" }).expect(200)).body.status).toBe("disabled");
      await A.patch(`/platform/plan-coupons/${c.id}/status`, { status: "nope" }).expect(400);
      expect((await A.get("/platform/plan-coupons").expect(200)).body.some((x: any) => x.id === c.id)).toBe(true);
      await A.del(`/platform/plan-coupons/${c.id}`).expect(204);
      await A.del(`/platform/plan-coupons/${c.id}`).expect(204);
      await A.put(`/platform/plan-coupons/${c.id}`, body()).expect(404);
      await A.patch(`/platform/plan-coupons/${c.id}/status`, { status: "active" }).expect(404);
    });

    it("explains problems in the UI's words", async () => {
      const bad = async (over: Record<string, unknown>, status = 400) => (await A.post("/platform/plan-coupons", body(over)).expect(status)).body.message;
      expect(await bad({ code: "ab" })).toBe("Use 3–20 letters, numbers or dashes for the code.");
      expect(await bad({ value: 0 })).toBe("Enter a discount greater than zero.");
      expect(await bad({ value: 101 })).toBe("A percentage can't be more than 100.");
      expect(await bad({ maxUses: 0 })).toBe("Max uses must be at least 1.");
      expect(await bad({ planIds: ["nope"] })).toBe("Choose valid plans.");
      expect(await bad({ businessId: "nope" })).toBe("That business no longer exists.");
      expect(await bad({ expiresAt: "soon" })).toBe("Enter a valid expiry date.");
      const first = (await A.post("/platform/plan-coupons", body()).expect(201)).body;
      expect(await bad({ code: first.code.toLowerCase() }, 409)).toBe("There is already a code with that name.");
      const other = (await A.post("/platform/plan-coupons", body()).expect(201)).body;
      expect((await A.put(`/platform/plan-coupons/${other.id}`, body({ code: first.code })).expect(409)).body.code).toBe("COUPON_EXISTS");
      await A.post("/platform/plan-coupons", body({ type: "fixed", value: 500 })).expect(201); // fixed amounts may exceed 100
    });

    it("tracks who redeemed it and what it costs per month, and deleting it leaves their price alone", async () => {
      const c = (await A.post("/platform/plan-coupons", body({ type: "fixed", value: 12 })).expect(201)).body;
      const monthly = await newTenant(api), yearly = await newTenant(api);
      await B(monthly).post("/business/billing/change-plan", { planId: "plan_growth", cycle: "monthly", couponCode: c.code }).expect(200);
      await B(yearly).post("/business/billing/change-plan", { planId: "plan_growth", cycle: "yearly", couponCode: c.code }).expect(200);
      const row = (await A.get("/platform/plan-coupons").expect(200)).body.find((x: any) => x.id === c.id);
      expect(row).toMatchObject({ redeemed: 2, usedCount: 2, discountPerMonth: 7 }); // monthly: $12 capped at the $6 price = 6; yearly: $12 off $60 = 12 / 12 = 1
      await A.patch(`/platform/businesses/${yearly.businessId}/status`, { status: "cancelled" }).expect(200);
      expect((await A.get("/platform/plan-coupons").expect(200)).body.find((x: any) => x.id === c.id).discountPerMonth).toBe(6); // cancelled subscriptions no longer cost anything

      await A.del(`/platform/plan-coupons/${c.id}`).expect(204);
      const s = (await B(monthly).get("/business/billing").expect(200)).body.subscription;
      expect(s).toMatchObject({ amount: 0, discount: 6 }); // the code is gone but the discount already in the price stays
      expect(s.couponCode).toBeUndefined();
    });

    it("a disabled code stops working for new sign-ups", async () => {
      const c = (await A.post("/platform/plan-coupons", body()).expect(201)).body;
      await api().post("/api/v1/plan-coupons/validate").send({ code: c.code, planId: "plan_growth" }).expect(200);
      await A.patch(`/platform/plan-coupons/${c.id}/status`, { status: "disabled" }).expect(200);
      expect((await api().post("/api/v1/plan-coupons/validate").send({ code: c.code, planId: "plan_growth" }).expect(400)).body.message).toBe("That discount code isn't valid.");
    });
  });
});
