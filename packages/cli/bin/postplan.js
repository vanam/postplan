#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { formatBytes, formatIssue, validateUpload } from "../src/html-policy.js";

// Keep the executable and publication metadata aligned with the package version.
const { version: VERSION } = createRequire(import.meta.url)("../package.json");
const DEFAULT_API_URL = "https://postplan.martinvana.com";
const POSTPLAN_DIR = path.join(os.homedir(), ".postplan");
const CONFIG_PATH = path.join(POSTPLAN_DIR, "config.json");
const CREDENTIALS_PATH = path.join(POSTPLAN_DIR, "credentials.json");
// Draft mappings from older CLIs. Read only; new mappings go to DRAFT_BINDINGS_DIR.
const DRAFTS_PATH = path.join(POSTPLAN_DIR, "drafts.json");
const DRAFT_BINDINGS_DIR = path.join(POSTPLAN_DIR, "drafts");

class CliError extends Error {}
// Postplan could not be reached at all: DNS, TLS, timeouts, refused sockets.
class NetworkError extends CliError {}

const program = new Command();

program
  .name("postplan")
  .description("Upload static HTML drafts to Postplan.")
  .version(VERSION);

const authCommand = program.command("auth").description("Manage CLI authentication.");

authCommand
  .command("set")
  .argument("<api-key>", "Postplan API key")
  .option("--api-url <url>", "Override the default Postplan API base URL")
  .action((apiKey, options) => {
    saveCredentials(apiKey, options.apiUrl);
    console.log("Postplan credentials saved.");
  });

authCommand
  .command("login")
  .description("Log in by pasting an API key from the browser. Works over SSH.")
  .option("--api-url <url>", "Override the default Postplan API base URL")
  .action(async (options) => {
    const { apiUrl } = readAuth(options.apiUrl, { requireApiKey: false });

    console.log("Open this in your browser (any device):\n");
    console.log(`  ${apiUrl}/cli/auth\n`);
    console.log("Sign in, generate a key, then paste it below.\n");

    const readline = await import("node:readline/promises");
    const { once } = await import("node:events");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let apiKey;
    try {
      // rl.question never resolves if stdin closes (EOF/ctrl-d) — race the
      // close event so that path hits the "No key entered" error below
      // instead of exiting 0 silently.
      apiKey = (
        await Promise.race([
          rl.question("Paste your API key: "),
          once(rl, "close").then(() => "")
        ])
      ).trim();
    } finally {
      rl.close();
    }

    if (!apiKey) {
      throw new CliError("No key entered. Nothing saved.");
    }

    const { ok, body } = await requestJson(`${apiUrl}/api/me`, { apiKey });
    if (!ok) {
      throw new CliError(body.error || "That key was rejected. Nothing saved.");
    }

    saveCredentials(apiKey, options.apiUrl);
    console.log(`\nLogged in as ${body.accountName} (key: ${body.apiKeyName}).`);
  });

program
  .command("whoami")
  .description("Check the configured Postplan credentials.")
  .action(async () => {
    const { apiUrl, apiKey } = readAuth();
    const { ok, body } = await requestJson(`${apiUrl}/api/me`, { apiKey });
    if (!ok) {
      throw new CliError(body.error || "Authentication failed.");
    }
    console.log(`Account: ${body.accountName} (${body.accountId})`);
    console.log(`API key: ${body.apiKeyName} (${body.apiKeyId})`);
    console.log(`Flags: ${body.flags?.length ? body.flags.join(", ") : "none"}`);
  });

