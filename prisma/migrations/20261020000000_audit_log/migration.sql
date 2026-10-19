CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "businessId" TEXT,
    "actorId" TEXT,
    "actorRole" TEXT NOT NULL,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "meta" JSONB,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditLog_businessId_at_idx" ON "AuditLog"("businessId", "at");
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
