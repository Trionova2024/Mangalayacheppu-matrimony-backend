/**
 * User soft delete. Users are NEVER removed from the database — we only set
 * isDeleted = true. Profile, transactions, call logs, reports etc. are all kept.
 *
 * Deleted users are hidden everywhere because every User read adds
 * isDeleted: false automatically (src/lib/prisma.js).
 *
 * Mobile / email are unique only among non-deleted users (partial unique
 * indexes WHERE "isDeleted" = false), so the deleted row keeps its original
 * mobile/email and the same values can be reused:
 *  - admin delete / self delete → isDeleted = true → number/email free for a
 *    new registration or for another user's update
 *  - ban (report action) → isDeleted = true, status BANNED → number/email stay
 *    blocked (checked in code via findBannedUserByMobile / users.js)
 */
const prisma = require("../lib/prisma");

/**
 * @param {string} userId
 * @param {{ banned?: boolean, client?: any }} [opts]
 * @returns {Promise<object|null>} updated user, or null if not found / already deleted
 */
async function softDeleteUser(userId, { banned = false, client = prisma } = {}) {
  const user = await client.user.findUnique({ where: { id: userId } }); // excludes already-deleted
  if (!user) return null;

  return client.user.update({
    where: { id: userId },
    data: {
      isDeleted: true,
      fcmToken:  null, // stop all pushes
      ...(banned && { status: "BANNED" }),
    },
  });
}

/**
 * Finds a banned user by any of the given mobile variants (banned numbers can
 * never register or log in again).
 * @param {string|string[]} mobiles
 */
async function findBannedUserByMobile(mobiles) {
  const list = (Array.isArray(mobiles) ? mobiles : [mobiles]).filter(Boolean).map(String);
  if (!list.length) return null;
  return prisma.user.findFirst({
    where:  { mobile: { in: list }, isDeleted: true, status: "BANNED" },
    select: { id: true },
  });
}

const BANNED_RESPONSE = { message: "This account has been banned. Contact support.", code: "ACCOUNT_BANNED" };

module.exports = { softDeleteUser, findBannedUserByMobile, BANNED_RESPONSE };
