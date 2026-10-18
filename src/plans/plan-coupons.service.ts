import { Injectable } from "@nestjs/common";
import { Plan, Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { PrismaService } from "../prisma/prisma.service";

type Tx = Prisma.TransactionClient | PrismaService;

export interface PricedPlan {
  /** What the business pays per period (USD), net of the discount. */
  amount: Prisma.Decimal;
  discount: Prisma.Decimal | null;
  planCouponId: string | null;
}

@Injectable()
export class PlanCouponsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Validates a code for a plan in the order the UI documents, and returns the coupon. */
  async check(db: Tx, code: string, plan: Plan, businessId?: string) {
    const c = await db.planCoupon.findUnique({
      where: { code: code.trim().toUpperCase() },
      include: { plans: true, _count: { select: { redemptions: true } } },
    });
    const bad = (m: string, k = "COUPON_INVALID") => AppError.badRequest(m, k);
    if (!c || c.status !== "ACTIVE") throw bad("That discount code isn't valid.");
    if (c.expiresAt && c.expiresAt.getTime() < Date.now()) throw bad("That discount code has expired.", "COUPON_EXPIRED");
    if (c.maxUses != null && c._count.redemptions >= c.maxUses) throw bad("That discount code has been fully used.", "COUPON_USED_UP");
    if (c.businessId && c.businessId !== businessId) throw bad("That discount code isn't valid for this business.");
    if (c.plans.length && !c.plans.some((p) => p.planId === plan.id)) {
      const names = await db.plan.findMany({ where: { id: { in: c.plans.map((p) => p.planId) } }, select: { name: true } });
      throw bad(`That code only works on the ${names.map((n) => n.name).join(", ")} plan.`, "COUPON_WRONG_PLAN");
    }
    if (plan.priceMonthly.equals(0)) throw bad("Discount codes only apply to paid plans.", "COUPON_FREE_PLAN");
    return c;
  }

  /** The list price for the cycle, minus the code's discount (never more than the price), rounded to cents. */
  async price(db: Tx, plan: Plan, cycle: "MONTHLY" | "YEARLY", code?: string, businessId?: string): Promise<PricedPlan> {
    const list = cycle === "YEARLY" ? plan.priceYearly : plan.priceMonthly;
    if (!code?.trim()) return { amount: list, discount: null, planCouponId: null };
    const c = await this.check(db, code, plan, businessId);
    const raw = c.type === "PERCENT" ? list.mul(c.value).div(100) : c.value;
    const discount = Prisma.Decimal.min(raw, list).toDecimalPlaces(2);
    return { amount: list.sub(discount).toDecimalPlaces(2), discount, planCouponId: c.id };
  }

  /** One redemption per business per code, so changing billing cycle never uses a second one. */
  async redeem(db: Tx, planCouponId: string, businessId: string) {
    await db.planCouponRedemption.upsert({
      where: { planCouponId_businessId: { planCouponId, businessId } },
      create: { planCouponId, businessId },
      update: {},
    });
  }
}
