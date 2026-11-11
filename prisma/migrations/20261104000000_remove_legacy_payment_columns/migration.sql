-- Migration: 20261104000000_remove_legacy_payment_columns
-- Payments are In-App Purchase only (Google Play / Apple). Removes unused Razorpay gateway columns.

-- Preserve historical Razorpay order/payment references in the generic payment columns
UPDATE "Transaction"
SET "paymentOrderId" = COALESCE("paymentOrderId", "razorpayOrderId"),
    "paymentId"      = COALESCE("paymentId", "razorpayPaymentId")
WHERE "razorpayOrderId" IS NOT NULL OR "razorpayPaymentId" IS NOT NULL;

-- DropIndex
DROP INDEX IF EXISTS "Transaction_razorpayPaymentId_idx";

-- AlterTable Transaction
ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "cardInfo";
ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "razorpayOrderId";
ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "razorpayPaymentId";
ALTER TABLE "Transaction" DROP COLUMN IF EXISTS "razorpaySignature";

-- AlterTable AppConfig
ALTER TABLE "AppConfig" DROP COLUMN IF EXISTS "razorpayKeyId";
ALTER TABLE "AppConfig" DROP COLUMN IF EXISTS "razorpaySecret";
