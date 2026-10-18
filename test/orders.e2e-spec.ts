import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant } from "./helpers";

describe("Storefront and orders", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  let t: Tenant, slug: string;
  let n = 0;
  const post = (x: Tenant, path: string, body: object) => api().post(`/api/v1${path}`).set(...x.auth).send(body);
  const get = (x: Tenant, path: string) => api().get(`/api/v1${path}`).set(...x.auth);
  const patch = (x: Tenant, path: string, body: object) => api().patch(`/api/v1${path}`).set(...x.auth).send(body);
  const mk = async (x: Tenant, over: Record<string, unknown> = {}) =>
    (await post(x, "/business/products", { name: `Item ${++n}`, sku: "", category: "", description: "", price: 100, stock: 10, status: "active", ...over }).expect(201)).body;
  const slugOf = async (x: Tenant) => (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
  const shopper = (over: Record<string, unknown> = {}) => ({ name: "Chidi Eze", email: `Chidi${++n}.${run}@Example.com`, phone: "0803", ...over });
  const order = (s: string, items: object[], over: Record<string, unknown> = {}) =>
    api().post(`/api/v1/store/${s}/orders`).send({ customer: shopper(), shippingAddress: "12 Ikoyi Rd, Lagos", paymentMethod: "cod", items, ...over });
  const stockOf = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } }));

  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    t = await newTenant(api);
    slug = await slugOf(t);
  });
  afterAll(async () => { await app.close(); });

  describe("public store", () => {
    it("shows the store, hides drafts, and lists only categories that have something on sale", async () => {
      await post(t, "/business/categories", { name: "Live Cat" });
      await post(t, "/business/categories", { name: "Empty Cat" });
      await post(t, "/business/categories", { name: "Draft Cat" });
      const live = await mk(t, { name: "Visible", category: "Live Cat" });
      await mk(t, { name: "Hidden", category: "Draft Cat", status: "draft" });
      await mk(t, { name: "Sold out one", stock: 0, category: "Live Cat" });
      const store = (await api().get(`/api/v1/store/${slug}`).expect(200)).body;
      expect(store).toMatchObject({ slug, currency: "NGN", city: "Lagos" });
      expect(store.ownerEmail).toBeUndefined(); // shoppers never see owner details
      const names = (await api().get(`/api/v1/store/${slug}/products`).expect(200)).body.map((p: any) => p.name);
      expect(names).toContain("Visible");
      expect(names).toContain("Sold out one"); // stays visible, can't be bought
      expect(names).not.toContain("Hidden");
      expect((await api().get(`/api/v1/store/${slug}/categories`).expect(200)).body).toEqual([{ name: "Live Cat" }]);
      expect(live.id).toBeTruthy();
    });

    it("is unavailable unless the business is active or on trial", async () => {
      const x = await newTenant(api);
      const s = await slugOf(x);
      await api().get(`/api/v1/store/${s}`).expect(200);
      for (const status of ["PENDING", "SUSPENDED", "CANCELLED"]) {
        await prisma.business.update({ where: { id: x.businessId }, data: { status: status as never } });
        const r = await api().get(`/api/v1/store/${s}`).expect(404);
        expect(r.body).toMatchObject({ code: "STORE_UNAVAILABLE", message: "This store isn't available right now." });
        await api().get(`/api/v1/store/${s}/products`).expect(404);
      }
      await api().get("/api/v1/store/no-such-store").expect(404);
    });
  });

  describe("placing an order", () => {
    it("prices lines, snapshots names, numbers orders per business and finds the order by token", async () => {
      const p = await mk(t, { name: "Dress", price: 100, stock: 9, variants: [{ name: "S", stock: 4 }, { name: "L", stock: 5, price: 150 }] });
      const [s, l] = p.variants;
      const shop = shopper();
      const r = await order(slug, [{ productId: p.id, variantId: l.id, qty: 2 }, { productId: p.id, variantId: s.id, qty: 1 }], { customer: shop, notes: "Gift wrap" }).expect(201);
      const o = r.body;
      expect(o).toMatchObject({ status: "pending", paymentStatus: "unpaid", channel: "online", paymentMethod: "cod", total: 400, notes: "Gift wrap", customerName: "Chidi Eze", customerEmail: shop.email.toLowerCase() });
      expect(o.items).toEqual([
        { productId: p.id, variantId: l.id, name: "Dress (L)", qty: 2, price: 150 },
        { productId: p.id, variantId: s.id, name: "Dress (S)", qty: 1, price: 100 },
      ]);
      expect(o.number).toMatch(/^#[A-Z0-9]{2}\d{4}$/);
      expect(o.publicToken).toBeTruthy();
      const second = (await order(slug, [{ productId: p.id, variantId: s.id, qty: 1 }]).expect(201)).body;
      expect(Number(second.number.slice(3))).toBe(Number(o.number.slice(3)) + 1);

      const fresh = await stockOf(p.id);
      expect(fresh.stock).toBe(9 - 4);
      expect(fresh.sold).toBe(4);
      expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: l.id } })).stock).toBe(3);

      const seen = (await api().get(`/api/v1/store/orders/${o.publicToken}`).expect(200)).body;
      expect(seen.order.number).toBe(o.number);
      expect(seen.store.slug).toBe(slug);
      await api().get(`/api/v1/store/orders/${o.id}`).expect(404); // the id is not a way in
    });

    it("creates the customer once per email, case-insensitively", async () => {
      const p = await mk(t);
      const email = `Repeat.${run}@Example.COM`;
      await order(slug, [{ productId: p.id, qty: 1 }], { customer: shopper({ email }) }).expect(201);
      await order(slug, [{ productId: p.id, qty: 1 }], { customer: shopper({ email: email.toLowerCase() }) }).expect(201);
      expect(await prisma.customer.count({ where: { businessId: t.businessId, email: email.toLowerCase() } })).toBe(1);
    });

    it("explains every way a cart can be wrong, in the UI's words", async () => {
      const plain = await mk(t, { name: "Plain", stock: 2 });
      const opt = await mk(t, { name: "Opts", variants: [{ name: "M", stock: 1 }, { name: "XL", stock: 0 }] });
      const draft = await mk(t, { name: "Draft", status: "draft" });
      const out = await mk(t, { name: "Gone", stock: 0 });
      const bad = async (items: object[], status = 400) => (await order(slug, items).expect(status)).body.message;
      expect(await bad([{ productId: plain.id, qty: 3 }])).toBe("Only 2 of Plain left in stock.");
      expect(await bad([{ productId: out.id, qty: 1 }])).toBe("Gone is sold out.");
      expect(await bad([{ productId: opt.id, qty: 1 }])).toBe("Please choose an option for Opts.");
      expect(await bad([{ productId: opt.id, variantId: opt.variants[1].id, qty: 1 }])).toBe("Opts (XL) is sold out.");
      expect(await bad([{ productId: opt.id, variantId: opt.variants[0].id, qty: 2 }])).toBe("Only 1 of Opts (M) left in stock.");
      expect(await bad([{ productId: draft.id, qty: 1 }])).toBe("One of the items in your cart is no longer available.");
      expect(await bad([{ productId: "nope", qty: 1 }])).toBe("One of the items in your cart is no longer available.");
      expect(await bad([{ productId: plain.id, qty: 0 }])).toBe("Invalid quantity.");
      expect(await bad([{ productId: plain.id, qty: 1.5 }])).toBe("Invalid quantity.");
      expect(await bad([])).toBe("Your cart is empty.");
      expect((await stockOf(plain.id)).stock).toBe(2); // nothing changed
    });

    it("can't be tricked past the stock check by listing a product twice", async () => {
      const p = await mk(t, { name: "Twice", stock: 3 });
      const r = await order(slug, [{ productId: p.id, qty: 2 }, { productId: p.id, qty: 2 }]).expect(400);
      expect(r.body.message).toBe("Only 3 of Twice left in stock.");
      expect((await stockOf(p.id)).stock).toBe(3);
    });

    it("sells the last items to exactly the right number of simultaneous shoppers", async () => {
      const p = await mk(t, { name: "Last ones", stock: 3 });
      const results = await Promise.all(Array.from({ length: 8 }, () => order(slug, [{ productId: p.id, qty: 1 }])));
      expect(results.filter((r: any) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r: any) => r.status === 400).every((r: any) => /sold out/.test(r.body.message))).toBe(true);
      const after = await stockOf(p.id);
      expect(after).toMatchObject({ stock: 0, sold: 3, status: "OUT_OF_STOCK" });
      const numbers = (await prisma.order.findMany({ where: { items: { some: { productId: p.id } } } })).map((o) => o.number);
      expect(new Set(numbers).size).toBe(3); // no duplicate order numbers
    });

    it("fails whole: a late failure leaves stock, coupons and counters untouched", async () => {
      const a = await mk(t, { name: "OK item", stock: 5 });
      const b = await mk(t, { name: "Short item", stock: 1 });
      const before = await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } });
      await order(slug, [{ productId: a.id, qty: 2 }, { productId: b.id, qty: 5 }]).expect(400);
      expect((await stockOf(a.id)).stock).toBe(5);
      expect((await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).orderSeq).toBe(before.orderSeq);
    });

    it("marks card orders paid only in demo mode, and counts them toward the customer's totals", async () => {
      const p = await mk(t, { price: 50 });
      const email = `card.${run}@example.com`;
      const o = (await order(slug, [{ productId: p.id, qty: 2 }], { paymentMethod: "card", customer: shopper({ email }) }).expect(201)).body;
      expect(o).toMatchObject({ paymentStatus: "paid", status: "pending", total: 100 });
      const c = await prisma.customer.findFirstOrThrow({ where: { businessId: t.businessId, email } });
      expect(c.ordersCount).toBe(1);
      expect(Number(c.totalSpent)).toBe(100);
      await order(slug, [{ productId: p.id, qty: 1 }], { customer: shopper({ email }) }).expect(201); // unpaid COD doesn't count
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).ordersCount).toBe(1);
    });

    it("rejects bad customer details and payment methods with plain messages", async () => {
      const p = await mk(t);
      const items = [{ productId: p.id, qty: 1 }];
      expect((await order(slug, items, { customer: shopper({ email: "nope" }) }).expect(400)).body.message).toBe("Enter a valid email address.");
      expect((await order(slug, items, { customer: shopper({ name: " " }) }).expect(400)).body.message).toBe("Please enter your name.");
      expect((await order(slug, items, { shippingAddress: "" }).expect(400)).body.message).toBe("Please enter your delivery address.");
      expect((await order(slug, items, { paymentMethod: "cash" }).expect(400)).body.code).toBe("VALIDATION_ERROR");
    });

    it("stops at the plan's monthly order limit", async () => {
      const plan = await prisma.plan.create({ data: { id: `ord_${run}`, name: "Two a month", priceMonthly: 1, priceYearly: 10, maxProducts: 50, maxStaff: 1, maxOrdersPerMonth: 2, maxStorageGb: 1, features: [] } });
      const x = await newTenant(api);
      await prisma.business.update({ where: { id: x.businessId }, data: { planId: plan.id } });
      const s = await slugOf(x);
      const p = await mk(x);
      await order(s, [{ productId: p.id, qty: 1 }]).expect(201);
      await order(s, [{ productId: p.id, qty: 1 }]).expect(201);
      const r = await order(s, [{ productId: p.id, qty: 1 }]).expect(403);
      expect(r.body).toMatchObject({ code: "PLAN_LIMIT_ORDERS", message: "This store isn't taking new orders right now. Please try again later." });
      expect((await stockOf(p.id)).stock).toBe(8);
    });
  });

  describe("shopper coupons", () => {
    const coupon = (over: Record<string, unknown>) => post(t, "/business/coupons", over);
    it("applies percent and fixed discounts, capped at the subtotal, and counts uses", async () => {
      const p = await mk(t, { price: 1000 });
      await prisma.coupon.createMany({ data: [
        { businessId: t.businessId, code: `PCT${run}`.toUpperCase(), type: "PERCENT", value: 10 },
        { businessId: t.businessId, code: `BIG${run}`.toUpperCase(), type: "FIXED", value: 5000 },
      ] });
      const pct = (await order(slug, [{ productId: p.id, qty: 2 }], { couponCode: `pct${run}` }).expect(201)).body;
      expect(pct).toMatchObject({ total: 1800, discount: 200, couponCode: `PCT${run}`.toUpperCase() });
      const big = (await order(slug, [{ productId: p.id, qty: 1 }], { couponCode: `BIG${run}` }).expect(201)).body;
      expect(big).toMatchObject({ total: 0, discount: 1000 });
      expect((await prisma.coupon.findFirstOrThrow({ where: { code: `PCT${run}`.toUpperCase() } })).usedCount).toBe(1);
    });

    it("previews a code without using it, and explains why a code fails", async () => {
      const p = await mk(t, { price: 1000 });
      const code = (s: string) => `${s}${run}`.toUpperCase();
      await prisma.coupon.createMany({ data: [
        { businessId: t.businessId, code: code("MIN"), type: "FIXED", value: 100, minOrder: 5000 },
        { businessId: t.businessId, code: code("OLD"), type: "FIXED", value: 100, expiresAt: new Date(Date.now() - 1000) },
        { businessId: t.businessId, code: code("OFF"), type: "FIXED", value: 100, status: "DISABLED" },
        { businessId: t.businessId, code: code("PRV"), type: "PERCENT", value: 25 },
      ] });
      const ask = (c: string, subtotal = 1000) => api().post(`/api/v1/store/${slug}/coupons/validate`).send({ code: c, subtotal });
      expect((await ask(code("PRV"), 2000).expect(200)).body).toEqual({ code: code("PRV"), discount: 500 });
      expect((await prisma.coupon.findFirstOrThrow({ where: { code: code("PRV") } })).usedCount).toBe(0);
      expect((await ask(code("MIN")).expect(400)).body.message).toBe("Spend at least ₦5,000 to use this code.");
      expect((await ask(code("OLD")).expect(400)).body.message).toBe("That code has expired.");
      expect((await ask(code("OFF")).expect(400)).body.message).toBe("That code isn't valid.");
      expect((await ask("NOPE").expect(400)).body.message).toBe("That code isn't valid.");
      expect((await order(slug, [{ productId: p.id, qty: 1 }], { couponCode: code("MIN") }).expect(400)).body.message).toBe("Spend at least ₦5,000 to use this code.");
    });

    it("gives a single-use code to exactly one of several simultaneous shoppers, with stock restored for the rest", async () => {
      const p = await mk(t, { price: 100, stock: 10 });
      const code = `ONCE${run}`.toUpperCase();
      await prisma.coupon.create({ data: { businessId: t.businessId, code, type: "PERCENT", value: 10, maxUses: 1 } });
      const results = await Promise.all([1, 2, 3, 4].map(() => order(slug, [{ productId: p.id, qty: 1 }], { couponCode: code })));
      expect(results.filter((r: any) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r: any) => r.status === 400).map((r: any) => r.body.message)).toEqual(Array(3).fill("That code has been fully used."));
      expect((await prisma.coupon.findFirstOrThrow({ where: { code } })).usedCount).toBe(1);
      expect((await stockOf(p.id)).stock).toBe(9); // failed orders rolled back
    });

    it("keeps one business's codes out of another's checkout", async () => {
      const x = await newTenant(api);
      const p = await mk(x);
      const code = `MINE${run}`.toUpperCase();
      await prisma.coupon.create({ data: { businessId: t.businessId, code, type: "PERCENT", value: 50 } });
      expect((await order(await slugOf(x), [{ productId: p.id, qty: 1 }], { couponCode: code }).expect(400)).body.message).toBe("That code isn't valid.");
    });
  });

  describe("managing orders", () => {
    let paidOrder: any, product: any, email: string;
    beforeAll(async () => {
      product = await mk(t, { name: "Managed", price: 200, stock: 10 });
      email = `mgr.${run}@example.com`;
      paidOrder = (await order(slug, [{ productId: product.id, qty: 3 }], { paymentMethod: "card", customer: shopper({ email }) }).expect(201)).body;
    });

    it("lists with filters and a total-count header, and only the business's own", async () => {
      const all = await get(t, "/business/orders?limit=2").expect(200);
      expect(all.body).toHaveLength(2);
      expect(Number(all.headers["x-total-count"])).toBeGreaterThan(2);
      expect((await get(t, `/business/orders?q=${paidOrder.number.slice(1)}`).expect(200)).body.map((o: any) => o.id)).toEqual([paidOrder.id]);
      expect((await get(t, "/business/orders?paymentStatus=paid&channel=online&status=pending").expect(200)).body.every((o: any) => o.paymentStatus === "paid")).toBe(true);
      expect((await get(t, "/business/orders?channel=whatsapp&q=zzzz").expect(200)).body).toEqual([]);
      const other = await newTenant(api);
      expect((await get(other, "/business/orders").expect(200)).body).toEqual([]);
      await get(other, `/business/orders/${paidOrder.id}`).expect(404);
      await patch(other, `/business/orders/${paidOrder.id}/status`, { status: "cancelled" }).expect(404);
      await post(other, `/business/orders/${paidOrder.id}/receipt`, {}).expect(404);
      await api().get("/api/v1/business/orders").expect(401);
    });

    it("cancelling returns stock and resets the customer's totals; reopening takes the stock again", async () => {
      const cust = () => prisma.customer.findFirstOrThrow({ where: { businessId: t.businessId, email } });
      expect((await cust()).ordersCount).toBe(1);
      const c = (await patch(t, `/business/orders/${paidOrder.id}/status`, { status: "cancelled" }).expect(200)).body;
      expect(c).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
      expect(await stockOf(product.id)).toMatchObject({ stock: 10, sold: 0 });
      expect(await cust()).toMatchObject({ ordersCount: 0 });
      await patch(t, `/business/orders/${paidOrder.id}/status`, { status: "cancelled" }).expect(200); // idempotent: stock isn't returned twice
      expect((await stockOf(product.id)).stock).toBe(10);
      const re = (await patch(t, `/business/orders/${paidOrder.id}/status`, { status: "processing" }).expect(200)).body;
      expect(re).toMatchObject({ status: "processing", paymentStatus: "paid" });
      expect(await stockOf(product.id)).toMatchObject({ stock: 7, sold: 3 });
      expect((await cust()).ordersCount).toBe(1);
    });

    it("refunds, and won't reopen an order whose stock has since been sold", async () => {
      const p = await mk(t, { name: "Scarce", stock: 2, price: 10 });
      const o = (await order(slug, [{ productId: p.id, qty: 2 }]).expect(201)).body;
      expect((await patch(t, `/business/orders/${o.id}/status`, { status: "refunded" }).expect(200)).body).toMatchObject({ status: "refunded", paymentStatus: "refunded" });
      expect((await stockOf(p.id)).stock).toBe(2);
      await order(slug, [{ productId: p.id, qty: 2 }]).expect(201); // someone else buys it
      const r = await patch(t, `/business/orders/${o.id}/status`, { status: "pending" }).expect(400);
      expect(r.body.message).toBe("Scarce is sold out.");
      expect((await get(t, `/business/orders/${o.id}`)).body.status).toBe("refunded");
    });

    it("marks an unpaid order paid when it moves past pending, and records receipts", async () => {
      const p = await mk(t);
      const o = (await order(slug, [{ productId: p.id, qty: 1 }]).expect(201)).body;
      expect(o.paymentStatus).toBe("unpaid");
      expect((await patch(t, `/business/orders/${o.id}/status`, { status: "shipped" }).expect(200)).body.paymentStatus).toBe("paid");
      expect((await get(t, `/business/orders/${o.id}`)).body.receiptSentAt).toBeUndefined();
      const r = (await post(t, `/business/orders/${o.id}/receipt`, {}).expect(200)).body;
      expect(r.receiptSentAt).toBeTruthy();
      await patch(t, `/business/orders/${o.id}/status`, { status: "weird" }).expect(400);
    });
  });

  describe("recording a sale", () => {
    const sale = (x: Tenant, body: Record<string, unknown>) => post(x, "/business/sales", { channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true, ...body });

    it("records a walk-in sale, takes stock and uses the merchant's own price", async () => {
      const p = await mk(t, { name: "Sale item", price: 100, stock: 5 });
      const r = (await sale(t, { items: [{ productId: p.id, qty: 2, price: 80 }], discount: 10 }).expect(201)).body;
      expect(r).toMatchObject({ customerId: "walk_in", customerName: "Walk-in customer", status: "delivered", paymentStatus: "paid", channel: "in_store", paymentMethod: "cash", total: 150, discount: 10 });
      expect(r.items[0]).toMatchObject({ qty: 2, price: 80 });
      expect(await stockOf(p.id)).toMatchObject({ stock: 3, sold: 2 });
    });

    it("sets status and payment from handedOver and paid", async () => {
      const p = await mk(t);
      const owed = (await sale(t, { items: [{ productId: p.id, qty: 1 }], paid: false, handedOver: false, paymentMethod: "bank", channel: "whatsapp" }).expect(201)).body;
      expect(owed).toMatchObject({ status: "processing", paymentStatus: "unpaid", channel: "whatsapp", paymentMethod: "bank" });
    });

    it("reuses a new customer by phone or email and keeps their totals", async () => {
      const p = await mk(t, { price: 100 });
      const phone = `080${run}`;
      const first = (await sale(t, { items: [{ productId: p.id, qty: 1 }], newCustomer: { name: "Bisi", phone } }).expect(201)).body;
      const again = (await sale(t, { items: [{ productId: p.id, qty: 2 }], newCustomer: { name: "Bisi A.", phone } }).expect(201)).body;
      expect(again.customerId).toBe(first.customerId);
      expect(again.customerName).toBe("Bisi");
      const c = (await get(t, `/business/customers/${first.customerId}`).expect(200)).body;
      expect(c.customer).toMatchObject({ name: "Bisi", orders: 2, totalSpent: 300 });
      expect(c.avgOrder).toBe(150);
      expect(c.orders).toHaveLength(2);
      expect(c.lastOrderAt).toBeTruthy();
    });

    it("explains problems in the merchant's words", async () => {
      const plain = await mk(t, { name: "Plain", stock: 1 });
      const opt = await mk(t, { name: "Opts", variants: [{ name: "M", stock: 1 }] });
      const bad = async (body: Record<string, unknown>, status = 400) => (await sale(t, body).expect(status)).body.message;
      expect(await bad({ items: [] })).toBe("Add at least one product to the sale.");
      expect(await bad({ items: [{ productId: "nope", qty: 1 }] })).toBe("One of the products no longer exists.");
      expect(await bad({ items: [{ productId: plain.id, qty: 0 }] })).toBe("Enter a whole quantity for Plain.");
      expect(await bad({ items: [{ productId: plain.id, qty: 1, price: -5 }] })).toBe("Enter a valid price for Plain.");
      expect(await bad({ items: [{ productId: opt.id, qty: 1 }] })).toBe("Choose an option for Opts.");
      expect(await bad({ items: [{ productId: plain.id, qty: 5 }] })).toBe("Only 1 of Plain left in stock.");
      expect(await bad({ items: [{ productId: plain.id, qty: 1 }], discount: 5000 })).toBe("The discount can't be more than the sale total.");
      expect(await bad({ items: [{ productId: plain.id, qty: 1 }], customerId: "nope" })).toBe("That customer no longer exists.");
      expect(await bad({ items: [{ productId: plain.id, qty: 1 }], newCustomer: { name: "X", email: "bad" } })).toBe("Enter a valid customer email, or leave it blank.");
      expect(await bad({ items: [{ productId: plain.id, qty: 1 }], channel: "online" })).toBe("Choose where the sale came from.");
      expect((await stockOf(plain.id)).stock).toBe(1);
    });

    it("won't use another business's customer or products, and needs an active store", async () => {
      const x = await newTenant(api);
      const theirs = await mk(x);
      const cust = (await sale(x, { items: [{ productId: theirs.id, qty: 1 }], newCustomer: { name: "Theirs", phone: "1" } }).expect(201)).body.customerId;
      const mine = await mk(t);
      expect((await sale(t, { items: [{ productId: theirs.id, qty: 1 }] }).expect(400)).body.message).toBe("One of the products no longer exists.");
      expect((await sale(t, { items: [{ productId: mine.id, qty: 1 }], customerId: cust }).expect(400)).body.message).toBe("That customer no longer exists.");
      await prisma.business.update({ where: { id: x.businessId }, data: { status: "PENDING" } });
      expect((await sale(x, { items: [{ productId: theirs.id, qty: 1 }] }).expect(403)).body.message).toBe("Your store isn't active, so new sales can't be recorded.");
    });
  });

  describe("customers", () => {
    it("lists and searches the business's own customers only", async () => {
      const x = await newTenant(api);
      const p = await mk(x);
      const s = await slugOf(x);
      await order(s, [{ productId: p.id, qty: 1 }], { customer: shopper({ name: "Zainab Bello", email: `zb.${run}@example.com` }) }).expect(201);
      const list = await get(x, "/business/customers").expect(200);
      expect(list.body).toHaveLength(1);
      expect(list.headers["x-total-count"]).toBe("1");
      expect(list.body[0]).toMatchObject({ name: "Zainab Bello", orders: 0, totalSpent: 0, businessId: x.businessId });
      expect((await get(x, "/business/customers?q=zainab").expect(200)).body).toHaveLength(1);
      expect((await get(x, "/business/customers?q=nobody").expect(200)).body).toHaveLength(0);
      await get(t, `/business/customers/${list.body[0].id}`).expect(404);
      expect((await get(t, "/business/customers").expect(200)).body.some((c: any) => c.name === "Zainab Bello")).toBe(false);
    });
  });
});

describe("card payments without the demo switch", () => {
  it("leaves card orders unpaid until a provider confirms them", async () => {
    process.env.DEMO_CARD_PAYMENTS = "false";
    const { app, api } = await boot();
    try {
      const x = await newTenant(api);
      const p = (await api().post("/api/v1/business/products").set(...x.auth).send({ name: "P", sku: "", category: "", description: "", price: 10, stock: 5, status: "active" }).expect(201)).body;
      const s = (await app.get(PrismaService).business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
      const o = await api().post(`/api/v1/store/${s}/orders`).send({ customer: { name: "A B", email: "ab@example.com", phone: "1" }, shippingAddress: "x", paymentMethod: "card", items: [{ productId: p.id, qty: 1 }] }).expect(201);
      expect(o.body.paymentStatus).toBe("unpaid");
    } finally {
      process.env.DEMO_CARD_PAYMENTS = "true";
      await app.close();
    }
  });
});
