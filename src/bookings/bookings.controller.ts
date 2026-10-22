import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthContext, CurrentUser, MinRole, Public, Roles } from "../common/decorators";
import { BookingsService } from "./bookings.service";
import { AdminBookingDto, BookingSettingsDto, BookingStatusDto, ListBookingsQuery, NewBookingDto, SlotsQuery } from "./dto/bookings.dto";

const limit = (n: number) => ({ default: { limit: () => Number(process.env.AUTH_RATE_LIMIT ?? n), ttl: 60_000 } });

@ApiTags("bookings")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@Controller("business")
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get("bookings") list(@CurrentUser() u: AuthContext, @Query() q: ListBookingsQuery) { return this.bookings.list(u.businessId!, q); }
  @Post("bookings") create(@CurrentUser() u: AuthContext, @Body() dto: AdminBookingDto) { return this.bookings.bookAsTeam(u.businessId!, dto); }
  @Patch("bookings/:id/status") status(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() dto: BookingStatusDto) { return this.bookings.setStatus(u.businessId!, id, dto.status); }

  @Get("booking-settings") settings(@CurrentUser() u: AuthContext) { return this.bookings.getSettings(u.businessId!); }
  @MinRole("MANAGER") @Put("booking-settings") saveSettings(@CurrentUser() u: AuthContext, @Body() dto: BookingSettingsDto) { return this.bookings.updateSettings(u.businessId!, dto); }
}

/** What a customer can do without signing in. */
@ApiTags("storefront")
@Public()
@Controller("store")
export class PublicBookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Throttle(limit(60)) @Get(":slug/services/:serviceId/slots")
  slots(@Param("slug") slug: string, @Param("serviceId") serviceId: string, @Query() q: SlotsQuery) { return this.bookings.slots(slug, serviceId, q.date); }

  @Throttle(limit(10)) @Post(":slug/bookings")
  book(@Param("slug") slug: string, @Body() dto: NewBookingDto) { return this.bookings.book(slug, dto); }

  @Get("bookings/:token") one(@Param("token") token: string) { return this.bookings.byToken(token); }

  @Throttle(limit(10)) @HttpCode(200) @Post("bookings/:token/cancel")
  cancel(@Param("token") token: string) { return this.bookings.cancelByToken(token); }
}
