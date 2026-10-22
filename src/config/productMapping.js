/**
 * Product & Plan Mapping Service
 *
 * Safely resolves Google Play product identifiers to internal database packages.
 * Guarantees that prices, credits, and subscription durations are authoritatively
 * derived from server-side database records and never trusted from client payloads.
 */

const prisma = require("../lib/prisma");

/**
 * Parses optional environment variable GOOGLE_PLAY_PRODUCT_MAPPING.
 * Format: JSON object {"google_product_id": "internal_package_id"}
 */
function getEnvProductMapping() {
  const raw = process.env.GOOGLE_PLAY_PRODUCT_MAPPING;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (err) {
    console.warn("[ProductMapping] Invalid GOOGLE_PLAY_PRODUCT_MAPPING JSON:", err.message);
    return {};
  }
}

/**
 * Resolves a Google Play product ID to a database Package.
 *
 * Lookup order:
 * 1. Package table by `googlePlayProductId`
 * 2. GOOGLE_PLAY_PRODUCT_MAPPING environment map -> Package table by `id`
 * 3. Package table by `id` directly
 * 4. Package table by lowercase `name`
 *
 * @param {string} googlePlayProductId
 * @returns {Promise<import("@prisma/client").Package | null>}
 */
async function resolvePackageByGoogleProductId(googlePlayProductId) {
  if (!googlePlayProductId || typeof googlePlayProductId !== "string") {
    return null;
  }
  const cleanId = googlePlayProductId.trim();

  // 1. Direct DB lookup by googlePlayProductId
  let pkg = await prisma.package.findFirst({
    where: {
      googlePlayProductId: cleanId,
      status: "ACTIVE",
    },
  });
  if (pkg) return pkg;

  // 2. Env mapping
  const envMap = getEnvProductMapping();
  const mappedPackageId = envMap[cleanId];
  if (mappedPackageId) {
    pkg = await prisma.package.findFirst({
      where: {
        id: mappedPackageId,
        status: "ACTIVE",
      },
    });
    if (pkg) return pkg;
  }

  // 3. Direct DB lookup by Package.id
  pkg = await prisma.package.findFirst({
    where: {
      id: cleanId,
      status: "ACTIVE",
    },
  });
  if (pkg) return pkg;

  // 4. Case-insensitive match on name (e.g. "bronze" matches "Bronze")
  pkg = await prisma.package.findFirst({
    where: {
      name: {
        equals: cleanId,
        mode: "insensitive",
      },
      status: "ACTIVE",
    },
  });
  if (pkg) return pkg;

  return null;
}

/**
 * Determines whether a Google Play product is a subscription or a one-time product.
 * Returns "SUBSCRIPTION" or "INAPP".
 */
function determineProductType(googlePlayProductId) {
  const envTypesRaw = process.env.GOOGLE_PLAY_PRODUCT_TYPES; // JSON: {"prod_id": "SUBSCRIPTION"|"INAPP"}
  if (envTypesRaw) {
    try {
      const types = JSON.parse(envTypesRaw);
      if (types[googlePlayProductId]) {
        return types[googlePlayProductId].toUpperCase();
      }
    } catch {}
  }

  // Convention-based detection
  const lower = String(googlePlayProductId || "").toLowerCase();
  if (lower.startsWith("sub_") || lower.includes("sub") || lower.includes("monthly") || lower.includes("yearly") || lower.includes("annual")) {
    return "SUBSCRIPTION";
  }
  return "INAPP"; // default to consumable in-app product for credits
}

function getEnvAppleProductMapping() {
  const raw = process.env.APPLE_PRODUCT_MAPPING;
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch (err) {
    console.warn("[ProductMapping] Invalid APPLE_PRODUCT_MAPPING JSON:", err.message);
    return {};
  }
}

/**
 * Resolves an Apple product ID to a database Package.
 *
 * Lookup order:
 * 1. Package table by `appleProductId`
 * 2. APPLE_PRODUCT_MAPPING environment map -> Package table by `id`
 * 3. Package table by `id` directly
 * 4. Package table by lowercase `name`
 *
 * @param {string} appleProductId
 * @returns {Promise<import("@prisma/client").Package | null>}
 */
async function resolvePackageByAppleProductId(appleProductId) {
  if (!appleProductId || typeof appleProductId !== "string") {
    return null;
  }
  const cleanId = appleProductId.trim();

  // 1. Direct DB lookup by appleProductId
  let pkg = await prisma.package.findFirst({
    where: {
      appleProductId: cleanId,
      status: "ACTIVE",
    },
  });
  if (pkg) return pkg;

  // 2. Env mapping
  const envMap = getEnvAppleProductMapping();
  const mappedPackageId = envMap[cleanId];
  if (mappedPackageId) {
    pkg = await prisma.package.findFirst({
      where: {
        id: mappedPackageId,
        status: "ACTIVE",
      },
    });
    if (pkg) return pkg;
  }

  // 3. Direct DB lookup by Package.id
  pkg = await prisma.package.findFirst({
    where: {
      id: cleanId,
      status: "ACTIVE",
    },
  });
  if (pkg) return pkg;

  // 4. Case-insensitive match on name
  pkg = await prisma.package.findFirst({
    where: {
      name: {
        equals: cleanId,
        mode: "insensitive",
      },
      status: "ACTIVE",
    },
  });
  if (pkg) return pkg;

  return null;
}

module.exports = {
  resolvePackageByGoogleProductId,
  resolvePackageByAppleProductId,
  determineProductType,
  getEnvProductMapping,
  getEnvAppleProductMapping,
};
