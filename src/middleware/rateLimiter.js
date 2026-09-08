/**
 * In-memory sliding-window rate limiting middleware.
 * Zero external dependencies, safe for production and testing.
 */

function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000; // 15 minutes default
  const max = options.max || 100;                      // max requests per window
  const message = options.message || "Too many requests, please try again later.";
  const statusCode = options.statusCode || 429;
  const keyGenerator = options.keyGenerator || ((req) => {
    return (
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      req.connection?.remoteAddress ||
      "unknown"
    );
  });

  // Map of key -> array of request timestamps
  const hits = new Map();

  // Periodic cleanup of expired entries (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of hits.entries()) {
      const valid = timestamps.filter(t => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(key);
      } else {
        hits.set(key, valid);
      }
    }
  }, Math.min(windowMs, 5 * 60 * 1000));

  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  const middleware = (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    const timestamps = hits.get(key) || [];
    const validTimestamps = timestamps.filter(t => now - t < windowMs);

    if (validTimestamps.length >= max) {
      const oldest = validTimestamps[0];
      const resetTime = Math.ceil((oldest + windowMs - now) / 1000);
      res.setHeader("Retry-After", resetTime > 0 ? resetTime : 1);
      res.setHeader("RateLimit-Limit", max);
      res.setHeader("RateLimit-Remaining", 0);
      return res.status(statusCode).json({ message });
    }

    validTimestamps.push(now);
    hits.set(key, validTimestamps);

    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", Math.max(0, max - validTimestamps.length));

    next();
  };

  // Helper method for testing/resetting
  middleware.reset = () => hits.clear();

  return middleware;
}

// Stricter limiter for authentication & sensitive endpoints
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 20,
  message: "Too many authentication attempts. Please try again later.",
});

// General limiter for public API endpoints
const generalLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 300,
  message: "Too many requests, please try again later.",
});

module.exports = {
  createRateLimiter,
  authLimiter,
  generalLimiter,
};
