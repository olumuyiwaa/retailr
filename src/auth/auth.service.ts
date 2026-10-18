import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { BusinessStatus, Currency, Prisma, Role, User } from "@prisma/client";
import * as argon2 from "argon2";
import { createHash, randomBytes } from "crypto";
import { AppError } from "../common/errors";
import { toAuthUser } from "../common/serializers";
import { PlanCouponsService } from "../plans/plan-coupons.service";
import { PrismaService } from "../prisma/prisma.service";
import { RegisterDto } from "./dto/auth.dto";

const DAY = 86_400_000;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const currencyForCountry = (country: string): Currency => {
  const c = country.trim().toLowerCase();
  return c === "nigeria" ? "NGN" : c === "ghana" ? "GHS" : c === "kenya" ? "KES" : "USD";
};

export interface Session {
  user: ReturnType<typeof toAuthUser>;
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
          phone: dto.phone ?? "", country: dto.country, city: dto.city, currency: currencyForCountry(dto.country),
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

  async logout(token: string) {
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw AppError.unauthorized();
    return toAuthUser(user);
  }

  private async issue(user: User): Promise<Session> {
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role as Role, businessId: user.businessId ?? undefined });
    const refreshToken = randomBytes(48).toString("base64url");
    const days = this.config.get<number>("REFRESH_TOKEN_TTL_DAYS") ?? 30;
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt: new Date(Date.now() + days * DAY) },
    });
    return { user: toAuthUser(user), accessToken, refreshToken };
  }
}

// a real argon2 hash of a random string, only used to equalise timing when the email is unknown
const DUMMY_HASH = argon2.hash(randomBytes(16).toString("hex"));
