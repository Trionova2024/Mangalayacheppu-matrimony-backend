-- Soft delete: rows are never hard-deleted. isDeleted = true hides the record
-- from the mobile app and the admin panel, but it stays in the database.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Package" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- Mobile / email must be unique only among NON-deleted users, so a deleted
-- user's mobile/email can be reused by a new registration or another user.
-- (Partial unique indexes; schema.prisma keeps @unique on both fields.)
DROP INDEX IF EXISTS "User_mobile_key";
CREATE UNIQUE INDEX "User_mobile_key" ON "User"("mobile") WHERE "isDeleted" = false;

DROP INDEX IF EXISTS "User_email_key";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email") WHERE "isDeleted" = false;
