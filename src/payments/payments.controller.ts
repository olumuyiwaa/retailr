import { Controller, Headers, HttpCode, Param, Post, Req, UnauthorizedException } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request } from "express";
import { Public } from "../common/decorators";
import { PaymentsService } from "./payments.service";

@ApiTags("payments")
@Controller("webhooks")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /**
   * Providers call `/webhooks/paystack` or `/webhooks/flutterwave` after a payment. We check their signature (Paystack: HMAC of the raw body;
   * Flutterwave: the secret hash in `verif-hash`), then ask the provider what really happened before changing anything.
   */
  @Public() @SkipThrottle() @HttpCode(200) @Post(":provider")
  async webhook(@Param("provider") name: string, @Req() req: Request & { rawBody?: Buffer }, @Headers() headers: Record<string, string | string[] | undefined>) {
    const provider = this.payments.byName(name);
    if (!provider || !req.rawBody || !provider.verifyWebhook(req.rawBody, headers)) throw new UnauthorizedException();
    const ref = provider.webhookReference(req.body);
    if (ref) await this.payments.confirm(ref).catch(() => undefined); // unknown references (not ours) are ignored; the provider must still get a 200
    return { received: true };
  }
}
