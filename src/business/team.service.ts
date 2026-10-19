import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { AppError } from "../common/errors";
import { toTeamMember } from "../common/serializers";
import { MailService } from "../mail/mail.service";
import { teamInviteMail } from "../mail/templates";
import { PrismaService } from "../prisma/prisma.service";
import { InviteDto } from "./dto/business.dto";

const INVITE_DAYS = 7;

@Injectable()
export class TeamService {
  constructor(private readonly prisma: PrismaService, private readonly mail: MailService) {}

  /** A fresh one-time token (only its hash is stored) and the moment it stops working. */
  private newToken() {
    const token = randomBytes(32).toString("hex");
    return { token, hash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) };
  }

  private async sendInvite(businessId: string, member: { name: string; email: string; role: string }, token: string, inviterUserId: string) {
    const [biz, inviter] = await Promise.all([
      this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true } }),
      this.prisma.user.findUnique({ where: { id: inviterUserId }, select: { name: true } }),
    ]);
    await this.mail.trySend(teamInviteMail(member.email, {
      name: member.name, business: biz.name, inviter: inviter?.name ?? "A teammate", role: member.role.toLowerCase(), days: INVITE_DAYS,
      link: `${this.mail.appUrl}/admin/accept-invite?token=${token}`,
    }));
  }

  async list(businessId: string) {
    return (await this.prisma.forBusiness(businessId).teamMember.findMany({ orderBy: { createdAt: "asc" } })).map(toTeamMember);
  }

  async invite(businessId: string, dto: InviteDto, inviterUserId: string) {
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
    // The raw token only ever goes in the invite email; the database keeps its hash.
    const t = this.newToken();
    try {
      const m = await db.teamMember.create({
        data: { name: dto.name.trim(), email, role: dto.role.toUpperCase() as never, status: "INVITED", inviteTokenHash: t.hash, inviteExpiresAt: t.expiresAt } as never,
      });
      await this.sendInvite(businessId, m, t.token, inviterUserId);
      return toTeamMember(m);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw AppError.conflict("That person is already on your team.", "TEAM_MEMBER_EXISTS");
      throw e;
    }
  }

  /** A new link (the old one stops working) for someone who hasn't accepted yet. */
  async resend(businessId: string, id: string, inviterUserId: string) {
    const db = this.prisma.forBusiness(businessId);
    const m = await db.teamMember.findUnique({ where: { id } });
    if (!m) throw AppError.notFound("Team member not found.");
    if (m.status !== "INVITED") throw AppError.badRequest("That person has already joined.", "ALREADY_JOINED");
    const t = this.newToken();
    await db.teamMember.update({ where: { id }, data: { inviteTokenHash: t.hash, inviteExpiresAt: t.expiresAt } });
    await this.sendInvite(businessId, m, t.token, inviterUserId);
    return toTeamMember(m);
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
