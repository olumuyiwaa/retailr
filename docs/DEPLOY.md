# Deploying Retailr API

One container (the `Dockerfile`), one PostgreSQL database. Everything else is configuration.

## First deploy

1. **Database.** PostgreSQL 14+ (16 tested). Set `DATABASE_URL`.
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
| `DEMO_CARD_PAYMENTS=false` | Otherwise shopper card orders count as paid with no payment. |
| `PAYMENTS_DRIVER=paystack` / `flutterwave` / `paystack,flutterwave`, plus `PAYSTACK_SECRET_KEY` and/or `FLUTTERWAVE_SECRET_KEY` + `FLUTTERWAVE_SECRET_HASH` | Subscription billing; the first listed is the default. Leave `none` to give plans away free. |

## Paystack

- Set the webhook URL in the Paystack dashboard to `https://<api>/api/v1/webhooks/paystack`. Paystack signs it with your secret key; we verify that and then ask Paystack about the payment before acting.
- Use test keys first (`sk_test_…`), and test: checkout, return page, a declined card, a renewal (set a subscription's `currentPeriodEnd` into the past and run the jobs).
- Charges are in each business's own currency (the plan's `localPrices`, or USD × the demo rates). Set `localPrices` on every plan for every currency you sell in. Check that your Paystack account can collect each of those currencies.

## Background jobs

They run inside the API process, hourly, and are safe on several instances at once. To run them on one instance only, set `JOBS_ENABLED=false` on the others. `DUNNING_GRACE_DAYS` (default 7) is how long a store stays open after a failed renewal.

## Operating notes

- **Behind a proxy/load balancer:** terminate TLS there and set `TRUST_PROXY` to the number of proxies in front of the API (usually 1). Without it every visitor looks like the proxy's address, so rate limits and analytics are shared by everyone. Don't set it when the API is directly exposed: clients could then forge their address.
- **Raw body:** the webhook signature is checked on the exact bytes received, so don't put anything in front of the API that rewrites JSON bodies.
- **Backups:** the database is the only state (plus uploaded files in your bucket). Back up both.
- **Audit log:** `GET /platform/audit` (everything) and `GET /business/audit` (a business's own). Consider pruning old rows once it grows.
- **Rolling back:** migrations are forward-only. Deploy additive migrations first, then the code that uses them.

## Not done yet

Flutterwave and Stripe adapters.

### Payment webhooks

- **Paystack:** Settings → API Keys & Webhooks → Webhook URL `https://<api-host>/api/v1/webhooks/paystack`.
- **Flutterwave:** Settings → Webhooks → URL `https://<api-host>/api/v1/webhooks/flutterwave`, and set "Secret hash" to the same value as `FLUTTERWAVE_SECRET_HASH` (any long random string). Tick "Receive webhook responses".

Webhooks are a speed-up, not the source of truth: the billing page also confirms on return and a job resolves anything left pending.
