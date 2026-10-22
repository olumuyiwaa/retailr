import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../audit/audit.service";
import { MailService } from "../mail/mail.service";
import { trialEndingMail } from "../mail/templates";
import { addPeriod, PaymentsService } from "../payments/payments.service";
import { MessagesService } from "../business/messages.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";

const HOUR = 3_600_000, DAY = 86_400_000;

/**
 * Background work. Every step is safe to run twice or on two servers at once (updates are guarded, charge references are
 * derived from the subscription and period), so it needs no leader election: set JOBS_ENABLED=false on instances that
 * shouldn't run it, or just let them all run.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Jobs");
  private timer?: NodeJS.Timeout;
  private lastNightly = "";

  constructor(private readonly prisma: PrismaService, private readonly payments: PaymentsService, private readonly mail: MailService, private readonly config: ConfigService, private readonly audit: AuditService, private readonly notifications: NotificationsService, private readonly messages: MessagesService) {}

  onModuleInit() {
    if ((this.config.get("JOBS_ENABLED") ?? "true") !== "true") return;
    this.timer = setInterval(() => void this.tick(), HOUR);
    this.timer.unref();
    setTimeout(() => void this.tick(), 30_000).unref(); // first pass shortly after boot
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** Hourly: billing. Once a day around 02:00 UTC: housekeeping. */
  async tick(now = new Date()) {
    try {
      await this.messages.processQueue(80);
      await this.billing(now);
      const day = now.toISOString().slice(0, 10);
      if (now.getUTCHours() === 2 && this.lastNightly !== day) { this.lastNightly = day; await this.nightly(now); }
    } catch (e) { this.log.error(`job run failed: ${(e as Error).stack ?? e}`); }
  }

  async billing(now = new Date()) {
    return {
      reminded: await this.trialReminders(now),
      expiredTrials: await this.expireTrials(now),
      stale: await this.resolveStalePayments(now),
      renewals: await this.renewals(now),
      abandoned: await this.expireAbandonedCheckouts(now),
    };
  }

  /** Three days before a trial ends, once. */
  async trialReminders(now = new Date()) {
    const subs = await this.prisma.subscription.findMany({
      where: { status: "TRIALING", trialReminderSentAt: null, trialEndsAt: { gt: now, lte: new Date(now.getTime() + 3 * DAY) }, business: { status: "TRIAL" } },
      include: { business: true },
    });
    let sent = 0;
    for (const s of subs) {
      const claimed = await this.prisma.subscription.updateMany({ where: { id: s.id, trialReminderSentAt: null }, data: { trialReminderSentAt: now } });
      if (!claimed.count) continue;
      const days = Math.max(1, Math.ceil((s.trialEndsAt!.getTime() - now.getTime()) / DAY));
      await this.mail.trySend(trialEndingMail(s.business.ownerEmail, { name: s.business.ownerName, business: s.business.name, days, link: `${this.mail.appUrl}/admin/business/billing` }));
      sent++;
    }
    return sent;
  }

  /** A trial that ended without a payment: past due, owner told. The store stays up for the grace period. */
  async expireTrials(now = new Date()) {
    const subs = await this.prisma.subscription.findMany({ where: { status: "TRIALING", trialEndsAt: { lte: now }, business: { status: "TRIAL" } }, include: { business: true } });
    for (const s of subs) await this.payments.markPastDue(s.id, s.business);
    return subs.length;
  }

  /** A renewal whose answer never came back (e.g. the customer had to confirm on their bank's page): ask the provider. */
  async resolveStalePayments(now = new Date()) {
    if (!this.payments.enabled) return 0;
    const stale = await this.prisma.invoice.findMany({ where: { kind: "RENEWAL", status: "PENDING", issuedAt: { lt: new Date(now.getTime() - HOUR) }, providerReference: { not: null } } });
    for (const i of stale) {
      let status = (await this.payments.confirm(i.providerReference!).catch(() => null))?.status ?? "pending";
      // a charge that is still undecided after a day (say, a bank that never completed 3-D Secure) counts as a failure, or it would block every retry
      if (status === "pending" && i.issuedAt.getTime() < now.getTime() - DAY) {
        const r = await this.prisma.invoice.updateMany({ where: { id: i.id, status: "PENDING" }, data: { status: "FAILED" } });
        if (r.count) status = "failed";
      }
      if (status === "failed") {
        const sub = await this.prisma.subscription.findUnique({ where: { businessId: i.businessId }, include: { business: true } });
        if (sub) await this.payments.markPastDue(sub.id, sub.business);
      }
    }
    return stale.length;
  }

  /** Subscriptions whose period has ended: charge the card, retry daily through the grace period, then suspend the store. */
  async renewals(now = new Date()) {
    const out = { paid: 0, failed: 0, pending: 0, free: 0, suspended: 0, pastDue: 0 };
    const due = await this.prisma.subscription.findMany({
      where: { status: { in: ["ACTIVE", "PAST_DUE"] }, cancelledAt: null, currentPeriodEnd: { lte: now }, plan: { priceMonthly: { gt: 0 } }, business: { status: { in: ["ACTIVE", "TRIAL"] } } },
      include: { business: true },
    });
    const grace = this.payments.dunningGraceDays * DAY;
    for (const s of due) {
      // fully discounted: nothing to collect, the period simply rolls on
      if (s.amount.isZero()) {
        let end = addPeriod(s.currentPeriodEnd, s.cycle);
        while (end.getTime() <= now.getTime()) end = addPeriod(end, s.cycle);
        await this.prisma.subscription.update({ where: { id: s.id }, data: { status: "ACTIVE", currentPeriodEnd: end } });
        out.free++;
        continue;
      }
      if (s.status === "PAST_DUE" && now.getTime() - s.currentPeriodEnd.getTime() > grace) {
        const r = await this.prisma.business.updateMany({ where: { id: s.businessId, status: { in: ["ACTIVE", "TRIAL"] } }, data: { status: "SUSPENDED", suspensionReason: "NON_PAYMENT" } });
        out.suspended += r.count;
        if (r.count) await this.audit.record({ action: "business.suspended_non_payment", actorRole: "SYSTEM", actorEmail: "system", businessId: s.businessId });
        continue;
      }
      if (!s.providerAuthorization || !this.payments.enabled) {
        if (s.status === "ACTIVE") { await this.payments.markPastDue(s.id, s.business); out.pastDue++; }
        continue;
      }
      if (s.status === "PAST_DUE") {
        const last = await this.prisma.invoice.findFirst({ where: { businessId: s.businessId, kind: "RENEWAL" }, orderBy: { issuedAt: "desc" } });
        if (last && now.getTime() - last.issuedAt.getTime() < DAY) continue; // retry once a day
      }
      const r = await this.payments.renew(s.id);
      if (r === "paid") out.paid++; else if (r === "failed") out.failed++; else if (r === "pending") out.pending++;
    }
    return out;
  }

  /** A checkout nobody finished: mark it failed so it doesn't linger as pending forever. */
  async expireAbandonedCheckouts(now = new Date()) {
    const r = await this.prisma.invoice.updateMany({ where: { kind: "CHECKOUT", status: "PENDING", issuedAt: { lt: new Date(now.getTime() - DAY) } }, data: { status: "FAILED" } });
    return r.count;
  }

  /** Daily housekeeping. */
  async nightly(now = new Date()) {
    const tokens = await this.prisma.refreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: new Date(now.getTime() - 30 * DAY) } }] } });
    const seen = await this.prisma.analyticsSeen.deleteMany({ where: { date: { lt: new Date(now.getTime() - 2 * DAY) } } });
    // safety net: customer totals recomputed from paid orders, fixing any drift
    const customers = await this.prisma.$executeRaw`
      UPDATE "Customer" c SET "ordersCount" = COALESCE(s.n, 0), "totalSpent" = COALESCE(s.t, 0)
      FROM (SELECT c2."id", COUNT(o."id")::int AS n, SUM(o."total") AS t FROM "Customer" c2 LEFT JOIN "Order" o ON o."customerId" = c2."id" AND o."paymentStatus" = 'PAID' GROUP BY c2."id") s
      WHERE s."id" = c."id" AND (c."ordersCount" <> COALESCE(s.n, 0) OR c."totalSpent" <> COALESCE(s.t, 0))`;
    const notifications = await this.notifications.prune(now);
    return { refreshTokens: tokens.count, analyticsSeen: seen.count, customersFixed: customers, notifications };
  }
}
