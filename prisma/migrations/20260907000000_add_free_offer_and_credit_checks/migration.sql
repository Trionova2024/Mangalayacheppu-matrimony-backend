-- Migration: 20260907000000_add_free_offer_and_credit_checks
-- Ensures database-level integrity for Free Test Offer idempotency and non-negative credit balances.

-- 1. Free Offer Single Claim Idempotency Constraint (Partial Unique Index)
CREATE UNIQUE INDEX IF NOT EXISTS "uq_user_free_offer" 
ON "Transaction" ("userId", "packageId") 
WHERE "paymentMethod" = 'FREE_OFFER';

-- 2. Non-negative credits check constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_credits_non_negative'
    ) THEN
        ALTER TABLE "User" ADD CONSTRAINT "check_credits_non_negative" CHECK ("credits" >= 0);
    END IF;
END $$;

-- 3. Non-negative freeContactsLeft check constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_free_contacts_non_negative'
    ) THEN
        ALTER TABLE "User" ADD CONSTRAINT "check_free_contacts_non_negative" CHECK ("freeContactsLeft" >= 0);
    END IF;
END $$;
