/**
 * Apple In-App Purchase (IAP) Verification and App Store Server Notifications Service
 *
 * Supports both StoreKit 2 JWS signed transactions and Apple App Store receipt validation.
 */

const jwt = require("jsonwebtoken");
const { resolvePackageByAppleProductId } = require("../config/productMapping");
const {
  grantPurchaseEntitlement,
  handleSubscriptionRenewal,
  handleSubscriptionRevocationOrRefund,
  EntitlementError,
} = require("./subscriptionService");

let mockAppleClient = null;

function setMockAppleClient(mock) {
  mockAppleClient = mock;
}

class AppleIapVerificationError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = "AppleIapVerificationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Masks sensitive transaction/receipt identifiers for safe logging.
 */
function maskAppleToken(val) {
  if (!val || typeof val !== "string") return "empty";
  if (val.length <= 8) return "***";
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
}

/**
 * Decodes a JWS string (StoreKit 2 payload or notification).
 */
function decodeAppleJWS(jwsString) {
  try {
    const decoded = jwt.decode(jwsString, { complete: true });
    return decoded ? decoded.payload : null;
  } catch (err) {
    console.warn("[Apple IAP] Failed to decode JWS:", err.message);
    return null;
  }
}

/**
 * Validates a StoreKit 1 / receipt file with Apple's verifyReceipt service.
 */
async function verifyWithAppleReceiptApi(receiptData, password) {
  if (mockAppleClient?.verifyReceipt) {
    return await mockAppleClient.verifyReceipt(receiptData, password);
  }

  const productionUrl = "https://buy.itunes.apple.com/verifyReceipt";
  const sandboxUrl = "https://sandbox.itunes.apple.com/verifyReceipt";

  const isSandboxEnv = process.env.APPLE_IAP_ENV === "sandbox";
  const primaryUrl = isSandboxEnv ? sandboxUrl : productionUrl;

  const makeReq = async (url) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "receipt-data": receiptData,
        password: password || process.env.APPLE_SHARED_SECRET || undefined,
        "exclude-old-transactions": true,
      }),
    });
    return await res.json().catch(() => ({ status: -1 }));
  };

  let data = await makeReq(primaryUrl);

  // Status 21007: Receipt is from sandbox but sent to production
  if (data.status === 21007) {
    console.log("[Apple IAP] Receipt is from Sandbox. Redirecting to sandbox verifyReceipt...");
    data = await makeReq(sandboxUrl);
  }

  return data;
}

/**
 * Verifies an Apple purchase (StoreKit 2 signed transaction or App Store receipt).
 *
 * @param {Object} params
 * @param {string} params.userId - Authenticated user ID
 * @param {string} params.productId - Apple product ID
 * @param {string} [params.receiptData] - Base64 receipt data (StoreKit 1)
 * @param {string} [params.signedTransaction] - StoreKit 2 JWS signed transaction
 * @param {string} [params.transactionId] - Client transaction identifier
 * @returns {Promise<{ success: boolean, status: string, message: string, data: any }>}
 */
