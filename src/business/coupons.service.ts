import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { toCoupon } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { CouponDto } from "./dto/business.dto";

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(businessId: string) {
    return (await this.prisma.forBusiness(businessId).coupon.findMany({ orderBy: { createdAt: "desc" } })).map(toCoupon);
  }

  private clean(dto: CouponDto) {
    const code = String(dto.code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw AppError.badRequest("Use 3–20 letters, numbers or dashes for the code.");
    if (!(dto.value > 0)) throw AppError.badRequest("Enter a discount greater than zero.");
    if (dto.type === "percent" && dto.value > 100) throw AppError.badRequest("A percentage can't be more than 100.");
    let expiresAt: Date | null = null;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw AppError.badRequest("Enter a valid expiry date.");
    }
    return { code, type: dto.type.toUpperCase() as "PERCENT" | "FIXED", value: dto.value, minOrder: dto.minOrder ?? null, maxUses: dto.maxUses ?? null, expiresAt };
  }

  async create(businessId: string, dto: CouponDto) {
    const data = this.clean(dto);
    try {
      return toCoupon(await this.prisma.forBusiness(businessId).coupon.create({ data: data as never }));
    } catch (e) { throw this.dupe(e); }
  }

  /** Full replacement of the editable fields; the use count is kept. */
  async update(businessId: string, id: string, dto: CouponDto) {
    const db = this.prisma.forBusiness(businessId);
    const data = this.clean(dto);
    if (!(await db.coupon.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Coupon not found.");
    try {
      return toCoupon(await db.coupon.update({ where: { id }, data }));
    } catch (e) { throw this.dupe(e); }
  }

  async setStatus(businessId: string, id: string, status: "active" | "disabled") {
    const db = this.prisma.forBusiness(businessId);
    if (!(await db.coupon.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Coupon not found.");
    return toCoupon(await db.coupon.update({ where: { id }, data: { status: status.toUpperCase() as never } }));
  }

  async remove(businessId: string, id: string) {
    await this.prisma.forBusiness(businessId).coupon.deleteMany({ where: { id } });
  }

  private dupe(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return AppError.conflict("You already have a code with that name.", "COUPON_EXISTS");
    return e;
  }
}
