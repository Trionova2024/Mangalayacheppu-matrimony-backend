const router    = require("express").Router();
const prisma    = require("../lib/prisma");
const adminAuth = require("../middleware/adminAuth");
const userAuth  = require("../middleware/userAuth");
const { getAgeFromDob } = require("../utils/age");

// ── Admin: GET /api/users ──────────────────────────────────────────────────────
router.get("/", adminAuth, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.max(1, parseInt(req.query.limit) || 50);
    const search = req.query.search || "";
    const where  = search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { mobile: { contains: search } }] } : {};
    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" }, include: { personal: true } }),
    ]);
    res.json({ data: { data: users.map(formatAdminUser), total, page, limit } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: POST /api/users ────────────────────────────────────────────────────
router.post("/", adminAuth, async (req, res) => {
  try {
    const { name, email, age, phone, mobile, location, native, city, state, credits, status, gender, religion, caste } = req.body;

    const trimmedName = name !== undefined ? String(name).trim() : "";
    if (trimmedName !== "" && !/^[a-zA-Z\s.'-]+$/.test(trimmedName)) {
      return res.status(400).json({ message: "Name must contain only alphabetic characters" });
    }
    const newPhone = phone !== undefined ? phone : mobile;
    const trimmedMobile = newPhone !== undefined && newPhone !== "" ? String(newPhone).trim() : `admin_${Date.now()}`;
    const cleanEmail = email !== undefined && email !== null && email !== "" ? String(email).trim() : null;

    // Status validation (BE-12)
    const allowedStatuses = ["PENDING", "ACTIVE", "BLOCKED", "INACTIVE"];
    let cleanStatus = "ACTIVE";
    if (status !== undefined && status !== null && status !== "") {
      const upperStatus = String(status).toUpperCase();
      if (!allowedStatuses.includes(upperStatus)) {
        return res.status(400).json({ message: "Invalid status. Allowed values: PENDING, ACTIVE, BLOCKED, INACTIVE" });
      }
      cleanStatus = upperStatus;
    }

    // Age validation (BE-09 / QA-04)
    let ageVal = undefined;
    if (age !== undefined && age !== null && age !== "") {
      const numAge = Number(age);
      if (isNaN(numAge) || !Number.isInteger(numAge) || numAge < 18 || numAge > 120) {
        return res.status(400).json({ message: "Age must be a valid integer between 18 and 120" });
      }
      ageVal = numAge;
    }

    // Location mapping (BE-10 / QA-06)
    const locationVal = location !== undefined
      ? location
      : (native !== undefined
          ? native
          : (city || state ? [city, state].filter(Boolean).join(", ") : undefined));

    // Credits validation (QA-05)
    if (credits !== undefined && credits !== null && credits !== "") {
      const numCredits = Number(credits);
      if (isNaN(numCredits) || !Number.isInteger(numCredits) || numCredits < 0) {
        return res.status(400).json({ message: "Credits must be a non-negative integer" });
      }
    }

    const creditNum = Number(credits);
    const validCredits = !isNaN(creditNum) && Number.isInteger(creditNum) && creditNum >= 0 ? creditNum : 0;

    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          name:             trimmedName,
          mobile:           trimmedMobile,
          email:            cleanEmail,
          credits:          validCredits,
          freeContactsLeft: validCredits,
          status:           cleanStatus,
        },
      });

      const personalData = {
        fullName: trimmedName || undefined,
        ...(ageVal !== undefined && { age: ageVal }),
        ...(locationVal !== undefined && { native: String(locationVal).trim() }),
        ...(gender !== undefined && { gender: String(gender).trim() }),
        ...(religion !== undefined && { religion: String(religion).trim() }),
        ...(caste !== undefined && { caste: String(caste).trim() }),
      };

      if (Object.keys(personalData).length > 0) {
        await tx.personalProfile.create({
          data: {
            userId: createdUser.id,
            ...personalData,
          },
        });
      }

      return tx.user.findUnique({
        where:   { id: createdUser.id },
        include: { personal: true },
      });
    });

    res.status(201).json({ data: formatAdminUser(user) });
  } catch (err) {
    if (err.code === "P2002") return res.status(409).json({ message: "Email or mobile already exists" });
    res.status(500).json({ message: err.message });
  }
});

