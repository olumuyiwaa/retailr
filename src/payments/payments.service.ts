import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Business, BillingCycle, Invoice, Plan, Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import { AppError } from "../common/errors";
import { PER_USD } from "../common/money";
import { toInvoice } from "../common/serializers";
import { MailService } from "../mail/mail.service";
import { money, paymentFailedMail, subscriptionPaidMail } from "../mail/templates";
import { PlanCouponsService } from "../plans/plan-coupons.service";
import { PrismaService } from "../prisma/prisma.service";
import { PAYMENT_PROVIDER, PaymentProvider, VerifiedCharge } from "./payment.provider";

const D = (n: Prisma.Decimal.Value) => new Prisma.Decimal(n);
const minor = (d: Prisma.Decimal) => d.mul(100).toDecimalPlaces(0).toNumber();

/** One calendar month or year after `from`, clamping the day (31 Jan + 1 month = 28/29 Feb). */
export function addPeriod(from: Date, cycle: BillingCycle): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (cycle === "YEARLY" ? 12 : 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export type CheckoutResult = { reference: string; checkoutUrl?: string; invoice: ReturnType<typeof toInvoice>; charge: { amount: number; currency: string }; applied: boolean };

/** Everything that turns a payment into a subscription: checkout, confirmation, renewal charges. */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger("Payments");

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly coupons: PlanCouponsService,
    @Optional() @Inject(PAYMENT_PROVIDER) readonly provider: PaymentProvider | null,
  ) {}

  get enabled() { return !!this.provider; }

  // ---------- pricing ----------

  /** What to charge in the business's own currency: the plan's hand-set local price if there is one, scaled by any discount; otherwise the USD price converted at the demo rates. */
  chargeFor(plan: Plan, cycle: BillingCycle, currency: string, listUsd: Prisma.Decimal, netUsd: Prisma.Decimal) {
    const local = (plan.localPrices as Record<string, { monthly: number; yearly: number }> | null)?.[currency];
    const key = cycle === "YEARLY" ? "yearly" : "monthly";
    const ratio = listUsd.isZero() ? D(0) : netUsd.div(listUsd);
    const base = local ? D(local[key]) : listUsd.mul(PER_USD[currency] ?? 1);
    return { amount: base.mul(ratio).toDecimalPlaces(2), currency };
  }

  // ---------- starting a payment ----------

  async checkout(businessId: string, planId: string, cycleIn: "monthly" | "yearly", couponCode?: string): Promise<CheckoutResult> {
    if (!this.provider) throw AppError.badRequest("Online payments aren't switched on yet.", "PAYMENTS_OFF");
    const cycle: BillingCycle = cycleIn === "yearly" ? "YEARLY" : "MONTHLY";
    const plan = await this.prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) throw AppError.badRequest("Could not change plan.", "PLAN_CHANGE_FAILED");
    if (plan.priceMonthly.equals(0)) throw AppError.badRequest("That plan is free, so there's nothing to pay.", "PLAN_FREE");
    const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    const priced = await this.coupons.price(this.prisma, plan, cycle, couponCode?.trim() || undefined, businessId);
    const list = cycle === "YEARLY" ? plan.priceYearly : plan.priceMonthly;
    const charge = this.chargeFor(plan, cycle, biz.currency, list, priced.amount);
    const description = `${plan.name} plan (${cycle.toLowerCase()})`;
    const base = { businessId, planId: plan.id, description, amount: priced.amount, cycle, planCouponId: priced.planCouponId, discount: priced.discount, chargeAmount: charge.amount, chargeCurrency: charge.currency };

    if (charge.amount.lte(0)) {
      // a 100% discount: nothing to collect, so switch now (and renew for free)
      const inv = await this.prisma.invoice.create({ data: { ...base, status: "PAID", paidAt: new Date() } });
      await this.prisma.$transaction((tx) => this.applyCheckout(tx, inv, undefined));
      return { reference: "", invoice: toInvoice(inv), charge: { amount: 0, currency: charge.currency }, applied: true };
    }

    const reference = `rtl_${randomBytes(12).toString("hex")}`;
    const inv = await this.prisma.invoice.create({ data: { ...base, status: "PENDING", providerReference: reference, kind: "CHECKOUT" } });
    try {
      const { authorizationUrl } = await this.provider.initialize({
        reference, email: biz.ownerEmail, amount: minor(charge.amount), currency: charge.currency,
        callbackUrl: `${this.mail.appUrl}/admin/business/billing?reference=${reference}`, metadata: { businessId, invoiceId: inv.id },
      });
      return { reference, checkoutUrl: authorizationUrl, invoice: toInvoice(inv), charge: { amount: charge.amount.toNumber(), currency: charge.currency }, applied: false };
    } catch (e) {
      this.log.error(`initialize failed for ${reference}: ${(e as Error).message}`);
      await this.prisma.invoice.update({ where: { id: inv.id }, data: { status: "FAILED" } });
      throw new AppError(502, "PAYMENT_PROVIDER_ERROR", "We couldn't start the payment. Please try again.");
    }
  }

  // ---------- confirming a payment ----------

  /** Used by the page the customer returns to, and by webhooks: asks the provider what happened, then applies it once. */
  async confirm(reference: string, onlyBusinessId?: string): Promise<{ status: "paid" | "failed" | "pending"; applied: boolean }> {
    if (!this.provider) throw AppError.badRequest("Online payments aren't switched on yet.", "PAYMENTS_OFF");
    const inv = await this.prisma.invoice.findUnique({ where: { providerReference: reference } });
    if (!inv || (onlyBusinessId && inv.businessId !== onlyBusinessId)) throw AppError.notFound("Payment not found.");
    if (inv.status === "PAID") return { status: "paid", applied: false };
    const v = await this.provider.verify(reference).catch((e) => { this.log.warn(`verify ${reference}: ${(e as Error).message}`); return null; });
    if (!v) return { status: "pending", applied: false };
    return this.settle(reference, v);
  }

  /** Records the outcome of a payment exactly once, however many times it's reported (webhook, return page, renewal response). */
  async settle(reference: string, v: VerifiedCharge): Promise<{ status: "paid" | "failed" | "pending"; applied: boolean }> {
    if (v.status === "pending") return { status: "pending", applied: false };
    let paidInvoice: Invoice | null = null;
    const out = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "providerReference" = ${reference} FOR UPDATE`;
      if (!rows.length) return { status: "failed" as const, applied: false };
      const inv = await tx.invoice.findUniqueOrThrow({ where: { id: rows[0].id } });
      if (inv.status === "PAID") return { status: "paid" as const, applied: false };
      if (v.status === "failed") {
        await tx.invoice.update({ where: { id: inv.id }, data: { status: "FAILED" } });
        return { status: "failed" as const, applied: false };
      }
      // success: it has to be for what we asked for
      if (v.amount !== minor(inv.chargeAmount ?? D(0)) || v.currency.toUpperCase() !== (inv.chargeCurrency ?? "").toUpperCase()) {
        this.log.error(`payment ${reference} amount mismatch: got ${v.amount} ${v.currency}, expected ${inv.chargeAmount} ${inv.chargeCurrency}`);
        await tx.invoice.update({ where: { id: inv.id }, data: { status: "FAILED" } });
        return { status: "failed" as const, applied: false };
      }
      const paid = await tx.invoice.update({ where: { id: inv.id }, data: { status: "PAID", paidAt: new Date() } });
      if (inv.kind === "RENEWAL") await this.applyRenewal(tx, paid);
      else await this.applyCheckout(tx, paid, v.authorizationCode);
      paidInvoice = paid;
      return { status: "paid" as const, applied: true };
    });
    if (paidInvoice) await this.sendPaidMail(paidInvoice);
    return out;
  }

  /** A first payment (or plan change): the subscription becomes this plan, paid up for one period, with the card kept for renewals. */
  private async applyCheckout(tx: Prisma.TransactionClient, inv: Invoice, authorizationCode?: string) {
    const biz = await tx.business.findUniqueOrThrow({ where: { id: inv.businessId } });
    const cycle = inv.cycle ?? "MONTHLY";
    await tx.subscription.update({
      where: { businessId: inv.businessId },
      data: {
        planId: inv.planId, cycle, amount: inv.amount, planCouponId: inv.planCouponId, discount: inv.discount,
        status: "ACTIVE", trialEndsAt: null, cancelledAt: null, currentPeriodEnd: addPeriod(new Date(), cycle),
        ...(authorizationCode ? { providerAuthorization: authorizationCode } : {}),
      },
    });
    const lifts = biz.status === "SUSPENDED" && biz.suspensionReason === "NON_PAYMENT"; // paying fixes a billing suspension, never an admin one
    await tx.business.update({
      where: { id: biz.id },
      data: { planId: inv.planId, ...(biz.status === "TRIAL" || lifts ? { status: "ACTIVE" } : {}), ...(lifts ? { suspensionReason: null } : {}) },
    });
    if (inv.planCouponId) await this.coupons.redeem(tx, inv.planCouponId, inv.businessId);
  }

  /** A renewal succeeded: the next period starts where the last one ended. */
  private async applyRenewal(tx: Prisma.TransactionClient, inv: Invoice) {
    const sub = await tx.subscription.findUniqueOrThrow({ where: { businessId: inv.businessId } });
    const biz = await tx.business.findUniqueOrThrow({ where: { id: inv.businessId } });
    // keep the schedule even if we're catching up after a late payment
    let end = addPeriod(sub.currentPeriodEnd, sub.cycle);
    while (end.getTime() <= Date.now()) end = addPeriod(end, sub.cycle);
    await tx.subscription.update({ where: { businessId: inv.businessId }, data: { status: "ACTIVE", currentPeriodEnd: end } });
    if (biz.status === "SUSPENDED" && biz.suspensionReason === "NON_PAYMENT") await tx.business.update({ where: { id: biz.id }, data: { status: "ACTIVE", suspensionReason: null } });
  }

  private async sendPaidMail(inv: Invoice) {
    const [biz, sub, plan] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: inv.businessId } }),
      this.prisma.subscription.findUnique({ where: { businessId: inv.businessId } }),
      this.prisma.plan.findUnique({ where: { id: inv.planId } }),
    ]);
    if (!biz || !sub || !plan) return;
    await this.mail.trySend(subscriptionPaidMail(biz.ownerEmail, {
      name: biz.ownerName, business: biz.name, plan: plan.name,
      amount: money(Number(inv.chargeAmount ?? inv.amount), inv.chargeCurrency ?? "USD"), nextDate: sub.currentPeriodEnd.toISOString().slice(0, 10),
    }));
  }

  // ---------- renewals ----------

  /**
   * Charges the saved card for the period that just ended. The reference is derived from the subscription, period and attempt
   * number, so two servers running this at once create the same invoice, and the second one's insert is refused.
   */
  async renew(subId: string): Promise<"paid" | "failed" | "pending" | "skipped"> {
    if (!this.provider) return "skipped";
    const sub = await this.prisma.subscription.findUnique({ where: { id: subId }, include: { business: true, plan: true } });
    if (!sub || !sub.providerAuthorization) return "skipped";
    const period = sub.currentPeriodEnd.toISOString();
    const attempt = (await this.prisma.invoice.count({ where: { businessId: sub.businessId, kind: "RENEWAL", status: "FAILED", providerReference: { startsWith: `renew_${sub.id}_${period}_` } } })) + 1;
    const reference = `renew_${sub.id}_${period}_${attempt}`;
    const list = sub.cycle === "YEARLY" ? sub.plan.priceYearly : sub.plan.priceMonthly;
    const charge = this.chargeFor(sub.plan, sub.cycle, sub.business.currency, list, sub.amount);
    let inv: Invoice;
    try {
      inv = await this.prisma.invoice.create({ data: {
        businessId: sub.businessId, planId: sub.planId, description: `${sub.plan.name} plan (${sub.cycle.toLowerCase()}) renewal`, amount: sub.amount, status: "PENDING",
        providerReference: reference, kind: "RENEWAL", attempt, cycle: sub.cycle, planCouponId: sub.planCouponId, discount: sub.discount, chargeAmount: charge.amount, chargeCurrency: charge.currency,
      } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "skipped"; // another worker has this attempt
      throw e;
    }
    let result: VerifiedCharge;
    try {
      result = await this.provider.chargeAuthorization({ authorizationCode: sub.providerAuthorization, email: sub.business.ownerEmail, amount: minor(charge.amount), currency: charge.currency, reference });
    } catch (e) {
      this.log.warn(`charge ${reference}: ${(e as Error).message}`);
      result = { status: "failed", amount: 0, currency: charge.currency };
    }
    const settled = await this.settle(reference, result);
    if (settled.status === "failed") await this.markPastDue(sub.id, sub.business);
    return settled.status;
  }

  /** The period ended and nothing was collected: PAST_DUE, and the owner is told. */
  async markPastDue(subId: string, business: Business) {
    const sub = await this.prisma.subscription.findUniqueOrThrow({ where: { id: subId }, include: { plan: true } });
    const moved = await this.prisma.subscription.updateMany({ where: { id: subId, status: { in: ["ACTIVE", "TRIALING"] } }, data: { status: "PAST_DUE" } });
    if (moved.count) await this.mail.trySend(paymentFailedMail(business.ownerEmail, { name: business.ownerName, business: business.name, plan: sub.plan.name, link: `${this.mail.appUrl}/admin/business/billing` }));
  }

  get dunningGraceDays() { return this.config.get<number>("DUNNING_GRACE_DAYS") ?? 7; }
}
