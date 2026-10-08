import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createApp } from "../src/api.js";

it("backfills surviving single-page versions without restoring public drafts or script permission", async () => {
  const migrations = JSON.parse(env.TEST_MIGRATIONS);
  await applyD1Migrations(env.LEGACY_DB, migrations.slice(0, 2));
  await env.LEGACY_DB.batch([
    env.LEGACY_DB.prepare("INSERT INTO accounts (id, name, created_at, updated_at) VALUES ('legacy', 'Legacy', '', '')"),
    env.LEGACY_DB.prepare("INSERT INTO api_keys (id, account_id, name, key_hash, created_at) VALUES ('legacy-key', 'legacy', 'Legacy', 'legacy-hash', '')"),
    env.LEGACY_DB.prepare("INSERT INTO drafts (id, account_id, title, current_version_id, version_seq, created_at, updated_at) VALUES ('old-draft', 'legacy', 'Old title', 'old-version', 1, '', '')"),
    env.LEGACY_DB.prepare(`INSERT INTO draft_versions (id, draft_id, version_number, object_key,
      content_hash, file_size, created_at, created_by_api_key_id, has_inline_script)
      VALUES ('old-version', 'old-draft', 1, 'original.html', 'exact-hash', 123, '', 'legacy-key', 1)`)
  ]);
  await applyD1Migrations(env.LEGACY_DB, migrations.slice(2));
  expect(await env.LEGACY_DB.prepare("SELECT scripts_allowed, object_key FROM draft_versions WHERE id = 'old-version'").first())
    .toEqual({ scripts_allowed: 0, object_key: "original.html" });
  expect(await env.LEGACY_DB.prepare("SELECT path, object_key, content_hash, file_size, title FROM draft_version_pages").first())
    .toEqual({ path: "index.html", object_key: "original.html", content_hash: "exact-hash", file_size: 123, title: "Old title" });
  expect(await env.LEGACY_DB.prepare("SELECT id FROM accounts WHERE id = 'acct_public_upload'").first()).toBeNull();
  const html = '<title>Old title</title><script>document.title = "must not execute";</script>\n';
  await env.DRAFTS.put("original.html", html);
  for (const suffix of ["", "/raw", "/v/1", "/v/1/raw"]) {
    const response = await createApp().fetch(new Request(`https://postplan.test/d/old-draft${suffix}`),
      { ...env, DB: env.LEGACY_DB });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(html);
    expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
  }
});
