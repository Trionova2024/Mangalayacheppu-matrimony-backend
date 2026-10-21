-- Migration: 20261021000000_add_cashfree_fields
-- Adds gateway-neutral payment columns (used by Cashfree). Existing Razorpay columns are kept for historical transactions.

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "paymentOrderId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "paymentId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Transaction_paymentOrderId_idx" ON "Transaction"("paymentOrderId");

-- One Cashfree order can be credited only once (Partial Unique Index)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_order_completed"
ON "Transaction" ("paymentOrderId")
WHERE "status" = 'COMPLETED' AND "paymentOrderId" IS NOT NULL;