// ── Admin: PUT /api/users/:id ─────────────────────────────────────────────────
router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { name, email, age, phone, mobile, location, native, city, state, status, gender, religion, caste } = req.body;
    const trimmedName = name !== undefined ? String(name).trim() : undefined;
    if (trimmedName !== undefined && trimmedName !== "" && !/^[a-zA-Z\s.'-]+$/.test(trimmedName)) {
      return res.status(400).json({ message: "Name must contain only alphabetic characters" });
    }
    const newPhone = phone !== undefined ? phone : mobile;
    const trimmedMobile = newPhone !== undefined ? String(newPhone).trim() : undefined;
    const cleanEmail = email !== undefined ? (email === null || email === "" ? null : String(email).trim()) : undefined;
    
    // Status validation (BE-12)
    let cleanStatus = undefined;
    if (status !== undefined && status !== null && status !== "") {
      const upperStatus = String(status).toUpperCase();
      const allowedStatuses = ["PENDING", "ACTIVE", "BLOCKED", "INACTIVE"];
      if (!allowedStatuses.includes(upperStatus)) {
        return res.status(400).json({ message: "Invalid status. Allowed values: PENDING, ACTIVE, BLOCKED, INACTIVE" });
      }
      cleanStatus = upperStatus;
    }

    // Location mapping (BE-10)
    const locationVal = location !== undefined
      ? location
      : (native !== undefined
          ? native
          : (city || state ? [city, state].filter(Boolean).join(", ") : undefined));

    // Age validation (BE-09)
    let ageVal = undefined;
    if (age !== undefined && age !== null && age !== "") {
      const numAge = Number(age);
      if (isNaN(numAge) || !Number.isInteger(numAge) || numAge < 18 || numAge > 120) {
        return res.status(400).json({ message: "Age must be a valid integer between 18 and 120" });
      }
      ageVal = numAge;
    }

    const updateData = {
      ...(cleanEmail !== undefined && { email: cleanEmail }),
      ...(cleanStatus !== undefined && { status: cleanStatus }),
      ...(trimmedName !== undefined && { name: trimmedName }),
      ...(trimmedMobile !== undefined && { mobile: trimmedMobile }),
    };

    const personalData = {
      ...(trimmedName !== undefined && { fullName: trimmedName }),
      ...(ageVal !== undefined && { age: ageVal }),
      ...(locationVal !== undefined && { native: String(locationVal).trim() }),
      ...(gender !== undefined && { gender: String(gender).trim() }),
      ...(religion !== undefined && { religion: String(religion).trim() }),
      ...(caste !== undefined && { caste: String(caste).trim() }),
    };

    const user = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        const notFoundErr = new Error("User not found");
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      if (Object.keys(updateData).length > 0) {
        await tx.user.update({
          where: { id: req.params.id },
          data:  updateData,
        });
      }

      if (Object.keys(personalData).length > 0) {
        await tx.personalProfile.upsert({
          where:  { userId: req.params.id },
          create: { userId: req.params.id, ...personalData },
          update: personalData,
        });
      }

      return tx.user.findUnique({
        where:   { id: req.params.id },
        include: { personal: true },
      });
    });

    res.json({ data: formatAdminUser(user) });
  } catch (err) {
    if (err.status === 404 || err.code === "P2025") return res.status(404).json({ message: "User not found" });
    if (err.code === "P2002") return res.status(409).json({ message: "Email or mobile already exists" });
    res.status(500).json({ message: err.message });
  }
});

