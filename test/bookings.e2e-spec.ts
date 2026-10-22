import { INestApplication } from "@nestjs/common";
import { addDays, localDate } from "../src/bookings/availability";
import { MailService } from "../src/mail/mail.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, Tenant } from "./helpers";

describe("Bookings", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, mail: MailService;
  let n = 0;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); mail = app.get(MailService); });
  afterAll(async () => { await app.close(); });

  const as = (t: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...t.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...t.auth).send(b),
    put: (p: string, b: object = {}) => api().put(`/api/v1${p}`).set(...t.auth).send(b),
    patch: (p: string, b: object = {}) => api().patch(`/api/v1${p}`).set(...t.auth).send(b),
  });
  const everyDay = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "08:00", end: "18:00" }]]));
  const settings = (t: Tenant, over: object = {}) => as(t).put("/business/booking-settings", { timezone: "Africa/Lagos", hours: everyDay, noticeHours: 0, autoConfirm: true, ...over });
  const tomorrow = () => addDays(localDate(Date.now(), "Africa/Lagos").date, 2); // two days out clears any notice period
  const shop = async (over: object = {}, svc: object = {}) => {
    const t = await newTenant(api);
    await settings(t, over).expect(200);
    const s = (await as(t).post("/business/services", { name: "Haircut", durationMins: 60, bookable: true, price: 5000, status: "active", ...svc }).expect(201)).body;
    const slug = (await prisma.business.findUniqueOrThrow({ where: { id: t.businessId } })).slug;
    const slots = async (date = tomorrow()) => (await api().get(`/api/v1/store/${slug}/services/${s.id}/slots?date=${date}`).expect(200)).body;
    const book = (startsAt: string, over: object = {}) => api().post(`/api/v1/store/${slug}/bookings`).send({ serviceId: s.id, startsAt, customer: { name: "Ada Obi", email: `ada${++n}@example.com`, phone: "0800" }, ...over });
    return { t, s, slug, slots, book };
  };

  it("needs a duration to be bookable, and can't be bought through the cart", async () => {
    const t = await newTenant(api);
    const bad = await as(t).post("/business/services", { name: "Massage", bookable: true, price: 100, status: "active" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("DURATION_REQUIRED");
    const { s, slug } = await shop();
    expect(s).toMatchObject({ bookable: true, maxConcurrent: 1, durationMins: 60 });
    const r = await api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "A", email: "a@example.com", phone: "1" }, shippingAddress: "x", paymentMethod: "cod", items: [{ serviceId: s.id, qty: 1 }] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("BOOKING_REQUIRED");
  });

  it("lists open slots from the opening hours and removes one once it is booked", async () => {
    const { slots, book, t } = await shop();
    const before = await slots();
    expect(before).toMatchObject({ timezone: "Africa/Lagos", durationMins: 60 });
    const labels = before.slots.map((x: any) => x.label);
    expect(labels[0]).toBe("08:00");
    expect(labels).toContain("17:00");
    expect(labels).not.toContain("17:30"); // a 60-minute booking has to finish by 18:00

    const pick = before.slots.find((x: any) => x.label === "10:00").startsAt;
    const made = await book(pick).expect(201);
    expect(made.body).toMatchObject({ status: "confirmed", serviceName: "Haircut", durationMins: 60, publicToken: expect.any(String) });
    const after = (await slots()).slots.map((x: any) => x.label);
    expect(after).not.toContain("09:30");
    expect(after).not.toContain("10:00");
    expect(after).not.toContain("10:30");
    expect(after).toContain("09:00");
    expect(after).toContain("11:00");

    const again = await book(pick);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SLOT_TAKEN");
    expect((await as(t).get("/business/bookings").expect(200)).body).toHaveLength(1);
  });

  it("lets overlapping bookings up to the service's capacity", async () => {
    const { slots, book } = await shop({}, { maxConcurrent: 2 });
    const pick = (await slots()).slots[0].startsAt;
    await book(pick).expect(201);
    await book(pick).expect(201);
    await book(pick).expect(409);
  });

  it("rejects times that aren't offered, dates outside the window, and unbookable services", async () => {
    const { slots, book, slug, t } = await shop();
    const offGrid = new Date(Date.parse((await slots()).slots[0].startsAt) + 7 * 60_000).toISOString();
    await book(offGrid).expect(409);
    await book(new Date(Date.now() - 3600_000).toISOString()).expect(400);
    await api().get(`/api/v1/store/${slug}/services/x/slots?date=2020-01-01`).expect(400);
    await api().get(`/api/v1/store/${slug}/services/x/slots?date=${addDays(tomorrow(), 90)}`).expect(400);
    const plain = (await as(t).post("/business/products", { name: "Comb", price: 1, stock: 3, status: "active" }).expect(201)).body;
    await api().get(`/api/v1/store/${slug}/services/${plain.id}/slots?date=${tomorrow()}`).expect(404);
  });

  it("respects the notice period and closed days", async () => {
    const closed = await shop({ hours: { ...everyDay, [["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${tomorrow()}T00:00:00Z`).getUTCDay()]]: [] } });
    expect((await closed.slots()).slots).toEqual([]);
    const far = await shop({ noticeHours: 168 });
    expect((await far.slots(addDays(localDate(Date.now(), "Africa/Lagos").date, 1))).slots).toEqual([]);
  });

  it("validates settings and keeps them per business", async () => {
    const t = await newTenant(api);
    expect((await settings(t, { timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await settings(t, { hours: { mon: [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "14:00" }] } })).status).toBe(400);
    expect((await settings(t, { hours: { mon: [{ start: "17:00", end: "09:00" }] } })).status).toBe(400);
    expect((await settings(t, { hours: { mon: [{ start: "9am", end: "5pm" }] } })).status).toBe(400);
    const ok = (await settings(t, { hours: { mon: [{ start: "09:00", end: "12:00" }] }, noticeHours: 5, autoConfirm: false }).expect(200)).body;
    expect(ok).toMatchObject({ configured: true, noticeHours: 5, autoConfirm: false, hours: { mon: [{ start: "09:00", end: "12:00" }] } });
    const fresh = await newTenant(api);
    expect((await as(fresh).get("/business/booking-settings").expect(200)).body).toMatchObject({ configured: false, timezone: "Africa/Lagos" });
    await api().get("/api/v1/business/booking-settings").expect(401);
  });

  it("holds a booking for the team to confirm when auto-confirm is off, and emails the customer", async () => {
    const { t, slots, book } = await shop({ autoConfirm: false });
    const email = `pending${++n}@example.com`;
    const made = (await book((await slots()).slots[0].startsAt, { customer: { name: "Ada", email, phone: "1" } }).expect(201)).body;
    expect(made.status).toBe("pending");
    expect(mail.outbox.some((m) => m.to === email && /booking request/.test(m.subject))).toBe(true);

    const confirmed = (await as(t).patch(`/business/bookings/${made.id}/status`, { status: "confirmed" }).expect(200)).body;
    expect(confirmed.status).toBe("confirmed");
    expect(mail.outbox.some((m) => m.to === email && /confirmed/.test(m.subject))).toBe(true);
    expect((await as(t).patch(`/business/bookings/${made.id}/status`, { status: "completed" }).expect(200)).body.status).toBe("completed");
  });

  it("tells the team about a new booking and about a cancellation", async () => {
    const { t, slots, book, slug } = await shop();
    const made = (await book((await slots()).slots[0].startsAt).expect(201)).body;
    const inbox = async () => (await as(t).get("/notifications").expect(200)).body.items.map((i: any) => i.type);
    await new Promise((r) => setTimeout(r, 200));
    expect(await inbox()).toContain("new_booking");

    const view = (await api().get(`/api/v1/store/bookings/${made.publicToken}`).expect(200)).body;
    expect(view.booking).toMatchObject({ id: made.id, status: "confirmed", timezone: "Africa/Lagos" });
    expect(view.store.slug).toBe(slug);
    expect((await api().post(`/api/v1/store/bookings/${made.publicToken}/cancel`).expect(200)).body.status).toBe("cancelled");
    await api().post(`/api/v1/store/bookings/${made.publicToken}/cancel`).expect(400);
    await new Promise((r) => setTimeout(r, 200));
    expect(await inbox()).toContain("booking_cancelled");
    // the freed slot can be booked again
    await book(made.startsAt).expect(201);
    await api().get("/api/v1/store/bookings/nope").expect(404);
  });

  it("never reopens a cancelled booking, and keeps bookings private to their business", async () => {
    const { t, slots, book } = await shop();
    const made = (await book((await slots()).slots[0].startsAt).expect(201)).body;
    const other = await newTenant(api);
    expect((await as(other).get("/business/bookings").expect(200)).body).toEqual([]);
    await as(other).patch(`/business/bookings/${made.id}/status`, { status: "cancelled" }).expect(404);
    await as(t).patch(`/business/bookings/${made.id}/status`, { status: "cancelled" }).expect(200);
    await as(t).patch(`/business/bookings/${made.id}/status`, { status: "confirmed" }).expect(400);
  });

  it("lets the team book a customer in by phone, even outside opening hours", async () => {
    const { t, s } = await shop();
    const late = new Date(Date.parse(`${tomorrow()}T00:00:00Z`) + 21 * 3_600_000).toISOString(); // 22:00 Lagos, closed
    const made = (await as(t).post("/business/bookings", { serviceId: s.id, startsAt: late, customer: { name: "Walk-in", phone: "0801" } }).expect(201)).body;
    expect(made).toMatchObject({ status: "confirmed", source: "admin" });
    await as(t).post("/business/bookings", { serviceId: s.id, startsAt: late, customer: { name: "Second", phone: "0802" } }).expect(409);
    expect((await as(t).get(`/business/bookings?from=${new Date().toISOString()}`).expect(200)).body).toHaveLength(1);
    expect((await as(t).get("/business/customers?q=Walk-in").expect(200)).body).toHaveLength(1);
  });
});
