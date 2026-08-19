import { createRemoteJWKSet, jwtVerify } from "jose";
import { bytesToBase64Url, randomToken } from "./crypto.js";

const jwksCaches = new Map();
const issuerCaches = new Map();

export async function buildPkce() {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: bytesToBase64Url(new Uint8Array(digest)),
    state: randomToken(24)
  };
}

export function buildAuthorizeUrl({ shooBaseUrl, redirectUri, state, challenge }) {
  const url = new URL(`${shooBaseUrl}/authorize`);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("pii", "true");
  return url.toString();
}

export async function exchangeCode({ shooBaseUrl, code, verifier, redirectUri }) {
  const response = await fetch(`${shooBaseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier
    }),
    signal: AbortSignal.timeout(10_000)
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`shoo token exchange failed: ${body.error || response.status}`);
  }
  if (typeof body.id_token !== "string") {
    throw new Error("shoo token exchange returned no id_token.");
  }
  return body;
}

export async function verifyIdToken(idToken, { shooBaseUrl, audOrigin }) {
  const audience = `origin:${new URL(audOrigin).origin}`;
  const { payload } = await jwtVerify(idToken, getJwks(shooBaseUrl), {
    issuer: await getIssuer(shooBaseUrl),
    audience,
    algorithms: ["ES256"]
  });
  if (typeof payload.pairwise_sub !== "string" || !payload.pairwise_sub) {
    throw new Error("shoo id_token is missing pairwise_sub.");
  }
  return payload;
}

function getJwks(shooBaseUrl) {
  if (!jwksCaches.has(shooBaseUrl)) {
    jwksCaches.set(
      shooBaseUrl,
      createRemoteJWKSet(new URL(`${shooBaseUrl}/.well-known/jwks.json`))
    );
  }
  return jwksCaches.get(shooBaseUrl);
}

async function getIssuer(shooBaseUrl) {
  if (!issuerCaches.has(shooBaseUrl)) {
    const promise = fetch(`${shooBaseUrl}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000)
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`shoo discovery failed: ${response.status}`);
        const body = await response.json();
        if (typeof body.issuer !== "string") {
          throw new Error("shoo discovery document has no issuer.");
        }
        return body.issuer;
      })
      .catch((error) => {
        issuerCaches.delete(shooBaseUrl);
        throw error;
      });
    issuerCaches.set(shooBaseUrl, promise);
  }
  return issuerCaches.get(shooBaseUrl);
}

export function resetShooCaches() {
  jwksCaches.clear();
  issuerCaches.clear();
}
