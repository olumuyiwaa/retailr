ALTER TABLE "Invoice" ADD COLUMN "provider" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "provider" TEXT;
-- everything recorded so far went through Paystack
UPDATE "Invoice" SET "provider" = 'paystack' WHERE "providerReference" IS NOT NULL;
UPDATE "Subscription" SET "provider" = 'paystack' WHERE "providerAuthorization" IS NOT NULL;
