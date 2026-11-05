/**
 * Shared Subscription & Entitlement Service
 *
 * Centralizes credit allocation, transaction management, and subscription
 * lifecycle operations for In-App Purchase providers (Google Play and Apple).
 */

const prisma = require("../lib/prisma");

class EntitlementError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = "EntitlementError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseExpiryDate(expiryTime) {
  if (!expiryTime) return null;
  if (expiryTime instanceof Date) return isNaN(expiryTime.getTime()) ? null : expiryTime;
  const num = Number(expiryTime);
  if (!isNaN(num) && num > 0) {
    const d = new Date(num);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(expiryTime);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Grants package credits and records a COMPLETED transaction atomically.
 * Ensures idempotency and prevents duplicate credit allocation.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {import("@prisma/client").Package} params.pkg
 * @param {string} params.paymentMethod - "GOOGLE_PLAY" | "APPLE_IAP"
 * @param {string} [params.paymentOrderId]
 * @param {string} [params.paymentId]
 * @param {string} [params.purchaseToken]
 * @param {string} [params.productId]
 * @param {Date|string} [params.expiresAt]
 * @param {boolean} [params.isRenewal]
 * @param {Object} [params.metadata]
 * @returns {Promise<{ transaction: any, creditsAdded: number, alreadyProcessed: boolean }>}
 */
async function grantPurchaseEntitlement({
  userId,
  pkg,
  paymentMethod,
  paymentOrderId,
  paymentId,
  purchaseToken,
  productId,
  expiresAt,
  isRenewal = false,
  metadata,
}) {
  if (!userId || !pkg) {
    throw new EntitlementError("User ID and Package are required", "INVALID_INPUT", 400);
  }

  // 1. Check for token belonging to a DIFFERENT user (fraud prevention)
  if (purchaseToken) {
    const existingWithToken = await prisma.transaction.findFirst({
      where: {
        purchaseToken,
        status: "COMPLETED",
      },
    });

    if (existingWithToken) {
      if (existingWithToken.userId !== userId) {
        throw new EntitlementError(
          "This purchase token is already associated with another user account.",
          "PURCHASE_TOKEN_USER_MISMATCH",
          409
        );
      }
      // If this is NOT an explicit renewal notification, any re-verification of the same token is a duplicate
      if (!isRenewal) {
        return {
          transaction: existingWithToken,
          creditsAdded: 0,
          alreadyProcessed: true,
        };
      }
    }
  }

  // 2. Check for orderId idempotency
  if (paymentOrderId) {
    const existingWithOrder = await prisma.transaction.findFirst({
      where: {
        paymentOrderId,
        status: "COMPLETED",
      },
    });
    if (existingWithOrder) {
      if (existingWithOrder.userId !== userId) {
        throw new EntitlementError(
          "This order ID is already associated with another user account.",
          "ORDER_USER_MISMATCH",
          409
        );
      }
      return {
        transaction: existingWithOrder,
        creditsAdded: 0,
        alreadyProcessed: true,
      };
    }
  }

  // 3. Atomic Allocation & Transaction Creation
  try {
    const result = await prisma.$transaction(async (tx) => {
      // In-transaction re-verification
      if (paymentOrderId) {
        const doubleCheckOrder = await tx.transaction.findFirst({
          where: { paymentOrderId, status: "COMPLETED" },
        });
        if (doubleCheckOrder) {
          return { transaction: doubleCheckOrder, creditsAdded: 0, alreadyProcessed: true };
        }
      } else if (purchaseToken) {
        const doubleCheckToken = await tx.transaction.findFirst({
          where: { purchaseToken, status: "COMPLETED" },
        });
        if (doubleCheckToken) {
          return { transaction: doubleCheckToken, creditsAdded: 0, alreadyProcessed: true };
        }
      }

      // Calculate expiry if not provided
      const resolvedExpiry =
        parseExpiryDate(expiresAt) ||
        (pkg.validityDays ? new Date(Date.now() + pkg.validityDays * 86400000) : null);

      const transaction = await tx.transaction.create({
        data: {
          userId,
          packageId:      pkg.id,
          amount:         pkg.amount, // strictly from DB package
          paymentMethod:  paymentMethod || "GOOGLE_PLAY",
          paymentOrderId: paymentOrderId || null,
          paymentId:      paymentId || null,
          purchaseToken:  purchaseToken || null,
          productId:      productId || pkg.googlePlayProductId || pkg.id,
          expiresAt:      resolvedExpiry,
          metadata:       metadata || undefined,
          status:         "COMPLETED",
        },
      });

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { credits: { increment: pkg.credits } },
      });

      return {
        transaction,
        creditsAdded: pkg.credits,
        newCreditBalance: updatedUser.credits,
        alreadyProcessed: false,
      };
    });

    return result;
  } catch (err) {
    // Unique partial index collision on purchaseToken or paymentOrderId
    if (
      err.code === "P2002" ||
      err.message?.includes("uq_purchase_token_completed") ||
      err.message?.includes("uq_payment_order_completed")
    ) {
      const existing = await prisma.transaction.findFirst({
        where: {
          OR: [
            ...(purchaseToken ? [{ purchaseToken, status: "COMPLETED" }] : []),
            ...(paymentOrderId ? [{ paymentOrderId, status: "COMPLETED" }] : []),
          ],
        },
      });
      return {
        transaction: existing,
        creditsAdded: 0,
        alreadyProcessed: true,
      };
    }
    throw err;
  }
}

