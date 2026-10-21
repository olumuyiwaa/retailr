import { Injectable } from "@nestjs/common";
import { toCustomer, toOrder, toProduct } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";

export const SEARCH_PER_TYPE = 5;

/** One box over the whole business: orders, customers and products/services. */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(businessId: string, raw: string) {
    const q = raw.trim().slice(0, 80);
    if (q.length < 2) return { q, orders: [], customers: [], products: [] };
    const db = this.prisma.forBusiness(businessId);
    const has = { contains: q, mode: "insensitive" as const };
    const [orders, customers, products] = await Promise.all([
      db.order.findMany({
        where: { OR: [{ number: has }, { customerName: has }, { customerEmail: has }, { customerPhone: { contains: q } }] },
        include: { items: true }, orderBy: { placedAt: "desc" }, take: SEARCH_PER_TYPE,
      }),
      db.customer.findMany({
        where: { OR: [{ name: has }, { email: has }, { phone: { contains: q } }, { city: has }] },
        orderBy: { createdAt: "desc" }, take: SEARCH_PER_TYPE,
      }),
      db.product.findMany({
        where: { OR: [{ name: has }, { sku: has }] },
        include: { category: true, images: { orderBy: { position: "asc" }, take: 1 } }, orderBy: { createdAt: "desc" }, take: SEARCH_PER_TYPE,
      }),
    ]);
    return { q, orders: orders.map((o) => toOrder(o)), customers: customers.map(toCustomer), products: products.map(toProduct) };
  }
}
