import { Controller, Headers, HttpCode, Post, Req, UnauthorizedException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../common/decorators";
import { PaymentsService } from "./payments.service";

@ApiTags("payments")
@Controller("webhooks")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Paystack calls this after a payment. We check the signature on the raw body, then ask Paystack what really happened before changing anything. */
  @Public() @SkipThrottle() @HttpCode(200) @Post("paystack")
  async paystack(@Req() req: Request & { rawBody?: Buffer }, @Headers("x-paystack-signature") signature?: string) {
    const provider = this.payments.provider;
    if (!provider || provider.name !== "paystack" || !req.rawBody || !provider.verifyWebhook(req.rawBody, signature)) throw new UnauthorizedException();
    const ref = provider.webhookReference(req.body);
    if (ref) await this.payments.confirm(ref).catch(() => undefined); // unknown references (not ours) are ignored; Paystack must still get a 200
    return { received: true };
  }
}
