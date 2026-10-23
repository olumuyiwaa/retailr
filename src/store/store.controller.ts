import { Body, Controller, Get, Header, HttpCode, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../common/decorators";
import { PlaceOrderDto, ValidateCouponDto } from "./dto/store.dto";
import { StoreService } from "./store.service";

const SECONDS = Number(process.env.STORE_CACHE_SECONDS ?? 60);
/** Public listings can be served from a CDN or the browser for a short while: most storefront traffic is these four reads. Checkout re-checks stock and prices, so a stale listing never oversells. */
const LISTING_CACHE = SECONDS > 0 ? `public, max-age=${Math.min(SECONDS, 15)}, s-maxage=${SECONDS}, stale-while-revalidate=${SECONDS * 5}` : "no-store";

/** Everything a shopper can do without signing in. Rate-limited per client. */
@ApiTags("storefront")
@Public()
@Controller("store")
export class StoreController {
  constructor(private readonly store: StoreService) {}

  // declared before the :slug routes so "orders" is never read as a slug
  @Header("Cache-Control", "private, no-store")
  @Get("orders/:token") order(@Param("token") token: string) { return this.store.orderByToken(token); }

  @Header("Cache-Control", LISTING_CACHE) @Get(":slug") get(@Param("slug") slug: string) { return this.store.store(slug); }
  @Header("Cache-Control", LISTING_CACHE) @Get(":slug/products") products(@Param("slug") slug: string) { return this.store.products(slug); }
  @Header("Cache-Control", LISTING_CACHE) @Get(":slug/services") services(@Param("slug") slug: string) { return this.store.services(slug); }
  @Header("Cache-Control", LISTING_CACHE) @Get(":slug/categories") categories(@Param("slug") slug: string) { return this.store.categories(slug); }

  @Throttle({ default: { limit: () => Number(process.env.AUTH_RATE_LIMIT ?? 30), ttl: 60_000 } })
  @HttpCode(200) @Post(":slug/coupons/validate")
  validate(@Param("slug") slug: string, @Body() dto: ValidateCouponDto) { return this.store.validateCoupon(slug, dto.code, dto.subtotal); }

  @Throttle({ default: { limit: () => Number(process.env.AUTH_RATE_LIMIT ?? 10), ttl: 60_000 } })
  @Post(":slug/orders")
  place(@Param("slug") slug: string, @Body() dto: PlaceOrderDto) { return this.store.placeOrder(slug, dto); }
}
