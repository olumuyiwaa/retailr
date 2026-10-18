import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Roles } from "../common/decorators";
import { withTotal } from "../common/paging";
import { BusinessesQuery, BusinessStatusDto, InvoicesQuery, PlanCouponDto, PlanCouponStatusDto, PlanDto, SubscriptionsQuery } from "./dto/platform.dto";
import { PlatformCatalogueService } from "./platform-catalogue.service";
import { PlatformService } from "./platform.service";

@ApiTags("platform")
@ApiBearerAuth()
@Roles("SUPER_ADMIN")
@Controller("platform")
export class PlatformController {
  constructor(private readonly platform: PlatformService, private readonly catalogue: PlatformCatalogueService) {}

  @Get("overview") overview() { return this.platform.overview(); }

  @Get("businesses") async businesses(@Query() q: BusinessesQuery, @Res({ passthrough: true }) res: Response) { const r = await this.platform.businesses(q); withTotal(res, r.total); return r.items; }
  @Get("businesses/:id") business(@Param("id") id: string) { return this.platform.businessDetail(id); }
  @Patch("businesses/:id/status") status(@Param("id") id: string, @Body() d: BusinessStatusDto) { return this.platform.setStatus(id, d.status); }

  @Get("subscriptions") async subscriptions(@Query() q: SubscriptionsQuery, @Res({ passthrough: true }) res: Response) { const r = await this.platform.subscriptions(q); withTotal(res, r.total); return r.items; }
  @Get("invoices") async invoices(@Query() q: InvoicesQuery, @Res({ passthrough: true }) res: Response) { const r = await this.platform.invoices(q); withTotal(res, r.total); return r.items; }

  @Get("plans") plans() { return this.catalogue.plans(); }
  @Put("plans/:id") savePlan(@Param("id") id: string, @Body() d: PlanDto) { return this.catalogue.savePlan(id, d); }

  @Get("plan-coupons") coupons() { return this.catalogue.list(); }
  @Post("plan-coupons") createCoupon(@Body() d: PlanCouponDto) { return this.catalogue.create(d); }
  @Put("plan-coupons/:id") updateCoupon(@Param("id") id: string, @Body() d: PlanCouponDto) { return this.catalogue.update(id, d); }
  @Patch("plan-coupons/:id/status") couponStatus(@Param("id") id: string, @Body() d: PlanCouponStatusDto) { return this.catalogue.setStatus(id, d.status); }
  @HttpCode(204) @Delete("plan-coupons/:id") async deleteCoupon(@Param("id") id: string) { await this.catalogue.remove(id); }
}
