# Frontend integration notes

What the Next.js app needs to do when it moves from the mock services to this API. Endpoint details are in `API.md`.

## 1. Subscribing to a paid plan

When `GET /business/billing` returns `payments.enabled: true`, `change-plan` refuses paid plans (402 `PAYMENT_REQUIRED`). Use checkout instead.

1. **Start:** `POST /business/billing/checkout { planId, cycle, couponCode? }`.
   - `applied: true` (a 100% discount code): nothing to pay; refetch billing and show the new plan.
   - Otherwise `window.location.href = checkoutUrl`. Show `charge.amount` and `charge.currency` beforehand: it is what the card is charged, in the business's own currency.
   - 400 `PLAN_FREE`: use `change-plan`. 502 `PAYMENT_PROVIDER_ERROR`: "We couldn't start the payment", let them retry.
2. **Return:** Paystack sends the customer back to `/admin/business/billing?reference=<ref>`. On load, if `reference` is present, call `GET /business/billing/verify/:reference` and show:
   - `paid`: success; refetch billing and remove `?reference` from the URL.
   - `failed`: "Your payment didn't go through"; offer to try again.
   - `pending`: "Still confirming…"; poll every few seconds for about a minute. The webhook usually settles it, and the result is the same either way.
3. **Never** treat the redirect itself as proof of payment; only `verify` (or a refetched billing view) is.
4. **Past due / suspended:** a store in `PAST_DUE` still works; show a banner with a "Pay now" button that runs checkout for the current plan. A store suspended for non-payment gets 403 on its API calls, so the billing page can't load. Show the message from the error and tell them to contact support, or add a payments-only exception later if you want self-service reactivation.
5. Billing view extras: `payments.cardOnFile` tells you whether renewals can happen automatically; show "Card on file" or "Add a card by paying for your plan".
6. A moved-to-free plan drops the saved card. There is no proration: a plan change starts a fresh period.

## 2. Accept-invite page (`/admin/accept-invite?token=…`)

1. `GET /auth/invite/:token` → `{ name, email, role, businessName }`. A 400/404 means expired, used or invalid: show "This invite link has expired. Ask the owner to resend it."
2. Show the name and business, ask for a password (8+ characters), then `POST /auth/accept-invite { token, password }`.
3. The response is a normal session (`user`, `accessToken`, `refreshToken`): store it as after login and go to the admin home.

## 3. Analytics tracking

- Send `POST /track` (no auth). Batch events in memory and flush every few seconds and on `visibilitychange` → hidden (use `navigator.sendBeacon` with a JSON blob there).
- Body: `{ scope, visitorId, sessionId, events: [{ type, path, productId?, source, device, country }] }`, 1–50 events.
  - `scope`: the business id on a storefront, `"platform"` on the marketing site.
  - `visitorId`: random id kept in `localStorage`, stable per browser. `sessionId`: random id kept in `sessionStorage` (new per tab visit).
  - `type`: `page`, `product`, `add_to_cart`, `checkout`. `source`: `direct|whatsapp|instagram|facebook|search|other` (from `utm_source`/referrer). `device`: `mobile|desktop|tablet`.
  - `productId` only for `product` and `add_to_cart` events.
- The response is always 202; ignore it. Wrap everything in try/catch: tracking must never break a page.
- Send `source`, `device` and `country` on the first event of a session; later ones are ignored for that.

## 4. Smaller things

- **Lists:** `page` and `limit` query params; the total is in the `X-Total-Count` header (the API exposes it to the browser).
- **Errors:** `{ statusCode, code, message }`; show `message`. Unknown body fields are silently dropped, so a typo'd field name won't error: check the network tab if a value doesn't save.
- **Tokens:** access tokens last ~15 minutes: on a 401, call `POST /auth/refresh` once, retry, and log out if that fails. Refresh tokens rotate; store the new one each time.
- **Audit log page (optional):** `GET /business/audit` gives a business its own history; `GET /platform/audit` is for the super admin.
- **Team roles:** use `teamRole` from the session (`owner|manager|staff`) to hide what a person can't use; the table in `API.md` has the rules and the API enforces them (403 `INSUFFICIENT_ROLE`).
- **Customer messages:** email is delivered; SMS and WhatsApp are recorded only. Label them accordingly.
