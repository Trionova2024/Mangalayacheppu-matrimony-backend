const router   = require("express").Router();
const multer   = require("multer");
const path     = require("path");
const fs       = require("fs");
const prisma   = require("../lib/prisma");
const userAuth = require("../middleware/userAuth");

// ── Multer setup ───────────────────────────────────────────────────────────────
const uploadDir = path.join(__dirname, "../../", process.env.UPLOAD_DIR || "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:    (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files allowed"), false);
  },
});

// ── GET /api/gallery ───────────────────────────────────────────────────────────
router.get("/", userAuth, async (req, res) => {
  try {
    const photos = await prisma.galleryPhoto.findMany({
      where:   { userId: req.user.id },
      orderBy: { uploadedAt: "desc" },
    });
    res.json({ success: true, data: photos.map(p => ({ id: p.id, url: `/uploads/${path.basename(p.url)}` })) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/gallery/upload ───────────────────────────────────────────────────
router.post("/upload", userAuth, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const url = `/uploads/${req.file.filename}`;
    const photo = await prisma.galleryPhoto.create({
      data: { userId: req.user.id, url, filename: req.file.filename },
    });

    // Set first photo as profile image automatically
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.profileImage) {
      await prisma.user.update({ where: { id: req.user.id }, data: { profileImage: url } });
    }

    res.json({ success: true, data: { id: photo.id, url } });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