// ── Admin: DELETE /api/users/:id ──────────────────────────────────────────────
router.delete("/:id", adminAuth, async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ data: null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: PATCH /api/users/:id/credits ───────────────────────────────────────
router.patch("/:id/credits", adminAuth, async (req, res) => {
  try {
    const { credits, reason } = req.body;
    if (credits === undefined || credits === null) {
      return res.status(400).json({ message: "Credits value is required" });
    }
    const creditDelta = Number(credits);
    if (isNaN(creditDelta) || !Number.isInteger(creditDelta)) {
      return res.status(400).json({ message: "Credits must be a valid integer" });
    }

    const trimmedReason = typeof reason === "string" ? reason.trim().slice(0, 500) : undefined;

    const user = await prisma.$transaction(async (tx) => {
      const existing = await tx.user.findUnique({ where: { id: req.params.id } });
      if (!existing) {
        const notFoundErr = new Error("User not found");
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      const currentCredits = existing.credits || 0;
      const newCredits = Math.max(0, currentCredits + creditDelta);

      const updated = await tx.user.update({
        where: { id: req.params.id },
        data:  { credits: newCredits },
        include: { personal: true },
      });

      // Safely persist reason to credit audit log if the model is available
      if (tx.creditAuditLog) {
        try {
          await tx.creditAuditLog.create({
            data: {
              userId: req.params.id,
              adminId: req.admin?.id || null,
              amount: creditDelta,
              balanceAfter: newCredits,
              reason: trimmedReason || null,
            },
          });
        } catch (auditErr) {
          console.warn("Credit audit log write skipped/failed:", auditErr.message);
        }
      }

      return updated;
    });

    res.json({ data: formatAdminUser(user) });
  } catch (err) {
    if (err.status === 404 || err.code === "P2025") return res.status(404).json({ message: "User not found" });
    res.status(500).json({ message: err.message });
  }
});

// ── Admin: PATCH /api/users/:id/block  — toggle block ─────────────────────────
// This DIRECTLY affects the Flutter app — blocked user gets 403 on next API call
router.patch("/:id/block", adminAuth, async (req, res) => {
  try {
    const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: "User not found" });

    const newStatus = existing.status === "BLOCKED" ? "ACTIVE" : "BLOCKED";
    const user = await prisma.user.update({ where: { id: req.params.id }, data: { status: newStatus } });

    // Push notification to user's device about block/unblock
    if (user.fcmToken) {
      const firebase = require("../lib/firebase");
      if (firebase) {
        const msg = newStatus === "BLOCKED"
          ? "Your account has been suspended. Contact support."
          : "Your account has been reactivated. Welcome back!";
        firebase.messaging().send({ token: user.fcmToken, notification: { title: "Account Status Update", body: msg } }).catch(() => {});
      }
    }

    res.json({ data: formatAdminUser(user) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: GET /api/users/reports ─────────────────────────────────────────────
router.get("/reports", adminAuth, async (req, res) => {
  try {
    const { status, category, startDate, endDate, from, to } = req.query;
    const where = {};
    if (status) {
      where.status = String(status).toUpperCase();
    }
    if (category) {
      where.category = String(category).toUpperCase();
    }
    const start = startDate || from;
    const end = endDate || to;
    if (start || end) {
      where.createdAt = {};
      if (start) where.createdAt.gte = new Date(start);
      if (end) where.createdAt.lte = new Date(end);
    }

    const reports = await prisma.userReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { accused: { include: { personal: true } }, reporter: { select: { id: true, name: true, mobile: true } } },
    });
    res.json({ data: reports });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: PATCH /api/users/reports/:id/action ────────────────────────────────
// Takes action on report → enforced in Flutter via status check
router.patch("/reports/:id/action", adminAuth, async (req, res) => {
  try {
    const { action } = req.body; // WARNED | SUSPENDED | BANNED

    const report = await prisma.userReport.update({
      where: { id: req.params.id },
      data:  { action, status: "REVIEWED" },
      include: { accused: true },
    });

    if (action === "SUSPENDED") {
      await prisma.user.update({ where: { id: report.accusedId }, data: { status: "BLOCKED" } });
      // FCM notify
      if (report.accused.fcmToken) {
        const fb = require("../lib/firebase");
        if (fb) fb.messaging().send({ token: report.accused.fcmToken, notification: { title: "Account Suspended", body: "Your account has been temporarily suspended due to a violation." } }).catch(() => {});
      }
    } else if (action === "BANNED") {
      await prisma.user.delete({ where: { id: report.accusedId } });
    } else if (action === "WARNED") {
      if (report.accused.fcmToken) {
        const fb = require("../lib/firebase");
        if (fb) fb.messaging().send({ token: report.accused.fcmToken, notification: { title: "Warning", body: "You have received a warning for violating community guidelines." } }).catch(() => {});
      }
    }

    res.json({ data: { action } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Flutter: POST /api/users/report  — user reports another user ───────────────
router.post("/report", userAuth, async (req, res) => {
  try {
    const { accusedId, reason, category } = req.body;
    if (!accusedId || !reason) return res.status(400).json({ message: "accusedId and reason required" });

    const report = await prisma.userReport.create({
      data: { accusedId, reporterId: req.user.id, reason, category: category || "HARASSMENT" },
    });
    res.json({ success: true, data: report });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatAdminUser(u) {
  const p = u.personal;
  const age = p ? getAgeFromDob(p.dobDay, p.dobMonth, p.dobYear, p.age) : (p?.age || 0);
  return {
    id:       u.id,
    name:     p?.fullName || u.name,
    email:    u.email   || "",
    phone:    u.mobile  || "",
    age:      age || 0,
    location: p?.native || "",
    credits:  u.credits,
    status:   titleCase(u.status),
    createdAt: u.createdAt,
  };
}

function titleCase(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

module.exports = router;
