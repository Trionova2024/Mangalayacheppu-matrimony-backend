const router    = require("express").Router();
const prisma    = require("../lib/prisma");
const userAuth  = require("../middleware/userAuth");
const adminAuth = require("../middleware/adminAuth");

// ── Flutter: POST /api/support  — user opens a ticket ─────────────────────────
router.post("/create", userAuth, async (req, res) => {
  try {
    const { subject, message } = req.body;
    const ticket = await prisma.supportTicket.create({
      data: {
        userId:  req.user.id,
        name:    req.user.name,
        email:   req.user.email || req.user.mobile,
        subject: subject || "General Enquiry",
      },
    });
    if (message) {
      await prisma.supportMessage.create({ data: { ticketId: ticket.id, sender: "CUSTOMER", text: message } });
    }
    res.status(201).json({ success: true, data: ticket });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Admin: GET /api/support ───────────────────────────────────────────────────
router.get("/", adminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 50);
    const [total, tickets] = await Promise.all([
      prisma.supportTicket.count(),
      prisma.supportTicket.findMany({ skip: (page - 1) * limit, take: limit, orderBy: { updatedAt: "desc" }, include: { messages: { orderBy: { createdAt: "asc" } } } }),
    ]);
    res.json({ data: { data: tickets, total, page, limit } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/:id", adminAuth, async (req, res) => {
  try {
    const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, include: { messages: { orderBy: { createdAt: "asc" } } } });
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    res.json({ data: ticket });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Admin replies → sends FCM push to user
router.post("/:id/messages", adminAuth, async (req, res) => {
  try {
    const { text, sender } = req.body;
    const msg = await prisma.supportMessage.create({ data: { ticketId: req.params.id, sender: sender || "ADMIN", text } });
    const ticket = await prisma.supportTicket.update({ where: { id: req.params.id }, data: { status: "PENDING", updatedAt: new Date() }, include: { user: true } });
    // Push to user
    if (ticket.user?.fcmToken) {
      const fb = require("../lib/firebase");
      if (fb) fb.messaging().send({ token: ticket.user.fcmToken, notification: { title: "Support Reply", body: text.slice(0, 100) } }).catch(() => {});
    }
    res.status(201).json({ data: msg });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.patch("/:id/status", adminAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const ticket = await prisma.supportTicket.update({ where: { id: req.params.id }, data: { status } });
    res.json({ data: ticket });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
