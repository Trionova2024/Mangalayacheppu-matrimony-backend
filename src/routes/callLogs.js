// callLogs.js
const router    = require("express").Router();
const prisma    = require("../lib/prisma");
const adminAuth = require("../middleware/adminAuth");

function getDateRange(period, startDate, endDate, from, to) {
  const now = new Date();
  let gte = undefined;
  let lte = undefined;

  const p = (period || "").trim().toLowerCase().replace(/[\s_-]+/g, "");

  if (p === "today") {
    gte = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    lte = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (p === "thisweek" || p === "week") {
    const dayOfWeek = now.getDay();
    gte = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek, 0, 0, 0, 0);
    lte = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  } else if (p === "thismonth" || p === "month") {
    gte = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    lte = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (p === "thisyear" || p === "year") {
    gte = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    lte = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  }

  const customStart = startDate || from;
  const customEnd = endDate || to;
  if (customStart) {
    const d = new Date(customStart);
    if (!isNaN(d.getTime())) gte = d;
  }
  if (customEnd) {
    const d = new Date(customEnd);
    if (!isNaN(d.getTime())) lte = d;
  }

  if (gte || lte) {
    return {
      ...(gte && { gte }),
      ...(lte && { lte }),
    };
  }
  return undefined;
}

router.get("/", adminAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 50);
    const { period, range, filter, startDate, endDate, from, to } = req.query;

    const dateFilter = getDateRange(period || range || filter, startDate, endDate, from, to);
    const where = dateFilter ? { createdAt: dateFilter } : {};

    const [total, logs] = await Promise.all([
      prisma.callLog.count({ where }),
      prisma.callLog.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          locker: { select: { id: true, name: true, mobile: true } },
          viewed: { select: { id: true, name: true, mobile: true } },
        },
      }),
    ]);
    res.json({
      data: {
        data: logs.map(l => ({
          id:      l.id,
          locker:  { name: l.locker?.name || "Unknown", email: l.locker?.mobile || "" },
          viewed:  { name: l.viewed?.name || "Unknown", email: l.viewed?.mobile || "" },
          date:    l.createdAt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }).toUpperCase(),
          time:    l.createdAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
          credits: l.credits,
          pack:    l.pack,
        })),
        total,
        page,
        limit,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
