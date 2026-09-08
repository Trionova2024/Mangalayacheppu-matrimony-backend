const router    = require("express").Router();
const prisma    = require("../lib/prisma");
const adminAuth = require("../middleware/adminAuth");
const { getAgeFromDob } = require("../utils/age");

function fmtDate(d) { return new Date(d).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }).toUpperCase(); }
function daysSince(d) { return Math.floor((Date.now() - new Date(d).getTime()) / 86400000); }

function buildDateFilter(startDate, endDate, from, to) {
  const start = startDate || from;
  const end   = endDate || to;
  if (!start && !end) return undefined;
  const filter = {};
  if (start) {
    const d = new Date(start);
    if (!isNaN(d.getTime())) filter.gte = d;
  }
  if (end) {
    const d = new Date(end);
    if (!isNaN(d.getTime())) filter.lte = d;
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

router.get("/", adminAuth, async (_req, res) => {
  res.json({ data: [
    { title: "All Users",          tag: "User",      tagColor: "#6B7280", tagBg: "#F3F4F6" },
    { title: "New Signups",        tag: "User",      tagColor: "#6B7280", tagBg: "#F3F4F6" },
    { title: "Inactive Users",     tag: "Activity",  tagColor: "#B45309", tagBg: "#FEF3C7" },
    { title: "Transaction Report", tag: "Finance",   tagColor: "#1D4ED8", tagBg: "#DBEAFE" },
    { title: "Paid Users",         tag: "Paid User", tagColor: "#C9A84C", tagBg: "#FEF3C7" },
    { title: "Churn Analysis",     tag: "Retention", tagColor: "#8B1A2B", tagBg: "#FEE2E2" },
  ]});
});

router.post("/generate", adminAuth, async (req, res) => {
  res.json({ data: { title: req.body.title, generatedAt: new Date() } });
});

router.get("/data", adminAuth, async (req, res) => {
  try {
    const title = req.query.title || "All Users";
    const { status, startDate, endDate, from, to, paymentMethod, method, search } = req.query;
    const dateFilter = buildDateFilter(startDate, endDate, from, to);

    switch (title) {
      case "All Users": {
        const where = {};
        if (status) where.status = String(status).toUpperCase();
        if (dateFilter) where.createdAt = dateFilter;
        if (search) {
          where.OR = [
            { name: { contains: String(search), mode: "insensitive" } },
            { mobile: { contains: String(search) } },
          ];
        }

        const users = await prisma.user.findMany({
          where,
          orderBy: { createdAt: "desc" },
          include: { personal: true },
        });

        return res.json({
          data: users.map(u => {
            const p = u.personal;
            const age = p ? (p.age || (p.dobDay && p.dobMonth && p.dobYear ? getAgeFromDob(p.dobDay, p.dobMonth, p.dobYear, p.age) : "—")) : "—";
            return {
              id:       u.id,
              name:     p?.fullName || u.name,
              email:    u.email || "—",
              age:      age || "—",
              phone:    u.mobile,
              location: p?.native || "—",
              status:   u.status,
              credits:  u.credits,
              date:     fmtDate(u.createdAt),
            };
          }),
        });
      }

      case "New Signups": {
        const defaultStart = new Date(Date.now() - 30 * 86400000);
        const where = {
          createdAt: dateFilter || { gte: defaultStart },
        };
        if (status) where.status = String(status).toUpperCase();

        const users = await prisma.user.findMany({
          where,
          orderBy: { createdAt: "desc" },
          include: { personal: true },
        });

        return res.json({
          data: users.map(u => ({
            id:     u.id,
            name:   u.personal?.fullName || u.name,
            email:  u.email || "—",
            status: u.status,
            date:   fmtDate(u.createdAt),
          })),
        });
      }

      case "Inactive Users": {
        const where = {
          status: status ? String(status).toUpperCase() : { in: ["INACTIVE", "BLOCKED"] },
        };
        if (dateFilter) where.updatedAt = dateFilter;

        const users = await prisma.user.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          include: { personal: true },
        });

        return res.json({
          data: users.map(u => ({
            id:        u.id,
            name:      u.personal?.fullName || u.name,
            email:     u.email || "—",
            status:    u.status,
            daysSince: daysSince(u.updatedAt),
            date:      fmtDate(u.updatedAt),
          })),
        });
      }

      case "Transaction Report": {
        const where = {};
        if (status) where.status = String(status).toUpperCase();
        const payMethod = paymentMethod || method;
        if (payMethod) where.paymentMethod = String(payMethod).toUpperCase();
        if (dateFilter) where.createdAt = dateFilter;

        const txns = await prisma.transaction.findMany({
          where,
          orderBy: { createdAt: "desc" },
          include: {
            user: { include: { personal: true } },
            package: true,
          },
        });

        return res.json({
          data: txns.map(t => ({
            id:      t.id,
            name:    t.user?.personal?.fullName || t.user?.name || "—",
            email:   t.user?.mobile || "—",
            amount:  t.amount,
            package: t.package?.name || "—",
            status:  t.status,
            method:  t.paymentMethod,
            date:    fmtDate(t.createdAt),
          })),
        });
      }

      case "Paid Users": {
        const where = {
          status: status ? String(status).toUpperCase() : "COMPLETED",
        };
        const payMethod = paymentMethod || method;
        if (payMethod) where.paymentMethod = String(payMethod).toUpperCase();
        if (dateFilter) where.createdAt = dateFilter;

        const txns = await prisma.transaction.findMany({
          where,
          distinct: ["userId"],
          include: {
            user: { include: { personal: true } },
            package: true,
          },
          orderBy: { createdAt: "desc" },
        });

        return res.json({
          data: txns.map(t => ({
            id:      t.userId,
            name:    t.user?.personal?.fullName || t.user?.name || "—",
            email:   t.user?.mobile || "—",
            package: t.package?.name || "—",
            amount:  t.amount,
            date:    fmtDate(t.createdAt),
          })),
        });
      }

      case "Churn Analysis": {
        const defaultThreshold = new Date(Date.now() - 90 * 86400000);
        const where = {
          AND: [
            { status: status ? String(status).toUpperCase() : { not: "BLOCKED" } },
            { updatedAt: dateFilter || { lte: defaultThreshold } },
          ],
        };

        const users = await prisma.user.findMany({
          where,
          orderBy: { updatedAt: "asc" },
          include: { personal: true },
        });

        return res.json({
          data: users.map(u => ({
            id:        u.id,
            name:      u.personal?.fullName || u.name,
            email:     u.email || "—",
            daysSince: daysSince(u.updatedAt),
            status:    u.status,
            date:      fmtDate(u.updatedAt),
          })),
        });
      }

      default: return res.status(400).json({ message: "Unknown report type" });
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
