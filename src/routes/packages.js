const router    = require("express").Router();
const crypto    = require("crypto");
const prisma    = require("../lib/prisma");
const userAuth  = require("../middleware/userAuth");
const adminAuth = require("../middleware/adminAuth");
const jwt       = require("jsonwebtoken");
const { getAgeFromDob } = require("../utils/age");

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
        packages: packages.map(p => ({
          id: p.id, title: p.title || p.name, subtitle: p.subtitle || p.description,
          price: p.price || Math.round(p.amount), contacts: p.credits, validityDays: p.validityDays,
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

    // ── CASE B: NON-ZERO PACKAGE (Real Gateway Flow) ───────────────────────────
    const config = await prisma.appConfig.findUnique({ where: { id: "singleton" } });
    const keyId  = config?.razorpayKeyId || process.env.RAZORPAY_KEY_ID || "";
    const secret = config?.razorpaySecret || process.env.RAZORPAY_KEY_SECRET || "";

    if (!keyId || !secret) {
      return res.status(500).json({
        success: false,
        message: "Payment gateway configuration is missing",
      });
    }

    // Create real Razorpay order via Razorpay REST API
    let orderId;
    try {
      const auth = Buffer.from(`${keyId}:${secret}`).toString("base64");
      const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Basic ${auth}`,
        },
        body: JSON.stringify({
          amount:   Math.round(pkg.amount * 100), // paise
          currency: "INR",
          receipt:  `rcpt_${req.user.id.slice(0, 8)}_${Date.now()}`,
          notes: {
            userId:    req.user.id,
            packageId: pkg.id,
          },
        }),
      });

      const rzpData = await rzpRes.json();
      if (!rzpRes.ok || !rzpData.id) {
        return res.status(502).json({
          success: false,
          message: "Failed to create payment order with gateway",
          error:   rzpData.error?.description || "Gateway error",
        });
      }
      orderId = rzpData.id;
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
        amount:   Math.round(pkg.amount * 100),
        currency: "INR",
        keyId,
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
    const { orderId, paymentId, signature, packageId, status, error } = req.body;

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
            paymentMethod:     "RAZORPAY",
            razorpayOrderId:   orderId   || null,
            razorpayPaymentId: paymentId || null,
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
    if (paymentId) {
      const existingCompleted = await prisma.transaction.findFirst({
        where: { razorpayPaymentId: paymentId, status: "COMPLETED" },
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

    // ── Signature Verification ────────────────────────────────────────────────
    const config = await prisma.appConfig.findUnique({ where: { id: "singleton" } });
    const secret = config?.razorpaySecret || process.env.RAZORPAY_KEY_SECRET || "";

    if (!secret) {
      return res.status(500).json({
        success: false,
        status:  "FAILED",
        message: "Payment gateway configuration is missing",
        data:    { status: "FAILED", message: "Server payment configuration missing" },
      });
    }

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "Missing payment verification parameters (orderId, paymentId, signature required)",
        data: {
          status:  "FAILED",
          message: "Missing payment verification parameters",
        },
      });
    }

    const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
    if (expected !== signature) {
      // Record failed transaction
      await prisma.transaction.create({
        data: {
          userId:            req.user.id,
          packageId:         pkg.id,
          amount:            pkg.amount,
          paymentMethod:     "RAZORPAY",
          razorpayOrderId:   orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
          status:            "FAILED",
        },
      });

      return res.status(400).json({
        success: false,
        status:  "FAILED",
        message: "Payment verification failed: invalid signature",
        data: {
          status:  "FAILED",
          message: "Payment verification failed",
        },
      });
    }

    // ── Atomic Transaction & Credit Allocation ────────────────────────────────
    await prisma.$transaction(async (tx) => {
      // Re-verify duplicate within transaction lock
      const alreadyDone = await tx.transaction.findFirst({
        where: { razorpayPaymentId: paymentId, status: "COMPLETED" },
      });
      if (alreadyDone) return;

      await tx.transaction.create({
        data: {
          userId:            req.user.id,
          packageId:         pkg.id,
          amount:            pkg.amount, // strictly from DB
          paymentMethod:     "RAZORPAY",
          razorpayOrderId:   orderId,
          razorpayPaymentId: paymentId,
          razorpaySignature: signature,
          status:            "COMPLETED",
        },
      });

      await tx.user.update({
        where: { id: req.user.id },
        data:  { credits: { increment: pkg.credits } }, // strictly from DB
      });
    });

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
          paymentMethod:     "RAZORPAY",
          razorpayOrderId:   orderId   || null,
          razorpayPaymentId: paymentId || null,
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
          paymentMethod:   "RAZORPAY",
          razorpayOrderId: orderId || null,
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
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch("/approvals/:id/reject", adminAuth, async (req, res) => {
  try {
    const approval = await prisma.profileApproval.update({ where: { id: req.params.id }, data: { status: "REJECTED", reviewedAt: new Date() } });
    await sendPush(approval.userId, "Profile Update Required", "Your profile needs some changes. Please update and resubmit.");
    res.json({ data: approval });
  } catch (err) { res.status(500).json({ message: err.message }); }
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
  } catch (err) { res.status(500).json({ message: err.message }); }
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
