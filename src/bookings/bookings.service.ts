import { Injectable } from "@nestjs/common";
import { Business, Prisma } from "@prisma/client";
import { AppError } from "../common/errors";
import { toBooking, toPublicStore } from "../common/serializers";
import { bookingMail, when } from "../mail/templates";
import { MailService } from "../mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import { OrderEngine, Tx } from "../orders/order-engine.service";
import { PrismaService } from "../prisma/prisma.service";
import { addDays, DAYS, DEFAULT_HOURS, freeSlots, Hours, localDate, MAX_DAYS_AHEAD, timeLabel, toMins, validDate, validTimezone, zonedToUtc } from "./availability";
import { AdminBookingDto, BookingSettingsDto, ListBookingsQuery, NewBookingDto } from "./dto/bookings.dto";

const ACTIVE = ["PENDING", "CONFIRMED"] as const;
const MAX_RANGES_PER_DAY = 3;
const UNAVAILABLE = "This store isn't available right now.";

type Customer = { name: string; email?: string; phone?: string };

/** Opening hours, free slots and bookings for bookable services. */
@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: OrderEngine,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  // ---------- settings ----------

  async getSettings(businessId: string) {
    const b = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    return { timezone: b.timezone, hours: (b.bookingHours as unknown as Hours | null) ?? DEFAULT_HOURS, configured: !!b.bookingHours, noticeHours: b.bookingNoticeHours, autoConfirm: b.bookingAutoConfirm };
  }

  async updateSettings(businessId: string, dto: BookingSettingsDto) {
    if (!validTimezone(dto.timezone)) throw AppError.badRequest("Choose a valid time zone, like Africa/Lagos.", "TIMEZONE_INVALID");
    const hours: Hours = {};
    for (const [day, ranges] of Object.entries(dto.hours)) {
      if (!(DAYS as readonly string[]).includes(day)) throw AppError.badRequest(`"${day}" isn't a day of the week.`);
      if (!Array.isArray(ranges) || ranges.length === 0) continue; // closed
      if (ranges.length > MAX_RANGES_PER_DAY) throw AppError.badRequest(`Use at most ${MAX_RANGES_PER_DAY} opening periods a day.`);
      const clean = ranges.map((r) => {
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r?.start ?? "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r?.end ?? "")) throw AppError.badRequest("Opening times must look like 09:00.");
        if (toMins(r.start) >= toMins(r.end)) throw AppError.badRequest("Each opening period must end after it starts.");
        return { start: r.start, end: r.end };
      }).sort((a, b) => toMins(a.start) - toMins(b.start));
      for (let i = 1; i < clean.length; i++) if (toMins(clean[i].start) < toMins(clean[i - 1].end)) throw AppError.badRequest("Opening periods on the same day can't overlap.");
      hours[day as keyof Hours] = clean;
    }
    await this.prisma.business.update({ where: { id: businessId }, data: { timezone: dto.timezone, bookingHours: hours as never, bookingNoticeHours: dto.noticeHours, bookingAutoConfirm: dto.autoConfirm } });
    return this.getSettings(businessId);
  }

  // ---------- availability ----------

  private async liveBusiness(slug: string): Promise<Business> {
    const biz = await this.prisma.business.findUnique({ where: { slug: slug.toLowerCase() } });
    if (!biz || (biz.status !== "ACTIVE" && biz.status !== "TRIAL")) throw AppError.notFound(UNAVAILABLE, "STORE_UNAVAILABLE");
    return biz;
  }

  private async slotStarts(db: Tx, biz: Business, service: { id: string; durationMins: number | null; maxConcurrent: number }, date: string, now = Date.now()) {
    const dayStart = zonedToUtc(date, 0, biz.timezone), dayEnd = zonedToUtc(date, 1440, biz.timezone);
    const rows = await db.booking.findMany({
      where: { serviceId: service.id, status: { in: [...ACTIVE] }, startsAt: { lt: new Date(dayEnd) }, endsAt: { gt: new Date(dayStart) } },
      select: { startsAt: true, endsAt: true },
    });
    return freeSlots({
      hours: (biz.bookingHours as unknown as Hours | null) ?? DEFAULT_HOURS, tz: biz.timezone, date, durationMins: service.durationMins ?? 60, capacity: service.maxConcurrent,
      booked: rows.map((r) => ({ start: r.startsAt.getTime(), end: r.endsAt.getTime() })), now, noticeMs: biz.bookingNoticeHours * 3_600_000,
    });
  }

  /** The times a customer can pick for one service on one day. */
  async slots(slug: string, serviceId: string, date: string) {
    const biz = await this.liveBusiness(slug);
    if (!validDate(date)) throw AppError.badRequest("Pick a valid date.", "DATE_INVALID");
    const today = localDate(Date.now(), biz.timezone).date;
    if (date < today) throw AppError.badRequest("Pick a date from today onwards.", "DATE_PAST");
    if (date > addDays(today, MAX_DAYS_AHEAD)) throw AppError.badRequest(`Bookings open up to ${MAX_DAYS_AHEAD} days ahead.`, "DATE_TOO_FAR");
    const db = this.prisma.forBusiness(biz.id) as unknown as Tx;
    const service = await db.service.findUnique({ where: { id: serviceId } });
    if (!service || !service.bookable || service.status !== "ACTIVE") throw AppError.notFound("This service can't be booked online.", "NOT_BOOKABLE");
    const starts = await this.slotStarts(db, biz, service, date);
    return {
      date, timezone: biz.timezone, durationMins: service.durationMins,
      slots: starts.map((t) => ({ startsAt: new Date(t).toISOString(), label: timeLabel(t, biz.timezone) })),
    };
  }

  // ---------- making a booking ----------

  /** A customer booking online. */
  async book(slug: string, dto: NewBookingDto) {
    const biz = await this.liveBusiness(slug);
    return this.create(biz, dto, { admin: false });
  }

  /** The team booking on a customer's behalf (a phone call, a walk-in). */
  async bookAsTeam(businessId: string, dto: AdminBookingDto) {
    const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    return this.create(biz, dto, { admin: true });
  }

  private async create(biz: Business, dto: { serviceId: string; optionId?: string; startsAt: string; customer: Customer; notes?: string }, o: { admin: boolean }) {
    const start = Date.parse(dto.startsAt);
    if (Number.isNaN(start)) throw AppError.badRequest("Pick a time slot.", "TIME_INVALID");
    if (start < Date.now()) throw AppError.badRequest("That time has already passed.", "TIME_PAST");

    const booking = await this.engine.inTenantTransaction(biz.id, async (tx) => {
      const service = await tx.service.findUnique({ where: { id: dto.serviceId }, include: { options: true } });
      if (!service || !service.bookable || !service.durationMins || (!o.admin && service.status !== "ACTIVE")) {
        throw AppError.badRequest("This service can't be booked right now.", "NOT_BOOKABLE");
      }
      let option: (typeof service.options)[number] | undefined;
      if (service.options.length) {
        option = service.options.find((v) => v.id === dto.optionId);
        if (!option) throw AppError.badRequest(`Choose an option for ${service.name}.`, "OPTION_REQUIRED");
      }
      const end = start + service.durationMins * 60_000;

      if (o.admin) {
        // the team may book outside opening hours, but never past the service's capacity
        const clash = await tx.booking.count({ where: { serviceId: service.id, status: { in: [...ACTIVE] }, startsAt: { lt: new Date(end) }, endsAt: { gt: new Date(start) } } });
        if (clash >= service.maxConcurrent) throw AppError.conflict("That time is already fully booked.", "SLOT_TAKEN");
      } else {
        const date = localDate(start, biz.timezone).date;
        const free = await this.slotStarts(tx, biz, service, date);
        if (!free.includes(start)) throw AppError.conflict("That time was just taken. Please pick another.", "SLOT_TAKEN");
      }

      const customer = await this.resolveCustomer(tx, dto.customer);
      const status = o.admin || biz.bookingAutoConfirm ? "CONFIRMED" : "PENDING";
      return tx.booking.create({
        data: {
          serviceId: service.id, customerId: customer.id, serviceName: service.name, variantName: option?.name ?? null,
          price: option?.price ?? service.price, startsAt: new Date(start), endsAt: new Date(end), status,
          customerName: dto.customer.name.trim(), customerEmail: customer.email, customerPhone: dto.customer.phone?.trim() || customer.phone || null,
          notes: dto.notes?.trim() || null, source: o.admin ? "admin" : "store",
        } as never,
      });
    });

    if (!o.admin) {
      void this.notifications.notifyBusiness(biz.id, {
        type: "NEW_BOOKING", title: `New booking: ${booking.serviceName}`,
        body: `${booking.customerName} · ${when(booking.startsAt, biz.timezone)}`, link: "/admin/business/bookings",
      });
    }
    if (booking.customerEmail) void this.mailCustomer(biz, booking, booking.status === "PENDING" ? "requested" : "confirmed");
    return toBooking(booking, { publicToken: true, timezone: biz.timezone });
  }

  private async resolveCustomer(tx: Tx, c: Customer) {
    const email = c.email?.trim().toLowerCase() || null;
    const phone = c.phone?.trim() ?? "";
    const matches: Prisma.CustomerWhereInput[] = [];
    if (email) matches.push({ email });
    if (!email && phone) matches.push({ phone });
    const existing = matches.length ? await tx.customer.findFirst({ where: { OR: matches } }) : null;
    return existing ?? tx.customer.create({ data: { name: c.name.trim(), email, phone } as never });
  }

  private mailCustomer(biz: Business, b: { customerName: string; customerEmail: string | null; serviceName: string; startsAt: Date; publicToken: string }, kind: "requested" | "confirmed" | "cancelled") {
    if (!b.customerEmail) return Promise.resolve(false);
    return this.mail.trySend(bookingMail(b.customerEmail, {
      kind, customer: b.customerName, business: biz.name, service: b.serviceName, startsAt: b.startsAt, timezone: biz.timezone,
      link: `${this.mail.appUrl}/s/${biz.slug}/booking/${b.publicToken}`,
    }));
  }

  // ---------- the team's view ----------

  async list(businessId: string, q: ListBookingsQuery) {
    const term = q.q?.trim();
    const where: Prisma.BookingWhereInput = {
      ...(q.status ? { status: q.status.toUpperCase() as never } : {}),
      ...(q.from || q.to ? { startsAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } } : {}),
      ...(term ? { OR: [{ customerName: { contains: term, mode: "insensitive" } }, { serviceName: { contains: term, mode: "insensitive" } }, { customerEmail: { contains: term, mode: "insensitive" } }, { customerPhone: { contains: term } }] } : {}),
    };
    const db = this.prisma.forBusiness(businessId);
    const rows = await db.booking.findMany({ where, orderBy: { startsAt: q.from ? "asc" : "desc" }, take: q.limit ?? 200 });
    const tz = (await this.prisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { timezone: true } })).timezone;
    return rows.map((b) => toBooking(b, { timezone: tz }));
  }

  async setStatus(businessId: string, id: string, status: string) {
    const biz = await this.prisma.business.findUniqueOrThrow({ where: { id: businessId } });
    const db = this.prisma.forBusiness(businessId);
    const b = await db.booking.findUnique({ where: { id } });
    if (!b) throw AppError.notFound("Booking not found.");
    const next = status.toUpperCase();
    if (b.status === "CANCELLED" && next !== "CANCELLED") throw AppError.badRequest("A cancelled booking can't be reopened. Make a new booking instead.", "BOOKING_CANCELLED");
    if (b.status === next) return toBooking(b, { timezone: biz.timezone });
    const updated = await db.booking.update({ where: { id }, data: { status: next as never } });
    if (next === "CONFIRMED" && b.status === "PENDING") void this.mailCustomer(biz, updated, "confirmed");
    if (next === "CANCELLED") void this.mailCustomer(biz, updated, "cancelled");
    return toBooking(updated, { timezone: biz.timezone });
  }

  // ---------- the customer's own link ----------

  async byToken(token: string) {
    const b = await this.prisma.booking.findUnique({ where: { publicToken: token }, include: { business: { include: { plan: { select: { themes: true, priceMonthly: true } } } } } });
    if (!b) throw AppError.notFound("Booking not found.");
    return { booking: toBooking(b, { publicToken: true, timezone: b.business.timezone }), store: toPublicStore(b.business, b.business.plan) };
  }

  async cancelByToken(token: string) {
    const b = await this.prisma.booking.findUnique({ where: { publicToken: token }, include: { business: true } });
    if (!b) throw AppError.notFound("Booking not found.");
    if (!(ACTIVE as readonly string[]).includes(b.status)) throw AppError.badRequest("This booking can't be cancelled.", "NOT_CANCELLABLE");
    if (b.startsAt.getTime() <= Date.now()) throw AppError.badRequest("This booking has already started.", "ALREADY_STARTED");
    const claimed = await this.prisma.booking.updateMany({ where: { id: b.id, status: { in: [...ACTIVE] } }, data: { status: "CANCELLED" } });
    if (claimed.count === 0) throw AppError.badRequest("This booking can't be cancelled.", "NOT_CANCELLABLE");
    void this.notifications.notifyBusiness(b.businessId, {
      type: "BOOKING_CANCELLED", title: `Booking cancelled: ${b.serviceName}`,
      body: `${b.customerName} · ${when(b.startsAt, b.business.timezone)}`, link: "/admin/business/bookings",
    });
    return { ...toBooking({ ...b, status: "CANCELLED" }, { publicToken: true, timezone: b.business.timezone }) };
  }
}
