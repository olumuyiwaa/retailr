-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "suspensionReason" TEXT;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "providerAuthorization" TEXT,
ADD COLUMN     "trialReminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "chargeAmount" DECIMAL(12,2),
ADD COLUMN     "chargeCurrency" TEXT,
ADD COLUMN     "cycle" "BillingCycle",
ADD COLUMN     "discount" DECIMAL(12,2),
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'CHECKOUT',
ADD COLUMN     "planCouponId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_providerReference_key" ON "Invoice"("providerReference");

