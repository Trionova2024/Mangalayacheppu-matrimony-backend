/**
 * Google Play In-App Purchase (IAP) Verification and RTDN Service
 *
 * Implements authoritative purchase verification and acknowledgement/consumption
 * using the official Google Android Publisher API (v3).
 */

const fs = require("fs");
const { androidpublisher } = require("@googleapis/androidpublisher");
const { GoogleAuth } = require("google-auth-library");
const { resolvePackageByGoogleProductId, determineProductType } = require("../config/productMapping");
const {
  grantPurchaseEntitlement,
  handleSubscriptionRenewal,
  handleSubscriptionRevocationOrRefund,
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

  const auth = new GoogleAuth(authOptions);
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

/**
 * Handles Real-time Developer Notifications (RTDN) delivered via Google Cloud Pub/Sub push.
 *
 * @param {Object} req - Express request
 * @returns {Promise<{ handled: boolean, eventType: string, message: string }>}
 */
async function handlePubSubNotification(req) {
  // 1. Verify notification source (optional token or header check)
  const expectedToken = process.env.GOOGLE_PLAY_PUBSUB_VERIFICATION_TOKEN;
  if (expectedToken) {
    const receivedToken =
      req.query?.token ||
      req.headers["x-pubsub-verification-token"] ||
      req.headers["authorization"]?.replace(/^Bearer\s+/i, "");

    if (receivedToken !== expectedToken) {
      console.warn("[GooglePlay RTDN] PubSub token verification failed.");
      throw new GooglePlayVerificationError("Unauthorized Pub/Sub source", "UNAUTHORIZED_PUBSUB", 401);
    }
  }

  // Pub/Sub push envelope contains message.data as base64 string
  const pubSubMsg = req.body?.message;
  if (!pubSubMsg || !pubSubMsg.data) {
    console.warn("[GooglePlay RTDN] Missing Pub/Sub message data.");
    return { handled: false, eventType: "EMPTY", message: "Missing Pub/Sub message payload" };
  }

  let payload;
  try {
    const decodedStr = Buffer.from(pubSubMsg.data, "base64").toString("utf8");
    payload = JSON.parse(decodedStr);
  } catch (err) {
    console.error("[GooglePlay RTDN] Failed to parse Pub/Sub base64 payload:", err.message);
    throw new GooglePlayVerificationError("Malformed Pub/Sub message data", "BAD_PAYLOAD", 400);
  }

  const configuredPackage = (process.env.GOOGLE_PLAY_PACKAGE_NAME || "").trim();
  if (payload.packageName && configuredPackage && payload.packageName !== configuredPackage) {
    console.warn(`[GooglePlay RTDN] Ignoring notification for different package: ${payload.packageName}`);
    return { handled: false, eventType: "IGNORED_PACKAGE", message: "Package mismatch" };
  }

  // ── 1. Test Notification Ping ───────────────────────────────────────────────
  if (payload.testNotification) {
    console.log("[GooglePlay RTDN] Test notification received and acknowledged.");
    return { handled: true, eventType: "TEST_NOTIFICATION", message: "Test notification acknowledged" };
  }

  // ── 2. Subscription Notification ────────────────────────────────────────────
  if (payload.subscriptionNotification) {
    const subNotif = payload.subscriptionNotification;
    const notificationType = subNotif.notificationType;
    const purchaseToken = subNotif.purchaseToken;
    const subscriptionId = subNotif.subscriptionId;

    console.log(`[GooglePlay RTDN] Subscription event (type: ${notificationType}) for subscription ${subscriptionId}`);

    // Authoritative verification via Google Play API
    const client = getAndroidPublisherClient();
    let authorativeSub;
    try {
      const res = await client.purchases.subscriptionsv2.get({
        packageName: configuredPackage || payload.packageName,
        token: purchaseToken,
      });
      authorativeSub = res.data;
    } catch (fetchErr) {
      console.error(`[GooglePlay RTDN] Failed to query authoritative subscription state:`, fetchErr.message);
      // Return 200/handled to prevent infinite Pub/Sub retries on permanently non-existent tokens
      return { handled: false, eventType: `TYPE_${notificationType}`, message: fetchErr.message };
    }

    const internalPackage = await resolvePackageByGoogleProductId(subscriptionId);
    const lineItem = authorativeSub.lineItems?.[0] || {};
    const expiryTime = lineItem.expiryTime;
    const orderId = authorativeSub.latestOrderId;

    // Handle lifecycle types:
    // 2: SUBSCRIPTION_RENEWED
    // 4: SUBSCRIPTION_PURCHASED
    // 3: SUBSCRIPTION_CANCELED (auto-renew turned off)
    // 13: SUBSCRIPTION_EXPIRED
    // 12: SUBSCRIPTION_REVOKED
    switch (notificationType) {
      case 2: // RENEWED
      case 4: // PURCHASED
        if (internalPackage) {
          await handleSubscriptionRenewal({
            purchaseToken,
            orderId,
            expiryTime,
            productId: subscriptionId,
            pkg: internalPackage,
            metadata: { rtdnType: notificationType, subData: authorativeSub },
          });
        }
        break;

      case 12: // REVOKED
        await handleSubscriptionRevocationOrRefund({
          purchaseToken,
          reason: "REVOKED",
          metadata: { rtdnType: notificationType },
        });
        break;

      case 13: // EXPIRED
        console.log(`[GooglePlay RTDN] Subscription ${subscriptionId} expired.`);
        break;

      case 3: // CANCELED
        console.log(`[GooglePlay RTDN] Subscription ${subscriptionId} canceled auto-renew. Access active until ${expiryTime}`);
        break;

      default:
        console.log(`[GooglePlay RTDN] Event type ${notificationType} recorded.`);
    }

    return { handled: true, eventType: `TYPE_${notificationType}`, message: "Subscription event processed" };
  }

  // ── 3. One-Time Product Notification ─────────────────────────────────────────
  if (payload.oneTimeProductNotification) {
    const oneTimeNotif = payload.oneTimeProductNotification;
    console.log(`[GooglePlay RTDN] One-time product notification received:`, oneTimeNotif.sku);
    return { handled: true, eventType: "ONE_TIME_PRODUCT", message: "One-time product notification received" };
  }

  return { handled: true, eventType: "UNKNOWN", message: "Notification acknowledged" };
}

module.exports = {
  getAndroidPublisherClient,
  setMockAndroidPublisherClient,
  verifyGooglePlayPurchase,
  handlePubSubNotification,
  GooglePlayVerificationError,
  maskToken,
};
