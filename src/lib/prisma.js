const { PrismaClient } = require("@prisma/client");

const base = global.prismaBase || new PrismaClient();
if (process.env.NODE_ENV !== "production") global.prismaBase = base;

// ── Soft delete: these models are NEVER hard-deleted ──────────────────────────
// Every read on User, Package and Notification automatically adds
// `isDeleted: false`, so deleted records never appear in the mobile app or the
// admin panel — but they stay in the database.
//
// To deliberately look at deleted records, put `isDeleted` in the where clause yourself:
//   only deleted:      prisma.user.findFirst({ where: { mobile, isDeleted: true } })
//   deleted + live:    prisma.user.findFirst({ where: { mobile, isDeleted: undefined } })
//
// NOTE: this does not filter records loaded through a relation (`include: { user }`
// on Transaction, `include: { notification }` on NotificationRecipient, …). Those
// queries filter explicitly with the helpers in src/utils/softDelete.js.
// Old transactions intentionally still show their (possibly deleted) package name.
const READ_OPERATIONS = new Set([
  "findUnique", "findUniqueOrThrow",
  "findFirst",  "findFirstOrThrow",
  "findMany",   "count", "aggregate", "groupBy",
]);

async function excludeDeleted({ operation, args, query }) {
  if (READ_OPERATIONS.has(operation)) {
    const where = args?.where || {};
    if (!Object.prototype.hasOwnProperty.call(where, "isDeleted")) {
      args = { ...args, where: { ...where, isDeleted: false } };
    }
  }
  return query(args);
}

const prisma = base.$extends({
  name: "softDelete",
  query: {
    user:         { $allOperations: excludeDeleted },
    package:      { $allOperations: excludeDeleted },
    notification: { $allOperations: excludeDeleted },
  },
});

module.exports = prisma;
