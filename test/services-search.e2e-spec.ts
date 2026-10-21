import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, Tenant } from "./helpers";

describe("Services and search", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); });
  afterAll(async () => { await app.close(); });

  const as = (t: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...t.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...t.auth).send(b),
    put: (p: string, b: object = {}) => api().put(`/api/v1${p}`).set(...t.auth).send(b),
    patch: (p: string, b: object = {}) => api().patch(`/api/v1${p}`).set(...t.auth).send(b),
  });
  const service = (x: Tenant, over: object = {}) =>
    as(x).post("/business/products", { name: "Haircut", kind: "service", durationMins: 45, price: 5000, status: "active", ...over });
  const slugOf = async (x: Tenant) => (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;

  it("creates a service with no stock, and never marks it sold out", async () => {
    const x = await newTenant(api);
    const s = (await service(x).expect(201)).body;
    expect(s).toMatchObject({ kind: "service", durationMins: 45, stock: 0, status: "active" });
    // even if the owner sends out_of_stock, a service stays active
    const again = (await as(x).put(`/business/products/${s.id}`, { name: "Haircut", kind: "service", price: 5000, status: "out_of_stock" }).expect(200)).body;
    expect(again.status).toBe("active");
    // plain products still default to stocked
    const p = (await as(x).post("/business/products", { name: "Comb", price: 100, stock: 0, status: "active" }).expect(201)).body;
    expect(p).toMatchObject({ kind: "product", status: "out_of_stock" });
    expect((await as(x).get("/business/products?kind=service").expect(200)).body.map((r: any) => r.id)).toEqual([s.id]);
  });

  it("sells a service from the storefront and from a recorded sale without touching stock", async () => {
    const x = await newTenant(api);
    const s = (await service(x).expect(201)).body;
    const slug = await slugOf(x);
    const res = await api().post(`/api/v1/store/${slug}/orders`)
      .send({ customer: { name: "Ada Obi", email: "ada@example.com", phone: "123" }, shippingAddress: "x", paymentMethod: "cod", items: [{ productId: s.id, qty: 3 }] });
    expect(res.status).toBe(201);
    await as(x).post("/business/sales", { items: [{ productId: s.id, qty: 2 }], channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true, newCustomer: { name: "Walk in" } }).expect(201);
    const after = (await as(x).get(`/business/products/${s.id}`).expect(200)).body;
    expect(after).toMatchObject({ stock: 0, sold: 5, status: "active" });
    // cancelling gives back the sold count, not stock
    const order = (await as(x).get("/business/orders").expect(200)).body.find((o: any) => o.channel === "online");
    await as(x).patch(`/business/orders/${order.id}/status`, { status: "cancelled" }).expect(200);
    const cancelled = (await as(x).get(`/business/products/${s.id}`).expect(200)).body;
    expect(cancelled.stock).toBe(0);
    expect(cancelled.sold).toBeLessThan(5);
  });

  it("searches orders, customers and products in one call, only within the business", async () => {
    const x = await newTenant(api), other = await newTenant(api);
    const lamp = (await as(x).post("/business/products", { name: "Zebra Lamp", price: 100, stock: 3, status: "active" }).expect(201)).body;
    await service(x, { name: "Zebra Grooming" }).expect(201);
    await as(other).post("/business/products", { name: "Zebra Secret", price: 100, stock: 3, status: "active" }).expect(201);
    await as(x).post("/business/sales", { items: [{ productId: lamp.id, qty: 1 }], channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true, newCustomer: { name: "Zebra Fan" } }).expect(201);

    const r = (await as(x).get("/business/search?q=zebra").expect(200)).body;
    expect(r.products.map((p: any) => p.name).sort()).toEqual(["Zebra Grooming", "Zebra Lamp"]);
    expect(r.customers.map((c: any) => c.name)).toEqual(["Zebra Fan"]);
    expect(r.orders.map((o: any) => o.customerName)).toEqual(["Zebra Fan"]);
    expect((await as(x).get("/business/search?q=z").expect(200)).body).toMatchObject({ orders: [], customers: [], products: [] });
    await api().get("/api/v1/business/search?q=zebra").expect(401);
  });
});
