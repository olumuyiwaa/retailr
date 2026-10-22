# Retailr API

Backend for [Retailr](https://github.com/olumuyiwaa/retailr_frontend), a multi-tenant SaaS where small businesses subscribe, get a public storefront at `/s/<slug>` and run it from a business admin, with a super admin for the platform. This repo starts from a spec derived from the frontend's domain types (`src/types/saas.ts`) and mock services (`src/services/*.ts`), so the API matches what every screen already expects.

**Status:** the API is built and tested (NestJS, Prisma 6, PostgreSQL) and the web app uses it. Still to build: online card payments at storefront checkout, and delivery fees (see "Later").

| Done | Where |
| --- | --- |
| Config validation (fails fast at boot), helmet, CORS, global validation, one error shape `{ statusCode, code, message }`, rate limiting, Swagger at `/docs` | `src/config`, `src/setup.ts`, `src/common` |
| Auth: register (with platform discount codes), login, refresh-token rotation with replay detection, logout, `me`; argon2 passwords; global JWT guard with `@Public()` and `@Roles()`; suspended or cancelled businesses are locked out immediately, even with a token they already hold | `src/auth`, `src/common/guards` |
| Tenant isolation: `prisma.forBusiness(id)` scopes every query on a tenant model and blocks cross-tenant writes | `src/prisma/tenant.ts` |
| Public `GET /plans` and `POST /plan-coupons/validate` | `src/plans` |
| Catalogue: categories (cover picture, rename keeps products, delete uncategorises), products (variants with stable ids, photos, details, plan product limit enforced under concurrency), filters and paging | `src/catalogue` |
| Image uploads: signed PUT URLs for S3-compatible storage (or a local driver for development), type and size limits, files tied to their business | `src/storage` |
| Full PostgreSQL schema, first migration, seed (plans, super admin, discount codes) | `prisma/` |
| Storefront and orders: public store, coupon check, `placeOrder` (per-business advisory lock, guarded stock and coupon updates, atomic order numbers, plan limits), order status changes with restock, record a sale, customers and detail | `src/store`, `src/orders` |
| Business extras: coupons, customer groups (manual and rule-based, computed at read time), messages (email and SMS, sent in the background), team invites with plan limits, profile and theme, and the payment options a store's checkout offers (`paymentMethods`, `bankDetails`) | `src/business` |
| Dashboard overview and sales report (`GET /business/overview`, `GET /business/reports/sales?days=7\|30\|90\|365`): paid-order revenue, trends vs the previous period, splits, leaders | `src/business/reports.*` |
| Billing: usage (including real upload size), invoices, change plan with platform discount codes (one redemption per business, last use serialised, carried-code rules) | `src/billing` |
| Platform admin: overview (MRR, signups, churn, GMV), businesses with approve/suspend/cancel, subscriptions, invoices, plans, discount codes | `src/platform` |
| Visit tracking (`POST /track`, public, de-duplicated, bounded) and analytics for businesses and the platform; funnel steps count distinct visits, and "placed an order" counts visits that ordered | `src/analytics` |
| Subscription payments (Paystack, pluggable provider): checkout, signed webhook, renewals, dunning and trial jobs | `src/payments`, `src/jobs`, `src/billing` |
| Audit log of platform and sensitive business changes | `src/audit` |
| Services alongside products (`kind`, no stock, never sold out) and one search over orders, customers and products | `src/catalogue`, `src/search` |
| Password reset and email verification (single-use hashed links, sessions revoked on reset) | `src/auth`, `src/mail` |
| Calendar subscription links: private iCalendar feed of bookings for Google, Apple and Outlook (hashed, revocable) | `src/calendar` |
| Bookable services: opening hours, 30-minute slots, capacity per service, public booking and cancel links, team calendar | `src/bookings` |
| Notifications for admins: in-app (new orders, low and sold-out stock, new sign-ups for the platform) plus browser push (Web Push, optional VAPID keys) | `src/notifications` |
| SMS (Termii or log driver) and email (SMTP or log driver): team invites with accept-invite, receipts, customer messages with `{{first_name}}` and `{{store}}` filled in | `src/mail`, `src/auth`, `src/business` |
| About 200 end-to-end tests against a real database (including tenant isolation) | `test/` |

Deploying: see `docs/DEPLOY.md` and the `Dockerfile`. Switching the web app over: `docs/FRONTEND.md`.

## Run it

```bash
cp .env.example .env            # then set JWT_ACCESS_SECRET and SEED_SUPER_ADMIN_PASSWORD
npm install                     # also runs prisma generate
npm run db:up                   # Postgres 16 via docker compose (or point DATABASE_URL at your own)
npx prisma migrate deploy       # use `npm run prisma:migrate` while developing schema changes
npm run seed
npm run seed:demo               # optional: "Scentora", a demo perfume shop at /s/scentora (demo@scentora.example / Demo@12345)
npm run start:dev               # http://localhost:4000/api/v1, docs at /docs
npm test                        # needs DATABASE_URL pointing at a migrated, seeded database
```

The Prisma client uses `engineType = "client"` with the `@prisma/adapter-pg` driver adapter, so there is no native query-engine binary to download.

### Using the tenant client

Everything a business admin does should go through `prisma.forBusiness(user.businessId)` (the id comes from the verified token, see `@CurrentUser()`), never the bare `prisma` client:

```ts
const db = this.prisma.forBusiness(user.businessId!);
await db.category.findMany();                 // only this business's rows
await db.category.create({ data: { name } }); // businessId is stamped for you
```

Child tables without a `businessId` (ProductImage, ProductVariant, OrderItem, CustomerGroupMember) must be reached through their parent, e.g. `db.product.findFirst({ where: { id }, include: { variants: true } })`.

| File | What it is |
| --- | --- |
| [`prisma/schema.prisma`](./prisma/schema.prisma) | PostgreSQL data model (validated against Prisma 6.19) |
| [`docs/API.md`](./docs/API.md) | Every endpoint, who may call it, and the business rules each one must enforce |

## Stack

NestJS + Prisma + PostgreSQL, TypeScript. Suggested extras: `class-validator` for DTOs, `@nestjs/jwt` + `argon2` for auth, `@nestjs/throttler` for rate limits, BullMQ + Redis for background jobs, S3-compatible storage (Cloudflare R2 or S3) for images, Paystack or Flutterwave for subscription billing.

## Ground rules

1. **Multi-tenancy.** A business admin's `businessId` comes from the access token, never from the URL or body. Every tenant query goes through one place (a `TenantService` or Prisma extension) that adds `where: { businessId }`. Cross-tenant access should be impossible to write by accident. Add a test that logs in as business A and tries to read or change each of business B's resources.
2. **Roles.** `SUPER_ADMIN` calls `/platform/*`. `BUSINESS_ADMIN` calls `/business/*`. Storefront endpoints under `/store/*`, plus `/plans`, `/track` and `/auth/*`, are public and rate-limited.
3. **Money.** `Decimal(12,2)` in the database, strings in JSON are fine, never floats in arithmetic. Business amounts are in the business's currency. Plans, subscriptions, invoices and platform discounts are USD.
4. **Transactions.** Anything that touches stock, orders or customer totals runs inside one `prisma.$transaction`, and stock is decremented with a guarded update (`UPDATE ... SET stock = stock - $qty WHERE stock >= $qty`) so two shoppers can't both buy the last item.
5. **Response shape.** Return what the frontend types already describe, with these mappings: enums go out lower-case with underscores (`OUT_OF_STOCK` → `"out_of_stock"`, `IN_STORE` → `"in_store"`); `createdAt` goes out as `joinedAt` on businesses and customers and as `startedAt` on subscriptions; decimals go out as numbers; a product's category goes out as its name; `images[0]` is also sent as `image`. Do the mapping in one serializer layer, not in controllers.
6. **Errors.** `{ "statusCode": 400, "code": "STOCK_INSUFFICIENT", "message": "Only 2 of Silk Wrap Dress (Large) left in stock." }`. The frontend shows `message` as-is, so keep the sentences the mock services already use (they are quoted in `docs/API.md`).
7. **Lists.** The UI currently loads whole lists and searches client-side. Build list endpoints with `page`, `limit` (default 50, max 200), `q` and the filters named in `docs/API.md` from day one, and the frontend can move to server-side paging when needed.
8. **Images.** The mock keeps photos as base64 data URLs. Replace that with an upload endpoint that returns a URL (`POST /business/uploads` → presigned PUT, then send the final URL when saving). Never store data URLs in the database. Validate type (jpeg, png, webp, svg for logos) and size (about 2 MB).

## Suggested build order

1. **Foundation:** Nest project, Prisma, config, global validation pipe, error filter, serializer layer, health check.
2. **Auth:** register, login, refresh, logout, `me`, guards, tenant context, seed script (plans, a super admin, demo business).
3. **Catalogue:** categories, products (variants, images, specs), uploads.
4. **Storefront + orders:** public store endpoints, `placeOrder` (the most important transaction), order management, record a sale, customers and customer detail.
5. **Business extras:** coupons, groups, messages, team, profile and theme, overview and reports.
6. **Platform:** businesses (approve, suspend), plans, subscriptions, invoices, platform overview.
7. **Billing:** payment-provider integration, webhooks, trial expiry and renewal jobs, platform discounts at sign-up and plan change.
8. **Analytics:** `/track` ingest into `AnalyticsDay`, both analytics endpoints.
9. **Hardening:** rate limits, audit log, e2e tests for tenant isolation and the order transaction, OpenAPI docs.

## The web app

The Next.js app ([retailr_frontend](https://github.com/olumuyiwaa/retailr_frontend)) talks to this API only (no mock data any more). Set its `NEXT_PUBLIC_API_URL` to this API's `/api/v1` address and its origin in `CORS_ORIGINS` here. `docs/FRONTEND.md` has the integration notes for checkout payments, invites and analytics tracking.

## Behaviour worth knowing

- **Cancelled or refunded orders** put stock back and take `sold` down; customer totals are recomputed from paid orders whenever an order's payment or status changes.
- **Public order links** use `Order.publicToken`, never the order id, so they can't be guessed.
- **Passwords** are hashed with argon2. Reset and email-verification links are random, single-use, expire, and only their SHA-256 hash is stored; a reset signs every device out. Asking for a link never reveals whether an email has an account. Verification is a reminder, not a gate: nobody is locked out for not confirming.
- **Storage usage** in billing is the real sum of upload sizes. The plan's storage limit is enforced when an upload URL is requested (`PLAN_LIMIT_STORAGE`).
- **Analytics** read `AnalyticsDay`; a business with no data yet shows zeros.
- **Order limits** count online orders and recorded sales alike, per calendar month.
- **Messages.** Email and SMS are sent in the background in this process, five at a time. At high volume this should become a queue with retries. SMS has no per-plan credit limit yet, so every message is paid for by the platform's Termii account.

## Later

- Let one login belong to several businesses (replace `User.businessId` with a membership table).
- Customer accounts for shoppers (optional login, saved addresses, order history), with guest checkout kept as the default.
- Delivery zones and fees, inventory history, expenses and profit, and real card payments at storefront checkout (today the card option only works as a demo, see `DEMO_CARD_PAYMENTS`).
