require("dotenv").config();
const router    = require("express").Router();
const jwt       = require("jsonwebtoken");
const bcrypt    = require("bcryptjs");
const prisma    = require("../lib/prisma");
const userAuth  = require("../middleware/userAuth");
const adminAuth = require("../middleware/adminAuth");
const { authLimiter } = require("../middleware/rateLimiter");

function makeToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || "7d" });
}

function userResponse(user) {
  return {
    id:               user.id,
    name:             user.name,
    mobile:           user.mobile,
    freeContactsLeft: user.freeContactsLeft,
    isProfileComplete: user.isProfileComplete,
    isVerified:       user.isVerified,
    fcmToken:         user.fcmToken,
    status:           user.status,
  };
}

// ── POST /api/auth/login
// Admin sends { email, password } → admin JWT
// Flutter sends { mobile } → OTP trigger
router.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password, mobile } = req.body;

    // ── Admin login (email + password) ─────────────────────────────────────
    if (email && password) {
      const admin = await prisma.admin.findUnique({ where: { email } });
      if (!admin) return res.status(401).json({ message: "Invalid credentials" });
      const valid = await bcrypt.compare(password, admin.password);
      if (!valid)  return res.status(401).json({ message: "Invalid credentials" });
      const token = makeToken(admin.id);
      return res.json({ data: { token, admin: { id: admin.id, name: admin.name, email: admin.email } } });
    }

    // ── Flutter login (mobile only) ────────────────────────────────────────
    if (mobile) {
      const user = await prisma.user.findUnique({ where: { mobile } });
      if (!user) return res.status(404).json({ message: "User not found. Please sign up." });
      if (user.status === "BLOCKED")
        return res.status(403).json({ message: "Account suspended. Contact support.", code: "ACCOUNT_BLOCKED" });
      return res.json({ success: true, message: "OTP sent via Firebase" });
    }

    return res.status(400).json({ message: "email+password or mobile required" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/signup ──────────────────────────────────────────────────────
router.post("/signup", authLimiter, async (req, res) => {
  try {
    const { mobile, name } = req.body;
    if (!mobile || !name) return res.status(400).json({ message: "mobile and name required" });

    const config = await prisma.appConfig.findUnique({ where: { id: "singleton" } });
    const defaultCredits = config?.defaultCredits ?? 3;

    let user = await prisma.user.findUnique({ where: { mobile } });
    if (!user) {
      user = await prisma.user.create({
        data: { mobile, name, credits: defaultCredits, freeContactsLeft: defaultCredits, status: "PENDING", isVerified: false },
      });
      // Auto-create ProfileApproval → appears in admin queue immediately
      await prisma.profileApproval.create({ data: { userId: user.id, status: "PENDING" } });
    }

    res.json({ success: true, message: "OTP sent via Firebase" });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ message: "Mobile already registered" });
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
router.post("/verify-otp", authLimiter, async (req, res) => {
  try {
    const { mobile, firebaseIdToken } = req.body;
    if (!mobile || !firebaseIdToken)
      return res.status(400).json({ message: "mobile and firebaseIdToken required" });

    let decodedMobile = mobile;
    try {
      const firebaseAdmin = require("../lib/firebase");
      if (firebaseAdmin && firebaseAdmin.apps?.length) {
        const decoded = await firebaseAdmin.auth().verifyIdToken(firebaseIdToken);
        decodedMobile = (decoded.phone_number || "").replace(/^\+91/, "") || mobile;
      }
    } catch (fbErr) {
      console.warn("Firebase verify skipped:", fbErr.message);
    }

    let user = await prisma.user.findUnique({ where: { mobile: decodedMobile } });
    if (!user && mobile && mobile !== decodedMobile) {
      user = await prisma.user.findUnique({ where: { mobile } });
    }
    if (!user) {
      const stripped   = (decodedMobile || "").replace(/^\+91/, "").trim();
      const withPrefix = `+91${stripped}`;
      user = await prisma.user.findFirst({
        where: {
          mobile: { in: [decodedMobile, stripped, withPrefix, mobile].filter(Boolean) },
        },
      });
    }

    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.status === "BLOCKED")
      return res.status(403).json({ message: "Account suspended. Contact support.", code: "ACCOUNT_BLOCKED" });

    const token = makeToken(user.id);
    const uData = userResponse(user);
    res.json({
      success: true,
      message: "Login successful",
      token,
      user: uData,
      data: {
        token,
        user: uData,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/auth/resend-otp ─────────────────────────────────────────────────
router.post("/resend-otp", authLimiter, async (req, res) => {
  const { mobile } = req.body;
  const user = await prisma.user.findUnique({ where: { mobile } }).catch(() => null);
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ success: true, message: "OTP resent via Firebase" });
});

// ── POST /api/auth/save-fcm-token ─────────────────────────────────────────────
router.post("/save-fcm-token", userAuth, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ message: "fcmToken required" });
    await prisma.user.update({ where: { id: req.user.id }, data: { fcmToken } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/auth/me  (admin) ─────────────────────────────────────────────────
router.get("/me", adminAuth, (req, res) => {
  const { id, name, email } = req.admin;
  res.json({ data: { id, name, email } });
});

// ── PUT /api/auth/profile  (admin) ────────────────────────────────────────────
router.put("/profile", adminAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const updated = await prisma.admin.update({ where: { id: req.admin.id }, data: { name } });
    res.json({ data: { id: updated.id, name: updated.name, email: updated.email } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PUT /api/auth/password  (admin) ───────────────────────────────────────────
router.put("/password", adminAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const valid = await bcrypt.compare(currentPassword, req.admin.password);
    if (!valid) return res.status(400).json({ message: "Current password incorrect" });
    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.admin.update({ where: { id: req.admin.id }, data: { password: hashed } });
    res.json({ data: null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
