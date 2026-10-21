import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, ValidateNested } from "class-validator";
import type { Request } from "express";
import { AuthContext, CurrentUser } from "../common/decorators";
import { NotificationsService } from "./notifications.service";

class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @IsOptional() @Type(() => String) unread?: string;
}
class KeysDto {
  @IsString() @MaxLength(200) p256dh: string;
  @IsString() @MaxLength(100) auth: string;
}
class SubscribeDto {
  @IsUrl({ protocols: ["https"], require_protocol: true, require_tld: false }) @MaxLength(1000) endpoint: string;
  @ValidateNested() @Type(() => KeysDto) keys: KeysDto;
}
class UnsubscribeDto {
  @IsString() @MaxLength(1000) endpoint: string;
}

/** The signed-in person's own notifications. Open to every business team member and to super admins. */
@ApiTags("notifications")
@ApiBearerAuth()
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get() list(@CurrentUser() u: AuthContext, @Query() q: ListQuery) { return this.notifications.list(u.userId, { limit: q.limit, unreadOnly: q.unread === "true" }); }

  @HttpCode(204) @Post("read-all") readAll(@CurrentUser() u: AuthContext) { return this.notifications.markAllRead(u.userId); }

  @Get("push/key") key() { return { enabled: this.notifications.pushEnabled, publicKey: this.notifications.publicKey }; }

  @HttpCode(204) @Post("push/subscribe")
  subscribe(@CurrentUser() u: AuthContext, @Body() dto: SubscribeDto, @Req() req: Request) {
    return this.notifications.subscribe(u.userId, { endpoint: dto.endpoint, p256dh: dto.keys.p256dh, auth: dto.keys.auth }, req.headers["user-agent"]);
  }

  @HttpCode(204) @Post("push/unsubscribe")
  unsubscribe(@CurrentUser() u: AuthContext, @Body() dto: UnsubscribeDto) { return this.notifications.unsubscribe(u.userId, dto.endpoint); }

  @HttpCode(204) @Post(":id/read") read(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.notifications.markRead(u.userId, id); }
}
