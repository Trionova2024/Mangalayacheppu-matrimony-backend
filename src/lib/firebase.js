let adminApp;

try {
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
      : null;

    if (serviceAccount) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      console.log("✅  Firebase Admin initialized");
    } else {
      console.warn("⚠️   FIREBASE_SERVICE_ACCOUNT_JSON not set — FCM push disabled");
    }
  }
  adminApp = admin;
} catch (err) {
  console.warn("Firebase Admin init failed:", err.message);
}

module.exports = adminApp;
