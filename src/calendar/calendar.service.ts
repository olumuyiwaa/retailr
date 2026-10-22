import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "crypto";
import { AppError } from "../common/errors";
import { PrismaService } from "../prisma/prisma.service";
import { renderFeed } from "./ics";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const MAX_ACTIVE_FEEDS_PER_USER = 10;
const WINDOW_PAST_DAYS = 14;
const WINDOW_FUTURE_DAYS = 120;
const MAX_EVENTS = 1000;
const TOUCH_INTERVAL_MS = 3_600_000;
const DAY = 86_400_000;

const toFeed = (f: { id: string; label: string | null; createdAt: Date; lastAccessedAt: Date | null }) => ({
  id: f.id, label: f.label, createdAt: f.createdAt.toISOString(), lastAccessedAt: f.lastAccessedAt?.toISOString() ?? null,
});

/** Private calendar subscription links. The link is the secret: shown once, only its hash is kept. */
@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}

  private get apiUrl() { return (this.config.get<string>("API_PUBLIC_URL") ?? "http://localhost:4000").replace(/\/$/, ""); }

  async create(businessId: string, userId: string, label?: string) {
    const db = this.prisma.forBusiness(businessId);
    if ((await db.calendarFeed.count({ where: { userId, revokedAt: null } })) >= MAX_ACTIVE_FEEDS_PER_USER) {
      throw AppError.badRequest("Too many calendar links. Revoke one you no longer use first.", "TOO_MANY_FEEDS");
    }
    const token = randomBytes(32).toString("base64url");
    const feed = await db.calendarFeed.create({ data: { userId, label: label?.trim().slice(0, 80) || null, tokenHash: sha256(token) } as never });
    const url = `${this.apiUrl}/api/v1/calendar-feed/${token}.ics`;
    // many calendar apps open webcal:// directly as "subscribe"
    return { ...toFeed(feed), url, webcalUrl: url.replace(/^https?:\/\//, "webcal://") };
  }

  /** Never returns the secret: it can't be recovered, only revoked. */
  async list(businessId: string, userId: string) {
    const rows = await this.prisma.forBusiness(businessId).calendarFeed.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map(toFeed);
  }

  async revoke(businessId: string, userId: string, id: string) {
    const db = this.prisma.forBusiness(businessId);
    const feed = await db.calendarFeed.findFirst({ where: { id, userId, revokedAt: null } });
    if (!feed) throw AppError.notFound("Calendar link not found.");
    await db.calendarFeed.update({ where: { id }, data: { revokedAt: new Date() } });
  }

  /** Every failure is the same 404, so a probe learns nothing about which part failed. */
  async render(token: string, now = new Date()): Promise<string> {
    const notFound = AppError.notFound("Not found.");
    if (!token || token.length < 32 || token.length > 128) throw notFound;
    const feed = await this.prisma.calendarFeed.findUnique({ where: { tokenHash: sha256(token) }, include: { business: { select: { name: true, status: true } } } });
    if (!feed || feed.revokedAt) throw notFound;
    if (feed.business.status !== "ACTIVE" && feed.business.status !== "TRIAL") throw notFound;
    // someone who left the team loses their link automatically
    const member = await this.prisma.teamMember.findFirst({ where: { businessId: feed.businessId, userId: feed.userId, status: "ACTIVE" }, select: { id: true } });
    if (!member) throw notFound;

    const bookings = await this.prisma.booking.findMany({
      where: { businessId: feed.businessId, startsAt: { gte: new Date(now.getTime() - WINDOW_PAST_DAYS * DAY), lte: new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY) } },
      orderBy: { startsAt: "asc" }, take: MAX_EVENTS,
    });
    // "last used" is a courtesy for the settings screen: touch it at most hourly, never let it fail the feed
    if (!feed.lastAccessedAt || now.getTime() - feed.lastAccessedAt.getTime() > TOUCH_INTERVAL_MS) {
      void this.prisma.calendarFeed.update({ where: { id: feed.id }, data: { lastAccessedAt: now } }).catch(() => undefined);
    }
    return renderFeed({ name: `${feed.business.name} · Bookings`, bookings, now });
  }
}
