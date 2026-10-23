-- The "bazaar" theme (1688-inspired wholesale marketplace): include it in the default and on every plan that doesn't have it yet.
ALTER TABLE "Plan" ALTER COLUMN "themes" SET DEFAULT ARRAY['classic','showcase','atelier','market','shop','bazaar']::TEXT[];
UPDATE "Plan" SET "themes" = array_append("themes", 'bazaar') WHERE NOT ('bazaar' = ANY("themes"));
