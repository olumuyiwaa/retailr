import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AuthContext, CurrentUser, Roles, MinRole } from "../common/decorators";
import { CouponsService } from "./coupons.service";
import { AudienceQuery, CouponDto, CouponStatusDto, GroupDto, InviteDto, ProfileDto, SendMessageDto } from "./dto/business.dto";
import { GroupsService } from "./groups.service";
import { MessagesService } from "./messages.service";
import { ProfileService } from "./profile.service";
import { ExpensesService } from "./expenses.service";
import { TeamService } from "./team.service";

@ApiTags("business")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@MinRole("MANAGER")
@Controller("business")
export class BusinessController {
  constructor(
    private readonly coupons: CouponsService, private readonly groups: GroupsService, private readonly messages: MessagesService,
    private readonly team: TeamService, private readonly profile: ProfileService, private readonly expenses: ExpensesService,
  ) {}

  @Get("coupons") listCoupons(@CurrentUser() u: AuthContext) { return this.coupons.list(u.businessId!); }
  @Post("coupons") createCoupon(@CurrentUser() u: AuthContext, @Body() d: CouponDto) { return this.coupons.create(u.businessId!, d); }
  @Put("coupons/:id") updateCoupon(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() d: CouponDto) { return this.coupons.update(u.businessId!, id, d); }
  @Patch("coupons/:id/status") couponStatus(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() d: CouponStatusDto) { return this.coupons.setStatus(u.businessId!, id, d.status); }
  @HttpCode(204) @Delete("coupons/:id") async deleteCoupon(@CurrentUser() u: AuthContext, @Param("id") id: string) { await this.coupons.remove(u.businessId!, id); }

  @Get("groups") listGroups(@CurrentUser() u: AuthContext) { return this.groups.list(u.businessId!); }
  @Get("groups/:id/members") groupMembers(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.groups.members(u.businessId!, id); }
  @Post("groups") createGroup(@CurrentUser() u: AuthContext, @Body() d: GroupDto) { return this.groups.create(u.businessId!, d); }
  @Put("groups/:id") updateGroup(@CurrentUser() u: AuthContext, @Param("id") id: string, @Body() d: GroupDto) { return this.groups.update(u.businessId!, id, d); }
  @HttpCode(204) @Delete("groups/:id") async deleteGroup(@CurrentUser() u: AuthContext, @Param("id") id: string) { await this.groups.remove(u.businessId!, id); }

  @Get("messages/audience") audience(@CurrentUser() u: AuthContext, @Query() q: AudienceQuery) { return this.messages.preview(u.businessId!, q); }
  @Get("messages") listMessages(@CurrentUser() u: AuthContext) { return this.messages.list(u.businessId!); }
  @Get("messages/sms-credits") smsCredits(@CurrentUser() u: AuthContext) { return this.messages.smsUsage(u.businessId!); }
  @Post("messages") sendMessage(@CurrentUser() u: AuthContext, @Body() d: SendMessageDto) { return this.messages.send(u.businessId!, d); }

  @Get("team") listTeam(@CurrentUser() u: AuthContext) { return this.team.list(u.businessId!); }
  @MinRole("OWNER") @Post("team") invite(@CurrentUser() u: AuthContext, @Body() d: InviteDto) { return this.team.invite(u.businessId!, d, u.userId); }
  @MinRole("OWNER") @HttpCode(200) @Post("team/:id/resend") resend(@CurrentUser() u: AuthContext, @Param("id") id: string) { return this.team.resend(u.businessId!, id, u.userId); }
  @MinRole("OWNER") @HttpCode(204) @Delete("team/:id") async removeMember(@CurrentUser() u: AuthContext, @Param("id") id: string) { await this.team.remove(u.businessId!, id); }

  @MinRole("STAFF") @Get("profile") getProfile(@CurrentUser() u: AuthContext) { return this.profile.get(u.businessId!); }
  @MinRole("OWNER") @Patch("profile") updateProfile(@CurrentUser() u: AuthContext, @Body() d: ProfileDto) { return this.profile.update(u.businessId!, d); }
}