program
  .command("upload")
  .argument("<path>", "HTML file, or a folder of .html pages with an index.html")
  .option("--slug <name>", "Publish at a custom URL; the same slug always updates the same draft. With --draft, renames that draft")
  .option("--draft <draft-id>", "Update a specific draft")
  .option("--new", "Always create a new draft")
  .option("--description <text>", "Set a short description for the draft")
  .option("--json", "Print the publication receipt as JSON")
  .option("--api-url <url>", "Override the default Postplan API base URL")
  .description("Upload or update an HTML draft.")
  .action(async (target, options) => {
    if (options.new && (options.draft || options.slug !== undefined)) {
      throw new CliError(
        "--new cannot be combined with --draft or --slug: those name an existing draft. Use an unused slug to create a new draft at a custom URL."
      );
    }
    const { apiUrl, apiKey } = readAuth(options.apiUrl);
    const source = readUploadSource(target);
    // A slug names the draft by itself, so the saved mapping for this path is
    // only used without one. `--draft <id> --slug <name>` renames a draft.
    const mappedDraftId =
      options.new || options.draft || options.slug !== undefined
        ? null
        : findDraftMapping(apiUrl, source.resolved)?.draftId || null;
    const draftId = options.draft || mappedDraftId;

    const payload = {
      ...source.body,
      filename: source.filename,
      draftId,
      slug: options.slug,
      description: options.description,
      metadata: {
        ...collectGitMetadata(source.dir),
        ...collectCiMetadata(),
        cliVersion: VERSION,
        ...(source.body.html ? { fileSha256: sha256(source.body.html) } : {})
      }
    };

    const { ok, status, body } = await requestJson(`${apiUrl}/api/uploads`, {
      apiKey,
      body: payload,
      timeoutMs: 300_000
    });

    if (!ok) {
      const staleMapping = status === 404 && mappedDraftId;
      const hint = staleMapping
        ? "\nThe saved draft for this path belongs to another account or was deleted. Re-run with --new to publish a new draft."
        : "";
      if (options.json) {
        printJson({ ok: false, status, error: body.error || null, errors: body.errors || [], issues: body.issues || [] });
        process.exitCode = 1;
        return;
      }
      throw new CliError(`Upload rejected (HTTP ${status}): ${serverErrorMessage(body)}${hint}`);
    }

    const receipt = {
      ok: true,
      // Servers before receipts sent no `created`; fall back to what was asked.
      action: (body.created ?? !draftId) ? "created" : body.unchanged ? "unchanged" : "updated",
      draftId: body.draftId,
      slug: body.slug || null,
      versionNumber: body.versionNumber,
      url: body.publicUrl,
      rawUrl: body.rawUrl,
      versionUrl: body.versionUrl,
      contentHash: body.contentHash,
      totalBytes: body.totalBytes,
      account: body.account?.name || null,
      pages: body.pages || null,
      // The draft ID never moves; a slug can be renamed and reused by
      // another draft, so it would not reliably name this one.
      updateCommand: [
        "postplan upload",
        shellQuote(source.resolved),
        `--draft ${body.draftId}`,
        apiUrl === DEFAULT_API_URL ? null : `--api-url ${shellQuote(apiUrl)}`
      ]
        .filter(Boolean)
        .join(" "),
      warnings: body.warnings || []
    };

    // Print the receipt before touching local state: the page is already
    // published, and a failed map write must not hide where it went.
    if (options.json) {
      printJson(receipt);
    } else {
      printReceipt(receipt);
    }

    try {
      saveDraftMapping(apiUrl, source.resolved, {
        draftId: receipt.draftId,
        slug: receipt.slug,
        publicUrl: receipt.url,
        rawUrl: receipt.rawUrl,
        latestVersionNumber: receipt.versionNumber
      });
    } catch (error) {
      console.error(`Warning: published, but could not save the local draft mapping: ${error.message}`);
    }
  });

