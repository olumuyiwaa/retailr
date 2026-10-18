import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { AuthContext, CurrentUser, Roles } from "../common/decorators";
import { BillingService } from "./billing.service";

export class ChangePlanDto {
  @IsString() planId: string;
  @IsIn(["monthly", "yearly"]) cycle: "monthly" | "yearly";
  @IsOptional() @IsString() @MaxLength(40) couponCode?: string;
}

@ApiTags("billing")
@ApiBearerAuth()
@Roles("BUSINESS_ADMIN")
@Controller("business/billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}
  @Get() get(@CurrentUser() u: AuthContext) { return this.billing.get(u.businessId!); }
  /** Returns the refreshed billing view so the page can redraw in one go. */
  @HttpCode(200) @Post("change-plan") change(@CurrentUser() u: AuthContext, @Body() d: ChangePlanDto) { return this.billing.changePlan(u.businessId!, d.planId, d.cycle, d.couponCode); }
}
