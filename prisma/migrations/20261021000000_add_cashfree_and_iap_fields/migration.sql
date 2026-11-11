-- Migration: 20261021000000_add_cashfree_and_iap_fields
-- Adds Cashfree, Google Play IAP, and Apple IAP payment columns, indexes, and idempotency constraints.
-- Existing Razorpay columns are preserved for historical transactions.

-- AlterTable Package
ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "googlePlayProductId" TEXT;
ALTER TABLE "Package" ADD COLUMN IF NOT EXISTS "appleProductId" TEXT;

-- CreateIndex for Package product IDs
CREATE UNIQUE INDEX IF NOT EXISTS "Package_googlePlayProductId_key" ON "Package"("googlePlayProductId");
CREATE UNIQUE INDEX IF NOT EXISTS "Package_appleProductId_key" ON "Package"("appleProductId");

-- AlterTable Transaction
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "paymentOrderId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "paymentId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "purchaseToken" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Transaction_paymentOrderId_idx" ON "Transaction"("paymentOrderId");
CREATE INDEX IF NOT EXISTS "Transaction_purchaseToken_idx" ON "Transaction"("purchaseToken");

-- Cashfree order idempotency (one paymentOrderId credited only once)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_payment_order_completed"
ON "Transaction" ("paymentOrderId")
WHERE "status" = 'COMPLETED' AND "paymentOrderId" IS NOT NULL;

-- IAP token and order idempotency (prevent duplicate credit allocation)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_purchase_token_order_completed"
ON "Transaction" ("purchaseToken", "paymentOrderId")
WHERE "status" = 'COMPLETED' AND "purchaseToken" IS NOT NULL AND "paymentOrderId" IS NOT NULL;