program
  .command("check")
  .argument("[path]", "HTML file or folder to validate; omit for a readiness check only")
  .option("--slug <name>", "Also check whether a custom URL is available to you")
  .option("--json", "Print the report as JSON")
  .option("--api-url <url>", "Override the default Postplan API base URL")
  .description("Check account, limits, and capabilities, and validate a page. Never publishes.")
  .action(async (target, options) => {
    const { apiUrl, apiKey } = readAuth(options.apiUrl, { requireApiKey: false });
    const source = target ? readUploadSource(target) : null;

    let report;
    if (!apiKey) {
      report = offlineReport(source, new CliError("Missing API key. Run: postplan auth login"));
      report.authenticationError = report.networkError;
      delete report.networkError;
    } else {
      try {
        const { ok, status, body } = await requestJson(`${apiUrl}/api/check`, {
          apiKey,
          body: { ...source?.body, slug: options.slug },
          timeoutMs: 60_000
        });
        report = ok
          ? { ...body, offline: false }
          : { ok: false, offline: false, status, errors: body.errors?.length ? body.errors : [body.error || "Check failed."] };
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error;
        report = offlineReport(source, error);
      }
    }

    report = { cliVersion: VERSION, apiUrl, path: source?.resolved || null, ...report };
    if (options.json) {
      printJson(report);
    } else {
      printCheckReport(report);
    }
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("list")
  .description("List the drafts published to your account.")
  .option("--api-url <url>", "Override the default Postplan API base URL")
  .option("--json", "Print the raw JSON response")
  .action(async (options) => {
    const { apiUrl, apiKey } = readAuth(options.apiUrl);
    const { ok, body } = await requestJson(`${apiUrl}/api/drafts`, { apiKey });
    if (!ok) {
      throw new CliError(body.error || "Failed to list drafts.");
    }

    const drafts = body.drafts || [];

    if (options.json) {
      console.log(JSON.stringify(drafts, null, 2));
      return;
    }

    if (!drafts.length) {
      console.log("No drafts yet. Publish one with: postplan upload <file>");
      return;
    }

    console.log(`Drafts (${drafts.length})\n`);
    for (const draft of drafts) {
      const repo = draft.repoOrg && draft.repoName ? `${draft.repoOrg}/${draft.repoName}` : "no repo";
      const version = draft.latestVersionNumber ? `v${draft.latestVersionNumber}` : "no versions";
      const count = `${draft.versionCount} version${draft.versionCount === 1 ? "" : "s"}`;
      const disabled = draft.disabled ? " · disabled" : "";

      console.log(draft.title || "Untitled Draft");
      console.log(`  ${repo} · ${version} · ${count} · updated ${timeAgo(draft.updatedAt)}${disabled}`);
      console.log(`  ${draft.publicUrl}`);
      if (draft.description) {
        console.log(`  ${draft.description}`);
      }
      console.log("");
    }
  });

program.exitOverride();

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(1);
  }

  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    process.exit(0);
  }

  console.error(error.message || error);
  process.exit(1);
});

function readAuth(apiUrlOverride, { requireApiKey = true } = {}) {
  const config = readJson(CONFIG_PATH, {});
  const credentials = readJson(CREDENTIALS_PATH, {});
  const apiUrl = (
    apiUrlOverride ||
    process.env.POSTPLAN_API_URL ||
    config.apiUrl ||
    DEFAULT_API_URL
  ).replace(/\/+$/, "");
  const apiKey = process.env.POSTPLAN_API_KEY || credentials.apiKey;

  if (requireApiKey && !apiKey) {
    throw new CliError("Missing API key. Run: postplan auth set <api-key>");
  }

  return { apiUrl, apiKey };
}

function ensureStateDir() {
  fs.mkdirSync(POSTPLAN_DIR, { recursive: true, mode: 0o700 });
}

function saveCredentials(apiKey, apiUrlOverride) {
  ensureStateDir();

  if (apiUrlOverride) {
    writeJson(CONFIG_PATH, {
      ...readJson(CONFIG_PATH, {}),
      apiUrl: apiUrlOverride.replace(/\/+$/, "")
    });
  }

  writeJson(
    CREDENTIALS_PATH,
    {
      apiKey,
      updatedAt: new Date().toISOString()
    },
    0o600
  );
}

// Each (API URL, path) binding is its own file, so concurrent uploads and
// uploads to different APIs never rewrite each other's mappings.
function draftBindingPath(apiUrl, file) {
  return path.join(DRAFT_BINDINGS_DIR, `${sha256(`${apiUrl}\n${file}`)}.json`);
}

// Finds the draft a path was last published to on this API. Older CLIs kept
// one mapping per path in drafts.json with no API URL, and used it for
// whichever API they called; this CLI does the same until the path gets a
// binding of its own.
function findDraftMapping(apiUrl, file) {
  const binding = readStateJson(draftBindingPath(apiUrl, file));
  if (binding) return binding;
  const legacy = readStateJson(DRAFTS_PATH)?.files?.[file];
  return legacy && (!legacy.apiUrl || legacy.apiUrl === apiUrl) ? legacy : null;
}

function saveDraftMapping(apiUrl, file, entry) {
  writeJson(draftBindingPath(apiUrl, file), {
    ...entry,
    apiUrl,
    file,
    updatedAt: new Date().toISOString()
  });
}

