require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { generalLimiter } = require("./middleware/rateLimiter");

// ── Startup Environment Hardening ─────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  const weakPlaceholders = [
    "change_this_to_a_long_random_secret_min_32_chars",
    "secret",
    "jwt_secret",
  ];
  if (!process.env.JWT_SECRET || weakPlaceholders.includes(process.env.JWT_SECRET) || process.env.JWT_SECRET.length < 16) {
    console.error("FATAL: Insecure or missing JWT_SECRET in production environment.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("FATAL: Missing DATABASE_URL in production environment.");
    process.exit(1);
  }
}

const app  = express();
const PORT = process.env.PORT || 4000;

// ── CORS Configuration ────────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(o => o.trim()).filter(Boolean)
  : ["http://localhost:3000", "http://localhost:5173", "http://localhost:4000"];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin header (mobile apps, CLI, internal requests)
    if (!origin) return callback(null, true);
    if (process.env.NODE_ENV !== "production") return callback(null, true);
    if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors(corsOptions));
app.use(express.json());

// Global rate limiting across /api endpoints
app.use("/api", generalLimiter);

// Serve uploaded photos (gallery images)
app.use("/uploads", express.static(path.join(__dirname, "..", process.env.UPLOAD_DIR || "uploads")));

// ── Routes ─────────────────────────────────────────────────────────────────────
// Flutter app routes
app.use("/api/auth",          require("./routes/auth"));
app.use("/api/profile",       require("./routes/profile"));
app.use("/api/home",          require("./routes/home"));
app.use("/api/gallery",       require("./routes/gallery"));
app.use("/api/packages",      require("./routes/packages"));
app.use("/api/privacy",       require("./routes/privacy"));
app.use("/api/dropdowns",     require("./routes/dropdowns"));
app.use("/api/notifications", require("./routes/notifications"));

// Admin panel routes
app.use("/api/dashboard",     require("./routes/dashboard"));
app.use("/api/users",         require("./routes/users"));
app.use("/api/transactions",  require("./routes/transactions"));
app.use("/api/call-logs",     require("./routes/callLogs"));
app.use("/api/support",       require("./routes/support"));
app.use("/api/reports",       require("./routes/reports"));

// ── Health check ───────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok", timestamp: new Date() }));
app.use((_req, res) => res.status(404).json({ message: "Route not found" }));

// ── Global Error Handler ───────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  const status = err.status || err.statusCode || 500;

  // Preserve controlled client errors
  if (status >= 400 && status < 500) {
    return res.status(status).json({
      message: err.message || "Request failed",
      ...(err.code ? { code: err.code } : {}),
    });
  }

  // Sanitize 5xx internal server errors in production to avoid leaking internals
  const message = process.env.NODE_ENV === "production"
    ? "Internal server error"
    : (err.message || "Internal server error");

  res.status(status).json({
    message,
    ...(err.code && process.env.NODE_ENV !== "production" ? { code: err.code } : {}),
  });
});

app.listen(PORT, () => console.log(`✅  Matrimony API → http://localhost:${PORT}`));
