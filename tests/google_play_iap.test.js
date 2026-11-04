/**
 * Google Play In-App Purchase (IAP) Test Suite
 *
 * Verifies provider selection, configuration validation, purchase verification
 * (subscription and consumable one-time products), idempotency, cross-user protection,
 * Google API error handling, failed purchase recording, and Google Play product sync.
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const express = require("express");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_min_32_characters_long!";
process.env.GOOGLE_PLAY_PACKAGE_NAME = "com.trionova.matrimony";
// Product sync is exercised against the mock client, regardless of the local .env setting
process.env.GOOGLE_PLAY_SYNC_PRODUCTS = "true";
process.env.APPLE_IAP_ENABLED = "false";
process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "test-service-account@matrimony.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3\n-----END PRIVATE KEY-----\n",
});

const prisma = require("../src/lib/prisma");
const { validatePaymentConfig } = require("../src/config/paymentConfig");
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
      monetization: {
        onetimeproducts: {
          patch: async (params) => {
            mockGoogleCalls.push({ method: "onetimeproducts.patch", params });
            if (overrides.productPatchError) {
              throw overrides.productPatchError;
            }
            return { data: params.requestBody };
          },
          purchaseOptions: {
            batchUpdateStates: async (params) => {
              mockGoogleCalls.push({ method: "purchaseOptions.batchUpdateStates", params });
              if (overrides.batchUpdateStatesError) {
                throw overrides.batchUpdateStatesError;
              }
              return { data: {} };
            },
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
    // Subscriptions must be declared explicitly; product IDs are never used to guess the type
    process.env.GOOGLE_PLAY_PRODUCT_TYPES = JSON.stringify({ [testSubPackage.googlePlayProductId]: "SUBSCRIPTION" });

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
    it("Requires GOOGLE_PLAY_PACKAGE_NAME", () => {
      const origPkg = process.env.GOOGLE_PLAY_PACKAGE_NAME;
      delete process.env.GOOGLE_PLAY_PACKAGE_NAME;

      assert.throws(
        () => validatePaymentConfig(),
        /GOOGLE_PLAY_PACKAGE_NAME is required/
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
      assert.equal(body.data.isAppleIap, false);
      assert.equal(body.data.serviceAccount, undefined);
    });

    it("Keeps Apple endpoints switched off unless APPLE_IAP_ENABLED=true", async () => {
      for (const path of ["/api/payments/apple/verify", "/api/payments/apple/notifications"]) {
        const res = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${user1Token}` },
          body: JSON.stringify({ productId: "credits_10", signedTransaction: "forged.jws.token", signedPayload: "forged" }),
        });
        assert.equal(res.status, 404);
        assert.equal((await res.json()).code, "APPLE_IAP_DISABLED");
      }
    });

    it("Rejects paid package order creation (IAP only)", async () => {
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

    it("Treats a product whose name contains \"monthly\" as a one-time product", async () => {
      const monthlyPackage = await prisma.package.create({
        data: {
          name: `Monthly Pack ${Date.now()}`,
          credits: 12,
          amount: 249,
          validityDays: 30,
          googlePlayProductId: `monthly_pack_${Date.now().toString().slice(-8)}`,
          status: "ACTIVE",
        },
      });

      try {
        const res = await fetch(`${baseUrl}/api/payments/google-play/verify`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${user1Token}`,
          },
          body: JSON.stringify({
            productId: monthlyPackage.googlePlayProductId,
            purchaseToken: `monthly_token_${Date.now()}`,
          }),
        });

        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, "COMPLETED");
        assert.equal(body.data.credits, 12);
        assert.ok(mockGoogleCalls.some((c) => c.method === "products.get"));
        assert.ok(!mockGoogleCalls.some((c) => c.method === "subscriptionsv2.get"));
      } finally {
        await prisma.transaction.deleteMany({ where: { packageId: monthlyPackage.id } });
        await prisma.package.delete({ where: { id: monthlyPackage.id } });
      }
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

  describe("4. Failed & Cancelled Purchases", () => {
    async function postJson(path, token, body) {
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
    }

    it("Requires authenticated user to report a failed purchase", async () => {
      const res = await postJson("/api/payments/google-play/failed", null, {
        productId: testInAppPackage.googlePlayProductId,
      });
      assert.equal(res.status, 401);
    });

    it("Rejects failed-purchase report without productId", async () => {
      const res = await postJson("/api/payments/google-play/failed", user1Token, { reason: "CANCELLED" });
      assert.equal(res.status, 400);
    });

    it("Records a user-cancelled purchase as FAILED without changing credits", async () => {
      const before = await prisma.user.findUnique({ where: { id: testUser1.id } });
      const startedAt = new Date();

      const res = await postJson("/api/payments/google-play/failed", user1Token, {
        productId: testInAppPackage.googlePlayProductId,
        reason: "CANCELLED",
        errorCode: "USER_CANCELED",
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.status, "FAILED");
      assert.equal(body.message, "Payment cancelled by user");

      const tx = await prisma.transaction.findFirst({
        where: { userId: testUser1.id, status: "FAILED", purchaseToken: null, createdAt: { gte: startedAt } },
        orderBy: { createdAt: "desc" },
      });
      assert.ok(tx);
      assert.equal(tx.paymentMethod, "GOOGLE_PLAY");
      assert.equal(tx.packageId, testInAppPackage.id);
      assert.equal(tx.amount, testInAppPackage.amount);
      assert.equal(tx.metadata.source, "CLIENT");
      assert.equal(tx.metadata.reason, "CANCELLED");
      assert.equal(tx.metadata.errorCode, "USER_CANCELED");

      const after = await prisma.user.findUnique({ where: { id: testUser1.id } });
      assert.equal(after.credits, before.credits);
    });

    it("Does not duplicate FAILED records for the same purchase token", async () => {
      const purchaseToken = `failed_dup_token_${Date.now()}`;
      const payload = { productId: testInAppPackage.googlePlayProductId, purchaseToken, errorCode: "ERROR" };

      const res1 = await postJson("/api/payments/google-play/failed", user1Token, payload);
      const res2 = await postJson("/api/payments/google-play/failed", user1Token, payload);
      assert.equal((await res1.json()).message, "Payment failed");
      assert.equal(res2.status, 200);

      const count = await prisma.transaction.count({ where: { purchaseToken, status: "FAILED" } });
      assert.equal(count, 1);
    });

    it("Ignores a failure report for a purchase that was already verified", async () => {
      const purchaseToken = `failed_after_success_${Date.now()}`;
      const verifyRes = await postJson("/api/payments/google-play/verify", user1Token, {
        productId: testInAppPackage.googlePlayProductId,
        purchaseToken,
      });
      assert.equal(verifyRes.status, 200);

      const res = await postJson("/api/payments/google-play/failed", user1Token, {
        productId: testInAppPackage.googlePlayProductId,
        purchaseToken,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, "COMPLETED");
      assert.equal(body.data.alreadyProcessed, true);

      const failedCount = await prisma.transaction.count({ where: { purchaseToken, status: "FAILED" } });
      assert.equal(failedCount, 0);
    });

    it("Records FAILED transaction when Google reports the purchase as canceled", async () => {
      setupMockGoogleClient({ purchaseState: 1 }); // 1 = Canceled
      const purchaseToken = `canceled_state_token_${Date.now()}`;

      const res = await postJson("/api/payments/google-play/verify", user1Token, {
        productId: testInAppPackage.googlePlayProductId,
        purchaseToken,
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "PURCHASE_CANCELED");

      const tx = await prisma.transaction.findFirst({ where: { purchaseToken } });
      assert.ok(tx);
      assert.equal(tx.status, "FAILED");
      assert.equal(tx.userId, testUser1.id);
      assert.equal(tx.packageId, testInAppPackage.id);
      assert.equal(tx.metadata.source, "SERVER_VERIFICATION");
      assert.equal(tx.metadata.code, "PURCHASE_CANCELED");
    });

    it("Records FAILED transaction for a user who tries to reuse another user's token", async () => {
      const purchaseToken = `reuse_attempt_token_${Date.now()}`;
      const payload = { productId: testInAppPackage.googlePlayProductId, purchaseToken };

      assert.equal((await postJson("/api/payments/google-play/verify", user1Token, payload)).status, 200);
      assert.equal((await postJson("/api/payments/google-play/verify", user2Token, payload)).status, 409);

      const failed = await prisma.transaction.findFirst({ where: { purchaseToken, status: "FAILED" } });
      assert.ok(failed);
      assert.equal(failed.userId, testUser2.id);
      assert.equal(failed.metadata.code, "PURCHASE_TOKEN_USER_MISMATCH");
    });

    it("Does not record pending purchases as FAILED (they can still complete)", async () => {
      setupMockGoogleClient({ purchaseState: 2 }); // 2 = Pending
      const purchaseToken = `pending_not_failed_${Date.now()}`;

      const res = await postJson("/api/payments/google-play/verify", user1Token, {
        productId: testInAppPackage.googlePlayProductId,
        purchaseToken,
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "PURCHASE_PENDING");

      const tx = await prisma.transaction.findFirst({ where: { purchaseToken } });
      assert.equal(tx, null);
    });
  });

  describe("5. Admin: Automatic Google Play Products for Packages", () => {
    let admin;
    let adminToken;
    const createdPackageIds = [];
    const suffix = Date.now().toString().slice(-6);

    async function adminRequest(method, path, body) {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: body ? JSON.stringify(body) : undefined,
      });
    }

    async function createPackage(body) {
      const res = await adminRequest("POST", "/api/packages", body);
      const json = await res.json();
      if (json.data?.id) createdPackageIds.push(json.data.id);
      return { res, json };
    }

    const callsOf = (method) => mockGoogleCalls.filter((c) => c.method === method);
    const stateRequest = (call) => call.params.requestBody.requests[0];

    before(async () => {
      admin = await prisma.admin.create({
        data: { name: "IAP Test Admin", email: `iap_admin_${suffix}@test.local`, password: "not-used" },
      });
      adminToken = jwt.sign({ id: admin.id }, process.env.JWT_SECRET);
    });

    after(async () => {
      if (createdPackageIds.length) await prisma.package.deleteMany({ where: { id: { in: createdPackageIds } } });
      if (admin) await prisma.admin.delete({ where: { id: admin.id } });
    });

    it("Creates the Google Play product automatically and stores the generated product ID", async () => {
      const { res, json } = await createPackage({
        name: `Gold Credits ${suffix}`, credits: 30, amount: 499, validityDays: 90,
      });
      assert.equal(res.status, 201);

      const productId = json.data.googlePlayProductId;
      assert.equal(productId, `gold_credits_${suffix}_${json.data.id.replace(/-/g, "").slice(0, 8)}`);

      const [patch] = callsOf("onetimeproducts.patch");
      assert.equal(patch.params.productId, productId);
      assert.equal(patch.params.allowMissing, true);
      assert.equal(patch.params.packageName, "com.trionova.matrimony");
      const body = patch.params.requestBody;
      assert.equal(body.listings[0].title, `Gold Credits ${suffix}`);
      const pricing = body.purchaseOptions[0].regionalPricingAndAvailabilityConfigs[0];
      assert.deepEqual(pricing, {
        regionCode: "IN",
        price: { currencyCode: "INR", units: "499", nanos: 0 },
        availability: "AVAILABLE",
      });
      assert.equal(body.purchaseOptions[0].buyOption.legacyCompatible, true);

      const [state] = callsOf("purchaseOptions.batchUpdateStates");
      assert.ok(stateRequest(state).activatePurchaseOptionRequest);
    });

    it("Uses an admin-provided product ID when given", async () => {
      const { res, json } = await createPackage({
        name: `Custom ID Pack ${suffix}`, credits: 15, amount: 349, googlePlayProductId: `credits_15_${suffix}`,
      });
      assert.equal(res.status, 201);
      assert.equal(json.data.googlePlayProductId, `credits_15_${suffix}`);
      assert.equal(callsOf("onetimeproducts.patch")[0].params.productId, `credits_15_${suffix}`);
    });

    it("Does not create a Google Play product for free packages", async () => {
      const { res, json } = await createPackage({ name: `Free Pack ${suffix}`, credits: 3, amount: 0 });
      assert.equal(res.status, 201);
      assert.equal(json.data.googlePlayProductId, null);
      assert.equal(mockGoogleCalls.length, 0);
    });

    it("Rejects an invalid product ID format without calling Google", async () => {
      const { res, json } = await createPackage({
        name: `Bad ID Pack ${suffix}`, credits: 5, amount: 99, googlePlayProductId: "Credits-15 Pack",
      });
      assert.equal(res.status, 400);
      assert.match(json.message, /googlePlayProductId/);
      assert.equal(mockGoogleCalls.length, 0);
    });

    it("Rejects a product ID already used by another package without calling Google", async () => {
      const { res } = await createPackage({
        name: `Duplicate ID Pack ${suffix}`, credits: 5, amount: 99, googlePlayProductId: `credits_15_${suffix}`,
      });
      assert.equal(res.status, 409);
      assert.equal(mockGoogleCalls.length, 0);
    });

    it("Does not save the package when Google Play product creation fails", async () => {
      const apiError = new Error("The caller does not have permission");
      apiError.code = 403;
      setupMockGoogleClient({ productPatchError: apiError });

      const name = `Google Fails Pack ${suffix}`;
      const { res, json } = await createPackage({ name, credits: 10, amount: 299 });
      assert.equal(res.status, 502);
      assert.match(json.message, /Google Play product sync failed: The caller does not have permission/);

      const saved = await prisma.package.findFirst({ where: { name } });
      assert.equal(saved, null);
    });

    it("Pushes price changes and deactivation to Google Play on update", async () => {
      const { json: created } = await createPackage({ name: `Update Pack ${suffix}`, credits: 20, amount: 449 });
      const productId = created.data.googlePlayProductId;
      setupMockGoogleClient();

      const priceRes = await adminRequest("PUT", `/api/packages/${created.data.id}`, { amount: 599 });
      assert.equal(priceRes.status, 200);
      assert.equal((await priceRes.json()).data.googlePlayProductId, productId);
      const [patch] = callsOf("onetimeproducts.patch");
      assert.equal(patch.params.productId, productId);
      assert.equal(patch.params.requestBody.purchaseOptions[0].regionalPricingAndAvailabilityConfigs[0].price.units, "599");

      setupMockGoogleClient();
      const statusRes = await adminRequest("PUT", `/api/packages/${created.data.id}`, { status: "INACTIVE" });
      assert.equal(statusRes.status, 200);
      const [state] = callsOf("purchaseOptions.batchUpdateStates");
      assert.ok(stateRequest(state).deactivatePurchaseOptionRequest);
    });

    it("Keeps the package unchanged when the Google Play update fails", async () => {
      const { json: created } = await createPackage({ name: `Update Fails Pack ${suffix}`, credits: 20, amount: 449 });
      setupMockGoogleClient({ productPatchError: new Error("Price is below the minimum") });

      const res = await adminRequest("PUT", `/api/packages/${created.data.id}`, { amount: 1 });
      assert.equal(res.status, 502);

      const unchanged = await prisma.package.findUnique({ where: { id: created.data.id } });
      assert.equal(unchanged.amount, 449);
    });

    it("Creates the missing Google Play product when an existing package without one is updated", async () => {
      const legacy = await prisma.package.create({
        data: { name: `Legacy Pack ${suffix}`, credits: 10, amount: 399, validityDays: 90 },
      });
      createdPackageIds.push(legacy.id);

      const res = await adminRequest("PUT", `/api/packages/${legacy.id}`, { credits: 12 });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.googlePlayProductId, `legacy_pack_${suffix}_${legacy.id.replace(/-/g, "").slice(0, 8)}`);
      assert.equal(callsOf("onetimeproducts.patch").length, 1);
    });

    it("Deactivates the Google Play product when the package is deleted", async () => {
      const { json: created } = await createPackage({ name: `Delete Pack ${suffix}`, credits: 5, amount: 199 });
      setupMockGoogleClient();

      const res = await adminRequest("DELETE", `/api/packages/${created.data.id}`);
      assert.equal(res.status, 200);
      const [state] = callsOf("purchaseOptions.batchUpdateStates");
      assert.equal(stateRequest(state).deactivatePurchaseOptionRequest.productId, created.data.googlePlayProductId);
    });
  });
});
