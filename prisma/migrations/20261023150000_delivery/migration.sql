-- Delivery options: per-business config plus a snapshot of the choice on each order.
ALTER TABLE "Business" ADD COLUMN "delivery" JSONB;
ALTER TABLE "Order" ADD COLUMN "deliveryMethod" TEXT;
ALTER TABLE "Order" ADD COLUMN "deliveryZone" TEXT;
ALTER TABLE "Order" ADD COLUMN "shippingFee" DECIMAL(12,2) NOT NULL DEFAULT 0;