async function verifyApplePurchase({ userId, productId, receiptData, signedTransaction, transactionId }) {
  if (!productId || typeof productId !== "string" || !productId.trim()) {
    throw new AppleIapVerificationError("productId is required", "MISSING_PRODUCT_ID", 400);
  }

  const cleanProductId = productId.trim();
  const internalPackage = await resolvePackageByAppleProductId(cleanProductId);

  if (!internalPackage) {
    throw new AppleIapVerificationError(
      `Unrecognized or inactive Apple product ID "${cleanProductId}".`,
      "UNKNOWN_PRODUCT_ID",
      400
    );
  }

  const configuredBundleId = (process.env.APPLE_BUNDLE_ID || "").trim();

  // ── CASE A: Mock Apple Client (Testing) ───────────────────────────────────
  if (mockAppleClient?.verifyPurchase) {
    const mockResult = await mockAppleClient.verifyPurchase({
      userId,
      productId: cleanProductId,
      receiptData,
      signedTransaction,
      transactionId,
    });

    if (mockResult.error) {
      throw new AppleIapVerificationError(
        mockResult.error.message || "Apple verification failed",
        mockResult.error.code || "APPLE_VERIFICATION_FAILED",
        mockResult.error.statusCode || 400
      );
    }

    const resolvedOrderId = mockResult.transactionId || transactionId || `apple_${Date.now()}`;
    const grantResult = await grantPurchaseEntitlement({
      userId,
      pkg: internalPackage,
      paymentMethod: "APPLE_IAP",
      paymentOrderId: resolvedOrderId,
      paymentId: resolvedOrderId,
      purchaseToken: mockResult.originalTransactionId || resolvedOrderId,
      productId: cleanProductId,
      expiresAt: mockResult.expiresDate ? new Date(mockResult.expiresDate) : null,
      metadata: {
        platform: "iOS",
        appleProductId: cleanProductId,
        transactionId: resolvedOrderId,
      },
    });

    return {
      success: true,
      status: "COMPLETED",
      message: grantResult.alreadyProcessed
        ? "Payment already processed"
        : `${internalPackage.credits} credits added to your account`,
      data: {
        status: "COMPLETED",
        orderId: resolvedOrderId,
        credits: internalPackage.credits,
        alreadyProcessed: grantResult.alreadyProcessed,
        package: {
          id: internalPackage.id,
          title: internalPackage.title || internalPackage.name,
          price: internalPackage.price || Math.round(internalPackage.amount),
          contacts: internalPackage.credits,
          validityDays: internalPackage.validityDays,
        },
      },
    };
  }

  // ── CASE B: StoreKit 2 Signed Transaction JWS ──────────────────────────────
  if (signedTransaction && typeof signedTransaction === "string") {
    console.log(`[Apple IAP] Verifying StoreKit 2 transaction for user ${userId}`);
    const payload = decodeAppleJWS(signedTransaction);

    if (!payload) {
      throw new AppleIapVerificationError("Invalid StoreKit 2 signed transaction", "INVALID_TRANSACTION", 400);
    }

    if (configuredBundleId && payload.bundleId && payload.bundleId !== configuredBundleId) {
      throw new AppleIapVerificationError(
        `Bundle ID mismatch. Expected "${configuredBundleId}", got "${payload.bundleId}".`,
        "BUNDLE_ID_MISMATCH",
        400
      );
    }

    if (payload.productId && payload.productId !== cleanProductId) {
      throw new AppleIapVerificationError(
        `Product ID mismatch. Expected "${cleanProductId}", got "${payload.productId}".`,
        "PRODUCT_ID_MISMATCH",
        400
      );
    }

    // Check revocation
    if (payload.revocationDate) {
      throw new AppleIapVerificationError(
        "Purchase was revoked by Apple.",
        "PURCHASE_REVOKED",
        400
      );
    }

    const resolvedTxId = String(payload.transactionId || transactionId || `apple_${Date.now()}`);
    const originalTxId = String(payload.originalTransactionId || resolvedTxId);
    const expiresAt = payload.expiresDate ? new Date(payload.expiresDate) : null;

    const grantResult = await grantPurchaseEntitlement({
      userId,
      pkg: internalPackage,
      paymentMethod: "APPLE_IAP",
      paymentOrderId: resolvedTxId,
      paymentId: originalTxId,
      purchaseToken: originalTxId,
      productId: cleanProductId,
      expiresAt,
      metadata: {
        platform: "iOS",
        appleProductId: cleanProductId,
        transactionId: resolvedTxId,
        originalTransactionId: originalTxId,
        environment: payload.environment,
      },
    });

    return {
      success: true,
      status: "COMPLETED",
      message: grantResult.alreadyProcessed
        ? "Payment already processed"
        : `${internalPackage.credits} credits added to your account`,
      data: {
        status: "COMPLETED",
        orderId: resolvedTxId,
        credits: internalPackage.credits,
        alreadyProcessed: grantResult.alreadyProcessed,
        package: {
          id: internalPackage.id,
          title: internalPackage.title || internalPackage.name,
          price: internalPackage.price || Math.round(internalPackage.amount),
          contacts: internalPackage.credits,
          validityDays: internalPackage.validityDays,
        },
      },
    };
  }

  // ── CASE C: StoreKit 1 Base64 Receipt ──────────────────────────────────────
  if (receiptData && typeof receiptData === "string") {
    console.log(`[Apple IAP] Verifying receipt for user ${userId}`);
    const receiptResult = await verifyWithAppleReceiptApi(receiptData);

    if (receiptResult.status !== 0) {
      const errorCodes = {
        21000: "App Store could not read the JSON object.",
        21002: "The data in the receipt-data property was malformed or missing.",
        21003: "The receipt could not be authenticated.",
        21004: "The shared secret does not match the shared secret on file.",
        21005: "The receipt server is not currently available.",
        21006: "This receipt is valid but the subscription has expired.",
        21010: "This receipt could not be authorized.",
      };
      const message = errorCodes[receiptResult.status] || `Apple receipt verification failed (status: ${receiptResult.status})`;
      throw new AppleIapVerificationError(message, "INVALID_RECEIPT", 400);
    }

    const receipt = receiptResult.receipt || {};
    if (configuredBundleId && receipt.bundle_id && receipt.bundle_id !== configuredBundleId) {
      throw new AppleIapVerificationError(
        `Bundle ID mismatch. Expected "${configuredBundleId}", got "${receipt.bundle_id}".`,
        "BUNDLE_ID_MISMATCH",
        400
      );
    }

    // Look for matching in-app purchase in receipt
    const inApps = receipt.in_app || receiptResult.latest_receipt_info || [];
    const matchedPurchase = inApps.find((p) => p.product_id === cleanProductId) || inApps[0];

    if (!matchedPurchase) {
      throw new AppleIapVerificationError(
        "Receipt does not contain a purchase for this product.",
        "PURCHASE_NOT_FOUND_IN_RECEIPT",
        400
      );
    }

    const resolvedTxId = String(matchedPurchase.transaction_id || transactionId || `apple_${Date.now()}`);
    const originalTxId = String(matchedPurchase.original_transaction_id || resolvedTxId);
    const expiresAt = matchedPurchase.expires_date_ms ? new Date(Number(matchedPurchase.expires_date_ms)) : null;

    const grantResult = await grantPurchaseEntitlement({
      userId,
      pkg: internalPackage,
      paymentMethod: "APPLE_IAP",
      paymentOrderId: resolvedTxId,
      paymentId: originalTxId,
      purchaseToken: originalTxId,
      productId: cleanProductId,
      expiresAt,
      metadata: {
        platform: "iOS",
        appleProductId: cleanProductId,
        transactionId: resolvedTxId,
        originalTransactionId: originalTxId,
      },
    });

    return {
      success: true,
      status: "COMPLETED",
      message: grantResult.alreadyProcessed
        ? "Payment already processed"
        : `${internalPackage.credits} credits added to your account`,
      data: {
        status: "COMPLETED",
        orderId: resolvedTxId,
        credits: internalPackage.credits,
        alreadyProcessed: grantResult.alreadyProcessed,
        package: {
          id: internalPackage.id,
          title: internalPackage.title || internalPackage.name,
          price: internalPackage.price || Math.round(internalPackage.amount),
          contacts: internalPackage.credits,
          validityDays: internalPackage.validityDays,
        },
      },
    };
  }

  throw new AppleIapVerificationError(
    "Either signedTransaction or receiptData is required for verification.",
    "MISSING_VERIFICATION_PAYLOAD",
    400
  );
}

