import { INestApplication } from "@nestjs/common";
import { MessagesService } from "../src/business/messages.service";
import { MailService } from "../src/mail/mail.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant, run, Tenant } from "./helpers";

describe("Email, invites and receipts", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, mail: MailService;
  let n = 0;
  const S = (x: Tenant) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set(...x.auth),
    post: (p: string, b: object = {}) => api().post(`/api/v1${p}`).set(...x.auth).send(b),
    del: (p: string) => api().delete(`/api/v1${p}`).set(...x.auth),
  });
  const mailsTo = (to: string) => mail.outbox.filter((m) => m.to === to);
  const tokenIn = (m: { text: string }) => /token=([a-f0-9]{64})/.exec(m.text)![1];
  const invite = async (x: Tenant, role = "staff") => {
    const email = `inv${++n}.${run}@example.com`;
    const m = (await S(x).post("/business/team", { name: "New Person", email, role }).expect(201)).body;
    return { member: m, email, token: tokenIn(mailsTo(email)[0]) };
  };

  beforeAll(async () => { ({ app, prisma, api } = await boot()); mail = app.get(MailService); });
  afterAll(async () => { await app.close(); });

  describe("team invites", () => {
    it("emails a one-time link, and the page can preview it", async () => {
      const x = await newTenant(api, { businessName: `Acme <img src=x onerror=alert(1)> ${run}` });
      const { email, token } = await invite(x, "manager");
      const sent = mailsTo(email);
      expect(sent).toHaveLength(1);
      expect(sent[0].subject).toContain("invited you to");
      expect(sent[0].text).toContain("/admin/accept-invite?token=");
      expect(sent[0].html).not.toContain("<img src=x"); // business names are escaped in HTML
      expect(sent[0].html).toContain("&lt;img");
      expect(await prisma.teamMember.count({ where: { businessId: x.businessId, inviteTokenHash: token } })).toBe(0); // only a hash is stored
      const p = (await api().get(`/api/v1/auth/invite/${token}`).expect(200)).body;
      expect(p).toMatchObject({ name: "New Person", email, role: "manager" });
      expect(p.businessName).toContain("Acme");
      expect((await api().get("/api/v1/auth/invite/nope").expect(400)).body.code).toBe("INVITE_INVALID");
    });

    it("accepting creates the login once, and the new teammate can work in the business", async () => {
      const x = await newTenant(api); const { email, token, member } = await invite(x);
      expect((await api().post("/api/v1/auth/accept-invite").send({ token, password: "short" }).expect(400)).body.message).toBe("Password must be at least 8 characters.");
      const r = (await api().post("/api/v1/auth/accept-invite").send({ token, password: "new-password-1" }).expect(200)).body;
      expect(r.user).toMatchObject({ email, role: "business_admin", businessId: x.businessId });
      await api().get("/api/v1/business/profile").set("Authorization", `Bearer ${r.accessToken}`).expect(200);
      expect((await S(x).get("/business/team").expect(200)).body.find((t: any) => t.id === member.id).status).toBe("active");
      expect((await api().post("/api/v1/auth/accept-invite").send({ token, password: "another-pass-1" }).expect(400)).body.code).toBe("INVITE_INVALID");
      await api().post("/api/v1/auth/login").send({ email, password: "new-password-1" }).expect(200);
      // removing them takes the login away
      await S(x).del(`/business/team/${member.id}`).expect(204);
      await api().post("/api/v1/auth/login").send({ email, password: "new-password-1" }).expect(401);
    });

    it("two people clicking the same link: exactly one gets in", async () => {
      const x = await newTenant(api); const { token } = await invite(x);
      const rs = await Promise.all([1, 2, 3].map(() => api().post("/api/v1/auth/accept-invite").send({ token, password: "race-password-1" })));
      expect(rs.filter((r: any) => r.status === 200)).toHaveLength(1);
      expect(rs.filter((r: any) => r.status === 400)).toHaveLength(2);
    });

    it("refuses expired links, taken emails and inactive businesses", async () => {
      const x = await newTenant(api);
      const a = await invite(x);
      await prisma.teamMember.update({ where: { id: a.member.id }, data: { inviteExpiresAt: new Date(Date.now() - 1000) } });
      expect((await api().post("/api/v1/auth/accept-invite").send({ token: a.token, password: "password-123" }).expect(400)).body.code).toBe("INVITE_INVALID");
      await api().get(`/api/v1/auth/invite/${a.token}`).expect(400);

      const b = await invite(x);
      await prisma.user.create({ data: { email: b.email, name: "Existing", passwordHash: "x", role: "BUSINESS_ADMIN" } });
      expect((await api().post("/api/v1/auth/accept-invite").send({ token: b.token, password: "password-123" }).expect(409)).body.code).toBe("EMAIL_TAKEN");
      expect((await prisma.teamMember.findUniqueOrThrow({ where: { id: b.member.id } })).status).toBe("INVITED"); // rolled back, can try again later

      const c = await invite(x);
      await prisma.business.update({ where: { id: x.businessId }, data: { status: "SUSPENDED" } });
      expect((await api().post("/api/v1/auth/accept-invite").send({ token: c.token, password: "password-123" }).expect(403)).body.code).toBe("BUSINESS_SUSPENDED");
    });

    it("resend replaces the link; it only works for people who haven't joined, in your own team", async () => {
      const x = await newTenant(api); const other = await newTenant(api);
      const { email, token, member } = await invite(x);
      await S(x).post(`/business/team/${member.id}/resend`).expect(200);
      expect(mailsTo(email)).toHaveLength(2);
      const fresh = tokenIn(mailsTo(email)[1]);
      expect(fresh).not.toBe(token);
      await api().get(`/api/v1/auth/invite/${token}`).expect(400);
      await api().post("/api/v1/auth/accept-invite").send({ token: fresh, password: "password-123" }).expect(200);
      expect((await S(x).post(`/business/team/${member.id}/resend`).expect(400)).body.message).toBe("That person has already joined.");
      await S(other).post(`/business/team/${member.id}/resend`).expect(404);
    });
  });

  describe("receipts", () => {
    it("emails the receipt to the customer and records when", async () => {
      const x = await newTenant(api, { businessName: `Receipt Shop ${run}` }); const sx = S(x);
      const p = (await sx.post("/business/products", { name: "Silk <b>Dress</b>", sku: "", category: "", description: "", price: 250, stock: 5, status: "active" }).expect(201)).body;
      const slug = (await prisma.business.findUniqueOrThrow({ where: { id: x.businessId } })).slug;
      const email = `rcpt.${run}@example.com`;
      const o = (await api().post(`/api/v1/store/${slug}/orders`).send({ customer: { name: "Ada Obi", email, phone: "1" }, shippingAddress: "12 <i>Rd</i>", paymentMethod: "cod", items: [{ productId: p.id, qty: 2 }] }).expect(201)).body;
      const r = (await sx.post(`/business/orders/${o.id}/receipt`).expect(200)).body;
      expect(r.receiptSentAt).toBeTruthy();
      const m = mailsTo(email)[0];
      expect(m.subject).toBe(`Your receipt from Receipt Shop ${run} (${o.number})`);
      expect(m.text).toContain("2 x Silk <b>Dress</b>  ₦500");
      expect(m.text).toContain(`/s/${slug}/order/${o.publicToken}`);
      expect(m.html).not.toContain("<b>Dress</b>"); expect(m.html).not.toContain("<i>Rd</i>");
      expect(m.html).toContain("&lt;b&gt;Dress");
    });

    it("says so when there's nobody to send it to or the mail fails", async () => {
      const x = await newTenant(api); const sx = S(x);
      const p = (await sx.post("/business/products", { name: "P", sku: "", category: "", description: "", price: 10, stock: 5, status: "active" }).expect(201)).body;
      const walkIn = (await sx.post("/business/sales", { items: [{ productId: p.id, qty: 1 }], channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true }).expect(201)).body;
      expect((await sx.post(`/business/orders/${walkIn.id}/receipt`).expect(400)).body.code).toBe("NO_CUSTOMER_EMAIL");
      const withEmail = (await sx.post("/business/sales", { items: [{ productId: p.id, qty: 1 }], newCustomer: { name: "E M", email: `em.${run}@example.com` }, channel: "in_store", paymentMethod: "cash", paid: true, handedOver: true }).expect(201)).body;
      const spy = jest.spyOn(mail, "send").mockRejectedValueOnce(new Error("smtp down"));
      const f = await sx.post(`/business/orders/${withEmail.id}/receipt`).expect(502);
      expect(f.body).toMatchObject({ code: "MAIL_FAILED", message: "We couldn't send the receipt. Please try again." });
      spy.mockRestore();
      expect((await sx.get(`/business/orders/${withEmail.id}`).expect(200)).body.receiptSentAt).toBeUndefined(); // not marked as sent
      await sx.post(`/business/orders/${withEmail.id}/receipt`).expect(200);
    });
  });

  describe("customer messages", () => {
    it("emails each reachable customer with their own name and the store filled in", async () => {
      const x = await newTenant(api, { businessName: `Msg Shop ${run}` }); const sx = S(x);
      const mk = (name: string, email: string | null, phone = "08011111111") => prisma.customer.create({ data: { businessId: x.businessId, name, email, phone } });
      const ada = `ada.${run}@example.com`, bola = `bola.${run}@example.com`;
      await mk("Ada Obi", ada); await mk("Bola Ige", bola); await mk("No Email", null);
      const before = mail.outbox.length;
      const r = (await sx.post("/business/messages", { channel: "email", subject: "Hi {{first_name}}!", body: "Hello {{ first_name }}, new stock at {{store}}. <script>x</script>", audience: { type: "all" } }).expect(201)).body;
      expect(r.recipientCount).toBe(2);
      await app.get(MessagesService).idle();
      const sent = mail.outbox.slice(before);
      expect(sent.map((m) => m.to).sort()).toEqual([ada, bola].sort());
      const toAda = sent.find((m) => m.to === ada)!;
      expect(toAda.subject).toBe("Hi Ada!");
      expect(toAda.text).toContain(`Hello Ada, new stock at Msg Shop ${run}.`);
      expect(toAda.html).not.toContain("<script>");
      expect(sent.find((m) => m.to === bola)!.subject).toBe("Hi Bola!");
    });

    it("a failure for one customer doesn't stop the others, and SMS sends no email", async () => {
      const x = await newTenant(api); const sx = S(x);
      const emails = [1, 2, 3, 4, 5, 6, 7].map((i) => `many${i}.${run}.${x.businessId.slice(-5)}@example.com`);
      for (const e of emails) await prisma.customer.create({ data: { businessId: x.businessId, name: "Pat Q", email: e, phone: "08011111111" } });
      const before = mail.outbox.length;
      const spy = jest.spyOn(mail, "send").mockImplementationOnce(async () => { throw new Error("boom"); });
      await sx.post("/business/messages", { channel: "email", subject: "News", body: "Hello", audience: { type: "all" } }).expect(201);
      await app.get(MessagesService).idle();
      spy.mockRestore();
      expect(mail.outbox.length - before).toBe(6); // 7 attempted, one failed
      const again = mail.outbox.length;
      await sx.post("/business/messages", { channel: "sms", body: "Hello", audience: { type: "all" } }).expect(201);
      await app.get(MessagesService).idle();
      expect(mail.outbox.length).toBe(again);
    });
  });
});