// Reads a JSON state file, or null when it does not exist. A corrupt file is
// moved aside, not silently reset, so it can still be recovered by hand.
function readStateJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Warning: could not read ${file}: ${error.message}`);
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    console.error(`Warning: ${file} was not valid JSON. Moved it to ${aside}.`);
    return null;
  }
}

// Reads an upload target: one HTML file, or every .html file under a folder
// (skipping dotfiles and node_modules) as pages keyed by relative path.
function readUploadSource(target) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    throw new CliError(`Path does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    return {
      resolved,
      dir: path.dirname(resolved),
      filename: path.basename(resolved),
      body: { html: fs.readFileSync(resolved, "utf8") }
    };
  }

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        files.push({
          path: path.relative(resolved, full).split(path.sep).join("/"),
          html: fs.readFileSync(full, "utf8")
        });
      }
    }
  };
  walk(resolved);
  if (!files.length) {
    throw new CliError(`No .html files found in ${resolved}`);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { resolved, dir: resolved, filename: path.basename(resolved), body: { files } };
}

// POSTs `body` as JSON (GET when absent) and returns { ok, status, body }.
// Unreachable servers throw NetworkError, so callers can tell "could not
// reach Postplan" apart from "Postplan rejected this".
async function requestJson(url, { apiKey, body, timeoutMs = 30_000 } = {}) {
  const headers = { "User-Agent": `postplan/${VERSION}` };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const reason =
      error.name === "TimeoutError"
        ? `timed out after ${timeoutMs / 1000}s`
        : error.cause?.message || error.message;
    throw new NetworkError(`Could not reach ${new URL(url).origin}: ${reason}`);
  }

  // The connection can also drop or time out while the body streams in.
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new NetworkError(`Lost the connection to ${new URL(url).origin}: ${error.cause?.message || error.message}`);
  }
  try {
    return { ok: response.ok, status: response.status, body: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      status: response.status,
      body: { error: `Postplan returned HTTP ${response.status}: ${text.slice(0, 200)}` }
    };
  }
}

function serverErrorMessage(body) {
  const details = body.errors?.length ? `\n- ${body.errors.join("\n- ")}` : "";
  return `${body.error || "HTML failed Postplan validation."}${details}`;
}

// Offline fallback for `check`: the bundled validator knows the markup rules,
// but not the account, its limits, or whether scripts are allowed.
function offlineReport(source, error) {
  const validation = source
    ? validateUpload(source.body.files || [{ path: "index.html", html: source.body.html }])
    : null;
  return {
    ok: false,
    offline: true,
    networkError: error.message,
    ...(validation && {
      markupOk: validation.ok,
      totalBytes: validation.totalBytes,
      pages: validation.pages.map((page) => ({ path: page.path, bytes: page.bytes, title: page.title, hasScripts: page.hasScripts })),
      issues: validation.issues,
      errors: validation.errors,
      warnings: validation.warnings
    })
  };
}

function printReceipt(receipt) {
  const headline = {
    created: "Uploaded draft",
    updated: "Updated draft",
    unchanged: `Unchanged: this content is already version ${receipt.versionNumber}`
  }[receipt.action];
  console.log(headline);
  console.log(`URL: ${receipt.url}`);
  console.log(`Raw HTML: ${receipt.rawUrl}`);
  if (receipt.versionUrl) console.log(`Version URL: ${receipt.versionUrl}`);
  console.log(`Draft ID: ${receipt.draftId}`);
  console.log(`Version: ${receipt.versionNumber}`);
  if (receipt.pages) console.log(`Pages: ${receipt.pages.map((page) => page.path).join(", ")}`);
  if (receipt.account) console.log(`Account: ${receipt.account}`);
  console.log(`Update: ${receipt.updateCommand}`);
  for (const warning of receipt.warnings) {
    console.warn(`Warning: ${warning}`);
  }
}

