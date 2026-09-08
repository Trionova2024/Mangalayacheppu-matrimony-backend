require("dotenv").config();
const jwt    = require("jsonwebtoken");
const prisma = require("../lib/prisma");

module.exports = async function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  const match  = header?.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1].trim())
    return res.status(401).json({ message: "No token provided" });

  const token = match[1].trim();
  if (token === "null" || token === "undefined")
    return res.status(401).json({ message: "Invalid or expired token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const admin   = await prisma.admin.findUnique({ where: { id: payload.id } });
    if (!admin) return res.status(401).json({ message: "Admin not found" });
    req.admin = admin;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};
