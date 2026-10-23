import { Module } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module";
import { PlatformCatalogueService } from "./platform-catalogue.service";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";

@Module({ imports: [PaymentsModule], controllers: [PlatformController], providers: [PlatformService, PlatformCatalogueService] })
export class PlatformModule {}
