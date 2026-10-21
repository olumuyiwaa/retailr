-- Bookable services: opening hours, appointment slots and bookings.
ALTER TYPE "NotificationType" ADD VALUE 'NEW_BOOKING';
ALTER TYPE "NotificationType" ADD VALUE 'BOOKING_CANCELLED';

CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

ALTER TABLE "Business" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos';
ALTER TABLE "Business" ADD COLUMN "bookingHours" JSONB;
ALTER TABLE "Business" ADD COLUMN "bookingNoticeHours" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Business" ADD COLUMN "bookingAutoConfirm" BOOLEAN NOT NULL DEFAULT true;
UPDATE "Business" SET "timezone" = 'Africa/Accra' WHERE lower("country") = 'ghana';
UPDATE "Business" SET "timezone" = 'Africa/Nairobi' WHERE lower("country") = 'kenya';

ALTER TABLE "Product" ADD COLUMN "bookable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "maxConcurrent" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "productId" TEXT,
    "customerId" TEXT,
    "serviceName" TEXT NOT NULL,
    "variantName" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'store',
    "publicToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Booking_publicToken_key" ON "Booking"("publicToken");
CREATE INDEX "Booking_businessId_startsAt_idx" ON "Booking"("businessId", "startsAt");
CREATE INDEX "Booking_productId_startsAt_idx" ON "Booking"("productId", "startsAt");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
