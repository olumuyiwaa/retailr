ALTER TABLE "Plan" ADD COLUMN "themes" TEXT[] NOT NULL DEFAULT ARRAY['classic','showcase','atelier','market']::TEXT[];
