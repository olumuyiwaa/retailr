# Retailr API

Base path `/api/v1`. JSON in and out. Auth is `Authorization: Bearer <accessToken>` (short-lived, about 15 minutes) with a refresh token for renewal. "Rules" below are what the mock services enforce today; the error text is what the UI shows, so keep it.

Legend: 🌐 public (rate-limited) · 🏪 business admin · 👑 super admin.

## Auth

| Endpoint | Who | Notes |
| --- | --- | --- |
| `POST /auth/register` | 🌐 | Body: `ownerName, email, password, businessName, category, country, city, phone, planId, cycle ("monthly"\|"yearly"), couponCode?`. |
| `POST /auth/login` | 🌐 | `{ email, password }` → `{ user, accessToken, refreshToken }`. |
| `POST /auth/refresh` | 🌐 | Rotates the refresh token; revoke the old one. |
| `POST /auth/logout` | any | Revokes the refresh token. |
| `GET /auth/me` | any | `AuthUser`: `{ id, name, email, role, businessId? }`. |
| `POST /auth/forgot-password`, `POST /auth/reset-password` | 🌐 | New; the mock has no reset. |
| `POST /auth/accept-invite` | 🌐 | New; a team member sets a password from the emailed invite token. |

**Register rules**
- Email must be unique (case-insensitive): "An account with this email already exists."
- The plan must exist: "Please choose a plan."
- Validate `couponCode` (see Platform discounts) *before* creating anything, so a bad code leaves no half-made account.
- Slug comes from the business name (`&` → `and`, non-alphanumerics → `-`); on a clash append `-2`, `-3`, ...
- Store currency comes from the country (Nigeria NGN, Ghana GHS, Kenya KES, otherwise USD).
- Paid plan: business `TRIAL`, subscription `TRIALING`, 14-day trial (`trialEndsAt = currentPeriodEnd`). Free plan: business `ACTIVE`, subscription `ACTIVE`, no trial.
- `Subscription.amount` is the price for the chosen cycle net of the discount.
- Also create the owner `TeamMember` (role OWNER, ACTIVE) and the `User` (BUSINESS_ADMIN). If you want an approval queue, create the business as `PENDING` instead and let a super admin activate it.

**Login rules**: wrong email or password gives "Invalid email or password."; a `SUSPENDED` business gives "This business account is suspended. Contact Retailr support."; `CANCELLED` gives "This business account has been cancelled." (HTTP 403).

## Public: pricing, storefront, tracking

Invites: `GET /auth/invite/:token` previews `{ name, email, role, businessName }`; `POST /auth/accept-invite { token, password }` creates the login and returns a session. Links are valid for 7 days, work once, and point to `APP_PUBLIC_URL/admin/accept-invite?token=...` (the frontend page still needs building). Customer messages (email and SMS) are sent in the background as the message is recorded.

`POST /track` notes: 1–50 events per batch; visitors are counted once per day and sessions once per `sessionId` (kept as hashed markers in `AnalyticsSeen`, pruned after two days); the first event of a new session supplies source, device and country. Page paths are reduced to a fixed set (`/`, `/shop`, `/product`, `/cart`, `/checkout`, `/get-started`, `/pricing`, `/features`, else `other`), product ids must be live products of that store, unknown or closed stores and bots are ignored with a 202, and the endpoint is rate-limited (`TRACK_RATE_LIMIT`, default 120 a minute per IP). Analytics windows are counted back from today in UTC.

