process.env.PAYMENTS_DRIVER = "fake";
import { INestApplication } from "@nestjs/common";
import { createHmac } from "crypto";
import { JobsService } from "../src/jobs/jobs.service";
import { MailService } from "../src/mail/mail.service";
import { FakePaystackApi } from "../src/payments/paystack.provider";
import { PAYMENT_PROVIDER } from "../src/payments/payment.provider";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant } from "./helpers";

const DAY = 86_400_000;

describe("Payments", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, fake: FakePaystackApi, jobs: JobsService, mail: MailService;
  let n = 0;
  const S = (x: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...x.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...x.auth).send(b),
  });
  const sub = (x: Tenant) => prisma.subscription.findUniqueOrThrow({ where: { businessId: x.businessId } });
  const biz = (x: Tenant) => prisma.business.findUniqueOrThrow({ where: { id: x.businessId } });
  const checkout = (x: Tenant, body: object = { planId: "plan_scale", cycle: "monthly" }) => S(x).post("/business/billing/checkout", body);
  const hook = (body: object, secret = "fake-secret") => {
    const raw = JSON.stringify(body);
    return api().post("/api/v1/webhooks/paystack").set("Content-Type", "application/json").set("x-paystack-signature", createHmac("sha512", secret).update(raw).digest("hex")).send(raw);
  };
  /** Starts a checkout, pays it, confirms it: a business with an active paid plan and a card on file. */
  const subscribe = async (x: Tenant, body: object = { planId: "plan_scale", cycle: "monthly" }) => {
    const c = (await checkout(x, body).expect(200)).body;
    fake.complete(c.reference);
    await S(x).get(`/business/billing/verify/${c.reference}`).expect(200);
    return c;
  };
  const planCode = (over: Record<string, unknown> = {}) => prisma.planCoupon.create({ data: { code: `PC${++n}${run}`.toUpperCase(), type: "PERCENT", value: 50, ...over } as never });

  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    fake = (app.get(PAYMENT_PROVIDER) as any).api;
    jobs = app.get(JobsService); mail = app.get(MailService);
  });
  afterAll(async () => { await app.close(); });

  it("requires payment for a paid plan, but free plans still switch directly", async () => {
    const x = await newTenant(api);
    const r = await S(x).post("/business/billing/change-plan", { planId: "plan_scale", cycle: "monthly" }).expect(402);
    expect(r.body.code).toBe("PAYMENT_REQUIRED");
    await S(x).post("/business/billing/change-plan", { planId: "plan_basic", cycle: "monthly" }).expect(200);
    expect((await S(x).get("/business/billing").expect(200)).body.payments).toMatchObject({ enabled: true, provider: "paystack", cardOnFile: false });
  });

  it("checkout creates a pending invoice and returns the provider's page", async () => {
    const x = await newTenant(api);
    const c = (await checkout(x).expect(200)).body;
    expect(c.checkoutUrl).toContain(c.reference);
    expect(c.applied).toBe(false);
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { providerReference: c.reference } });
    expect(inv).toMatchObject({ status: "PENDING", businessId: x.businessId, planId: "plan_scale", kind: "CHECKOUT" });
    expect(fake.transactions.get(c.reference)!.amount).toBe(Math.round(Number(inv.chargeAmount) * 100));
    expect((await sub(x)).planId).toBe("plan_growth"); // nothing changes until it's paid
    await api().post("/api/v1/business/billing/checkout").send({ planId: "plan_scale", cycle: "monthly" }).expect(401);
    await checkout(x, { planId: "plan_basic", cycle: "monthly" }).expect(400); // free plan: nothing to pay
    await checkout(x, { planId: "nope", cycle: "monthly" }).expect(400);
  });

  it("verifying a paid checkout activates the plan, keeps the card and moves a trial to active", async () => {
    const x = await newTenant(api);
    const c = (await checkout(x).expect(200)).body;
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("pending");
    fake.complete(c.reference);
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("paid");
    const s = await sub(x);
    expect(s).toMatchObject({ planId: "plan_scale", status: "ACTIVE", trialEndsAt: null });
    expect(s.providerAuthorization).toMatch(/^AUTH_/);
    expect(s.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 27 * DAY);
    expect(await biz(x)).toMatchObject({ planId: "plan_scale", status: "ACTIVE" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { providerReference: c.reference } })).status).toBe("PAID");
    expect(mail.outbox.some((m: any) => m.to === x.email && /payment|receipt|paid/i.test(m.subject))).toBe(true);
    expect((await S(x).get("/business/billing").expect(200)).body.payments.cardOnFile).toBe(true);
    // confirming again changes nothing
    const before = (await sub(x)).currentPeriodEnd;
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("paid");
    expect((await sub(x)).currentPeriodEnd).toEqual(before);
  });

  it("only the business that started a payment can look it up", async () => {
    const x = await newTenant(api), y = await newTenant(api);
    const c = (await checkout(x).expect(200)).body;
    await S(y).get(`/business/billing/verify/${c.reference}`).expect(404);
    await S(x).get(`/business/billing/verify/unknown_ref`).expect(404);
  });

  it("a failed payment marks the invoice failed and changes nothing", async () => {
    const x = await newTenant(api);
    const c = (await checkout(x).expect(200)).body;
    fake.complete(c.reference, "failed");
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("failed");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { providerReference: c.reference } })).status).toBe("FAILED");
    expect((await sub(x)).planId).toBe("plan_growth");
  });

  it("rejects a payment for the wrong amount", async () => {
    const x = await newTenant(api);
    const c = (await checkout(x).expect(200)).body;
    fake.complete(c.reference);
    fake.transactions.get(c.reference)!.amount -= 100;
    expect((await S(x).get(`/business/billing/verify/${c.reference}`).expect(200)).body.status).toBe("failed");
    expect((await sub(x)).planId).toBe("plan_growth");
  });

  it("a provider outage gives a 502 and a failed invoice", async () => {
    const x = await newTenant(api);
    fake.failInitialize = true;
    try { expect((await checkout(x).expect(502)).body.code).toBe("PAYMENT_PROVIDER_ERROR"); } finally { fake.failInitialize = false; }
    expect((await prisma.invoice.findMany({ where: { businessId: x.businessId } })).map((i) => i.status)).toEqual(["FAILED"]);
  });

  describe("webhook", () => {
    it("confirms a payment when the signature is right, and is idempotent", async () => {
      const x = await newTenant(api);
      const c = (await checkout(x).expect(200)).body;
      fake.complete(c.reference);
      await hook({ event: "charge.success", data: { reference: c.reference } }).expect(200);
      expect((await sub(x)).planId).toBe("plan_scale");
      const end = (await sub(x)).currentPeriodEnd;
      await hook({ event: "charge.success", data: { reference: c.reference } }).expect(200);
      expect((await sub(x)).currentPeriodEnd).toEqual(end);
      expect(await prisma.invoice.count({ where: { businessId: x.businessId, status: "PAID" } })).toBe(1);
    });
    it("rejects a bad or missing signature, ignores unknown references and other events", async () => {
      const x = await newTenant(api);
      const c = (await checkout(x).expect(200)).body;
      fake.complete(c.reference);
      await hook({ event: "charge.success", data: { reference: c.reference } }, "wrong-secret").expect(401);
      await api().post("/api/v1/webhooks/paystack").send({ event: "charge.success", data: { reference: c.reference } }).expect(401);
      expect((await sub(x)).planId).toBe("plan_growth");
      await hook({ event: "charge.success", data: { reference: "someone_elses" } }).expect(200);
      await hook({ event: "transfer.success", data: { reference: c.reference } }).expect(200);
      expect((await sub(x)).planId).toBe("plan_growth");
    });
    it("won't trust the body: a success event for an unpaid reference changes nothing", async () => {
      const x = await newTenant(api);
      const c = (await checkout(x).expect(200)).body; // never completed at the provider
      await hook({ event: "charge.success", data: { reference: c.reference } }).expect(200);
      expect((await sub(x)).planId).toBe("plan_growth");
    });
  });

  describe("discount codes", () => {
    it("charges the discounted price and redeems the code on payment", async () => {
      const x = await newTenant(api);
      const code = await planCode({ value: 50 });
      const c = (await checkout(x, { planId: "plan_scale", cycle: "monthly", couponCode: code.code }).expect(200)).body;
      const full = await checkout(await newTenant(api), { planId: "plan_scale", cycle: "monthly" });
      expect(c.charge.amount).toBeCloseTo(full.body.charge.amount / 2, 1);
      expect(await prisma.planCouponRedemption.count({ where: { planCouponId: code.id } })).toBe(0); // not until paid
      fake.complete(c.reference);
      await S(x).get(`/business/billing/verify/${c.reference}`).expect(200);
      expect(await prisma.planCouponRedemption.count({ where: { planCouponId: code.id } })).toBe(1);
      expect((await sub(x)).planCouponId).toBe(code.id);
    });
    it("a 100% code switches the plan straight away, with no payment", async () => {
      const x = await newTenant(api);
      const code = await planCode({ value: 100 });
      const c = (await checkout(x, { planId: "plan_scale", cycle: "monthly", couponCode: code.code }).expect(200)).body;
      expect(c).toMatchObject({ applied: true, charge: { amount: 0 } });
      expect(await sub(x)).toMatchObject({ planId: "plan_scale", status: "ACTIVE" });
      expect(fake.transactions.has(c.reference)).toBe(false);
    });
  });

  describe("renewals", () => {
    const expire = (x: Tenant, days = 0) => prisma.subscription.update({ where: { businessId: x.businessId }, data: { currentPeriodEnd: new Date(Date.now() - days * DAY - 1000) } });

    it("charges the saved card and rolls the period forward", async () => {
      const x = await newTenant(api); await subscribe(x);
      await expire(x);
      const before = await sub(x);
      const r = await jobs.renewals();
      expect(r.paid).toBeGreaterThanOrEqual(1);
      const after = await sub(x);
      expect(after.status).toBe("ACTIVE");
      expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);
      expect(after.currentPeriodEnd.getTime()).toBeGreaterThan(before.currentPeriodEnd.getTime());
      expect(await prisma.invoice.count({ where: { businessId: x.businessId, kind: "RENEWAL", status: "PAID" } })).toBe(1);
      await jobs.renewals(); // nothing is due now: no second charge
      expect(await prisma.invoice.count({ where: { businessId: x.businessId, kind: "RENEWAL" } })).toBe(1);
    });

    it("a declined card makes the subscription past due, and tells the owner", async () => {
      const x = await newTenant(api); await subscribe(x);
      await expire(x);
      mail.outbox.length = 0;
      fake.nextCharge = "failed";
      try { await jobs.renewals(); } finally { fake.nextCharge = "success"; }
      expect((await sub(x)).status).toBe("PAST_DUE");
      expect(await biz(x)).toMatchObject({ status: "ACTIVE" }); // still open during the grace period
      expect(mail.outbox.some((m: any) => m.to === x.email)).toBe(true);
      // not retried again within a day
      await jobs.renewals();
      expect(await prisma.invoice.count({ where: { businessId: x.businessId, kind: "RENEWAL" } })).toBe(1);
      // a day later it retries, and success brings it back
      await prisma.invoice.updateMany({ where: { businessId: x.businessId }, data: { issuedAt: new Date(Date.now() - 2 * DAY) } });
      await jobs.renewals();
      expect((await sub(x)).status).toBe("ACTIVE");
    });

    it("suspends for non-payment after the grace period, and paying lifts it", async () => {
      const x = await newTenant(api); await subscribe(x);
      await expire(x, 10);
      await prisma.subscription.update({ where: { businessId: x.businessId }, data: { status: "PAST_DUE" } });
      const r = await jobs.renewals();
      expect(r.suspended).toBeGreaterThanOrEqual(1);
      expect(await biz(x)).toMatchObject({ status: "SUSPENDED", suspensionReason: "NON_PAYMENT" });
      // a fresh payment lifts it (checkout is allowed to run while suspended through the service)
      const svc = (await import("../src/payments/payments.service")).PaymentsService;
      const ps = app.get(svc);
      const c = await ps.checkout(x.businessId, "plan_scale", "monthly");
      fake.complete(c.reference);
      await ps.confirm(c.reference);
      expect(await biz(x)).toMatchObject({ status: "ACTIVE", suspensionReason: null });
    });

    it("paying never lifts an admin suspension", async () => {
      const x = await newTenant(api); await subscribe(x);
      await prisma.business.update({ where: { id: x.businessId }, data: { status: "SUSPENDED", suspensionReason: "ADMIN" } });
      const ps = app.get((await import("../src/payments/payments.service")).PaymentsService);
      const c = await ps.checkout(x.businessId, "plan_scale", "monthly");
      fake.complete(c.reference);
      await ps.confirm(c.reference);
      expect(await biz(x)).toMatchObject({ status: "SUSPENDED", suspensionReason: "ADMIN" });
      await expire(x, 30);
      await jobs.renewals(); // and renewals skip suspended stores
      expect(await prisma.invoice.count({ where: { businessId: x.businessId, kind: "RENEWAL" } })).toBe(0);
    });

    it("no card on file means past due, not a charge", async () => {
      const x = await newTenant(api); await subscribe(x);
      await prisma.subscription.update({ where: { businessId: x.businessId }, data: { providerAuthorization: null } });
      await expire(x);
      await jobs.renewals();
      expect((await sub(x)).status).toBe("PAST_DUE");
      expect(await prisma.invoice.count({ where: { businessId: x.businessId, kind: "RENEWAL" } })).toBe(0);
    });

    it("a fully discounted subscription rolls on for free", async () => {
      const x = await newTenant(api);
      const code = await planCode({ value: 100 });
      await checkout(x, { planId: "plan_scale", cycle: "monthly", couponCode: code.code }).expect(200);
      await expire(x);
      const r = await jobs.renewals();
      expect(r.free).toBeGreaterThanOrEqual(1);
      expect((await sub(x)).currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    });

    it("resolves a renewal the bank left pending", async () => {
      const x = await newTenant(api); await subscribe(x);
      await expire(x);
      fake.nextCharge = "pending";
      try { await jobs.renewals(); } finally { fake.nextCharge = "success"; }
      const inv = await prisma.invoice.findFirstOrThrow({ where: { businessId: x.businessId, kind: "RENEWAL" } });
      expect(inv.status).toBe("PENDING");
      fake.complete(inv.providerReference!);
      await prisma.invoice.update({ where: { id: inv.id }, data: { issuedAt: new Date(Date.now() - 2 * 3_600_000) } });
      await jobs.resolveStalePayments();
      expect((await sub(x)).currentPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("PAID");
    });

    it("a renewal still pending after a day is failed, so retries aren't blocked forever", async () => {
      const x = await newTenant(api); await subscribe(x);
      await expire(x);
      fake.nextCharge = "pending";
      try { await jobs.renewals(); } finally { fake.nextCharge = "success"; }
      const inv = await prisma.invoice.findFirstOrThrow({ where: { businessId: x.businessId, kind: "RENEWAL" } });
      await prisma.invoice.update({ where: { id: inv.id }, data: { issuedAt: new Date(Date.now() - 25 * 3_600_000) } });
      await jobs.resolveStalePayments();
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe("FAILED");
      expect((await sub(x)).status).toBe("PAST_DUE");
      // the next daily retry now gets a fresh attempt and collects
      await prisma.invoice.update({ where: { id: inv.id }, data: { issuedAt: new Date(Date.now() - 25 * 3_600_000) } });
      await jobs.renewals();
      expect((await sub(x)).status).toBe("ACTIVE");
      expect(await prisma.invoice.count({ where: { businessId: x.businessId, kind: "RENEWAL" } })).toBe(2);
    });

    it("leaves cancelled subscriptions alone", async () => {
      const x = await newTenant(api); await subscribe(x);
      await prisma.subscription.update({ where: { businessId: x.businessId }, data: { cancelledAt: new Date() } });
      await expire(x);
      await jobs.renewals();
      expect(await prisma.invoice.count({ where: { businessId: x.businessId, kind: "RENEWAL" } })).toBe(0);
    });
  });

  describe("trials and housekeeping", () => {
    it("reminds once, three days before the trial ends", async () => {
      const x = await newTenant(api);
      await prisma.subscription.update({ where: { businessId: x.businessId }, data: { trialEndsAt: new Date(Date.now() + 2 * DAY) } });
      mail.outbox.length = 0;
      await jobs.trialReminders();
      expect(mail.outbox.filter((m: any) => m.to === x.email)).toHaveLength(1);
      await jobs.trialReminders();
      expect(mail.outbox.filter((m: any) => m.to === x.email)).toHaveLength(1);
    });
    it("an ended trial becomes past due; one with time left is untouched", async () => {
      const x = await newTenant(api), y = await newTenant(api);
      await prisma.subscription.update({ where: { businessId: x.businessId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
      await jobs.expireTrials();
      expect((await sub(x)).status).toBe("PAST_DUE");
      expect((await sub(y)).status).toBe("TRIALING");
    });
    it("abandons old unpaid checkouts", async () => {
      const x = await newTenant(api);
      const c = (await checkout(x).expect(200)).body;
      await prisma.invoice.updateMany({ where: { providerReference: c.reference }, data: { issuedAt: new Date(Date.now() - 2 * DAY) } });
      await jobs.expireAbandonedCheckouts();
      expect((await prisma.invoice.findUniqueOrThrow({ where: { providerReference: c.reference } })).status).toBe("FAILED");
    });
    it("nightly cleanup runs and repairs customer totals", async () => {
      const x = await newTenant(api);
      const cu = await prisma.customer.create({ data: { businessId: x.businessId, name: "A", email: `a${run}@e.com`, phone: "1", ordersCount: 9, totalSpent: 999 } as never });
      const r = await jobs.nightly();
      expect(r.customersFixed).toBeGreaterThanOrEqual(1);
      expect(await prisma.customer.findUniqueOrThrow({ where: { id: cu.id } })).toMatchObject({ ordersCount: 0 });
    });
  });
});
