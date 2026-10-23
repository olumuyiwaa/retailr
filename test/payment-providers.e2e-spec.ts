process.env.PAYMENTS_DRIVER = "fake,fake-flutterwave";
import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant } from "./helpers";

describe("Choosing payment providers (super admin)", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, admin: [string, string];
  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    const r = await api().post("/api/v1/auth/login").send({ email: process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@retailr.com", password: process.env.SEED_SUPER_ADMIN_PASSWORD }).expect(200);
    admin = ["Authorization", `Bearer ${r.body.accessToken}`];
  });
  afterAll(async () => { await prisma.platformSetting.deleteMany({ where: { key: "payments" } }); await app.close(); });

  const put = (body: object) => api().put("/api/v1/platform/payment-providers").set(...admin).send(body);
  const checkout = (t: { auth: [string, string] }, body: object = {}) => api().post("/api/v1/business/billing/checkout").set(...t.auth).send({ planId: "plan_scale", cycle: "monthly", ...body });

  it("lists both providers, switched on, with the first as default", async () => {
    await prisma.platformSetting.deleteMany({ where: { key: "payments" } });
    const r = (await api().get("/api/v1/platform/payment-providers").set(...admin).expect(200)).body;
    expect(r.providers.map((p: any) => [p.name, p.configured, p.enabled])).toEqual([["paystack", true, true], ["flutterwave", true, true]]);
    expect(r.providers.find((p: any) => p.isDefault).name).toBe("paystack");
  });

  it("switches the default, and turns a provider off for new payments", async () => {
    const t = await newTenant(api);
    const r = (await put({ enabled: ["flutterwave"], default: "flutterwave" }).expect(200)).body;
    expect(r.providers.map((p: any) => [p.name, p.enabled, p.isDefault])).toEqual([["paystack", false, false], ["flutterwave", true, true]]);
    const c = (await checkout(t).expect(200)).body;
    expect((await prisma.invoice.findUniqueOrThrow({ where: { providerReference: c.reference } })).provider).toBe("flutterwave");
    expect((await checkout(t, { provider: "paystack" }).expect(400)).body.code).toBe("PROVIDER_UNAVAILABLE");
    expect((await api().get("/api/v1/business/billing").set(...t.auth).expect(200)).body.payments).toMatchObject({ provider: "flutterwave", providers: ["flutterwave"] });
    // and back
    await put({ enabled: ["paystack", "flutterwave"], default: "paystack" }).expect(200);
    const c2 = (await checkout(t).expect(200)).body;
    expect((await prisma.invoice.findUniqueOrThrow({ where: { providerReference: c2.reference } })).provider).toBe("paystack");
  });

  it("rejects an empty choice, an unknown provider, a default that is switched off, and non-admins", async () => {
    expect((await put({ enabled: [], default: "paystack" }).expect(400)).body.code).toBe("PROVIDER_REQUIRED");
    expect((await put({ enabled: ["stripe"], default: "stripe" }).expect(400)).body.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect((await put({ enabled: ["paystack"], default: "flutterwave" }).expect(400)).body.code).toBe("DEFAULT_NOT_ENABLED");
    const t = await newTenant(api);
    await api().put("/api/v1/platform/payment-providers").set(...t.auth).send({ enabled: ["paystack"], default: "paystack" }).expect(403);
    await api().get("/api/v1/platform/payment-providers").expect(401);
  });
});
