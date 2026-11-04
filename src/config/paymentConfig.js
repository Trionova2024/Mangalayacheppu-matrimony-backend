/**
 * Payment Configuration and Validation
 *
 * Paid packages are sold only through In-App Purchase:
 * - Google Play Billing (Android)
 * - Apple App Store (iOS)
 */

/**
 * Validates payment configuration at application startup.
 * Throws an Error with a clear message if configuration is invalid.
 */
function validatePaymentConfig() {
  const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
  const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const googleAppCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (!packageName || !packageName.trim()) {
    throw new Error("FATAL: GOOGLE_PLAY_PACKAGE_NAME is required for Google Play In-App Purchase.");
  }

  if ((!serviceAccountJson || !serviceAccountJson.trim()) && (!googleAppCreds || !googleAppCreds.trim())) {
    throw new Error(
      "FATAL: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS " +
      "is required for Google Play In-App Purchase."
    );
  }

  return { provider: "IAP" };
}

module.exports = {
  validatePaymentConfig,
};