/**
 * Handles App Store Server Notifications v2.
 */
async function handleAppleServerNotification(req) {
  const { signedPayload } = req.body || {};
  if (!signedPayload) {
    return { handled: false, message: "Missing signedPayload" };
  }

  const notification = decodeAppleJWS(signedPayload);
  if (!notification) {
    throw new AppleIapVerificationError("Invalid notification JWS", "BAD_NOTIFICATION", 400);
  }

  const notificationType = notification.notificationType;
  const data = notification.data || {};
  const signedTxInfo = data.signedTransactionInfo;
  const txInfo = signedTxInfo ? decodeAppleJWS(signedTxInfo) : {};

  const originalTransactionId = txInfo.originalTransactionId || txInfo.transactionId;
  const productId = txInfo.productId;

  console.log(`[Apple Server Notification] Event: ${notificationType} (Product: ${productId}, OriginalTx: ${maskAppleToken(originalTransactionId)})`);

  if (!originalTransactionId) {
    return { handled: true, eventType: notificationType, message: "No transaction ID in payload" };
  }

  const internalPackage = productId ? await resolvePackageByAppleProductId(productId) : null;

  switch (notificationType) {
    case "DID_RENEW":
    case "SUBSCRIBED":
      if (internalPackage) {
        await handleSubscriptionRenewal({
          purchaseToken: String(originalTransactionId),
          orderId: String(txInfo.transactionId || `apple_renew_${Date.now()}`),
          expiryTime: txInfo.expiresDate,
          productId,
          pkg: internalPackage,
          metadata: { notificationType, txInfo },
        });
      }
      break;

    case "REVOKE":
    case "REFUND":
      await handleSubscriptionRevocationOrRefund({
        purchaseToken: String(originalTransactionId),
        reason: notificationType,
        metadata: { notificationType, txInfo },
      });
      break;

    case "EXPIRED":
      console.log(`[Apple Server Notification] Subscription expired for ${originalTransactionId}`);
      break;

    default:
      console.log(`[Apple Server Notification] Unhandled event: ${notificationType}`);
  }

  return {
    handled: true,
    eventType: notificationType,
    message: "Apple server notification processed successfully",
  };
}

module.exports = {
  verifyApplePurchase,
  handleAppleServerNotification,
  setMockAppleClient,
  AppleIapVerificationError,
  decodeAppleJWS,
};
