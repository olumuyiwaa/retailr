import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { StorageService } from "../src/storage/storage.service";
import { boot, newTenant, run, Tenant, uploadImage } from "./helpers";

describe("Billing", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  let n = 0;
  const S = (x: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...x.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...x.auth).send(b),
  });
  const change = (x: Tenant, body: object) => S(x).post("/business/billing/change-plan", body);
  const code = (s: string) => `${s}${++n}${run}`.toUpperCase();
  const mkCode = (over: Record<string, unknown> = {}) =>
    prisma.planCoupon.create({ data: { code: code("BC"), type: "PERCENT", value: 50, ...over } as never });
  const sub = (x: Tenant) => prisma.subscription.findUniqueOrThrow({ where: { businessId: x.businessId } });

  beforeAll(async () => { ({ app, prisma, api } = await boot()); });
  afterAll(async () => { await app.close(); });

  describe("billing view", () => {
    it("shows plan, subscription, usage, invoices and the plans on offer", async () => {
      const x = await newTenant(api); const sx = S(x);
      await sx.post("/business/products", { name: "P", sku: "", category: "", description: "", price: 10, stock: 5, status: "active" }).expect(201);
      const b = (await sx.get("/business/billing").expect(200)).body;
      expect(b.plan).toMatchObject({ id: "plan_growth", name: "Growth", limits: { products: 1500, staff: 5, ordersPerMonth: 2000, storageGb: 10 } });
      expect(b.subscription).toMatchObject({ planId: "plan_growth", status: "trialing", cycle: "monthly", amount: 6 });
      expect(b.subscription.couponCode).toBeUndefined();
      expect(b.usage).toEqual({ products: { used: 1, limit: 1500 }, staff: { used: 1, limit: 5 }, ordersThisMonth: { used: 0, limit: 2000 }, storageGb: { used: 0, limit: 10 } });
      expect(b.invoices).toEqual([]);
      expect(b.plans.map((p: any) => p.id).filter((id: string) => id.startsWith("plan_"))).toEqual(["plan_basic", "plan_starter", "plan_growth", "plan_scale"]); // cheapest first (other tests leave plans behind)
      await api().get("/api/v1/business/billing").expect(401);
    });

    it("counts this month's orders and the real size of uploaded files", async () => {
      const x = await newTenant(api); const sx = S(x);
      const p = (await sx.post("/business/products", { name: "P", sku: "", category: "", description: "", price: 10, stock: 5, status: "active" }).expect(201)).body;
      const slug = (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
      await api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "A B", email: "ab@example.com", phone: "1" }, shippingAddress: "x", paymentMethod: "cod", items: [{ productId: p.id, qty: 1 }] }).expect(201);
      await prisma.order.updateMany({ where: { businessId: x.businessId }, data: { placedAt: new Date(Date.now() - 70 * 86_400_000) } });
      await api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "A B", email: "ab@example.com", phone: "1" }, shippingAddress: "x", paymentMethod: "cod", items: [{ productId: p.id, qty: 1 }] }).expect(201);
      expect((await sx.get("/business/billing").expect(200)).body.usage.ordersThisMonth.used).toBe(1);

      const storage = app.get(StorageService);
      expect(await storage.usageBytes(x.businessId)).toBe(0);
      await uploadImage(api, x, "product", Buffer.alloc(1500, 1));
      await uploadImage(api, x, "logo", Buffer.alloc(2500, 2));
      expect(await storage.usageBytes(x.businessId)).toBe(4000);
      const other = await newTenant(api);
      expect(await storage.usageBytes(other.businessId)).toBe(0); // other tenants' files don't count
      expect(await storage.usageBytes("../")).toBe(0);
    });

    it("lists only the business's own invoices, newest first", async () => {
      const x = await newTenant(api), y = await newTenant(api);
      const mk = (b: Tenant, d: number, description: string) => prisma.invoice.create({ data: { businessId: b.businessId, planId: "plan_growth", description, amount: 6, status: "PAID", issuedAt: new Date(Date.now() - d * 86_400_000), paidAt: new Date() } });
      await mk(x, 40, "Old"); await mk(x, 5, "New"); await mk(y, 1, "Theirs");
      const inv = (await S(x).get("/business/billing").expect(200)).body.invoices;
      expect(inv.map((i: any) => i.description)).toEqual(["New", "Old"]);
      expect(inv[0]).toMatchObject({ status: "paid", amount: 6, planId: "plan_growth", businessId: x.businessId });
      expect(inv[0].paidAt).toBeTruthy();
    });
  });

  describe("changing plan", () => {
    it("switches plan and cycle and prices them", async () => {
      const x = await newTenant(api);
      const r = (await change(x, { planId: "plan_scale", cycle: "yearly" }).expect(200)).body;
      expect(r.plan.id).toBe("plan_scale");
      expect(r.subscription).toMatchObject({ planId: "plan_scale", cycle: "yearly", amount: 150, status: "trialing" });
      expect((await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).planId).toBe("plan_scale");
      expect((await change(x, { planId: "plan_starter", cycle: "monthly" }).expect(200)).body.subscription.amount).toBe(3);
    });

    it("moving to a free plan makes the subscription active, ends the trial and activates the business", async () => {
      const x = await newTenant(api);
      const c = await mkCode();
      await change(x, { planId: "plan_growth", cycle: "monthly", couponCode: c.code }).expect(200);
      const r = (await change(x, { planId: "plan_basic", cycle: "monthly" }).expect(200)).body;
      expect(r.subscription).toMatchObject({ status: "active", amount: 0 });
      expect(r.subscription.trialEndsAt).toBeUndefined();
      expect(r.subscription.couponCode).toBeUndefined(); // the discount goes with the old plan
      expect((await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).status).toBe("ACTIVE");
      const e = (await change(x, { planId: "plan_basic", cycle: "monthly", couponCode: c.code }).expect(400)).body;
      expect(e.message).toBe("Discount codes only apply to paid plans.");
    });

    it("applies a code, records one redemption, and shows the discount", async () => {
      const x = await newTenant(api);
      const c = await mkCode({ type: "FIXED", value: 2 });
      const r = (await change(x, { planId: "plan_growth", cycle: "monthly", couponCode: ` ${c.code.toLowerCase()} ` }).expect(200)).body;
      expect(r.subscription).toMatchObject({ amount: 4, discount: 2, couponCode: c.code });
      expect(await prisma.planCouponRedemption.count({ where: { planCouponId: c.id } })).toBe(1);
      // yearly keeps the same code (still one redemption) and prices off the yearly list price
      const y = (await change(x, { planId: "plan_growth", cycle: "yearly" }).expect(200)).body;
      expect(y.subscription).toMatchObject({ amount: 58, discount: 2, couponCode: c.code });
      expect(await prisma.planCouponRedemption.count({ where: { planCouponId: c.id } })).toBe(1);
      // a discount can never take the price below zero
      const big = await mkCode({ type: "FIXED", value: 100 });
      expect((await change(x, { planId: "plan_starter", cycle: "monthly", couponCode: big.code }).expect(200)).body.subscription).toMatchObject({ amount: 0, discount: 3 });
    });

    it("a bad code changes nothing and says why, in the documented order", async () => {
      const x = await newTenant(api); const y = await newTenant(api);
      const before = await sub(x);
      const bad = async (couponCode: string, planId = "plan_starter") => (await change(x, { planId, cycle: "monthly", couponCode }).expect(400)).body.message;
      expect(await bad("NOPE")).toBe("That discount code isn't valid.");
      const off = await mkCode({ status: "DISABLED" });
      expect(await bad(off.code)).toBe("That discount code isn't valid.");
      const old = await mkCode({ expiresAt: new Date(Date.now() - 1000) });
      expect(await bad(old.code)).toBe("That discount code has expired.");
      const mine = await mkCode({ businessId: y.businessId });
      expect(await bad(mine.code)).toBe("That discount code isn't valid for this business.");
      const only = await mkCode({ plans: { create: [{ planId: "plan_scale" }] } });
      expect(await bad(only.code)).toBe("That code only works on the Scale plan.");
      const after = await sub(x);
      expect(after).toMatchObject({ planId: before.planId, cycle: before.cycle });
      expect(Number(after.amount)).toBe(Number(before.amount));
      expect((await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).planId).toBe(before.planId);
      // the business-only code works for its own business
      await change(y, { planId: "plan_starter", cycle: "monthly", couponCode: mine.code }).expect(200);
    });

    it("drops a discount when the plan changes without a code, and a carried code that no longer works", async () => {
      const x = await newTenant(api);
      const c = await mkCode({ plans: { create: [{ planId: "plan_growth" }] } });
      await change(x, { planId: "plan_growth", cycle: "monthly", couponCode: c.code }).expect(200);
      const moved = (await change(x, { planId: "plan_starter", cycle: "monthly" }).expect(200)).body;
      expect(moved.subscription.couponCode).toBeUndefined(); expect(moved.subscription.amount).toBe(3);
      await change(x, { planId: "plan_growth", cycle: "monthly", couponCode: c.code }).expect(200);
      await prisma.planCoupon.update({ where: { id: c.id }, data: { status: "DISABLED" } });
      const quiet = (await change(x, { planId: "plan_growth", cycle: "yearly" }).expect(200)).body; // same plan, code now disabled
      expect(quiet.subscription).toMatchObject({ amount: 60, cycle: "yearly" });
      expect(quiet.subscription.couponCode).toBeUndefined();
    });

    it("a single-use code is used up by one business but the redeemer can keep it; the last use goes to one of two racers", async () => {
      const a = await newTenant(api), b = await newTenant(api);
      const once = await mkCode({ maxUses: 1 });
      await change(a, { planId: "plan_growth", cycle: "monthly", couponCode: once.code }).expect(200);
      expect((await change(b, { planId: "plan_growth", cycle: "monthly", couponCode: once.code }).expect(400)).body.message).toBe("That discount code has been fully used.");
      await change(a, { planId: "plan_growth", cycle: "yearly" }).expect(200); // carried
      expect((await sub(a)).planCouponId).toBe(once.id);
      await change(a, { planId: "plan_growth", cycle: "monthly", couponCode: once.code }).expect(200); // re-entered by its own redeemer

      const racers = await Promise.all([1, 2, 3].map(() => newTenant(api)));
      const last = await mkCode({ maxUses: 1 });
      const results = await Promise.all(racers.map((r) => change(r, { planId: "plan_growth", cycle: "monthly", couponCode: last.code })));
      expect(results.filter((r: any) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r: any) => r.status === 400).every((r: any) => r.body.message === "That discount code has been fully used.")).toBe(true);
      expect(await prisma.planCouponRedemption.count({ where: { planCouponId: last.id } })).toBe(1);
    });

    it("rejects unknown or retired plans and bad input", async () => {
      const x = await newTenant(api);
      expect((await change(x, { planId: "nope", cycle: "monthly" }).expect(400)).body.message).toBe("Could not change plan.");
      await prisma.plan.create({ data: { id: `old_${run}`, name: "Old", priceMonthly: 1, priceYearly: 10, maxProducts: 1, maxStaff: 1, maxOrdersPerMonth: 1, maxStorageGb: 1, features: [], isActive: false } });
      expect((await change(x, { planId: `old_${run}`, cycle: "monthly" }).expect(400)).body.message).toBe("Could not change plan.");
      await change(x, { planId: "plan_growth", cycle: "weekly" }).expect(400);
      await api().post("/api/v1/business/billing/change-plan").send({ planId: "plan_growth", cycle: "monthly" }).expect(401);
      expect((await sub(x)).planId).toBe("plan_growth");
    });
  });
});
