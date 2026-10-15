const router   = require("express").Router();
const multer   = require("multer");
const path     = require("path");
const prisma   = require("../lib/prisma");
const userAuth = require("../middleware/userAuth");
const { uploadToS3 } = require("../lib/s3");

// ── Multer setup (In-memory storage for S3 uploads) ───────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    console.log("[gallery] fileFilter checking:", {
      fieldname:    file.fieldname,
      originalname: file.originalname,
      mimetype:     file.mimetype,
    });
    if (file.mimetype.startsWith("image/")) return cb(null, true);
    const err = new Error("Only image files allowed");
    err.status = 400;
    cb(err);
  },
});

// Wraps multer so upload errors become 400s instead of falling through to the 500 handler
function handlePhotoUpload(req, res, next) {
  console.log("[gallery] Incoming upload request:", {
    userId:        req.user?.id,
    path:          req.originalUrl,
    contentType:   req.headers["content-type"],
    contentLength: req.headers["content-length"],
  });

  upload.single("photo")(req, res, (err) => {
    if (!err) return next();
    console.error("[gallery] Multer error:", {
      code:    err.code,
      field:   err.field,
      message: err.message,
    });
    if (err.status) return res.status(err.status).json({ message: err.message });
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(400).json({ message: `File too large. Max ${parseInt(process.env.MAX_FILE_SIZE_MB) || 5} MB` });
    if (err instanceof multer.MulterError) return res.status(400).json({ message: err.message });
    next(err);
  });
}

// ── GET /api/gallery ───────────────────────────────────────────────────────────
router.get("/", userAuth, async (req, res) => {
  try {
    const photos = await prisma.galleryPhoto.findMany({
      where:   { userId: req.user.id },
      orderBy: { uploadedAt: "desc" },
    });
    res.json({
      success: true,
      data: photos.map(p => ({
        id:  p.id,
        url: p.url.startsWith("http") ? p.url : `/uploads/${path.basename(p.url)}`,
      })),
    });
  } catch (err) {
    console.error("[gallery] GET / error:", err);
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/gallery/upload ───────────────────────────────────────────────────
router.post("/upload", userAuth, handlePhotoUpload, async (req, res) => {
  try {
    console.log("[gallery] POST /upload handler triggered. req.file:", req.file ? {
      fieldname:    req.file.fieldname,
      originalname: req.file.originalname,
      mimetype:     req.file.mimetype,
      size:         req.file.size,
    } : "undefined");

    if (!req.file) {
      console.warn("[gallery] POST /upload - No file in req.file. Body keys:", Object.keys(req.body || {}));
      return res.status(400).json({ message: "No file uploaded" });
    }

    // Upload directly to S3 with datewise folder and userId+date naming
    const s3Result = await uploadToS3({
      buffer:       req.file.buffer,
      userId:       req.user.id,
      originalname: req.file.originalname,
      mimetype:     req.file.mimetype,
    });

    const url = s3Result.url;
    const photo = await prisma.galleryPhoto.create({
      data: { userId: req.user.id, url, filename: s3Result.key },
    });

    // Set first photo as profile image automatically if user has none
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.profileImage) {
      await prisma.user.update({ where: { id: req.user.id }, data: { profileImage: url } });
      console.log(`[gallery] Assigned first photo as profileImage for user ${req.user.id}`);
    }

    console.log(`[gallery] Photo successfully saved to DB. id=${photo.id}, url=${url}`);
    res.json({ success: true, data: { id: photo.id, url } });
  } catch (err) {
    console.error("[gallery] POST /upload failed with error:", err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
