-- Products and services become separate tables. Existing services keep their ids, so order and booking history still points at them.
CREATE TYPE "ServiceStatus" AS ENUM ('ACTIVE', 'DRAFT');

CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price" DECIMAL(12,2) NOT NULL,
    "durationMins" INTEGER,
    "bookable" BOOLEAN NOT NULL DEFAULT false,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "status" "ServiceStatus" NOT NULL DEFAULT 'ACTIVE',
    "sold" INTEGER NOT NULL DEFAULT 0,
    "imageColor" TEXT NOT NULL DEFAULT '#c3ceff',
    "specs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Service_businessId_status_idx" ON "Service"("businessId", "status");
CREATE INDEX "Service_businessId_categoryId_idx" ON "Service"("businessId", "categoryId");
ALTER TABLE "Service" ADD CONSTRAINT "Service_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Service" ADD CONSTRAINT "Service_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ServiceImage" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "ServiceImage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceImage_serviceId_position_key" ON "ServiceImage"("serviceId", "position");
ALTER TABLE "ServiceImage" ADD CONSTRAINT "ServiceImage_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ServiceOption" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2),
    "position" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ServiceOption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ServiceOption_serviceId_name_key" ON "ServiceOption"("serviceId", "name");
ALTER TABLE "ServiceOption" ADD CONSTRAINT "ServiceOption_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD COLUMN "serviceId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "optionId" TEXT;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ServiceOption"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- copy the services across (a draft stays a draft; anything else is active)
INSERT INTO "Service" ("id", "businessId", "categoryId", "name", "description", "price", "durationMins", "bookable", "maxConcurrent", "status", "sold", "imageColor", "specs", "createdAt", "updatedAt")
SELECT "id", "businessId", "categoryId", "name", "description", "price", "durationMins", "bookable", "maxConcurrent",
       'ACTIVE'::"ServiceStatus", "sold", "imageColor", "specs", "createdAt", "updatedAt"
FROM "Product" WHERE "kind" = 'SERVICE';
UPDATE "Service" s SET "status" = 'DRAFT' FROM "Product" p WHERE p."id" = s."id" AND p."status" = 'DRAFT';

INSERT INTO "ServiceImage" ("id", "serviceId", "url", "position")
SELECT i."id", i."productId", i."url", i."position" FROM "ProductImage" i JOIN "Product" p ON p."id" = i."productId" WHERE p."kind" = 'SERVICE';

INSERT INTO "ServiceOption" ("id", "serviceId", "name", "price", "position")
SELECT v."id", v."productId", v."name", v."price", v."position" FROM "ProductVariant" v JOIN "Product" p ON p."id" = v."productId" WHERE p."kind" = 'SERVICE';

-- point history at the new rows
UPDATE "OrderItem" oi SET "serviceId" = oi."productId", "optionId" = oi."variantId", "productId" = NULL, "variantId" = NULL
FROM "Product" p WHERE p."id" = oi."productId" AND p."kind" = 'SERVICE';
-- an option id that was copied must exist; a variant id on a service line was copied above, so this is safe

DROP INDEX "Booking_productId_startsAt_idx";
ALTER TABLE "Booking" DROP CONSTRAINT "Booking_productId_fkey";
ALTER TABLE "Booking" RENAME COLUMN "productId" TO "serviceId";
-- bookings only ever pointed at services, but guard against a deleted row anyway
UPDATE "Booking" SET "serviceId" = NULL WHERE "serviceId" IS NOT NULL AND "serviceId" NOT IN (SELECT "id" FROM "Service");
CREATE INDEX "Booking_serviceId_startsAt_idx" ON "Booking"("serviceId", "startsAt");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DELETE FROM "Product" WHERE "kind" = 'SERVICE';
ALTER TABLE "Product" DROP COLUMN "kind", DROP COLUMN "durationMins", DROP COLUMN "bookable", DROP COLUMN "maxConcurrent";
DROP TYPE "ProductKind";
