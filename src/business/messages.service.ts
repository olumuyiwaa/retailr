import { Injectable, Logger } from "@nestjs/common";
import { AppError } from "../common/errors";
import { toMessage } from "../common/serializers";
import { MailService } from "../mail/mail.service";
import { customerMessageMail, fillTemplate } from "../mail/templates";
import { SmsService, normalizePhone } from "../sms/sms.service";
import { PrismaService } from "../prisma/prisma.service";
import { AudienceDto, SendMessageDto } from "./dto/business.dto";
import { membersWhere } from "./groups.service";

type Channel = "email" | "sms";
const reachable = (c: { email: string | null; phone: string }, channel: Channel) =>
  channel === "email" ? /^\S+@\S+\.\S+$/.test(c.email ?? "") : c.phone.replace(/\D/g, "").length >= 7;

const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

@Injectable()
export class MessagesService {
  private readonly log = new Logger("Messages");
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
  ) {}

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

  /** SMS credits used this calendar month (sent + still queued). */
  async smsUsage(businessId: string) {
    const biz = await this.prisma.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { plan: { select: { maxSmsPerMonth: true } } },
    });
    const limit = biz.plan.maxSmsPerMonth;
    const used = await this.prisma.messageJob.count({
      where: {
        businessId,
        channel: "SMS",
        status: { in: ["PENDING", "SENT"] },
        createdAt: { gte: monthStart() },
      },
    });
    return { used, limit, remaining: limit === -1 ? -1 : Math.max(0, limit - used) };
  }

  async preview(businessId: string, q: { type: "all" | "group"; groupId?: string; channel: Channel }) {
    const a = await this.audience(businessId, q, q.channel);
    const base = { count: a.recipients.length, skipped: a.total - a.recipients.length, label: a.label, sampleName: a.recipients[0]?.name.split(" ")[0] };
    if (q.channel !== "sms") return base;
    const credits = await this.smsUsage(businessId);
    return { ...base, sms: credits };
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

    if (dto.channel === "sms") {
      const credits = await this.smsUsage(businessId);
      if (credits.limit !== -1 && a.recipients.length > credits.remaining) {
        throw AppError.badRequest(
          credits.remaining <= 0
            ? "You've used this month's SMS credits. Upgrade your plan or wait until next month."
            : `This message needs ${a.recipients.length} SMS credits but you only have ${credits.remaining} left this month.`,
          "SMS_CREDITS_EXCEEDED",
        );
      }
    }

    const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true, country: true } });
    const subject = dto.channel === "email" ? dto.subject!.trim() : null;

    const jobs = a.recipients.map((r) => {
      const filled = fillTemplate(body, { first_name: r.name.split(" ")[0] || "there", store: biz.name });
      if (dto.channel === "email") {
        return {
          channel: "EMAIL" as const,
          toAddress: (r.email ?? "").trim(),
          recipientName: r.name,
          subject,
          body: filled,
        };
      }
      const phone = normalizePhone(r.phone, biz.country);
      return {
        channel: "SMS" as const,
        toAddress: phone ?? r.phone.replace(/\D/g, ""),
        recipientName: r.name,
        subject: null as string | null,
        body: filled,
      };
    }).filter((j) => j.toAddress);

    if (!jobs.length) throw AppError.badRequest("No customers in this audience can be reached on that channel.");

    const m = await this.prisma.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          businessId,
          channel: dto.channel.toUpperCase() as never,
          subject,
          body,
          audienceLabel: a.label,
          recipientCount: jobs.length,
        },
      });
      await tx.messageJob.createMany({
        data: jobs.map((j) => ({
          messageId: message.id,
          businessId,
          channel: j.channel,
          toAddress: j.toAddress,
          recipientName: j.recipientName,
          subject: j.subject,
          body: j.body,
        })),
      });
      return message;
    });

    // Kick delivery without blocking the request (jobs also run on the hourly tick).
    void this.processQueue(50).catch((e) => this.log.warn(`queue kick failed: ${(e as Error).message}`));
    return toMessage(m);
  }

  /**
   * Deliver pending MessageJob rows. Safe to call from many processes: each job is claimed with a conditional update.
   * Returns how many were attempted.
   */
  async processQueue(batch = 40): Promise<number> {
    const pending = await this.prisma.messageJob.findMany({
      where: { status: "PENDING", attempts: { lt: 5 } },
      orderBy: { createdAt: "asc" },
      take: batch,
    });
    let n = 0;
    for (const job of pending) {
      const claimed = await this.prisma.messageJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: { attempts: { increment: 1 } },
      });
      if (!claimed.count) continue;
      n++;
      let ok = false;
      let err: string | undefined;
      try {
        if (job.channel === "EMAIL") {
          const biz = await this.prisma.business.findUnique({ where: { id: job.businessId }, select: { name: true } });
          ok = await this.mail.trySend(
            customerMessageMail(job.toAddress, {
              subject: job.subject ?? "Message",
              body: job.body,
              store: biz?.name ?? "your store",
            }),
          );
        } else {
          await this.sms.send({ to: job.toAddress, text: job.body });
          ok = true;
        }
      } catch (e) {
        ok = false;
        err = (e as Error).message?.slice(0, 300);
      }

      if (ok) {
        await this.prisma.$transaction([
          this.prisma.messageJob.update({ where: { id: job.id }, data: { status: "SENT", processedAt: new Date(), lastError: null } }),
          this.prisma.message.update({ where: { id: job.messageId }, data: { sentCount: { increment: 1 } } }),
        ]);
      } else if (job.attempts + 1 >= 5) {
        await this.prisma.$transaction([
          this.prisma.messageJob.update({
            where: { id: job.id },
            data: { status: "FAILED", processedAt: new Date(), lastError: err ?? "send failed" },
          }),
          this.prisma.message.update({ where: { id: job.messageId }, data: { failedCount: { increment: 1 } } }),
        ]);
      } else {
        await this.prisma.messageJob.update({
          where: { id: job.id },
          data: { lastError: err ?? "send failed" },
        });
      }
    }
    return n;
  }
}
