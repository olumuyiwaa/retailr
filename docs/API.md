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
| `POST /auth/forgot-password` | 🌐 | `{ email }` → 204 whether or not the email has an account. Mails a link to `APP_PUBLIC_URL/admin/reset-password?token=...` (valid 60 minutes, one use). One mail per account per minute. |
| `POST /auth/reset-password` | 🌐 | `{ token, password }` → 204. Sets the password, signs the account out on every device, and counts as proof of the inbox (confirms the email). Bad, used or expired token: 400 `RESET_INVALID`. |
| `POST /auth/verify-email` | 🌐 | `{ token }` → 204. The link mailed at sign-up (`/admin/verify-email?token=...`, valid 48 hours, one use). 400 `VERIFY_INVALID` otherwise. |
| `POST /auth/resend-verification` | 🔑 | 204; a fresh link replaces the old one. Does nothing once verified. |
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

Each `Plan` has `themes`: the storefront theme ids it includes (`classic` is always there). The platform admin sets them in `PUT /platform/plans/:id` (`themes: string[]`, validated against `classic | showcase | atelier | market | shop | bazaar`; omitted = all). `PATCH /business/profile` with a theme outside the plan returns 403 `THEME_NOT_IN_PLAN`; after a downgrade the public storefront renders the default theme (no `theme` in the response) until the business upgrades or picks an included one.
| `POST /plan-coupons/validate` 🌐 | `{ code, planId }` → `PlanCoupon` or an error. Business-restricted codes only validate for that business (send the token when logged in). |
| `GET /store/:slug` 🌐 | `PublicStore` (`id, name, slug, category, description, phone, city, country, brandColor, theme, logo, currency, paymentMethods, bankAccount?`). 404 "This store isn't available right now." unless the business is `ACTIVE` or `TRIAL`. |
| `GET /store/:slug/products` 🌐 | Non-draft products (sold-out ones stay visible but can't be bought), with images, variants and specs. |
| `GET /store/:slug/services` 🌐 | Non-draft services, with images, options and specs. |
| `GET /store/:slug/categories` 🌐 | `[{ name, image? }]`: the business's categories that currently have at least one non-draft product or service, sorted by name. |
| `POST /store/:slug/coupons/validate` 🌐 | `{ code, subtotal }` → `{ code, discount }`. Doesn't use the code up. |
| `POST /store/:slug/orders` 🌐 | Place an order (below). Returns the `Order` including `publicToken`. |
| `GET /store/orders/:publicToken` 🌐 | The order plus the store, for the confirmation and invoice pages. Looked up by the unguessable token only (the order id never works). |
| `POST /track` 🌐 (built) | Batched events: `{ scope: businessId \| "platform", visitorId, sessionId, events: [{ type: "page"\|"product"\|"add_to_cart"\|"checkout"\|"order", path, productId?, source, device, country }] }`. Fire-and-forget (202); upsert into `AnalyticsDay` by `(scope, date)`. Count a visitor once per day and a session once per sessionId. The funnel steps count each session once (`productSessions`, `cartSessions`, `checkoutSessions`, `orderSessions`); the storefront sends `order` once an order goes through. |

**Place order**: body `{ customer: { name, email, phone }, shippingAddress, notes?, paymentMethod, couponCode?, items: [{ productId, variantId?, qty } or { serviceId, optionId?, qty }] }` (each line is a product or a service, never both). `paymentMethod` must be one of the store's `paymentMethods`, otherwise 400 `PAYMENT_METHOD_UNAVAILABLE`. In one transaction:
1. Business must be `ACTIVE` or `TRIAL`: "This store isn't available right now." Cart must be non-empty: "Your cart is empty."
2. Plan limit `maxOrdersPerMonth` (unless -1): "This store isn't taking new orders right now. Please try again later."
3. For each line: product exists, belongs to the business and isn't a draft ("One of the items in your cart is no longer available."); qty is a whole number ≥ 1; with variants, `variantId` is required ("Please choose an option for {product}.") and its stock is checked ("{name} ({variant}) is sold out." / "Only {n} of {name} ({variant}) left in stock."); without variants, out-of-stock or insufficient stock gives "{name} is sold out." / "Only {n} of {name} left in stock." A service line has no stock: with options, `optionId` is required (same "Please choose an option" message), the option price replaces the service price, only `sold` moves, and a bookable service is refused with `BOOKING_REQUIRED`.
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

Products and services are separate tables and endpoints. A **product** is stocked (variants, SKU, stock, low-stock alerts). A **service** (a haircut, repair, class…) has no stock and is never sold out; it has an optional `durationMins` (1–1440), priced **options** instead of variants, and can be `bookable`. Plan limits count both together. Existing services were moved out of `Product` by migration `split_services`, keeping their ids, so order and booking history still resolve.
| Endpoint | Notes |
| --- | --- |
| `GET /business/products` | Optional `q` (name or SKU), `status`, `categoryId`, `page` (default 1), `limit` (default 100, max 200). The body is the page of products; the total is in the `X-Total-Count` header. |
| `GET /business/products/:id` | One product. |
| `POST /business/products`, `PUT /business/products/:id` | Body: `name, sku, category (name), description, price, stock, status, images[], variants[], specs[]`. |
| `DELETE /business/products/:id` | Order history keeps its snapshots (`OrderItem.productId` becomes null). |
| `GET /business/services`, `GET /business/services/:id` | Same paging and `X-Total-Count` as products; filters `q` (name), `status` (`active` or `draft`), `categoryId`. A `Service` is `{ id, name, category, description, price, durationMins?, bookable?, maxConcurrent?, status, sold, imageColor, image?, images?, options?, specs? }`. |
| `POST /business/services`, `PUT /business/services/:id` | Body: `name, category (name), description, price, durationMins, bookable, maxConcurrent, status (active\|draft), images[], options[] ({ id?, name, price? }), specs[]`. `bookable` needs `durationMins` (400 `DURATION_REQUIRED`). `PUT` replaces the options; send an option's `id` to keep it. Managers and owners only. |
| `DELETE /business/services/:id` | Order and booking history keep their snapshots (`serviceId` becomes null). |
| `GET /business/categories` | Each with `productCount` and `serviceCount`. |
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

**Record a sale**: body `{ customerId? | newCustomer?: { name, phone?, email? }, items: [{ productId, variantId?, qty, price? } or { serviceId, optionId?, qty, price? }], channel, paymentMethod, paid, handedOver, discount?, notes? }`. Rules: business must be `ACTIVE` or `TRIAL` ("Your store isn't active, so new sales can't be recorded."); at least one item ("Add at least one product to the sale."); monthly order limit ("You've reached this month's order limit on your plan. Upgrade to record more sales."); the same stock checks as checkout; a custom `price` overrides the item price; `discount` is a flat amount and can't exceed the subtotal ("The discount can't be more than the sale total."); an unknown `customerId` gives "That customer no longer exists."; a provided email must look valid ("Enter a valid customer email, or leave it blank."); a missing customer becomes a walk-in. Status is `DELIVERED` when `handedOver`, otherwise `PROCESSING`; payment is `PAID` or `UNPAID` from `paid`. Stock, `sold` and customer totals update as in checkout.

### Search

| Endpoint | Notes |
|---|---|
| `GET /business/search?q=` | The top 5 orders (number, customer name, email, phone), customers (name, email, phone, city) and products (name, SKU) and services (name) matching `q`: `{ q, orders, customers, products, services }`. Needs 2+ characters, otherwise all four lists are empty. Scoped to the signed-in business. |

### Bookings

A service with `bookable: true` (needs `durationMins`; bookings use `serviceId` and `optionId`) is booked into a time slot instead of bought through the cart (`POST /store/:slug/orders` refuses it with `BOOKING_REQUIRED`). `maxConcurrent` is how many bookings of it can overlap.

| Endpoint | Notes |
|---|---|
| `GET /business/booking-settings` | `{ timezone, hours, configured, noticeHours, autoConfirm }`. `hours` is `{ mon: [{ start: "09:00", end: "17:00" }], ... }`; a day left out is closed. Until the owner saves once, Monday to Friday 09:00-17:00 applies (`configured: false`). |
| `PUT /business/booking-settings` | Manager and up. Validates the time zone, `HH:MM` times, start before end, no overlaps, at most 3 periods a day. `noticeHours` 0-168. |
| `GET /business/bookings` | Optional `status`, `from`, `to` (ISO), `q`, `limit`. Soonest first when `from` is given, otherwise newest first. |
| `POST /business/bookings` | The team books a customer in. `{ serviceId, optionId?, startsAt, customer: { name, phone?, email? }, notes? }`. May fall outside opening hours but not past `maxConcurrent` (409 `SLOT_TAKEN`). Always confirmed. |
| `PATCH /business/bookings/:id/status` | `confirmed`, `completed`, `cancelled`, `no_show`. A cancelled booking can't be reopened. Confirming or cancelling emails the customer. |

Calendar subscription links (🏪, each person manages their own): `GET /business/calendar/feeds` lists them (never the secret), `POST /business/calendar/feeds { label? }` makes one and returns `{ url, webcalUrl }` **once** (10 active per person; 400 `TOO_MANY_FEEDS`), `DELETE /business/calendar/feeds/:id` revokes (204). The `url` is `API_PUBLIC_URL/api/v1/calendar-feed/<token>.ics`, an iCalendar feed of the business's bookings from 14 days back to 120 days ahead (max 1000) that Google, Apple or Outlook calendar can subscribe to. Only a SHA-256 hash of the token is stored. The link stops working (plain 404, same for every failure) when it is revoked, when the person who made it leaves the team, or when the business isn't live. The feed carries customer names, phones and emails, so treat the link like a password. `FEED_RATE_LIMIT` (default 600 per minute per client) bounds polling.

Public (🌐): `GET /store/:slug/services/:serviceId/slots?date=YYYY-MM-DD` → `{ date, timezone, durationMins, slots: [{ startsAt, label }] }` (labels are local time in the business's zone; slots start every 30 minutes inside opening hours, honour the notice period, hide times at capacity; dates from today up to 60 days ahead). `POST /store/:slug/bookings` → the booking with its `publicToken` (re-checked inside a per-business lock, so two people can't take the same slot: 409 `SLOT_TAKEN`). `GET /store/bookings/:token` and `POST /store/bookings/:token/cancel` serve the customer's own link (`/s/:slug/booking/:token`). Customers pay on arrival; a booking does not create an order. The team is notified of new and cancelled bookings, and the customer is emailed.

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
| `GET /business/profile`, `PATCH /business/profile` | Editable: `name, description, phone, country, city, brandColor, category, currency, theme, logo, paymentMethods, bankDetails`. `logo` is a URL, `null` removes it. `paymentMethods` is a non-empty list of `cod`, `bank` and `card`; new stores start with `cod` only. **Bank transfer** needs `bankAccount: { bankName, accountNumber, accountName, instructions?, branch?, sortCode?, swiftCode?, iban? }` (the first three required): switching `bank` on without them is 400 `BANK_DETAILS_REQUIRED`, partial details 400 `BANK_DETAILS_INCOMPLETE`, a bad number or SWIFT code `BANK_ACCOUNT_NUMBER_INVALID` / `BANK_SWIFT_INVALID`; `bankAccount: null` removes them (not while `bank` is on). **Card** is a demo, so it can only be chosen, and is only shown to shoppers, when the server runs `DEMO_CARD_PAYMENTS=true` (otherwise 400 `CARD_UNAVAILABLE`). The public store and checkout only list what really works: `paymentMethods` there is the saved choice minus card (outside demo mode) and minus bank without complete details, falling back to `cod`; `bankAccount` is included only while bank is offered. The admin profile also returns `availableMethods` and `cardAvailable`. Validate `theme` against the known theme ids. |

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

## Subscription payments (Paystack, Flutterwave)

**Choosing providers from the UI.** `PAYMENTS_DRIVER` says which providers are *set up on the server* (their keys live in the environment, never in the database). The super admin then chooses, under Platform settings, which of those are switched on for new payments and which is the default: `GET /platform/payment-providers` → `{ paymentsEnabled, providers: [{ name, label, configured, enabled, isDefault, requiredEnv }] }`, `PUT /platform/payment-providers` with `{ enabled: ["paystack","flutterwave"], default }` (stored in `PlatformSetting` key `payments`; errors 400 `PROVIDER_REQUIRED`, `PROVIDER_NOT_CONFIGURED`, `DEFAULT_NOT_ENABLED`). Until they choose, every configured provider is on and the first is the default. Switching only affects new checkouts: a payment already started, its webhook, and card renewals always go back through the provider that took the money, even if it has since been switched off.

Switched on with `PAYMENTS_DRIVER=paystack` (needs `PAYSTACK_SECRET_KEY`), `flutterwave` (needs `FLUTTERWAVE_SECRET_KEY` and `FLUTTERWAVE_SECRET_HASH`) or both, comma separated: `paystack,flutterwave`. The first listed is the default. Each invoice and each saved card remembers its provider, so confirmations, webhooks and renewals always go back through the one that took the payment. With `none` (the default) plan changes apply directly, as before. `fake` and `fake-flutterwave` are in-memory providers for tests and local work and are refused in production.

| Endpoint | Notes |
|---|---|
| `POST /business/billing/checkout` | `{ planId, cycle, couponCode?, provider? }` (`provider` must be one of `payments.providers`, else 400 `PROVIDER_UNAVAILABLE`; omitted = default) → `{ reference, checkoutUrl, invoice, charge: { amount, currency }, applied }`. Redirect the browser to `checkoutUrl`. Charged in the business's currency (the plan's `localPrices`, scaled by any discount). A 100% discount returns `applied: true` with no URL and the plan switches at once. A provider outage returns 502 `PAYMENT_PROVIDER_ERROR`. |
| `GET /business/billing/verify/:reference` | Call from the page Paystack returns to (`?reference=` on `/admin/business/billing`). Asks the provider and applies the result once: `{ status: "paid"\|"failed"\|"pending", applied }`. Only the business that started it can look it up. |
| `POST /webhooks/paystack` 🌐 | Signed (`x-paystack-signature`, HMAC-SHA512 of the raw body). Bad signature → 401. Never trusts the body: it asks Paystack about the reference, then applies it. Always 200 for valid signatures. |
| `POST /webhooks/flutterwave` 🌐 | Flutterwave has no body signature: it sends back the secret hash you configured in the `verif-hash` header, compared in constant time. Only `charge.completed` is acted on, and only after asking Flutterwave about `tx_ref`. Wrong or missing hash, or an unknown provider name → 401. |
| `POST /business/billing/change-plan` | When payments are on, a paid target plan returns 402 `PAYMENT_REQUIRED` (use checkout). Free plans still switch directly and drop the saved card. |

