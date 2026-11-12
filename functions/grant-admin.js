// Run with trusted Application Default Credentials for the production project.
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
initializeApp({ projectId: "teslab-order-center" });

async function grant(uid) {
  if (!uid) throw new Error("Usage: node grant-admin.js <Firebase Authentication UID>");
  const auth = getAuth();
  const account = await auth.getUser(uid);
  if (account.disabled || !account.providerData.some(p => p.providerId === "password")) {
    throw new Error("Select an enabled email/password account in Firebase Authentication.");
  }
  await auth.setCustomUserClaims(uid, { ...account.customClaims, admin: true });
  console.log("Administrator role granted. Sign in again to refresh the ID token.");
}
grant(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
