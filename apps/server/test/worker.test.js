import { SELF, env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetShooCaches } from "../src/shoo.js";
import { consumeRateLimit, deleteExpiredRateLimits } from "../src/rate-limit.js";

const HTML = "<!doctype html><html><head><title>First draft</title></head><body>exact bytes</body></html>";

describe("Postplan Worker", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports D1 health and serves the home page", async () => {
    const health = await SELF.fetch("https://postplan.test/healthz");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true });

    const home = await SELF.fetch("https://postplan.test/");
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("Postplan");
    expect(homeHtml).toContain('<link rel="icon" href="/favicon.ico">');

    const favicon = await SELF.fetch("https://postplan.test/favicon.ico");
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get("content-type")).toMatch(/^image\//);
    expect((await favicon.arrayBuffer()).byteLength).toBe(778);
  });

  it("uploads and serves exact HTML through path-style URLs", async () => {
    const upload = await uploadDraft({ html: HTML, filename: "first.html" });
    expect(upload.response.status).toBe(201);
    expect(upload.body.publicUrl).toBe(`https://postplan.test/d/${upload.body.draftId}`);
    expect(upload.body.rawUrl).toBe(`${upload.body.publicUrl}/raw`);

    const served = await SELF.fetch(upload.body.rawUrl);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(HTML);
    expect(served.headers.get("x-postplan-draft-id")).toBe(upload.body.draftId);
    expect(served.headers.get("x-postplan-draft-version")).toBe("1");
    expect(served.headers.get("content-security-policy")).toContain("script-src 'none'");

    const removedAlias = await SELF.fetch("https://postplan.test/raw");
    expect(removedAlias.status).toBe(404);
  });

  it.each(["", "Bearer invalid-key"])("requires a valid API key for uploads (%j)", async (authorization) => {
    const draftsBefore = await env.DB.prepare("SELECT COUNT(*) AS count FROM drafts").first();
    const objectsBefore = await env.DRAFTS.list();
    const upload = await uploadDraft({ html: HTML, filename: "private.html" }, {
      Authorization: authorization
    });
    expect(upload.response.status).toBe(401);
    expect(upload.body).toEqual({ ok: false, error: "Missing or invalid API key." });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM drafts").first()).toEqual(draftsBefore);
    expect((await env.DRAFTS.list()).objects).toEqual(objectsBefore.objects);
  });

  it("allocates unique versions for concurrent updates", async () => {
    const first = await uploadDraft({ html: HTML, filename: "concurrent.html" });
    const updates = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        uploadDraft({
          html: `<!doctype html><title>Version ${index + 2}</title><p>${index}</p>`,
          filename: "concurrent.html",
          draftId: first.body.draftId
        })
      )
    );

    expect(updates.map(({ response }) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(updates.map(({ body }) => body.versionNumber).sort((a, b) => a - b)).toEqual([
      2, 3, 4, 5, 6
    ]);

    const current = await SELF.fetch(`https://postplan.test/d/${first.body.draftId}`);
    expect(current.headers.get("x-postplan-draft-version")).toBe("6");
    const historical = await SELF.fetch(`https://postplan.test/d/${first.body.draftId}/v/1/raw`);
    expect(await historical.text()).toBe(HTML);
  });

  it("supports bootstrap auth and API-key revocation", async () => {
    const bootstrapHeaders = { Authorization: "Bearer test-bootstrap-key" };
    const me = await SELF.fetch("https://postplan.test/api/me", { headers: bootstrapHeaders });
    expect(me.status).toBe(200);
    expect((await me.json()).apiKeyId).toBe("key_bootstrap");

    const created = await SELF.fetch("https://postplan.test/api/api-keys", {
      method: "POST",
      headers: { ...bootstrapHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test key" })
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const keyHeaders = { Authorization: `Bearer ${createdBody.token}` };
    expect((await SELF.fetch("https://postplan.test/api/me", { headers: keyHeaders })).status).toBe(200);

    const revoked = await SELF.fetch(
      `https://postplan.test/api/api-keys/${createdBody.apiKey.id}/revoke`,
      { method: "POST", headers: bootstrapHeaders }
    );
    expect(revoked.status).toBe(200);
    expect((await SELF.fetch("https://postplan.test/api/me", { headers: keyHeaders })).status).toBe(401);
  });

  it("lists, disables, and deletes owned drafts", async () => {
    const headers = { Authorization: "Bearer test-bootstrap-key" };
    const uploaded = await uploadDraft(
      { html: HTML, filename: "owned.html", description: "Owned draft" },
      headers
    );

    const list = await SELF.fetch("https://postplan.test/api/drafts", { headers });
    const listBody = await list.json();
    expect(listBody.drafts.find((draft) => draft.draftId === uploaded.body.draftId)).toMatchObject({
      draftId: uploaded.body.draftId,
      description: "Owned draft",
      latestVersionNumber: 1,
      versionCount: 1
    });

    const disabled = await SELF.fetch(
      `https://postplan.test/api/drafts/${uploaded.body.draftId}/disable`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "done" })
      }
    );
    expect(disabled.status).toBe(200);
    expect((await SELF.fetch(uploaded.body.publicUrl)).status).toBe(404);

    const deleted = await SELF.fetch(`https://postplan.test/api/drafts/${uploaded.body.draftId}`, {
      method: "DELETE",
      headers
    });
    expect(deleted.status).toBe(200);
    const afterDelete = await SELF.fetch("https://postplan.test/api/drafts", { headers });
    expect((await afterDelete.json()).drafts.map((draft) => draft.draftId)).not.toContain(uploaded.body.draftId);
  });

  it("rejects invalid HTML and malformed JSON", async () => {
    const invalidHtml = await uploadDraft({
      html: "<!doctype html><script src='https://example.com/x.js'></script>",
      filename: "bad.html"
    });
    expect(invalidHtml.response.status).toBe(422);
    expect(invalidHtml.body.errors).toContain("External script sources are not allowed.");

    const invalidJson = await SELF.fetch("https://postplan.test/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-bootstrap-key" },
      body: "{"
    });
    expect(invalidJson.status).toBe(400);
  });

  it("enforces and cleans exact D1 rate-limit buckets", async () => {
    const options = {
      keyPrefix: "test-limit",
      identity: "one-user",
      windowMs: 1_000,
      max: 2,
      now: 10_000
    };
    expect((await consumeRateLimit(env.DB, options)).allowed).toBe(true);
    expect((await consumeRateLimit(env.DB, options)).allowed).toBe(true);
    const denied = await consumeRateLimit(env.DB, options);
    expect(denied).toEqual({ allowed: false, retryAfter: 1 });

    await deleteExpiredRateLimits(env.DB, 11_001);
    const row = await env.DB.prepare(
      "SELECT bucket_key FROM rate_limits WHERE bucket_key = 'test-limit:one-user'"
    ).first();
    expect(row).toBeNull();
  });

  it("removes an R2 object when the D1 write rolls back", async () => {
    const existingObjects = await env.DRAFTS.list();
    if (existingObjects.objects.length) {
      await env.DRAFTS.delete(existingObjects.objects.map((object) => object.key));
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM upload_events"),
      env.DB.prepare("DELETE FROM draft_versions"),
      env.DB.prepare("DELETE FROM drafts"),
      env.DB.prepare(`CREATE TRIGGER reject_test_draft BEFORE INSERT ON drafts
        BEGIN SELECT RAISE(ABORT, 'Test write failure'); END`)
    ]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await uploadDraft({ html: HTML, filename: "orphan.html" });
    expect(failed.response.status).toBe(500);
    expect((await env.DRAFTS.list()).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT id FROM drafts").first()).toBeNull();
    expect(errorLog).toHaveBeenCalled();
    await env.DB.prepare("DROP TRIGGER reject_test_draft").run();
    errorLog.mockRestore();
  });

  it("renders browser sign-in when no session is present", async () => {
    const dashboard = await SELF.fetch("https://postplan.test/dashboard");
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain("Continue with shoo");
    expect(dashboardHtml).toContain('<link rel="icon" href="/favicon.ico">');

    const apiKeys = await SELF.fetch("https://postplan.test/settings/api-keys");
    expect(apiKeys.status).toBe(200);
    expect(await apiKeys.text()).toContain("Continue with shoo");

    const clientAuth = await SELF.fetch("https://postplan.test/cli/auth", {
      redirect: "manual"
    });
    expect(clientAuth.status).toBe(302);
    expect(clientAuth.headers.get("location")).toBe("/settings/api-keys");
  });

  it("completes Shoo sign-in and creates a dashboard session", async () => {
    resetShooCaches();
    const signIn = await SELF.fetch("https://postplan.test/auth/sign-in?next=/dashboard", {
      redirect: "manual"
    });
    expect(signIn.status).toBe(302);
    const authorizeUrl = new URL(signIn.headers.get("location"));
    expect(authorizeUrl.origin).toBe("https://shoo.test");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorizeUrl.searchParams.get("state");
    const authCookie = cookiePair(signIn.headers.get("set-cookie"), "postplan_auth_state");

    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const idToken = await new SignJWT({
      pairwise_sub: "pairwise_test_user",
      email: "person@example.com",
      email_verified: true,
      name: "Test Person"
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer("https://shoo.test")
      .setAudience("origin:https://postplan.test")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

    vi.stubGlobal("fetch", async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/token") return Response.json({ id_token: idToken });
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({ issuer: "https://shoo.test" });
      }
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({
          keys: [{ ...publicJwk, kid: "test-key", use: "sig", alg: "ES256" }]
        });
      }
      return new Response("Not found", { status: 404 });
    });

    const callback = await SELF.fetch(
      `https://postplan.test/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: authCookie }, redirect: "manual" }
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/dashboard");
    const sessionCookie = cookiePair(callback.headers.get("set-cookie"), "postplan_session");

    const dashboard = await SELF.fetch("https://postplan.test/dashboard", {
      headers: { Cookie: sessionCookie }
    });
    expect(dashboard.status).toBe(200);
    const html = await dashboard.text();
    expect(html).toContain("person@example.com");
    expect(html).toContain("My drafts");
  });
});

async function uploadDraft(payload, extraHeaders = {}) {
  const response = await SELF.fetch("https://postplan.test/api/uploads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.20",
      Authorization: "Bearer test-bootstrap-key",
      ...extraHeaders
    },
    body: JSON.stringify(payload)
  });
  return { response, body: await response.json() };
}

function cookiePair(header, name) {
  const match = String(header || "").match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  if (!match) throw new Error(`Missing ${name} cookie.`);
  return `${name}=${match[1]}`;
}
