import { Module } from "@nestjs/common";
import { PlanCouponsService } from "./plan-coupons.service";
import { PlansController } from "./plans.controller";

@Module({ controllers: [PlansController], providers: [PlanCouponsService], exports: [PlanCouponsService] })
export class PlansModule {}
