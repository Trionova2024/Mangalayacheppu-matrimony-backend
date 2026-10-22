/**
 * Google Play In-App Purchase (IAP) Test Suite
 *
 * Verifies provider selection, configuration validation, purchase verification
 * (subscription and consumable one-time products), idempotency, cross-user protection,
 * Google API error handling, and Pub/Sub RTDN lifecycle handling.
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const express = require("express");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_min_32_characters_long!";
process.env.PAYMENT_PROVIDER = "IAP";
process.env.GOOGLE_PLAY_PACKAGE_NAME = "com.trionova.matrimony";
process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "test-service-account@matrimony.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END PRIVATE KEY-----\n",
});
process.env.GOOGLE_PLAY_PUBSUB_VERIFICATION_TOKEN = "test_pubsub_secret_token";

const prisma = require("../src/lib/prisma");
const { validatePaymentConfig, getPaymentProvider } = require("../src/config/paymentConfig");
const { setMockAndroidPublisherClient } = require("../src/services/googlePlayService");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/packages", require("../src/routes/packages"));
  app.use("/api/payments", require("../src/routes/payments"));
  return app;
}

describe("Google Play IAP Tests", () => {
  let app;
  let server;
  let baseUrl;
  let testUser1;
  let testUser2;
  let testSubPackage;
  let testInAppPackage;
  let user1Token;
  let user2Token;
  let mockGoogleCalls = [];

  // Helper to build a customizable mock Android Publisher API client
  function setupMockGoogleClient(overrides = {}) {
    mockGoogleCalls = [];
    const mockClient = {
      purchases: {
        subscriptionsv2: {
          get: async ({ packageName, token }) => {
            mockGoogleCalls.push({ method: "subscriptionsv2.get", packageName, token });
            if (overrides.subscriptionsv2GetError) {
              throw overrides.subscriptionsv2GetError;
            }
            return {
              data: {
                subscriptionState: overrides.subscriptionState ?? "SUBSCRIPTION_STATE_ACTIVE",
                latestOrderId: overrides.latestOrderId ?? `GPA.test-${Date.now()}`,
                acknowledgementState: overrides.acknowledgementState ?? "ACKNOWLEDGEMENT_STATE_PENDING_ACKNOWLEDGE",
                lineItems: [
                  {
                    productId: overrides.lineItemProductId ?? testSubPackage.googlePlayProductId,
                    expiryTime: overrides.expiryTime ?? new Date(Date.now() + 30 * 86400000).toISOString(),
                  },
                ],
              },
            };
          },
        },
        subscriptions: {
          acknowledge: async ({ packageName, subscriptionId, token }) => {
            mockGoogleCalls.push({ method: "subscriptions.acknowledge", packageName, subscriptionId, token });
            if (overrides.subscriptionAcknowledgeError) {
              throw overrides.subscriptionAcknowledgeError;
            }
            return { data: {} };
          },
        },
        products: {
          get: async ({ packageName, productId, token }) => {
            mockGoogleCalls.push({ method: "products.get", packageName, productId, token });
            if (overrides.productsGetError) {
              throw overrides.productsGetError;
            }
            return {
              data: {
                purchaseState: overrides.purchaseState ?? 0, // 0 = Purchased
                consumptionState: overrides.consumptionState ?? 0, // 0 = Yet to be consumed
                acknowledgementState: overrides.acknowledgementState ?? 0,
                orderId: overrides.orderId ?? `GPA.prod-${Date.now()}`,
              },
            };
          },
          consume: async ({ packageName, productId, token }) => {
            mockGoogleCalls.push({ method: "products.consume", packageName, productId, token });
            if (overrides.productsConsumeError) {
              throw overrides.productsConsumeError;
            }
            return { data: {} };
          },
        },
      },
    };
    setMockAndroidPublisherClient(mockClient);
    return mockClient;
  }

  before(async () => {
    app = createTestApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    const uniqueSuffix = Date.now().toString().slice(-6);

    testUser1 = await prisma.user.create({
      data: {
        name: `IAP User 1 ${uniqueSuffix}`,
        mobile: `9888${uniqueSuffix}`,
        status: "ACTIVE",
        credits: 10,
      },
    });
    user1Token = jwt.sign({ id: testUser1.id }, process.env.JWT_SECRET);

    testUser2 = await prisma.user.create({
      data: {
        name: `IAP User 2 ${uniqueSuffix}`,
        mobile: `9777${uniqueSuffix}`,
        status: "ACTIVE",
        credits: 5,
      },
    });
    user2Token = jwt.sign({ id: testUser2.id }, process.env.JWT_SECRET);

    testSubPackage = await prisma.package.create({
      data: {
        name: `Gold Subscription ${uniqueSuffix}`,
        credits: 50,
        amount: 899,
        price: 899,
        validityDays: 30,
        googlePlayProductId: `sub_gold_monthly_${uniqueSuffix}`,
        status: "ACTIVE",
      },
    });

    testInAppPackage = await prisma.package.create({
      data: {
        name: `Consumable Credits Pack ${uniqueSuffix}`,
        credits: 25,
        amount: 399,
        price: 399,
        validityDays: 90,
        googlePlayProductId: `inapp_credits_25_${uniqueSuffix}`,
        status: "ACTIVE",
      },
    });
  });

  after(async () => {
    try {
      if (testUser1) {
        await prisma.creditAuditLog.deleteMany({ where: { userId: testUser1.id } });
        await prisma.transaction.deleteMany({ where: { userId: testUser1.id } });
        await prisma.user.delete({ where: { id: testUser1.id } }).catch(() => {});
      }
      if (testUser2) {
        await prisma.creditAuditLog.deleteMany({ where: { userId: testUser2.id } });
        await prisma.transaction.deleteMany({ where: { userId: testUser2.id } });
        await prisma.user.delete({ where: { id: testUser2.id } }).catch(() => {});
      }
      if (testSubPackage) {
        await prisma.package.delete({ where: { id: testSubPackage.id } }).catch(() => {});
      }
      if (testInAppPackage) {
        await prisma.package.delete({ where: { id: testInAppPackage.id } }).catch(() => {});
      }
    } catch {}

    setMockAndroidPublisherClient(null);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    setupMockGoogleClient();
  });

  describe("1. Environment & Provider Configuration", () => {
    it("Validates PAYMENT_PROVIDER=CASHFREE without requiring IAP credentials", () => {
      const origProvider = process.env.PAYMENT_PROVIDER;
      const origPkg = process.env.GOOGLE_PLAY_PACKAGE_NAME;
      const origCreds = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;

      process.env.PAYMENT_PROVIDER = "CASHFREE";
      delete process.env.GOOGLE_PLAY_PACKAGE_NAME;
      delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;

      const result = validatePaymentConfig();
      assert.equal(result.provider, "CASHFREE");

      process.env.PAYMENT_PROVIDER = origProvider;
      process.env.GOOGLE_PLAY_PACKAGE_NAME = origPkg;
      process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = origCreds;
    });

    it("Rejects invalid PAYMENT_PROVIDER with a clear error", () => {
      const origProvider = process.env.PAYMENT_PROVIDER;
      process.env.PAYMENT_PROVIDER = "STRIPE";

      assert.throws(
        () => validatePaymentConfig(),
        /Invalid PAYMENT_PROVIDER "STRIPE"/
      );

      process.env.PAYMENT_PROVIDER = origProvider;
    });

    it("Requires GOOGLE_PLAY_PACKAGE_NAME when PAYMENT_PROVIDER=IAP", () => {
      const origPkg = process.env.GOOGLE_PLAY_PACKAGE_NAME;
      delete process.env.GOOGLE_PLAY_PACKAGE_NAME;

      assert.throws(
        () => validatePaymentConfig(),
        /GOOGLE_PLAY_PACKAGE_NAME is required when PAYMENT_PROVIDER=IAP/
      );

      process.env.GOOGLE_PLAY_PACKAGE_NAME = origPkg;
    });

    it("GET /api/payments/config exposes provider info without secrets", async () => {
      const res = await fetch(`${baseUrl}/api/payments/config`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.provider, "IAP");
      assert.equal(body.data.isIap, true);
      assert.equal(body.data.isCashfree, false);
      assert.equal(body.data.serviceAccount, undefined);
    });

    it("Rejects Cashfree order creation when PAYMENT_PROVIDER=IAP", async () => {
      const res = await fetch(`${baseUrl}/api/packages/create-order`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({ packageId: testSubPackage.id }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "IAP_PROVIDER_ACTIVE");
    });
  });

  describe("2. Google Play Purchase Verification Endpoint", () => {
    it("Requires authenticated user (rejects without token)", async () => {
      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: testSubPackage.googlePlayProductId,
          purchaseToken: "sample_token",
        }),
      });
      assert.equal(res.status, 401);
    });

    it("Rejects missing productId or purchaseToken with 400", async () => {
      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({ productId: testSubPackage.googlePlayProductId }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.ok(body.message.includes("purchaseToken"));
    });

    it("Rejects package name mismatch with 400", async () => {
      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testSubPackage.googlePlayProductId,
          purchaseToken: "valid_token_123",
          packageName: "com.imposter.fakeapp",
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "PACKAGE_NAME_MISMATCH");
    });

    it("Rejects unknown or unmapped product ID with 400", async () => {
      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: "unknown_nonexistent_product_xyz",
          purchaseToken: "valid_token_123",
        }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "UNKNOWN_PRODUCT_ID");
    });

    it("Successfully verifies subscription, allocates credits, and acknowledges with Google", async () => {
      const purchaseToken = `sub_token_success_${Date.now()}`;
      const userBefore = await prisma.user.findUnique({ where: { id: testUser1.id } });

      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testSubPackage.googlePlayProductId,
          purchaseToken,
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.status, "COMPLETED");
      assert.equal(body.data.credits, testSubPackage.credits);

      // Verify Google subscription acknowledge was called
      const ackCall = mockGoogleCalls.find((c) => c.method === "subscriptions.acknowledge");
      assert.ok(ackCall, "Expected subscriptions.acknowledge to be called");
      assert.equal(ackCall.token, purchaseToken);

      // Verify DB transaction
      const tx = await prisma.transaction.findFirst({
        where: { purchaseToken, status: "COMPLETED" },
      });
      assert.ok(tx);
      assert.equal(tx.userId, testUser1.id);
      assert.equal(tx.paymentMethod, "GOOGLE_PLAY");
      assert.equal(tx.packageId, testSubPackage.id);

      // Verify credits incremented
      const userAfter = await prisma.user.findUnique({ where: { id: testUser1.id } });
      assert.equal(userAfter.credits, userBefore.credits + testSubPackage.credits);
    });

    it("Rejects pending subscription purchases with 400 (no credits granted)", async () => {
      setupMockGoogleClient({
        subscriptionState: "SUBSCRIPTION_STATE_PENDING",
      });

      const purchaseToken = `sub_pending_token_${Date.now()}`;
      const userBefore = await prisma.user.findUnique({ where: { id: testUser1.id } });

      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testSubPackage.googlePlayProductId,
          purchaseToken,
        }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "PURCHASE_PENDING");

      // Verify no credits were granted
      const userAfter = await prisma.user.findUnique({ where: { id: testUser1.id } });
      assert.equal(userAfter.credits, userBefore.credits);
    });

    it("Rejects expired subscription purchases with 400 (no credits granted)", async () => {
      setupMockGoogleClient({
        subscriptionState: "SUBSCRIPTION_STATE_EXPIRED",
      });

      const purchaseToken = `sub_expired_token_${Date.now()}`;
      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testSubPackage.googlePlayProductId,
          purchaseToken,
        }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "SUBSCRIPTION_EXPIRED");
    });

    it("Successfully verifies consumable one-time product and consumes it with Google", async () => {
      const purchaseToken = `inapp_token_success_${Date.now()}`;
      const userBefore = await prisma.user.findUnique({ where: { id: testUser1.id } });

      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testInAppPackage.googlePlayProductId,
          purchaseToken,
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.status, "COMPLETED");

      // Verify Google products consume was called
      const consumeCall = mockGoogleCalls.find((c) => c.method === "products.consume");
      assert.ok(consumeCall, "Expected products.consume to be called for consumable");
      assert.equal(consumeCall.token, purchaseToken);

      // Verify credits incremented
      const userAfter = await prisma.user.findUnique({ where: { id: testUser1.id } });
      assert.equal(userAfter.credits, userBefore.credits + testInAppPackage.credits);
    });

    it("Rejects pending one-time purchases with 400", async () => {
      setupMockGoogleClient({ purchaseState: 2 }); // 2 = Pending

      const purchaseToken = `inapp_pending_token_${Date.now()}`;
      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testInAppPackage.googlePlayProductId,
          purchaseToken,
        }),
      });

      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "PURCHASE_PENDING");
    });

    it("Handles duplicate verification request idempotently (no duplicate credits)", async () => {
      const purchaseToken = `idempotent_token_${Date.now()}`;

      // First verification
      const res1 = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testInAppPackage.googlePlayProductId,
          purchaseToken,
        }),
      });
      assert.equal(res1.status, 200);

      const userAfterFirst = await prisma.user.findUnique({ where: { id: testUser1.id } });

      // Second verification of the exact same token
      const res2 = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testInAppPackage.googlePlayProductId,
          purchaseToken,
        }),
      });
      assert.equal(res2.status, 200);
      const body2 = await res2.json();
      assert.equal(body2.success, true);
      assert.equal(body2.data.alreadyProcessed, true);

      // Credits must NOT have increased on duplicate
      const userAfterSecond = await prisma.user.findUnique({ where: { id: testUser1.id } });
      assert.equal(userAfterSecond.credits, userAfterFirst.credits);
    });

    it("Prevents purchase token from granting entitlements to a different user (anti-fraud)", async () => {
      const purchaseToken = `cross_user_token_${Date.now()}`;

      // User 1 claims token
      const res1 = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testInAppPackage.googlePlayProductId,
          purchaseToken,
        }),
      });
      assert.equal(res1.status, 200);

      const user2Before = await prisma.user.findUnique({ where: { id: testUser2.id } });

      // User 2 attempts to claim the same purchase token
      const res2 = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user2Token}`,
        },
        body: JSON.stringify({
          productId: testInAppPackage.googlePlayProductId,
          purchaseToken,
        }),
      });

      assert.equal(res2.status, 409);
      const body2 = await res2.json();
      assert.equal(body2.code, "PURCHASE_TOKEN_USER_MISMATCH");

      // User 2 credits must NOT increase
      const user2After = await prisma.user.findUnique({ where: { id: testUser2.id } });
      assert.equal(user2After.credits, user2Before.credits);
    });

    it("Handles Google API network error with 502 and does not create completed transaction", async () => {
      const apiError = new Error("Connection timed out to googleapis.com");
      apiError.status = 503;

      setupMockGoogleClient({
        subscriptionsv2GetError: apiError,
      });

      const purchaseToken = `timeout_token_${Date.now()}`;
      const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${user1Token}`,
        },
        body: JSON.stringify({
          productId: testSubPackage.googlePlayProductId,
          purchaseToken,
        }),
      });

      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.code, "GOOGLE_API_ERROR");

      // Ensure no transaction was recorded
      const tx = await prisma.transaction.findFirst({ where: { purchaseToken } });
      assert.equal(tx, null);
    });
  });

  describe("3. Google Play RTDN Pub/Sub Notifications", () => {
    it("Rejects Pub/Sub push notification with invalid token", async () => {
      const res = await fetch(`${baseUrl}/api/payments/google-play/notifications?token=invalid_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: { data: Buffer.from("{}").toString("base64") } }),
      });
      assert.equal(res.status, 401);
    });

    it("Acknowledges test notification ping from Google Play Console", async () => {
      const payload = {
        version: "1.0",
        packageName: "com.trionova.matrimony",
        eventTimeMillis: Date.now().toString(),
        testNotification: { version: "1.0" },
      };

      const res = await fetch(`${baseUrl}/api/payments/google-play/notifications?token=test_pubsub_secret_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            data: Buffer.from(JSON.stringify(payload)).toString("base64"),
          },
        }),
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.eventType, "TEST_NOTIFICATION");
    });

    it("Processes subscription renewal notification (type 2) and updates expiry and credits", async () => {
      const purchaseToken = `rtdn_renew_token_${Date.now()}`;

      // Seed initial purchase for User 1
      await prisma.transaction.create({
        data: {
          userId: testUser1.id,
          packageId: testSubPackage.id,
          amount: testSubPackage.amount,
          paymentMethod: "GOOGLE_PLAY",
          paymentOrderId: `GPA.init-${Date.now()}`,
          purchaseToken,
          productId: testSubPackage.googlePlayProductId,
          status: "COMPLETED",
        },
      });

      const renewalOrderId = `GPA.renew-${Date.now()}`;
      setupMockGoogleClient({
        latestOrderId: renewalOrderId,
        lineItemProductId: testSubPackage.googlePlayProductId,
        expiryTime: new Date(Date.now() + 60 * 86400000).toISOString(),
      });

      const userBefore = await prisma.user.findUnique({ where: { id: testUser1.id } });

      const payload = {
        version: "1.0",
        packageName: "com.trionova.matrimony",
        subscriptionNotification: {
          notificationType: 2, // SUBSCRIPTION_RENEWED
          purchaseToken,
          subscriptionId: testSubPackage.googlePlayProductId,
        },
      };

      const res = await fetch(`${baseUrl}/api/payments/google-play/notifications?token=test_pubsub_secret_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            data: Buffer.from(JSON.stringify(payload)).toString("base64"),
          },
        }),
      });

      assert.equal(res.status, 200);

      // Verify renewal transaction created
      const renewalTx = await prisma.transaction.findFirst({
        where: { paymentOrderId: renewalOrderId },
      });
      assert.ok(renewalTx);
      assert.equal(renewalTx.userId, testUser1.id);

      // Verify renewal credits added
      const userAfter = await prisma.user.findUnique({ where: { id: testUser1.id } });
      assert.equal(userAfter.credits, userBefore.credits + testSubPackage.credits);
    });

    it("Processes subscription revocation notification (type 12) and marks transaction REFUNDED", async () => {
      const purchaseToken = `rtdn_revoke_token_${Date.now()}`;

      await prisma.transaction.create({
        data: {
          userId: testUser1.id,
          packageId: testSubPackage.id,
          amount: testSubPackage.amount,
          paymentMethod: "GOOGLE_PLAY",
          paymentOrderId: `GPA.revoke_test-${Date.now()}`,
          purchaseToken,
          productId: testSubPackage.googlePlayProductId,
          status: "COMPLETED",
        },
      });

      const payload = {
        version: "1.0",
        packageName: "com.trionova.matrimony",
        subscriptionNotification: {
          notificationType: 12, // SUBSCRIPTION_REVOKED
          purchaseToken,
          subscriptionId: testSubPackage.googlePlayProductId,
        },
      };

      const res = await fetch(`${baseUrl}/api/payments/google-play/notifications?token=test_pubsub_secret_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            data: Buffer.from(JSON.stringify(payload)).toString("base64"),
          },
        }),
      });

      assert.equal(res.status, 200);

      const revokedTx = await prisma.transaction.findFirst({
        where: { purchaseToken },
      });
      assert.equal(revokedTx.status, "REFUNDED");
    });
  });
});
