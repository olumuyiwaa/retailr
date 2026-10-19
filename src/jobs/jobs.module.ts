import { Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module";
import { JobsService } from "./jobs.service";

@Module({ imports: [PaymentsModule], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
