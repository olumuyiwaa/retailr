import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { paymentDrivers } from "../config/env";
import { PlansModule } from "../plans/plans.module";
import { FakeFlutterwaveApi, FlutterwaveProvider, HttpFlutterwaveApi } from "./flutterwave.provider";
import { PAYMENT_PROVIDER, PAYMENT_PROVIDERS, PaymentProvider } from "./payment.provider";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { FakePaystackApi, HttpPaystackApi, PaystackProvider } from "./paystack.provider";

@Module({
  imports: [PlansModule],
  controllers: [PaymentsController],
  providers: [
    {
      provide: PAYMENT_PROVIDERS,
      inject: [ConfigService],
      useFactory: (c: ConfigService): PaymentProvider[] => {
        const out: PaymentProvider[] = [];
        for (const d of paymentDrivers(c.get("PAYMENTS_DRIVER"))) {
          if (d === "paystack") out.push(new PaystackProvider(new HttpPaystackApi(c.getOrThrow("PAYSTACK_SECRET_KEY"), c.get("PAYSTACK_BASE_URL") || undefined), c.getOrThrow("PAYSTACK_SECRET_KEY")));
          else if (d === "fake") out.push(new PaystackProvider(new FakePaystackApi(), c.get("PAYSTACK_SECRET_KEY") ?? "fake-secret"));
          else if (d === "flutterwave") out.push(new FlutterwaveProvider(new HttpFlutterwaveApi(c.getOrThrow("FLUTTERWAVE_SECRET_KEY"), c.get("FLUTTERWAVE_BASE_URL") || undefined), c.getOrThrow("FLUTTERWAVE_SECRET_HASH")));
          else if (d === "fake-flutterwave") out.push(new FlutterwaveProvider(new FakeFlutterwaveApi(), c.get("FLUTTERWAVE_SECRET_HASH") ?? "fake-hash"));
        }
        return out;
      },
    },
    /** The default provider (kept for code that only needs one). */
    { provide: PAYMENT_PROVIDER, inject: [PAYMENT_PROVIDERS], useFactory: (p: PaymentProvider[]) => p[0] ?? null },
    PaymentsService,
  ],
  exports: [PaymentsService, PAYMENT_PROVIDER, PAYMENT_PROVIDERS],
})
export class PaymentsModule {}
