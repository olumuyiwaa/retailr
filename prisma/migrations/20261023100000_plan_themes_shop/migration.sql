-- The "shop" theme was added after plan_themes: include it in the default and on every plan that doesn't have it yet.
ALTER TABLE "Plan" ALTER COLUMN "themes" SET DEFAULT ARRAY['classic','showcase','atelier','market','shop']::TEXT[];
UPDATE "Plan" SET "themes" = array_append("themes", 'shop') WHERE NOT ('shop' = ANY("themes"));
