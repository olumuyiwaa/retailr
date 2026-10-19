import { INestApplication } from "@nestjs/common";
import { MailService } from "../src/mail/mail.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant } from "./helpers";

describe("Team permissions", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, mail: MailService;
  let n = 0;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); mail = app.get(MailService); });
  afterAll(async () => { await app.close(); });

  const as = (t: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...t.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...t.auth).send(b),
    put: (p: string, b: object = {}) => api().put(`/api/v1${p}`).set(...t.auth).send(b),
    patch: (p: string, b: object = {}) => api().patch(`/api/v1${p}`).set(...t.auth).send(b),
    del: (p: string) => api().delete(`/api/v1${p}`).set(...t.auth),
  });
  /** Invites someone with a role and has them accept, returning their session. */
  const member = async (owner: Tenant, role: "manager" | "staff"): Promise<Tenant & { memberId: string }> => {
    const email = `m${++n}.${run}@example.com`;
    const m = (await as(owner).post("/business/team", { name: "Team Mate", email, role }).expect(201)).body;
    const mailed = [...mail.outbox].reverse().find((x: any) => x.to === email)!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(mailed.text)![1];
    const r = await api().post("/api/v1/auth/accept-invite").send({ token, password: "password123" }).expect(200);
    return { businessId: owner.businessId, token: r.body.accessToken, auth: ["Authorization", `Bearer ${r.body.accessToken}`], email, memberId: m.id };
  };
  const product = { name: "P", sku: "", category: "", description: "", price: 10, stock: 5, status: "active" };

  it("staff can work orders, sales and customers and read the catalogue, but nothing else", async () => {
    const owner = await newTenant(api); const staff = await member(owner, "staff");
    const p = (await as(owner).post("/business/products", product).expect(201)).body;
    const s = as(staff);
    await s.get("/business/products").expect(200);
    await s.get("/business/categories").expect(200);
    await s.get("/business/orders").expect(200);
    await s.get("/business/customers").expect(200);
    await s.get("/business/overview").expect(200);
    await s.get("/business/profile").expect(200);
    await s.post("/business/sales", { items: [{ productId: p.id, qty: 1 }], channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true }).expect(201);
    // no catalogue changes, reports, marketing, team, billing, settings
    await s.post("/business/products", product).expect(403);
    await s.put(`/business/products/${p.id}`, product).expect(403);
    await s.del(`/business/products/${p.id}`).expect(403);
    await s.post("/business/categories", { name: "X" }).expect(403);
    await s.post("/business/uploads", { kind: "product", contentType: "image/png", size: 10 }).expect(403);
    await s.get("/business/reports/sales").expect(403);
    await s.get("/business/analytics").expect(403);
    await s.get("/business/coupons").expect(403);
    await s.get("/business/groups").expect(403);
    await s.get("/business/messages").expect(403);
    await s.get("/business/team").expect(403);
    await s.get("/business/billing").expect(403);
    await s.patch("/business/profile", { name: "Mine now" }).expect(403);
    await s.get("/business/audit").expect(403);
    expect((await s.get("/business/billing")).body.code).toBe("INSUFFICIENT_ROLE");
  });

  it("a manager runs the shop but can't touch billing, the team or store settings", async () => {
    const owner = await newTenant(api); const mgr = await member(owner, "manager");
    const m = as(mgr);
    const p = (await m.post("/business/products", product).expect(201)).body;
    await m.put(`/business/products/${p.id}`, product).expect(200);
    await m.get("/business/reports/sales").expect(200);
    await m.get("/business/analytics").expect(200);
    await m.get("/business/coupons").expect(200);
    await m.get("/business/groups").expect(200);
    await m.get("/business/messages").expect(200);
    await m.get("/business/team").expect(200);
    await m.get("/business/orders").expect(200);
    await m.post("/business/uploads", { kind: "product", contentType: "image/png", size: 10 }).expect(200);
    await m.get("/business/billing").expect(403);
    await m.post("/business/billing/change-plan", { planId: "plan_basic", cycle: "monthly" }).expect(403);
    await m.post("/business/team", { name: "X", email: `x${run}@example.com`, role: "staff" }).expect(403);
    await m.patch("/business/profile", { name: "Mine now" }).expect(403);
    await m.get("/business/audit").expect(403);
  });

  it("the session tells the app which role the person has", async () => {
    const owner = await newTenant(api); const staff = await member(owner, "staff");
    expect((await as(owner).get("/auth/me").expect(200)).body.teamRole).toBe("owner");
    expect((await as(staff).get("/auth/me").expect(200)).body.teamRole).toBe("staff");
    const login = await api().post("/api/v1/auth/login").send({ email: staff.email, password: "password123" }).expect(200);
    expect(login.body.user.teamRole).toBe("staff");
  });

  it("the owner can do everything", async () => {
    const owner = await newTenant(api); const o = as(owner);
    await o.get("/business/billing").expect(200);
    await o.get("/business/team").expect(200);
    await o.patch("/business/profile", { name: "Owner renamed" }).expect(200);
    await o.get("/business/audit").expect(200);
    await o.get("/business/reports/sales").expect(200);
  });

  it("removing a member cuts their access at once, even with a token that hasn't expired", async () => {
    const owner = await newTenant(api); const mgr = await member(owner, "manager");
    await as(mgr).get("/business/orders").expect(200);
    await as(owner).del(`/business/team/${mgr.memberId}`).expect(204);
    const r = await as(mgr).get("/business/orders").expect(403);
    expect(r.body.code).toBe("TEAM_ACCESS_REVOKED");
  });

  it("a member can't reach another business, and an invited-but-not-joined person has no login", async () => {
    const a = await newTenant(api), b = await newTenant(api);
    const staff = await member(a, "staff");
    const pb = (await as(b).post("/business/products", product).expect(201)).body;
    await as(staff).get(`/business/products/${pb.id}`).expect(404);
    expect((await as(staff).get("/business/orders").expect(200)).body).toEqual([]);
    const email = `pend${run}@example.com`;
    await as(a).post("/business/team", { name: "Pending", email, role: "staff" }).expect(201);
    await api().post("/api/v1/auth/login").send({ email, password: "password123" }).expect(401);
  });
});
