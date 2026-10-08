import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/postplan.js", import.meta.url));

// Run the real executable with isolated state and an HTTP API on loopback.
async function fixture(t, respond) {
  const home = await mkdtemp(path.join(os.tmpdir(), "postplan-cli-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const result = respond(request, body ? JSON.parse(body) : null);
    response.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, POSTPLAN_API_URL: apiUrl };
  delete env.POSTPLAN_API_KEY;
  return {
    home,
    apiUrl,
    run: (...args) => exec(process.execPath, [cli, ...args], { cwd: home, env })
  };
}

test("uploads exact HTML and reuses the saved draft unless --new is supplied", async (t) => {
  const uploads = [];
  const { home, apiUrl, run } = await fixture(t, (request, body) => {
    assert.equal(request.url, "/api/uploads");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, undefined);
    uploads.push(body);
    return {
      status: body.draftId ? 200 : 201,
      body: {
        draftId: "draft-one",
        versionNumber: uploads.length,
        publicUrl: `${apiUrl}/d/draft-one`,
        rawUrl: `${apiUrl}/d/draft-one/raw`
      }
    };
  });
  const html = "<!doctype html><title>Plan</title><h1>Hello</h1>\n";
  await writeFile(path.join(home, "plan.html"), html);
  const first = JSON.parse((await run("upload", "plan.html", "--json")).stdout);
  assert.equal(first.ok, true);
  assert.equal(first.action, "created");
  assert.equal(first.url, `${apiUrl}/d/draft-one`);
  assert.equal(uploads[0].html, html);
  assert.equal(uploads[0].filename, "plan.html");
  assert.equal(uploads[0].metadata.cliVersion, "0.0.5");
  assert.equal(uploads[0].draftId, null);
  assert.equal(JSON.parse((await run("upload", "plan.html", "--json")).stdout).action, "updated");
  assert.equal(uploads[1].draftId, "draft-one");
  await run("upload", "plan.html", "--new", "--json");
  assert.equal(uploads[2].draftId, null);
  const bindings = await readdir(path.join(home, ".postplan", "drafts"));
  assert.equal(bindings.length, 1);
});

test("saves credentials and uses them for authenticated draft listing", async (t) => {
  const { home, apiUrl, run } = await fixture(t, (request) => {
    assert.equal(request.url, "/api/drafts");
    assert.equal(request.headers.authorization, "Bearer test-key");
    return { body: { drafts: [{ id: "owned-draft", title: "My plan" }] } };
  });
  await run("auth", "set", "test-key", "--api-url", apiUrl);
  const credentials = JSON.parse(await readFile(path.join(home, ".postplan", "credentials.json"), "utf8"));
  assert.equal(credentials.apiKey, "test-key");
  assert.deepEqual(JSON.parse((await run("list", "--json")).stdout), [{ id: "owned-draft", title: "My plan" }]);
});

test("reports a rejected upload without saving a draft mapping", async (t) => {
  const { home, run } = await fixture(t, () => ({
    status: 400,
    body: { error: "Invalid HTML", errors: ["Forms are not allowed"] }
  }));
  await writeFile(path.join(home, "bad.html"), "<form></form>");
  await assert.rejects(run("upload", "bad.html", "--json"), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.status, 400);
    assert.deepEqual(report.errors, ["Forms are not allowed"]);
    return true;
  });
  await assert.rejects(readdir(path.join(home, ".postplan", "drafts")), { code: "ENOENT" });
});
