import { base64UrlToBytes, bytesToBase64Url } from "./crypto.js";

export const SESSION_COOKIE = "postplan_session";
export const AUTH_STATE_COOKIE = "postplan_auth_state";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_STATE_TTL_SECONDS = 10 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function signToken(payload, secret, ttlSeconds, now = nowSeconds()) {
  const body = bytesToBase64Url(
    encoder.encode(JSON.stringify({ ...payload, exp: now + ttlSeconds }))
  );
  return `${body}.${bytesToBase64Url(await hmac(body, secret))}`;
}

export async function verifyToken(token, secret, now = nowSeconds()) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await importHmacKey(secret),
      base64UrlToBytes(parts[1]),
      encoder.encode(parts[0])
    );
    if (!valid) return null;

    const payload = JSON.parse(decoder.decode(base64UrlToBytes(parts[0])));
    if (!Number.isFinite(payload.exp) || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function createSessionCookie(
  { accountId, accountName, email, pictureUrl },
  secret,
  { secure = true } = {}
) {
  const token = await signToken(
    { accountId, accountName, email: email ?? null, pictureUrl: pictureUrl ?? null },
    requireSecret(secret),
    SESSION_TTL_SECONDS
  );
  return serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, secure });
}

export function clearSessionCookie({ secure = true } = {}) {
  return serializeCookie(SESSION_COOKIE, "", { maxAge: 0, secure });
}

export async function createAuthStateCookie(payload, secret, { secure = true } = {}) {
  const token = await signToken(payload, requireSecret(secret), AUTH_STATE_TTL_SECONDS);
  return serializeCookie(AUTH_STATE_COOKIE, token, {
    maxAge: AUTH_STATE_TTL_SECONDS,
    secure
  });
}

export function clearAuthStateCookie({ secure = true } = {}) {
  return serializeCookie(AUTH_STATE_COOKIE, "", { maxAge: 0, secure });
}

export async function readSession(request, secret) {
  if (!secret) return null;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const payload = await verifyToken(token, secret);
  return payload?.accountId ? payload : null;
}

export async function readAuthState(request, secret) {
  if (!secret) return null;
  const token = readCookie(request, AUTH_STATE_COOKIE);
  return token ? verifyToken(token, secret) : null;
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const equalIndex = part.indexOf("=");
    if (equalIndex === -1) continue;
    if (part.slice(0, equalIndex).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(equalIndex + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function serializeCookie(name, value, { maxAge, secure }) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

async function hmac(value, secret) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secret),
    encoder.encode(value)
  );
  return new Uint8Array(signature);
}

function importHmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function requireSecret(secret) {
  if (!secret) throw new Error("POSTPLAN_SESSION_SECRET is not configured.");
  return secret;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
