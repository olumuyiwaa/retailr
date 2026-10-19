import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant } from "./helpers";

describe("Audit log", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); });
  afterAll(async () => { await app.close(); });
  const S = (x: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...x.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...x.auth).send(b),
  });
  const admin = async () => {
    const r = await api().post("/api/v1/auth/login").send({ email: process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@retailr.com", password: process.env.SEED_SUPER_ADMIN_PASSWORD }).expect(200);
    return ["Authorization", `Bearer ${r.body.accessToken}`] as [string, string];
  };
  const settle = () => new Promise((r) => setTimeout(r, 150)); // the entry is written just after the response

  it("records a business's sensitive changes, with who did it, and shows them only to that business", async () => {
    const x = await newTenant(api), y = await newTenant(api);
    await S(x).post("/business/coupons", { code: `A${run}`.slice(0, 10).toUpperCase(), type: "percent", value: 10, minOrder: 0, maxUses: 5, expiresAt: null, status: "active" }).expect(201);
    await S(y).post("/business/coupons", { code: `B${run}`.slice(0, 10).toUpperCase(), type: "percent", value: 10, minOrder: 0, maxUses: 5, expiresAt: null, status: "active" }).expect(201);
    await settle();
    const log = (await S(x).get("/business/audit").expect(200)).body;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "POST business/coupons", actorRole: "BUSINESS_ADMIN", actorEmail: x.email, businessId: x.businessId });
    expect(log[0].meta.fields).toContain("code");
    await api().get("/api/v1/business/audit").expect(401);
  });

  it("never records reads or secret-looking fields", async () => {
    const x = await newTenant(api);
    await S(x).get("/business/coupons").expect(200);
    await S(x).post("/business/team", { name: "Sam", email: `sam${run}@example.com`, role: "staff", password: "hunter2hunter2" }).catch(() => undefined);
    await settle();
    const log = (await S(x).get("/business/audit").expect(200)).body;
    expect(log.some((e: any) => e.action.startsWith("GET"))).toBe(false);
    expect(JSON.stringify(log)).not.toContain("hunter2");
  });

  it("records platform actions against the business they touch, and lists them for the owner of the platform only", async () => {
    const x = await newTenant(api); const a = await admin();
    await api().patch(`/api/v1/platform/businesses/${x.businessId}/status`).set(...a).send({ status: "suspended" }).expect(200);
    await settle();
    const all = await api().get(`/api/v1/platform/audit?businessId=${x.businessId}`).set(...a).expect(200);
    expect(all.body[0]).toMatchObject({ action: "PATCH platform/businesses/:id/status", actorRole: "SUPER_ADMIN", businessId: x.businessId, meta: { status: "suspended" } });
    expect(Number(all.headers["x-total-count"])).toBe(all.body.length);
    const y = await newTenant(api);
    await api().get("/api/v1/platform/audit").set(...y.auth).expect(403);
  });

  it("a failed request leaves no entry", async () => {
    const x = await newTenant(api);
    await S(x).post("/business/coupons", { nonsense: true }).expect(400);
    await settle();
    expect((await S(x).get("/business/audit").expect(200)).body).toEqual([]);
  });
});
