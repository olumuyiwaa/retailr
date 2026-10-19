import { Module } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsService } from "./analytics.service";
import { IngestService } from "./ingest.service";

@Module({ controllers: [AnalyticsController], providers: [IngestService, AnalyticsService] })
export class AnalyticsModule {}
