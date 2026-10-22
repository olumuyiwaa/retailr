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
    as(x).post("/business/services", { name: "Haircut", durationMins: 45, price: 5000, status: "active", ...over });
  const slugOf = async (x: Tenant) => (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
  const checkout = (slug: string, items: object[]) =>
    api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "Ada Obi", email: "ada@example.com", phone: "123" }, shippingAddress: "x", paymentMethod: "cod", items });

  it("keeps services apart from products: separate endpoints, no stock", async () => {
    const x = await newTenant(api);
    const s = (await service(x).expect(201)).body;
    expect(s).toMatchObject({ durationMins: 45, status: "active" });
    expect(s.stock).toBeUndefined();
    const p = (await as(x).post("/business/products", { name: "Comb", price: 100, stock: 0, status: "active" }).expect(201)).body;
    expect(p).toMatchObject({ status: "out_of_stock" });
    expect((await as(x).get("/business/services").expect(200)).body.map((r: any) => r.id)).toEqual([s.id]);
    expect((await as(x).get("/business/products").expect(200)).body.map((r: any) => r.id)).toEqual([p.id]);
    await as(x).get(`/business/products/${s.id}`).expect(404);
    await as(x).get(`/business/services/${p.id}`).expect(404);
    // services can't be out of stock
    await as(x).put(`/business/services/${s.id}`, { name: "Haircut", price: 5000, status: "out_of_stock" }).expect(400);
  });

  it("lists only active services on the storefront and keeps them out of the products list", async () => {
    const x = await newTenant(api);
    const live = (await service(x).expect(201)).body;
    await service(x, { name: "Secret", status: "draft" }).expect(201);
    const slug = await slugOf(x);
    expect((await api().get(`/api/v1/store/${slug}/services`).expect(200)).body.map((r: any) => r.id)).toEqual([live.id]);
    expect((await api().get(`/api/v1/store/${slug}/products`).expect(200)).body).toEqual([]);
  });

  it("sells a service from the storefront and a recorded sale, counting sold without stock, with priced options", async () => {
    const x = await newTenant(api);
    const s = (await service(x, { options: [{ name: "Short", price: 4000 }, { name: "Long", price: 7000 }] }).expect(201)).body;
    expect(s.options).toHaveLength(2);
    const slug = await slugOf(x);
    expect((await checkout(slug, [{ serviceId: s.id, qty: 1 }])).body.code).toBe("OPTION_REQUIRED");
    const long = s.options.find((o: any) => o.name === "Long");
    const res = await checkout(slug, [{ serviceId: s.id, optionId: long.id, qty: 3 }]);
    expect(res.status).toBe(201);
    expect(res.body.items[0]).toMatchObject({ serviceId: s.id, optionId: long.id, name: "Haircut (Long)", qty: 3, price: 7000 });
    expect(res.body.total).toBe(21000);
    await as(x).post("/business/sales", { items: [{ serviceId: s.id, optionId: long.id, qty: 2 }], channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true, newCustomer: { name: "Walk in" } }).expect(201);
    expect((await as(x).get(`/business/services/${s.id}`).expect(200)).body.sold).toBe(5);
    // cancelling gives back the sold count
    const order = (await as(x).get("/business/orders").expect(200)).body.find((o: any) => o.channel === "online");
    await as(x).patch(`/business/orders/${order.id}/status`, { status: "cancelled" }).expect(200);
    expect((await as(x).get(`/business/services/${s.id}`).expect(200)).body.sold).toBe(2);
  });

  it("rejects a line that is both or neither, and keeps one business's services private", async () => {
    const x = await newTenant(api), other = await newTenant(api);
    const s = (await service(x).expect(201)).body;
    const p = (await as(x).post("/business/products", { name: "Comb", price: 100, stock: 3, status: "active" }).expect(201)).body;
    const slug = await slugOf(x);
    await checkout(slug, [{ serviceId: s.id, productId: p.id, qty: 1 }]).expect(400);
    await checkout(slug, [{ qty: 1 }]).expect(400);
    await as(other).get(`/business/services/${s.id}`).expect(404);
    await as(other).put(`/business/services/${s.id}`, { name: "Mine now", price: 1, status: "active" }).expect(404);
  });

  it("searches orders, customers, products and services in one call, only within the business", async () => {
    const x = await newTenant(api), other = await newTenant(api);
    const lamp = (await as(x).post("/business/products", { name: "Zebra Lamp", price: 100, stock: 3, status: "active" }).expect(201)).body;
    await service(x, { name: "Zebra Grooming" }).expect(201);
    await as(other).post("/business/products", { name: "Zebra Secret", price: 100, stock: 3, status: "active" }).expect(201);
    await as(x).post("/business/sales", { items: [{ productId: lamp.id, qty: 1 }], channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true, newCustomer: { name: "Zebra Fan" } }).expect(201);

    const r = (await as(x).get("/business/search?q=zebra").expect(200)).body;
    expect(r.products.map((p: any) => p.name)).toEqual(["Zebra Lamp"]);
    expect(r.services.map((p: any) => p.name)).toEqual(["Zebra Grooming"]);
    expect(r.customers.map((c: any) => c.name)).toEqual(["Zebra Fan"]);
    expect(r.orders.map((o: any) => o.customerName)).toEqual(["Zebra Fan"]);
    expect((await as(x).get("/business/search?q=z").expect(200)).body).toMatchObject({ orders: [], customers: [], products: [], services: [] });
    await api().get("/api/v1/business/search?q=zebra").expect(401);
  });
});
