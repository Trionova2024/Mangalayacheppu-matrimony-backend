require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const bcrypt           = require("bcryptjs");
const prisma           = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database v2...\n");

  // ── App Config ─────────────────────────────────────────────────────────────
  await prisma.appConfig.upsert({
    where: { id: "singleton" }, update: {},
    create: { id: "singleton", defaultCredits: 3, validityMonths: 3, razorpayKeyId: process.env.RAZORPAY_KEY_ID || "", razorpaySecret: process.env.RAZORPAY_KEY_SECRET || "" },
  });
  console.log("✅  App config");

  // ── Admin ──────────────────────────────────────────────────────────────────
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword && process.env.NODE_ENV === "production") {
    throw new Error("FATAL: ADMIN_PASSWORD environment variable is required in production.");
  }
  const passwordToUse = adminPassword || "DevAdminSecretKey!2026";
  const hashed = await bcrypt.hash(passwordToUse, 10);
  const admin  = await prisma.admin.upsert({
    where: { email: process.env.ADMIN_EMAIL || "admin@matrimony.com" }, update: {},
    create: { name: process.env.ADMIN_NAME || "Super Admin", email: process.env.ADMIN_EMAIL || "admin@matrimony.com", password: hashed },
  });
  console.log(`✅  Admin: ${admin.email}`);

  // ── Packages ───────────────────────────────────────────────────────────────
  const pkgData = [
    { id: "pkg-bronze",   name: "Bronze",   title: "Bronze",   subtitle: "10 contact credits",  credits: 10,  amount: 299,  price: 299,  validityDays: 30,  description: "10 contact credits, valid 30 days" },
    { id: "pkg-silver",   name: "Silver",   title: "Silver",   subtitle: "30 contact credits",  credits: 30,  amount: 699,  price: 699,  validityDays: 90,  description: "30 contact credits, valid 90 days" },
    { id: "pkg-gold",     name: "Gold",     title: "Gold",     subtitle: "60 contact credits",  credits: 60,  amount: 1199, price: 1199, validityDays: 180, description: "60 contact credits, valid 180 days" },
    { id: "pkg-platinum", name: "Platinum", title: "Platinum", subtitle: "100 contact credits", credits: 100, amount: 1999, price: 1999, validityDays: 365, description: "100 contact credits, valid 1 year" },
  ];
  for (const p of pkgData) {
    await prisma.package.upsert({ where: { id: p.id }, update: {}, create: { ...p, status: "ACTIVE" } });
  }
  console.log("✅  Packages: Bronze, Silver, Gold, Platinum");

  // ── Sample Users ───────────────────────────────────────────────────────────
  const usersData = [
    { name: "Priya Nair",      mobile: "9876543210", isVerified: true,  status: "ACTIVE",   credits: 30, freeContactsLeft: 0 },
    { name: "Rahul Sharma",    mobile: "9876543211", isVerified: true,  status: "ACTIVE",   credits: 60, freeContactsLeft: 0 },
    { name: "Anitha Krishnan", mobile: "9876543212", isVerified: true,  status: "ACTIVE",   credits: 10, freeContactsLeft: 1 },
    { name: "Vikram Patel",    mobile: "9876543213", isVerified: false, status: "PENDING",  credits: 3,  freeContactsLeft: 3 },
    { name: "Meera Reddy",     mobile: "9876543214", isVerified: true,  status: "ACTIVE",   credits: 15, freeContactsLeft: 0 },
    { name: "Arjun Menon",     mobile: "9876543215", isVerified: false, status: "INACTIVE", credits: 0,  freeContactsLeft: 3 },
    { name: "Divya Suresh",    mobile: "9876543216", isVerified: true,  status: "ACTIVE",   credits: 5,  freeContactsLeft: 2 },
    { name: "Karthik Iyer",    mobile: "9876543217", isVerified: true,  status: "ACTIVE",   credits: 100,freeContactsLeft: 0 },
  ];

  const users = [];
  for (const u of usersData) {
    const user = await prisma.user.upsert({ where: { mobile: u.mobile }, update: {}, create: { ...u, isProfileComplete: u.isVerified } });
    users.push(user);
  }
  console.log(`✅  Users: ${users.length} seeded`);

  // ── Personal Profiles ──────────────────────────────────────────────────────
  const personalData = [
    { userId: users[0].id, fullName: "Priya Nair",      gender: "Female", age: 28, religion: "Hindu", caste: "Nair",     native: "Chennai",   aboutMe: "Looking for a life partner" },
    { userId: users[1].id, fullName: "Rahul Sharma",    gender: "Male",   age: 32, religion: "Hindu", caste: "Brahmin",  native: "Mumbai",    aboutMe: "Software engineer, loves travel" },
    { userId: users[2].id, fullName: "Anitha Krishnan", gender: "Female", age: 26, religion: "Hindu", caste: "Iyer",     native: "Bangalore", aboutMe: "Doctor by profession" },
    { userId: users[4].id, fullName: "Meera Reddy",     gender: "Female", age: 29, religion: "Hindu", caste: "Reddy",    native: "Hyderabad", aboutMe: "Teacher, enjoys reading" },
    { userId: users[6].id, fullName: "Divya Suresh",    gender: "Female", age: 27, religion: "Hindu", caste: "Chettiar", native: "Coimbatore",aboutMe: "Finance professional" },
    { userId: users[7].id, fullName: "Karthik Iyer",    gender: "Male",   age: 33, religion: "Hindu", caste: "Iyer",     native: "Madurai",   aboutMe: "Entrepreneur" },
  ];
  for (const p of personalData) {
    await prisma.personalProfile.upsert({ where: { userId: p.userId }, update: {}, create: p });
  }
  console.log("✅  Personal profiles");

  // ── Profile Approvals ──────────────────────────────────────────────────────
  for (const user of users) {
    const existing = await prisma.profileApproval.findUnique({ where: { userId: user.id } });
    if (!existing) {
      await prisma.profileApproval.create({
        data: { userId: user.id, status: user.isVerified ? "APPROVED" : "PENDING", reviewedAt: user.isVerified ? new Date() : null },
      });
    }
  }
  console.log("✅  Profile approvals");

  // ── Transactions ───────────────────────────────────────────────────────────
  const pkgs = await prisma.package.findMany();
  for (let i = 0; i < 3; i++) {
    const pkg = pkgs[i % pkgs.length];
    await prisma.transaction.create({
      data: { userId: users[i].id, packageId: pkg.id, amount: pkg.amount, paymentMethod: "RAZORPAY", status: "COMPLETED" },
    });
  }
  console.log("✅  Transactions: 3 seeded");

  // ── Call Logs ──────────────────────────────────────────────────────────────
  for (let i = 0; i < 4; i++) {
    await prisma.callLog.create({
      data: { lockerId: users[i].id, viewedId: users[(i + 2) % users.length].id, credits: 1, pack: pkgs[i % pkgs.length].name },
    });
  }
  console.log("✅  Call logs: 4 seeded");

  // ── Support Tickets ────────────────────────────────────────────────────────
  const t1 = await prisma.supportTicket.create({ data: { userId: users[0].id, name: users[0].name, email: users[0].mobile, subject: "Cannot view contact details", status: "OPEN" } });
  await prisma.supportMessage.create({ data: { ticketId: t1.id, sender: "CUSTOMER", text: "I purchased credits but cannot view contacts." } });
  const t2 = await prisma.supportTicket.create({ data: { userId: users[1].id, name: users[1].name, email: users[1].mobile, subject: "Profile not visible in search", status: "OPEN" } });
  await prisma.supportMessage.create({ data: { ticketId: t2.id, sender: "CUSTOMER", text: "My profile is not appearing in search results." } });
  console.log("✅  Support tickets: 2 seeded");

  // ── User Report ────────────────────────────────────────────────────────────
  await prisma.userReport.create({ data: { accusedId: users[5].id, reporterId: users[0].id, reason: "Sending inappropriate messages", category: "HARASSMENT", status: "PENDING" } });
  console.log("✅  User report: 1 seeded");

  // ── Notification ───────────────────────────────────────────────────────────
  await prisma.notification.create({ data: { title: "Welcome to Mangalyacheppu!", message: "Explore your perfect match today.", type: "GLOBAL", isDraft: false, sentAt: new Date() } });
  console.log("✅  Notification seeded");

  console.log(`\n🎉 Seed complete!`);
  console.log(`\n📧  Admin: ${admin.email}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
