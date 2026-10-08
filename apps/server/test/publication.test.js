import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api.js";
import { sha256 } from "../src/crypto.js";

const auth = { Authorization: "Bearer test-bootstrap-key" };
const INDEX = '<!doctype html><title>Index</title><a href="guide/setup.html">Guide</a>';
const GUIDE = '<!doctype html><title>Guide</title><a href="../index.html">Home</a>';
const files = [{ path: "index.html", html: INDEX }, { path: "guide/setup.html", html: GUIDE }];

async function post(route, body, headers = auth) {
  const response = await SELF.fetch(`https://postplan.test${route}`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

describe("publication contracts", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM upload_events"),
      env.DB.prepare("DELETE FROM draft_version_pages"),
      env.DB.prepare("DELETE FROM draft_versions"),
      env.DB.prepare("DELETE FROM drafts"),
      env.DB.prepare("DELETE FROM rate_limits")
    ]);
    const objects = await env.DRAFTS.list();
    if (objects.objects.length) await env.DRAFTS.delete(objects.objects.map(object => object.key));
  });
  it("publishes exact pages, full receipts, and stable historical page routes", async () => {
    const first = await post("/api/uploads", { files, filename: "site" });
    expect(first.response.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, unchanged: false, versionNumber: 1,
      account: { name: "Bootstrap Account" }, totalBytes: new TextEncoder().encode(INDEX + GUIDE).byteLength });
    expect(first.body.pages.map(page => page.path)).toEqual(["index.html", "guide/setup.html"]);
    expect(first.body.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.body.publicUrl).toBe(`https://postplan.test/d/${first.body.draftId}/`);
    for (const route of [first.body.publicUrl, first.body.rawUrl]) {
      expect(await (await SELF.fetch(route)).text()).toBe(INDEX);
    }
    expect(await (await SELF.fetch(new URL("guide/setup.html", first.body.publicUrl))).text()).toBe(GUIDE);
    expect(await (await SELF.fetch(`${first.body.rawUrl}/guide/setup.html`)).text()).toBe(GUIDE);
    const redirect = await SELF.fetch(first.body.publicUrl.slice(0, -1), { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`/d/${first.body.draftId}/`);
    const updated = await post("/api/uploads", { draftId: first.body.draftId,
      files: [files[0], { ...files[1], html: '<title>New guide</title>' }] });
    expect(updated.body.versionNumber).toBe(2);
    expect(await (await SELF.fetch(new URL("guide/setup.html", first.body.versionUrl))).text()).toBe(GUIDE);
    expect(await (await SELF.fetch(new URL("guide/setup.html", updated.body.publicUrl))).text()).toBe('<title>New guide</title>');
    expect((await SELF.fetch(new URL("missing.html", first.body.publicUrl))).status).toBe(404);
    const list = await SELF.fetch("https://postplan.test/api/drafts", { headers: auth });
    expect((await list.json()).drafts[0]).toMatchObject({ pageCount: 2, latestVersionNumber: 2 });
  });

  it("deduplicates repeated content and applies audited metadata changes", async () => {
    const first = await post("/api/uploads", { html: INDEX, description: "before" });
    const before = await env.DRAFTS.list();
    const second = await post("/api/uploads", { html: INDEX, draftId: first.body.draftId,
      description: "after", slug: "my-plan" });
    expect(second.body).toMatchObject({ created: false, unchanged: true, versionNumber: 1, slug: "my-plan" });
    expect((await env.DRAFTS.list()).objects.length).toBe(before.objects.length);
    expect(await env.DB.prepare("SELECT description, slug, version_seq FROM drafts WHERE id = ?")
      .bind(first.body.draftId).first()).toMatchObject({ description: "after", slug: "my-plan", version_seq: 1 });
    expect(await env.DB.prepare("SELECT event_type FROM upload_events WHERE draft_id = ? AND event_type = 'draft.metadata-updated'")
      .bind(first.body.draftId).first()).not.toBeNull();
  });

  it("deduplicates simultaneous identical updates to an existing draft", async () => {
    const first = await post("/api/uploads", { html: INDEX });
    const updates = await Promise.all(Array.from({ length: 4 }, () =>
      post("/api/uploads", { draftId: first.body.draftId, html: GUIDE })));
    expect(updates.every(upload => upload.response.status === 200)).toBe(true);
    expect(updates.every(upload => upload.body.versionNumber === 2)).toBe(true);
    expect(updates.filter(upload => !upload.body.unchanged)).toHaveLength(1);
    expect((await env.DRAFTS.list()).objects).toHaveLength(2);
  });

  it("claims slugs concurrently, reuses owned slugs, and frees a renamed or deleted slug", async () => {
    const uploads = await Promise.all(Array.from({ length: 3 }, () => post("/api/uploads", { html: INDEX, slug: "shared-plan" })));
    expect(uploads.map(upload => upload.response.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(uploads.map(upload => upload.body.draftId)).size).toBe(1);
    const first = uploads.find(upload => upload.body.created).body;
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM draft_versions WHERE draft_id = ?")
      .bind(first.draftId).first()).toMatchObject({ count: 1 });
    expect((await env.DRAFTS.list()).objects.length).toBe(1);
    const alias = await SELF.fetch(first.publicUrl, { redirect: "manual" });
    expect(alias.headers.get("location")).toBe(`/d/${first.draftId}/`);
    const rename = await post("/api/uploads", { draftId: first.draftId, html: INDEX, slug: "renamed-plan" });
    expect(rename.body.unchanged).toBe(true);
    expect((await SELF.fetch(first.publicUrl)).status).toBe(404);
    const replacement = await post("/api/uploads", { html: INDEX, slug: "shared-plan" });
    expect(replacement.body.created).toBe(true);
    await SELF.fetch(`https://postplan.test/api/drafts/${replacement.body.draftId}`, { method: "DELETE", headers: auth });
    expect((await post("/api/uploads", { html: INDEX, slug: "shared-plan" })).body.created).toBe(true);
  });

  it("enforces slug ownership and reserves disabled slugs", async () => {
    const first = await post("/api/uploads", { html: INDEX, slug: "private-owner" });
    await env.DB.prepare("INSERT INTO accounts (id, name, created_at, updated_at) VALUES ('other', 'Other', '', '')").run();
    await env.DB.prepare("INSERT INTO api_keys (id, account_id, name, key_hash, created_at) VALUES ('other-key', 'other', 'Other', ?, '')")
      .bind(await sha256("other-token")).run();
    const otherAuth = { Authorization: "Bearer other-token" };
    expect((await post("/api/uploads", { html: INDEX, slug: "private-owner" }, otherAuth)).response.status).toBe(409);
    expect((await post("/api/uploads", { html: INDEX, draftId: first.body.draftId }, otherAuth)).response.status).toBe(404);
    const check = await post("/api/check", { slug: "private-owner" }, otherAuth);
    expect(check.body).toMatchObject({ ok: false, slug: { status: "taken" } });
    await post(`/api/drafts/${first.body.draftId}/disable`, {});
    expect((await SELF.fetch(first.body.publicUrl)).status).toBe(404);
    expect((await post("/api/uploads", { html: INDEX, slug: "private-owner" })).response.status).toBe(409);
  });

  it("checks readiness and exact limits without publishing or consuming upload quotas", async () => {
    const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM drafts").first();
    const ready = await post("/api/check", {});
    expect(ready.body).toMatchObject({ ok: true, flags: [], account: { name: "Bootstrap Account" },
      limits: { maxBytes: 524288, maxPages: 20 }, capabilities: { inlineScripts: true, customUrls: true } });
    const checked = await post("/api/check", { files, slug: "available-plan" });
    expect(checked.body).toMatchObject({ ok: true, slug: { status: "available" } });
    expect(checked.body.pages).toHaveLength(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM drafts").first()).toEqual(before);
    expect((await env.DRAFTS.list()).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT bucket_key FROM rate_limits WHERE bucket_key LIKE 'upload-%'").first()).toBeNull();
    expect((await post("/api/check", { html: "<form></form>" })).body).toMatchObject({ ok: false });
    expect((await post("/api/check", { slug: "Bad_Slug" })).body).toMatchObject({ ok: false, slug: { status: "invalid" } });
    const limited = await createApp().fetch(new Request("https://postplan.test/api/check", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ files })
    }), { ...env, MAX_HTML_BYTES: "20", MAX_UPLOAD_PAGES: "1" });
    expect((await limited.json()).issues).toContainEqual(expect.objectContaining({ code: "too-many-pages" }));
  });

  it("rejects unauthenticated checks, invalid paths, and ambiguous bodies before writing", async () => {
    expect((await post("/api/check", {}, {})).response.status).toBe(401);
    expect((await post("/api/check", {}, { Authorization: "Bearer invalid" })).response.status).toBe(401);
    expect((await post("/api/uploads", { html: INDEX, files })).response.status).toBe(400);
    expect((await post("/api/check", { files: null })).response.status).toBe(400);
    for (const path of ["../escape.html", "%2e%2e/x.html", "/absolute.html", "raw/a.html", "v/a.html"]) {
      expect((await post("/api/uploads", { files: [files[0], { path, html: GUIDE }] })).response.status).toBe(422);
    }
    expect((await env.DRAFTS.list()).objects).toHaveLength(0);
    const malformed = await post("/api/uploads", [1]);
    expect(malformed.response.status).toBe(400);
  });

  it("bounds chunked bodies and rate-limits checks separately from uploads", async () => {
    const app = createApp();
    const request = () => new Request("https://postplan.test/api/check", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}"
    });
    const bindings = { ...env, CHECK_RATE_LIMIT_MAX: "1" };
    expect((await app.fetch(request(), bindings)).status).toBe(200);
    const limited = await app.fetch(request(), bindings);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post("/api/uploads", { html: INDEX })).response.status).toBe(201);
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"html":"'));
      controller.enqueue(new TextEncoder().encode("x".repeat(50)));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    } });
    const oversized = await app.fetch(new Request("https://postplan.test/api/uploads", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body
    }), { ...env, UPLOAD_BODY_LIMIT: "20b" });
    expect(oversized.status).toBe(413);
  });

  it("grants scripts only to new versions and preserves inert JSON and old permissions", async () => {
    const html = '<title>Interactive</title><script>document.title="Works";</script>';
    const first = await post("/api/uploads", { html });
    const csp = (await SELF.fetch(first.body.publicUrl)).headers.get("content-security-policy");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("script-src-attr 'none'");
    expect((await SELF.fetch(first.body.rawUrl)).headers.get("content-security-policy")).toBe(csp);
    await env.DB.prepare("UPDATE draft_versions SET scripts_allowed = 0 WHERE id = ?").bind(first.body.versionId).run();
    const reuploaded = await post("/api/uploads", { html, draftId: first.body.draftId });
    expect(reuploaded.body).toMatchObject({ versionNumber: 2, unchanged: false });
    expect((await SELF.fetch(first.body.versionUrl)).headers.get("content-security-policy")).toContain("script-src 'none'");
    const data = await post("/api/uploads", { html: '<title>Data</title><script type="application/json">{}</script>' });
    expect(data.response.status).toBe(201);
    expect(data.body.pages[0].hasScripts).toBe(false);
    expect((await SELF.fetch(data.body.publicUrl)).headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("cleans up partially written folders and failed manifest transactions", async () => {
    const app = createApp();
    let calls = 0;
    const bucket = {
      put: async (...args) => { if (++calls === 2) throw new Error("Test R2 write failure"); return env.DRAFTS.put(...args); },
      delete: (...args) => env.DRAFTS.delete(...args)
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.fetch(new Request("https://postplan.test/api/uploads", {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ files })
      }), { ...env, DRAFTS: bucket });
      expect(response.status).toBe(500);
      expect((await env.DRAFTS.list()).objects).toHaveLength(0);
      await env.DB.prepare(`CREATE TRIGGER fail_page BEFORE INSERT ON draft_version_pages
        WHEN NEW.path = 'guide/setup.html' BEGIN SELECT RAISE(ABORT, 'Test page failure'); END`).run();
      expect((await post("/api/uploads", { files })).response.status).toBe(500);
      expect((await env.DRAFTS.list()).objects).toHaveLength(0);
      expect(await env.DB.prepare("SELECT id FROM drafts").first()).toBeNull();
      await env.DB.prepare("DROP TRIGGER fail_page").run();
    } finally { log.mockRestore(); }
  });
});
