import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { validateEnv } from "./config/env";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { BillingModule } from "./billing/billing.module";
import { BusinessModule } from "./business/business.module";
import { PaymentsModule } from "./payments/payments.module";
import { PlatformModule } from "./platform/platform.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { JobsModule } from "./jobs/jobs.module";
import { AuditModule } from "./audit/audit.module";
import { SmsModule } from "./sms/sms.module";
import { MailModule } from "./mail/mail.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./auth/auth.module";
import { PlansModule } from "./plans/plans.module";
import { StorageModule } from "./storage/storage.module";
import { CatalogueModule } from "./catalogue/catalogue.module";
import { OrdersModule } from "./orders/orders.module";
import { BookingsModule } from "./bookings/bookings.module";
import { SearchModule } from "./search/search.module";
import { StoreModule } from "./store/store.module";
import { HealthController } from "./health/health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: () => Number(process.env.RATE_LIMIT ?? 120) }]),
    PrismaModule,
    MailModule,
    SmsModule,
    AuditModule,
    NotificationsModule,
    AuthModule,
    PlansModule,
    StorageModule,
    CatalogueModule,
    OrdersModule,
    SearchModule,
    BookingsModule,
    StoreModule,
    BusinessModule,
    PaymentsModule,
    JobsModule,
    BillingModule,
    PlatformModule,
    AnalyticsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
