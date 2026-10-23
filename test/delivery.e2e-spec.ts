import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant } from "./helpers";

describe("Delivery options", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); });
  afterAll(async () => { await app.close(); });

  const setup = async (over: Record<string, unknown> = {}) => {
    const t = await newTenant(api, over);
    const sx = { post: (u: string, b: object) => api().post(`/api/v1${u}`).set(...t.auth).send(b), patch: (u: string, b: object) => api().patch(`/api/v1${u}`).set(...t.auth).send(b) };
    const slug = (await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).slug;
    const p = (await sx.post("/business/products", { name: "P", sku: "", category: "", description: "", price: 1000, stock: 50, status: "active" }).expect(201)).body;
    const buy = (extra: object, qty = 1) => api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "A B", email: "ab@example.com", phone: "1" }, paymentMethod: "cod", items: [{ productId: p.id, qty }], ...extra });
    return { t, sx, slug, p, buy };
  };
  const zones = [{ kind: "local", name: "Lekki", fee: 2500 }, { kind: "international", name: "United Kingdom", fee: 20000, note: "Allow 7 days" }];

  it("keeps free delivery with an address until the business sets up delivery options", async () => {
    const { buy } = await setup();
    const r = (await buy({ shippingAddress: "1 Road" }).expect(201)).body;
    expect(r).toMatchObject({ total: 1000, shippingFee: 0 });
    await buy({}).expect(400);
  });

  it("adds the chosen zone's fee on the server, and offers pickup at zero", async () => {
    const { sx, slug, buy } = await setup();
    const saved = (await sx.patch("/business/profile", { delivery: { pickup: { enabled: true, address: "5 Shop St", hours: "9-5" }, zones } }).expect(200)).body;
    expect(saved.delivery.zones).toHaveLength(2);
    const id = saved.delivery.zones[0].id;
    const pub = (await api().get(`/api/v1/store/${slug}`).expect(200)).body.delivery;
    expect(pub).toMatchObject({ configured: true, pickup: { enabled: true, address: "5 Shop St" } });
    const o = (await buy({ shippingAddress: "1 Road", deliveryMethod: "delivery", deliveryZoneId: id }).expect(201)).body;
    expect(o).toMatchObject({ total: 3500, shippingFee: 2500, deliveryZone: "Lekki", deliveryMethod: "delivery" });
    expect((await buy({ shippingAddress: "1 Road" }).expect(400)).body.code).toBe("DELIVERY_ZONE_REQUIRED");
    expect((await buy({ shippingAddress: "1 Road", deliveryMethod: "delivery", deliveryZoneId: "nope" }).expect(400)).body.code).toBe("DELIVERY_ZONE_REQUIRED");
    const pick = (await buy({ deliveryMethod: "pickup" }).expect(201)).body;
    expect(pick).toMatchObject({ total: 1000, shippingFee: 0, deliveryMethod: "pickup" });
  });

  it("refuses pickup that isn't switched on and pickup without an address", async () => {
    const { sx, buy } = await setup();
    await sx.patch("/business/profile", { delivery: { pickup: { enabled: false }, zones } }).expect(200);
    expect((await buy({ deliveryMethod: "pickup" }).expect(400)).body.code).toBe("PICKUP_UNAVAILABLE");
    expect((await sx.patch("/business/profile", { delivery: { pickup: { enabled: true, address: " " }, zones: [] } }).expect(400)).body.code).toBe("PICKUP_ADDRESS_REQUIRED");
  });

  it("validates zones", async () => {
    const { sx } = await setup();
    const code = async (zs: object[]) => (await sx.patch("/business/profile", { delivery: { pickup: { enabled: false }, zones: zs } }).expect(400)).body.code;
    expect(await code([{ kind: "local", name: " ", fee: 1 }])).toBe("DELIVERY_ZONE_NAME");
    expect(await code([{ kind: "local", name: "A", fee: 1 }, { kind: "local", name: "a", fee: 2 }])).toBe("DELIVERY_ZONE_DUPLICATE");
    await sx.patch("/business/profile", { delivery: { pickup: { enabled: false }, zones: [{ kind: "local", name: "A", fee: -1 }] } }).expect(400);
  });

  it("applies the free-shipping threshold on paid plans only", async () => {
    const paid = await setup();
    const saved = (await paid.sx.patch("/business/profile", { delivery: { pickup: { enabled: false }, zones, freeShippingThreshold: 2000 } }).expect(200)).body;
    const id = saved.delivery.zones[0].id;
    const small = (await paid.buy({ shippingAddress: "x", deliveryZoneId: id }, 1).expect(201)).body;
    expect(small.shippingFee).toBe(2500);
    const big = (await paid.buy({ shippingAddress: "x", deliveryZoneId: id }, 2).expect(201)).body;
    expect(big).toMatchObject({ shippingFee: 0, total: 2000 });

    const free = await setup({ planId: "plan_basic" });
    const denied = await free.sx.patch("/business/profile", { delivery: { pickup: { enabled: false }, zones, freeShippingThreshold: 2000 } }).expect(403);
    expect(denied.body.code).toBe("FEATURE_NOT_IN_PLAN");
    await free.sx.patch("/business/profile", { delivery: { pickup: { enabled: false }, zones } }).expect(200);
  });

  it("stops applying a saved threshold if the business drops to a free plan", async () => {
    const { t, sx, slug, buy } = await setup();
    const saved = (await sx.patch("/business/profile", { delivery: { pickup: { enabled: false }, zones, freeShippingThreshold: 500 } }).expect(200)).body;
    await prisma.business.update({ where: { id: t.businessId }, data: { planId: "plan_basic" } });
    expect((await api().get(`/api/v1/store/${slug}`).expect(200)).body.delivery.freeShippingThreshold).toBeNull();
    expect((await buy({ shippingAddress: "x", deliveryZoneId: saved.delivery.zones[0].id }).expect(201)).body.shippingFee).toBe(2500);
  });
});
