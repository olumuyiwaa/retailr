import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { toCustomer, toGroup } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { GroupDto } from "./dto/business.dto";

const DAY = 86_400_000;
const RULES = ["spent_over", "orders_at_least", "joined_within_days", "no_order_within_days"] as const;

/** Which customers a group holds: stored members for manual groups, a rule evaluated now for auto groups. */
export function membersWhere(g: { id: string; kind: string; ruleType: string | null; ruleValue: Prisma.Decimal | null }, now = Date.now()): Prisma.CustomerWhereInput {
  if (g.kind === "MANUAL") return { groupMembers: { some: { groupId: g.id } } };
  const v = Number(g.ruleValue ?? 0);
  const cutoff = new Date(now - v * DAY);
  switch (g.ruleType) {
    case "SPENT_OVER": return { totalSpent: { gt: v } };
    case "ORDERS_AT_LEAST": return { ordersCount: { gte: v } };
    case "JOINED_WITHIN_DAYS": return { createdAt: { gte: cutoff } };
    // last order older than the cutoff, or never ordered and joined longer ago than the cutoff
    case "NO_ORDER_WITHIN_DAYS": return { AND: [{ orders: { none: { placedAt: { gte: cutoff } } } }, { OR: [{ orders: { some: {} } }, { createdAt: { lt: cutoff } }] }] };
    default: return { id: "__none__" };
  }
}

@Injectable()
export class GroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(businessId: string) {
    const db = this.prisma.forBusiness(businessId);
    const groups = await db.customerGroup.findMany({ orderBy: { createdAt: "asc" }, include: { members: { select: { customerId: true } } } });
    return Promise.all(groups.map(async (g) => toGroup(g, await db.customer.count({ where: membersWhere(g) }))));
  }

  async members(businessId: string, id: string) {
    const db = this.prisma.forBusiness(businessId);
    const g = await db.customerGroup.findUnique({ where: { id } });
    if (!g) throw AppError.notFound("Group not found.");
    return (await db.customer.findMany({ where: membersWhere(g), orderBy: { createdAt: "desc" } })).map(toCustomer);
  }

  private async clean(businessId: string, dto: GroupDto, id: string | null) {
    const db = this.prisma.forBusiness(businessId);
    const name = String(dto.name ?? "").trim();
    if (!name) throw AppError.badRequest("Give the group a name.");
    const clash = await db.customerGroup.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
    if (clash) throw AppError.conflict("You already have a group with that name.", "GROUP_EXISTS");
    let rule: { ruleType: never; ruleValue: number } | null = null;
    if (dto.kind === "auto") {
      const v = Number(dto.rule?.value);
      if (!dto.rule || !(RULES as readonly string[]).includes(dto.rule.type) || dto.rule.value === null || dto.rule.value === "" || !Number.isFinite(v) || v < 0) {
        throw AppError.badRequest("Enter a valid number for the rule.");
      }
      rule = { ruleType: dto.rule.type.toUpperCase() as never, ruleValue: v };
    }
    // only this business's own customers can be members
    const wanted = dto.kind === "manual" ? [...new Set((dto.memberIds ?? []).filter((m) => typeof m === "string"))] : [];
    const valid = wanted.length ? (await db.customer.findMany({ where: { id: { in: wanted } }, select: { id: true } })).map((c) => c.id) : [];
    return {
      name, description: dto.description?.trim() || null, kind: dto.kind.toUpperCase() as "MANUAL" | "AUTO",
      ruleType: rule?.ruleType ?? null, ruleValue: rule?.ruleValue ?? null, memberIds: valid,
    };
  }

  async create(businessId: string, dto: GroupDto) {
    const { memberIds, ...data } = await this.clean(businessId, dto, null);
    try {
      const g = await this.prisma.forBusiness(businessId).customerGroup.create({
        data: { ...data, members: { create: memberIds.map((customerId) => ({ customerId })) } } as never,
        include: { members: { select: { customerId: true } } },
      });
      return toGroup(g);
    } catch (e) { throw this.dupe(e); }
  }

  async update(businessId: string, id: string, dto: GroupDto) {
    const db = this.prisma.forBusiness(businessId);
    if (!(await db.customerGroup.findUnique({ where: { id }, select: { id: true } }))) throw AppError.notFound("Group not found.");
    const { memberIds, ...data } = await this.clean(businessId, dto, id);
    try {
      const g = await db.customerGroup.update({
        where: { id },
        data: { ...data, members: { deleteMany: {}, create: memberIds.map((customerId) => ({ customerId })) } } as never,
        include: { members: { select: { customerId: true } } },
      });
      return toGroup(g);
    } catch (e) { throw this.dupe(e); }
  }

  async remove(businessId: string, id: string) {
    await this.prisma.forBusiness(businessId).customerGroup.deleteMany({ where: { id } });
  }

  /** Names of the groups a customer is in (used by the customer detail). */
  async namesFor(businessId: string, customerId: string): Promise<string[]> {
    const db = this.prisma.forBusiness(businessId);
    const groups = await db.customerGroup.findMany({ orderBy: { createdAt: "asc" } });
    const hits = await Promise.all(groups.map(async (g) => ((await db.customer.count({ where: { AND: [{ id: customerId }, membersWhere(g)] } })) ? g.name : null)));
    return hits.filter((n): n is string => !!n);
  }

  private dupe(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return AppError.conflict("You already have a group with that name.", "GROUP_EXISTS");
    return e;
  }
}
