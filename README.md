# Retailr API

Backend for [Retailr](https://github.com/olumuyiwaa/retailr_frontend) — a multi-tenant SaaS where small businesses subscribe, get a public storefront at `/s/<slug>`, and manage everything from a dashboard. A super admin runs the platform.

Built with **NestJS 11 · Prisma 6 · PostgreSQL 16 · TypeScript**.

---

## What's built

| Area | What it does | Where |
|---|---|---|
| **Config & bootstrap** | Config validation (fails fast at boot), Helmet, CORS, global validation pipe, one error shape `{ statusCode, code, message }`, rate limiting, Swagger at `/docs` | `src/config`, `src/setup.ts`, `src/common` |
| **Auth** | Register (with platform discount codes), login, refresh-token rotation with replay detection, logout, `me`; argon2 passwords; global JWT guard with `@Public()` and `@Roles()`; suspended or cancelled businesses are locked out immediately | `src/auth`, `src/common/guards` |
| **Tenant isolation** | `prisma.forBusiness(id)` scopes every query on a tenant model and blocks cross-tenant writes | `src/prisma/tenant.ts` |
| **Plans** | Public `GET /plans`, `POST /plan-coupons/validate`; each plan carries the storefront theme ids it includes | `src/plans` |
| **Catalogue** | Categories (cover picture, rename keeps products, delete uncategorises), products (variants with stable ids, up to 6 photos, specs, plan product limit enforced under concurrency), services (no stock, optional duration, bookable switch, options), filters and paging | `src/catalogue` |
| **Image uploads** | Signed PUT URLs for S3-compatible storage (or a local driver for development), type/size validation, files tied to their business | `src/storage` |
| **Storefront & orders** | Public store, coupon check, `placeOrder` (per-business advisory lock, guarded stock and coupon updates, atomic order numbers, plan limits), order status changes with restock, record a sale, customers and detail | `src/store`, `src/orders` |
| **Business extras** | Coupons, customer groups (manual and rule-based, computed at read time), messages (email and SMS, sent in the background), team invites with plan limits, profile and theme, payment options a store's checkout offers (`paymentMethods`, `bankDetails`) | `src/business` |
| **Reports & overview** | `GET /business/overview` (KPIs), `GET /business/reports/sales?days=7\|30\|90\|365` (revenue, trends, splits, leaders) | `src/business/reports.*` |
| **Billing** | Usage (including real upload size), invoices, change plan with platform discount codes (one redemption per business, last-use serialised, code rules carried) | `src/billing` |
| **Platform admin** | Overview (MRR, signups, churn, GMV), businesses with approve/suspend/cancel, subscriptions, invoices, plans, discount codes, audit log | `src/platform` |
| **Analytics** | `POST /track` (public, de-duplicated, bounded); business and platform analytics with funnel steps counting distinct visits; "placed an order" counts visits that ordered | `src/analytics` |
| **Subscription payments** | Paystack and Flutterwave adapters; checkout, signed webhooks, renewals, dunning and trial jobs | `src/payments`, `src/jobs`, `src/billing` |
| **Bookings** | Opening hours, 30-minute slots, capacity per service, public booking and cancel links, team calendar (month/week/day view) | `src/bookings` |
| **Calendar feeds** | Private iCalendar links per user, hashed tokens, revocable; Booking data exported to Google/Apple/Outlook | `src/calendar` |
| **Notifications** | In-app (new orders, low/out-of-stock, new sign-ups for platform); browser push via Web Push (optional VAPID keys) | `src/notifications` |
| **Email & SMS** | SMTP or log driver for email; Termii or log driver for SMS; team invites, order receipts, customer messages with `{{first_name}}` / `{{store}}` substitution | `src/mail`, `src/sms` |
| **Search** | Single endpoint searches orders, customers, products and services across a business | `src/search` |
| **Audit log** | Platform and sensitive business actions recorded with actor, target and metadata | `src/audit` |
| **Database** | Full PostgreSQL schema, migrations, seed (plans + super admin + discount codes), demo seed (Scentora perfume shop) | `prisma/` |
| **Tests** | ~200 end-to-end tests against a real database, including tenant isolation and the order transaction | `test/` |

For full endpoint details see [`docs/API.md`](./docs/API.md). For deployment see [`docs/DEPLOY.md`](./docs/DEPLOY.md). For frontend integration see [`docs/FRONTEND.md`](./docs/FRONTEND.md).

---

## Quick start

```bash
cp .env.example .env            # fill in JWT_ACCESS_SECRET and SEED_SUPER_ADMIN_PASSWORD at minimum
npm install                     # also runs prisma generate (postinstall)
npm run db:up                   # starts Postgres 16 via Docker Compose
npx prisma migrate deploy       # apply migrations (use npm run prisma:migrate while developing schema)
npm run seed                    # creates plans, super admin and platform discount codes
npm run seed:demo               # optional: "Scentora" demo shop at /s/scentora
npm run start:dev               # http://localhost:4000/api/v1  ·  Swagger at /docs
```

The Prisma client uses `engineType = "client"` with the `@prisma/adapter-pg` driver adapter — no native binary to download.

### Other scripts

| Script | What it does |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm run start:prod` | Run compiled output (`node dist/main`) |
| `npm test` | E2E tests (requires a migrated, seeded `DATABASE_URL`) |
| `npm run typecheck` | TypeScript type-check without emitting |
| `npm run prisma:migrate` | Create and apply a new migration (development) |
| `npm run prisma:deploy` | Apply pending migrations (production / CI) |

---

## Environment variables

Copy `.env.example` to `.env` and fill in:

### Required for any environment

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | Random secret for access tokens — `openssl rand -base64 48` |
| `CORS_ORIGINS` | Comma-separated browser origins, e.g. `http://localhost:3000` |

### Authentication & sessions

| Variable | Default | Description |
|---|---|---|
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime in days |

### URLs & seeding

| Variable | Description |
|---|---|
| `APP_PUBLIC_URL` | Web app URL (used in email links), e.g. `http://localhost:3000` |
| `API_PUBLIC_URL` | This API's public URL (used for local file links), e.g. `http://localhost:4000` |
| `SEED_SUPER_ADMIN_EMAIL` | Email for the seeded super admin |
| `SEED_SUPER_ADMIN_PASSWORD` | Password for the seeded super admin |

### Image storage

| Variable | Default | Description |
|---|---|---|
| `STORAGE_DRIVER` | `local` | `local` (dev only) or `s3` (production) |
| `LOCAL_UPLOAD_DIR` | `./uploads` | Directory for local uploads |
| `UPLOAD_MAX_BYTES` | `2097152` | Max upload size (2 MB) |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Required when `STORAGE_DRIVER=s3` |
| `STORAGE_PUBLIC_URL` | — | CDN / bucket public base URL for S3 mode |

### Email

| Variable | Default | Description |
|---|---|---|
| `MAIL_DRIVER` | `log` | `log` (prints to console) or `smtp` |
| `SMTP_URL` | — | e.g. `smtps://user:pass@smtp.example.com:465` |
| `MAIL_FROM` | `Retailr <noreply@retailr.com>` | From address |

### SMS

| Variable | Default | Description |
|---|---|---|
| `SMS_DRIVER` | `log` | `log` or `termii` |
| `TERMII_API_KEY` | — | Required when `SMS_DRIVER=termii` |
| `SMS_SENDER` | `Retailr` | Registered Termii sender name |

### Subscription payments

| Variable | Default | Description |
|---|---|---|
| `PAYMENTS_DRIVER` | `none` | `none`, `paystack`, `flutterwave`, or `paystack,flutterwave` (first = default) |
| `PAYSTACK_SECRET_KEY` | — | `sk_live_…` or `sk_test_…` |
| `FLUTTERWAVE_SECRET_KEY` | — | `FLWSECK-…` |
| `FLUTTERWAVE_SECRET_HASH` | — | Random string — also set in Flutterwave dashboard |
| `JOBS_ENABLED` | `true` | Set `false` on extra instances to run jobs on one instance only |
| `DUNNING_GRACE_DAYS` | `7` | Days a store stays open after a failed renewal |

### Browser push notifications (optional)

```bash
npx web-push generate-vapid-keys   # run once; keep the private key secret
```

| Variable | Description |
|---|---|
| `VAPID_PUBLIC_KEY` | Generated public key |
| `VAPID_PRIVATE_KEY` | Generated private key (never expose) |
| `VAPID_SUBJECT` | Contact `mailto:` or `https:` URL |

Leave both keys empty to disable push. In-app notifications still work without them.

### Storefront card payments (demo)

| Variable | Default | Description |
|---|---|---|
| `DEMO_CARD_PAYMENTS` | `true` | `true` makes card orders count as paid immediately (dev/demo only). Set `false` in production once real card payments are integrated. |

### Networking

| Variable | Default | Description |
|---|---|---|
| `TRUST_PROXY` | `0` | Number of reverse proxies / load balancers in front of the API — needed for correct IP-based rate limiting and analytics |

---

## Architecture

### Multi-tenancy

A business admin's `businessId` comes **only from the verified access token**, never from the URL or body. Every tenant query goes through `prisma.forBusiness(id)`:

```ts
const db = this.prisma.forBusiness(user.businessId!);
await db.category.findMany();                  // only this business's rows
await db.category.create({ data: { name } }); // businessId is stamped automatically
```

Child tables without a `businessId` column (ProductImage, ProductVariant, OrderItem, CustomerGroupMember) must be reached through their parent.

### Roles

| Role | Prefix | Description |
|---|---|---|
| `SUPER_ADMIN` | `/platform/*` | Retailr platform team |
| `BUSINESS_ADMIN` | `/business/*` | Store owners and staff |
| Public | `/store/*`, `/plans`, `/track`, `/auth/*` | Rate-limited, no token required |

### Money

- `Decimal(12,2)` in the database, serialised as numbers in JSON — never JavaScript floats in arithmetic.
- Business amounts are in the business's own currency. Plan prices, subscriptions, invoices and platform discounts are USD.

### Transactions

Stock decrements, order creation and coupon usage run inside a single `prisma.$transaction` with a guarded update:

```sql
UPDATE product SET stock = stock - $qty WHERE id = $id AND stock >= $qty
```

This prevents two shoppers buying the last item without pessimistic locks.

### Response shape

Enums go out lower-case (`OUT_OF_STOCK` → `"out_of_stock"`), decimals go out as numbers, `createdAt` goes out as `joinedAt` on businesses/customers and `startedAt` on subscriptions. All mapping happens in `src/common/serializers/index.ts` — never in controllers.

### Storefront themes

The `Plan.themes` array lists the storefront theme ids a plan includes (`classic` is always present). `PATCH /business/profile` with a theme id outside that list returns `403 THEME_NOT_IN_PLAN`. The platform admin sets `themes` per plan via `PUT /platform/plans/:id`.

The theme id is also validated against `THEME_IDS` in `src/business/dto/business.dto.ts`. When adding a new theme, update both that constant and the `Plan.themes` default in `prisma/schema.prisma`.

---

## Project structure

```
src/
  analytics/        POST /track ingest + GET /analytics/* read endpoints
  audit/            AuditLog writes and the admin read endpoint
  auth/             Register, login, refresh, logout, me, password reset, email verify, invites
  billing/          Usage, invoices, plan changes, billing view
  bookings/         Bookable services, slot availability, public booking + cancel, calendar
  business/         Profile, coupons, groups, messages, team, reports, overview
  calendar/         iCalendar feed generation and token management
  catalogue/        Categories, products, services, variants, images, uploads
  common/           Guards, decorators, error classes, serializers, AppError
  config/           Config schema (validated at boot with Joi / class-validator)
  health/           GET /health
  jobs/             Scheduled jobs: trial expiry, renewal, dunning, cleanup
  mail/             SMTP and log email drivers
  notifications/    In-app notifications + Web Push
  orders/           Order management, status updates, record a sale
  payments/         Paystack + Flutterwave adapters, checkout, webhooks
  plans/            Public plans endpoint, plan coupon validation
  platform/         Super admin: overview, businesses, plans editor, subscriptions, invoices, coupons
  prisma/           PrismaService + TenantService (forBusiness)
  search/           Cross-entity search (orders, customers, products, services)
  sms/              Termii and log SMS drivers
  storage/          S3 and local storage drivers, presigned URLs
  store/            Public storefront: store info, products, coupons, place order, order by token
prisma/
  schema.prisma     Full PostgreSQL schema
  migrations/       Applied migration files
  seed.ts           Plans, super admin, platform discount codes
  seed-demo.ts      "Scentora" demo perfume shop
docs/
  API.md            Every endpoint, rules and error codes
  DEPLOY.md         Production deployment guide
  FRONTEND.md       Frontend integration notes (payments, invites, analytics)
```

---

## Ground rules

1. **Never trust the request body for `businessId`.** Always derive it from `@CurrentUser()`.
2. **All tenant queries through `prisma.forBusiness(id)`.** Cross-tenant access must be impossible to write by accident.
3. **Money as `Decimal`.** `Decimal(12,2)` in DB, serialised as numbers. Never `parseFloat` or `Number()` on money values.
4. **Transactions for anything that touches stock, orders or customer totals.**
5. **Errors have a `code`.** `{ statusCode, code, message }` — the frontend shows `message` verbatim; keep wording consistent with `docs/API.md`.
6. **Lists are paginated.** `page`, `limit` (default 50, max 200), `q` and named filters from day one.
7. **Never store data URLs.** Images go to storage; the DB holds only the URL.
8. **Tests cover tenant isolation.** Log in as business A and confirm that business B's resources are unreachable.

---

## Webhook setup

### Paystack
Dashboard → API Keys & Webhooks → Webhook URL:
```
https://<api-host>/api/v1/webhooks/paystack
```

### Flutterwave
Dashboard → Settings → Webhooks → URL:
```
https://<api-host>/api/v1/webhooks/flutterwave
```
Set "Secret hash" to the same value as `FLUTTERWAVE_SECRET_HASH`. Tick "Receive webhook responses".

Webhooks are a speed-up, not the source of truth. The billing page also confirms on return and a background job resolves anything left pending.

---

## Not done yet

- **Online card payments at storefront checkout** — the `DEMO_CARD_PAYMENTS=true` flag makes card orders count as paid immediately. Real shopper card payments (Paystack Inline, Flutterwave Inline, or a third provider) are not yet integrated.
- **Delivery fees and zones.**
- **Customer accounts** for shoppers (saved addresses, order history) — guest checkout is the default today.
- **Subdomain routing / custom domains.**
- **Stripe adapter** for subscription billing.
- **Deposit on booking.**
- **Each business connects their own Paystack or Flutterwave account (or alternatively a subaccount under platform).**
  ```
  WHY:
  
  -Settlement goes to the seller (easier compliance story)
  -Reconciliation is per business
  ```
---

## The web app

The Next.js frontend ([retailr_frontend](https://github.com/olumuyiwaa/retailr_frontend)) talks only to this API. Point its `NEXT_PUBLIC_API_URL` at this server's `/api/v1` address and add its origin to `CORS_ORIGINS` here. Full integration details are in [`docs/FRONTEND.md`](./docs/FRONTEND.md).
