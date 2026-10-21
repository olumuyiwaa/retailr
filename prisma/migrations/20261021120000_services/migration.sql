-- Businesses can sell services as well as products.
CREATE TYPE "ProductKind" AS ENUM ('PRODUCT', 'SERVICE');
ALTER TABLE "Product" ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'PRODUCT';
ALTER TABLE "Product" ADD COLUMN "durationMins" INTEGER;