| Endpoint | Returns / does |
| --- | --- |
| `GET /plans` 🌐 | Active plans (`Plan`), for the pricing page, sign-up and billing. |
| `POST /plan-coupons/validate` 🌐 | `{ code, planId }` → `PlanCoupon` or an error. Business-restricted codes only validate for that business (send the token when logged in). |
| `GET /store/:slug` 🌐 | `PublicStore` (`id, name, slug, category, description, phone, city, country, brandColor, theme, logo, currency`). 404 "This store isn't available right now." unless the business is `ACTIVE` or `TRIAL`. |
| `GET /store/:slug/products` 🌐 | Non-draft products (sold-out ones stay visible but can't be bought), with images, variants and specs. |
| `GET /store/:slug/categories` 🌐 | `[{ name, image? }]`: the business's categories that currently have at least one non-draft product, sorted by name. |
| `POST /store/:slug/coupons/validate` 🌐 | `{ code, subtotal }` → `{ code, discount }`. Doesn't use the code up. |
| `POST /store/:slug/orders` 🌐 | Place an order (below). Returns the `Order` including `publicToken`. |
| `GET /store/orders/:publicToken` 🌐 | The order plus the store, for the confirmation and invoice pages. Looked up by the unguessable token only (the order id never works). |
| `POST /track` 🌐 (built) | Batched events: `{ scope: businessId \| "platform", visitorId, sessionId, events: [{ type: "page"\|"product"\|"add_to_cart"\|"checkout", path, productId?, source, device, country }] }`. Fire-and-forget (202); upsert into `AnalyticsDay` by `(scope, date)`. Count a visitor once per day and a session once per sessionId. |

**Place order**: body `{ customer: { name, email, phone }, shippingAddress, notes?, paymentMethod, couponCode?, items: [{ productId, variantId?, qty }] }`. In one transaction:
1. Business must be `ACTIVE` or `TRIAL`: "This store isn't available right now." Cart must be non-empty: "Your cart is empty."
2. Plan limit `maxOrdersPerMonth` (unless -1): "This store isn't taking new orders right now. Please try again later."
3. For each line: product exists, belongs to the business and isn't a draft ("One of the items in your cart is no longer available."); qty is a whole number ≥ 1; with variants, `variantId` is required ("Please choose an option for {product}.") and its stock is checked ("{name} ({variant}) is sold out." / "Only {n} of {name} ({variant}) left in stock."); without variants, out-of-stock or insufficient stock gives "{name} is sold out." / "Only {n} of {name} left in stock."
4. Item price = variant price if set, else product price. Snapshot `name` ("Name (Variant)") and `price` on the `OrderItem`.
5. Business coupon: must be ACTIVE, unexpired and under `maxUses`, and the subtotal must meet `minOrder`. Messages: "That code isn't valid." / "That code has expired." / "That code has been fully used." / "Spend at least {amount} to use this code." Discount = percent of subtotal or the fixed amount, never more than the subtotal. Increment `usedCount`.
6. `total = subtotal - discount`. `paymentStatus = PAID` only for card payments that the payment provider confirmed (until a provider is wired in, `DEMO_CARD_PAYMENTS=true` marks card orders paid, mirroring the mock); otherwise `UNPAID`. `status = PENDING`.
7. Customer: find by `(businessId, lower(email))`, otherwise create. Order number: increment `Business.orderSeq` atomically and format `#` + first two letters of the slug upper-cased + the sequence (e.g. `#AD1180`).
8. Decrement variant and product stock with the guarded update, add to `product.sold`, and set product `OUT_OF_STOCK` when stock reaches 0. If the order is paid, add to the customer's `ordersCount` and `totalSpent`.

## Business admin (`/business/*`, 🏪)

### Overview, reports, analytics
| Endpoint | Returns |
| --- | --- |
| `GET /business/overview` | `BusinessOverview` (30-day revenue and order counts with change vs the previous 30 days, customers, average order value, revenue series, orders by status, top products, low stock, recent orders, pending and unpaid counts, fulfilment and cancel rates, product counts, team size). Revenue counts paid orders only. Low stock = non-draft products with stock ≤ 6. |
| `GET /business/reports/sales?days=7\|30\|90\|365` | `SalesReport`: totals with change vs the previous period, series, by channel, by payment method, top products, top customers, money still owed. |
| `GET /business/analytics?days=7\|30\|90\|365` | `BusinessAnalytics` from `AnalyticsDay` (visitors, sessions, page views, conversion = online orders per 100 sessions, funnel visit → product view → add to cart → checkout → order, pages, sources, devices, countries, top products). Previous-period change is computed the same way. |

### Products and categories
| Endpoint | Notes |
| --- | --- |
| `GET /business/products` | Optional `q` (name or SKU), `status`, `categoryId`, `page` (default 1), `limit` (default 100, max 200). The body is the page of products; the total is in the `X-Total-Count` header. |
| `GET /business/products/:id` | One product. |
| `POST /business/products`, `PUT /business/products/:id` | Body: `name, sku, category (name), description, price, stock, status, images[], variants[], specs[]`. |
| `DELETE /business/products/:id` | Order history keeps its snapshots (`OrderItem.productId` becomes null). |
| `GET /business/categories` | Each with `productCount`. |
| `POST /business/categories`, `PATCH /business/categories/:id`, `DELETE /business/categories/:id` | Delete leaves products uncategorised and returns `{ uncategorised }`. Rename keeps products attached (they point at the category id). |
| `POST /business/uploads` | `{ kind: "product"\|"category"\|"logo", contentType, size }` → `{ method: "PUT", uploadUrl, headers, publicUrl, maxBytes, expiresInSeconds }`. JPG, PNG, WebP or GIF only (no SVG, which can carry scripts), up to `UPLOAD_MAX_BYTES` (2 MB). PUT the bytes to `uploadUrl` with the given headers, then save `publicUrl` on the product, category or business. Keys start with the business id; saving a URL that isn't the business's own upload fails with `IMAGE_NOT_OWNED`. |

**Product rules**
- Max 6 photos: "A product can have up to 6 photos." `images[0]` is the cover; omit `images` to leave them unchanged, send `[]` to remove all. Photos are URLs from `/business/uploads`, never data URLs.
- `PUT` replaces the variants: omit them or send `[]` for none. Send a variant's `id` to keep that row (order history points at it); variants missing from the list are deleted.
- Max 10 specs: "A product can have up to 10 details." Each needs both a name and a value ("Each product detail needs both a name and a value."), names under 30 characters and values under 120. Omit to leave unchanged, `[]` to clear.
- Variants: every variant needs a name ("Every variant needs a name."), names are unique within the product, case-insensitively ("Two variants are both called \"{name}\"."), stock is a whole number ≥ 0, price optional and ≥ 0. When variants exist, `product.stock` is forced to the sum of their stock.
- Category must be one of the business's own, matched case-insensitively and stored by its canonical name: "\"{name}\" isn't one of your categories. Add it under Categories first." Blank means uncategorised.
- A product saved as `ACTIVE` with stock 0 becomes `OUT_OF_STOCK`.
- Creating one beyond the plan's `maxProducts` (unless -1) fails: "Your {plan} plan is limited to {n} products. Upgrade to add more."
- Category names are unique per business, case-insensitively; names are trimmed.

### Orders, sales, customers
| Endpoint | Notes |
| --- | --- |
| `GET /business/orders` | `q` (number or customer), `status`, `paymentStatus`, `channel`, `from`, `to`, `page`, `limit`. Total in the `X-Total-Count` header. |
| `PATCH /business/orders/:id/status` | `{ status }`. `REFUNDED` sets payment to `REFUNDED`; `CANCELLED` sets it to `UNPAID`; moving an unpaid order to any status other than pending marks it `PAID`. **Also**: return stock when moving to cancelled or refunded, and recompute the customer's totals. |
| `POST /business/orders/:id/receipt` | Emails the receipt to the customer's address, then sets `receiptSentAt`. 400 `NO_CUSTOMER_EMAIL` for walk-ins without an email; 502 `MAIL_FAILED` if the mail can't go out (and `receiptSentAt` stays unset). |
| `POST /business/sales` | Record a sale made outside the storefront (below). |
| `GET /business/customers` | `q`, `groupId`. Each row: `id, name, email, phone, city, orders, totalSpent, joinedAt`. |
| `GET /business/customers/:id` | `CustomerDetail`: the customer, their orders (newest first), group names, average paid order value, last order date and last delivery address. |

Orders keep a nullable `customerId` (walk-in sales have none; the API returns `"walk_in"` for them, and deleting a customer keeps their orders). Reopening a cancelled or refunded order takes the stock again and fails with the sold-out message if it's gone.

**Record a sale**: body `{ customerId? | newCustomer?: { name, phone?, email? }, items: [{ productId, variantId?, qty, price? }], channel, paymentMethod, paid, handedOver, discount?, notes? }`. Rules: business must be `ACTIVE` or `TRIAL` ("Your store isn't active, so new sales can't be recorded."); at least one item ("Add at least one product to the sale."); monthly order limit ("You've reached this month's order limit on your plan. Upgrade to record more sales."); the same stock checks as checkout; a custom `price` overrides the item price; `discount` is a flat amount and can't exceed the subtotal ("The discount can't be more than the sale total."); an unknown `customerId` gives "That customer no longer exists."; a provided email must look valid ("Enter a valid customer email, or leave it blank."); a missing customer becomes a walk-in. Status is `DELIVERED` when `handedOver`, otherwise `PROCESSING`; payment is `PAID` or `UNPAID` from `paid`. Stock, `sold` and customer totals update as in checkout.

### Customer groups and messages
| Endpoint | Notes |
| --- | --- |
| `GET /business/groups` | Each with `memberCount`. |
| `GET /business/groups/:id/members` | Customers. |
| `POST /business/groups`, `PUT /business/groups/:id`, `DELETE /business/groups/:id` | Names unique per business ("You already have a group with that name."). Auto groups need a valid rule value ("Enter a valid number for the rule."). |
| `GET /business/messages/audience?type=all\|group&groupId&channel=email\|sms` | `{ count, skipped, label, sampleName }`: customers without an email (for email) or phone (for SMS) are skipped. |
| `GET /business/messages` | Newest first. Each has `delivered` and `failed`, filled in a few seconds after sending (both 0 while still sending). |
| `POST /business/messages` | `{ channel, subject?, body, audience }`. "Write a message first."; email needs a subject ("Add a subject for the email."); SMS is capped at 480 characters; no reachable recipients gives "No customers in this audience can be reached on that channel." Fill `{{first_name}}` and `{{store}}` per customer. Queue delivery. |

**SMS delivery.** `SMS_DRIVER=termii` sends through Termii (`TERMII_API_KEY`, `SMS_SENDER`, optional `TERMII_CHANNEL=generic|dnd`); `log` only logs, for development. Numbers are turned into international form from the business's country (Nigeria 234, Ghana 233, Kenya 254); one that can't be, or that the provider refuses, counts as `failed`. In Nigeria the sender name must be registered with the provider first. WhatsApp is not a message channel (the API charges per message and needs approved templates); it stays as a sales channel and traffic source.

**Group rules** (computed at read time, never stored): `SPENT_OVER` = total spent > value; `ORDERS_AT_LEAST` = orders ≥ value; `JOINED_WITHIN_DAYS` = joined within value days; `NO_ORDER_WITHIN_DAYS` = last order older than value days, or no order and joined longer ago than value days.

### Coupons, team, billing, profile
Implemented so far: coupons, team, profile, groups and messages. `PUT` on a coupon or group replaces the editable fields (omitted optional fields are cleared). Unknown body fields are stripped, so slug, plan and status can't be changed through the profile. Messages are delivered when sent (email and SMS); team invites store only a hashed token and are emailed.
| Endpoint | Notes |
| --- | --- |
| `GET/POST/PUT/DELETE /business/coupons`, `PATCH /business/coupons/:id/status` | Code is upper-cased, 3–20 of A–Z, 0–9 and `-` ("Use 3–20 letters, numbers or dashes for the code."); value > 0 ("Enter a discount greater than zero."); percent ≤ 100 ("A percentage can't be more than 100."); unique per business ("You already have a code with that name."). |
| `GET /business/team` | Members. |
| `POST /business/team` | `{ name, email, role: "manager"\|"staff" }`. Limited by plan `maxStaff` ("Your {plan} plan allows {n} team members. Upgrade to invite more."); duplicate email gives "That person is already on your team." Create as `INVITED`, email an invite link. |
| `POST /business/team/:id/resend` | New invite link for someone who hasn't joined (the old one stops working). |
| `DELETE /business/team/:id` | The owner can't be removed: "The owner cannot be removed." |
| `GET /business/billing` | `{ plan, subscription, usage, invoices, plans }`. Usage: products, staff, orders this month, storage (real sum of uploads). |
| `POST /business/billing/change-plan` | `{ planId, cycle, couponCode? }` (below). Returns the refreshed billing view. When payments are on, a paid plan needs checkout instead (below). A business that already redeemed a code isn't blocked by its own use when it changes cycle or re-enters the code. |
| `GET /business/profile`, `PATCH /business/profile` | Editable: `name, description, phone, country, city, brandColor, category, currency, theme, logo`. `logo` is a URL, `null` removes it. Validate `theme` against the known theme ids. |

## Platform discounts (subscription coupons)

A `PlanCoupon` gives a business money off its Retailr subscription. Percent or fixed USD, optional plan list (empty = all paid plans), optional single business, optional `maxUses` and expiry.

Validation (used by `/plan-coupons/validate`, register and change-plan), in this order:
1. Code exists and is ACTIVE: "That discount code isn't valid."
2. Not expired: "That discount code has expired."
3. Under `maxUses`: "That discount code has been fully used."
4. If restricted to a business, it must be that business: "That discount code isn't valid for this business."
5. If restricted to plans, the chosen plan must be one: "That code only works on the {plan names} plan."
6. The plan must be paid: "Discount codes only apply to paid plans."

Pricing: `discount = min(percent of list price, or the fixed USD, list price)`, rounded to cents; `Subscription.amount = list - discount`; store `planCouponId` and `discount`. Redeem once per business per code (`PlanCouponRedemption`, unique), so changing billing cycle on the same plan doesn't use another redemption. `usedCount` in responses = redemption count.

Change plan: validate the code first so a bad one changes nothing. Switching plan without a code drops the discount. Changing only the cycle on the same plan keeps it if it's still valid, and silently drops it otherwise. Moving to a free plan sets the subscription `ACTIVE`, clears the trial and the discount. When billing is real, charge the discounted amount through the payment provider.

## Platform admin (`/platform/*`, 👑)

List endpoints take `page` and `limit` (default 50, max 200) and return the total in `X-Total-Count`. Re-activating a business also clears its subscription's `cancelledAt`. `PUT /platform/plans/:id` creates the plan when the id is new; price changes don't touch what existing subscribers already pay. A deleted discount code leaves the discount already in a subscription's price in place (`discount` stays, `couponCode` goes).

| Endpoint | Notes |
| --- | --- |
| `GET /platform/overview` | `PlatformOverview`: MRR with change, business counts by status, sign-ups in the last 30 days, churn, GMV, 12-month MRR and sign-up series, plan distribution, recent sign-ups, recent invoices. MRR counts non-trial, non-cancelled subscriptions, with yearly amounts divided by 12, and uses the discounted amount. |
| `GET /platform/businesses` | Rows: the business plus `planName` and `mrr`. `q`, `status`, `planId`. |
| `GET /platform/businesses/:id` | Business, plan, subscription, invoices, team, 30-day paid orders and revenue. |
| `PATCH /platform/businesses/:id/status` | `{ status }`. Also moves the subscription: `SUSPENDED` → `PAST_DUE`, `ACTIVE` → `ACTIVE`, `CANCELLED` → `CANCELLED` with `cancelledAt`. Suspended and cancelled businesses can't log in and their storefront goes offline. |
| `GET /platform/subscriptions` | Rows with `businessName`, `planName`, `couponCode`, `discount`. |
| `GET /platform/invoices` | Rows with `businessName`. `status`, `q`. |
| `GET /platform/plans`, `PUT /platform/plans/:id` | Plans with `subscribers` (businesses not cancelled or pending). |
| `GET /platform/plan-coupons`, `POST`, `PUT /:id`, `PATCH /:id/status`, `DELETE /:id` | Rows add `businessName`, `planNames`, `redeemed` (businesses using it) and `discountPerMonth` (sum over live subscriptions, yearly ÷ 12). Same code rules as business coupons; deleting a code leaves existing discounts in place. |
| `GET /platform/analytics?days=7\|30\|90\|365` | `PlatformAnalytics`: the marketing-site funnel (visit → sign-up page → sign-ups from real `Business` rows), plus totals across all storefronts and the busiest stores. |

## Team roles

Every request from a business login is checked against the person's current team role (read fresh each time, so removing someone or changing their role takes effect at once; a removed member gets 403 `TEAM_ACCESS_REVOKED`). A role that is too low gets 403 `INSUFFICIENT_ROLE`. `GET /auth/me` and the login response carry `teamRole` (`owner`, `manager` or `staff`).

| Role | Can |
|---|---|
| **Staff** | Orders (view, change status, send receipts), record sales, customers, read products and categories, the dashboard overview, read the store profile. |
| **Manager** | Everything staff can, plus change products, categories and uploads, customer groups, messages, shopper coupons, sales reports, site analytics, and view the team. |
| **Owner** | Everything, plus billing and plan changes, inviting/removing team members, editing store settings, and the audit log. |

In code: `@MinRole("MANAGER")` on a route or controller (the method wins over the class); routes without it are open to the whole team.

## Audit log

`GET /business/audit` (a business's own history) and `GET /platform/audit` (everything; filter `businessId`, `action`). Paged, newest first: `{ id, at, action, actorRole, actorEmail, businessId, targetId, meta }`. Every successful change under `/platform/*` and `/business/{coupons,team,billing,profile,groups}` is recorded as `"<METHOD> <route>"` with the field names changed (plus short scalar values, never anything that looks like a password, token or card). Payments and the non-payment suspension are recorded as `payment.checkout_paid`, `payment.renewal_paid`, `business.suspended_non_payment` with actor `SYSTEM`. Failed requests and reads are not recorded.

## Subscription payments (Paystack)

Switched on with `PAYMENTS_DRIVER=paystack` and `PAYSTACK_SECRET_KEY`. With `none` (the default) plan changes apply directly, as before. `fake` is an in-memory provider for tests and local work and is refused in production.

| Endpoint | Notes |
|---|---|
| `POST /business/billing/checkout` | `{ planId, cycle, couponCode? }` → `{ reference, checkoutUrl, invoice, charge: { amount, currency }, applied }`. Redirect the browser to `checkoutUrl`. Charged in the business's currency (the plan's `localPrices`, scaled by any discount). A 100% discount returns `applied: true` with no URL and the plan switches at once. A provider outage returns 502 `PAYMENT_PROVIDER_ERROR`. |
| `GET /business/billing/verify/:reference` | Call from the page Paystack returns to (`?reference=` on `/admin/business/billing`). Asks the provider and applies the result once: `{ status: "paid"\|"failed"\|"pending", applied }`. Only the business that started it can look it up. |
| `POST /webhooks/paystack` 🌐 | Signed (`x-paystack-signature`, HMAC-SHA512 of the raw body). Bad signature → 401. Never trusts the body: it asks Paystack about the reference, then applies it. Always 200 for valid signatures. |
| `POST /business/billing/change-plan` | When payments are on, a paid target plan returns 402 `PAYMENT_REQUIRED` (use checkout). Free plans still switch directly and drop the saved card. |

`GET /business/billing` also returns `payments: { enabled, provider, cardOnFile }`.

Rules: the amount and currency must match the invoice or the payment is rejected. An invoice is applied exactly once (unique `providerReference`, row lock), however many times it's reported. A successful first payment sets `ACTIVE`, ends the trial, stores the reusable card, starts a period, redeems the discount code and emails a receipt. There is no proration: a plan change starts a fresh period. Paying lifts a `NON_PAYMENT` suspension, never an `ADMIN` one (`Business.suspensionReason`).

## Background jobs

`JobsService` runs hourly (and once on boot) unless `JOBS_ENABLED=false`; every step is safe to run twice or on several servers.

- **Trial reminder:** 3 days before `trialEndsAt`, once.
- **Trial expiry:** an unpaid ended trial becomes `PAST_DUE`; the owner is emailed. The store stays up.
- **Renewals:** at `currentPeriodEnd`, charge the saved card (reference `renew_<sub>_<period>_<attempt>`). Free or fully discounted subscriptions roll on without a charge. No card on file → `PAST_DUE`.
- **Dunning:** a `PAST_DUE` subscription retries once a day; after `DUNNING_GRACE_DAYS` (default 7) the business is suspended with reason `NON_PAYMENT`.
- **Stale payments:** a renewal still pending after an hour is resolved by asking the provider. Checkouts unpaid after 24 h are marked `FAILED`.
- **Nightly (02:00 UTC):** prune expired refresh tokens and old analytics dedupe rows; recompute customer totals from paid orders.

Still open: Flutterwave/Stripe adapters behind the same `PaymentProvider` interface.
