import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { num, toPlan, toPlanCoupon } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { PlanCouponDto, PlanDto } from "./dto/platform.dto";

const CURRENCIES = ["NGN", "GHS", "KES", "USD"];
const whole = (n: unknown) => Number.isInteger(n) && (n as number) >= -1; // -1 means unlimited

/** Plans and the platform's own discount codes. */
@Injectable()
export class PlatformCatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- plans ----------

  async plans() {
    const [plans, counts] = await Promise.all([
      this.prisma.plan.findMany({ orderBy: [{ priceMonthly: "asc" }, { createdAt: "asc" }] }),
      this.prisma.business.groupBy({ by: ["planId"], where: { status: { notIn: ["CANCELLED", "PENDING"] } }, _count: { _all: true } }),
    ]);
    const n = new Map(counts.map((c) => [c.planId, c._count._all]));
    return plans.map((p) => ({ ...toPlan(p), subscribers: n.get(p.id) ?? 0 }));
  }

  /** Creates the plan if the id is new, otherwise updates it. Existing subscriptions keep the amount they already pay. */
  async savePlan(id: string, dto: PlanDto) {
    if (!/^[a-z0-9_-]{3,40}$/.test(id)) throw AppError.badRequest("Use 3–40 lower-case letters, numbers, dashes or underscores for the plan id.");
    const name = dto.name.trim();
    if (!name) throw AppError.badRequest("Enter a plan name.");
    if (!(dto.priceMonthly >= 0) || !(dto.priceYearly >= 0)) throw AppError.badRequest("Prices can't be negative.");
    const l = dto.limits;
    if (![l.products, l.staff, l.ordersPerMonth, l.storageGb].every(whole)) throw AppError.badRequest("Limits must be whole numbers, or -1 for unlimited.");
    const fee = dto.transactionFeePct ?? 0;
    if (!(fee >= 0 && fee <= 100)) throw AppError.badRequest("The transaction fee must be between 0 and 100%.");
    const features = dto.features.map((f) => f.trim()).filter(Boolean);
    let localPrices: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
    if (dto.localPrices && Object.keys(dto.localPrices).length) {
      const ok = Object.entries(dto.localPrices).every(([c, v]) => CURRENCIES.includes(c) && v && v.monthly >= 0 && v.yearly >= 0);
      if (!ok) throw AppError.badRequest("Enter valid local prices.");
      localPrices = dto.localPrices as Prisma.InputJsonValue;
    }
    const data = {
      name, description: dto.description?.trim() ?? "", priceMonthly: dto.priceMonthly, priceYearly: dto.priceYearly, transactionFeePct: fee,
      maxProducts: l.products, maxStaff: l.staff, maxOrdersPerMonth: l.ordersPerMonth, maxStorageGb: l.storageGb,
      features, highlighted: dto.highlighted ?? false, isActive: dto.isActive ?? true, localPrices,
    };
    return toPlan(await this.prisma.plan.upsert({ where: { id }, create: { id, ...data }, update: data }));
  }

  // ---------- discount codes ----------

  private async rows(where: Prisma.PlanCouponWhereInput = {}) {
    const coupons = await this.prisma.planCoupon.findMany({
      where, orderBy: { createdAt: "desc" },
      include: { plans: true, business: { select: { name: true } }, _count: { select: { redemptions: true } } },
    });
    if (!coupons.length) return [];
    const [plans, live] = await Promise.all([
      this.prisma.plan.findMany({ select: { id: true, name: true } }),
      this.prisma.subscription.findMany({ where: { planCouponId: { in: coupons.map((c) => c.id) }, status: { not: "CANCELLED" }, discount: { not: null } }, select: { planCouponId: true, cycle: true, discount: true } }),
    ]);
    const names = new Map(plans.map((p) => [p.id, p.name]));
    return coupons.map((c) => ({
      ...toPlanCoupon(c),
      ...(c.business ? { businessName: c.business.name } : {}),
      planNames: c.plans.map((p) => names.get(p.planId) ?? p.planId),
      redeemed: c._count.redemptions,
      discountPerMonth: Math.round(live.filter((s) => s.planCouponId === c.id).reduce((n, s) => n + (s.cycle === "YEARLY" ? num(s.discount!) / 12 : num(s.discount!)), 0) * 100) / 100,
    }));
  }

  list() { return this.rows(); }

  private async clean(dto: PlanCouponDto) {
    const code = String(dto.code ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw AppError.badRequest("Use 3–20 letters, numbers or dashes for the code.");
    if (!(dto.value > 0)) throw AppError.badRequest("Enter a discount greater than zero.");
    if (dto.type === "percent" && dto.value > 100) throw AppError.badRequest("A percentage can't be more than 100.");
    if (dto.maxUses != null && !(Number.isInteger(dto.maxUses) && dto.maxUses >= 1)) throw AppError.badRequest("Max uses must be at least 1.");
    let expiresAt: Date | null = null;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw AppError.badRequest("Enter a valid expiry date.");
    }
    const planIds = [...new Set(dto.planIds ?? [])];
    if (planIds.length && (await this.prisma.plan.count({ where: { id: { in: planIds } } })) !== planIds.length) throw AppError.badRequest("Choose valid plans.");
    const businessId = dto.businessId || null;
    if (businessId && !(await this.prisma.business.findUnique({ where: { id: businessId }, select: { id: true } }))) throw AppError.badRequest("That business no longer exists.");
    return { code, type: dto.type.toUpperCase() as "PERCENT" | "FIXED", value: dto.value, maxUses: dto.maxUses ?? null, expiresAt, note: dto.note?.trim() || null, businessId, planIds };
  }

  async create(dto: PlanCouponDto) {
    const { planIds, businessId, ...d } = await this.clean(dto);
    try {
      const c = await this.prisma.planCoupon.create({ data: { ...d, businessId, plans: { create: planIds.map((planId) => ({ planId })) } } });
      return (await this.rows({ id: c.id }))[0];
    } catch (e) { throw this.dupe(e); }
  }

  async update(id: string, dto: PlanCouponDto) {
    if (!(await this.prisma.planCoupon.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Discount not found.");
    const { planIds, businessId, ...d } = await this.clean(dto);
    try {
      await this.prisma.planCoupon.update({ where: { id }, data: { ...d, businessId, plans: { deleteMany: {}, create: planIds.map((planId) => ({ planId })) } } });
    } catch (e) { throw this.dupe(e); }
    return (await this.rows({ id }))[0];
  }

  async setStatus(id: string, status: "active" | "disabled") {
    if (!(await this.prisma.planCoupon.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Discount not found.");
    await this.prisma.planCoupon.update({ where: { id }, data: { status: status.toUpperCase() as never } });
    return (await this.rows({ id }))[0];
  }

  /** Subscriptions already discounted by the code keep their price. */
  async remove(id: string) { await this.prisma.planCoupon.deleteMany({ where: { id } }); }

  private dupe(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return AppError.conflict("There is already a code with that name.", "COUPON_EXISTS");
    return e;
  }
}
