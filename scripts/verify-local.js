import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const serverRoot = path.join(root, "apps/server");
const wrangler = path.join(serverRoot, "node_modules/wrangler/bin/wrangler.js");
const cli = process.env.POSTPLAN_TEST_CLI || path.join(root, "packages/cli/bin/postplan.js");
const port = 8897;
const apiUrl = `http://127.0.0.1:${port}`;
const temp = await mkdtemp(path.join(os.tmpdir(), "postplan-integration-"));
const configPath = path.join(temp, "wrangler.json");
const state = path.join(temp, "state");
const env = { ...process.env, HOME: temp, USERPROFILE: temp,
  POSTPLAN_API_URL: apiUrl, POSTPLAN_API_KEY: "integration-test-key",
  WRANGLER_SEND_METRICS: "false" };
let worker;

// Check that this dedicated test port is free; never replace another preview.
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", () => probe.close(resolve));
});

async function run(...args) {
  return exec(process.execPath, [cli, ...args], { cwd: temp, env, windowsHide: true });
}

try {
  const config = JSON.parse(await readFile(path.join(serverRoot, "wrangler.jsonc"), "utf8"));
  config.main = path.join(serverRoot, "src/worker.js");
  config.assets.directory = path.join(serverRoot, "public");
  config.d1_databases[0].migrations_dir = path.join(serverRoot, "migrations");
  config.vars = { POSTPLAN_BOOTSTRAP_API_KEY: env.POSTPLAN_API_KEY, POSTPLAN_PUBLIC_BASE_URL: apiUrl };
  config.name = "postplan-integration-test";
  await writeFile(configPath, JSON.stringify(config));
  await exec(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local",
    "--config", configPath, "--persist-to", state], { cwd: temp, env, windowsHide: true });
  worker = spawn(process.execPath, [wrangler, "dev", "--local", "--config", configPath,
    "--persist-to", state, "--port", String(port), "--inspector-port", "0", "--log-level", "warn"],
    { cwd: temp, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  worker.stdout.on("data", data => { logs = (logs + data).slice(-10000); });
  worker.stderr.on("data", data => { logs = (logs + data).slice(-10000); });
  const deadline = Date.now() + 30000;
  while (true) {
    try {
      if ((await fetch(`${apiUrl}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) break;
    } catch { /* The disposable Worker is still starting. */ }
    if (worker.exitCode !== null || Date.now() > deadline) throw new Error(`Worker did not start: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  await mkdir(path.join(temp, "site/guide"), { recursive: true });
  await writeFile(path.join(temp, "site/index.html"), '<title>Index</title><a href="guide/setup.html">Guide</a>');
  await writeFile(path.join(temp, "site/guide/setup.html"), '<title>Guide</title><a href="../index.html">Home</a>');
  const ready = JSON.parse((await run("check", "site", "--slug", "integration-plan", "--json")).stdout);
  assert.equal(ready.ok, true);
  assert.equal(ready.pages.length, 2);
  const first = JSON.parse((await run("upload", "site", "--slug", "integration-plan", "--json")).stdout);
  assert.equal(first.action, "created");
  assert.equal(first.account, "Bootstrap Account");
  assert.equal(first.pages.length, 2);
  const response = await fetch(first.url);
  assert.equal(response.url, `${apiUrl}/d/${first.draftId}/`);
  assert.match(await (await fetch(new URL("guide/setup.html", response.url))).text(), /<title>Guide<\/title>/);
  const unchanged = JSON.parse((await run("upload", "site", "--slug", "integration-plan", "--json")).stdout);
  assert.equal(unchanged.action, "unchanged");
  assert.equal(unchanged.versionNumber, 1);
  await writeFile(path.join(temp, "site/guide/setup.html"), "<title>Updated guide</title>");
  const updated = JSON.parse((await run("upload", "site", "--draft", first.draftId, "--json")).stdout);
  assert.equal(updated.action, "updated");
  assert.equal(updated.versionNumber, 2);
  assert.match(await (await fetch(new URL("guide/setup.html", first.versionUrl))).text(), /<title>Guide<\/title>/);
  assert.equal(JSON.parse((await run("list", "--json")).stdout)[0].slug, "integration-plan");

  // A real uploaded draft reports browser sandbox behavior in its own document.
  const sandboxHtml = `<!doctype html><title>Sandbox verification</title><pre id="result">waiting</pre>
    <script>
    (async () => {
      const result = { scriptExecuted: true, origin: window.origin };
      const blocked = (name, action) => { try { action(); result[name] = false; } catch { result[name] = true; } };
      blocked("storageBlocked", () => localStorage.setItem("probe", "1"));
      blocked("cookieBlocked", () => document.cookie);
      blocked("workerBlocked", () => new Worker("/worker.js"));
      result.popupBlocked = window.open("about:blank") === null;
      try { await fetch("/healthz"); result.fetchBlocked = false; } catch { result.fetchBlocked = true; }
      document.getElementById("result").textContent = JSON.stringify(result);
    })();
    </script>`;
  await writeFile(path.join(temp, "sandbox.html"), sandboxHtml);
  const sandbox = JSON.parse((await run("upload", "sandbox.html", "--json")).stdout);
  console.log("Local CLI/Worker integration passed: folder, check, slug, unchanged, update, history, list.");
  console.log(`Sandbox verification URL: ${sandbox.url}`);
  console.log(`Sandbox raw URL: ${sandbox.rawUrl}`);
  if (process.argv.includes("--keep-alive")) {
    console.log("Disposable Worker remains available for browser verification on port 8897.");
    await new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  }
} finally {
  worker?.kill();
  // Only remove the exact directory created for this disposable verification.
  if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith("postplan-integration-")) {
    throw new Error("Unexpected integration test directory");
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
