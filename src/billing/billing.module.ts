import { Module } from "@nestjs/common";
import { PlansModule } from "../plans/plans.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";

@Module({ imports: [PlansModule], controllers: [BillingController], providers: [BillingService] })
export class BillingModule {}
