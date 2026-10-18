import { Injectable } from "@nestjs/common";
import { AppError } from "../common/errors";
import { toInvoice, toPlan, toSubscription } from "../common/serializers";
import { PlanCouponsService } from "../plans/plan-coupons.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

const GB = 1024 ** 3;

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly coupons: PlanCouponsService) {}

  async get(businessId: string) {
    const db = this.prisma.forBusiness(businessId);
    const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { plan: true } });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [sub, invoices, plans, products, staff, orders, bytes] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { businessId }, include: { planCoupon: { select: { code: true } } } }),
      db.invoice.findMany({ orderBy: { issuedAt: "desc" } }),
      this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { priceMonthly: "asc" } }),
      db.product.count(), db.teamMember.count(), db.order.count({ where: { placedAt: { gte: monthStart } } }),
      this.storage.usageBytes(businessId),
    ]);
    const p = biz.plan;
    return {
      plan: toPlan(p),
      ...(sub ? { subscription: toSubscription(sub) } : {}),
      usage: {
        products: { used: products, limit: p.maxProducts },
        staff: { used: staff, limit: p.maxStaff },
        ordersThisMonth: { used: orders, limit: p.maxOrdersPerMonth },
        storageGb: { used: Math.round((bytes / GB) * 100) / 100, limit: p.maxStorageGb },
      },
      invoices: invoices.map(toInvoice),
      plans: plans.map(toPlan),
    };
  }

  /**
   * Moves the business to another plan and/or billing cycle. A bad code changes nothing. Without a code the discount is
   * dropped, except when only the cycle changes: then the existing code is kept if it still works.
   * TODO: when a payment provider is connected, charge the new amount here (or hand off to its checkout) before applying.
   */
  async changePlan(businessId: string, planId: string, cycleIn: "monthly" | "yearly", couponCode?: string) {
    const cycle = cycleIn === "yearly" ? "YEARLY" : "MONTHLY";
    await this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.findFirst({ where: { id: planId, isActive: true } });
      const sub = await tx.subscription.findUnique({ where: { businessId }, include: { planCoupon: true } });
      if (!plan || !sub) throw AppError.badRequest("Could not change plan.", "PLAN_CHANGE_FAILED");

      const free = plan.priceMonthly.equals(0);
      const entered = couponCode?.trim() || undefined;
      const carry = !entered && !free && sub.planId === plan.id ? sub.planCoupon?.code : undefined;
      let priced;
      try {
        priced = await this.coupons.price(tx, plan, cycle, entered ?? carry, businessId);
      } catch (e) {
        if (entered) throw e; // the person typed it: tell them why it failed
        priced = await this.coupons.price(tx, plan, cycle); // a carried code that no longer works is dropped quietly
      }

      // a trial that moves to a free plan has nothing left to trial
      const biz = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { status: true } });
      await tx.business.update({ where: { id: businessId }, data: { planId: plan.id, ...(free && biz.status === "TRIAL" ? { status: "ACTIVE" } : {}) } });
      await tx.subscription.update({
        where: { businessId },
        data: {
          planId: plan.id, cycle, amount: priced.amount, planCouponId: priced.planCouponId, discount: priced.discount,
          ...(free ? { status: "ACTIVE", trialEndsAt: null } : {}),
        },
      });
      if (priced.planCouponId) await this.coupons.redeem(tx, priced.planCouponId, businessId);
    });
    return this.get(businessId);
  }
}
