# Deploying Retailr API

One container (the `Dockerfile`), one PostgreSQL database. Everything else is configuration.

## First deploy

1. **Database.** PostgreSQL 14+ (16 tested). Set `DATABASE_URL`.
   - **Neon:** use the *pooled* connection string (host contains `-pooler`) with `?sslmode=require` for the app, and the *direct* string for `prisma migrate deploy` (run it with `DATABASE_URL` pointed at the direct host). Neon suspends idle compute (5 minutes on the free plan, so the first request after a quiet spell is slow, about a second); the app closes idle connections after 10 s and waits up to 20 s to connect, so it reconnects cleanly instead of failing. To stop suspensions entirely, turn off "Scale to zero" on a paid plan or ping `/api/v1/health` every 4 minutes (e.g. UptimeRobot). `DB_POOL_MAX` (default 10) caps connections; keep it low on free plans.
2. **Migrations.** Run before starting a new version, from the same image: `npx prisma migrate deploy`. Run it once per release, not once per instance.
3. **Seed (once).** Creates the plans and the super admin: `SEED_SUPER_ADMIN_EMAIL`, `SEED_SUPER_ADMIN_PASSWORD` (`npm run seed` needs dev dependencies, so run it from a checkout or a build stage, not the slim runtime image). Change the admin password after the first login.
4. **Start.** `node dist/main` (the image does this). `GET /api/v1/health` is the health check.

## Required in production

| Variable | Why |
|---|---|
| `NODE_ENV=production` | Hides `/docs`, forbids the fake payment driver. |
| `DATABASE_URL`, `JWT_ACCESS_SECRET` | `openssl rand -base64 48`. Rotating the secret signs everyone out. |
| `CORS_ORIGINS` | The web app's origin(s), comma separated. |
| `APP_PUBLIC_URL` | Where the web app lives: used in emails and as the payment return address. |
| `API_PUBLIC_URL` | This API's public URL (used for uploaded file links). |
| `STORAGE_DRIVER=s3` + `S3_*`, `STORAGE_PUBLIC_URL` | `local` is for development only: the container's disk isn't durable. |
| `MAIL_DRIVER=smtp`, `SMTP_URL`, `MAIL_FROM` | With `log`, invites and receipts are only printed. |
| `SMS_DRIVER=termii`, `TERMII_API_KEY`, `SMS_SENDER` | With `log`, texts are only printed. Register the sender name with Termii first. |
| `TRUST_PROXY` | See operating notes. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional. Browser push for admins: `npx web-push generate-vapid-keys`, set both keys together. Without them in-app notifications still work and the web app hides the push switch. Changing the pair later invalidates every saved subscription. |
| `DEMO_CARD_PAYMENTS=false` | Otherwise shopper card orders count as paid with no payment. |
| `PAYMENTS_DRIVER=paystack` / `flutterwave` / `paystack,flutterwave`, plus `PAYSTACK_SECRET_KEY` and/or `FLUTTERWAVE_SECRET_KEY` + `FLUTTERWAVE_SECRET_HASH` | Subscription billing; the first listed is the default. Leave `none` to give plans away free. |

## Paystack

- Set the webhook URL in the Paystack dashboard to `https://<api>/api/v1/webhooks/paystack`. Paystack signs it with your secret key; we verify that and then ask Paystack about the payment before acting.
- Use test keys first (`sk_test_…`), and test: checkout, return page, a declined card, a renewal (set a subscription's `currentPeriodEnd` into the past and run the jobs).
- Charges are in each business's own currency (the plan's `localPrices`, or USD × the demo rates). Set `localPrices` on every plan for every currency you sell in. Check that your Paystack account can collect each of those currencies.

## Background jobs

They run inside the API process, hourly, and are safe on several instances at once. To run them on one instance only, set `JOBS_ENABLED=false` on the others. `DUNNING_GRACE_DAYS` (default 7) is how long a store stays open after a failed renewal.

## Scaling

One instance is fine to start. Before a traffic spike, or once you run several instances:

- **Cache the storefront.** `GET /store/:slug`, `/products`, `/services` and `/categories` send `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` (`STORE_CACHE_SECONDS`, `0` turns it off). Put a CDN (Cloudflare, Netlify edge, CloudFront) in front of the API so most shopper reads never reach Node or Postgres. A listing can be up to a minute stale; checkout re-checks stock and prices, so it never oversells. Order and booking pages are `no-store`.
- **Redis for rate limits.** Set `REDIS_URL` and every instance shares one set of counters; without it each instance counts alone, so the real limit is the limit times the number of instances. Redis is optional and nothing else needs it yet.
- **Database connections.** Total connections = instances × `DB_POOL_MAX`. Put PgBouncer (or your host's pooler) in front, and keep that total under Postgres's `max_connections`.
- **Background jobs on one instance.** Set `JOBS_ENABLED=false` on all but one.
- **Writes on one shop are serial.** Orders, bookings and sales take a per-business Postgres lock so stock and slots stay correct; a single shop's checkout throughput is bounded by it, other shops are unaffected.
- **Load test first.** Try k6 against `/store/:slug/products` (through the CDN and directly) and the checkout route, and read the numbers before promising a figure.

## Operating notes

- **Behind a proxy/load balancer:** terminate TLS there and set `TRUST_PROXY` to the number of proxies in front of the API (usually 1). Without it every visitor looks like the proxy's address, so rate limits and analytics are shared by everyone. Don't set it when the API is directly exposed: clients could then forge their address.
- **Raw body:** the webhook signature is checked on the exact bytes received, so don't put anything in front of the API that rewrites JSON bodies.
- **Backups:** the database is the only state (plus uploaded files in your bucket). Back up both.
- **Audit log:** `GET /platform/audit` (everything) and `GET /business/audit` (a business's own). Consider pruning old rows once it grows.
- **Rolling back:** migrations are forward-only. Deploy additive migrations first, then the code that uses them.

## Not done yet

A Stripe adapter. Online payments at storefront checkout (shoppers paying a store) are also not built: the Paystack and Flutterwave adapters only collect subscriptions.

### Payment webhooks

- **Paystack:** Settings → API Keys & Webhooks → Webhook URL `https://<api-host>/api/v1/webhooks/paystack`.
- **Flutterwave:** Settings → Webhooks → URL `https://<api-host>/api/v1/webhooks/flutterwave`, and set "Secret hash" to the same value as `FLUTTERWAVE_SECRET_HASH` (any long random string). Tick "Receive webhook responses".

Webhooks are a speed-up, not the source of truth: the billing page also confirms on return and a job resolves anything left pending.
