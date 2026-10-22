import { INestApplication } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, Tenant } from "./helpers";

describe("Calendar subscription links", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); });
  afterAll(async () => { await app.close(); });

  const as = (t: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...t.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...t.auth).send(b),
    del: (p: string) => api().delete(`/api/v1${p}`).set(...t.auth),
  });
  const feedPath = (url: string) => new URL(url).pathname;

  const withBooking = async () => {
    const t = await newTenant(api);
    const hours = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "08:00", end: "18:00" }]]));
    await as(t).post("/business/products", { name: "Haircut", kind: "service", durationMins: 60, bookable: true, price: 5000, status: "active" }).expect(201);
    await api().put("/api/v1/business/booking-settings").set(...t.auth).send({ timezone: "Africa/Lagos", hours, noticeHours: 0, autoConfirm: true }).expect(200);
    const s = (await as(t).get("/business/products").expect(200)).body[0];
    const startsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await as(t).post("/business/bookings", { productId: s.id, startsAt, customer: { name: "Ada Obi", phone: "0800" } }).expect(201);
    return t;
  };

  it("creates a private link whose secret is shown once, and serves the bookings as an .ics", async () => {
    const t = await withBooking();
    const made = (await as(t).post("/business/calendar/feeds", { label: "My phone" }).expect(201)).body;
    expect(made.url).toMatch(/\/api\/v1\/calendar-feed\/[\w-]{43}\.ics$/);
    expect(made.webcalUrl.startsWith("webcal://")).toBe(true);

    const listed = (await as(t).get("/business/calendar/feeds").expect(200)).body;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(made.url.split("/").pop()!.replace(".ics", "")); // the secret is never listed

    const res = await api().get(feedPath(made.url)).expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/calendar/);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.text).toContain("BEGIN:VCALENDAR");
    expect(res.text).toContain("SUMMARY:Haircut · Ada Obi");
    const row = await prisma.calendarFeed.findUniqueOrThrow({ where: { id: made.id } });
    expect(row.tokenHash).not.toContain(made.url.split("/").pop()!.replace(".ics", ""));
  });

  it("stops serving once revoked, and gives every bad link the same 404", async () => {
    const t = await withBooking();
    const made = (await as(t).post("/business/calendar/feeds").expect(201)).body;
    await as(t).del(`/business/calendar/feeds/${made.id}`).expect(204);
    await api().get(feedPath(made.url)).expect(404);
    await api().get("/api/v1/calendar-feed/short.ics").expect(404);
    await api().get(`/api/v1/calendar-feed/${"x".repeat(43)}.ics`).expect(404);
    expect((await as(t).get("/business/calendar/feeds").expect(200)).body).toEqual([]);
    await as(t).del(`/business/calendar/feeds/${made.id}`).expect(404);
  });

  it("keeps links private to the person who made them, and to their business's bookings", async () => {
    const a = await withBooking(), b = await newTenant(api);
    const made = (await as(a).post("/business/calendar/feeds").expect(201)).body;
    expect((await as(b).get("/business/calendar/feeds").expect(200)).body).toEqual([]);
    await as(b).del(`/business/calendar/feeds/${made.id}`).expect(404);
    const mine = await api().get(feedPath((await as(b).post("/business/calendar/feeds").expect(201)).body.url)).expect(200);
    expect(mine.text).not.toContain("Ada Obi"); // another business's customers never appear
    await api().get("/api/v1/business/calendar/feeds").expect(401);
  });

  it("caps the number of active links per person", async () => {
    const t = await newTenant(api);
    for (let i = 0; i < 10; i++) await as(t).post("/business/calendar/feeds").expect(201);
    const r = await as(t).post("/business/calendar/feeds");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("TOO_MANY_FEEDS");
  });

  it("stops serving when the business is no longer live", async () => {
    const t = await withBooking();
    const made = (await as(t).post("/business/calendar/feeds").expect(201)).body;
    await prisma.business.update({ where: { id: t.businessId }, data: { status: "SUSPENDED" } });
    await api().get(feedPath(made.url)).expect(404);
  });
});
