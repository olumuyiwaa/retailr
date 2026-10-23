import { Injectable } from "@nestjs/common";
import { AppError } from "../common/errors";
import { toInvoice, toPlan, toSubscription } from "../common/serializers";
import { PaymentsService } from "../payments/payments.service";
import { PlanCouponsService } from "../plans/plan-coupons.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";

const GB = 1024 ** 3;

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly coupons: PlanCouponsService, private readonly payments: PaymentsService) {}

  async get(businessId: string) {
    const db = this.prisma.forBusiness(businessId);
    const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { plan: true } });
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const [sub, invoices, plans, products, staff, orders, bytes, smsUsed] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { businessId }, include: { planCoupon: { select: { code: true } } } }),
      db.invoice.findMany({ orderBy: { issuedAt: "desc" } }),
      this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { priceMonthly: "asc" } }),
      Promise.all([db.product.count(), db.service.count()]).then(([a, b]) => a + b), db.teamMember.count(), db.order.count({ where: { placedAt: { gte: monthStart } } }),
      this.storage.usageBytes(businessId),
      this.prisma.messageJob.count({ where: { businessId, channel: "SMS", status: { in: ["PENDING", "SENT"] }, createdAt: { gte: monthStart } } }),
    ]);
    const p = biz.plan;
    return {
      plan: toPlan(p),
      ...(sub ? { subscription: toSubscription(sub) } : {}),
      /** Whether the page should send people through checkout to pay, and whether a card is saved for renewals. */
      payments: { enabled: this.payments.enabled, ...(await this.payments.selection().then((c) => ({ provider: c.default, providers: c.enabled }))), cardOnFile: !!sub?.providerAuthorization },
      usage: {
        products: { used: products, limit: p.maxProducts },
        staff: { used: staff, limit: p.maxStaff },
        ordersThisMonth: { used: orders, limit: p.maxOrdersPerMonth },
        storageGb: { used: Math.round((bytes / GB) * 100) / 100, limit: p.maxStorageGb },
        smsThisMonth: { used: smsUsed, limit: p.maxSmsPerMonth },
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
      if (this.payments.enabled && !free) throw new AppError(402, "PAYMENT_REQUIRED", "Complete payment to switch to this plan.");
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
          ...(free ? { status: "ACTIVE", trialEndsAt: null, providerAuthorization: null, provider: null } : {}), // a free plan stops card renewals
        },
      });
      if (priced.planCouponId) await this.coupons.redeem(tx, priced.planCouponId, businessId);
    });
    return this.get(businessId);
  }
}

