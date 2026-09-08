-- Migration: 20260904000000_add_indexes_and_credit_audit_log
-- Prepared for database performance and credit audit trails.
-- NOTE: Migration prepared but NOT executed.

-- CreateTable
CREATE TABLE IF NOT EXISTS "CreditAuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "adminId" TEXT,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes for User
CREATE INDEX IF NOT EXISTS "User_status_isVerified_idx" ON "User"("status", "isVerified");
CREATE INDEX IF NOT EXISTS "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndexes for ProfileApproval
CREATE INDEX IF NOT EXISTS "ProfileApproval_status_idx" ON "ProfileApproval"("status");

-- CreateIndexes for Transaction
CREATE INDEX IF NOT EXISTS "Transaction_userId_status_idx" ON "Transaction"("userId", "status");
CREATE INDEX IF NOT EXISTS "Transaction_status_createdAt_idx" ON "Transaction"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "Transaction_razorpayPaymentId_idx" ON "Transaction"("razorpayPaymentId");

-- CreateIndexes for CallLog
CREATE INDEX IF NOT EXISTS "CallLog_lockerId_viewedId_idx" ON "CallLog"("lockerId", "viewedId");
CREATE INDEX IF NOT EXISTS "CallLog_viewedId_idx" ON "CallLog"("viewedId");
CREATE INDEX IF NOT EXISTS "CallLog_createdAt_idx" ON "CallLog"("createdAt");

-- CreateIndexes for CreditAuditLog
CREATE INDEX IF NOT EXISTS "CreditAuditLog_userId_idx" ON "CreditAuditLog"("userId");
CREATE INDEX IF NOT EXISTS "CreditAuditLog_createdAt_idx" ON "CreditAuditLog"("createdAt");

-- CreateIndexes for SupportTicket
CREATE INDEX IF NOT EXISTS "SupportTicket_status_idx" ON "SupportTicket"("status");

-- CreateIndexes for Bookmark
CREATE INDEX IF NOT EXISTS "Bookmark_targetId_idx" ON "Bookmark"("targetId");

-- CreateIndexes for Swipe
CREATE INDEX IF NOT EXISTS "Swipe_ownerId_idx" ON "Swipe"("ownerId");
CREATE INDEX IF NOT EXISTS "Swipe_targetId_idx" ON "Swipe"("targetId");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'CreditAuditLog_userId_fkey'
    ) THEN
        ALTER TABLE "CreditAuditLog" ADD CONSTRAINT "CreditAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
