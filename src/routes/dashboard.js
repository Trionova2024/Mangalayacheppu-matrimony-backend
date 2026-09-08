// dashboard.js
const router    = require("express").Router();
const prisma    = require("../lib/prisma");
const adminAuth = require("../middleware/adminAuth");

router.get("/stats", adminAuth, async (_req, res) => {
  try {
    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const [totalUsers, userGrowth, allRev, monthRev, openTickets, pendingApprovals, newMembers] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: monthStart } } }),
      prisma.transaction.aggregate({ _sum: { amount: true }, where: { status: "COMPLETED" } }),
      prisma.transaction.aggregate({ _sum: { amount: true }, where: { status: "COMPLETED", createdAt: { gte: monthStart } } }),
      prisma.supportTicket.count({ where: { status: { in: ["OPEN","PENDING"] } } }),
      prisma.profileApproval.count({ where: { status: "PENDING" } }),
      prisma.user.findMany({ where: { createdAt: { gte: monthStart } }, orderBy: { createdAt: "desc" }, take: 8, select: { id: true, name: true, status: true, createdAt: true } }),
    ]);
    res.json({ data: { totalUsers, userGrowth, totalRevenue: allRev._sum.amount || 0, monthRevenue: monthRev._sum.amount || 0, openTickets, pendingApprovals, newMembers } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/revenue", adminAuth, async (req, res) => {
  try {
    const year   = parseInt(req.query.year) || new Date().getFullYear();
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const startOfYear = new Date(year, 0, 1, 0, 0, 0, 0);
    const endOfYear   = new Date(year, 11, 31, 23, 59, 59, 999);

    const txns = await prisma.transaction.findMany({
      where: {
        status: "COMPLETED",
        createdAt: {
          gte: startOfYear,
          lte: endOfYear,
        },
      },
      select: { amount: true, createdAt: true },
    });

    const byMonth = Array(12).fill(0);
    txns.forEach(t => {
      const m = new Date(t.createdAt).getMonth();
      if (m >= 0 && m < 12) {
        byMonth[m] += Number(t.amount) || 0;
      }
    });

    res.json({ data: MONTHS.map((month, i) => ({ month, revenue: Math.round(byMonth[i]) })) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/growth", adminAuth, async (req, res) => {
  try {
    const year   = parseInt(req.query.year) || new Date().getFullYear();
    const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const startOfYear = new Date(year, 0, 1, 0, 0, 0, 0);
    const endOfYear   = new Date(year, 11, 31, 23, 59, 59, 999);

    const users = await prisma.user.findMany({
      where: {
        createdAt: {
          gte: startOfYear,
          lte: endOfYear,
        },
      },
      select: { createdAt: true },
    });

    const byMonth = Array(12).fill(0);
    users.forEach(u => {
      const m = new Date(u.createdAt).getMonth();
      if (m >= 0 && m < 12) {
        byMonth[m]++;
      }
    });

    res.json({ data: MONTHS.map((month, i) => ({ month, users: byMonth[i] })) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get("/broadcasts", adminAuth, async (_req, res) => {
  try {
    const notifs = await prisma.notification.findMany({ where: { isDraft: false }, orderBy: { sentAt: "desc" }, take: 5 });
    res.json({ data: notifs });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
