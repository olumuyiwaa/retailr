import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationType, Prisma, TeamRole } from "@prisma/client";
import * as webpush from "web-push";
import { AppError } from "../common/errors";
import { PrismaService } from "../prisma/prisma.service";

/** A product at or below this many units (after an order took it there) raises a low-stock alert. */
export const LOW_STOCK_AT = 5;
const KEEP_DAYS = 60;

export interface NotificationInput { type: NotificationType; title: string; body?: string; link?: string; businessId?: string }
export interface PushKeys { endpoint: string; p256dh: string; auth: string }
/** What goes to the browser's push service. Replaceable so tests don't need the network. */
export type PushSender = (sub: PushKeys, payload: string) => Promise<void>;

const SYMBOL: Record<string, string> = { NGN: "₦", GHS: "GH₵", KES: "KSh", USD: "$" };
export const money = (amount: number, currency: string) =>
  `${SYMBOL[currency] ?? ""}${amount.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;

/**
 * In-app notifications (one row per person) and browser push for them. Everything here is best effort:
 * a failure is logged and never reaches the request that caused the notification.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger("Notifications");
  readonly publicKey: string | null;
  private readonly enabled: boolean;
  /** Sends one push message; swap it out in tests. */
  sender: PushSender;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    const pub = config.get<string>("VAPID_PUBLIC_KEY"), priv = config.get<string>("VAPID_PRIVATE_KEY");
    this.enabled = !!pub && !!priv;
    this.publicKey = this.enabled ? pub! : null;
    if (this.enabled) {
      const subject = config.get<string>("VAPID_SUBJECT") || `mailto:${(config.get<string>("MAIL_FROM") ?? "").match(/<([^>]+)>/)?.[1] ?? "noreply@retailr.com"}`;
      webpush.setVapidDetails(subject, pub!, priv!);
    }
    this.sender = async (sub, payload) => {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 60 * 60 * 24 });
    };
  }

  get pushEnabled() { return this.enabled; }

  // ---------- creating notifications ----------

  /** Everyone on a business's team who can open the app (optionally only some roles). */
  async notifyBusiness(businessId: string, input: NotificationInput, roles?: TeamRole[]) {
    try {
      const members = await this.prisma.teamMember.findMany({
        where: { businessId, status: "ACTIVE", userId: { not: null }, ...(roles ? { role: { in: roles } } : {}) },
        select: { userId: true },
      });
      await this.deliver(members.map((m) => m.userId!), { ...input, businessId });
    } catch (e) { this.log.warn(`notify business failed: ${(e as Error).message}`); }
  }

  /** The platform's own admins. */
  async notifyPlatform(input: NotificationInput) {
    try {
      const admins = await this.prisma.user.findMany({ where: { role: "SUPER_ADMIN" }, select: { id: true } });
      await this.deliver(admins.map((a) => a.id), input);
    } catch (e) { this.log.warn(`notify platform failed: ${(e as Error).message}`); }
  }

  /** A shopper placed an order on the storefront. */
  async newOrder(businessId: string, order: { number: string; total: Prisma.Decimal | number; customerName: string }, currency: string) {
    await this.notifyBusiness(businessId, {
      type: "NEW_ORDER",
      title: `New order ${order.number}`,
      body: `${order.customerName} · ${money(Number(order.total), currency)}`,
      link: "/admin/business/orders",
    });
  }

  /**
   * After an order took `lines` out of stock: one alert when a product runs out and one when it first falls to the
   * low-stock level, for the owner and managers. Crossing the line is what triggers it, so it isn't repeated on every sale.
   */
  async stockAlerts(businessId: string, lines: { productId: string | null; qty: number }[]) {
    try {
      const taken = new Map<string, number>();
      for (const l of lines) if (l.productId) taken.set(l.productId, (taken.get(l.productId) ?? 0) + l.qty);
      if (!taken.size) return;
      const products = await this.prisma.product.findMany({ where: { id: { in: [...taken.keys()] }, businessId, kind: "PRODUCT" }, select: { id: true, name: true, stock: true } });
      for (const p of products) {
        const before = p.stock + (taken.get(p.id) ?? 0);
        if (p.stock <= 0 && before > 0) {
          await this.notifyBusiness(businessId, { type: "OUT_OF_STOCK", title: `${p.name} is sold out`, body: "Restock it to keep selling.", link: "/admin/business/products" }, ["OWNER", "MANAGER"]);
        } else if (p.stock > 0 && p.stock <= LOW_STOCK_AT && before > LOW_STOCK_AT) {
          await this.notifyBusiness(businessId, { type: "LOW_STOCK", title: `${p.name} is running low`, body: `Only ${p.stock} left in stock.`, link: "/admin/business/products" }, ["OWNER", "MANAGER"]);
        }
      }
    } catch (e) { this.log.warn(`stock alerts failed: ${(e as Error).message}`); }
  }

  private async deliver(userIds: string[], input: NotificationInput) {
    if (!userIds.length) return;
    await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, businessId: input.businessId ?? null, type: input.type, title: input.title, body: input.body ?? "", link: input.link ?? null })),
    });
    if (this.enabled) await this.push(userIds, input);
  }

  private async push(userIds: string[], input: NotificationInput) {
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId: { in: userIds } } });
    const payload = JSON.stringify({ title: input.title, body: input.body ?? "", link: input.link ?? "/admin", type: input.type });
    await Promise.all(subs.map(async (s) => {
      try {
        await this.sender(s, payload);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // the browser says this subscription is gone for good
        if (status === 404 || status === 410) await this.prisma.pushSubscription.deleteMany({ where: { id: s.id } });
        else this.log.warn(`push failed (${status ?? "no status"}): ${(e as Error).message}`);
      }
    }));
  }

  // ---------- reading them ----------

  async list(userId: string, opts: { limit?: number; unreadOnly?: boolean }) {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where: { userId, ...(opts.unreadOnly ? { readAt: null } : {}) }, orderBy: { createdAt: "desc" }, take: limit }),
      this.prisma.notification.count({ where: { userId, readAt: null } }),
    ]);
    return {
      unreadCount,
      items: rows.map((n) => ({ id: n.id, type: n.type.toLowerCase(), title: n.title, body: n.body, ...(n.link ? { link: n.link } : {}), read: !!n.readAt, createdAt: n.createdAt.toISOString() })),
    };
  }

  async markRead(userId: string, id: string) {
    const r = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (!r.count && !(await this.prisma.notification.findFirst({ where: { id, userId }, select: { id: true } }))) throw AppError.notFound("Notification not found.");
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  }

  // ---------- push subscriptions ----------

  async subscribe(userId: string, sub: PushKeys, userAgent?: string) {
    if (!this.enabled) throw AppError.badRequest("Push notifications aren't switched on for this server.", "PUSH_DISABLED");
    // the same browser may have been used by someone else before: the endpoint moves to whoever subscribes now
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, userAgent: userAgent?.slice(0, 200) ?? null },
      update: { userId, p256dh: sub.p256dh, auth: sub.auth, userAgent: userAgent?.slice(0, 200) ?? null },
    });
  }

  async unsubscribe(userId: string, endpoint: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  /** Old notifications are dropped after a couple of months. */
  async prune(now = new Date()) {
    return (await this.prisma.notification.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - KEEP_DAYS * 86_400_000) } } })).count;
  }
}
