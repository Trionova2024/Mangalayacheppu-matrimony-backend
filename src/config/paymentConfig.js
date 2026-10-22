/**
 * Payment Provider Configuration and Validation
 *
 * Supported providers:
 * - CASHFREE (default)
 * - IAP (Google Play In-App Purchase)
 */

const SUPPORTED_PROVIDERS = Object.freeze(["CASHFREE", "IAP"]);

/**
 * Returns the currently configured payment provider in uppercase.
 * Defaults to "CASHFREE" if not set.
 */
function getPaymentProvider() {
  const raw = process.env.PAYMENT_PROVIDER;
  if (!raw || !raw.trim()) {
    return "CASHFREE";
  }
  return raw.trim().toUpperCase();
}

/**
 * Checks if the configured provider is valid.
 */
function isValidProvider(provider) {
  return SUPPORTED_PROVIDERS.includes(provider);
}

/**
 * Validates payment configuration at application startup.
 * Throws an Error with a clear message if configuration is invalid.
 */
function validatePaymentConfig() {
  const provider = getPaymentProvider();

  if (!isValidProvider(provider)) {
    throw new Error(
      `FATAL: Invalid PAYMENT_PROVIDER "${process.env.PAYMENT_PROVIDER}". ` +
      `Supported values are: ${SUPPORTED_PROVIDERS.join(", ")} (case-insensitive).`
    );
  }

  // If IAP is selected, validate required Google Play configuration
  if (provider === "IAP") {
    const packageName = process.env.GOOGLE_PLAY_PACKAGE_NAME;
    const serviceAccountJson = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
    const googleAppCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

    if (!packageName || !packageName.trim()) {
      throw new Error(
        "FATAL: GOOGLE_PLAY_PACKAGE_NAME is required when PAYMENT_PROVIDER=IAP."
      );
    }

    if ((!serviceAccountJson || !serviceAccountJson.trim()) && (!googleAppCreds || !googleAppCreds.trim())) {
      throw new Error(
        "FATAL: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS " +
        "is required when PAYMENT_PROVIDER=IAP."
      );
    }
  }

  // Notice: If provider === "CASHFREE", missing IAP credentials MUST NOT cause an error.
  return { provider };
}

function isCashfreeEnabled() {
  return getPaymentProvider() === "CASHFREE";
}

function isIapEnabled() {
  return getPaymentProvider() === "IAP";
}

module.exports = {
  SUPPORTED_PROVIDERS,
  getPaymentProvider,
  isValidProvider,
  validatePaymentConfig,
  isCashfreeEnabled,
  isIapEnabled,
};
