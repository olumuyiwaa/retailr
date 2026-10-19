-- CreateTable
CREATE TABLE "AnalyticsSeen" (
    "scope" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,

    CONSTRAINT "AnalyticsSeen_pkey" PRIMARY KEY ("scope","date","kind","keyHash")
);

