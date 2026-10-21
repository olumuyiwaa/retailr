import { INestApplication } from "@nestjs/common";
import { MailService } from "../src/mail/mail.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { boot, newTenant } from "./helpers";

describe("Password reset and email verification", () => {
  let app: INestApplication, prisma: PrismaService, api: () => any, mail: MailService;
  beforeAll(async () => { ({ app, prisma, api } = await boot()); mail = app.get(MailService); });
  afterAll(async () => { await app.close(); });

  const tokenIn = (to: string, subject: RegExp) => {
    const m = [...mail.outbox].reverse().find((x) => x.to === to && subject.test(x.subject));
    return m?.text.match(/token=([\w-]+)/)?.[1];
  };
  const login = (email: string, password: string) => api().post("/api/v1/auth/login").send({ email, password });
  /** The one-minute cooldown is for people; tests clear it. */
  const noCooldown = () => prisma.authToken.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });

  it("emails a link that sets a new password once, and signs every device out", async () => {
    const t = await newTenant(api);
    const refresh = (await login(t.email, "password123").expect(200)).body.refreshToken;

    await api().post("/api/v1/auth/forgot-password").send({ email: t.email }).expect(204);
    const token = tokenIn(t.email, /Reset your/)!;
    expect(token).toBeTruthy();

    await api().post("/api/v1/auth/reset-password").send({ token, password: "short" }).expect(400);
    await api().post("/api/v1/auth/reset-password").send({ token, password: "brand-new-pass" }).expect(204);
    await api().post("/api/v1/auth/reset-password").send({ token, password: "another-pass-1" }).expect(400); // single use

    await login(t.email, "password123").expect(401);
    await login(t.email, "brand-new-pass").expect(200);
    await api().post("/api/v1/auth/refresh").send({ refreshToken: refresh }).expect(401); // old sessions are gone
  });

  it("answers the same for unknown emails, and throttles repeat requests", async () => {
    const before = mail.outbox.length;
    await api().post("/api/v1/auth/forgot-password").send({ email: "nobody@example.com" }).expect(204);
    expect(mail.outbox.length).toBe(before);

    const t = await newTenant(api);
    await api().post("/api/v1/auth/forgot-password").send({ email: t.email }).expect(204);
    const n = mail.outbox.filter((m) => m.to === t.email && /Reset your/.test(m.subject)).length;
    await api().post("/api/v1/auth/forgot-password").send({ email: t.email }).expect(204);
    expect(mail.outbox.filter((m) => m.to === t.email && /Reset your/.test(m.subject)).length).toBe(n); // within the cooldown

    await noCooldown();
    await api().post("/api/v1/auth/forgot-password").send({ email: t.email }).expect(204);
    const second = tokenIn(t.email, /Reset your/)!;
    await api().post("/api/v1/auth/reset-password").send({ token: "garbage", password: "password456" }).expect(400);
    await api().post("/api/v1/auth/reset-password").send({ token: second, password: "password456" }).expect(204);
  });

  it("rejects an expired reset link", async () => {
    const t = await newTenant(api);
    await api().post("/api/v1/auth/forgot-password").send({ email: t.email }).expect(204);
    const token = tokenIn(t.email, /Reset your/)!;
    await prisma.authToken.updateMany({ where: { user: { email: t.email } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await api().post("/api/v1/auth/reset-password").send({ token, password: "password456" }).expect(400);
  });

  it("verifies the owner's email from the link, and resend does nothing once verified", async () => {
    const t = await newTenant(api);
    expect((await api().get("/api/v1/auth/me").set(...t.auth).expect(200)).body.emailVerified).toBe(false);
    const token = tokenIn(t.email, /Confirm your email/)!;
    expect(token).toBeTruthy();

    await api().post("/api/v1/auth/verify-email").send({ token: "nope" }).expect(400);
    await api().post("/api/v1/auth/verify-email").send({ token }).expect(204);
    await api().post("/api/v1/auth/verify-email").send({ token }).expect(400);
    expect((await api().get("/api/v1/auth/me").set(...t.auth).expect(200)).body.emailVerified).toBe(true);

    const n = mail.outbox.length;
    await api().post("/api/v1/auth/resend-verification").set(...t.auth).expect(204);
    expect(mail.outbox.length).toBe(n);
    await api().post("/api/v1/auth/resend-verification").expect(401);
  });

  it("resending sends a fresh link that replaces the old one", async () => {
    const t = await newTenant(api);
    const first = tokenIn(t.email, /Confirm your email/)!;
    await noCooldown();
    await api().post("/api/v1/auth/resend-verification").set(...t.auth).expect(204);
    const second = tokenIn(t.email, /Confirm your email/)!;
    expect(second).not.toBe(first);
    await api().post("/api/v1/auth/verify-email").send({ token: first }).expect(400);
    await api().post("/api/v1/auth/verify-email").send({ token: second }).expect(204);
  });

  it("a password reset also confirms the email", async () => {
    const t = await newTenant(api);
    await api().post("/api/v1/auth/forgot-password").send({ email: t.email }).expect(204);
    await api().post("/api/v1/auth/reset-password").send({ token: tokenIn(t.email, /Reset your/)!, password: "password456" }).expect(204);
    const s = (await login(t.email, "password456").expect(200)).body;
    expect(s.user.emailVerified).toBe(true);
  });
});
