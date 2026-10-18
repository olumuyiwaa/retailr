import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { toCustomer, toOrder } from "../common/serializers";
import { GroupsService } from "../business/groups.service";
import { PrismaService } from "../prisma/prisma.service";
import { ListCustomersQuery, ListOrdersQuery, RecordSaleDto } from "./dto/orders.dto";
import { holdsStock, OrderEngine } from "./order-engine.service";

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService, private readonly engine: OrderEngine, private readonly groups: GroupsService) {}

  async list(businessId: string, q: ListOrdersQuery) {
    const where: Prisma.OrderWhereInput = {
      ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
      ...(q.paymentStatus ? { paymentStatus: q.paymentStatus.toUpperCase() as never } : {}),
      ...(q.channel ? { channel: q.channel.toUpperCase() as never } : {}),
      ...(q.from || q.to ? { placedAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      ...(q.q?.trim() ? { OR: [{ number: { contains: q.q.trim(), mode: "insensitive" } }, { customerName: { contains: q.q.trim(), mode: "insensitive" } }] } : {}),
    };
    const limit = q.limit ?? 100;
    const db = this.prisma.forBusiness(businessId);
    const [rows, total] = await Promise.all([
      db.order.findMany({ where, include: { items: true }, orderBy: { placedAt: "desc" }, skip: ((q.page ?? 1) - 1) * limit, take: limit }),
      db.order.count({ where }),
    ]);
    return { items: rows.map((o) => toOrder(o)), total };
  }

  async get(businessId: string, id: string) {
    const o = await this.prisma.forBusiness(businessId).order.findUnique({ where: { id }, include: { items: true } });
    if (!o) throw AppError.notFound("Order not found.");
    return toOrder(o);
  }

  /**
   * Moves an order to a new status. Cancelling or refunding gives the stock back (and moving it out of those
   * states takes it again, if there is enough), and the customer's totals are recomputed.
   */
  async setStatus(businessId: string, id: string, status: string) {
    const next = status.toUpperCase() as Prisma.OrderUpdateInput["status"] & string;
    const order = await this.engine.inTenantTransaction(businessId, async (tx) => {
      const o = await tx.order.findUnique({ where: { id }, include: { items: true } });
      if (!o) throw AppError.notFound("Order not found.");

      const had = holdsStock(o.status), will = holdsStock(next as never);
      if (had && !will) for (const i of o.items) if (i.productId) await this.engine.returnStock(tx, i.productId, i.variantId, i.qty);
      if (!had && will) for (const i of o.items) if (i.productId) await this.engine.takeStock(tx, i.productId, i.variantId ?? undefined, i.qty, i.name);

      let paymentStatus = o.paymentStatus;
      if (next === "REFUNDED") paymentStatus = "REFUNDED";
      else if (next === "CANCELLED") paymentStatus = "UNPAID";
      else if (paymentStatus === "UNPAID" && next !== "PENDING") paymentStatus = "PAID";

      const updated = await tx.order.update({ where: { id }, data: { status: next as never, paymentStatus }, include: { items: true } });
      if (o.customerId) await this.engine.recomputeCustomer(tx, o.customerId);
      return updated;
    });
    return toOrder(order);
  }

  async markReceiptSent(businessId: string, id: string) {
    const db = this.prisma.forBusiness(businessId);
    if (!(await db.order.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Order not found.");
    // TODO: queue the receipt email once an email provider is connected; for now this records that it was sent
    return toOrder(await db.order.update({ where: { id }, data: { receiptSentAt: new Date() }, include: { items: true } }));
  }

  /** A sale made outside the storefront (in person, WhatsApp, Instagram, phone...). */
  async recordSale(businessId: string, dto: RecordSaleDto) {
    const order = await this.engine.inTenantTransaction(businessId, (tx) =>
      this.engine.createOrder(tx, {
        source: "sale", businessId, items: dto.items,
        customer: dto.customerId ? { id: dto.customerId } : dto.newCustomer ?? null,
        channel: dto.channel.toUpperCase() as never, paymentMethod: dto.paymentMethod.toUpperCase() as never,
        status: dto.handedOver ? "DELIVERED" : "PROCESSING", paymentStatus: dto.paid ? "PAID" : "UNPAID",
        flatDiscount: dto.discount, notes: dto.notes,
      }),
    );
    return toOrder(order);
  }

  // ---------- customers ----------

  async customers(businessId: string, q: ListCustomersQuery) {
    const term = q.q?.trim();
    const where: Prisma.CustomerWhereInput = term
      ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }, { phone: { contains: term } }, { city: { contains: term, mode: "insensitive" } }] }
      : {};
    const limit = q.limit ?? 100;
    const db = this.prisma.forBusiness(businessId);
    const [rows, total] = await Promise.all([
      db.customer.findMany({ where, orderBy: { createdAt: "desc" }, skip: ((q.page ?? 1) - 1) * limit, take: limit }),
      db.customer.count({ where }),
    ]);
    return { items: rows.map(toCustomer), total };
  }

  async customerDetail(businessId: string, id: string) {
    const db = this.prisma.forBusiness(businessId);
    const customer = await db.customer.findUnique({ where: { id } });
    if (!customer) throw AppError.notFound("Customer not found.");
    const orders = await db.order.findMany({ where: { customerId: id }, include: { items: true }, orderBy: { placedAt: "desc" } });
    const paid = orders.filter((o) => o.paymentStatus === "PAID");
    return {
      customer: toCustomer(customer),
      orders: orders.map((o) => toOrder(o)),
      groups: await this.groups.namesFor(businessId, id),
      avgOrder: paid.length ? paid.reduce((n, o) => n + Number(o.total), 0) / paid.length : 0,
      ...(orders[0] ? { lastOrderAt: orders[0].placedAt.toISOString() } : {}),
      ...(orders.find((o) => o.shippingAddress) ? { address: orders.find((o) => o.shippingAddress)!.shippingAddress } : {}),
    };
  }
}
