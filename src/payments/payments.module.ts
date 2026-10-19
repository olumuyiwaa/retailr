import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PlansModule } from "../plans/plans.module";
import { PAYMENT_PROVIDER, PaymentProvider } from "./payment.provider";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { FakePaystackApi, HttpPaystackApi, PaystackProvider } from "./paystack.provider";

@Module({
  imports: [PlansModule],
  controllers: [PaymentsController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (c: ConfigService): PaymentProvider | null => {
        const driver = c.get("PAYMENTS_DRIVER") ?? "none";
        if (driver === "paystack") return new PaystackProvider(new HttpPaystackApi(c.getOrThrow("PAYSTACK_SECRET_KEY"), c.get("PAYSTACK_BASE_URL") || undefined), c.getOrThrow("PAYSTACK_SECRET_KEY"));
        if (driver === "fake") return new PaystackProvider(new FakePaystackApi(), c.get("PAYSTACK_SECRET_KEY") ?? "fake-secret");
        return null;
      },
    },
    PaymentsService,
  ],
  exports: [PaymentsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
