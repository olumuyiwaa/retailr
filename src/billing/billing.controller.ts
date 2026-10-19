import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { AuthContext, CurrentUser, Roles } from "../common/decorators";
import { PaymentsService } from "../payments/payments.service";
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
  constructor(private readonly billing: BillingService, private readonly payments: PaymentsService) {}
  @Get() get(@CurrentUser() u: AuthContext) { return this.billing.get(u.businessId!); }
  /** Returns the refreshed billing view so the page can redraw in one go. */
  @HttpCode(200) @Post("change-plan") change(@CurrentUser() u: AuthContext, @Body() d: ChangePlanDto) { return this.billing.changePlan(u.businessId!, d.planId, d.cycle, d.couponCode); }

  /** Starts a payment for a plan. Send the person to `checkoutUrl`; they come back to the billing page with `?reference=...`. */
  @HttpCode(200) @Post("checkout")
  async checkout(@CurrentUser() u: AuthContext, @Body() d: ChangePlanDto) {
    const r = await this.payments.checkout(u.businessId!, d.planId, d.cycle, d.couponCode);
    return r.applied ? { ...r, billing: await this.billing.get(u.businessId!) } : r;
  }

  /** The page calls this when the person returns from checkout, so they see the result without waiting for the webhook. */
  @Get("verify/:reference")
  async verify(@CurrentUser() u: AuthContext, @Param("reference") reference: string) {
    const r = await this.payments.confirm(reference, u.businessId!);
    return { ...r, billing: await this.billing.get(u.businessId!) };
  }
}
