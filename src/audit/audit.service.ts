import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export interface AuditEntry {
  action: string;
  actorRole: string;
  actorId?: string | null;
  actorEmail?: string | null;
  businessId?: string | null;
  targetId?: string | null;
  meta?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger("Audit");
  constructor(private readonly prisma: PrismaService) {}

  /** Best effort: a failure to write the log never fails the request it describes. */
  async record(e: AuditEntry) {
    try {
      const email = e.actorEmail ?? (e.actorId ? (await this.prisma.user.findUnique({ where: { id: e.actorId }, select: { email: true } }))?.email : null);
      await this.prisma.auditLog.create({ data: { action: e.action, actorRole: e.actorRole, actorId: e.actorId ?? null, actorEmail: email ?? null, businessId: e.businessId ?? null, targetId: e.targetId ?? null, meta: e.meta ?? Prisma.JsonNull } });
    } catch (err) { this.log.error(`could not write audit entry ${e.action}: ${(err as Error).message}`); }
  }

  async list(where: Prisma.AuditLogWhereInput, page: number, limit: number) {
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: [{ at: "desc" }, { id: "desc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, items: rows.map((r) => ({ id: r.id, at: r.at.toISOString(), action: r.action, actorRole: r.actorRole, actorEmail: r.actorEmail, businessId: r.businessId, targetId: r.targetId, meta: r.meta })) };
  }
}
