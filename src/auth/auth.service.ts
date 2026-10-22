import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { BusinessStatus, Currency, Prisma, Role, User } from "@prisma/client";
import * as argon2 from "argon2";
import { createHash, randomBytes } from "crypto";
import { AppError } from "../common/errors";
import { toAuthUser } from "../common/serializers";
import { MailService } from "../mail/mail.service";
import { passwordResetMail, verifyEmailMail } from "../mail/templates";
import { NotificationsService } from "../notifications/notifications.service";
import { PlanCouponsService } from "../plans/plan-coupons.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegisterDto } from "./dto/auth.dto";

const DAY = 86_400_000;
const RESET_MINUTES = 60;
const VERIFY_HOURS = 48;
/** One reset or verification mail per person per minute, so the form can't be used to flood an inbox. */
const COOLDOWN_MS = 60_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const timezoneForCountry = (country: string) => {
  const c = country.trim().toLowerCase();
  return c === "ghana" ? "Africa/Accra" : c === "kenya" ? "Africa/Nairobi" : c === "nigeria" ? "Africa/Lagos" : "UTC";
};
const currencyForCountry = (country: string): Currency => {
  const c = country.trim().toLowerCase();
  return c === "nigeria" ? "NGN" : c === "ghana" ? "GHS" : c === "kenya" ? "KES" : "USD";
};

