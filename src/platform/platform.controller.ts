import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Roles } from "../common/decorators";
import { PaymentsService } from "../payments/payments.service";
import { withTotal } from "../common/paging";
import { BusinessesQuery, BusinessStatusDto, InvoicesQuery, PlanCouponDto, PaymentProvidersDto, PlanCouponStatusDto, PlanDto, SubscriptionsQuery } from "./dto/platform.dto";
import { PlatformCatalogueService } from "./platform-catalogue.service";
import { PlatformService } from "./platform.service";

@ApiTags("platform")
@ApiBearerAuth()
@Roles("SUPER_ADMIN")
@Controller("platform")
export class PlatformController {
  constructor(private readonly platform: PlatformService, private readonly catalogue: PlatformCatalogueService, private readonly payments: PaymentsService) {}

  @Get("overview") overview() { return this.platform.overview(); }

  @Get("businesses") async businesses(@Query() q: BusinessesQuery, @Res({ passthrough: true }) res: Response) { const r = await this.platform.businesses(q); withTotal(res, r.total); return r.items; }
  @Get("businesses/:id") business(@Param("id") id: string) { return this.platform.businessDetail(id); }
  @Patch("businesses/:id/status") status(@Param("id") id: string, @Body() d: BusinessStatusDto) { return this.platform.setStatus(id, d.status); }

  @Get("subscriptions") async subscriptions(@Query() q: SubscriptionsQuery, @Res({ passthrough: true }) res: Response) { const r = await this.platform.subscriptions(q); withTotal(res, r.total); return r.items; }
  @Get("invoices") async invoices(@Query() q: InvoicesQuery, @Res({ passthrough: true }) res: Response) { const r = await this.platform.invoices(q); withTotal(res, r.total); return r.items; }

  @Get("plans") plans() { return this.catalogue.plans(); }
  @Put("plans/:id") savePlan(@Param("id") id: string, @Body() d: PlanDto) { return this.catalogue.savePlan(id, d); }

  /** Which payment providers are set up on the server, which are switched on, and the default. Keys stay in the environment. */
  @Get("payment-providers") paymentProviders() { return this.providers(); }
  @Put("payment-providers") async savePaymentProviders(@Body() d: PaymentProvidersDto) {
    await this.payments.setConfig(d.enabled, d.default);
    return this.providers();
  }

  private async providers() {
    const c = await this.payments.selection();
    const configured = new Set(this.payments.providers.map((p) => p.name));
    const info = { paystack: { label: "Paystack", env: ["PAYSTACK_SECRET_KEY"] }, flutterwave: { label: "Flutterwave", env: ["FLUTTERWAVE_SECRET_KEY", "FLUTTERWAVE_SECRET_HASH"] } };
    return {
      paymentsEnabled: this.payments.enabled,
      providers: (Object.keys(info) as (keyof typeof info)[]).map((name) => ({
        name, label: info[name].label, configured: configured.has(name), enabled: c.enabled.includes(name), isDefault: c.default === name, requiredEnv: info[name].env,
      })),
    };
  }

  @Get("plan-coupons") coupons() { return this.catalogue.list(); }
  @Post("plan-coupons") createCoupon(@Body() d: PlanCouponDto) { return this.catalogue.create(d); }
  @Put("plan-coupons/:id") updateCoupon(@Param("id") id: string, @Body() d: PlanCouponDto) { return this.catalogue.update(id, d); }
  @Patch("plan-coupons/:id/status") couponStatus(@Param("id") id: string, @Body() d: PlanCouponStatusDto) { return this.catalogue.setStatus(id, d.status); }
  @HttpCode(204) @Delete("plan-coupons/:id") async deleteCoupon(@Param("id") id: string) { await this.catalogue.remove(id); }
}
