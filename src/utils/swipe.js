const prisma = require("../lib/prisma");

/**
 * Returns an array of user IDs that should be excluded from profile feeds.
 * Per business rules: excludes current user AND all already-swiped profiles (LEFT and RIGHT).
 * @param {string} userId
 * @param {object} [prismaClient=prisma]
 * @returns {Promise<string[]>}
 */
async function getExcludedProfileIds(userId, prismaClient = prisma) {
  if (!userId) return [];
  const swipes = await prismaClient.swipe.findMany({
    where: { ownerId: userId },
    select: { targetId: true },
  });
  const swipedTargetIds = swipes.map(s => s.targetId);
  return [userId, ...swipedTargetIds];
}

module.exports = {
  getExcludedProfileIds,
};
