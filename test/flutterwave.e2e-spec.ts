process.env.PAYMENTS_DRIVER = "fake,fake-flutterwave";
import { INestApplication } from "@nestjs/common";
import { JobsService } from "../src/jobs/jobs.service";
import { FakeFlutterwaveApi, FlutterwaveProvider } from "../src/payments/flutterwave.provider";
import { PAYMENT_PROVIDERS } from "../src/payments/payment.provider";
import { FakePaystackApi } from "../src/payments/paystack.provider";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, Tenant } from "./helpers";

const DAY = 86_400_000;

describe("Flutterwave (alongside Paystack)", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, flw: FakeFlutterwaveApi, ps: FakePaystackApi, jobs: JobsService;
  const S = (x: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...x.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...x.auth).send(b),
  });
  const sub = (x: Tenant) => prisma.subscription.findUniqueOrThrow({ where: { businessId: x.businessId } });
  const checkout = (x: Tenant, provider?: string) => S(x).post("/business/billing/checkout", { planId: "plan_scale", cycle: "monthly", ...(provider ? { provider } : {}) });
  const hook = (body: object, hash?: string) => api().post("/api/v1/webhooks/flutterwave").set("Content-Type", "application/json").set(...(hash ? (["verif-hash", hash] as [string, string]) : (["x-none", "1"] as [string, string]))).send(JSON.stringify(body));
  const subscribe = async (x: Tenant, provider = "flutterwave") => {
    const c = (await checkout(x, provider).expect(200)).body;
    if (provider === "flutterwave") flw.complete(c.reference); else ps.complete(c.reference);
    await S(x).get(`/business/billing/verify/${c.reference}`).expect(200);
    return c;
  };

  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    const [p, f] = app.get(PAYMENT_PROVIDERS) as any[];
    ps = p.api; flw = (f as FlutterwaveProvider).api as FakeFlutterwaveApi;
    jobs = app.get(JobsService);
  });
  afterAll(async () => { await app.close(); });

  it("lists the enabled providers, default first", async () => {
    const x = await newTenant(api);
    expect((await S(x).get("/business/billing").expect(200)).body.payments).toMatchObject({ enabled: true, provider: "paystack", providers: ["paystack", "flutterwave"] });
  });

  it("checkout through Flutterwave sends major units and records the provider", async () => {
    const x = await newTenant(api);
    const c = (await checkout(x, "flutterwave").expect(200)).body;
    expect(c.checkoutUrl).toContain("fake-flw");
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { providerReference: c.reference } });
    expect(inv.provider).toBe("flutterwave");
    expect(flw.transactions.get(c.reference)!.amount).toBe(Number(inv.chargeAmount)); // naira, not kobo
    expect(ps.transactions.has(c.reference)).toBe(false);
  });

  it("an unknown or unavailable provider is refused; omitting it uses the default", async () => {
    const x = await newTenant(api);
    expect((await checkout(x, "stripe").expect(400)).body.code).toBe("PROVIDER_UNAVAILABLE");
    const c = (await checkout(x).expect(200)).body;
    expect((await prisma.invoice.findUniqueOrThrow({ where: { providerReference: c.reference } })).provider).toBe("paystack");
  });

  it("verifying a paid Flutterwave checkout activates the plan and keeps the card token and provider", async () => {
    const x = await newTenant(api);
    const c = (await checkout(x, "flutterwave").expect(200)).body;
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("pending"); // Flutterwave knows nothing yet
    flw.complete(c.reference);
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("paid");
    const s = await sub(x);
    expect(s).toMatchObject({ planId: "plan_scale", status: "ACTIVE", provider: "flutterwave" });
    expect(s.providerAuthorization).toMatch(/^flw-t1nf-/);
  });

  it("a failed payment stays unapplied", async () => {
    const x = await newTenant(api);
    const c = (await checkout(x, "flutterwave").expect(200)).body;
    flw.complete(c.reference, "failed");
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("failed");
    expect((await sub(x)).planId).toBe("plan_growth");
  });

  it("an amount that doesn't match the invoice is rejected", async () => {
    const x = await newTenant(api);
    const c = (await checkout(x, "flutterwave").expect(200)).body;
    flw.complete(c.reference);
    flw.transactions.get(c.reference)!.amount -= 1;
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("failed");
    expect((await sub(x)).planId).toBe("plan_growth");
  });

  describe("webhook", () => {
    it("rejects a missing or wrong verif-hash", async () => {
      const x = await newTenant(api);
      const c = (await checkout(x, "flutterwave").expect(200)).body;
      flw.complete(c.reference);
      const body = { event: "charge.completed", data: { tx_ref: c.reference, status: "successful" } };
      await hook(body).expect(401);
      await hook(body, "wrong").expect(401);
      await hook(body, "fake-hash-longer-than-the-real-one").expect(401);
      expect((await sub(x)).planId).toBe("plan_growth");
    });
    it("with the right hash it confirms with Flutterwave, applies once, and ignores other events", async () => {
      const x = await newTenant(api);
      const c = (await checkout(x, "flutterwave").expect(200)).body;
      flw.complete(c.reference);
      await hook({ event: "transfer.completed", data: { tx_ref: c.reference } }, "fake-hash").expect(200);
      expect((await sub(x)).planId).toBe("plan_growth");
      await hook({ event: "charge.completed", data: { tx_ref: c.reference } }, "fake-hash").expect(200);
      await hook({ event: "charge.completed", data: { tx_ref: c.reference } }, "fake-hash").expect(200);
      expect((await sub(x)).planId).toBe("plan_scale");
      expect(await prisma.invoice.count({ where: { providerReference: c.reference, status: "PAID" } })).toBe(1);
      await hook({ event: "charge.completed", data: { tx_ref: "not-ours" } }, "fake-hash").expect(200);
    });
    it("a Paystack signature doesn't open the Flutterwave route, and unknown providers are 401", async () => {
      await api().post("/api/v1/webhooks/flutterwave").set("x-paystack-signature", "abc").send({}).expect(401);
      await api().post("/api/v1/webhooks/stripe").send({}).expect(401);
    });
  });

  describe("renewals", () => {
    const expire = (x: Tenant) => prisma.subscription.update({ where: { businessId: x.businessId }, data: { currentPeriodEnd: new Date(Date.now() - 1000) } });

    it("charges the saved token through Flutterwave and rolls the period", async () => {
      const x = await newTenant(api); await subscribe(x);
      await expire(x);
      await jobs.renewals();
      const inv = await prisma.invoice.findFirstOrThrow({ where: { businessId: x.businessId, kind: "RENEWAL" } });
      expect(inv).toMatchObject({ status: "PAID", provider: "flutterwave" });
      expect(flw.transactions.get(inv.providerReference!)!.token).toMatch(/^flw-t1nf-/);
      expect((await sub(x)).currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);
    });
    it("a declined token makes the subscription past due", async () => {
      const x = await newTenant(api); await subscribe(x);
      await expire(x);
      flw.nextCharge = "failed";
      try { await jobs.renewals(); } finally { flw.nextCharge = "successful"; }
      expect((await sub(x)).status).toBe("PAST_DUE");
    });
    it("a pending charge (3-D Secure) is resolved later by asking Flutterwave", async () => {
      const x = await newTenant(api); await subscribe(x);
      await expire(x);
      flw.nextCharge = "pending";
      try { await jobs.renewals(); } finally { flw.nextCharge = "successful"; }
      const inv = await prisma.invoice.findFirstOrThrow({ where: { businessId: x.businessId, kind: "RENEWAL" } });
      expect(inv.status).toBe("PENDING");
      flw.transactions.get(inv.providerReference!)!.status = "successful";
      await prisma.invoice.update({ where: { id: inv.id }, data: { issuedAt: new Date(Date.now() - 2 * 3_600_000) } });
      await jobs.resolveStalePayments();
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    });
    it("each subscription renews through the provider that holds its card", async () => {
      const a = await newTenant(api), b = await newTenant(api);
      await subscribe(a, "paystack"); await subscribe(b, "flutterwave");
      await expire(a); await expire(b);
      await jobs.renewals();
      const ia = await prisma.invoice.findFirstOrThrow({ where: { businessId: a.businessId, kind: "RENEWAL" } });
      const ib = await prisma.invoice.findFirstOrThrow({ where: { businessId: b.businessId, kind: "RENEWAL" } });
      expect([ia.provider, ia.status, ib.provider, ib.status]).toEqual(["paystack", "PAID", "flutterwave", "PAID"]);
    });
    it("a card saved before providers were recorded renews through Paystack", async () => {
      const x = await newTenant(api); await subscribe(x, "paystack");
      await prisma.subscription.update({ where: { businessId: x.businessId }, data: { provider: null } });
      await expire(x);
      await jobs.renewals();
      expect((await prisma.invoice.findFirstOrThrow({ where: { businessId: x.businessId, kind: "RENEWAL" } })).provider).toBe("paystack");
    });
  });
});
