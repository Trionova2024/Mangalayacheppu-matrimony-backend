const router   = require("express").Router();
const prisma   = require("../lib/prisma");
const userAuth = require("../middleware/userAuth");

// GET /api/privacy
router.get("/", userAuth, async (req, res) => {
  try {
    let privacy = await prisma.privacySettings.findUnique({ where: { userId: req.user.id } });
    if (!privacy) {
      privacy = await prisma.privacySettings.create({ data: { userId: req.user.id } });
    }
    res.json({ success: true, data: privacy });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// PUT /api/privacy
router.put("/", userAuth, async (req, res) => {
  try {
    const { profileVisible, showPhotoToAll, showPhoneNumber, showEmail, showHoroscope } = req.body;
    const fields = { profileVisible, showPhotoToAll, showPhoneNumber, showEmail, showHoroscope };
    const invalid = Object.keys(fields).filter(k => fields[k] !== undefined && typeof fields[k] !== "boolean");
    if (invalid.length) return res.status(400).json({ message: `${invalid.join(", ")} must be true or false` });

    const privacy = await prisma.privacySettings.upsert({
      where:  { userId: req.user.id },
      create: { userId: req.user.id, profileVisible, showPhotoToAll, showPhoneNumber, showEmail, showHoroscope },
      update: { profileVisible, showPhotoToAll, showPhoneNumber, showEmail, showHoroscope },
    });
    res.json({ success: true, data: privacy });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
