import { Injectable } from "@nestjs/common";
import { AppError } from "../common/errors";
import { toOrder, toProduct, toPublicStore } from "../common/serializers";
import { OrderEngine } from "../orders/order-engine.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PlaceOrderDto } from "./dto/store.dto";

const UNAVAILABLE = "This store isn't available right now.";

@Injectable()
export class StoreService {
  constructor(private readonly prisma: PrismaService, private readonly engine: OrderEngine, private readonly notifications: NotificationsService) {}

  /** Only businesses that are live (active or on trial) have a public store. */
  private async live(slug: string) {
    const biz = await this.prisma.business.findUnique({ where: { slug: slug.toLowerCase() }, include: { plan: { select: { themes: true } } } });
    if (!biz || (biz.status !== "ACTIVE" && biz.status !== "TRIAL")) throw AppError.notFound(UNAVAILABLE, "STORE_UNAVAILABLE");
    return biz;
  }

  async store(slug: string) {
    const biz = await this.live(slug);
    return toPublicStore(biz, biz.plan);
  }

  /** Draft products are hidden; sold-out products stay visible but can't be bought. */
  async products(slug: string) {
    const biz = await this.live(slug);
    const rows = await this.prisma.forBusiness(biz.id).product.findMany({
      where: { status: { not: "DRAFT" } },
      include: { category: true, images: { orderBy: { position: "asc" } }, variants: { orderBy: { position: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toProduct);
  }

  /** The business's own categories that currently have something on sale, alphabetically, with their pictures. */
  async categories(slug: string) {
    const biz = await this.live(slug);
    const rows = await this.prisma.forBusiness(biz.id).category.findMany({ where: { products: { some: { status: { not: "DRAFT" } } } } });
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ name: c.name, ...(c.imageUrl ? { image: c.imageUrl } : {}) }));
  }

  async validateCoupon(slug: string, code: string, subtotal: number) {
    const biz = await this.live(slug);
    return this.engine.previewCoupon(biz.id, biz.currency, code, subtotal);
  }

  async placeOrder(slug: string, dto: PlaceOrderDto) {
    const biz = await this.live(slug);
    if (!biz.paymentMethods.includes(dto.paymentMethod)) throw AppError.badRequest("This store doesn't accept that payment method. Please choose another.", "PAYMENT_METHOD_UNAVAILABLE");
    // card is only "paid" once a payment provider confirms it; until one is connected that is a demo switch
    const paid = dto.paymentMethod === "card" && this.engine.demoCardPayments;
    const order = await this.engine.inTenantTransaction(biz.id, (tx) =>
      this.engine.createOrder(tx, {
        source: "store", businessId: biz.id, items: dto.items,
        customer: { name: dto.customer.name, email: dto.customer.email, phone: dto.customer.phone },
        channel: "ONLINE", paymentMethod: dto.paymentMethod.toUpperCase() as never,
        status: "PENDING", paymentStatus: paid ? "PAID" : "UNPAID",
        couponCode: dto.couponCode, shippingAddress: dto.shippingAddress, notes: dto.notes,
      }),
    );
    // tell the team (never holds up or fails the shopper's order)
    void this.notifications.newOrder(biz.id, order, biz.currency);
    void this.notifications.stockAlerts(biz.id, order.items);
    return toOrder(order, { publicToken: true });
  }

  /** The confirmation and invoice pages: found by an unguessable token, not the order id. */
  async orderByToken(token: string) {
    const order = await this.prisma.order.findUnique({ where: { publicToken: token }, include: { items: true, business: { include: { plan: { select: { themes: true } } } } } });
    if (!order) throw AppError.notFound("Order not found.");
    return { order: toOrder(order, { publicToken: true }), store: toPublicStore(order.business, order.business.plan) };
  }
}
