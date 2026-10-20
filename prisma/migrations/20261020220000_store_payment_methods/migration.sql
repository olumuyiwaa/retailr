-- Store owners choose which payment options their checkout offers. Existing stores keep all three.
ALTER TABLE "Business"
  ADD COLUMN "paymentMethods" TEXT[] NOT NULL DEFAULT ARRAY['cod', 'bank', 'card']::TEXT[],
  ADD COLUMN "bankDetails" TEXT NOT NULL DEFAULT '';
