const router    = require("express").Router();
const prisma    = require("../lib/prisma");
const userAuth  = require("../middleware/userAuth");
const adminAuth = require("../middleware/adminAuth");

// ── Flutter: GET /api/notifications/user  — user's notification list ──────────
router.get("/user", userAuth, async (req, res) => {
  try {
    const notifs = await prisma.notificationRecipient.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: "desc" },
      include: { notification: true },
      take:    50,
    });
    res.json({
      success: true,
      data: notifs.map(n => ({
        id:       n.notification.id,
        title:    n.notification.title,
        message:  n.notification.message,
        sentAt:   n.notification.sentAt,
        isRead:   Boolean(n.isRead),
        readAt:   n.readAt,
      })),
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Flutter: GET /api/notifications/unread-count ──────────────────────────────
router.get("/unread-count", userAuth, async (req, res) => {
  try {
    const unreadCount = await prisma.notificationRecipient.count({
      where: {
        userId: req.user.id,
        isRead: false,
      },
    });
    res.json({
      success: true,
      data: { unreadCount },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Flutter: PATCH /api/notifications/read-all ────────────────────────────────
router.patch("/read-all", userAuth, async (req, res) => {
  try {
    await prisma.notificationRecipient.updateMany({
      where: {
        userId: req.user.id,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
    res.json({ success: true, message: "All notifications marked as read" });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Flutter: PATCH /api/notifications/:id/read ────────────────────────────────
// Mark single notification as read with ownership verification (IDOR protection)
router.patch("/:id/read", userAuth, async (req, res) => {
  try {
    const notificationId = req.params.id;

    // Verify recipient record belonging to authenticated user
    const recipient = await prisma.notificationRecipient.findFirst({
      where: {
        notificationId,
        userId: req.user.id,
      },
    });

    if (!recipient) {
      return res.status(404).json({ message: "Notification not found" });
    }

    // Idempotently update read status
    const updated = await prisma.notificationRecipient.update({
      where: { id: recipient.id },
      data:  { isRead: true, readAt: recipient.readAt || new Date() },
    });

    res.json({
      success: true,
      message: "Notification marked as read",
      data: {
        id:     notificationId,
        isRead: true,
        readAt: updated.readAt,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: GET /api/notifications ─────────────────────────────────────────────
router.get("/", adminAuth, async (_req, res) => {
  try {
    const notifs = await prisma.notification.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ data: notifs });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: POST /api/notifications  — broadcast to all users via FCM ──────────
router.post("/", adminAuth, async (req, res) => {
  try {
    const { title, message, isDraft } = req.body;

    const notif = await prisma.notification.create({
      data: { title, message: message || "", type: "GLOBAL", isDraft: isDraft === true, sentAt: isDraft ? null : new Date() },
    });

    if (!isDraft) {
      // Send FCM to all users with tokens
      const users = await prisma.user.findMany({ where: { fcmToken: { not: null }, status: "ACTIVE" }, select: { id: true, fcmToken: true } });
      await sendMulticast(users.map(u => u.fcmToken).filter(Boolean), title, message || "");

      // Record recipients (isRead defaults to false)
      await prisma.notificationRecipient.createMany({
        data: users.map(u => ({ notificationId: notif.id, userId: u.id, isRead: false })),
        skipDuplicates: true,
      });
    }

    res.status(201).json({ data: notif });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.put("/:id", adminAuth, async (req, res) => {
  try {
    const { title, message, isDraft } = req.body;
    const notif = await prisma.notification.update({ where: { id: req.params.id }, data: { title, message, isDraft: isDraft === true } });
    res.json({ data: notif });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete("/:id", adminAuth, async (req, res) => {
  try {
    await prisma.notification.delete({ where: { id: req.params.id } });
    res.json({ data: null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: PATCH /api/notifications/:id/send  — send a saved draft ────────────
router.patch("/:id/send", adminAuth, async (req, res) => {
  try {
    const notif = await prisma.notification.update({ where: { id: req.params.id }, data: { isDraft: false, sentAt: new Date() } });
    const users = await prisma.user.findMany({ where: { fcmToken: { not: null }, status: "ACTIVE" }, select: { id: true, fcmToken: true } });
    await sendMulticast(users.map(u => u.fcmToken).filter(Boolean), notif.title, notif.message || "");

    // Record recipients (isRead defaults to false)
    await prisma.notificationRecipient.createMany({
      data: users.map(u => ({ notificationId: notif.id, userId: u.id, isRead: false })),
      skipDuplicates: true,
    });

    res.json({ data: notif });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: GET /api/notifications/expiring ────────────────────────────────────
router.get("/expiring", adminAuth, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const now  = new Date();
    const txns = await prisma.transaction.findMany({ where: { status: "COMPLETED", packageId: { not: null } }, orderBy: { createdAt: "desc" }, include: { user: true, package: true } });
    const seen = new Set();
    const expiring = [];
    for (const t of txns) {
      if (seen.has(t.userId) || !t.package) continue;
      seen.add(t.userId);
      const expiryDate = new Date(t.createdAt.getTime() + t.package.validityDays * 86400000);
      const daysLeft   = Math.ceil((expiryDate - now) / 86400000);
      if (daysLeft >= 0 && daysLeft <= days)
        expiring.push({ userId: t.userId, name: t.user.name, email: t.user.email || "", pack: t.package.name, expiryDate: expiryDate.toISOString(), daysLeft });
    }
    res.json({ data: expiring });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: POST /api/notifications/send-expiry/:userId ────────────────────────
router.post("/send-expiry/:userId", adminAuth, async (req, res) => {
  try {
    const { name, pack, daysLeft } = req.body;
    const title   = `Package Expiry — ${pack}`;
    const message = `Hi ${name}, your ${pack} package expires in ${daysLeft} day(s). Renew to keep access!`;
    const notif   = await prisma.notification.create({ data: { title, message, type: "INDIVIDUAL", isDraft: false, sentAt: new Date() } });
    await prisma.notificationRecipient.create({ data: { notificationId: notif.id, userId: req.params.userId, isRead: false } });
    const user = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { fcmToken: true } });
    if (user?.fcmToken) await sendPush(user.fcmToken, title, message);
    res.json({ data: notif });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── FCM helpers ────────────────────────────────────────────────────────────────
async function sendPush(token, title, body) {
  try {
    const fb = require("../lib/firebase");
    if (!fb) return;
    await fb.messaging().send({ token, notification: { title, body } });
  } catch (e) { console.warn("FCM single push failed:", e.message); }
}

async function sendMulticast(tokens, title, body) {
  if (!tokens.length) return;
  try {
    const fb = require("../lib/firebase");
    if (!fb) return;
    // Send in batches of 500 (FCM limit)
    for (let i = 0; i < tokens.length; i += 500) {
      const batch = tokens.slice(i, i + 500);
      await fb.messaging().sendEachForMulticast({ tokens: batch, notification: { title, body } });
    }
  } catch (e) { console.warn("FCM multicast failed:", e.message); }
}

module.exports = router;
