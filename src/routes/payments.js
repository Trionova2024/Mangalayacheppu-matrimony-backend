const router   = require("express").Router();
const userAuth = require("../middleware/userAuth");
const { getPaymentProvider, isCashfreeEnabled, isIapEnabled } = require("../config/paymentConfig");
const {
  verifyGooglePlayPurchase,
  handlePubSubNotification,
  GooglePlayVerificationError,
} = require("../services/googlePlayService");
const {
  verifyApplePurchase,
  handleAppleServerNotification,
  AppleIapVerificationError,
} = require("../services/appleIapService");
const { EntitlementError } = require("../services/subscriptionService");

// ── GET /api/payments/config ──────────────────────────────────────────────────
// Informs mobile clients of the active payment providers (safe, no secrets exposed)
router.get("/config", (req, res) => {
  res.json({
    success: true,
    data: {
      provider:     getPaymentProvider(),
      isCashfree:   isCashfreeEnabled(),
      isIap:        isIapEnabled(),
      isGooglePlay: isIapEnabled(),
      isAppleIap:   true, // Apple IAP is always available for iOS clients to satisfy App Store rules
    },
  });
});

// ── POST /api/payments/google-play/verify ─────────────────────────────────────
// Authenticated user verifies purchase token with Google Play (Android)
router.post("/google-play/verify", userAuth, async (req, res) => {
  try {
    const { productId, purchaseToken, packageName } = req.body || {};

    if (!productId || typeof productId !== "string" || !productId.trim()) {
      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "productId is required",
        data:    { status: "FAILED", message: "productId is required" },
      });
    }

    if (!purchaseToken || typeof purchaseToken !== "string" || !purchaseToken.trim()) {
      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "purchaseToken is required",
        data:    { status: "FAILED", message: "purchaseToken is required" },
      });
    }

    // Authoritative server-side identity: req.user.id
    const result = await verifyGooglePlayPurchase({
      userId:        req.user.id,
      productId:     productId.trim(),
      purchaseToken: purchaseToken.trim(),
      packageName:   packageName ? String(packageName).trim() : undefined,
    });

    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof GooglePlayVerificationError || err instanceof EntitlementError) {
      return res.status(err.statusCode || 400).json({
        success: false,
        status:  "FAILED",
        code:    err.code,
        message: err.message,
        data:    { status: "FAILED", code: err.code, message: err.message },
      });
    }

    console.error("[GooglePlay Controller Error]:", err);
    return res.status(500).json({
      success: false,
      status:  "FAILED",
      message: "Internal server error while verifying purchase",
      data:    { status: "FAILED", message: "Internal server error" },
    });
  }
});

// ── POST /api/payments/google-play/notifications ──────────────────────────────
// Webhook for Google Cloud Pub/Sub Real-time Developer Notifications (RTDN)
router.post("/google-play/notifications", async (req, res) => {
  try {
    const result = await handlePubSubNotification(req);
    return res.status(200).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    if (err instanceof GooglePlayVerificationError) {
      return res.status(err.statusCode || 400).json({
        success: false,
        code:    err.code,
        message: err.message,
      });
    }

    console.error("[GooglePlay PubSub Controller Error]:", err);
    return res.status(500).json({
      success: false,
      message: "Error processing Pub/Sub notification",
    });
  }
});

// ── POST /api/payments/apple/verify ───────────────────────────────────────────
// Authenticated user verifies purchase with Apple App Store (iOS)
router.post("/apple/verify", userAuth, async (req, res) => {
  try {
    const { productId, receiptData, signedTransaction, transactionId } = req.body || {};

    if (!productId || typeof productId !== "string" || !productId.trim()) {
      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "productId is required",
        data:    { status: "FAILED", message: "productId is required" },
      });
    }

    if (!receiptData && !signedTransaction) {
      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "Either signedTransaction or receiptData is required",
        data:    { status: "FAILED", message: "Missing verification payload" },
      });
    }

    const result = await verifyApplePurchase({
      userId:            req.user.id,
      productId:         productId.trim(),
      receiptData:       receiptData ? String(receiptData).trim() : undefined,
      signedTransaction: signedTransaction ? String(signedTransaction).trim() : undefined,
      transactionId:     transactionId ? String(transactionId).trim() : undefined,
    });

    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof AppleIapVerificationError || err instanceof EntitlementError) {
      return res.status(err.statusCode || 400).json({
        success: false,
        status:  "FAILED",
        code:    err.code,
        message: err.message,
        data:    { status: "FAILED", code: err.code, message: err.message },
      });
    }

    console.error("[Apple Controller Error]:", err);
    return res.status(500).json({
      success: false,
      status:  "FAILED",
      message: "Internal server error while verifying Apple purchase",
      data:    { status: "FAILED", message: "Internal server error" },
    });
  }
});

// ── POST /api/payments/apple/notifications ────────────────────────────────────
// Webhook for Apple App Store Server Notifications v2
router.post("/apple/notifications", async (req, res) => {
  try {
    const result = await handleAppleServerNotification(req);
    return res.status(200).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    if (err instanceof AppleIapVerificationError) {
      return res.status(err.statusCode || 400).json({
        success: false,
        code:    err.code,
        message: err.message,
      });
    }

    console.error("[Apple Server Notifications Controller Error]:", err);
    return res.status(500).json({
      success: false,
      message: "Error processing Apple server notification",
    });
  }
});

module.exports = router;
