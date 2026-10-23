import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { AppError } from "../common/errors";
import { allowedThemes, num, toBusiness } from "../common/serializers";
import { cardAvailable, completeBankAccount } from "../common/payment-methods";
import { paidPlan } from "../common/delivery";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ProfileDto } from "./dto/business.dto";

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  async get(businessId: string) {
    const b = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { plan: { select: { priceMonthly: true } } } });
    const db = this.prisma.forBusiness(businessId);
    const [products, orders, customers, paid] = await Promise.all([
      db.product.count(), db.order.count(), db.customer.count(),
      db.order.aggregate({ where: { paymentStatus: "PAID" }, _sum: { total: true } }),
    ]);
    return toBusiness(b, { products, orders, customers, revenue: paid._sum.total ? num(paid._sum.total) : 0 }, b.plan);
  }

  async update(businessId: string, dto: ProfileDto) {
    const data: Record<string, unknown> = {};
    const text = (k: "name" | "description" | "phone" | "country" | "city" | "category", required: string | null) => {
      if (dto[k] === undefined) return;
      const v = dto[k]!.trim();
      if (required && !v) throw AppError.badRequest(required);
      data[k] = v;
    };
    text("name", "Enter your business name."); text("category", "Choose a business type.");
    text("country", "Enter your country."); text("city", "Enter your city.");
    text("description", null); text("phone", null);
    if (dto.brandColor !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(dto.brandColor)) throw AppError.badRequest("Choose a valid brand colour.");
      data.brandColor = dto.brandColor.toLowerCase();
    }
    if (dto.currency !== undefined) data.currency = dto.currency;
    if (dto.paymentMethods !== undefined || dto.bankAccount !== undefined) {
      const current = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { paymentMethods: true, bankAccount: true } });
      let account: unknown = current.bankAccount;
      if (dto.bankAccount !== undefined) {
        if (dto.bankAccount === null) account = null;
        else {
          const clean = completeBankAccount(dto.bankAccount);
          if (!clean) throw AppError.badRequest("Enter your bank name, account number and account name.", "BANK_DETAILS_INCOMPLETE");
          if (!/^[A-Za-z0-9][A-Za-z0-9 -]{2,32}[A-Za-z0-9]$/.test(clean.accountNumber)) throw AppError.badRequest("Enter a valid account number.", "BANK_ACCOUNT_NUMBER_INVALID");
          if (clean.swiftCode && !/^[A-Za-z0-9]{8,11}$/.test(clean.swiftCode)) throw AppError.badRequest("A SWIFT/BIC code has 8 or 11 letters and numbers.", "BANK_SWIFT_INVALID");
          account = clean;
        }
        data.bankAccount = account === null ? Prisma.DbNull : account;
      }
      const methods = dto.paymentMethods ?? current.paymentMethods;
      if (dto.paymentMethods?.includes("card") && !cardAvailable()) throw AppError.badRequest("Card payments aren't available yet. Choose pay on delivery or bank transfer.", "CARD_UNAVAILABLE");
      if (methods.includes("bank") && !completeBankAccount(account)) throw AppError.badRequest("Add your bank name, account number and account name before offering bank transfer.", "BANK_DETAILS_REQUIRED");
      if (dto.paymentMethods !== undefined) data.paymentMethods = dto.paymentMethods;
    }
    if (dto.delivery !== undefined) {
      const d = dto.delivery;
      const plan = await this.prisma.plan.findFirstOrThrow({ where: { businesses: { some: { id: businessId } } } });
      const seen = new Set<string>();
      const zones = (d.zones ?? []).map((z) => {
        const name = z.name.trim();
        if (!name) throw AppError.badRequest("Give every delivery zone a name.", "DELIVERY_ZONE_NAME");
        if (!(z.fee >= 0)) throw AppError.badRequest(`Enter a valid delivery fee for ${name}.`, "DELIVERY_FEE_INVALID");
        const key = `${z.kind}:${name.toLowerCase()}`;
        if (seen.has(key)) throw AppError.badRequest(`${name} is listed twice.`, "DELIVERY_ZONE_DUPLICATE");
        seen.add(key);
        return { id: z.id?.trim() || randomUUID().slice(0, 8), kind: z.kind, name, fee: Math.round(z.fee * 100) / 100, ...(z.note?.trim() ? { note: z.note.trim() } : {}) };
      });
      const pickup = { enabled: !!d.pickup?.enabled, address: d.pickup?.address?.trim() ?? "", hours: d.pickup?.hours?.trim() ?? "", instructions: d.pickup?.instructions?.trim() ?? "" };
      if (pickup.enabled && !pickup.address) throw AppError.badRequest("Add your pickup address before turning pickup on.", "PICKUP_ADDRESS_REQUIRED");
      const threshold = d.freeShippingThreshold ?? null;
      if (threshold !== null && threshold > 0 && !paidPlan(plan)) throw AppError.forbidden(`Free shipping thresholds aren't included in your ${plan.name} plan. Upgrade to use them.`, "FEATURE_NOT_IN_PLAN");
      data.delivery = { pickup, zones, freeShippingThreshold: threshold && threshold > 0 ? threshold : null, ...(d.note?.trim() ? { note: d.note.trim() } : {}) };
    }
    if (dto.theme !== undefined) {
      if (dto.theme !== null) {
        const plan = await this.prisma.plan.findFirstOrThrow({ where: { businesses: { some: { id: businessId } } } });
        if (!allowedThemes(plan.themes).includes(dto.theme)) {
          throw AppError.forbidden(`The ${dto.theme} theme isn't included in your ${plan.name} plan. Upgrade to use it.`, "THEME_NOT_IN_PLAN");
        }
      }
      data.theme = dto.theme; // null goes back to the default theme
    }
    if (dto.logo !== undefined) {
      if (dto.logo !== null && !this.storage.isOwnedUrl(businessId, dto.logo)) throw AppError.badRequest("Upload the logo again, then save.", "IMAGE_NOT_OWNED");
      data.logoUrl = dto.logo;
    }
    if (Object.keys(data).length) await this.prisma.business.update({ where: { id: businessId }, data });
    return this.get(businessId);
  }
}
