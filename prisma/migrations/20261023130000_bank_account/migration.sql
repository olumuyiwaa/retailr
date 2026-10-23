-- Bank transfer needs structured details (bank name, account number, account name, ...). Card is demo-only, so it is no longer a default.
ALTER TABLE "Business" ADD COLUMN "bankAccount" JSONB;
-- keep whatever free text a business had as the transfer instructions; the required fields are still missing, so bank transfer stays off until they add them
UPDATE "Business" SET "bankAccount" = jsonb_build_object('instructions', "bankDetails") WHERE "bankDetails" <> '';
ALTER TABLE "Business" ALTER COLUMN "paymentMethods" SET DEFAULT ARRAY['cod']::TEXT[];
UPDATE "Business" SET "paymentMethods" = array_remove("paymentMethods", 'card');
UPDATE "Business" SET "paymentMethods" = array_remove("paymentMethods", 'bank');
UPDATE "Business" SET "paymentMethods" = ARRAY['cod']::TEXT[] WHERE cardinality("paymentMethods") = 0;
