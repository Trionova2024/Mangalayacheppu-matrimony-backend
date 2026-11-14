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

/**
 * Returns swipe categorization for feeds where left-swiped (rejected) profiles
 * should still appear with an identification flag `isAlreadyRejected: true`.
 * Excludes: current user + RIGHT-swiped (liked) profiles.
 * @param {string} userId
 * @param {object} [prismaClient=prisma]
 * @returns {Promise<{ excludedIds: string[], rightSwipedIds: string[], leftSwipedIds: Set<string> }>}
 */
async function getSwipeStatusForFeed(userId, prismaClient = prisma) {
  if (!userId) {
    return { excludedIds: [], rightSwipedIds: [], leftSwipedIds: new Set() };
  }
  const swipes = await prismaClient.swipe.findMany({
    where: { ownerId: userId },
    select: { targetId: true, direction: true },
  });

  const rightSwipedIds = [];
  const leftSwipedIds = new Set();

  for (const s of swipes) {
    if (s.direction === "RIGHT") {
      rightSwipedIds.push(s.targetId);
    } else if (s.direction === "LEFT") {
      leftSwipedIds.add(s.targetId);
    }
  }

  return {
    excludedIds: [userId, ...rightSwipedIds],
    rightSwipedIds,
    leftSwipedIds,
  };
}

module.exports = {
  getExcludedProfileIds,
  getSwipeStatusForFeed,
};
