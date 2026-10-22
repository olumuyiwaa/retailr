import { Body, Controller, Delete, Get, HttpCode, Param, Post, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IsOptional, IsString, MaxLength } from "class-validator";
import type { Response } from "express";
import { AuthContext, CurrentUser, Public, Roles } from "../common/decorators";
import { CalendarService } from "./calendar.service";

class CreateFeedDto {
  @IsOptional() @IsString() @MaxLength(80) label?: string;
}

/** Each person manages their own subscription links. */
@ApiTags("calendar")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@Controller("business/calendar")
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get("feeds") list(@CurrentUser() u: AuthContext) { return this.calendar.list(u.businessId!, u.userId); }
  @Post("feeds") create(@CurrentUser() u: AuthContext, @Body() dto: CreateFeedDto) { return this.calendar.create(u.businessId!, u.userId, dto.label); }
  @HttpCode(204) @Delete("feeds/:id") async revoke(@CurrentUser() u: AuthContext, @Param("id") id: string) { await this.calendar.revoke(u.businessId!, u.userId, id); }
}

/** Calendar apps poll about hourly, often from shared provider IPs, so the per-client limit is generous. */
@ApiTags("calendar")
@Public()
@Controller("calendar-feed")
export class CalendarFeedController {
  constructor(private readonly calendar: CalendarService) {}

  @Throttle({ default: { limit: () => Number(process.env.FEED_RATE_LIMIT ?? 600), ttl: 60_000 } })
  @Get(":file")
  async serve(@Param("file") file: string, @Res() res: Response) {
    try {
      const body = await this.calendar.render(file.replace(/\.ics$/i, ""));
      res.set({
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="retailr.ics"',
        // the URL is a secret: keep it out of shared caches and referrers
        "Cache-Control": "private, max-age=300",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex",
      }).status(200).send(body);
    } catch (e) {
      if (e && typeof e === "object" && (e as { getStatus?: () => number }).getStatus?.() === 404) return res.status(404).type("text/plain").send("Not found");
      throw e;
    }
  }
}
