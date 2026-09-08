const router    = require("express").Router();
const prisma    = require("../lib/prisma");
const adminAuth = require("../middleware/adminAuth");

router.get("/stats", adminAuth, async (_req, res) => {
  try {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const [total, monthly, totalCount, completedCount, failedCount] = await Promise.all([
      prisma.transaction.aggregate({ _sum: { amount: true }, where: { status: "COMPLETED" } }),
      prisma.transaction.aggregate({ _sum: { amount: true }, where: { status: "COMPLETED", createdAt: { gte: monthStart } } }),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: "COMPLETED" } }),
      prisma.transaction.count({ where: { status: "FAILED" } }),
    ]);
    const successRate = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
    res.json({
      data: {
        totalRevenue:   total._sum.amount || 0,
        monthRevenue:   monthly._sum.amount || 0,
        totalCount,
        completedCount,
        failedCount,
        successRate,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/", adminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 50);
    const { status, paymentMethod } = req.query;

    const where = {};
    if (status) where.status = String(status).toUpperCase();
    if (paymentMethod) where.paymentMethod = String(paymentMethod).toUpperCase();

    const [total, txns] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              mobile: true,
              personal: { select: { fullName: true } },
            },
          },
          package: true,
        },
      }),
    ]);
    const data = txns.map(t => {
      const customerName = t.user?.personal?.fullName || t.user?.name || "Unknown";
      return {
        id:            t.id,
        uid:           t.id.slice(0, 8).toUpperCase(),
        name:          customerName,
        email:         t.user?.mobile || "",
        amount:        t.amount,
        payment:       t.paymentMethod || "RAZORPAY",
        paymentMethod: t.paymentMethod || "RAZORPAY",
        card:          t.cardInfo || "",
        status:        titleCase(t.status),
        date:          t.createdAt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }).toUpperCase(),
        createdAt:     t.createdAt,
      };
    });
    res.json({ data: { data, total, page, limit } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.delete("/:id", adminAuth, async (req, res) => {
  try {
    await prisma.transaction.delete({ where: { id: req.params.id } });
    res.json({ data: null });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s; }

module.exports = router;
