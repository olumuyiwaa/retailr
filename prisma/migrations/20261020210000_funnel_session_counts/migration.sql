-- Funnel steps now count distinct sessions instead of events.
ALTER TABLE "AnalyticsDay"
  ADD COLUMN "productSessions" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cartSessions" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "checkoutSessions" INTEGER NOT NULL DEFAULT 0;

-- History only has event counts, so approximate: no step can exceed the visits (or the step before it).
UPDATE "AnalyticsDay" SET
  "productSessions" = LEAST("productViews", "sessions"),
  "cartSessions" = LEAST("addToCart", "productViews", "sessions"),
  "checkoutSessions" = LEAST("checkouts", "addToCart", "productViews", "sessions");

-- Sessions that placed an order (the storefront now sends an "order" event). Older days can't be reconstructed.
ALTER TABLE "AnalyticsDay" ADD COLUMN "orderSessions" INTEGER NOT NULL DEFAULT 0;
