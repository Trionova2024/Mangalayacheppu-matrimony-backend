/**
 * Google Play In-App Purchase (IAP) Verification Service
 *
 * Implements authoritative purchase verification and acknowledgement/consumption
 * using the official Google Android Publisher API (v3).
 */

const fs = require("fs");
// Use the auth class bundled with @googleapis/androidpublisher: a GoogleAuth from a different
// google-auth-library version is not recognised by the API client and requests go out unauthenticated.
const { androidpublisher, auth: googleAuth } = require("@googleapis/androidpublisher");
const { resolvePackageByGoogleProductId, determineProductType } = require("../config/productMapping");
const {
  grantPurchaseEntitlement,
  recordFailedPurchase,
  EntitlementError,
} = require("./subscriptionService");

// In-memory holder for mock client in test mode
let mockPublisherClient = null;

function setMockAndroidPublisherClient(mockClient) {
  mockPublisherClient = mockClient;
}

function getAndroidPublisherClient() {
  if (mockPublisherClient) {
    return mockPublisherClient;
  }

  const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const googleAppCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  const authOptions = {
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  };

  if (serviceAccountJson && serviceAccountJson.trim()) {
    try {
      authOptions.credentials = JSON.parse(serviceAccountJson);
    } catch {
      if (fs.existsSync(serviceAccountJson.trim())) {
        authOptions.credentials = JSON.parse(fs.readFileSync(serviceAccountJson.trim(), "utf8"));
      } else {
        throw new Error("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is neither valid JSON nor an existing file path");
      }
    }
  } else if (googleAppCreds && fs.existsSync(googleAppCreds.trim())) {
    authOptions.keyFile = googleAppCreds.trim();
  }

  const auth = new googleAuth.GoogleAuth(authOptions);
  return androidpublisher({ version: "v3", auth });
}

/**
 * Masks a sensitive purchase token for safe logging.
 */
