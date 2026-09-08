const router   = require("express").Router();
const prisma   = require("../lib/prisma");
const userAuth = require("../middleware/userAuth");
const { validateAndCalculateAge, getAgeFromDob } = require("../utils/age");

// ── GET /api/profile/me  — Flutter: my profile screen ─────────────────────────
router.get("/me", userAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where:   { id: req.user.id },
      include: { personal: true, family: true, professional: true, physical: true, privacy: true, gallery: true },
    });
    res.json({ success: true, data: formatProfile(user) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/profile/interests  — Flutter: profiles liked (swiped RIGHT) ──────
// MUST be defined BEFORE /:id to avoid Express capturing "interests" as an id param
router.get("/interests", userAuth, async (req, res) => {
  try {
    const swipes = await prisma.swipe.findMany({
      where: {
        ownerId:   req.user.id,
        direction: "RIGHT",
        target: {
          status:     "ACTIVE",
          isVerified: true,
        },
      },
      orderBy: { createdAt: "desc" },
      include: {
        target: {
          include: {
            personal:     true,
            professional: true,
            physical:     true,
            gallery:      { take: 1 },
          },
        },
      },
    });

    const formatted = swipes.map(s => formatInterestTarget(s.target));
    res.json({ success: true, data: formatted });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/profile/personal ─────────────────────────────────────────────────
router.post("/personal", userAuth, async (req, res) => {
  try {
    const d = req.body;

    // Validate DOB if any DOB field is provided
    const dobDay   = d.dob?.day   !== undefined ? d.dob.day   : d.dobDay;
    const dobMonth = d.dob?.month !== undefined ? d.dob.month : d.dobMonth;
    const dobYear  = d.dob?.year  !== undefined ? d.dob.year  : d.dobYear;
    const hasDob = (dobDay !== undefined && dobDay !== null && dobDay !== "") ||
                   (dobMonth !== undefined && dobMonth !== null && dobMonth !== "") ||
                   (dobYear !== undefined && dobYear !== null && dobYear !== "") ||
                   d.dob !== undefined;

    let calculatedAge = undefined;
    if (hasDob) {
      const ageCheck = validateAndCalculateAge(dobDay, dobMonth, dobYear);
      if (!ageCheck.valid) {
        return res.status(400).json({ message: ageCheck.error });
      }
      calculatedAge = ageCheck.age;
    }

    const fullName = d.fullName !== undefined ? String(d.fullName).trim() : undefined;
    if (fullName !== undefined && fullName !== "") {
      if (!/^[a-zA-Z\s.'-]+$/.test(fullName)) {
        return res.status(400).json({ message: "Name must contain only alphabetic characters" });
      }
    }

    const data = {
      profileManagedBy: d.profileManagedBy,
      gender:           d.gender,
      religion:         d.religion,
      caste:            d.caste,
      subCaste:         d.subCaste,
      nakshatram:       d.nakshatram,
      native:           d.native,
      aboutMe:          d.aboutMe,
      interests:        d.interests || [],
    };

    if (fullName !== undefined) {
      data.fullName = fullName;
    }

    if (hasDob) {
      data.age      = calculatedAge;
      data.dobDay   = String(dobDay);
      data.dobMonth = String(dobMonth);
      data.dobYear  = String(dobYear);
    }

    // Atomically synchronize User.name and PersonalProfile.fullName
    await prisma.$transaction(async (tx) => {
      if (fullName) {
        await tx.user.update({
          where: { id: req.user.id },
          data:  { name: fullName },
        });
      }

      await tx.personalProfile.upsert({
        where:  { userId: req.user.id },
        create: { userId: req.user.id, ...data },
        update: data,
      });

      await checkProfileComplete(req.user.id, tx);
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/profile/family ───────────────────────────────────────────────────
router.post("/family", userAuth, async (req, res) => {
  try {
    const d = req.body;
    const data = {
      fatherName:       d.fatherName,
      fatherOccupation: d.fatherOccupation,
      motherName:       d.motherName,
      motherOccupation: d.motherOccupation,
      siblings:         d.siblings ? Number(d.siblings) : undefined,
      siblingNames:     d.siblingNames || [],
    };
    await prisma.familyProfile.upsert({
      where: { userId: req.user.id }, create: { userId: req.user.id, ...data }, update: data,
    });
    await checkProfileComplete(req.user.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/profile/professional ────────────────────────────────────────────
router.post("/professional", userAuth, async (req, res) => {
  try {
    const d = req.body;
    const data = {
      highestEducation: d.highestEducation,
      fieldOfStudy:     d.fieldOfStudy,
      occupationType:   d.occupationType,
      jobTitle:         d.jobTitle,
      organisation:     d.organisation,
      annualIncome:     d.annualIncome,
    };
    await prisma.professionalProfile.upsert({
      where: { userId: req.user.id }, create: { userId: req.user.id, ...data }, update: data,
    });
    await checkProfileComplete(req.user.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/profile/physical ────────────────────────────────────────────────
router.post("/physical", userAuth, async (req, res) => {
  try {
    const d = req.body;
    const data = { height: d.height, weight: d.weight, complexion: d.complexion };
    await prisma.physicalProfile.upsert({
      where: { userId: req.user.id }, create: { userId: req.user.id, ...data }, update: data,
    });
    await checkProfileComplete(req.user.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── GET /api/profile/:id  — Flutter: view another user's profile ───────────────
router.get("/:id", userAuth, async (req, res) => {
  try {
    const target = await prisma.user.findUnique({
      where:   { id: req.params.id },
      include: { personal: true, family: true, professional: true, physical: true, privacy: true, gallery: true },
    });
    if (!target) return res.status(404).json({ message: "Profile not found" });
    if (target.status !== "ACTIVE") return res.status(404).json({ message: "Profile not available" });

    res.json({ success: true, data: formatProfile(target) });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/profile/:id/unlock-contact ──────────────────────────────────────
router.post("/:id/unlock-contact", userAuth, async (req, res) => {
  try {
    const viewerId = req.user.id;
    const targetId = req.params.id;

    if (viewerId === targetId) {
      return res.status(400).json({ message: "Cannot unlock your own contact" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetId } });
      if (!target) {
        const err = new Error("Profile not found");
        err.status = 404;
        throw err;
      }
      if (target.status !== "ACTIVE") {
        const err = new Error("Profile not available");
        err.status = 404;
        throw err;
      }

      // Check if already unlocked (don't charge again)
      const existing = await tx.callLog.findFirst({
        where: { lockerId: viewerId, viewedId: targetId },
      });

      if (!existing) {
        // Query fresh viewer state from database to avoid concurrency race condition
        const freshViewer = await tx.user.findUnique({ where: { id: viewerId } });
        if (!freshViewer) {
          const err = new Error("User not found");
          err.status = 401;
          throw err;
        }

        const freeContactsLeft = freshViewer.freeContactsLeft || 0;
        const paidCredits = freshViewer.credits || 0;

        if (freeContactsLeft < 1 && paidCredits < 1) {
          const err = new Error("Insufficient credits. Please buy a package.");
          err.status = 402;
          err.code = "NO_CREDITS";
          throw err;
        }

        const useFree = freeContactsLeft > 0;
        await tx.user.update({
          where: { id: viewerId },
          data: useFree
            ? { freeContactsLeft: { decrement: 1 } }
            : { credits: { decrement: 1 } },
        });

        const txn = await tx.transaction.findFirst({
          where: { userId: viewerId, status: "COMPLETED" },
          include: { package: true },
          orderBy: { createdAt: "desc" },
        });

        await tx.callLog.create({
          data: {
            lockerId: viewerId,
            viewedId: targetId,
            credits:  1,
            pack:     useFree ? "Free" : (txn?.package?.name || "Paid"),
          },
        });
      }

      return {
        mobile: target.mobile,
        email:  target.email  || null,
        name:   target.name,
      };
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        message: err.message,
        ...(err.code ? { code: err.code } : {}),
      });
    }
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/profile/:id/bookmark ────────────────────────────────────────────
router.post("/:id/bookmark", userAuth, async (req, res) => {
  try {
    const existing = await prisma.bookmark.findUnique({
      where: { ownerId_targetId: { ownerId: req.user.id, targetId: req.params.id } },
    });
    if (existing) {
      await prisma.bookmark.delete({ where: { id: existing.id } });
      return res.json({ success: true, bookmarked: false });
    }
    await prisma.bookmark.create({ data: { ownerId: req.user.id, targetId: req.params.id } });
    res.json({ success: true, bookmarked: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── POST /api/profile/:id/swipe ───────────────────────────────────────────────
router.post("/:id/swipe", userAuth, async (req, res) => {
  try {
    const targetId = req.params.id;

    // 1. Self swipe rejection
    if (req.user.id === targetId) {
      return res.status(400).json({ message: "Cannot swipe on your own profile" });
    }

    // 2. Direction validation (strictly LEFT or RIGHT)
    const { direction } = req.body;
    if (!direction || (direction !== "LEFT" && direction !== "RIGHT")) {
      return res.status(400).json({ message: "Direction must be strictly LEFT or RIGHT" });
    }

    // 3. Target user existence check
    const target = await prisma.user.findUnique({ where: { id: targetId } });
    if (!target) {
      return res.status(404).json({ message: "Profile not found" });
    }

    // 4. Target user eligibility / active check
    if (target.status !== "ACTIVE") {
      return res.status(400).json({ message: "Profile is not available" });
    }

    // 5. Upsert swipe (never trust client ownerId, always req.user.id)
    await prisma.swipe.upsert({
      where:  { ownerId_targetId: { ownerId: req.user.id, targetId } },
      create: { ownerId: req.user.id, targetId, direction },
      update: { direction },
    });

    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatProfile(user) {
  return {
    id:               user.id,
    name:             user.personal?.fullName || user.name,
    mobile:           user.mobile,
    profileImage:     user.profileImage || null,
    isVerified:       user.isVerified,
    isProfileComplete: user.isProfileComplete,
    freeContactsLeft: user.freeContactsLeft,
    status:           user.status,
    personal:         user.personal     ? formatPersonal(user.personal)     : null,
    family:           user.family       ? user.family                       : null,
    professional:     user.professional ? user.professional                 : null,
    physical:         user.physical     ? user.physical                     : null,
    gallery:          (user.gallery     || []).map(g => ({ id: g.id, url: g.url })),
  };
}

function formatPersonal(p) {
  const age = getAgeFromDob(p.dobDay, p.dobMonth, p.dobYear, p.age);
  return {
    fullName:         p.fullName,
    profileManagedBy: p.profileManagedBy,
    gender:           p.gender,
    age:              age,
    dob:              { day: p.dobDay, month: p.dobMonth, year: p.dobYear },
    religion:         p.religion,
    caste:            p.caste,
    subCaste:         p.subCaste,
    nakshatram:       p.nakshatram,
    native:           p.native,
    aboutMe:          p.aboutMe,
    interests:        p.interests,
    updatedAt:        p.updatedAt,
  };
}

function formatInterestTarget(target) {
  const p     = target.personal;
  const prof  = target.professional;
  const phys  = target.physical;
  const photo = target.gallery?.[0]?.url || target.profileImage || null;
  const age   = p ? getAgeFromDob(p.dobDay, p.dobMonth, p.dobYear, p.age) : null;

  return {
    id:           target.id,
    name:         p?.fullName || target.name,
    age:          age,
    gender:       p?.gender || null,
    location:     p?.native || null,
    native:       p?.native || null,
    bio:          p?.aboutMe || null,
    aboutMe:      p?.aboutMe || null,
    imageUrl:     photo,
    profileImage: photo,
    isVerified:   target.isVerified,
    religion:     p?.religion || null,
    caste:        p?.caste || null,
    subCaste:     p?.subCaste || null,
    nakshatram:   p?.nakshatram || null,
    education:    prof?.highestEducation || null,
    occupation:   prof?.occupationType || prof?.jobTitle || null,
    organisation: prof?.organisation || null,
    annualIncome: prof?.annualIncome || null,
    height:       phys?.height || null,
    weight:       phys?.weight || null,
    complexion:   phys?.complexion || null,
    personal:     p ? formatPersonal(p) : null,
    professional: prof || null,
    physical:     phys || null,
    gallery:      (target.gallery || []).map(g => ({ id: g.id, url: g.url })),
  };
}

async function checkProfileComplete(userId, tx = prisma) {
  const [personal, family, professional, physical] = await Promise.all([
    tx.personalProfile.findUnique({ where: { userId } }),
    tx.familyProfile.findUnique({ where: { userId } }),
    tx.professionalProfile.findUnique({ where: { userId } }),
    tx.physicalProfile.findUnique({ where: { userId } }),
  ]);

  const complete = !!(personal?.fullName && family?.fatherName && professional?.highestEducation && physical?.height);

  await tx.user.update({
    where: { id: userId },
    data:  {
      isProfileComplete: complete,
    },
  });
}

module.exports = router;