export interface Session {
  user: ReturnType<typeof toAuthUser> & { teamRole?: "owner" | "manager" | "staff" };
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly coupons: PlanCouponsService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  async register(dto: RegisterDto): Promise<Session> {
    const email = dto.email.toLowerCase();
    const plan = await this.prisma.plan.findFirst({ where: { id: dto.planId, isActive: true } });
    if (!plan) throw AppError.badRequest("Please choose a plan.");
    const cycle = dto.cycle === "yearly" ? "YEARLY" : "MONTHLY";
    const free = plan.priceMonthly.equals(0);
    const passwordHash = await argon2.hash(dto.password);

    const user = await this.prisma.$transaction(async (tx) => {
      if (await tx.user.findUnique({ where: { email } })) throw AppError.conflict("An account with this email already exists.", "EMAIL_TAKEN");

      // check the code before anything is created, so a bad one leaves no half-made account
      const priced = await this.coupons.price(tx, plan, cycle, free ? undefined : dto.couponCode);

      const base = dto.businessName.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "store";
      let slug = base;
      for (let n = 2; await tx.business.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${base}-${n}`;

      const now = new Date();
      const trialEnds = new Date(now.getTime() + 14 * DAY);
      const status: BusinessStatus = free ? "ACTIVE" : "TRIAL";
      const business = await tx.business.create({
        data: {
          name: dto.businessName, slug, category: dto.category, ownerName: dto.ownerName, ownerEmail: email,
          phone: dto.phone ?? "", country: dto.country, city: dto.city, currency: currencyForCountry(dto.country), timezone: timezoneForCountry(dto.country),
          status, planId: plan.id,
        },
      });
      await tx.subscription.create({
        data: {
          businessId: business.id, planId: plan.id, status: free ? "ACTIVE" : "TRIALING", cycle,
          amount: priced.amount, currentPeriodEnd: trialEnds, trialEndsAt: free ? null : trialEnds,
          planCouponId: priced.planCouponId, discount: priced.discount,
        },
      });
      if (priced.planCouponId) await this.coupons.redeem(tx, priced.planCouponId, business.id);

      const created = await tx.user.create({
        data: { email, name: dto.ownerName, passwordHash, role: "BUSINESS_ADMIN", businessId: business.id },
      });
      await tx.teamMember.create({
        data: { businessId: business.id, userId: created.id, name: dto.ownerName, email, role: "OWNER", status: "ACTIVE" },
      });
      return created;
    });
    void this.notifications.notifyPlatform({ type: "NEW_BUSINESS", title: `New business: ${dto.businessName}`, body: `${dto.ownerName} · ${plan.name} plan · ${dto.city}, ${dto.country}`, link: "/admin/super/businesses" });
    void this.sendVerification(user);
    return this.issue(user);
  }

  async login(emailRaw: string, password: string): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { email: emailRaw.trim().toLowerCase() }, include: { business: true } });
    // verify against a dummy hash when the user is missing so response time doesn't reveal which emails exist
    const ok = await argon2.verify(user?.passwordHash ?? (await DUMMY_HASH), password).catch(() => false);
    if (!user || !ok) throw AppError.unauthorized("Invalid email or password.", "INVALID_CREDENTIALS");
    if (user.business?.status === "SUSPENDED") throw AppError.forbidden("This business account is suspended. Contact Retailr support.", "BUSINESS_SUSPENDED");
    if (user.business?.status === "CANCELLED") throw AppError.forbidden("This business account has been cancelled.", "BUSINESS_CANCELLED");
    return this.issue(user);
  }

  /** Rotates the refresh token. Presenting a token that was already used revokes the whole family of sessions. */
  async refresh(token: string): Promise<Session> {
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!row) throw AppError.unauthorized("Please sign in again.", "INVALID_REFRESH");
    if (row.revokedAt) {
      await this.prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw AppError.unauthorized("Please sign in again.", "INVALID_REFRESH");
    }
    if (row.expiresAt.getTime() < Date.now()) throw AppError.unauthorized("Your session has expired. Please sign in again.", "TOKEN_EXPIRED");
    const claimed = await this.prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count === 0) throw AppError.unauthorized("Please sign in again.", "INVALID_REFRESH"); // lost a race with another refresh
    return this.issue(row.user);
  }

  private async inviteFor(token: string) {
    const m = await this.prisma.teamMember.findUnique({ where: { inviteTokenHash: sha256(token) }, include: { business: { select: { name: true, status: true } } } });
    if (!m || m.status !== "INVITED" || !m.inviteExpiresAt || m.inviteExpiresAt.getTime() < Date.now()) {
      throw AppError.badRequest("This invite link isn't valid or has expired. Ask for a new one.", "INVITE_INVALID");
    }
    return m;
  }

  /** What the accept-invite page shows before the person chooses a password. */
  async invitePreview(token: string) {
    const m = await this.inviteFor(token);
    return { name: m.name, email: m.email, role: m.role.toLowerCase(), businessName: m.business.name };
  }

  /** Turns an invite into a login. The token works once. */
  async acceptInvite(token: string, password: string): Promise<Session> {
    const m = await this.inviteFor(token);
    if (m.business.status === "SUSPENDED") throw AppError.forbidden("This business account is suspended. Contact Retailr support.", "BUSINESS_SUSPENDED");
    if (m.business.status === "CANCELLED") throw AppError.forbidden("This business account has been cancelled.", "BUSINESS_CANCELLED");
    const passwordHash = await argon2.hash(password);
    const user = await this.prisma.$transaction(async (tx) => {
      // claim the invite first so two people clicking at once can't both use it
      const claimed = await tx.teamMember.updateMany({ where: { id: m.id, inviteTokenHash: sha256(token) }, data: { inviteTokenHash: null, inviteExpiresAt: null, status: "ACTIVE" } });
      if (claimed.count === 0) throw AppError.badRequest("This invite link isn't valid or has expired. Ask for a new one.", "INVITE_INVALID");
      const email = m.email.toLowerCase();
      if (await tx.user.findUnique({ where: { email } })) throw AppError.conflict("An account with this email already exists.", "EMAIL_TAKEN");
      const u = await tx.user.create({ data: { email, name: m.name, passwordHash, role: "BUSINESS_ADMIN", businessId: m.businessId, emailVerifiedAt: new Date() } });
      await tx.teamMember.update({ where: { id: m.id }, data: { userId: u.id } });
      return u;
    });
    return this.issue(user);
  }

  /** Makes a single-use token, replacing any unused ones of the same kind. Returns null during the cooldown. */
  private async mintToken(userId: string, kind: "PASSWORD_RESET" | "EMAIL_VERIFY", ttlMs: number): Promise<string | null> {
    const recent = await this.prisma.authToken.findFirst({ where: { userId, kind, createdAt: { gt: new Date(Date.now() - COOLDOWN_MS) } }, select: { id: true } });
    if (recent) return null;
    const token = randomBytes(32).toString("base64url");
    await this.prisma.$transaction([
      this.prisma.authToken.deleteMany({ where: { userId, kind, usedAt: null } }),
      this.prisma.authToken.create({ data: { userId, kind, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } }),
    ]);
    return token;
  }

  /** Claims a token exactly once, so two clicks (or two requests) can't both use it. */
  private async claimToken(token: string, kind: "PASSWORD_RESET" | "EMAIL_VERIFY") {
    const hash = sha256(token);
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash: hash } });
    const bad = kind === "PASSWORD_RESET"
      ? AppError.badRequest("This reset link isn't valid or has expired. Ask for a new one.", "RESET_INVALID")
      : AppError.badRequest("This confirmation link isn't valid or has expired. Ask for a new one.", "VERIFY_INVALID");
    if (!row || row.kind !== kind || row.usedAt || row.expiresAt.getTime() < Date.now()) throw bad;
    const claimed = await this.prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (claimed.count === 0) throw bad;
    return row;
  }

  /** Always answers the same way, so the form can't be used to find out which emails have accounts. */
  async forgotPassword(emailRaw: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: emailRaw.trim().toLowerCase() } });
    if (!user) return;
    const token = await this.mintToken(user.id, "PASSWORD_RESET", RESET_MINUTES * 60_000);
    if (!token) return;
    await this.mail.trySend(passwordResetMail(user.email, { name: user.name, link: `${this.mail.appUrl}/admin/reset-password?token=${token}`, minutes: RESET_MINUTES }));
  }

  /** Sets the new password, signs every device out, and counts as proof the person owns the inbox. */
  async resetPassword(token: string, password: string): Promise<void> {
    const row = await this.claimToken(token, "PASSWORD_RESET");
    const passwordHash = await argon2.hash(password);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: row.userId }, data: { passwordHash, emailVerifiedAt: new Date() } }),
      this.prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.authToken.deleteMany({ where: { userId: row.userId, kind: "PASSWORD_RESET" } }),
    ]);
  }

  private async sendVerification(user: User): Promise<boolean> {
    const token = await this.mintToken(user.id, "EMAIL_VERIFY", VERIFY_HOURS * 3_600_000);
    if (!token) return false;
    return this.mail.trySend(verifyEmailMail(user.email, { name: user.name, link: `${this.mail.appUrl}/admin/verify-email?token=${token}`, hours: VERIFY_HOURS }));
  }

  async verifyEmail(token: string): Promise<void> {
    const row = await this.claimToken(token, "EMAIL_VERIFY");
    await this.prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.unauthorized();
    if (user.emailVerifiedAt) return;
    await this.sendVerification(user);
  }

  async logout(token: string) {
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.unauthorized();
    return { ...toAuthUser(user), ...(await this.teamRole(user)) };
  }


  /** Update the signed-in person's display name. */
  async updateMe(userId: string, name: string) {
    const user = await this.prisma.user.update({ where: { id: userId }, data: { name: name.trim() } });
    return { ...toAuthUser(user), ...(await this.teamRole(user)) };
  }

  /** Change password while signed in. Revokes every other session. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.unauthorized();
    if (!(await argon2.verify(user.passwordHash, currentPassword))) {
      throw AppError.badRequest("Current password is incorrect.", "WRONG_PASSWORD");
    }
    if (currentPassword === newPassword) {
      throw AppError.badRequest("Choose a new password that is different from the current one.");
    }
    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }

  /**
   * Delete the signed-in account after password confirmation.
   * - Owner of a business: deletes the whole business (cascade).
   * - Staff/manager: removes only their login and team seat.
   * - Super admin: deletes their user row only.
   */
  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.unauthorized();
    if (!(await argon2.verify(user.passwordHash, password))) {
      throw AppError.badRequest("Password is incorrect.", "WRONG_PASSWORD");
    }
    if (user.role === "SUPER_ADMIN") {
      const admins = await this.prisma.user.count({ where: { role: "SUPER_ADMIN" } });
      if (admins <= 1) throw AppError.badRequest("You are the only platform admin. Add another admin before deleting this account.");
      await this.prisma.user.delete({ where: { id: userId } });
      return;
    }
    if (user.role === "BUSINESS_ADMIN" && user.businessId) {
      const member = await this.prisma.teamMember.findFirst({
        where: { userId: user.id, businessId: user.businessId },
        select: { role: true },
      });
      if (member?.role === "OWNER") {
        // Cascade removes products, orders, the owner user, etc.
        await this.prisma.business.delete({ where: { id: user.businessId } });
        return;
      }
    }
    await this.prisma.user.delete({ where: { id: userId } });
  }

  /** A business admin's role on the team, so the app can show only what they may use. */
  private async teamRole(user: User) {
    if (user.role !== "BUSINESS_ADMIN" || !user.businessId) return {};
    const m = await this.prisma.teamMember.findFirst({ where: { userId: user.id, businessId: user.businessId }, select: { role: true } });
    return m ? { teamRole: m.role.toLowerCase() as "owner" | "manager" | "staff" } : {};
  }

  private async issue(user: User): Promise<Session> {
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role as Role, businessId: user.businessId ?? undefined });
    const refreshToken = randomBytes(48).toString("base64url");
    const days = this.config.get<number>("REFRESH_TOKEN_TTL_DAYS") ?? 30;
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + days * DAY) },
    });
    return { user: { ...toAuthUser(user), ...(await this.teamRole(user)) }, accessToken, refreshToken };
  }
}

// a real argon2 hash of a random string, only used to equalise timing when the email is unknown
const DUMMY_HASH = argon2.hash(randomBytes(16).toString("hex"));
