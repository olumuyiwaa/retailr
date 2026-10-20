process.env.SMS_DRIVER = "termii";
process.env.TERMII_API_KEY = "test-key";
import { INestApplication } from "@nestjs/common";
import { MessagesService } from "../src/business/messages.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { normalizePhone, SmsService } from "../src/sms/sms.service";
import { boot, newTenant, run, Tenant } from "./helpers";

describe("normalizePhone", () => {
  it("turns local and international numbers into digits a provider accepts", () => {
    expect(normalizePhone("0801 234 5678", "Nigeria")).toBe("2348012345678");
    expect(normalizePhone("024-123-4567", "Ghana")).toBe("233241234567");
    expect(normalizePhone("0712 345 678", "Kenya")).toBe("254712345678");
    expect(normalizePhone("+233 24 123 4567", "Nigeria")).toBe("233241234567");
    expect(normalizePhone("00234 801 234 5678", "Ghana")).toBe("2348012345678");
    expect(normalizePhone("2348012345678", "Nigeria")).toBe("2348012345678");
  });
  it("gives up on numbers it can't make sense of", () => {
    expect(normalizePhone("123", "Nigeria")).toBeNull();
    expect(normalizePhone("", "Nigeria")).toBeNull();
    expect(normalizePhone("0801 234 5678", "Atlantis")).toBeNull(); // a local number needs a known country
    expect(normalizePhone("+1234567890123456789", "Nigeria")).toBeNull();
  });
});

describe("SMS delivery", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, sms: SmsService, messages: MessagesService;
  let calls: { url: string; body: any }[];
  beforeAll(async () => {
    ({ app, prisma, api } = await boot());
    sms = app.get(SmsService); messages = app.get(MessagesService);
  });
  afterAll(async () => { await app.close(); });
  beforeEach(() => {
    calls = [];
    sms.http = (async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (body.to.endsWith("0000")) return new Response(JSON.stringify({ message: "Invalid number" }), { status: 400 });
      return new Response(JSON.stringify({ message_id: `m${calls.length}`, message: "Successfully Sent" }), { status: 200 });
    }) as never;
  });

  const S = (x: Tenant) => ({ post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...x.auth).send(b), get: (p: string) => api().get(`/api/v1${p}`).set(...x.auth) });
  const customer = (x: Tenant, name: string, phone: string) => prisma.customer.create({ data: { businessId: x.businessId, name, email: `${name.toLowerCase().replace(/\W/g, "")}${run}@e.com`, phone } as never });

  it("sends one personalised text per customer through the provider and counts the results", async () => {
    const x = await newTenant(api);
    await customer(x, "Ada Obi", "0801 234 5678");
    await customer(x, "Bayo Ade", "+234 802 345 6789");
    await customer(x, "Chi Eze", "08030000000"); // the provider refuses this one
    const m = (await S(x).post("/business/messages", { channel: "sms", body: "Hi {{first_name}}, {{store}} has new stock", audience: { type: "all" } }).expect(201)).body;
    expect(m).toMatchObject({ channel: "sms", recipientCount: 3 });
    await messages.idle();
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("https://api.ng.termii.com/api/sms/send");
    expect(calls[0].body).toMatchObject({ from: "Retailr", type: "plain", channel: "dnd", api_key: "test-key" });
    const sent = calls.map((c) => c.body).sort((a, b) => a.to.localeCompare(b.to));
    expect(sent.map((c) => c.to)).toEqual(["2348012345678", "2348023456789", "2348030000000"]);
    expect(sent[0].sms).toMatch(/^Hi Ada, Shop .* has new stock$/);
    const list = (await S(x).get("/business/messages").expect(200)).body;
    expect(list[0]).toMatchObject({ id: m.id, delivered: 2, failed: 1 });
  });

  it("counts a number that can't be dialled as failed without calling the provider", async () => {
    const x = await newTenant(api);
    await customer(x, "Dee Okoro", "12345678"); // 8 digits: long enough to pass the audience check, not a real number
    await S(x).post("/business/messages", { channel: "sms", body: "Hello", audience: { type: "all" } }).expect(201);
    await messages.idle();
    expect(calls).toHaveLength(0);
    expect((await S(x).get("/business/messages").expect(200)).body[0]).toMatchObject({ delivered: 0, failed: 1 });
  });

  it("a provider outage fails the texts, not the request", async () => {
    const x = await newTenant(api);
    await customer(x, "Eve Musa", "0801 111 2222");
    sms.http = (async () => { throw new Error("network down"); }) as never;
    await S(x).post("/business/messages", { channel: "sms", body: "Hello", audience: { type: "all" } }).expect(201);
    await messages.idle();
    expect((await S(x).get("/business/messages").expect(200)).body[0]).toMatchObject({ delivered: 0, failed: 1 });
  });

  it("emails are counted too, and WhatsApp isn't a channel any more", async () => {
    const x = await newTenant(api);
    await customer(x, "Fay Bello", "0801 333 4444");
    await S(x).post("/business/messages", { channel: "email", subject: "Hi", body: "Hello", audience: { type: "all" } }).expect(201);
    await messages.idle();
    expect((await S(x).get("/business/messages").expect(200)).body[0]).toMatchObject({ channel: "email", delivered: 1, failed: 0 });
    await S(x).post("/business/messages", { channel: "whatsapp", body: "Hello", audience: { type: "all" } }).expect(400);
  });
});
