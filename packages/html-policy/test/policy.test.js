import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { hashUpload, validateHtml, validateUpload } from "../index.js";

const sha256 = value => createHash("sha256").update(value).digest("hex");

test("allows classic scripts and inert data while rejecting executable markup escapes", () => {
  assert.equal(validateHtml('<title>Plan</title><script>document.title = "ok";</script>').hasScripts, true);
  const data = validateHtml('<title>Data</title><script type="application/json">{"hello":1}</script>');
  assert.equal(data.ok, true);
  assert.equal(data.hasScripts, false);
  for (const html of [
    '<script type="module">import "https://example.com/x.js"</script>',
    '<p onclick="alert(1)">Click</p>',
    '<a href="java\nscript:alert(1)">Click</a>',
    '<template><iframe srcdoc="hello"></iframe></template>',
    '<base href="https://example.com">',
    '<link rel="stylesheet" href="https://example.com/style.css">'
  ]) assert.equal(validateHtml(html).ok, false, html);
});

test("requires a safe, unique index page and enforces aggregate UTF-8 limits", () => {
  const index = { path: "index.html", html: "<title>é</title>" };
  assert.equal(validateUpload([index], { maxBytes: 17 }).ok, true);
  assert.equal(validateUpload([index], { maxBytes: 16 }).ok, false);
  assert.equal(validateUpload([index, { path: "guide/setup.html", html: "hello" }], { maxPages: 1 }).ok, false);
  assert.equal(validateUpload([{ path: "other.html", html: "hello" }]).ok, false);
  assert.equal(validateUpload([index, index]).ok, false);
  for (const path of ["../escape.html", "/escape.html", "a\\b.html", "%2e%2e/x.html", "raw/a.html", "v/a.html", "raw.html"]) {
    assert.equal(validateUpload([index, { path, html: "hello" }]).ok, false, path);
  }
});

test("hashes exact single-page bytes and sorted multi-page paths", async () => {
  const index = { path: "index.html", html: "<title>Exact</title>\n" };
  const other = { path: "guide.html", html: "Guide" };
  assert.equal((await hashUpload([index], sha256)).contentHash, sha256(index.html));
  const original = await hashUpload([index, other], sha256);
  assert.equal(original.contentHash, (await hashUpload([other, index], sha256)).contentHash);
  assert.notEqual(original.contentHash, (await hashUpload([index, { ...other, path: "renamed.html" }], sha256)).contentHash);
});
