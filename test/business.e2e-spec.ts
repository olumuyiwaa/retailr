import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant, uploadImage } from "./helpers";

describe("Business extras", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  let t: Tenant, other: Tenant;
  let n = 0;
  const S = (x: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...x.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...x.auth).send(b),
    put: (p: string, b: object) => api().put(`/api/v1${p}`).set(...x.auth).send(b),
    patch: (p: string, b: object) => api().patch(`/api/v1${p}`).set(...x.auth).send(b),
    del: (p: string) => api().delete(`/api/v1${p}`).set(...x.auth),
  });
  let a: ReturnType<typeof S>, b: ReturnType<typeof S>;
  const DAY = 86_400_000;
  const cust = (x: Tenant, over: Record<string, unknown> = {}) =>
    prisma.customer.create({ data: { businessId: x.businessId, name: `Cust ${++n} Test`, email: `c${n}.${run}@example.com`, phone: "08031234567", ...over } as never });

  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    t = await newTenant(api); other = await newTenant(api);
    a = S(t); b = S(other);
  });
  afterAll(async () => { await app.close(); });

  describe("coupons", () => {
    const good = { type: "percent", value: 10 };
    it("normalises the code and explains each rule in the UI's words", async () => {
      const c = (await a.post("/business/coupons", { ...good, code: ` save-${run} `, minOrder: 500, maxUses: 5 }).expect(201)).body;
      expect(c).toMatchObject({ code: `SAVE-${run}`.toUpperCase(), type: "percent", value: 10, minOrder: 500, maxUses: 5, usedCount: 0, status: "active", businessId: t.businessId });
      const bad = async (body: object, status = 400) => (await a.post("/business/coupons", body).expect(status)).body.message;
      expect(await bad({ ...good, code: "ab" })).toBe("Use 3–20 letters, numbers or dashes for the code.");
      expect(await bad({ ...good, code: "no spaces" })).toBe("Use 3–20 letters, numbers or dashes for the code.");
      expect(await bad({ ...good, code: "ZERO1", value: 0 })).toBe("Enter a discount greater than zero.");
      expect(await bad({ ...good, code: "BIG101", value: 101 })).toBe("A percentage can't be more than 100.");
      expect(await bad({ ...good, code: `save-${run}` }, 409)).toBe("You already have a code with that name.");
      expect(await bad({ ...good, code: "BADDATE", expiresAt: "not a date" })).toBe("Enter a valid expiry date.");
      await a.post("/business/coupons", { type: "fixed", code: "FIXED1", value: 5000 }).expect(201); // a fixed amount may exceed 100
    });

    it("updates in full while keeping the use count, toggles status, and deletes idempotently", async () => {
      const c = (await a.post("/business/coupons", { ...good, code: `UPD${run}`, minOrder: 100 }).expect(201)).body;
      await prisma.coupon.update({ where: { id: c.id }, data: { usedCount: 3 } });
      const u = (await a.put(`/business/coupons/${c.id}`, { code: `upd${run}`, type: "fixed", value: 50 }).expect(200)).body;
      expect(u).toMatchObject({ type: "fixed", value: 50, usedCount: 3 });
      expect(u.minOrder).toBeUndefined(); // PUT replaces: omitted means cleared
      const exp = new Date(Date.now() + DAY).toISOString();
      expect((await a.put(`/business/coupons/${c.id}`, { code: `UPD${run}`, type: "percent", value: 5, expiresAt: exp }).expect(200)).body.expiresAt).toBe(exp);
      expect((await a.patch(`/business/coupons/${c.id}/status`, { status: "disabled" }).expect(200)).body.status).toBe("disabled");
      await a.patch(`/business/coupons/${c.id}/status`, { status: "gone" }).expect(400);
      await a.del(`/business/coupons/${c.id}`).expect(204);
      await a.del(`/business/coupons/${c.id}`).expect(204);
      await a.put(`/business/coupons/${c.id}`, { code: "ZZZ", type: "percent", value: 5 }).expect(404);
    });

    it("lists newest first, and a disabled code stops working at checkout", async () => {
      const list = (await a.get("/business/coupons").expect(200)).body;
      const times = list.map((x: any) => x.createdAt);
      expect([...times].sort().reverse()).toEqual(times);
      const code = `OFF${run}`.toUpperCase();
      const c = (await a.post("/business/coupons", { code, type: "percent", value: 10 }).expect(201)).body;
      const slug = (await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).slug;
      await api().post(`/api/v1/store/${slug}/coupons/validate`).send({ code, subtotal: 100 }).expect(200);
      await a.patch(`/business/coupons/${c.id}/status`, { status: "disabled" }).expect(200);
      expect((await api().post(`/api/v1/store/${slug}/coupons/validate`).send({ code, subtotal: 100 }).expect(400)).body.message).toBe("That code isn't valid.");
    });

    it("is private to each business", async () => {
      const c = (await a.post("/business/coupons", { ...good, code: `ISO${run}` }).expect(201)).body;
      expect((await b.get("/business/coupons").expect(200)).body.some((x: any) => x.id === c.id)).toBe(false);
      await b.put(`/business/coupons/${c.id}`, { code: "HACK", type: "percent", value: 99 }).expect(404);
      await b.patch(`/business/coupons/${c.id}/status`, { status: "disabled" }).expect(404);
      await b.del(`/business/coupons/${c.id}`).expect(204);
      expect((await prisma.coupon.findUnique({ where: { id: c.id } }))?.status).toBe("ACTIVE");
      await api().get("/api/v1/business/coupons").expect(401);
      expect((await b.post("/business/coupons", { ...good, code: `ISO${run}` }).expect(201)).body.code).toBe(`ISO${run}`.toUpperCase()); // same code in another business is fine
    });
  });

  describe("customer groups", () => {
    it("manual groups keep chosen members, ignore other businesses' customers and replace on update", async () => {
      const [c1, c2] = [await cust(t), await cust(t)];
      const foreign = await cust(other);
      const g = (await a.post("/business/groups", { name: `VIPs ${run}`, kind: "manual", description: " Best ", memberIds: [c1.id, foreign.id, c1.id, "nope"] }).expect(201)).body;
      expect(g).toMatchObject({ kind: "manual", description: "Best", memberIds: [c1.id] });
      expect(g.rule).toBeUndefined();
      expect((await a.get(`/business/groups/${g.id}/members`).expect(200)).body.map((c: any) => c.id)).toEqual([c1.id]);
      const u = (await a.put(`/business/groups/${g.id}`, { name: `VIPs ${run}`, kind: "manual", memberIds: [c2.id] }).expect(200)).body;
      expect(u.memberIds).toEqual([c2.id]);
      expect(u.description).toBeUndefined();
      const listed = (await a.get("/business/groups").expect(200)).body.find((x: any) => x.id === g.id);
      expect(listed.memberCount).toBe(1);
      // customer detail shows which groups they belong to
      expect((await a.get(`/business/customers/${c2.id}`).expect(200)).body.groups).toEqual([`VIPs ${run}`]);
      expect((await a.get(`/business/customers/${c1.id}`).expect(200)).body.groups).toEqual([]);
    });

    it("auto groups are worked out from their rule when read", async () => {
      const x = await newTenant(api); const sx = S(x);
      const old = new Date(Date.now() - 100 * DAY), recent = new Date(Date.now() - 2 * DAY);
      const big = await cust(x, { name: "Big Spender", totalSpent: 5000, ordersCount: 4, createdAt: old });
      const mid = await cust(x, { name: "Mid", totalSpent: 1000, ordersCount: 1, createdAt: old });
      const fresh = await cust(x, { name: "Fresh", createdAt: recent });
      const rule = async (type: string, value: number) => {
        const g = (await sx.post("/business/groups", { name: `${type}${value}`, kind: "auto", rule: { type, value } }).expect(201)).body;
        expect(g.rule).toEqual({ type, value }); expect(g.memberIds).toEqual([]);
        return (await sx.get(`/business/groups/${g.id}/members`).expect(200)).body.map((c: any) => c.id).sort();
      };
      expect(await rule("spent_over", 1000)).toEqual([big.id]); // strictly over
      expect(await rule("orders_at_least", 1)).toEqual([big.id, mid.id].sort());
      expect(await rule("joined_within_days", 7)).toEqual([fresh.id]);
      // fresh joined 2 days ago with no order; mid and big have old orders; give big a recent one
      await prisma.order.create({ data: { businessId: x.businessId, customerId: big.id, number: "#ZZ1", total: 10, subtotal: 10, customerName: "Big", customerEmail: "b@x.com", channel: "ONLINE", paymentMethod: "COD", status: "PENDING", paymentStatus: "UNPAID", placedAt: new Date() } as never });
      await prisma.order.create({ data: { businessId: x.businessId, customerId: mid.id, number: "#ZZ2", total: 10, subtotal: 10, customerName: "Mid", customerEmail: "m@x.com", channel: "ONLINE", paymentMethod: "COD", status: "PENDING", paymentStatus: "UNPAID", placedAt: new Date(Date.now() - 60 * DAY) } as never });
      expect(await rule("no_order_within_days", 30)).toEqual([mid.id]); // big ordered recently, fresh is too new
      expect(await rule("no_order_within_days", 1)).toEqual([big.id, mid.id].sort().filter((i) => i !== big.id).concat(fresh.id).sort());
      const listed = (await sx.get("/business/groups").expect(200)).body;
      expect(listed.find((g: any) => g.name === "spent_over1000").memberCount).toBe(1);
      expect((await sx.get(`/business/customers/${big.id}`).expect(200)).body.groups).toEqual(expect.arrayContaining(["spent_over1000", "orders_at_least1"]));
    });

    it("validates names and rules in the UI's words", async () => {
      const name = `Dupe ${run}`;
      await a.post("/business/groups", { name, kind: "manual" }).expect(201);
      expect((await a.post("/business/groups", { name: name.toUpperCase(), kind: "manual" }).expect(409)).body.message).toBe("You already have a group with that name.");
      expect((await b.post("/business/groups", { name, kind: "manual" }).expect(201)).body.name).toBe(name);
      expect((await a.post("/business/groups", { name: "  ", kind: "manual" }).expect(400)).body.message).toBe("Give the group a name.");
      for (const rule of [undefined, { type: "spent_over", value: -1 }, { type: "spent_over", value: "abc" }, { type: "spent_over", value: "" }, { type: "mystery", value: 1 }]) {
        expect((await a.post("/business/groups", { name: `R ${n++}`, kind: "auto", rule }).expect(400)).body.message).toBe("Enter a valid number for the rule.");
      }
      const g = (await a.post("/business/groups", { name: `Own ${run}`, kind: "manual" }).expect(201)).body;
      expect((await a.put(`/business/groups/${g.id}`, { name, kind: "manual" }).expect(409)).body.code).toBe("GROUP_EXISTS");
      await a.put(`/business/groups/${g.id}`, { name: `Own ${run}`, kind: "manual" }).expect(200); // keeping its own name is fine
    });

    it("deletes without touching customers, and is private to each business", async () => {
      const c = await cust(t);
      const g = (await a.post("/business/groups", { name: `Gone ${run}`, kind: "manual", memberIds: [c.id] }).expect(201)).body;
      await b.get(`/business/groups/${g.id}/members`).expect(404);
      await b.put(`/business/groups/${g.id}`, { name: "x", kind: "manual" }).expect(404);
      await b.del(`/business/groups/${g.id}`).expect(204);
      expect(await prisma.customerGroup.count({ where: { id: g.id } })).toBe(1);
      expect((await b.get("/business/groups").expect(200)).body.some((x: any) => x.id === g.id)).toBe(false);
      await a.del(`/business/groups/${g.id}`).expect(204);
      await a.del(`/business/groups/${g.id}`).expect(204);
      expect(await prisma.customer.count({ where: { id: c.id } })).toBe(1);
    });
  });

  describe("messages", () => {
    let x: Tenant, sx: ReturnType<typeof S>, groupId: string;
    beforeAll(async () => {
      x = await newTenant(api); sx = S(x);
      const withBoth = await cust(x, { name: "Ada Obi", email: `ada.${run}@example.com`, phone: "08011111111" });
      await cust(x, { name: "No Phone", email: `np.${run}@example.com`, phone: "123" });
      await cust(x, { name: "No Email", email: null, phone: "08022222222" });
      groupId = (await sx.post("/business/groups", { name: "Just Ada", kind: "manual", memberIds: [withBoth.id] }).expect(201)).body.id;
    });

    it("counts who can be reached on each channel", async () => {
      expect((await sx.get("/business/messages/audience?type=all&channel=email").expect(200)).body).toMatchObject({ count: 2, skipped: 1, label: "All customers", sampleName: "Ada" });
      expect((await sx.get("/business/messages/audience?type=all&channel=sms").expect(200)).body).toMatchObject({ count: 2, skipped: 1 });
      expect((await sx.get(`/business/messages/audience?type=group&groupId=${groupId}&channel=sms`).expect(200)).body).toEqual({ count: 1, skipped: 0, label: "Just Ada", sampleName: "Ada" });
      expect((await sx.get("/business/messages/audience?type=group&groupId=nope&channel=sms").expect(400)).body.message).toBe("That group no longer exists.");
      await sx.get("/business/messages/audience?type=all&channel=fax").expect(400);
      await sx.get("/business/messages/audience?type=all&channel=whatsapp").expect(400); // not offered
    });

    it("records a sent message with the right audience and recipient count", async () => {
      const m = (await sx.post("/business/messages", { channel: "email", subject: " Sale! ", body: " Hi {{first_name}}, welcome to {{store}} ", audience: { type: "all" } }).expect(201)).body;
      expect(m).toMatchObject({ channel: "email", subject: "Sale!", body: "Hi {{first_name}}, welcome to {{store}}", audienceLabel: "All customers", recipientCount: 2, businessId: x.businessId });
      const sms = (await sx.post("/business/messages", { channel: "sms", subject: "ignored", body: "Hello", audience: { type: "group", groupId } }).expect(201)).body;
      expect(sms).toMatchObject({ channel: "sms", audienceLabel: "Just Ada", recipientCount: 1 });
      expect(sms.subject).toBeUndefined();
      const list = (await sx.get("/business/messages").expect(200)).body;
      expect(list.map((r: any) => r.id)).toEqual([sms.id, m.id]); // newest first
      expect((await a.get("/business/messages").expect(200)).body.some((r: any) => r.id === m.id)).toBe(false);
    });

    it("refuses a message that can't be sent, in the UI's words", async () => {
      const send = async (body: object) => (await sx.post("/business/messages", { audience: { type: "all" }, ...body }).expect(400)).body.message;
      expect(await send({ channel: "email", subject: "s", body: "   " })).toBe("Write a message first.");
      expect(await send({ channel: "email", body: "hi" })).toBe("Add a subject for the email.");
      expect(await send({ channel: "email", subject: "  ", body: "hi" })).toBe("Add a subject for the email.");
      expect(await send({ channel: "sms", body: "x".repeat(481) })).toBe("SMS messages are limited to 480 characters.");
      await sx.post("/business/messages", { channel: "sms", body: "x".repeat(480), audience: { type: "all" } }).expect(201);
      const empty = await newTenant(api);
      expect((await S(empty).post("/business/messages", { channel: "sms", body: "hi", audience: { type: "all" } }).expect(400)).body.message).toBe("No customers in this audience can be reached on that channel.");
      expect((await sx.post("/business/messages", { channel: "sms", body: "hi", audience: { type: "group", groupId: "nope" } }).expect(400)).body.message).toBe("That group no longer exists.");
      // another business's group can't be used as an audience
      const theirs = (await b.post("/business/groups", { name: `Theirs ${run}`, kind: "manual" }).expect(201)).body.id;
      expect((await sx.post("/business/messages", { channel: "sms", body: "hi", audience: { type: "group", groupId: theirs } }).expect(400)).body.message).toBe("That group no longer exists.");
    });
  });

  describe("team", () => {
    it("lists the owner, invites people as invited, and treats emails case-insensitively", async () => {
      const x = await newTenant(api); const sx = S(x);
      expect((await sx.get("/business/team").expect(200)).body).toEqual([expect.objectContaining({ role: "owner", status: "active", email: x.email, businessId: x.businessId })]);
      const m = (await sx.post("/business/team", { name: "Tolu", email: `Tolu.${run}@Example.com`, role: "staff" }).expect(201)).body;
      expect(m).toMatchObject({ name: "Tolu", email: `tolu.${run}@example.com`, role: "staff", status: "invited" });
      expect(JSON.stringify(m)).not.toMatch(/token|hash/i);
      expect((await sx.post("/business/team", { name: "Tolu 2", email: `TOLU.${run}@example.com`, role: "manager" }).expect(409)).body.message).toBe("That person is already on your team.");
      expect((await sx.post("/business/team", { name: "X", email: "bad", role: "staff" }).expect(400)).body.message).toBe("Enter a valid email address.");
      expect((await sx.post("/business/team", { name: "X", email: `x.${run}@example.com`, role: "owner" }).expect(400)).body.message).toBe("Choose manager or staff.");
      expect((await S(other).get("/business/team").expect(200)).body.some((r: any) => r.id === m.id)).toBe(false);
    });

    it("stops at the plan's team size (counting the owner) unless it's unlimited", async () => {
      const plan = await prisma.plan.create({ data: { id: `team_${run}`, name: "Duo", priceMonthly: 1, priceYearly: 10, maxProducts: 50, maxStaff: 2, maxOrdersPerMonth: 50, maxStorageGb: 1, features: [] } });
      const x = await newTenant(api); const sx = S(x);
      await prisma.business.update({ where: { id: x.businessId }, data: { planId: plan.id } });
      await sx.post("/business/team", { name: "One", email: `one.${run}@example.com`, role: "staff" }).expect(201);
      const r = await sx.post("/business/team", { name: "Two", email: `two.${run}@example.com`, role: "staff" }).expect(403);
      expect(r.body).toMatchObject({ code: "PLAN_LIMIT_STAFF", message: "Your Duo plan allows 2 team members. Upgrade to invite more." });
      await prisma.plan.update({ where: { id: plan.id }, data: { maxStaff: -1 } });
      await sx.post("/business/team", { name: "Two", email: `two.${run}@example.com`, role: "staff" }).expect(201);
    });

    it("removes members but never the owner, and only within the business", async () => {
      const x = await newTenant(api); const sx = S(x);
      const m = (await sx.post("/business/team", { name: "Temp", email: `tmp.${run}@example.com`, role: "staff" }).expect(201)).body;
      const owner = (await sx.get("/business/team").expect(200)).body.find((r: any) => r.role === "owner");
      expect((await sx.del(`/business/team/${owner.id}`).expect(400)).body.message).toBe("The owner cannot be removed.");
      await S(other).del(`/business/team/${m.id}`).expect(404);
      await sx.del(`/business/team/${m.id}`).expect(204);
      await sx.del(`/business/team/${m.id}`).expect(404);
      expect((await sx.get("/business/team").expect(200)).body).toHaveLength(1);
    });
  });

  describe("profile", () => {
    it("shows the business with lifetime stats", async () => {
      const x = await newTenant(api); const sx = S(x);
      const p = (await sx.post("/business/products", { name: "P", sku: "", category: "", description: "", price: 100, stock: 5, status: "active" }).expect(201)).body;
      const slug = (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
      await api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "A B", email: "ab@example.com", phone: "1" }, shippingAddress: "x", paymentMethod: "card", items: [{ productId: p.id, qty: 2 }] }).expect(201);
      const prof = (await sx.get("/business/profile").expect(200)).body;
      expect(prof).toMatchObject({ id: x.businessId, slug, ownerEmail: x.email, status: "trial", currency: "NGN", stats: { products: 1, orders: 1, customers: 1, revenue: 200 } });
      expect(prof.joinedAt).toBeTruthy();
      expect(JSON.stringify(prof)).not.toMatch(/passwordHash|orderSeq/);
    });

    it("saves edits, trims text, and the storefront reflects them", async () => {
      const x = await newTenant(api); const sx = S(x);
      const logo = await uploadImage(api, x, "logo");
      const r = (await sx.patch("/business/profile", { name: "  New Name ", description: "About us", phone: "0800", country: "Ghana", city: "Accra", category: "Beauty", brandColor: "#AABBCC", currency: "GHS", theme: "atelier", logo }).expect(200)).body;
      expect(r).toMatchObject({ name: "New Name", description: "About us", phone: "0800", country: "Ghana", city: "Accra", category: "Beauty", brandColor: "#aabbcc", currency: "GHS", theme: "atelier", logo });
      const store = (await api().get(`/api/v1/store/${r.slug}`).expect(200)).body;
      expect(store).toMatchObject({ name: "New Name", currency: "GHS", theme: "atelier", logo });
      // an empty patch changes nothing; null clears the logo and theme
      expect((await sx.patch("/business/profile", {}).expect(200)).body.name).toBe("New Name");
      const cleared = (await sx.patch("/business/profile", { logo: null, theme: null }).expect(200)).body;
      expect(cleared.logo).toBeUndefined(); expect(cleared.theme).toBeUndefined();
      expect(cleared.slug).toBe(r.slug);
    });

    it("lets the owner choose which payment options the storefront offers", async () => {
      const x = await newTenant(api); const sx = S(x);
      const p = (await sx.post("/business/products", { name: "P", sku: "", category: "", description: "", price: 100, stock: 9, status: "active" }).expect(201)).body;
      const slug = (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
      const buy = (paymentMethod: string) => api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "A B", email: "ab@example.com", phone: "1" }, shippingAddress: "x", paymentMethod, items: [{ productId: p.id, qty: 1 }] });
      expect((await api().get(`/api/v1/store/${slug}`).expect(200)).body.paymentMethods).toEqual(["cod"]); // new stores start with pay on delivery only
      const r = (await sx.patch("/business/profile", { paymentMethods: ["cod", "bank"], bankAccount: { bankName: " GTBank ", accountNumber: "0123456789", accountName: "Adire Hub", instructions: "Use your order number" } }).expect(200)).body;
      expect(r).toMatchObject({ paymentMethods: ["cod", "bank"], bankAccount: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Adire Hub", instructions: "Use your order number" } });
      const pub = (await api().get(`/api/v1/store/${slug}`).expect(200)).body;
      expect(pub).toMatchObject({ paymentMethods: ["cod", "bank"], bankAccount: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Adire Hub" } });
      const refused = (await buy("card").expect(400)).body;
      expect(refused.code).toBe("PAYMENT_METHOD_UNAVAILABLE");
      await buy("bank").expect(201);
      await buy("cod").expect(201);
      expect((await sx.patch("/business/profile", { paymentMethods: [] }).expect(400)).body.message).toBe("Offer at least one way to pay.");
      await sx.patch("/business/profile", { paymentMethods: ["crypto"] }).expect(400);
    });

    it("only offers bank transfer once the bank details are complete, and card only in demo mode", async () => {
      const x = await newTenant(api); const sx = S(x);
      const code = async (body: object) => (await sx.patch("/business/profile", body).expect(400)).body.code;
      expect(await code({ paymentMethods: ["cod", "bank"] })).toBe("BANK_DETAILS_REQUIRED");
      expect(await code({ paymentMethods: ["bank"], bankAccount: { bankName: "GTBank", accountNumber: "0123456789", accountName: "   " } })).toBe("BANK_DETAILS_INCOMPLETE");
      expect(await code({ bankAccount: { bankName: "GTBank", accountNumber: "12", accountName: "Adire" } })).toBe("BANK_ACCOUNT_NUMBER_INVALID");
      expect(await code({ bankAccount: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Adire", swiftCode: "x" } })).toBe("BANK_SWIFT_INVALID");
      // details can be saved first, with the option still off
      await sx.patch("/business/profile", { bankAccount: { bankName: "GTBank", accountNumber: "0123456789", accountName: "Adire Hub", iban: "NG00GTBK0123456789", sortCode: "058" } }).expect(200);
      const on = (await sx.patch("/business/profile", { paymentMethods: ["bank"] }).expect(200)).body;
      expect(on.bankAccount).toMatchObject({ iban: "NG00GTBK0123456789", sortCode: "058" });
      // the details can't be removed while bank transfer is on
      expect(await code({ bankAccount: null })).toBe("BANK_DETAILS_REQUIRED");
      await sx.patch("/business/profile", { paymentMethods: ["cod"] }).expect(200);
      await sx.patch("/business/profile", { bankAccount: null }).expect(200);
      // a store saved with bank but no details (older data) just doesn't show it
      await prisma.business.update({ where: { id: x.businessId }, data: { paymentMethods: ["bank", "cod"], bankAccount: undefined } });
      const slug = (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
      const pub = (await api().get(`/api/v1/store/${slug}`).expect(200)).body;
      expect(pub.paymentMethods).toEqual(["cod"]);
      expect(pub.bankAccount).toBeUndefined();
      // card outside demo mode
      const prev = process.env.DEMO_CARD_PAYMENTS;
      process.env.DEMO_CARD_PAYMENTS = "false";
      try {
        expect(await code({ paymentMethods: ["cod", "card"] })).toBe("CARD_UNAVAILABLE");
        await prisma.business.update({ where: { id: x.businessId }, data: { paymentMethods: ["card"] } });
        expect((await api().get(`/api/v1/store/${slug}`).expect(200)).body.paymentMethods).toEqual(["cod"]);
      } finally { process.env.DEMO_CARD_PAYMENTS = prev; }
    });

    it("rejects bad values and can't change protected fields", async () => {
      const x = await newTenant(api); const sx = S(x);
      const bad = async (body: object) => (await sx.patch("/business/profile", body).expect(400)).body.message;
      expect(await bad({ name: "   " })).toBe("Enter your business name.");
      expect(await bad({ brandColor: "red" })).toBe("Choose a valid brand colour.");
      expect(await bad({ theme: "neon" })).toMatch(/theme/);
      expect(await bad({ currency: "EUR" })).toBeTruthy();
      const theirs = await uploadImage(api, other, "logo");
      expect((await sx.patch("/business/profile", { logo: theirs }).expect(400)).body.code).toBe("IMAGE_NOT_OWNED");
      expect((await sx.patch("/business/profile", { logo: "https://evil.example/x.png" }).expect(400)).body.code).toBe("IMAGE_NOT_OWNED");
      // slug, plan, status and owner details are not editable here (unknown fields are stripped, not applied)
      await sx.patch("/business/profile", { slug: "hijack" }).expect(200);
      await sx.patch("/business/profile", { status: "active", planId: "plan_scale" }).expect(200);
      const prof = (await sx.get("/business/profile").expect(200)).body;
      expect(prof.status).toBe("trial"); expect(prof.planId).toBe("plan_growth"); expect(prof.slug).not.toBe("hijack");
    });
  });
});