function maskToken(token) {
  if (!token || typeof token !== "string") return "empty";
  if (token.length <= 10) return "***";
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

class GooglePlayVerificationError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = "GooglePlayVerificationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Verifies a Google Play subscription or one-time purchase, acknowledges/consumes it,
 * and activates user entitlements.
 *
 * @param {Object} params
 * @param {string} params.userId - Authenticated user ID
 * @param {string} params.productId - Google Play product ID
 * @param {string} params.purchaseToken - Purchase token from Google Play
 * @param {string} [params.packageName] - Optional client package name (validated against server config)
 * @returns {Promise<{ success: boolean, status: string, message: string, data: any }>}
 */
async function verifyGooglePlayPurchase({ userId, productId, purchaseToken, packageName }) {
  const configuredPackage = (process.env.GOOGLE_PLAY_PACKAGE_NAME || "").trim();

  if (!configuredPackage) {
    throw new GooglePlayVerificationError(
      "Server configuration error: GOOGLE_PLAY_PACKAGE_NAME is missing.",
      "CONFIG_MISSING",
      500
    );
  }

  if (!productId || typeof productId !== "string" || !productId.trim()) {
    throw new GooglePlayVerificationError("productId is required", "MISSING_PRODUCT_ID", 400);
  }

  if (!purchaseToken || typeof purchaseToken !== "string" || !purchaseToken.trim()) {
    throw new GooglePlayVerificationError("purchaseToken is required", "MISSING_PURCHASE_TOKEN", 400);
  }

  const cleanProductId = productId.trim();
  const cleanToken = purchaseToken.trim();

  // Validate package name if provided by client
  if (packageName && packageName.trim() !== configuredPackage) {
    throw new GooglePlayVerificationError(
      `Package name mismatch. Expected "${configuredPackage}", got "${packageName}".`,
      "PACKAGE_NAME_MISMATCH",
      400
    );
  }

  // Authoritative server-side package resolution
  const internalPackage = await resolvePackageByGoogleProductId(cleanProductId);
  if (!internalPackage) {
    throw new GooglePlayVerificationError(
      `Unrecognized or inactive product ID "${cleanProductId}".`,
      "UNKNOWN_PRODUCT_ID",
      400
    );
  }

  const client = getAndroidPublisherClient();
  const productType = determineProductType(cleanProductId);

  console.log(`[GooglePlay] Verifying ${productType} ${cleanProductId} (token: ${maskToken(cleanToken)}) for user ${userId}`);

  if (productType === "SUBSCRIPTION") {
    return await verifySubscription({
      client,
      packageName: configuredPackage,
      productId: cleanProductId,
      purchaseToken: cleanToken,
      userId,
      internalPackage,
    });
  } else {
    return await verifyOneTimeProduct({
      client,
      packageName: configuredPackage,
      productId: cleanProductId,
      purchaseToken: cleanToken,
      userId,
      internalPackage,
    });
  }
}

/**
 * Handles Google Play Subscription verification via purchases.subscriptionsv2.get.
 */
async function verifySubscription({
  client,
  packageName,
  productId,
  purchaseToken,
  userId,
  internalPackage,
}) {
  let subData;
  try {
    const res = await client.purchases.subscriptionsv2.get({
      packageName,
      token: purchaseToken,
    });
    subData = res.data;
  } catch (apiErr) {
    const status = apiErr.code || apiErr.status || 500;
    const msg = apiErr.message || "Google Play API error";
    console.error(`[GooglePlay] Subscriptions API failed (${status}):`, msg);

    if (status === 400 || status === 404) {
      throw new GooglePlayVerificationError("Invalid subscription purchase token", "INVALID_PURCHASE_TOKEN", 400);
    }
    throw new GooglePlayVerificationError("Google Play verification service temporarily unavailable", "GOOGLE_API_ERROR", 502);
  }

  // Validate subscription state
  // SubscriptionState enum:
  // 1: SUBSCRIPTION_STATE_PENDING
  // 2: SUBSCRIPTION_STATE_ACTIVE
  // 3: SUBSCRIPTION_STATE_PAUSED
  // 4: SUBSCRIPTION_STATE_IN_GRACE_PERIOD
  // 5: SUBSCRIPTION_STATE_ON_HOLD
  // 6: SUBSCRIPTION_STATE_CANCELED
  // 7: SUBSCRIPTION_STATE_EXPIRED
  const state = subData.subscriptionState;
  const lineItem = subData.lineItems?.[0] || {};
  const lineItemProductId = lineItem.productId;

  if (lineItemProductId && lineItemProductId !== productId) {
    throw new GooglePlayVerificationError(
      `Verified subscription product "${lineItemProductId}" does not match requested "${productId}".`,
      "PRODUCT_MISMATCH",
      400
    );
  }

  if (state === "SUBSCRIPTION_STATE_PENDING" || state === 1) {
    throw new GooglePlayVerificationError(
      "Purchase is still pending payment confirmation by Google Play.",
      "PURCHASE_PENDING",
      400
    );
  }

  if (state === "SUBSCRIPTION_STATE_ON_HOLD" || state === 5) {
    throw new GooglePlayVerificationError(
      "Subscription is on hold due to a payment issue.",
      "SUBSCRIPTION_ON_HOLD",
      400
    );
  }

  if (state === "SUBSCRIPTION_STATE_EXPIRED" || state === 7) {
    throw new GooglePlayVerificationError(
      "Subscription has expired and cannot be activated.",
      "SUBSCRIPTION_EXPIRED",
      400
    );
  }

  // Active or Grace Period
  const isEligible =
    state === "SUBSCRIPTION_STATE_ACTIVE" ||
    state === 2 ||
    state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD" ||
    state === 4 ||
    (state === "SUBSCRIPTION_STATE_CANCELED" && lineItem.expiryTime && new Date(lineItem.expiryTime) > new Date());

  if (!isEligible) {
    throw new GooglePlayVerificationError(
      `Subscription state (${state}) is not eligible for entitlement activation.`,
      "SUBSCRIPTION_INELIGIBLE",
      400
    );
  }

  // Expiry date from Google
  const expiryTimeStr = lineItem.expiryTime;
  const expiresAt = expiryTimeStr ? new Date(expiryTimeStr) : null;
  const orderId = subData.latestOrderId || `GPA.${Date.now()}`;

  // Grant entitlement
  const grantResult = await grantPurchaseEntitlement({
    userId,
    pkg: internalPackage,
    paymentMethod: "GOOGLE_PLAY",
    paymentOrderId: orderId,
    paymentId: purchaseToken,
    purchaseToken,
    productId,
    expiresAt,
    metadata: {
      productType: "SUBSCRIPTION",
      subscriptionState: state,
      latestOrderId: orderId,
      lineItems: subData.lineItems,
    },
  });

  // Acknowledge subscription with Google Play if not already acknowledged
  const ackState = subData.acknowledgementState;
  const needsAck =
    ackState === "ACKNOWLEDGEMENT_STATE_PENDING_ACKNOWLEDGE" ||
    ackState === 0 ||
    !ackState;

  if (needsAck) {
    try {
      await client.purchases.subscriptions.acknowledge({
        packageName,
        subscriptionId: productId,
        token: purchaseToken,
      });
      console.log(`[GooglePlay] Subscription acknowledged successfully for token: ${maskToken(purchaseToken)}`);
    } catch (ackErr) {
      console.warn(`[GooglePlay] Subscription acknowledge warning:`, ackErr.message);
      // Entitlement is already granted safely; Google allows retrying acknowledgement
    }
  }

  return {
    success: true,
    status: "COMPLETED",
    message: grantResult.alreadyProcessed
      ? "Payment already processed"
      : `${internalPackage.credits} credits added to your account`,
    data: {
      status: "COMPLETED",
      orderId,
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

/**
 * Handles Google Play One-Time (in-app) product verification via purchases.products.get.
 */
async function verifyOneTimeProduct({
  client,
  packageName,
  productId,
  purchaseToken,
  userId,
  internalPackage,
}) {
  let productData;
  try {
    const res = await client.purchases.products.get({
      packageName,
      productId,
      token: purchaseToken,
    });
    productData = res.data;
  } catch (apiErr) {
    const status = apiErr.code || apiErr.status || 500;
    const msg = apiErr.message || "Google Play API error";
    console.error(`[GooglePlay] Products API failed (${status}):`, msg);

    if (status === 400 || status === 404) {
      throw new GooglePlayVerificationError("Invalid product purchase token", "INVALID_PURCHASE_TOKEN", 400);
    }
    throw new GooglePlayVerificationError("Google Play verification service temporarily unavailable", "GOOGLE_API_ERROR", 502);
  }

  // purchaseState:
  // 0: Purchased
  // 1: Canceled
  // 2: Pending
  const purchaseState = productData.purchaseState;
  if (purchaseState === 2 || purchaseState === "2") {
    throw new GooglePlayVerificationError(
      "Purchase is still pending payment confirmation by Google Play.",
      "PURCHASE_PENDING",
      400
    );
  }

  if (purchaseState === 1 || purchaseState === "1") {
    throw new GooglePlayVerificationError(
      "Purchase was canceled.",
      "PURCHASE_CANCELED",
      400
    );
  }

  if (purchaseState !== 0 && purchaseState !== "0") {
    throw new GooglePlayVerificationError(
      `Purchase state (${purchaseState}) is invalid.`,
      "INVALID_PURCHASE_STATE",
      400
    );
  }

  const orderId = productData.orderId || `GPA.${Date.now()}`;

  // Grant entitlement
  const grantResult = await grantPurchaseEntitlement({
    userId,
    pkg: internalPackage,
    paymentMethod: "GOOGLE_PLAY",
    paymentOrderId: orderId,
    paymentId: purchaseToken,
    purchaseToken,
    productId,
    metadata: {
      productType: "INAPP",
      purchaseState: productData.purchaseState,
      consumptionState: productData.consumptionState,
      orderId,
    },
  });

  // Consume consumable product (Matrimony credit packages are consumable so user can buy again)
  const isConsumed = productData.consumptionState === 1 || productData.consumptionState === "1";
  if (!isConsumed) {
    try {
      await client.purchases.products.consume({
        packageName,
        productId,
        token: purchaseToken,
      });
      console.log(`[GooglePlay] Product consumed successfully: ${productId}`);
    } catch (consumeErr) {
      console.warn(`[GooglePlay] Product consumption warning:`, consumeErr.message);
    }
  }

  return {
    success: true,
    status: "COMPLETED",
    message: grantResult.alreadyProcessed
      ? "Payment already processed"
      : `${internalPackage.credits} credits added to your account`,
    data: {
      status: "COMPLETED",
      orderId,
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

// Verification errors that mean the purchase is definitively invalid.
// Pending purchases, Google API outages and server configuration problems are
// retryable, so they are NOT recorded as failed transactions.
const FINAL_FAILURE_CODES = new Set([
  "INVALID_PURCHASE_TOKEN",
  "PURCHASE_CANCELED",
  "INVALID_PURCHASE_STATE",
  "PRODUCT_MISMATCH",
  "PACKAGE_NAME_MISMATCH",
  "UNKNOWN_PRODUCT_ID",
  "SUBSCRIPTION_ON_HOLD",
  "SUBSCRIPTION_EXPIRED",
  "SUBSCRIPTION_INELIGIBLE",
  "PURCHASE_TOKEN_USER_MISMATCH",
  "ORDER_USER_MISMATCH",
]);

/**
 * Records a FAILED transaction when server-side verification rejects a purchase.
 * Never throws: a recording problem must not change the response sent to the app.
 */
async function recordGooglePlayVerificationFailure({ userId, productId, purchaseToken, error }) {
  if (!FINAL_FAILURE_CODES.has(error?.code)) return null;

  try {
    const cleanProductId = typeof productId === "string" && productId.trim() ? productId.trim() : null;
    const cleanToken = typeof purchaseToken === "string" && purchaseToken.trim() ? purchaseToken.trim() : null;
    const pkg = cleanProductId ? await resolvePackageByGoogleProductId(cleanProductId) : null;

    return await recordFailedPurchase({
      userId,
      pkg,
      paymentMethod: "GOOGLE_PLAY",
      purchaseToken: cleanToken,
      productId: cleanProductId,
      metadata: {
        source: "SERVER_VERIFICATION",
        code: error.code,
        message: error.message,
      },
    });
  } catch (recordErr) {
    console.error("[GooglePlay] Could not record failed purchase:", recordErr.message);
    return null;
  }
}

/**
 * Records a purchase the app reports as cancelled or failed on the Google Play side
 * (the user closed the payment sheet, the card was declined, billing unavailable, ...).
 *
 * @param {Object} params
 * @param {string} params.userId - Authenticated user ID
 * @param {string} params.productId - Google Play product ID the user tried to buy
 * @param {string} [params.purchaseToken] - Present only if Google issued a token
 * @param {string} [params.orderId] - Google order ID, if any
 * @param {string} [params.reason] - "CANCELLED" | "FAILED" (default "FAILED")
 * @param {string} [params.errorCode] - Billing error code from the app (e.g. "USER_CANCELED")
 * @param {string} [params.errorMessage] - Billing error message from the app
 * @returns {Promise<{ cancelled: boolean, recorded: boolean, alreadyCompleted: boolean }>}
 */
async function reportFailedGooglePlayPurchase({
  userId,
  productId,
  purchaseToken,
  orderId,
  reason,
  errorCode,
  errorMessage,
}) {
  const cleanProductId = String(productId).trim();
  const cleanToken = typeof purchaseToken === "string" && purchaseToken.trim() ? purchaseToken.trim() : null;
  const cleanOrderId = typeof orderId === "string" && orderId.trim() ? orderId.trim() : null;
  const cancelled = String(reason || "").trim().toUpperCase() === "CANCELLED";

  const pkg = await resolvePackageByGoogleProductId(cleanProductId);

  const { transaction, recorded } = await recordFailedPurchase({
    userId,
    pkg,
    paymentMethod: "GOOGLE_PLAY",
    purchaseToken: cleanToken,
    paymentOrderId: cleanOrderId,
    productId: cleanProductId,
    metadata: {
      source: "CLIENT",
      reason: cancelled ? "CANCELLED" : "FAILED",
      ...(errorCode != null && { errorCode: String(errorCode).slice(0, 100) }),
      ...(errorMessage != null && { errorMessage: String(errorMessage).slice(0, 500) }),
    },
  });

  return {
    cancelled,
    recorded,
    // The purchase was already verified successfully: the failure report is ignored
    alreadyCompleted: transaction?.status === "COMPLETED",
  };
}

module.exports = {
  getAndroidPublisherClient,
  setMockAndroidPublisherClient,
  verifyGooglePlayPurchase,
  recordGooglePlayVerificationFailure,
  reportFailedGooglePlayPurchase,
  GooglePlayVerificationError,
  maskToken,
};
