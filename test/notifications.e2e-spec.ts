import { INestApplication } from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { NotificationsService } from "../src/notifications/notifications.service";
import { boot, newTenant, run, Tenant } from "./helpers";

describe("Notifications", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, svc: NotificationsService;
  let admin: Tenant;
  let n = 0;
  const sent: { endpoint: string; payload: any }[] = [];
  const pushKeys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };

  const as = (t: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...t.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...t.auth).send(b),
  });
  /** A person on a business's team with the given role, signed in through the real accept-invite flow. */
  const teammate = async (owner: Tenant, role: "MANAGER" | "STAFF"): Promise<Tenant> => {
    const token = `invite-${run}-${++n}`, email = `team${n}.${run}@example.com`;
    await prisma.teamMember.create({ data: { businessId: owner.businessId, name: role, email, role, status: "INVITED", inviteTokenHash: createHash("sha256").update(token).digest("hex"), inviteExpiresAt: new Date(Date.now() + 86_400_000) } });
    const r = await api().post("/api/v1/auth/accept-invite").send({ token, password: "password123" }).expect(200);
    return { businessId: owner.businessId, token: r.body.accessToken, auth: ["Authorization", `Bearer ${r.body.accessToken}`], email };
  };
  const until = async <T,>(read: () => Promise<T>, ok: (v: T) => boolean) => {
    let v = await read();
    for (let i = 0; i < 40 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 50)); v = await read(); }
    return v;
  };
  const inbox = async (t: Tenant) => (await as(t).get("/notifications").expect(200)).body as { unreadCount: number; items: any[] };
  const store = async (x: Tenant, stock = 10) => {
    const p = (await as(x).post("/business/products", { name: `Item ${++n}`, sku: "", category: "", description: "", price: 1000, stock, status: "active" }).expect(201)).body;
    const slug = (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
    const buy = (qty: number) => api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "Ada Obi", email: `ada${++n}@example.com`, phone: "123" }, shippingAddress: "x", paymentMethod: "cod", items: [{ productId: p.id, qty }] });
    return { p, buy };
  };

  beforeAll(async () => {
    const keys = require("web-push").generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    ({ app, prisma, api } = await boot());
    svc = app.get(NotificationsService);
    svc.sender = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); };
    const r = await api().post("/api/v1/auth/login").send({ email: process.env.SEED_SUPER_ADMIN_EMAIL ?? "admin@retailr.com", password: process.env.SEED_SUPER_ADMIN_PASSWORD }).expect(200);
    admin = { businessId: "", token: r.body.accessToken, auth: ["Authorization", `Bearer ${r.body.accessToken}`], email: "" };
  });
  afterAll(async () => { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; await app.close(); });

  it("needs a sign-in", async () => {
    await api().get("/api/v1/notifications").expect(401);
    await api().post("/api/v1/notifications/read-all").expect(401);
  });

  it("tells the whole team about a new storefront order, and keeps each person's read state separate", async () => {
    const owner = await newTenant(api), staff = await teammate(owner, "STAFF");
    const { buy } = await store(owner);
    await buy(1).expect(201);
    const mine = await until(() => inbox(owner), (b) => b.items.length >= 1), theirs = await until(() => inbox(staff), (b) => b.items.length >= 1);
    expect(mine.unreadCount).toBe(1);
    expect(mine.items[0]).toMatchObject({ type: "new_order", title: expect.stringMatching(/^New order #/), body: "Ada Obi · ₦1,000", link: "/admin/business/orders", read: false });
    expect(theirs.items).toHaveLength(1);

    await as(owner).post(`/notifications/${mine.items[0].id}/read`).expect(204);
    expect((await inbox(owner))).toMatchObject({ unreadCount: 0, items: [{ read: true }] });
    expect((await inbox(staff)).unreadCount).toBe(1); // reading it didn't mark it read for anyone else
    await as(owner).post(`/notifications/${mine.items[0].id}/read`).expect(204); // again is fine
    await as(owner).post("/notifications/nope/read").expect(404);
    expect((await as(owner).get("/notifications?unread=true").expect(200)).body.items).toHaveLength(0);
  });

  it("never shows one business's notifications to another, or lets them be marked read", async () => {
    const a = await newTenant(api), b = await newTenant(api);
    const { buy } = await store(a);
    await buy(1).expect(201);
    const mine = await until(() => inbox(a), (x) => x.items.length >= 1);
    expect((await inbox(b)).items).toHaveLength(0);
    await as(b).post(`/notifications/${mine.items[0].id}/read`).expect(404);
    expect((await inbox(a)).unreadCount).toBe(1);
    await as(b).post("/notifications/read-all").expect(204);
    expect((await inbox(a)).unreadCount).toBe(1);
  });

  it("marks everything read at once", async () => {
    const x = await newTenant(api);
    const { buy } = await store(x);
    await buy(1).expect(201); await buy(1).expect(201);
    await until(() => inbox(x), (b) => b.unreadCount >= 2);
    await as(x).post("/notifications/read-all").expect(204);
    expect((await inbox(x)).unreadCount).toBe(0);
  });

  it("warns the owner and managers (not staff) when stock runs low or out, once per crossing", async () => {
    const owner = await newTenant(api), manager = await teammate(owner, "MANAGER"), staff = await teammate(owner, "STAFF");
    const { p, buy } = await store(owner, 8);
    const alerts = async (t: Tenant) => (await inbox(t)).items.filter((i) => i.type === "low_stock" || i.type === "out_of_stock");
    await buy(2).expect(201); // 6 left: still fine
    await buy(1).expect(201); // 5 left: low
    const low = await until(() => alerts(owner), (a) => a.length >= 1);
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({ type: "low_stock", title: `${p.name} is running low`, body: "Only 5 left in stock.", link: "/admin/business/products" });
    await buy(1).expect(201); // 4 left: already low, no repeat
    await buy(4).expect(201); // sold out
    const out = await until(() => alerts(owner), (a) => a.length >= 2);
    expect(out.map((i) => i.type).sort()).toEqual(["low_stock", "out_of_stock"]);
    expect((await alerts(manager)).length).toBe(2);
    expect(await alerts(staff)).toHaveLength(0);
    expect((await inbox(staff)).items.every((i) => i.type === "new_order")).toBe(true);
  });

  it("tells the platform admins when a business signs up, and no one else", async () => {
    const before = (await as(admin).get("/notifications").expect(200)).body.unreadCount;
    const x = await newTenant(api, { businessName: `Fresh ${run} ${++n}` });
    const got = await until(() => inbox(admin), (b) => b.unreadCount > before);
    expect(got.items[0]).toMatchObject({ type: "new_business", title: expect.stringContaining("New business: Fresh"), link: "/admin/super/businesses" });
    expect((await inbox(x)).items.every((i) => i.type !== "new_business")).toBe(true);
  });

  describe("browser push", () => {
    const endpoint = () => `https://push.example.com/send/${run}-${++n}`;

    it("hands out the public key", async () => {
      const x = await newTenant(api);
      const k = (await as(x).get("/notifications/push/key").expect(200)).body;
      expect(k).toEqual({ enabled: true, publicKey: process.env.VAPID_PUBLIC_KEY });
      await api().get("/api/v1/notifications/push/key").expect(401);
    });

    it("pushes to every subscribed browser of the people notified, and only them", async () => {
      const owner = await newTenant(api), staff = await teammate(owner, "STAFF"), other = await newTenant(api);
      const e1 = endpoint(), e2 = endpoint(), e3 = endpoint();
      await as(owner).post("/notifications/push/subscribe", { endpoint: e1, keys: pushKeys }).expect(204);
      await as(staff).post("/notifications/push/subscribe", { endpoint: e2, keys: pushKeys }).expect(204);
      await as(other).post("/notifications/push/subscribe", { endpoint: e3, keys: pushKeys }).expect(204);
      const { buy } = await store(owner);
      await buy(1).expect(201);
      await until(async () => sent.filter((s) => [e1, e2, e3].includes(s.endpoint)), (s) => s.length >= 2);
      const mine = sent.filter((s) => [e1, e2, e3].includes(s.endpoint));
      expect(mine.map((s) => s.endpoint).sort()).toEqual([e1, e2].sort());
      expect(mine[0].payload).toMatchObject({ title: expect.stringMatching(/^New order/), body: "Ada Obi · ₦1,000", link: "/admin/business/orders", type: "NEW_ORDER" });
    });

    it("subscribing twice keeps one subscription, and it moves to whoever subscribes last", async () => {
      const a = await newTenant(api), b = await newTenant(api), e = endpoint();
      await as(a).post("/notifications/push/subscribe", { endpoint: e, keys: pushKeys }).expect(204);
      await as(a).post("/notifications/push/subscribe", { endpoint: e, keys: pushKeys }).expect(204);
      expect(await prisma.pushSubscription.count({ where: { endpoint: e } })).toBe(1);
      await as(b).post("/notifications/push/subscribe", { endpoint: e, keys: pushKeys }).expect(204);
      const idOf = async (t: Tenant) => (await prisma.user.findFirstOrThrow({ where: { businessId: t.businessId } })).id;
      expect((await prisma.pushSubscription.findUniqueOrThrow({ where: { endpoint: e } })).userId).toBe(await idOf(b));
      await as(a).post("/notifications/push/unsubscribe", { endpoint: e }).expect(204); // not a's any more: nothing happens
      expect(await prisma.pushSubscription.count({ where: { endpoint: e } })).toBe(1);
      await as(b).post("/notifications/push/unsubscribe", { endpoint: e }).expect(204);
      expect(await prisma.pushSubscription.count({ where: { endpoint: e } })).toBe(0);
    });

    it("rejects malformed subscriptions", async () => {
      const x = await newTenant(api);
      await as(x).post("/notifications/push/subscribe", { endpoint: "http://insecure.example/x", keys: pushKeys }).expect(400);
      await as(x).post("/notifications/push/subscribe", { endpoint: endpoint() }).expect(400);
      await as(x).post("/notifications/push/subscribe", { endpoint: endpoint(), keys: { p256dh: "x" } }).expect(400);
    });

    it("forgets a browser the push service says is gone, and a failing push doesn't break the order", async () => {
      const x = await newTenant(api), gone = endpoint(), flaky = endpoint();
      await as(x).post("/notifications/push/subscribe", { endpoint: gone, keys: pushKeys }).expect(204);
      await as(x).post("/notifications/push/subscribe", { endpoint: flaky, keys: pushKeys }).expect(204);
      const normal = svc.sender;
      svc.sender = async (sub) => { throw Object.assign(new Error("boom"), { statusCode: sub.endpoint === gone ? 410 : 500 }); };
      try {
        const { buy } = await store(x);
        await buy(1).expect(201);
        await until(() => prisma.pushSubscription.count({ where: { endpoint: gone } }), (c) => c === 0);
        expect(await prisma.pushSubscription.count({ where: { endpoint: gone } })).toBe(0);
        expect(await prisma.pushSubscription.count({ where: { endpoint: flaky } })).toBe(1); // a temporary failure keeps it
        expect((await inbox(x)).items.length).toBeGreaterThanOrEqual(1);
      } finally { svc.sender = normal; }
    });
  });

  it("drops notifications older than two months in the nightly clean-up", async () => {
    const x = await newTenant(api);
    const user = await prisma.user.findFirstOrThrow({ where: { businessId: x.businessId } });
    await prisma.notification.create({ data: { userId: user.id, businessId: x.businessId, type: "NEW_ORDER", title: "old", createdAt: new Date(Date.now() - 61 * 86_400_000) } });
    await prisma.notification.create({ data: { userId: user.id, businessId: x.businessId, type: "NEW_ORDER", title: "recent" } });
    expect(await svc.prune()).toBeGreaterThanOrEqual(1);
    expect((await inbox(x)).items.map((i) => i.title)).toEqual(["recent"]);
  });
});