`GET /business/billing` also returns `payments: { enabled, provider (default), providers (switched on by the super admin), cardOnFile }`.

Flutterwave notes: it works in major units (naira), our code in minor units, so amounts are converted at the edge. Token charges can come back pending (the bank wants 3-D Secure); the stale-payment job asks again, and a renewal still undecided after 24 h is marked `FAILED` and the subscription `PAST_DUE`, so the daily retry can start a fresh attempt.

Rules: the amount and currency must match the invoice or the payment is rejected. An invoice is applied exactly once (unique `providerReference`, row lock), however many times it's reported. A successful first payment sets `ACTIVE`, ends the trial, stores the reusable card, starts a period, redeems the discount code and emails a receipt. There is no proration: a plan change starts a fresh period. Paying lifts a `NON_PAYMENT` suspension, never an `ADMIN` one (`Business.suspensionReason`).

## Background jobs

`JobsService` runs hourly (and once on boot) unless `JOBS_ENABLED=false`; every step is safe to run twice or on several servers.

- **Trial reminder:** 3 days before `trialEndsAt`, once.
- **Trial expiry:** an unpaid ended trial becomes `PAST_DUE`; the owner is emailed. The store stays up.
- **Renewals:** at `currentPeriodEnd`, charge the saved card (reference `renew_<sub>_<period>_<attempt>`). Free or fully discounted subscriptions roll on without a charge. No card on file → `PAST_DUE`.
- **Dunning:** a `PAST_DUE` subscription retries once a day; after `DUNNING_GRACE_DAYS` (default 7) the business is suspended with reason `NON_PAYMENT`.
- **Stale payments:** a renewal still pending after an hour is resolved by asking the provider; after 24 h still undecided it is failed and the subscription goes `PAST_DUE`. Checkouts unpaid after 24 h are marked `FAILED`.
- **Nightly (02:00 UTC):** prune expired refresh tokens and old analytics dedupe rows; recompute customer totals from paid orders.

