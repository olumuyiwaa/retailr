-- AlterTable
ALTER TABLE "Plan" ADD COLUMN "maxSmsPerMonth" INTEGER NOT NULL DEFAULT 50;

-- CreateEnum
CREATE TYPE "MessageJobStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('RENT', 'UTILITIES', 'SUPPLIES', 'MARKETING', 'SALARIES', 'TRANSPORT', 'OTHER');

-- CreateTable
CREATE TABLE "MessageJob" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "toAddress" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL DEFAULT '',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" "MessageJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "MessageJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "spentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageJob_status_createdAt_idx" ON "MessageJob"("status", "createdAt");
CREATE INDEX "MessageJob_messageId_idx" ON "MessageJob"("messageId");
CREATE INDEX "MessageJob_businessId_channel_status_idx" ON "MessageJob"("businessId", "channel", "status");
CREATE INDEX "Expense_businessId_spentAt_idx" ON "Expense"("businessId", "spentAt");

-- AddForeignKey
ALTER TABLE "MessageJob" ADD CONSTRAINT "MessageJob_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed plan SMS limits roughly matching tiers
UPDATE "Plan" SET "maxSmsPerMonth" = 20 WHERE "id" = 'plan_basic';
UPDATE "Plan" SET "maxSmsPerMonth" = 50 WHERE "id" = 'plan_starter';
UPDATE "Plan" SET "maxSmsPerMonth" = 200 WHERE "id" = 'plan_growth';
UPDATE "Plan" SET "maxSmsPerMonth" = -1 WHERE "id" = 'plan_scale';