function printCheckReport(report) {
  console.log(`postplan ${report.cliVersion} -> ${report.apiUrl}`);
  if (report.offline) {
    console.log(`Offline: ${report.authenticationError || report.networkError}`);
    console.log(`${report.path ? "Checked markup locally. " : ""}Account, limits, and script permission were not checked.`);
  } else if (report.limits) {
    const account = report.account
      ? `${report.account.name} (key: ${report.account.apiKeyName})`
      : "none (sign in before uploading)";
    console.log(`Account: ${account}`);
    console.log(`Flags: ${report.flags.length ? report.flags.join(", ") : "none"}`);
    console.log(`Limit: ${formatBytes(report.limits.maxBytes)} per upload, ${report.limits.maxPages} page(s)`);
    console.log(`Inline JavaScript: ${report.capabilities.inlineScripts ? "allowed (sandboxed)" : "not enabled"}`);
    console.log(`Custom URLs: ${report.capabilities.customUrls ? "enabled" : "not enabled"}`);
  }
  if (report.slug) {
    console.log(`Custom URL "${report.slug.slug}": ${report.slug.status}${report.slug.message ? `. ${report.slug.message}` : ""}`);
  }
  if (report.path && report.pages) {
    const count = `${report.pages.length} page${report.pages.length === 1 ? "" : "s"}`;
    console.log(`\n${report.path} (${count}, ${formatBytes(report.totalBytes)})`);
  }
  for (const issue of report.issues || []) {
    console.log(`${issue.level === "error" ? "Error" : "Warning"}: ${formatIssue(issue)}`);
  }
  if (!report.issues) {
    for (const error of report.errors || []) console.log(`Error: ${error}`);
  }
  console.log(report.ok ? "\nReady." : "\nNot ready.");
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

// Writes through a temp file and rename, so a crash or a concurrent CLI run
// never leaves half-written JSON behind.
function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

function collectGitMetadata(cwd) {
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  const remote = git(["config", "--get", "remote.origin.url"], cwd);
  const parsedRemote = parseRemote(remote);
  const status = git(["status", "--porcelain"], cwd);

  return {
    repoOrg: parsedRemote.org || inferOrgFromRoot(repoRoot),
    repoName: parsedRemote.name || (repoRoot ? path.basename(repoRoot) : null),
    repoHost: parsedRemote.host || null,
    gitBranch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    gitCommitSha: git(["rev-parse", "HEAD"], cwd),
    gitCommitSubject: git(["log", "-1", "--format=%s"], cwd),
    // null when not a git repo; true/false when a working tree is present.
    gitDirty: status === null ? null : status.length > 0
  };
}

// Best-effort CI provenance. GitHub Actions is detected precisely (with a run
// URL); other CI systems are flagged generically. Nothing here is trusted for
// authorization — it is metadata for the dashboard and audit trail only.
function collectCiMetadata() {
  const env = process.env;
  if (env.GITHUB_ACTIONS === "true") {
    const server = env.GITHUB_SERVER_URL || "https://github.com";
    const repo = env.GITHUB_REPOSITORY;
    const runId = env.GITHUB_RUN_ID;
    return {
      ciProvider: "github_actions",
      ciRunUrl: repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
      ciActor: env.GITHUB_ACTOR || null
    };
  }
  if (env.CI) {
    return { ciProvider: "unknown" };
  }
  return {};
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function parseRemote(remote) {
  if (!remote) return {};

  const cleaned = remote.replace(/\.git$/, "");
  const sshMatch = cleaned.match(/^[^@]+@([^:]+):([^/]+)\/(.+)$/);
  if (sshMatch) {
    return { host: sshMatch[1], org: sshMatch[2], name: path.basename(sshMatch[3]) };
  }

  try {
    const url = new URL(cleaned);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      return { host: url.hostname, org: parts[0], name: parts.at(-1) };
    }
  } catch {
    // Fall through to path parsing.
  }

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return { org: parts.at(-2), name: parts.at(-1) };
  }

  return {};
}

function inferOrgFromRoot(repoRoot) {
  if (!repoRoot) return null;
  return path.basename(path.dirname(repoRoot));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function timeAgo(value) {
  if (!value) return "unknown";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "unknown";

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const units = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60]
  ];

  for (const [name, secs] of units) {
    const amount = Math.floor(seconds / secs);
    if (amount >= 1) return `${amount} ${name}${amount === 1 ? "" : "s"} ago`;
  }
  return "just now";
}
