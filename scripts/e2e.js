import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const base = (process.env.POSTPLAN_API_URL || "https://postplan.martinvana.com").replace(/\/+$/, "");
const apiKey = process.env.POSTPLAN_API_KEY;
const webAuthEnabled = process.env.POSTPLAN_WEB_AUTH_ENABLED?.trim().toLowerCase() === "true";
assert.ok(apiKey, "Set POSTPLAN_API_KEY in .env or your shell before running pnpm test:e2e.");

async function request(path, { method = "GET", body, authenticated = true, key = apiKey, status = 200 } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(authenticated ? { Authorization: `Bearer ${key}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(15000)
  });
  assert.equal(response.status, status, `${method} ${path}`);
  return response;
}

test(`public and web endpoints against ${base}`, async () => {
  const anonymous = { authenticated: false };
  const home = await request("/", anonymous);
  assert.match(home.headers.get("content-type"), /text\/html/);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Postplan/i);
  assert.equal(homeHtml.includes('href="/dashboard"'), webAuthEnabled);
  assert.equal((await (await request("/healthz", anonymous)).json()).ok, true);
  assert.ok((await (await request("/favicon.ico", anonymous)).arrayBuffer()).byteLength);

  if (!webAuthEnabled) {
    for (const [method, path] of [
      ["GET", "/auth/sign-in"],
      ["GET", "/auth/callback"],
      ["POST", "/auth/sign-out"],
      ["GET", "/dashboard"],
      ["GET", "/dashboard/drafts/e2e-missing"],
      ["GET", "/settings/api-keys"],
      ["POST", "/settings/api-keys"],
      ["POST", "/settings/api-keys/e2e-missing/revoke"],
      ["GET", "/cli/auth"]
    ]) {
      await request(path, { ...anonymous, method, status: 404 });
    }
    return;
  }

  // Check the session guards without logging in or changing browser-owned keys.
  for (const [method, path] of [
    ["GET", "/dashboard"],
    ["GET", "/dashboard/drafts/e2e-missing"],
    ["GET", "/settings/api-keys"],
    ["POST", "/settings/api-keys"],
    ["POST", "/settings/api-keys/e2e-missing/revoke"]
  ]) {
    const response = await request(path, { ...anonymous, method });
    assert.match(await response.text(), /Continue with shoo/, `${method} ${path}`);
  }
  const cliAuth = await request("/cli/auth", { ...anonymous, status: 302 });
  assert.equal(cliAuth.headers.get("location"), "/settings/api-keys");

  const signIn = await request("/auth/sign-in", { ...anonymous, status: 302 });
  const authorize = new URL(signIn.headers.get("location"));
  assert.equal(authorize.pathname, "/authorize");
  assert.equal(authorize.searchParams.get("redirect_uri"), `${base}/auth/callback`);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorize.searchParams.get("state"));
  assert.ok(signIn.headers.get("set-cookie"));
  await request("/auth/callback", { ...anonymous, status: 400 });
  const signOut = await request("/auth/sign-out", { ...anonymous, method: "POST", status: 302 });
  assert.equal(signOut.headers.get("location"), "/");
  assert.match(signOut.headers.get("set-cookie"), /Max-Age=0/i);
});

test("API key creation, account info, and revocation", async () => {
  const me = await (await request("/api/me")).json();
  assert.ok(me.accountId);
  let keyId;
  try {
    const created = await (await request("/api/api-keys", {
      method: "POST", body: { name: `E2E ${randomUUID()}` }, status: 201
    })).json();
    keyId = created.apiKey.id;
    assert.ok(keyId);
    const response = await request("/api/me", { key: created.token });
    assert.equal((await response.json()).accountId, me.accountId);
    await request(`/api/api-keys/${keyId}/revoke`, { method: "POST" });
    keyId = undefined;
    await request("/api/me", { key: created.token, status: 401 });
  } finally {
    if (keyId) await request(`/api/api-keys/${keyId}/revoke`, { method: "POST" });
  }
});

test("draft publication, serving routes, listing, disabling, and deletion", async () => {
  const original = `<!doctype html><title>E2E ${randomUUID()}</title><h1>Version 1</h1>`;
  const updated = original.replace("Version 1", "Version 2");
  const guide = "<!doctype html><title>E2E guide</title><script>console.log('smoke');</script>";
  const slug = `e2e-${randomUUID()}`;
  const files = [
    { path: "index.html", html: original },
    { path: "guide/setup.html", html: guide }
  ];
  let draftId;

  await request("/api/uploads", {
    method: "POST", body: { html: original }, authenticated: false, status: 401
  });
  const check = await (await request("/api/check", {
    method: "POST", body: { files, slug }
  })).json();
  assert.equal(check.ok, true);

  try {
    const first = await (await request("/api/uploads", {
      method: "POST", body: { files, slug }, status: 201
    })).json();
    draftId = first.draftId;
    assert.ok(draftId);
    assert.equal(first.created, true);
    assert.equal(first.versionNumber, 1);
    const draftPath = `/d/${draftId}`;
    for (const path of [`/s/${slug}`, `/s/${slug}/`, `/s/${slug}/guide/setup.html`, draftPath]) {
      const redirect = await request(path, { authenticated: false, status: 302 });
      const suffix = path.endsWith("setup.html") ? "guide/setup.html" : "";
      assert.equal(redirect.headers.get("location"), `${draftPath}/${suffix}`);
    }
    for (const suffix of ["/", "/raw", "/v/1/", "/v/1/raw"]) {
      assert.equal(await (await request(`${draftPath}${suffix}`, { authenticated: false })).text(), original);
    }
    for (const prefix of ["", "/raw", "/v/1", "/v/1/raw"]) {
      const page = await request(`${draftPath}${prefix}/guide/setup.html`, { authenticated: false });
      assert.equal(await page.text(), guide);
      assert.match(page.headers.get("content-security-policy"), /sandbox allow-scripts/);
    }
    const listed = await (await request("/api/drafts")).json();
    assert.ok(listed.drafts.some(draft => draft.draftId === draftId && draft.slug === slug));

    const unchanged = await (await request("/api/uploads", {
      method: "POST", body: { files, draftId }
    })).json();
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.versionId, first.versionId);

    const second = await (await request("/api/uploads", {
      method: "POST", body: { files: [{ path: "index.html", html: updated }, files[1]], draftId }
    })).json();
    assert.equal(second.draftId, draftId);
    assert.equal(second.versionNumber, 2);
    assert.notEqual(second.versionId, first.versionId);
    assert.equal(await (await request(`${draftPath}/`, { authenticated: false })).text(), updated);
    assert.equal(await (await request(first.versionUrl, { authenticated: false })).text(), original);
    await request(`/api/drafts/${draftId}/disable`, { method: "POST", body: { reason: "E2E smoke test" } });
    await request(`${draftPath}/`, { authenticated: false, status: 404 });
    await request(`/s/${slug}/`, { authenticated: false, status: 404 });
  } finally {
    if (draftId) {
      await request(`/api/drafts/${draftId}`, { method: "DELETE" });
      await request(`/d/${draftId}`, { authenticated: false, status: 404 });
    }
  }
});
