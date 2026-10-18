import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { AppError } from "../common/errors";
import { toTeamMember } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { InviteDto } from "./dto/business.dto";

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService) {}

  async list(businessId: string) {
    return (await this.prisma.forBusiness(businessId).teamMember.findMany({ orderBy: { createdAt: "asc" } })).map(toTeamMember);
  }

  async invite(businessId: string, dto: InviteDto) {
    const db = this.prisma.forBusiness(businessId);
    const email = dto.email.trim().toLowerCase();
    const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { plan: true } });
    const count = await db.teamMember.count();
    if (biz.plan.maxStaff !== -1 && count >= biz.plan.maxStaff) {
      throw AppError.forbidden(`Your ${biz.plan.name} plan allows ${biz.plan.maxStaff} team members. Upgrade to invite more.`, "PLAN_LIMIT_STAFF");
    }
    if (await db.teamMember.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } })) {
      throw AppError.conflict("That person is already on your team.", "TEAM_MEMBER_EXISTS");
    }
    // The raw token goes in the invite email (TODO: send it once an email provider is connected); only its hash is stored.
    const token = randomBytes(32).toString("hex");
    try {
      const m = await db.teamMember.create({
        data: { name: dto.name.trim(), email, role: dto.role.toUpperCase() as never, status: "INVITED", inviteTokenHash: createHash("sha256").update(token).digest("hex") } as never,
      });
      return toTeamMember(m);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw AppError.conflict("That person is already on your team.", "TEAM_MEMBER_EXISTS");
      throw e;
    }
  }

  async remove(businessId: string, id: string) {
    const db = this.prisma.forBusiness(businessId);
    const m = await db.teamMember.findUnique({ where: { id } });
    if (!m) throw AppError.notFound("Team member not found.");
    if (m.role === "OWNER") throw AppError.badRequest("The owner cannot be removed.", "OWNER_PROTECTED");
    await db.teamMember.delete({ where: { id } });
    // an accepted member also loses their login
    if (m.userId) await this.prisma.user.deleteMany({ where: { id: m.userId, businessId } });
  }
}
