// Minimal signed session token (HMAC-SHA256) — no external JWT dependency.
// Payload: { scope, iat, exp }. Token = base64url(payload) + "." + base64url(hmac)
//
// ADMIN_SESSION_SECRET must be set as a Vercel environment variable.
// This module never logs or returns the secret itself.

const crypto = require("crypto");

const COOKIE_NAME = "pbs_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8; // 8 hours

function getSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not set");
  }
  return secret;
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(input) {
  input = input.replace(/-/g, "+").replace(/_/g, "/");
  while (input.length % 4) input += "=";
  return Buffer.from(input, "base64").toString("utf8");
}

function sign(payloadStr) {
  return base64url(
    crypto.createHmac("sha256", getSecret()).update(payloadStr).digest()
  );
}

/**
 * Create a signed session token for a given admin scope.
 * scope: "SUPER" or a category code (e.g. "PRIME")
 */
function createSessionToken(scope) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { scope, iat: now, exp: now + SESSION_TTL_SECONDS };
  const payloadB64 = base64url(JSON.stringify(payload));
  const sig = sign(payloadB64);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a session token. Returns { scope } if valid, or null if invalid/expired.
 */
function verifySessionToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;

  const expectedSig = sign(payloadB64);
  // constant-time comparison
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.scope || !payload.exp) return null;
  if (Math.floor(Date.now() / 1000) > payload.exp) return null; // expired

  return { scope: payload.scope };
}

function buildSetCookie(token) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  return parts.join("; ");
}

function buildClearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function readSessionFromRequest(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(COOKIE_NAME + "="));
  if (!match) return null;
  const token = match.slice(COOKIE_NAME.length + 1);
  return verifySessionToken(token);
}

module.exports = {
  COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  buildSetCookie,
  buildClearCookie,
  readSessionFromRequest,
};
