require("dotenv").config();
const jwt    = require("jsonwebtoken");
const prisma = require("../lib/prisma");

module.exports = async function userAuth(req, res, next) {
  const header = req.headers.authorization;
  const match  = header?.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1].trim())
    return res.status(401).json({ message: "No token provided" });

  const token = match[1].trim();
  if (token === "null" || token === "undefined")
    return res.status(401).json({ message: "Invalid or expired token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await prisma.user.findUnique({ where: { id: payload.id } });

    if (!user) return res.status(401).json({ message: "User not found" });

    // ── Block check — enforces admin block/suspend in the app ──────────────
    if (user.status === "BLOCKED") {
      return res.status(403).json({
        message: "Your account has been suspended. Please contact support.",
        code: "ACCOUNT_BLOCKED",
      });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};
