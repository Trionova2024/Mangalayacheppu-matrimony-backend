/**
 * Cashfree Regression Test Suite
 *
 * Verifies that all Cashfree operations (order creation, payment verification,
 * webhook signature checking, replay protection, idempotency, and credit allocation)
 * continue functioning with zero behavioral regressions.
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const express = require("express");

// Set up environment for testing
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_jwt_secret_min_32_characters_long!";
process.env.PAYMENT_PROVIDER = "CASHFREE";
process.env.CASHFREE_APP_ID = "test_cf_app_id";
process.env.CASHFREE_SECRET_KEY = "test_cf_secret_key_1234567890";
process.env.CASHFREE_ENV = "sandbox";

const prisma = require("../src/lib/prisma");

// Build minimal express test app
function createTestApp() {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf ? buf.toString("utf8") : "";
    },
  }));
  app.use("/api/packages", require("../src/routes/packages"));
  app.use("/api/payments", require("../src/routes/payments"));
  return app;
}

describe("Cashfree Regression Tests", () => {
  let app;
  let server;
  let baseUrl;
  let testUser;
  let testPackage;
  let testFreePackage;
  let userToken;

  before(async () => {
    app = createTestApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // Create unique test user and packages
    const uniqueSuffix = Date.now().toString().slice(-6);
    testUser = await prisma.user.create({
      data: {
        name: `CF Test User ${uniqueSuffix}`,
        mobile: `9999${uniqueSuffix}`,
        status: "ACTIVE",
        credits: 5,
        freeContactsLeft: 3,
      },
    });

    userToken = jwt.sign({ id: testUser.id }, process.env.JWT_SECRET);

    testPackage = await prisma.package.create({
      data: {
        name: `CF Package ${uniqueSuffix}`,
        credits: 20,
        amount: 499,
        price: 499,
        validityDays: 60,
        status: "ACTIVE",
      },
    });

    testFreePackage = await prisma.package.create({
      data: {
        name: `Free Offer ${uniqueSuffix}`,
        credits: 5,
        amount: 0,
        price: 0,
        validityDays: 30,
        status: "ACTIVE",
      },
    });
  });

  after(async () => {
    // Clean up test data
    try {
      if (testUser) {
        await prisma.transaction.deleteMany({ where: { userId: testUser.id } });
        await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
      }
      if (testPackage) {
        await prisma.package.delete({ where: { id: testPackage.id } }).catch(() => {});
      }
      if (testFreePackage) {
        await prisma.package.delete({ where: { id: testFreePackage.id } }).catch(() => {});
      }
    } catch {}

    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("GET /api/packages should return packages and provider info", async () => {
    const res = await fetch(`${baseUrl}/api/packages`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data.packages));
    assert.equal(body.data.paymentProvider, "CASHFREE");
  });

  it("POST /api/packages/create-order for free package (amount === 0) should activate instantly", async () => {
    const res = await fetch(`${baseUrl}/api/packages/create-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ packageId: testFreePackage.id }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.isFree, true);
    assert.equal(body.data.status, "COMPLETED");

    // Verify credits increased
    const updatedUser = await prisma.user.findUnique({ where: { id: testUser.id } });
    assert.equal(updatedUser.credits, 5 + testFreePackage.credits);

    // Verify duplicate free offer claim is rejected
    const dupRes = await fetch(`${baseUrl}/api/packages/create-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({ packageId: testFreePackage.id }),
    });
    assert.equal(dupRes.status, 400);
    const dupBody = await dupRes.json();
    assert.equal(dupBody.code, "OFFER_ALREADY_CLAIMED");
  });

  it("POST /api/packages/verify-payment records explicit user cancellation", async () => {
    const orderId = `test_cancel_order_${Date.now()}`;
    const res = await fetch(`${baseUrl}/api/packages/verify-payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        orderId,
        packageId: testPackage.id,
        status: "CANCELLED",
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.status, "FAILED");

    // Verify failed transaction was logged
    const tx = await prisma.transaction.findFirst({
      where: { paymentOrderId: orderId, userId: testUser.id },
    });
    assert.ok(tx);
    assert.equal(tx.status, "FAILED");
    assert.equal(tx.paymentMethod, "CASHFREE");
  });

  it("Cashfree webhook signature verification rejects missing or invalid signatures", async () => {
    const res = await fetch(`${baseUrl}/api/packages/cashfree-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "TEST" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.ok(body.message.includes("signature"));
  });

  it("Cashfree webhook signature rejects timestamps older than 5 minutes (replay protection)", async () => {
    const oldTimestamp = Date.now() - 6 * 60 * 1000; // 6 mins ago
    const rawBody = JSON.stringify({ type: "TEST" });
    const payload = `${oldTimestamp}${rawBody}`;
    const sig = crypto.createHmac("sha256", process.env.CASHFREE_SECRET_KEY).update(payload).digest("base64");

    const res = await fetch(`${baseUrl}/api/packages/cashfree-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-timestamp": String(oldTimestamp),
        "x-webhook-signature": sig,
      },
      body: rawBody,
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.message.includes("expired"));
  });

  it("Cashfree webhook acknowledges valid test webhook ping", async () => {
    const timestamp = Date.now();
    const rawBody = JSON.stringify({ type: "TEST", data: { test_object: true } });
    const payload = `${timestamp}${rawBody}`;
    const sig = crypto.createHmac("sha256", process.env.CASHFREE_SECRET_KEY).update(payload).digest("base64");

    const res = await fetch(`${baseUrl}/api/packages/cashfree-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-timestamp": String(timestamp),
        "x-webhook-signature": sig,
      },
      body: rawBody,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
  });

  it("Cashfree webhook processes valid payment success and allocates credits idempotently", async () => {
    const orderId = `cf_test_order_${Date.now()}`;
    const cfPaymentId = `cf_pay_${Date.now()}`;
    const timestamp = Date.now();

    const initialUser = await prisma.user.findUnique({ where: { id: testUser.id } });
    const initialCredits = initialUser.credits;

    const webhookBody = {
      type: "PAYMENT_SUCCESS_WEBHOOK",
      data: {
        order: {
          order_id: orderId,
          order_amount: testPackage.amount,
          order_tags: {
            userId: testUser.id,
            packageId: testPackage.id,
          },
        },
        payment: {
          cf_payment_id: cfPaymentId,
          payment_status: "SUCCESS",
        },
      },
    };

    const rawBody = JSON.stringify(webhookBody);
    const signedPayload = `${timestamp}${rawBody}`;
    const sig = crypto.createHmac("sha256", process.env.CASHFREE_SECRET_KEY).update(signedPayload).digest("base64");

    // First delivery: should succeed and allocate credits
    const res1 = await fetch(`${baseUrl}/api/packages/cashfree-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-timestamp": String(timestamp),
        "x-webhook-signature": sig,
      },
      body: rawBody,
    });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.success, true);
    assert.equal(body1.status, "COMPLETED");

    const afterUser = await prisma.user.findUnique({ where: { id: testUser.id } });
    assert.equal(afterUser.credits, initialCredits + testPackage.credits);

    // Second delivery (duplicate webhook): should be idempotent and NOT allocate double credits
    const res2 = await fetch(`${baseUrl}/api/packages/cashfree-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-timestamp": String(timestamp),
        "x-webhook-signature": sig,
      },
      body: rawBody,
    });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.success, true);
    assert.equal(body2.alreadyProcessed, true);

    const finalUser = await prisma.user.findUnique({ where: { id: testUser.id } });
    assert.equal(finalUser.credits, initialCredits + testPackage.credits);
  });
});
