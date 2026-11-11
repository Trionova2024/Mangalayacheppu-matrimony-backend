const router    = require("express").Router();
const crypto    = require("crypto");
const prisma    = require("../lib/prisma");
const { LIVE_USER, VISIBLE_TRANSACTION } = require("../utils/softDelete");
const userAuth  = require("../middleware/userAuth");
const adminAuth = require("../middleware/adminAuth");
const jwt       = require("jsonwebtoken");
const { getAgeFromDob } = require("../utils/age");
const {
  GooglePlayCatalogError,
  isGooglePlaySyncEnabled,
  buildGooglePlayProductId,
  syncGooglePlayProduct,
  deactivateGooglePlayProduct,
} = require("../services/googlePlayCatalogService");

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
    const user = await prisma.user.findUnique({ where: { id: payload.id } }); // excludes soft-deleted
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
        paymentProvider: "IAP",
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

    // ── CASE B: PAID PACKAGE ─────────────────────────────────────────────────
    // Paid packages are sold only through Google Play / Apple In-App Purchase
    // (see /api/payments/google-play/verify and /api/payments/apple/verify).
    return res.status(400).json({
      success: false,
      message: "Paid packages must be purchased through Google Play or the App Store.",
      code: "IAP_PROVIDER_ACTIVE",
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin routes ───────────────────────────────────────────────────────────────
router.get("/stats", adminAuth, async (_req, res) => {
  try {
    const [revenue, credits, transactions] = await Promise.all([
      prisma.transaction.aggregate({ _sum: { amount: true }, where: { ...VISIBLE_TRANSACTION, status: "COMPLETED" } }),
      prisma.user.aggregate({ _sum: { credits: true } }), // excludes soft-deleted users
      prisma.transaction.groupBy({
        by: ["packageId"],
        _count: { packageId: true },
        orderBy: { _count: { packageId: "desc" } },
        take: 1,
        where: { ...VISIBLE_TRANSACTION, packageId: { not: null }, package: { isDeleted: false }, status: "COMPLETED" },
      }),
    ]);
    let topPackage = "—";
    if (transactions[0]?.packageId) {
      const pkg = await prisma.package.findUnique({ where: { id: transactions[0].packageId } });
      if (pkg) topPackage = pkg.name;
    }
    const totalUsers = await prisma.user.count();
    const paidUsers  = await prisma.transaction.groupBy({ by: ["userId"], where: { ...VISIBLE_TRANSACTION, status: "COMPLETED" } });
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
    const where = { user: LIVE_USER, ...(req.query.status && { status: String(req.query.status).toUpperCase() }) };
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
              transactions: { where: { isDeleted: false }, orderBy: { createdAt: "desc" }, take: 1, include: { package: true } },
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

// Google Play product IDs must start with a lowercase letter or number and may only
// contain lowercase letters, numbers, underscores and periods.
const GOOGLE_PLAY_PRODUCT_ID_RE = /^[a-z0-9][a-z0-9_.]*$/;

// Returns { value } (null clears the mapping) or { error } for an invalid product ID.
function parseGooglePlayProductId(raw) {
  if (raw === null || raw === "") return { value: null };
  const value = String(raw).trim();
  if (!value) return { value: null };
  if (!GOOGLE_PLAY_PRODUCT_ID_RE.test(value)) {
    return { error: "googlePlayProductId must start with a lowercase letter or number and contain only lowercase letters, numbers, underscores (_) and periods (.)" };
  }
  return { value };
}

function isGooglePlayProductIdConflict(err) {
  return err.code === "P2002" && String(err.meta?.target || "").includes("googlePlayProductId");
}

const GOOGLE_PLAY_PRODUCT_ID_CONFLICT = "This googlePlayProductId is already linked to another package";

// Checked before calling Google so we never overwrite the Google product of another package.
async function isGooglePlayProductIdTaken(productId, excludePackageId) {
  const owner = await prisma.package.findFirst({
    // include deleted packages: Google Play product IDs can never be reused
    where: { googlePlayProductId: productId, isDeleted: undefined, ...(excludePackageId && { NOT: { id: excludePackageId } }) },
    select: { id: true },
  });
  return Boolean(owner);
}

router.post("/", adminAuth, async (req, res) => {
  try {
    const { name, credits, amount, status, description, validityDays, title, subtitle, googlePlayProductId } = req.body;
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

    const productId = googlePlayProductId !== undefined ? parseGooglePlayProductId(googlePlayProductId) : { value: null };
    if (productId.error) return res.status(400).json({ message: productId.error });

    const numCredits = Number(credits);
    const numAmount = Number(amount);
    const validStatus = status && ["ACTIVE", "INACTIVE"].includes(String(status).toUpperCase()) ? String(status).toUpperCase() : "ACTIVE";

    const data = {
      id:           crypto.randomUUID(),
      name:         String(name).trim(),
      title:        title ? String(title).trim() : null,
      subtitle:     subtitle ? String(subtitle).trim() : null,
      credits:      numCredits,
      amount:       numAmount,
      price:        Math.round(numAmount),
      status:       validStatus,
      description:  description ? String(description).trim() : null,
      validityDays: validDays,
      googlePlayProductId: productId.value,
    };

    // Paid packages are created on Google Play first; the package is saved only if that succeeds
    const syncToGoogle = isGooglePlaySyncEnabled() && numAmount > 0;
    if (syncToGoogle) {
      data.googlePlayProductId = data.googlePlayProductId || buildGooglePlayProductId(data);
      if (await isGooglePlayProductIdTaken(data.googlePlayProductId)) {
        return res.status(409).json({ message: GOOGLE_PLAY_PRODUCT_ID_CONFLICT });
      }
      await syncGooglePlayProduct(data, data.googlePlayProductId);
    }

    let pkg;
    try {
      pkg = await prisma.package.create({ data });
    } catch (dbErr) {
      if (syncToGoogle) await deactivateGooglePlayProduct(data.googlePlayProductId);
      throw dbErr;
    }
    res.status(201).json({ data: pkg });
  } catch (err) {
    if (err instanceof GooglePlayCatalogError) return res.status(err.statusCode).json({ message: err.message });
    if (isGooglePlayProductIdConflict(err)) return res.status(409).json({ message: GOOGLE_PLAY_PRODUCT_ID_CONFLICT });
    res.status(500).json({ message: err.message });
  }
});

router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { name, credits, amount, status, description, validityDays, title, subtitle, googlePlayProductId } = req.body;

    if (credits !== undefined && (credits === null || credits === "" || isNaN(Number(credits)) || !Number.isInteger(Number(credits)) || Number(credits) < 0)) {
      return res.status(400).json({ message: "Credits must be a non-negative integer" });
    }
    if (amount !== undefined && (amount === null || amount === "" || isNaN(Number(amount)) || !isFinite(Number(amount)) || Number(amount) < 0)) {
      return res.status(400).json({ message: "Amount must be a non-negative number" });
    }
    if (validityDays !== undefined && (validityDays === null || validityDays === "" || isNaN(Number(validityDays)) || !Number.isInteger(Number(validityDays)) || Number(validityDays) <= 0)) {
      return res.status(400).json({ message: "validityDays must be a positive integer" });
    }

    const productId = googlePlayProductId !== undefined ? parseGooglePlayProductId(googlePlayProductId) : null;
    if (productId?.error) return res.status(400).json({ message: productId.error });

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
      ...(productId && { googlePlayProductId: productId.value }),
    };

    const existing = await prisma.package.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: "Package not found" });

    if (isGooglePlaySyncEnabled()) {
      const merged = { ...existing, ...updateData };

      if (merged.amount > 0) {
        // Keep the existing Google product unless the admin links a different one; create one if missing
        const targetProductId = productId?.value || existing.googlePlayProductId || buildGooglePlayProductId(merged);
        if (targetProductId !== existing.googlePlayProductId && await isGooglePlayProductIdTaken(targetProductId, existing.id)) {
          return res.status(409).json({ message: GOOGLE_PLAY_PRODUCT_ID_CONFLICT });
        }

        await syncGooglePlayProduct(merged, targetProductId);
        if (existing.googlePlayProductId && existing.googlePlayProductId !== targetProductId) {
          await deactivateGooglePlayProduct(existing.googlePlayProductId);
        }
        updateData.googlePlayProductId = targetProductId;
      } else if (existing.googlePlayProductId) {
        // Package became free: stop selling it on Google Play
        await deactivateGooglePlayProduct(existing.googlePlayProductId);
      }
    }

    const pkg = await prisma.package.update({
      where: { id: req.params.id },
      data:  updateData,
    });
    res.json({ data: pkg });
  } catch (err) {
    if (err instanceof GooglePlayCatalogError) return res.status(err.statusCode).json({ message: err.message });
    if (err.code === "P2025") return res.status(404).json({ message: "Package not found" });
    if (isGooglePlayProductIdConflict(err)) return res.status(409).json({ message: GOOGLE_PLAY_PRODUCT_ID_CONFLICT });
    res.status(500).json({ message: err.message });
  }
});

router.delete("/:id", adminAuth, async (req, res) => {
  try {
    // SOFT delete — kept in DB so old transactions keep their package; hidden from app & admin
    const existing = await prisma.package.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: "Package not found" });
    const pkg = await prisma.package.update({ where: { id: existing.id }, data: { isDeleted: true } });
    // Google Play product IDs can never be deleted and reused, so the product is only deactivated
    if (isGooglePlaySyncEnabled() && pkg.googlePlayProductId) {
      await deactivateGooglePlayProduct(pkg.googlePlayProductId);
    }
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
