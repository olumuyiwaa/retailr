import { Module } from "@nestjs/common";
import { PlatformCatalogueService } from "./platform-catalogue.service";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";

@Module({ controllers: [PlatformController], providers: [PlatformService, PlatformCatalogueService] })
export class PlatformModule {}