/**
 * Records a FAILED purchase attempt so admins can see failed / cancelled payments.
 * Never grants credits. If this user already has a COMPLETED or FAILED transaction
 * for the same purchase token, nothing new is recorded and that transaction is returned.
 *
 * @returns {Promise<{ transaction: any, recorded: boolean }>}
 */
async function recordFailedPurchase({
  userId,
  pkg,
  paymentMethod,
  purchaseToken,
  paymentOrderId,
  productId,
  metadata,
}) {
  if (purchaseToken) {
    const existing = await prisma.transaction.findFirst({
      where: { userId, purchaseToken, status: { in: ["COMPLETED", "FAILED"] } },
    });
    if (existing) {
      return { transaction: existing, recorded: false };
    }
  }

  const transaction = await prisma.transaction.create({
    data: {
      userId,
      packageId:      pkg?.id || null,
      amount:         pkg?.amount || 0,
      paymentMethod,
      paymentOrderId: paymentOrderId || null,
      purchaseToken:  purchaseToken || null,
      productId:      productId || null,
      metadata:       metadata || undefined,
      status:         "FAILED",
    },
  });

  return { transaction, recorded: true };
}

/**
 * Handles a subscription renewal event from App Store Server Notifications.
 */
async function handleSubscriptionRenewal({
  purchaseToken,
  orderId,
  expiryTime,
  productId,
  pkg,
  metadata,
}) {
  // Find the primary purchase or user linked to this purchaseToken
  // (FAILED attempts are ignored: they may belong to a user who tried to reuse someone else's token)
  const initialTx = await prisma.transaction.findFirst({
    where: { purchaseToken, status: { not: "FAILED" } },
    orderBy: { createdAt: "asc" },
  });

  if (!initialTx) {
    console.warn(`[Entitlement] Subscription renewal received for untracked purchase token.`);
    return { success: false, reason: "INITIAL_TRANSACTION_NOT_FOUND" };
  }

  const userId = initialTx.userId;

  // Check if renewal for this specific orderId was already recorded
  if (orderId) {
    const existingRenewal = await prisma.transaction.findFirst({
      where: { paymentOrderId: orderId, status: "COMPLETED" },
    });
    if (existingRenewal) {
      return { success: true, alreadyProcessed: true };
    }
  }

  const expiresAt = parseExpiryDate(expiryTime);

  // Record renewal transaction and allocate renewal credits
  return await grantPurchaseEntitlement({
    userId,
    pkg,
    paymentMethod: "GOOGLE_PLAY",
    paymentOrderId: orderId || `renewal_${Date.now()}`,
    paymentId: purchaseToken,
    purchaseToken,
    productId,
    expiresAt,
    isRenewal: true,
    metadata: {
      type: "SUBSCRIPTION_RENEWAL",
      ...metadata,
    },
  });
}

/**
 * Handles a subscription revocation or refund event from App Store Server Notifications.
 */
async function handleSubscriptionRevocationOrRefund({
  purchaseToken,
  reason = "REFUNDED",
  metadata,
}) {
  const transactions = await prisma.transaction.findMany({
    where: { purchaseToken, status: "COMPLETED" },
    include: { package: true },
  });

  if (!transactions.length) {
    return { success: false, reason: "NO_ACTIVE_TRANSACTIONS_FOR_TOKEN" };
  }

  await prisma.$transaction(async (tx) => {
    for (const t of transactions) {
      await tx.transaction.update({
        where: { id: t.id },
        data: {
          status: "REFUNDED",
          metadata: {
            ...(t.metadata || {}),
            revokedAt: new Date().toISOString(),
            revocationReason: reason,
            ...metadata,
          },
        },
      });

      // Deduct credited contacts if appropriate and log audit
      if (t.package && t.package.credits > 0) {
        const user = await tx.user.findUnique({ where: { id: t.userId } });
        if (user) {
          const newCredits = Math.max(0, user.credits - t.package.credits);
          await tx.user.update({
            where: { id: user.id },
            data: { credits: newCredits },
          });

          await tx.creditAuditLog.create({
            data: {
              userId: user.id,
              amount: -t.package.credits,
              balanceAfter: newCredits,
              reason: `Google Play purchase revoked/refunded: ${reason}`,
            },
          });
        }
      }
    }
  });

  return { success: true, affectedTransactions: transactions.length };
}

module.exports = {
  EntitlementError,
  grantPurchaseEntitlement,
  recordFailedPurchase,
  handleSubscriptionRenewal,
  handleSubscriptionRevocationOrRefund,
};
