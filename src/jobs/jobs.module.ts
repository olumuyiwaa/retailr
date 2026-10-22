import { Module } from "@nestjs/common";
import { BusinessModule } from "../business/business.module";
import { PaymentsModule } from "../payments/payments.module";
import { JobsService } from "./jobs.service";

@Module({ imports: [PaymentsModule, BusinessModule], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
