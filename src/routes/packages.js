const router    = require("express").Router();
const crypto    = require("crypto");
const prisma    = require("../lib/prisma");
const userAuth  = require("../middleware/userAuth");
const adminAuth = require("../middleware/adminAuth");
const jwt       = require("jsonwebtoken");
const { getAgeFromDob } = require("../utils/age");
const { getPaymentProvider, isIapEnabled } = require("../config/paymentConfig");

// ── Cashfree Payment Gateway (PG API v2026-01-01) ──────────────────────────────
const CASHFREE_API_VERSION = process.env.CASHFREE_API_VERSION || "2026-01-01";

function getCashfreeConfig() {
  const appId     = process.env.CASHFREE_APP_ID || "";
  const secretKey = process.env.CASHFREE_SECRET_KEY || "";
  const env       = process.env.CASHFREE_ENV === "production" ? "production" : "sandbox";
  const baseUrl   = env === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
  return { appId, secretKey, env, baseUrl };
}

async function cashfreeRequest(cf, method, path, body) {
  const res = await fetch(`${cf.baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type":    "application/json",
      "x-client-id":     cf.appId,
      "x-client-secret": cf.secretKey,
      "x-api-version":   CASHFREE_API_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// ── Smart auth middleware: detects admin vs flutter token ──────────────────────
async function smartAuth(req, res, next) {
  const header = req.headers.authorization;
  const match  = header?.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1].trim()) return res.status(401).json({ message: "No token provided" });
  const token = match[1].trim();
  if (token === "null" || token === "undefined") return res.status(401).json({ message: "Invalid or expired token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Try admin first
    const admin = await prisma.admin.findUnique({ where: { id: payload.id } });
    if (admin) { req.admin = admin; req.isAdmin = true; return next(); }
    // Try user
    const user = await prisma.user.findUnique({ where: { id: payload.id } });
    if (user) {
      if (user.status === "BLOCKED") return res.status(403).json({ message: "Account suspended.", code: "ACCOUNT_BLOCKED" });
      req.user = user; req.isAdmin = false; return next();
    }
    return res.status(401).json({ message: "Invalid token" });
  } catch { return res.status(401).json({ message: "Invalid or expired token" }); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/packages — Flutter: list packages for purchase | Admin: list all packages
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/", smartAuth, async (req, res) => {
  try {
    if (req.isAdmin) {
      // Admin: return full package list
      const packages = await prisma.package.findMany({ orderBy: { createdAt: "desc" } });
      return res.json({ data: packages });
    }
    // Flutter: return active packages + free user config
    const config   = await prisma.appConfig.findUnique({ where: { id: "singleton" } });
    const packages = await prisma.package.findMany({ where: { status: "ACTIVE" }, orderBy: { amount: "asc" } });
    res.json({
      success: true,
      data: {
        paymentProvider: getPaymentProvider(),
        packages: packages.map(p => ({
          id: p.id,
          title: p.title || p.name,
          subtitle: p.subtitle || p.description,
          price: p.price || Math.round(p.amount),
          contacts: p.credits,
          validityDays: p.validityDays,
          googlePlayProductId: p.googlePlayProductId || null,
          appleProductId:      p.appleProductId || null,
        })),
        freeUser: {
          contacts: config?.defaultCredits || 3,
          validityDays: (config?.validityMonths || 3) * 30,
          description: `${config?.defaultCredits || 3} free contacts valid for ${config?.validityMonths || 3} months`,
        },
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Flutter: POST /api/packages/create-order ──────────────────────────────────
router.post("/create-order", userAuth, async (req, res) => {
  try {
    const { packageId } = req.body;
    if (!packageId) return res.status(400).json({ message: "packageId is required" });

    const pkg = await prisma.package.findUnique({ where: { id: packageId } });
    if (!pkg) return res.status(404).json({ message: "Package not found" });
    if (pkg.status !== "ACTIVE") return res.status(400).json({ message: "Package is not active" });

    // ── CASE A: FREE OFFER (amount === 0) ──────────────────────────────────────
    if (pkg.amount === 0) {
      try {
        await prisma.$transaction(async (tx) => {
          // Double-check existing claim within transaction
          const existing = await tx.transaction.findFirst({
            where: { userId: req.user.id, packageId: pkg.id, status: "COMPLETED" },
          });
          if (existing) {
            const err = new Error("You have already claimed this offer");
            err.code = "OFFER_ALREADY_CLAIMED";
            throw err;
          }

          // Create FREE_OFFER transaction
          await tx.transaction.create({
            data: {
              userId:        req.user.id,
              packageId:     pkg.id,
              amount:        0,
              paymentMethod: "FREE_OFFER",
              status:        "COMPLETED",
            },
          });
          await tx.user.update({
            where: { id: req.user.id },
            data:  { credits: { increment: pkg.credits } },
          });
        });
      } catch (err) {
        if (
          err.code === "OFFER_ALREADY_CLAIMED" ||
          err.code === "P2002" ||
          err.message?.includes("uq_user_free_offer") ||
          err.message?.includes("unique constraint") ||
          err.message?.includes("already claimed")
        ) {
          return res.status(400).json({
            success: false,
            message: "You have already claimed this offer",
            code: "OFFER_ALREADY_CLAIMED",
          });
        }
        throw err;
      }

      return res.json({
        success: true,
        isFree:  true,
        message: `${pkg.credits} credits added to your account`,
        data: {
          status:   "COMPLETED",
          isFree:   true,
          orderId:  `free_${pkg.id}_${Date.now()}`,
          amount:   0,
          currency: "INR",
          message:  `${pkg.credits} credits added to your account`,
          package: {
            id: pkg.id, title: pkg.title || pkg.name, subtitle: pkg.subtitle,
            price: 0, contacts: pkg.credits, validityDays: pkg.validityDays,
          },
        },
      });
    }

    // ── CASE B: NON-ZERO PACKAGE ──────────────────────────────────────────────
    if (isIapEnabled()) {
      return res.status(400).json({
        success: false,
        message: "Payment provider is configured for Google Play In-App Purchase. Please use the Google Play purchase flow.",
        code: "IAP_PROVIDER_ACTIVE",
      });
    }

    const cf = getCashfreeConfig();

    if (!cf.appId || !cf.secretKey) {
      return res.status(500).json({
        success: false,
        message: "Payment gateway configuration is missing",
      });
    }

    // Create real Cashfree order via Cashfree PG REST API
    let orderId;
    let paymentSessionId;
    try {
      const mobileDigits = String(req.user.mobile || "").replace(/\D/g, "").slice(-10);
      const { ok, data: cfData } = await cashfreeRequest(cf, "POST", "/orders", {
        order_id:       `order_${req.user.id.replace(/-/g, "").slice(0, 8)}_${Date.now()}`,
        order_amount:   Number(pkg.amount.toFixed(2)), // rupees (not paise)
        order_currency: "INR",
        customer_details: {
          customer_id:    req.user.id,
          customer_phone: mobileDigits,
          ...(req.user.email && { customer_email: req.user.email }),
          ...(req.user.name  && { customer_name:  req.user.name }),
        },
        order_tags: {
          userId:    req.user.id,
          packageId: pkg.id,
        },
      });

      if (!ok || !cfData.order_id || !cfData.payment_session_id) {
        return res.status(502).json({
          success: false,
          message: "Failed to create payment order with gateway",
          error:   cfData.message || "Gateway error",
        });
      }
      orderId          = cfData.order_id;
      paymentSessionId = cfData.payment_session_id;
    } catch (netErr) {
      return res.status(502).json({
        success: false,
        message: "Payment gateway network error",
      });
    }

    res.json({
      success: true,
      data: {
        orderId,
        paymentSessionId,
        environment: cf.env,
        amount:   Math.round(pkg.amount * 100),
        currency: "INR",
        package: {
          id: pkg.id, title: pkg.title || pkg.name, subtitle: pkg.subtitle,
          price: pkg.price || Math.round(pkg.amount), contacts: pkg.credits, validityDays: pkg.validityDays,
        },
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Flutter: POST /api/packages/verify-payment ────────────────────────────────
router.post("/verify-payment", userAuth, async (req, res) => {
  try {
    const { orderId, paymentId, packageId, status, error } = req.body;

    if (!packageId) {
      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "packageId is required",
        data:    { status: "FAILED", message: "packageId is required" },
      });
    }

    const pkg = await prisma.package.findUnique({ where: { id: packageId } });
    if (!pkg) {
      return res.status(404).json({
        success: false,
        status:  "FAILED",
        message: "Package not found",
        data:    { status: "FAILED", message: "Package not found" },
      });
    }

    // ── Handle Free Offer in verify-payment ────────────────────────────────────
    if (pkg.amount === 0) {
      const existing = await prisma.transaction.findFirst({
        where: { userId: req.user.id, packageId: pkg.id, status: "COMPLETED" },
      });
      if (existing) {
        return res.json({
          success: true,
          status:  "COMPLETED",
          message: "Offer already claimed",
          data:    { status: "COMPLETED", alreadyProcessed: true },
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.transaction.create({
          data: {
            userId:        req.user.id,
            packageId:     pkg.id,
            amount:        0,
            paymentMethod: "FREE_OFFER",
            status:        "COMPLETED",
          },
        });
        await tx.user.update({
          where: { id: req.user.id },
          data:  { credits: { increment: pkg.credits } },
        });
      });

      return res.json({
        success: true,
        status:  "COMPLETED",
        message: `${pkg.credits} credits added to your account`,
        data:    { status: "COMPLETED", credits: pkg.credits },
      });
    }

    // ── Check for explicit failure / cancellation from client ─────────────────
    if (status === "FAILED" || status === "CANCELLED" || req.body.cancelled === true || error) {
      if (orderId || paymentId) {
        await prisma.transaction.create({
          data: {
            userId:            req.user.id,
            packageId:         pkg.id,
            amount:            pkg.amount,
            paymentMethod:     "CASHFREE",
            paymentOrderId:    orderId   || null,
            paymentId:         paymentId ? String(paymentId) : null,
            status:            "FAILED",
          },
        });
      }

      return res.status(200).json({
        success: false,
        status:  "FAILED",
        message: "Payment failed or was cancelled by user",
        data: {
          status:  "FAILED",
          message: "Payment failed or was cancelled by user",
        },
      });
    }

    // ── Check duplicate payment (idempotency) ─────────────────────────────────
    if (orderId) {
      const existingCompleted = await prisma.transaction.findFirst({
        where: { paymentOrderId:  orderId, status: "COMPLETED" },
      });
      if (existingCompleted) {
        return res.json({
          success: true,
          status:  "COMPLETED",
          message: "Payment already processed",
          data: {
            status:           "COMPLETED",
            alreadyProcessed: true,
          },
        });
      }
    }

    // ── Server-side verification with Cashfree ────────────────────────────────
    const cf = getCashfreeConfig();

    if (!cf.appId || !cf.secretKey) {
      return res.status(500).json({
        success: false,
        status:  "FAILED",
        message: "Payment gateway configuration is missing",
        data:    { status: "FAILED", message: "Server payment configuration missing" },
      });
    }

    if (!orderId) {
      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "Missing payment verification parameters (orderId required)",
        data: {
          status:  "FAILED",
          message: "Missing payment verification parameters",
        },
      });
    }

    // Fetch order + payments directly from Cashfree (with retry buffer if order is still ACTIVE)
    let cfOrder;
    let successPayment;
    try {
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Check if the webhook completed it while waiting
        const completedInDb = await prisma.transaction.findFirst({
          where: { paymentOrderId: orderId, status: "COMPLETED" },
        });
        if (completedInDb) {
          return res.json({
            success: true,
            status:  "COMPLETED",
            message: `${pkg.credits} credits added to your account`,
            data: {
              status:           "COMPLETED",
              credits:          pkg.credits,
              alreadyProcessed: true,
            },
          });
        }

        const orderRes = await cashfreeRequest(cf, "GET", `/orders/${encodeURIComponent(orderId)}`);
        if (!orderRes.ok) {
          return res.status(400).json({
            success: false,
            status:  "FAILED",
            message: "Payment verification failed: order not found",
            data:    { status: "FAILED", message: "Payment verification failed" },
          });
        }
        cfOrder = orderRes.data;

        const paymentsRes = await cashfreeRequest(cf, "GET", `/orders/${encodeURIComponent(orderId)}/payments`);
        if (paymentsRes.ok && Array.isArray(paymentsRes.data)) {
          successPayment = paymentsRes.data.find(p => p.payment_status === "SUCCESS");
        }

        // If Cashfree confirmed PAID, proceed immediately to credit
        if (cfOrder.order_status === "PAID") break;

        // If order has permanently expired or terminated, stop retrying
        if (cfOrder.order_status !== "ACTIVE") break;

        // Wait 2 seconds before checking Cashfree again if order is still ACTIVE
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    } catch (netErr) {
      return res.status(502).json({
        success: false,
        status:  "FAILED",
        message: "Payment gateway network error",
        data:    { status: "FAILED", message: "Payment gateway network error" },
      });
    }

    const cfPaymentId = successPayment?.cf_payment_id != null ? String(successPayment.cf_payment_id) : (paymentId ? String(paymentId) : null);
    const orderMatches =
      cfOrder.customer_details?.customer_id === req.user.id &&
      (!cfOrder.order_tags?.packageId || cfOrder.order_tags.packageId === pkg.id) &&
      Math.abs(Number(cfOrder.order_amount) - pkg.amount) < 0.01;

    if (!orderMatches) {
      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "Payment verification failed: order does not match this user or package",
        data:    { status: "FAILED", message: "Payment verification failed" },
      });
    }

    if (cfOrder.order_status !== "PAID") {
      // Still ACTIVE (bank confirmation in transit) → return PENDING, don't fail!
      if (cfOrder.order_status === "ACTIVE") {
        return res.status(200).json({
          success: true,
          status:  "PENDING",
          message: "Payment is being confirmed by the bank. Your credits will update in a moment.",
          data: {
            status:  "PENDING",
            orderId: orderId,
            message: "Payment pending bank confirmation",
          },
        });
      }

      // Order has permanently failed / expired / terminated
      await prisma.transaction.create({
        data: {
          userId:            req.user.id,
          packageId:         pkg.id,
          amount:            pkg.amount,
          paymentMethod:     "CASHFREE",
          paymentOrderId:    orderId,
          paymentId:         cfPaymentId,
          status:            "FAILED",
        },
      });

      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "Payment verification failed: payment not completed",
        data: {
          status:  "FAILED",
          message: "Payment verification failed",
        },
      });
    }

    // ── Atomic Transaction & Credit Allocation ────────────────────────────────
    try {
      await prisma.$transaction(async (tx) => {
        // Re-verify duplicate within transaction lock
        const alreadyDone = await tx.transaction.findFirst({
          where: { paymentOrderId:  orderId, status: "COMPLETED" },
        });
        if (alreadyDone) return;

        await tx.transaction.create({
          data: {
            userId:            req.user.id,
            packageId:         pkg.id,
            amount:            pkg.amount, // strictly from DB
            paymentMethod:     "CASHFREE",
            paymentOrderId:    orderId,
            paymentId:         cfPaymentId,
            status:            "COMPLETED",
          },
        });

        await tx.user.update({
          where: { id: req.user.id },
          data:  { credits: { increment: pkg.credits } }, // strictly from DB
        });
      });
    } catch (err) {
      // Concurrent verify for the same order hit the unique index → already credited
      if (err.code === "P2002" || err.message?.includes("uq_payment_order_completed")) {
        return res.json({
          success: true,
          status:  "COMPLETED",
          message: "Payment already processed",
          data:    { status: "COMPLETED", alreadyProcessed: true },
        });
      }
      throw err;
    }

    res.json({
      success: true,
      status:  "COMPLETED",
      message: `${pkg.credits} credits added to your account`,
      data: {
        status:  "COMPLETED",
        credits: pkg.credits,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Flutter: POST /api/packages/payment-failed ────────────────────────────────
router.post("/payment-failed", userAuth, async (req, res) => {
  try {
    const { orderId, paymentId, packageId } = req.body;
    let pkg = null;
    if (packageId) {
      pkg = await prisma.package.findUnique({ where: { id: packageId } });
    }

    if (packageId || orderId || paymentId) {
      await prisma.transaction.create({
        data: {
          userId:            req.user.id,
          packageId:         pkg?.id || null,
          amount:            pkg?.amount || 0,
          paymentMethod:     "CASHFREE",
          paymentOrderId:    orderId   || null,
          paymentId:         paymentId ? String(paymentId) : null,
          status:            "FAILED",
        },
      });
    }

    res.json({
      success: false,
      status:  "FAILED",
      message: "Payment failed",
      data: {
        status:  "FAILED",
        message: "Payment failed",
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Flutter: POST /api/packages/cancel ────────────────────────────────────────
router.post("/cancel", userAuth, async (req, res) => {
  try {
    const { orderId, packageId } = req.body;
    let pkg = null;
    if (packageId) {
      pkg = await prisma.package.findUnique({ where: { id: packageId } });
    }

    if (packageId || orderId) {
      await prisma.transaction.create({
        data: {
          userId:          req.user.id,
          packageId:       pkg?.id || null,
          amount:          pkg?.amount || 0,
          paymentMethod:   "CASHFREE",
          paymentOrderId:  orderId || null,
          status:          "FAILED",
        },
      });
    }

    res.json({
      success: false,
      status:  "FAILED",
      message: "Payment cancelled by user",
      data: {
        status:  "FAILED",
        message: "Payment cancelled by user",
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Webhook Signature Verification ─────────────────────────────────────────────
function verifyCashfreeWebhookSignature(req) {
  const signature = req.headers["x-webhook-signature"];
  const timestamp = req.headers["x-webhook-timestamp"];
  const rawBody   = req.rawBody != null ? req.rawBody : (req.body ? JSON.stringify(req.body) : "");
  const cf        = getCashfreeConfig();

  const secretCandidates = [
    process.env.CASHFREE_WEBHOOK_SECRET,
    cf.secretKey,
  ].filter(Boolean);

  if (!signature || !timestamp || !rawBody) {
    return { valid: false, reason: "Missing x-webhook-signature, x-webhook-timestamp, or raw request body" };
  }

  if (secretCandidates.length === 0) {
    return { valid: false, reason: "Cashfree secret key is not configured on the server" };
  }

  // Prevent replay attacks (allow 5 min clock drift)
  const tsNum = Number(timestamp);
  if (!Number.isNaN(tsNum)) {
    const tsMs = tsNum < 1e12 ? tsNum * 1000 : tsNum;
    if (Math.abs(Date.now() - tsMs) > 5 * 60 * 1000) {
      return { valid: false, reason: "Webhook timestamp expired (older than 5 minutes)" };
    }
  }

  const signedPayload = `${timestamp}${rawBody}`;
  const sigBuffer = Buffer.from(signature, "utf8");

  for (const secret of secretCandidates) {
    try {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(signedPayload)
        .digest("base64");
      const expBuffer = Buffer.from(expected, "utf8");

      if (sigBuffer.length === expBuffer.length && crypto.timingSafeEqual(sigBuffer, expBuffer)) {
        return { valid: true };
      }
    } catch {
      // try next candidate
    }
  }

  return { valid: false, reason: "Webhook signature verification failed" };
}

// ── Cashfree Webhook Handler ──────────────────────────────────────────────────
async function handleCashfreeWebhook(req, res) {
  try {
    // 1. Verify Cashfree Webhook Signature
    const verification = verifyCashfreeWebhookSignature(req);
    if (!verification.valid) {
      console.warn(`[Cashfree Webhook] Verification rejected: ${verification.reason}`);
      return res.status(400).json({ success: false, message: verification.reason });
    }

    const event = req.body || {};
    const eventType = (event.type || "").toUpperCase();
    const eventData = event.data || {};
    const orderData = eventData.order || {};
    const paymentData = eventData.payment || {};
    const customerData = eventData.customer_details || {};

    // ── Handle Cashfree Dashboard Test Ping ───────────────────────────────────
    if (eventType === "WEBHOOK" || eventType === "TEST" || eventData.test_object) {
      return res.status(200).json({
        success: true,
        message: "Cashfree test webhook verified and acknowledged",
      });
    }

    const orderId = orderData.order_id || eventData.order_id || event.order_id;
    const cfPaymentId = paymentData.cf_payment_id != null ? String(paymentData.cf_payment_id) : null;
    const paymentStatus = (paymentData.payment_status || "").toUpperCase();

    if (!orderId) {
      return res.status(400).json({ success: false, message: "Missing order_id in webhook payload" });
    }

    const isSuccess =
      eventType === "PAYMENT_SUCCESS_WEBHOOK" ||
      eventType === "ORDER_PAID_WEBHOOK" ||
      paymentStatus === "SUCCESS";

    const isFailure =
      eventType === "PAYMENT_FAILED_WEBHOOK" ||
      eventType === "PAYMENT_USER_DROPPED_WEBHOOK" ||
      paymentStatus === "FAILED" ||
      paymentStatus === "USER_DROPPED";

    // ── CASE 1: PAYMENT SUCCESS ───────────────────────────────────────────────
    if (isSuccess) {
      // Idempotency check: already completed
      const existingTx = await prisma.transaction.findFirst({
        where: { paymentOrderId: orderId, status: "COMPLETED" },
      });
      if (existingTx) {
        return res.status(200).json({
          success: true,
          status:  "COMPLETED",
          message: "Payment already processed",
          orderId,
          alreadyProcessed: true,
        });
      }

      const orderTags = orderData.order_tags || {};
      let userId = orderTags.userId || customerData.customer_id;
      let packageId = orderTags.packageId;

      // Fallback: If tags are missing from webhook payload, query Cashfree API for order details
      if (!userId || !packageId) {
        try {
          const cf = getCashfreeConfig();
          const orderRes = await cashfreeRequest(cf, "GET", `/orders/${encodeURIComponent(orderId)}`);
          if (orderRes.ok && orderRes.data) {
            userId    = userId || orderRes.data.customer_details?.customer_id || orderRes.data.order_tags?.userId;
            packageId = packageId || orderRes.data.order_tags?.packageId;
          }
        } catch (fetchErr) {
          console.warn("[Cashfree Webhook] Could not fetch order details from Cashfree:", fetchErr.message);
        }
      }

      if (!userId) {
        console.error(`[Cashfree Webhook] Could not determine userId for order ${orderId}`);
        return res.status(200).json({ success: false, message: "User not found for this order" });
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        console.error(`[Cashfree Webhook] User ${userId} not found in database`);
        return res.status(200).json({ success: false, message: "User not found in database" });
      }

      let pkg = null;
      if (packageId) {
        pkg = await prisma.package.findUnique({ where: { id: packageId } });
      }
      if (!pkg && orderData.order_amount != null) {
        pkg = await prisma.package.findFirst({
          where: { amount: Number(orderData.order_amount), status: "ACTIVE" },
        });
      }

      if (!pkg) {
        console.error(`[Cashfree Webhook] Package not found for order ${orderId}`);
        return res.status(200).json({ success: false, message: "Package not found" });
      }

      // Atomic allocation & credit
      try {
        await prisma.$transaction(async (tx) => {
          const alreadyDone = await tx.transaction.findFirst({
            where: { paymentOrderId: orderId, status: "COMPLETED" },
          });
          if (alreadyDone) return;

          await tx.transaction.create({
            data: {
              userId:         user.id,
              packageId:      pkg.id,
              amount:         pkg.amount, // strictly from DB
              paymentMethod:  "CASHFREE",
              paymentOrderId: orderId,
              paymentId:      cfPaymentId,
              status:         "COMPLETED",
            },
          });

          await tx.user.update({
            where: { id: user.id },
            data:  { credits: { increment: pkg.credits } }, // strictly from DB
          });
        });
      } catch (err) {
        if (err.code === "P2002" || err.message?.includes("uq_payment_order_completed")) {
          return res.status(200).json({
            success: true,
            status:  "COMPLETED",
            message: "Payment already processed",
            alreadyProcessed: true,
          });
        }
        throw err;
      }

      return res.status(200).json({
        success: true,
        status:  "COMPLETED",
        message: `${pkg.credits} credits added to user account`,
        orderId,
      });
    }

    // ── CASE 2: PAYMENT FAILED / CANCELLED / DROPPED ─────────────────────────
    if (isFailure) {
      const existingCompleted = await prisma.transaction.findFirst({
        where: { paymentOrderId: orderId, status: "COMPLETED" },
      });
      if (existingCompleted) {
        return res.status(200).json({
          success: true,
          message: "Order already completed; failure event ignored",
        });
      }

      const orderTags = orderData.order_tags || {};
      const userId = orderTags.userId || customerData.customer_id;
      const packageId = orderTags.packageId;

      let pkg = null;
      if (packageId) {
        pkg = await prisma.package.findUnique({ where: { id: packageId } });
      }

      const existingFailed = await prisma.transaction.findFirst({
        where: { paymentOrderId: orderId, status: "FAILED" },
      });

      if (!existingFailed && userId) {
        await prisma.transaction.create({
          data: {
            userId,
            packageId:      pkg?.id || null,
            amount:         pkg?.amount || Number(orderData.order_amount || 0),
            paymentMethod:  "CASHFREE",
            paymentOrderId: orderId,
            paymentId:      cfPaymentId,
            status:         "FAILED",
          },
        });
      }

      return res.status(200).json({
        success: true,
        status:  "FAILED",
        message: "Payment failure recorded",
        orderId,
      });
    }

    // ── Other event types ────────────────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: `Webhook event ${eventType || "UNKNOWN"} acknowledged`,
    });
  } catch (err) {
    console.error("[Cashfree Webhook Error]:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
}

// Public Cashfree Webhook endpoints (no user auth required; secured by signature verification)
router.post("/webhook", handleCashfreeWebhook);
router.post("/cashfree-webhook", handleCashfreeWebhook);

// ── Admin routes ───────────────────────────────────────────────────────────────
router.get("/stats", adminAuth, async (_req, res) => {
  try {
    const [revenue, credits, transactions] = await Promise.all([
      prisma.transaction.aggregate({ _sum: { amount: true }, where: { status: "COMPLETED" } }),
      prisma.user.aggregate({ _sum: { credits: true } }),
      prisma.transaction.groupBy({
        by: ["packageId"],
        _count: { packageId: true },
        orderBy: { _count: { packageId: "desc" } },
        take: 1,
        where: { packageId: { not: null }, status: "COMPLETED" },
      }),
    ]);
    let topPackage = "—";
    if (transactions[0]?.packageId) {
      const pkg = await prisma.package.findUnique({ where: { id: transactions[0].packageId } });
      if (pkg) topPackage = pkg.name;
    }
    const totalUsers = await prisma.user.count();
    const paidUsers  = await prisma.transaction.groupBy({ by: ["userId"], where: { status: "COMPLETED" } });
    res.json({ data: { totalRevenue: revenue._sum.amount || 0, totalCredits: credits._sum.credits || 0, topPackage, conversionRate: totalUsers > 0 ? Math.round((paidUsers.length / totalUsers) * 100) : 0 } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/config", adminAuth, async (_req, res) => {
  try {
    let config = await prisma.appConfig.findUnique({ where: { id: "singleton" } });
    if (!config) config = await prisma.appConfig.create({ data: { id: "singleton" } });
    res.json({ data: { defaultCredits: config.defaultCredits, validityMonths: config.validityMonths } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put("/config", adminAuth, async (req, res) => {
  try {
    const { defaultCredits, validityMonths } = req.body;

    let creditUpdate = undefined;
    if (defaultCredits !== undefined && defaultCredits !== null && defaultCredits !== "") {
      const numCredits = Number(defaultCredits);
      if (isNaN(numCredits) || !Number.isInteger(numCredits) || numCredits < 0) {
        return res.status(400).json({ message: "defaultCredits must be a non-negative integer" });
      }
      creditUpdate = numCredits;
    }

    let validityUpdate = undefined;
    if (validityMonths !== undefined && validityMonths !== null && validityMonths !== "") {
      const numMonths = Number(validityMonths);
      if (isNaN(numMonths) || !Number.isInteger(numMonths) || numMonths < 0) {
        return res.status(400).json({ message: "validityMonths must be a non-negative integer" });
      }
      validityUpdate = numMonths;
    }

    const existing = await prisma.appConfig.findUnique({ where: { id: "singleton" } });
    const finalCredits = creditUpdate !== undefined ? creditUpdate : (existing?.defaultCredits ?? 3);
    const finalValidity = validityUpdate !== undefined ? validityUpdate : (existing?.validityMonths ?? 3);

    const config = await prisma.appConfig.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", defaultCredits: finalCredits, validityMonths: finalValidity },
      update: {
        ...(creditUpdate !== undefined && { defaultCredits: creditUpdate }),
        ...(validityUpdate !== undefined && { validityMonths: validityUpdate }),
      },
    });
    res.json({ data: config });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/approvals", adminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 20);
    const where = req.query.status ? { status: String(req.query.status).toUpperCase() } : {};
    const [total, approvals] = await Promise.all([
      prisma.profileApproval.count({ where }),
      prisma.profileApproval.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { submittedAt: "desc" },
        include: {
          user: {
            include: {
              personal: true,
              gallery: true,
              transactions: { orderBy: { createdAt: "desc" }, take: 1, include: { package: true } },
            },
          },
        },
      }),
    ]);

    const formattedApprovals = approvals.map(a => {
      const p = a.user?.personal;
      const age = p ? (p.age || (p.dobDay && p.dobMonth && p.dobYear ? getAgeFromDob(p.dobDay, p.dobMonth, p.dobYear, p.age) : 0)) : 0;
      const location = a.location || p?.native || "";
      return {
        ...a,
        location,
        user: a.user ? {
          ...a.user,
          personal: p ? {
            ...p,
            age: age || p.age || 0,
            native: p.native || location || "",
          } : p,
        } : a.user,
      };
    });

    res.json({ data: { data: formattedApprovals, total, page, limit } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch("/approvals/:id/approve", adminAuth, async (req, res) => {
  try {
    const approval = await prisma.profileApproval.update({ where: { id: req.params.id }, data: { status: "APPROVED", reviewedAt: new Date() } });
    await prisma.user.update({ where: { id: approval.userId }, data: { isVerified: true, status: "ACTIVE" } });
    await sendPush(approval.userId, "Profile Approved! 🎉", "Your profile is now live. Start exploring matches!");
    res.json({ data: approval });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Approval not found" });
    res.status(500).json({ message: err.message });
  }
});

router.patch("/approvals/:id/reject", adminAuth, async (req, res) => {
  try {
    const approval = await prisma.profileApproval.update({ where: { id: req.params.id }, data: { status: "REJECTED", reviewedAt: new Date() } });
    await sendPush(approval.userId, "Profile Update Required", "Your profile needs some changes. Please update and resubmit.");
    res.json({ data: approval });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Approval not found" });
    res.status(500).json({ message: err.message });
  }
});

router.post("/", adminAuth, async (req, res) => {
  try {
    const { name, credits, amount, status, description, validityDays, title, subtitle } = req.body;
    if (!name || String(name).trim() === "") {
      return res.status(400).json({ message: "Package name is required" });
    }
    if (credits === undefined || credits === null || credits === "" || isNaN(Number(credits)) || !Number.isInteger(Number(credits)) || Number(credits) < 0) {
      return res.status(400).json({ message: "Credits must be a non-negative integer" });
    }
    if (amount === undefined || amount === null || amount === "" || isNaN(Number(amount)) || !isFinite(Number(amount)) || Number(amount) < 0) {
      return res.status(400).json({ message: "Amount must be a non-negative number" });
    }
    let validDays = 90;
    if (validityDays !== undefined && validityDays !== null && validityDays !== "") {
      const parsedDays = Number(validityDays);
      if (isNaN(parsedDays) || !Number.isInteger(parsedDays) || parsedDays <= 0) {
        return res.status(400).json({ message: "validityDays must be a positive integer" });
      }
      validDays = parsedDays;
    }

    const numCredits = Number(credits);
    const numAmount = Number(amount);
    const validStatus = status && ["ACTIVE", "INACTIVE"].includes(String(status).toUpperCase()) ? String(status).toUpperCase() : "ACTIVE";

    const pkg = await prisma.package.create({
      data: {
        name:         String(name).trim(),
        title:        title ? String(title).trim() : null,
        subtitle:     subtitle ? String(subtitle).trim() : null,
        credits:      numCredits,
        amount:       numAmount,
        price:        Math.round(numAmount),
        status:       validStatus,
        description:  description ? String(description).trim() : null,
        validityDays: validDays,
      },
    });
    res.status(201).json({ data: pkg });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { name, credits, amount, status, description, validityDays, title, subtitle } = req.body;

    if (credits !== undefined && (credits === null || credits === "" || isNaN(Number(credits)) || !Number.isInteger(Number(credits)) || Number(credits) < 0)) {
      return res.status(400).json({ message: "Credits must be a non-negative integer" });
    }
    if (amount !== undefined && (amount === null || amount === "" || isNaN(Number(amount)) || !isFinite(Number(amount)) || Number(amount) < 0)) {
      return res.status(400).json({ message: "Amount must be a non-negative number" });
    }
    if (validityDays !== undefined && (validityDays === null || validityDays === "" || isNaN(Number(validityDays)) || !Number.isInteger(Number(validityDays)) || Number(validityDays) <= 0)) {
      return res.status(400).json({ message: "validityDays must be a positive integer" });
    }

    let validStatus = undefined;
    if (status !== undefined) {
      const upperStatus = String(status).toUpperCase();
      if (!["ACTIVE", "INACTIVE"].includes(upperStatus)) {
        return res.status(400).json({ message: "Invalid status. Allowed values: ACTIVE, INACTIVE" });
      }
      validStatus = upperStatus;
    }

    const updateData = {
      ...(name !== undefined && { name: String(name).trim() }),
      ...(title !== undefined && { title: title ? String(title).trim() : null }),
      ...(subtitle !== undefined && { subtitle: subtitle ? String(subtitle).trim() : null }),
      ...(credits !== undefined && { credits: Number(credits) }),
      ...(amount !== undefined && { amount: Number(amount), price: Math.round(Number(amount)) }),
      ...(validStatus !== undefined && { status: validStatus }),
      ...(description !== undefined && { description: description ? String(description).trim() : null }),
      ...(validityDays !== undefined && { validityDays: Number(validityDays) }),
    };

    const pkg = await prisma.package.update({
      where: { id: req.params.id },
      data:  updateData,
    });
    res.json({ data: pkg });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Package not found" });
    res.status(500).json({ message: err.message });
  }
});

router.delete("/:id", adminAuth, async (req, res) => {
  try {
    await prisma.package.delete({ where: { id: req.params.id } });
    res.json({ data: null });
  } catch (err) {
    if (err.code === "P2025") return res.status(404).json({ message: "Package not found" });
    res.status(500).json({ message: err.message });
  }
});

async function sendPush(userId, title, body) {
  try {
    const firebase = require("../lib/firebase");
    if (!firebase) return;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { fcmToken: true } });
    if (!user?.fcmToken) return;
    await firebase.messaging().send({ token: user.fcmToken, notification: { title, body } });
  } catch (err) { console.warn("FCM push failed:", err.message); }
}

module.exports = router;