Still open: a Stripe adapter behind the same `PaymentProvider` interface.

## Notifications

For every signed-in person: business team members get their business's, super admins get the platform's. Each person has their own copy and read state.

| Endpoint | What it does |
|---|---|
| `GET /notifications?limit=20&unread=true` | `{ unreadCount, items: [{ id, type, title, body, link?, read, createdAt }] }`, newest first (`limit` 1-100, default 20). `type` is `new_order`, `low_stock`, `out_of_stock` or `new_business`. |
| `POST /notifications/:id/read` (204) | Marks one read. 404 if it isn't yours. |
| `POST /notifications/read-all` (204) | Marks all yours read. |
| `GET /notifications/push/key` | `{ enabled, publicKey }`: the VAPID public key the browser subscribes with. `enabled: false` when the server has no VAPID keys. |
| `POST /notifications/push/subscribe` (204) | `{ endpoint, keys: { p256dh, auth } }` from `PushSubscription.toJSON()`. `endpoint` must be https. Subscribing again with the same endpoint just updates it (and moves it to the current person). 400 `PUSH_DISABLED` without VAPID keys. |
| `POST /notifications/push/unsubscribe` (204) | `{ endpoint }` |

Who is told what: everyone on the team gets `new_order` when a shopper places a storefront order; the owner and managers get `low_stock` (a product falls to 5 or fewer) and `out_of_stock`, once each time a product crosses that line (also after a recorded sale); super admins get `new_business` on every sign-up. Each notification is also sent as a Web Push message to every browser that person subscribed, and a subscription the push service reports as gone (404/410) is deleted. Notifications are deleted after 60 days (nightly job). Creating one never fails or delays the action that caused it.
