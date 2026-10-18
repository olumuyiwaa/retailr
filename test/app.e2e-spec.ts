import { Controller, Get, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { Roles } from "../src/common/decorators";
import { PrismaService } from "../src/prisma/prisma.service";
import { configureApp } from "../src/setup";

@Controller("test-only")
class TestOnlyController {
  @Roles("SUPER_ADMIN") @Get("platform") platform() { return { ok: true }; }
  @Roles("BUSINESS_ADMIN") @Get("business") business() { return { ok: true }; }
}

const run = Math.random().toString(36).slice(2, 8);
let n = 0;
const base = (over: Record<string, unknown> = {}) => ({
  ownerName: "Ada Obi", email: `ada${++n}.${run}@example.com`, password: "password123",
  businessName: `Ada Shop ${run}`, category: "Fashion & Textiles", country: "Nigeria", city: "Lagos", phone: "0800",
  planId: "plan_growth", cycle: "monthly", ...over,
});

describe("Retailr API", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule], controllers: [TestOnlyController] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => { await app.close(); });

  describe("health and plans", () => {
    it("reports ok and talks to the database", async () => {
      const r = await api().get("/api/v1/health").expect(200);
      expect(r.body).toEqual({ status: "ok" });
    });
    it("lists active plans in the frontend's shape", async () => {
      const r = await api().get("/api/v1/plans").expect(200);
      const growth = r.body.find((p: any) => p.id === "plan_growth");
      expect(growth).toMatchObject({ priceMonthly: 6, limits: { products: 1500, staff: 5, ordersPerMonth: 2000, storageGb: 10 }, highlighted: true });
      expect(r.body[0].priceMonthly).toBe(0); // cheapest first
    });
  });

  describe("register", () => {
    it("creates a trial business on a paid plan", async () => {
      const body = base();
      const r = await api().post("/api/v1/auth/register").send(body).expect(201);
      expect(r.body.user).toMatchObject({ name: "Ada Obi", email: body.email, role: "business_admin" });
      expect(r.body.user.businessId).toBeTruthy();
      expect(r.body.accessToken && r.body.refreshToken).toBeTruthy();
      const biz = await prisma.business.findUnique({ where: { id: r.body.user.businessId }, include: { subscription: true, team: true } });
      expect(biz).toMatchObject({ status: "TRIAL", currency: "NGN", planId: "plan_growth" });
      expect(biz!.subscription).toMatchObject({ status: "TRIALING", cycle: "MONTHLY" });
      expect(Number(biz!.subscription!.amount)).toBe(6);
      expect(biz!.subscription!.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
      expect(biz!.team).toHaveLength(1);
      expect(biz!.team[0]).toMatchObject({ role: "OWNER", status: "ACTIVE" });
    });

    it("makes a free-plan business active with no trial", async () => {
      const r = await api().post("/api/v1/auth/register").send(base({ planId: "plan_basic", businessName: `Free ${run}` })).expect(201);
      const biz = await prisma.business.findUnique({ where: { id: r.body.user.businessId }, include: { subscription: true } });
      expect(biz!.status).toBe("ACTIVE");
      expect(biz!.subscription).toMatchObject({ status: "ACTIVE", trialEndsAt: null });
    });

    it("gives clashing business names a numbered slug", async () => {
      const name = `Same Name ${run}`;
      const a = await api().post("/api/v1/auth/register").send(base({ businessName: name })).expect(201);
      const b = await api().post("/api/v1/auth/register").send(base({ businessName: name })).expect(201);
      const [x, y] = await Promise.all([a, b].map((r) => prisma.business.findUnique({ where: { id: r.body.user.businessId } })));
      expect(y!.slug).toBe(`${x!.slug}-2`);
    });

    it("rejects a duplicate email, case-insensitively, with the UI's message", async () => {
      const body = base();
      await api().post("/api/v1/auth/register").send(body).expect(201);
      const r = await api().post("/api/v1/auth/register").send({ ...body, email: body.email.toUpperCase() }).expect(409);
      expect(r.body).toEqual({ statusCode: 409, code: "EMAIL_TAKEN", message: "An account with this email already exists." });
    });

    it("returns the first validation problem as a plain message", async () => {
      const r = await api().post("/api/v1/auth/register").send(base({ password: "short" })).expect(400);
      expect(r.body).toEqual({ statusCode: 400, code: "VALIDATION_ERROR", message: "Password must be at least 8 characters." });
      const r2 = await api().post("/api/v1/auth/register").send(base({ planId: "plan_nope" })).expect(400);
      expect(r2.body.message).toBe("Please choose a plan.");
    });

    it("leaves no account behind when the discount code is bad", async () => {
      const body = base({ couponCode: "NOPE-NOPE" });
      const before = await prisma.business.count();
      const r = await api().post("/api/v1/auth/register").send(body).expect(400);
      expect(r.body.message).toBe("That discount code isn't valid.");
      expect(await prisma.business.count()).toBe(before);
      expect(await prisma.user.findUnique({ where: { email: body.email } })).toBeNull();
    });
  });

  describe("platform discounts at sign-up", () => {
    const code = (s: string) => `${s}${run}`.toUpperCase();
    const make = (data: Record<string, unknown>) => prisma.planCoupon.create({ data: data as never });

    it("takes a percentage off the first-period price and counts one redemption", async () => {
      const c = await make({ code: code("PCT"), type: "PERCENT", value: 20 });
      const r = await api().post("/api/v1/auth/register").send(base({ couponCode: c.code.toLowerCase() })).expect(201);
      const sub = await prisma.subscription.findUnique({ where: { businessId: r.body.user.businessId } });
      expect(Number(sub!.amount)).toBe(4.8);
      expect(Number(sub!.discount)).toBe(1.2);
      expect(sub!.planCouponId).toBe(c.id);
      expect(await prisma.planCouponRedemption.count({ where: { planCouponId: c.id } })).toBe(1);
    });

    it("caps a fixed discount at the plan price", async () => {
      const c = await make({ code: code("FIX"), type: "FIXED", value: 10 });
      const r = await api().post("/api/v1/auth/register").send(base({ couponCode: c.code })).expect(201);
      const sub = await prisma.subscription.findUnique({ where: { businessId: r.body.user.businessId } });
      expect(Number(sub!.amount)).toBe(0);
      expect(Number(sub!.discount)).toBe(6);
    });

    it("enforces expiry, use limit, plan restriction and paid-only, with the documented messages", async () => {
      const expired = await make({ code: code("OLD"), type: "PERCENT", value: 10, expiresAt: new Date(Date.now() - 1000) });
      const full = await make({ code: code("FULL"), type: "PERCENT", value: 10, maxUses: 1 });
      await prisma.planCouponRedemption.create({ data: { planCouponId: full.id, businessId: (await prisma.business.findFirstOrThrow()).id } });
      const growthOnly = await make({ code: code("GRO"), type: "PERCENT", value: 10, plans: { create: [{ planId: "plan_growth" }] } });
      const off = await make({ code: code("OFF"), type: "PERCENT", value: 10, status: "DISABLED" });
      const ask = (couponCode: string, planId = "plan_growth") => api().post("/api/v1/plan-coupons/validate").send({ code: couponCode, planId });
      expect((await ask(expired.code).expect(400)).body.message).toBe("That discount code has expired.");
      expect((await ask(full.code).expect(400)).body.message).toBe("That discount code has been fully used.");
      expect((await ask(growthOnly.code, "plan_scale").expect(400)).body.message).toBe("That code only works on the Growth plan.");
      expect((await ask(off.code).expect(400)).body.message).toBe("That discount code isn't valid.");
      expect((await ask(code("LAUNCH20")).expect(400)).body.message).toBe("That discount code isn't valid.");
      expect((await ask("LAUNCH20", "plan_basic").expect(400)).body.message).toBe("Discount codes only apply to paid plans.");
      const ok = await ask(growthOnly.code).expect(200);
      expect(ok.body).toMatchObject({ code: growthOnly.code, type: "percent", value: 10, planIds: ["plan_growth"], usedCount: 0 });
    });

    it("never validates a code limited to one business on the public route", async () => {
      const biz = await prisma.business.findFirstOrThrow();
      const c = await make({ code: code("ONLY"), type: "PERCENT", value: 50, businessId: biz.id });
      const r = await api().post("/api/v1/plan-coupons/validate").send({ code: c.code, planId: "plan_growth" }).expect(400);
      expect(r.body.message).toBe("That discount code isn't valid for this business.");
    });
  });

  describe("login, sessions and roles", () => {
    let body: ReturnType<typeof base>;
    let session: { accessToken: string; refreshToken: string; user: { businessId: string } };
    beforeAll(async () => {
      body = base();
      session = (await api().post("/api/v1/auth/register").send(body).expect(201)).body;
    });

    it("rejects wrong credentials with one message for both cases", async () => {
      const a = await api().post("/api/v1/auth/login").send({ email: body.email, password: "wrong-pass" }).expect(401);
      const b = await api().post("/api/v1/auth/login").send({ email: "nobody@example.com", password: "wrong-pass" }).expect(401);
      expect(a.body.message).toBe("Invalid email or password.");
      expect(b.body).toEqual(a.body);
    });

    it("logs in with a differently-cased email and serves /auth/me", async () => {
      const r = await api().post("/api/v1/auth/login").send({ email: ` ${body.email.toUpperCase()} `, password: body.password }).expect(200);
      const me = await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${r.body.accessToken}`).expect(200);
      expect(me.body).toMatchObject({ email: body.email, role: "business_admin", businessId: session.user.businessId });
    });

    it("requires a valid token on private routes", async () => {
      await api().get("/api/v1/auth/me").expect(401);
      await api().get("/api/v1/auth/me").set("Authorization", "Bearer not-a-token").expect(401);
    });

    it("keeps each role to its own routes", async () => {
      const bearer = `Bearer ${session.accessToken}`;
      await api().get("/api/v1/test-only/business").set("Authorization", bearer).expect(200);
      const r = await api().get("/api/v1/test-only/platform").set("Authorization", bearer).expect(403);
      expect(r.body.code).toBe("FORBIDDEN");
      const admin = await api().post("/api/v1/auth/login").send({ email: process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@retailr.com", password: process.env.SEED_SUPER_ADMIN_PASSWORD ?? "Passw0rd!123" });
      if (admin.status === 200) {
        await api().get("/api/v1/test-only/platform").set("Authorization", `Bearer ${admin.body.accessToken}`).expect(200);
        await api().get("/api/v1/test-only/business").set("Authorization", `Bearer ${admin.body.accessToken}`).expect(403);
      }
    });

    it("rotates refresh tokens and revokes every session when an old one is replayed", async () => {
      const first = (await api().post("/api/v1/auth/login").send({ email: body.email, password: body.password }).expect(200)).body;
      const second = (await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken }).expect(200)).body;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      await api().post("/api/v1/auth/refresh").send({ refreshToken: first.refreshToken }).expect(401); // replay
      await api().post("/api/v1/auth/refresh").send({ refreshToken: second.refreshToken }).expect(401); // family revoked
    });

    it("logout revokes the refresh token", async () => {
      const s = (await api().post("/api/v1/auth/login").send({ email: body.email, password: body.password }).expect(200)).body;
      await api().post("/api/v1/auth/logout").send({ refreshToken: s.refreshToken }).expect(204);
      await api().post("/api/v1/auth/refresh").send({ refreshToken: s.refreshToken }).expect(401);
    });

    it("locks a suspended business out of login and out of tokens it already holds", async () => {
      const mine = base();
      const s = (await api().post("/api/v1/auth/register").send(mine).expect(201)).body;
      await api().get("/api/v1/test-only/business").set("Authorization", `Bearer ${s.accessToken}`).expect(200);
      await prisma.business.update({ where: { id: s.user.businessId }, data: { status: "SUSPENDED" } });
      const l = await api().post("/api/v1/auth/login").send({ email: mine.email, password: mine.password }).expect(403);
      expect(l.body.message).toBe("This business account is suspended. Contact Retailr support.");
      const t = await api().get("/api/v1/test-only/business").set("Authorization", `Bearer ${s.accessToken}`).expect(403);
      expect(t.body.code).toBe("BUSINESS_SUSPENDED");
      await prisma.business.update({ where: { id: s.user.businessId }, data: { status: "CANCELLED" } });
      expect((await api().post("/api/v1/auth/login").send({ email: mine.email, password: mine.password }).expect(403)).body.message).toBe("This business account has been cancelled.");
    });
  });

  describe("tenant isolation", () => {
    let a: string, b: string;
    beforeAll(async () => {
      a = (await api().post("/api/v1/auth/register").send(base()).expect(201)).body.user.businessId;
      b = (await api().post("/api/v1/auth/register").send(base()).expect(201)).body.user.businessId;
    });

    it("only shows a business its own rows, however the query is written", async () => {
      const A = prisma.forBusiness(a), B = prisma.forBusiness(b);
      const cat = await A.category.create({ data: { name: "Wigs" } as never });
      await B.category.create({ data: { name: "Bags" } as never });
      expect((await A.category.findMany()).map((c) => c.name)).toEqual(["Wigs"]);
      expect(await B.category.findUnique({ where: { id: cat.id } })).toBeNull();
      expect(await B.category.findFirst({ where: { id: cat.id } })).toBeNull();
      expect(await B.category.count({ where: { name: "Wigs" } })).toBe(0);
      expect((await B.category.findMany({ where: { OR: [{ id: cat.id }, { name: "Bags" }] } })).map((c) => c.name)).toEqual(["Bags"]);
    });

    it("can't update or delete another business's rows", async () => {
      const A = prisma.forBusiness(a), B = prisma.forBusiness(b);
      const cat = await A.category.create({ data: { name: "Shoes" } as never });
      expect((await B.category.updateMany({ where: { id: cat.id }, data: { name: "Hacked" } })).count).toBe(0);
      expect((await B.category.deleteMany({ where: { id: cat.id } })).count).toBe(0);
      await expect(B.category.update({ where: { id: cat.id }, data: { name: "Hacked" } })).rejects.toThrow();
      await expect(B.category.delete({ where: { id: cat.id } })).rejects.toThrow();
      expect((await A.category.findUnique({ where: { id: cat.id } }))!.name).toBe("Shoes");
    });

    it("stamps its own businessId on creates and refuses to write into another business", async () => {
      const A = prisma.forBusiness(a);
      const c = await A.category.create({ data: { name: "Stamped" } as never });
      expect(c.businessId).toBe(a);
      await expect(A.category.create({ data: { name: "Evil", businessId: b } as never })).rejects.toThrow("Cross-tenant write blocked.");
      await expect(A.category.update({ where: { id: c.id }, data: { businessId: b } as never })).rejects.toThrow();
      await A.category.createMany({ data: [{ name: "X1" }, { name: "X2" }] as never });
      expect(await prisma.category.count({ where: { businessId: a, name: { in: ["X1", "X2"] } } })).toBe(2);
    });

    it("enforces category names case-insensitively per business", async () => {
      const A = prisma.forBusiness(a), B = prisma.forBusiness(b);
      await A.category.create({ data: { name: "Dresses" } as never });
      await expect(A.category.create({ data: { name: "dresses" } as never })).rejects.toThrow();
      await expect(B.category.create({ data: { name: "dresses" } as never })).resolves.toBeTruthy();
    });
  });

  describe("rate limiting", () => {
    it("answers 429 in the standard error shape when a client hammers login", async () => {
      process.env.AUTH_RATE_LIMIT = "1";
      try {
        const r = await api().post("/api/v1/auth/login").send({ email: "x@example.com", password: "whatever1" });
        expect(r.status).toBe(429);
        expect(r.body).toMatchObject({ statusCode: 429, code: "RATE_LIMITED" });
      } finally {
        process.env.AUTH_RATE_LIMIT = "100000";
      }
    });
  });
});
