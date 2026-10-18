import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { IsString } from "class-validator";
import { Public } from "../common/decorators";
import { AppError } from "../common/errors";
import { toPlan, toPlanCoupon } from "../common/serializers";
import { PrismaService } from "../prisma/prisma.service";
import { PlanCouponsService } from "./plan-coupons.service";

class ValidatePlanCouponDto {
  @IsString() code: string;
  @IsString() planId: string;
}

@ApiTags("plans")
@Controller()
export class PlansController {
  constructor(private readonly prisma: PrismaService, private readonly coupons: PlanCouponsService) {}

  /** Pricing page, sign-up and billing. */
  @Public()
  @Get("plans")
  async list() {
    const plans = await this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { priceMonthly: "asc" } });
    return plans.map(toPlan);
  }

  /** Checks a discount code for a plan without using it up (sign-up). Business-only codes are checked on the billing endpoint instead. */
  @Public()
  @HttpCode(200)
  @Post("plan-coupons/validate")
  async validate(@Body() dto: ValidatePlanCouponDto) {
    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
    if (!plan) throw AppError.badRequest("Please choose a plan.");
    // no business in scope here, so codes limited to one business never validate on this public route
    const c = await this.coupons.check(this.prisma, dto.code, plan);
    return toPlanCoupon(c);
  }
}
