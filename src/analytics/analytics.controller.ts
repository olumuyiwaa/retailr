import { Body, Controller, Get, Headers, HttpCode, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AuthContext, CurrentUser, Public, Roles, MinRole } from "../common/decorators";
import { AnalyticsService } from "./analytics.service";
import { AnalyticsQuery, TrackDto } from "./dto/analytics.dto";
import { IngestService } from "./ingest.service";

const trackLimit = () => ({ default: { limit: Number(process.env.TRACK_RATE_LIMIT ?? 120), ttl: 60_000 } });

@ApiTags("analytics")
@Controller()
export class AnalyticsController {
  constructor(private readonly ingest: IngestService, private readonly analytics: AnalyticsService) {}

  /** Fire-and-forget: always 202 for a well-formed batch, even when it's ignored (unknown or closed store, bots). */
  @Public() @Throttle(trackLimit()) @HttpCode(202) @Post("track")
  async track(@Body() dto: TrackDto, @Headers("user-agent") ua?: string) { await this.ingest.track(dto, ua); }

  @ApiBearerAuth() @Roles("BUSINESS_ADMIN") @MinRole("MANAGER") @Get("business/analytics")
  business(@CurrentUser() u: AuthContext, @Query() q: AnalyticsQuery) { return this.analytics.business(u.businessId!, q.days ?? 30); }

  @ApiBearerAuth() @Roles("SUPER_ADMIN") @Get("platform/analytics")
  platform(@Query() q: AnalyticsQuery) { return this.analytics.platform(q.days ?? 30); }
}
