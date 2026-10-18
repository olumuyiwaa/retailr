import { Injectable } from "@nestjs/common";
import { AppError } from "../common/errors";
import { num, toBusiness } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ProfileDto } from "./dto/business.dto";

@Injectable()
export class ProfileService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  async get(businessId: string) {
    const b = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    const db = this.prisma.forBusiness(businessId);
    const [products, orders, customers, paid] = await Promise.all([
      db.product.count(), db.order.count(), db.customer.count(),
      db.order.aggregate({ where: { paymentStatus: "PAID" }, _sum: { total: true } }),
    ]);
    return toBusiness(b, { products, orders, customers, revenue: paid._sum.total ? num(paid._sum.total) : 0 });
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
    if (dto.theme !== undefined) data.theme = dto.theme; // null goes back to the default theme
    if (dto.logo !== undefined) {
      if (dto.logo !== null && !this.storage.isOwnedUrl(businessId, dto.logo)) throw AppError.badRequest("Upload the logo again, then save.", "IMAGE_NOT_OWNED");
      data.logoUrl = dto.logo;
    }
    if (Object.keys(data).length) await this.prisma.business.update({ where: { id: businessId }, data });
    return this.get(businessId);
  }
}
