import { Injectable } from "@nestjs/common";
import { AppError } from "../common/errors";
import { toMessage } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { AudienceDto, SendMessageDto } from "./dto/business.dto";
import { membersWhere } from "./groups.service";

type Channel = "email" | "sms" | "whatsapp";
const reachable = (c: { email: string | null; phone: string }, channel: Channel) =>
  channel === "email" ? /^\S+@\S+\.\S+$/.test(c.email ?? "") : c.phone.replace(/\D/g, "").length >= 7;

@Injectable()
export class MessagesService {
  constructor(private readonly prisma: PrismaService) {}

  private async audience(businessId: string, audience: AudienceDto, channel: Channel) {
    const db = this.prisma.forBusiness(businessId);
    let where = {};
    let label = "All customers";
    if (audience.type === "group") {
      const g = audience.groupId ? await db.customerGroup.findUnique({ where: { id: audience.groupId } }) : null;
      if (!g) throw AppError.badRequest("That group no longer exists.");
      where = membersWhere(g);
      label = g.name;
    }
    const pool = await db.customer.findMany({ where, select: { name: true, email: true, phone: true }, orderBy: { createdAt: "asc" } });
    return { label, total: pool.length, recipients: pool.filter((c) => reachable(c, channel)) };
  }

  /** How many customers a message would reach; customers without an email (or phone) are skipped. */
  async preview(businessId: string, q: { type: "all" | "group"; groupId?: string; channel: Channel }) {
    const a = await this.audience(businessId, q, q.channel);
    return { count: a.recipients.length, skipped: a.total - a.recipients.length, label: a.label, sampleName: a.recipients[0]?.name.split(" ")[0] };
  }

  async list(businessId: string) {
    return (await this.prisma.forBusiness(businessId).message.findMany({ orderBy: { sentAt: "desc" }, take: 200 })).map(toMessage);
  }

  async send(businessId: string, dto: SendMessageDto) {
    const body = String(dto.body ?? "").trim();
    if (!body) throw AppError.badRequest("Write a message first.");
    if (dto.channel === "email" && !dto.subject?.trim()) throw AppError.badRequest("Add a subject for the email.");
    if (dto.channel === "sms" && body.length > 480) throw AppError.badRequest("SMS messages are limited to 480 characters.");
    const a = await this.audience(businessId, dto.audience, dto.channel);
    if (a.recipients.length === 0) throw AppError.badRequest("No customers in this audience can be reached on that channel.");
    // TODO: queue delivery per recipient once an email/SMS provider is connected, filling {{first_name}} and {{store}}.
    // For now the message is recorded as sent.
    const m = await this.prisma.forBusiness(businessId).message.create({
      data: { channel: dto.channel.toUpperCase() as never, subject: dto.channel === "email" ? dto.subject!.trim() : null, body, audienceLabel: a.label, recipientCount: a.recipients.length } as never,
    });
    return toMessage(m);
  }
}
