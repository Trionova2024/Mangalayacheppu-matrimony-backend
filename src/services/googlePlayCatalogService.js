/**
 * Google Play Catalog Service
 *
 * Creates and updates Google Play one-time products for paid packages using the
 * Android Publisher API (monetization.onetimeproducts), so admins never have to
 * create products manually in Play Console.
 *
 * Each package maps to one one-time product with a single "buy" purchase option,
 * sold in one region (default: India / INR) at the package amount.
 */

const { getAndroidPublisherClient } = require("./googlePlayService");

const PURCHASE_OPTION_ID = "buy";
const TITLE_MAX_LENGTH = 55;
const DESCRIPTION_MAX_LENGTH = 200;
const PRODUCT_ID_NAME_MAX_LENGTH = 40;

class GooglePlayCatalogError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = "GooglePlayCatalogError";
    this.statusCode = statusCode;
  }
}

function getCatalogConfig() {
  return {
    packageName:    (process.env.GOOGLE_PLAY_PACKAGE_NAME || "").trim(),
    regionCode:     (process.env.GOOGLE_PLAY_PRODUCT_REGION || "IN").trim().toUpperCase(),
    currencyCode:   (process.env.GOOGLE_PLAY_PRODUCT_CURRENCY || "INR").trim().toUpperCase(),
    languageCode:   (process.env.GOOGLE_PLAY_PRODUCT_LANGUAGE || "en-US").trim(),
    regionsVersion: (process.env.GOOGLE_PLAY_REGIONS_VERSION || "2022/02").trim(),
  };
}

/**
 * Automatic product sync is on unless GOOGLE_PLAY_SYNC_PRODUCTS=false
 * (useful for local development without real Play Console access).
 */
function isGooglePlaySyncEnabled() {
  return String(process.env.GOOGLE_PLAY_SYNC_PRODUCTS || "true").trim().toLowerCase() !== "false";
}

/**
 * Builds a permanent, unique Google Play product ID from the package name and ID,
 * e.g. "Gold Credits" + "0f3b9637-..." -> "gold_credits_0f3b9637".
 * Google product IDs can never be reused, so the package ID suffix keeps them unique.
 */
function buildGooglePlayProductId({ id, name }) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, PRODUCT_ID_NAME_MAX_LENGTH)
    .replace(/_+$/g, "");
  const suffix = String(id).replace(/-/g, "").slice(0, 8).toLowerCase();
  return `${slug || "package"}_${suffix}`;
}

function truncate(text, max) {
  const value = String(text || "").trim();
  return value.length > max ? value.slice(0, max).trim() : value;
}

function toMoney(amount, currencyCode) {
  const units = Math.floor(Number(amount));
  const nanos = Math.round((Number(amount) - units) * 1e9);
  return { currencyCode, units: String(units), nanos };
}

function buildOneTimeProduct(pkg, productId, config) {
  const title = truncate(pkg.title || pkg.name, TITLE_MAX_LENGTH);
  const description = truncate(
    pkg.description || pkg.subtitle || `${pkg.credits} contact credits, valid for ${pkg.validityDays} days`,
    DESCRIPTION_MAX_LENGTH
  );

  return {
    packageName: config.packageName,
    productId,
    listings: [{ languageCode: config.languageCode, title, description }],
    purchaseOptions: [
      {
        purchaseOptionId: PURCHASE_OPTION_ID,
        // legacyCompatible lets older Play Billing Library versions (and the Flutter plugin) sell it
        buyOption: { legacyCompatible: true, multiQuantityEnabled: false },
        regionalPricingAndAvailabilityConfigs: [
          {
            regionCode:   config.regionCode,
            price:        toMoney(pkg.amount, config.currencyCode),
            availability: "AVAILABLE",
          },
        ],
      },
    ],
  };
}

function describeApiError(apiErr) {
  return apiErr?.errors?.[0]?.message || apiErr?.response?.data?.error?.message || apiErr?.message || "Unknown error";
}

async function setPurchaseOptionState(client, config, productId, active) {
  const target = { packageName: config.packageName, productId, purchaseOptionId: PURCHASE_OPTION_ID };
  await client.monetization.onetimeproducts.purchaseOptions.batchUpdateStates({
    packageName: config.packageName,
    productId,
    requestBody: {
      requests: [
        active
          ? { activatePurchaseOptionRequest: target }
          : { deactivatePurchaseOptionRequest: target },
      ],
    },
  });
}

/**
 * Creates the Google Play product if it does not exist, or updates its title,
 * description and price if it does, then activates or deactivates it to match
 * the package status.
 *
 * @param {Object} pkg - Package fields: name, title, subtitle, description, credits, amount, validityDays, status
 * @param {string} productId - Google Play product ID
 */
async function syncGooglePlayProduct(pkg, productId) {
  const config = getCatalogConfig();
  if (!config.packageName) {
    throw new GooglePlayCatalogError("GOOGLE_PLAY_PACKAGE_NAME is not configured", 500);
  }
  if (!(Number(pkg.amount) > 0)) {
    throw new GooglePlayCatalogError("Only paid packages can be created on Google Play", 400);
  }

  const client = getAndroidPublisherClient();

  try {
    await client.monetization.onetimeproducts.patch({
      packageName: config.packageName,
      productId,
      allowMissing: true,
      updateMask: "listings,purchaseOptions",
      "regionsVersion.version": config.regionsVersion,
      requestBody: buildOneTimeProduct(pkg, productId, config),
    });

    await setPurchaseOptionState(client, config, productId, String(pkg.status || "ACTIVE").toUpperCase() === "ACTIVE");
  } catch (apiErr) {
    console.error(`[GooglePlay Catalog] Sync failed for product ${productId}:`, describeApiError(apiErr));
    throw new GooglePlayCatalogError(`Google Play product sync failed: ${describeApiError(apiErr)}`);
  }

  console.log(`[GooglePlay Catalog] Product ${productId} synced (${pkg.status || "ACTIVE"})`);
  return productId;
}

/**
 * Stops a Google Play product from being sold. Never throws: used for cleanup paths.
 */
async function deactivateGooglePlayProduct(productId) {
  if (!productId) return false;
  try {
    const config = getCatalogConfig();
    await setPurchaseOptionState(getAndroidPublisherClient(), config, productId, false);
    console.log(`[GooglePlay Catalog] Product ${productId} deactivated`);
    return true;
  } catch (apiErr) {
    console.warn(`[GooglePlay Catalog] Could not deactivate product ${productId}:`, describeApiError(apiErr));
    return false;
  }
}

module.exports = {
  GooglePlayCatalogError,
  isGooglePlaySyncEnabled,
  buildGooglePlayProductId,
  buildOneTimeProduct,
  syncGooglePlayProduct,
  deactivateGooglePlayProduct,
};
