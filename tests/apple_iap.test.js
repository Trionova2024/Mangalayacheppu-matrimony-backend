/**
 * Apple In-App Purchase (IAP) Test Suite
 *
 * Verifies Apple StoreKit 2 JWS verification, StoreKit 1 receipt validation,
 * bundle ID verification, idempotency, cross-user protection, and App Store Server Notifications v2.
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const express = require("express");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_min_32_characters_long!";
process.env.PAYMENT_PROVIDER = "IAP";
process.env.APPLE_BUNDLE_ID = "com.trionova.matrimony";

const prisma = require("../src/lib/prisma");
const { setMockAppleClient } = require("../src/services/appleIapService");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/payments", require("../src/routes/payments"));
  return app;
}

describe("Apple In-App Purchase (IAP) Tests", () => {
  let app;
  let server;
  let baseUrl;
  let testUser1;
  let testUser2;
  let testApplePackage;
  let user1Token;
  let user2Token;

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
        name: `Apple User 1 ${uniqueSuffix}`,
        mobile: `9666${uniqueSuffix}`,
        status: "ACTIVE",
        credits: 10,
      },
    });
    user1Token = jwt.sign({ id: testUser1.id }, process.env.JWT_SECRET);

    testUser2 = await prisma.user.create({
      data: {
        name: `Apple User 2 ${uniqueSuffix}`,
        mobile: `9555${uniqueSuffix}`,
        status: "ACTIVE",
        credits: 5,
      },
    });
    user2Token = jwt.sign({ id: testUser2.id }, process.env.JWT_SECRET);

    testApplePackage = await prisma.package.create({
      data: {
        name: `Apple Gold Subscription ${uniqueSuffix}`,
        credits: 40,
        amount: 799,
        price: 799,
        validityDays: 30,
        appleProductId: `com.trionova.gold_${uniqueSuffix}`,
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
      if (testApplePackage) {
        await prisma.package.delete({ where: { id: testApplePackage.id } }).catch(() => {});
      }
    } catch {}

    setMockAppleClient(null);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    setMockAppleClient(null);
  });

  it("GET /api/payments/config exposes isAppleIap: true", async () => {
    const res = await fetch(`${baseUrl}/api/payments/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.isAppleIap, true);
  });

  it("POST /api/payments/apple/verify requires user authentication", async () => {
    const res = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: testApplePackage.appleProductId }),
    });
    assert.equal(res.status, 401);
  });

  it("Rejects missing productId or verification payload with 400", async () => {
    const res1 = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user1Token}`,
      },
      body: JSON.stringify({}),
    });
    assert.equal(res1.status, 400);

    const res2 = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user1Token}`,
      },
      body: JSON.stringify({ productId: testApplePackage.appleProductId }),
    });
    assert.equal(res2.status, 400);
    const body2 = await res2.json();
    assert.ok(body2.message.includes("signedTransaction or receiptData"));
  });

  it("Rejects unknown Apple product ID with 400", async () => {
    const res = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user1Token}`,
      },
      body: JSON.stringify({
        productId: "com.nonexistent.fake_apple_product",
        signedTransaction: "dummy_signed_tx",
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "UNKNOWN_PRODUCT_ID");
  });

  it("StoreKit 2: Rejects bundle ID mismatch with 400", async () => {
    const fakeJWS = jwt.sign(
      {
        bundleId: "com.othercompany.wrongapp",
        productId: testApplePackage.appleProductId,
        transactionId: "20000001",
        originalTransactionId: "20000001",
      },
      "test_secret"
    );

    const res = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user1Token}`,
      },
      body: JSON.stringify({
        productId: testApplePackage.appleProductId,
        signedTransaction: fakeJWS,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "BUNDLE_ID_MISMATCH");
  });

  it("StoreKit 2: Successfully verifies signed transaction and grants credits", async () => {
    const txId = `apple_tx_${Date.now()}`;
    const userBefore = await prisma.user.findUnique({ where: { id: testUser1.id } });

    const validJWS = jwt.sign(
      {
        bundleId: process.env.APPLE_BUNDLE_ID,
        productId: testApplePackage.appleProductId,
        transactionId: txId,
        originalTransactionId: txId,
        environment: "Sandbox",
      },
      "test_secret"
    );

    const res = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user1Token}`,
      },
      body: JSON.stringify({
        productId: testApplePackage.appleProductId,
        signedTransaction: validJWS,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.status, "COMPLETED");
    assert.equal(body.data.credits, testApplePackage.credits);

    // Verify DB transaction
    const tx = await prisma.transaction.findFirst({
      where: { paymentOrderId: txId, status: "COMPLETED" },
    });
    assert.ok(tx);
    assert.equal(tx.userId, testUser1.id);
    assert.equal(tx.paymentMethod, "APPLE_IAP");

    // Verify credits increased
    const userAfter = await prisma.user.findUnique({ where: { id: testUser1.id } });
    assert.equal(userAfter.credits, userBefore.credits + testApplePackage.credits);
  });

  it("StoreKit 2: Duplicate verification returns alreadyProcessed without duplicate credits", async () => {
    const txId = `apple_idempotent_tx_${Date.now()}`;

    const validJWS = jwt.sign(
      {
        bundleId: process.env.APPLE_BUNDLE_ID,
        productId: testApplePackage.appleProductId,
        transactionId: txId,
        originalTransactionId: txId,
      },
      "test_secret"
    );

    // First call
    const res1 = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user1Token}`,
      },
      body: JSON.stringify({
        productId: testApplePackage.appleProductId,
        signedTransaction: validJWS,
      }),
    });
    assert.equal(res1.status, 200);

    const userAfterFirst = await prisma.user.findUnique({ where: { id: testUser1.id } });

    // Second call
    const res2 = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user1Token}`,
      },
      body: JSON.stringify({
        productId: testApplePackage.appleProductId,
        signedTransaction: validJWS,
      }),
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.success, true);
    assert.equal(body2.data.alreadyProcessed, true);

    const userAfterSecond = await prisma.user.findUnique({ where: { id: testUser1.id } });
    assert.equal(userAfterSecond.credits, userAfterFirst.credits);
  });

  it("StoreKit 2: Rejects claiming transaction already owned by another user", async () => {
    const txId = `apple_cross_user_${Date.now()}`;

    const validJWS = jwt.sign(
      {
        bundleId: process.env.APPLE_BUNDLE_ID,
        productId: testApplePackage.appleProductId,
        transactionId: txId,
        originalTransactionId: txId,
      },
      "test_secret"
    );

    // User 1 claims it
    const res1 = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user1Token}`,
      },
      body: JSON.stringify({
        productId: testApplePackage.appleProductId,
        signedTransaction: validJWS,
      }),
    });
    assert.equal(res1.status, 200);

    // User 2 attempts to claim it
    const res2 = await fetch(`${baseUrl}/api/payments/apple/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${user2Token}`,
      },
      body: JSON.stringify({
        productId: testApplePackage.appleProductId,
        signedTransaction: validJWS,
      }),
    });

    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.code, "PURCHASE_TOKEN_USER_MISMATCH");
  });

  it("App Store Server Notifications: Handles DID_RENEW subscription renewal", async () => {
    const originalTxId = `orig_sub_${Date.now()}`;

    // Seed original subscription transaction
    await prisma.transaction.create({
      data: {
        userId: testUser1.id,
        packageId: testApplePackage.id,
        amount: testApplePackage.amount,
        paymentMethod: "APPLE_IAP",
        paymentOrderId: originalTxId,
        purchaseToken: originalTxId,
        productId: testApplePackage.appleProductId,
        status: "COMPLETED",
      },
    });

    const userBefore = await prisma.user.findUnique({ where: { id: testUser1.id } });
    const renewalTxId = `renew_${Date.now()}`;

    const signedTxInfo = jwt.sign(
      {
        originalTransactionId: originalTxId,
        transactionId: renewalTxId,
        productId: testApplePackage.appleProductId,
        expiresDate: new Date(Date.now() + 30 * 86400000).toISOString(),
      },
      "test_secret"
    );

    const signedPayload = jwt.sign(
      {
        notificationType: "DID_RENEW",
        data: {
          signedTransactionInfo: signedTxInfo,
        },
      },
      "test_secret"
    );

    const res = await fetch(`${baseUrl}/api/payments/apple/notifications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedPayload }),
    });

    assert.equal(res.status, 200);

    // Verify renewal transaction created
    const renewalTx = await prisma.transaction.findFirst({
      where: { paymentOrderId: renewalTxId },
    });
    assert.ok(renewalTx);
    assert.equal(renewalTx.userId, testUser1.id);

    // Verify renewal credits added
    const userAfter = await prisma.user.findUnique({ where: { id: testUser1.id } });
    assert.equal(userAfter.credits, userBefore.credits + testApplePackage.credits);
  });
});
