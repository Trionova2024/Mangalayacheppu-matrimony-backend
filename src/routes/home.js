const router   = require("express").Router();
const prisma   = require("../lib/prisma");
const userAuth = require("../middleware/userAuth");
const { getExcludedProfileIds } = require("../utils/swipe");
const { getAgeFromDob } = require("../utils/age");

// ── GET /api/home/dashboard ────────────────────────────────────────────────────
// Flutter home screen — credits left, featured profiles
router.get("/dashboard", userAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:   { id: req.user.id },
      include: { personal: true },
    });

    // Exclude current user and any swiped profiles (LEFT and RIGHT)
    const excludedIds = await getExcludedProfileIds(req.user.id);

    // Featured = recently joined verified users not swiped or owned by current user
    const featured = await prisma.user.findMany({
      where: {
        id:         { notIn: excludedIds },
        isVerified: true,
        status:     "ACTIVE",
        personal:   { isNot: null },
      },
      orderBy: { createdAt: "desc" },
      take:    10,
      include: {
        personal:     true,
        professional: true,
        physical:     true,
        gallery:      { take: 1 },
      },
    });

    res.json({
      success: true,
      data: {
        userName:         user.personal?.fullName || user.name,
        freeContactsLeft: user.freeContactsLeft,
        featuredProfiles: featured.map(formatCard),
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/home/profiles  — browse / paginated with database filtering ───────
router.get("/profiles", userAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit) || 10));

    // ── Validate minAge and maxAge (18..100) ──────────────────────────────────
    let minAge = undefined;
    if (req.query.minAge !== undefined && req.query.minAge !== "") {
      const parsed = Number(req.query.minAge);
      if (!Number.isInteger(parsed) || parsed < 18 || parsed > 100) {
        return res.status(400).json({ message: "minAge must be an integer between 18 and 100" });
      }
      minAge = parsed;
    }

    let maxAge = undefined;
    if (req.query.maxAge !== undefined && req.query.maxAge !== "") {
      const parsed = Number(req.query.maxAge);
      if (!Number.isInteger(parsed) || parsed < 18 || parsed > 100) {
        return res.status(400).json({ message: "maxAge must be an integer between 18 and 100" });
      }
      maxAge = parsed;
    }

    if (minAge !== undefined && maxAge !== undefined && minAge > maxAge) {
      return res.status(400).json({ message: "minAge cannot be greater than maxAge" });
    }

    // ── Build Prisma where filter ─────────────────────────────────────────────
    const personalWhere = {};

    if (req.query.gender) {
      personalWhere.gender = { equals: String(req.query.gender).trim(), mode: "insensitive" };
    }

    if (minAge !== undefined || maxAge !== undefined) {
      personalWhere.age = {
        ...(minAge !== undefined && { gte: minAge }),
        ...(maxAge !== undefined && { lte: maxAge }),
      };
    }

    if (req.query.religion) {
      personalWhere.religion = { equals: String(req.query.religion).trim(), mode: "insensitive" };
    }

    if (req.query.caste) {
      personalWhere.caste = { equals: String(req.query.caste).trim(), mode: "insensitive" };
    }

    const location = req.query.location || req.query.native;
    if (location) {
      personalWhere.native = { contains: String(location).trim(), mode: "insensitive" };
    }

    const professionalWhere = {};

    if (req.query.education) {
      professionalWhere.highestEducation = { contains: String(req.query.education).trim(), mode: "insensitive" };
    }

    if (req.query.occupation) {
      const occ = String(req.query.occupation).trim();
      professionalWhere.OR = [
        { occupationType: { contains: occ, mode: "insensitive" } },
        { jobTitle:       { contains: occ, mode: "insensitive" } },
      ];
    }

    // Bookmarks by current user (to set isBookmarked flag)
    const bookmarks = await prisma.bookmark.findMany({
      where:  { ownerId: req.user.id },
      select: { targetId: true },
    });
    const bookmarkedIds = new Set(bookmarks.map(b => b.targetId));

    // Exclude current user AND all already-swiped profiles (LEFT and RIGHT)
    const excludedIds = await getExcludedProfileIds(req.user.id);

    const where = {
      id:         { notIn: excludedIds },
      isVerified: true,
      status:     "ACTIVE",
      personal: {
        isNot: null,
        ...personalWhere,
      },
      ...(Object.keys(professionalWhere).length > 0 && { professional: professionalWhere }),
    };

    const profiles = await prisma.user.findMany({
      where,
      skip:    (page - 1) * limit,
      take:    limit,
      orderBy: { createdAt: "desc" },
      include: {
        personal:     true,
        professional: true,
        physical:     true,
        gallery:      { take: 1 },
      },
    });

    res.json({
      success: true,
      data: {
        profiles: profiles.map(p => ({
          ...formatCard(p),
          isBookmarked: bookmarkedIds.has(p.id),
        })),
        page,
        hasMore: profiles.length === limit,
      },
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatCard(user) {
  const p     = user.personal;
  const prof  = user.professional;
  const phys  = user.physical;
  const photo = user.gallery?.[0]?.url || user.profileImage || null;
  const age   = p ? getAgeFromDob(p.dobDay, p.dobMonth, p.dobYear, p.age) : null;

  return {
    id:           user.id,
    name:         p?.fullName || user.name,
    age:          age,
    location:     p?.native || null,
    bio:          p?.aboutMe || null,
    imageUrl:     photo,
    isVerified:   user.isVerified,
    religion:     p?.religion || null,
    caste:        p?.caste || null,
    education:    prof?.highestEducation || null,
    occupation:   prof?.occupationType || prof?.jobTitle || null,
    height:       phys?.height || null,
    isBookmarked: false,
  };
}

module.exports = router;
