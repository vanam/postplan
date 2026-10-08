import * as parse5 from "parse5";

const EMBED_FIX = "Link to the page instead of embedding it.";
const BLOCKED_TAGS = new Map([
  ["base", "Use relative links within the draft."],
  ["link", "Inline styles and use ordinary links instead."],
  ["form", "Forms cannot submit on Postplan. Use inputs without a <form> wrapper."],
  ["iframe", EMBED_FIX],
  ["object", EMBED_FIX],
  ["embed", EMBED_FIX],
  ["applet", EMBED_FIX]
]);

const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
  "srcdoc",
  "xlink:href"
]);

const BLOCKED_PROTOCOLS = ["javascript:", "vbscript:", "file:"];

// Scripts the browser runs. Inline only: the CSP never allows a script URL.
const EXECUTABLE_SCRIPT_TYPES = new Set(["", "text/javascript", "application/javascript"]);
// Inert data blocks do not grant script execution permission.
const DATA_SCRIPT_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "text/plain",
  "text/template",
  "text/html",
  "text/markdown",
  "text/csv"
]);

// Tags whose src must already be hosted somewhere: Postplan only hosts HTML.
const EMBED_SRC_TAGS = new Set(["img", "video", "audio", "source", "track"]);

// Browser APIs that fail inside the scripted-draft sandbox (opaque origin,
// connect-src 'none', no allow-modals). Reported as warnings so agents learn
// before a reader finds a broken page.
const SANDBOX_APIS = [
  {
    code: "sandbox-storage",
    pattern: /\b(localStorage|sessionStorage|indexedDB)\b/,
    message: "Scripts use browser storage, which throws in the Postplan sandbox.",
    fix: "Keep state in memory or in location.hash."
  },
  {
    code: "sandbox-cookie",
    pattern: /\bdocument\.cookie\b/,
    message: "Scripts use document.cookie, which throws in the Postplan sandbox.",
    fix: "Keep state in memory or in location.hash."
  },
  {
    code: "sandbox-network",
    pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b/,
    message: "Scripts make network requests, which the Postplan sandbox blocks.",
    fix: 'Inline the data in the page, for example in a <script type="application/json"> block.'
  },
  {
    code: "sandbox-dialog",
    pattern: /\b(alert|confirm|prompt)\s*\(/,
    message: "Scripts use alert/confirm/prompt, which do nothing in the Postplan sandbox.",
    fix: "Show messages in the page instead."
  },
  {
    code: "sandbox-worker",
    pattern: /\bnew\s+(Shared)?Worker\b/,
    message: "Scripts start workers, which the Postplan sandbox blocks.",
    fix: "Run the code on the main thread."
  }
];

// Multi-page uploads map each page path to a URL on the draft's host. These
// first segments are reserved for version and raw routes.
const PAGE_SEGMENT_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const RESERVED_PAGE_ROOTS = new Set([
  "v",
  "raw",
  "api",
  "healthz",
  "favicon.ico",
  "favicon.png",
  "favicon.svg"
]);
const MAX_PAGE_PATH_LENGTH = 200;
const MAX_PAGE_PATH_SEGMENTS = 6;

// Far above any real document (browsers themselves flatten around 512), but
// well below where a recursive parse5 serializer would overflow the call
// stack (~2000+ levels).
const MAX_DEPTH = 512;

// Validates one HTML document. Returns string errors/warnings for display and
// structured `issues` ({ level, code, message, fix, line, column, count }) for
// tools. `hasScripts` means the page contains code the browser would run.
export function validateHtml(html, options = {}) {
  const maxBytes = options.maxBytes ?? Infinity;
  const issues = createIssueList();

  if (typeof html !== "string" || html.trim() === "") {
    issues.error("empty", "HTML document is empty.");
    return result({ issues, title: null, hasScripts: false, bytes: 0, externalImageHosts: [] });
  }

  const bytes = new TextEncoder().encode(html).byteLength;
  if (bytes > maxBytes) {
    issues.error("too-large", sizeMessage(bytes, maxBytes));
  }

  let document;
  try {
    // scriptingEnabled: false so <noscript> children parse as real elements:
    // a reader without JavaScript sees them, so the policy must see them too.
    document = parse5.parse(html, { scriptingEnabled: false, sourceCodeLocationInfo: true });
  } catch {
    issues.error("parse-failed", "HTML document could not be parsed.");
    return result({ issues, title: null, hasScripts: false, bytes, externalImageHosts: [] });
  }

  let title = null;
  let hasScripts = false;
  const externalImageHosts = new Set();
  const scriptSources = [];

  function visit(node) {
    if (node.tagName) {
      const tagName = node.tagName.toLowerCase();
      const attributes = new Map(
        (node.attrs || []).map((attr) => [attr.name.toLowerCase(), String(attr.value || "").trim()])
      );

      if (BLOCKED_TAGS.has(tagName)) {
        issues.error("blocked-tag", `Blocked <${tagName}> tag.`, {
          node,
          fix: BLOCKED_TAGS.get(tagName)
        });
      }

      if (tagName === "script") {
        if (attributes.has("src")) {
          issues.error("external-script", "External script sources are not allowed.", {
            node,
            fix: "Inline the code in a <script> block."
          });
        }

        const scriptType = (attributes.get("type") || "").toLowerCase();
        if (EXECUTABLE_SCRIPT_TYPES.has(scriptType)) {
          hasScripts = true;
          scriptSources.push({ node, text: collectText(node) });
        } else if (!DATA_SCRIPT_TYPES.has(scriptType)) {
          issues.error("script-type", `Unsupported script type "${scriptType}".`, {
            node,
            fix: 'Use a classic inline script, or type="application/json" for data.'
          });
        }
      }

      if (EMBED_SRC_TAGS.has(tagName)) {
        // srcset candidates are "url descriptor" pairs separated by ", ". Data
        // URLs contain a comma with no space after it, so they stay whole.
        const references = [
          ...["src", "poster"].map((name) => [name, attributes.get(name)]),
          ...(attributes.get("srcset") || "")
            .split(/,\s+/)
            .map((candidate) => ["srcset", candidate.trim().split(/\s+/)[0]])
        ];
        for (const [name, value] of references) {
          if (value && isLocalReference(value)) {
            issues.warning("relative-asset", `"${value}" will not load. Postplan only hosts HTML pages.`, {
              node,
              attr: name,
              fix: "Upload the file (for example with file-upload) and use its https URL, or inline it as a data: URL."
            });
          }
        }
      }

      for (const attr of node.attrs || []) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || "").trim();

        if (name.startsWith("on")) {
          issues.error("event-handler", `Blocked inline event handler attribute "${name}" found.`, { node, attr: attr.name, fix: "Use addEventListener in a classic inline script." });
        }

        if (name === "srcdoc") {
          issues.error("srcdoc", 'Blocked "srcdoc" attribute.', { node, attr: attr.name, fix: EMBED_FIX });
        }

        if (URL_ATTRS.has(name)) {
          const normalized = value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
          if (BLOCKED_PROTOCOLS.some((protocol) => normalized.startsWith(protocol))) {
            issues.error("unsafe-url", `Blocked unsafe URL in "${name}" attribute.`, {
              node,
              attr: attr.name,
              fix: "Use an https link, or an event listener added from a <script> block."
            });
          }
        }

        if (name === "style" && /expression\s*\(|behavior\s*:|url\s*\(\s*javascript:/i.test(value)) {
          issues.error("unsafe-css", "Blocked unsafe inline CSS.", { node, attr: attr.name });
        }
      }

      if (tagName === "a" && (attributes.get("href") || "").startsWith("/")) {
        issues.warning("root-relative-link", "Root-relative links address the service root, not this draft.", { node, attr: "href", fix: "Use relative page paths." });
      }

      if (tagName === "meta" && (attributes.get("http-equiv") || "").toLowerCase() === "refresh") {
        issues.error("meta-refresh", "Blocked meta refresh tag.", { node, fix: "Use a normal link." });
      }

      // Record which hosts a draft pulls images from, for later review.
      if (tagName === "img") {
        const host = externalHost(attributes.get("src"));
        if (host) externalImageHosts.add(host);
      }

      if (tagName === "title" && !title) {
        title = collectText(node).trim().slice(0, 140) || null;
      }
    }
  }

  let tooDeep = false;
  const stack = [{ node: document, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    visit(node);
    if (depth >= MAX_DEPTH) {
      tooDeep = true;
      continue;
    }
    const children = [...(node.childNodes || []), ...(node.content ? [node.content] : [])];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], depth: depth + 1 });
    }
  }
  if (tooDeep) {
    issues.error("too-deep", `HTML is nested more than ${MAX_DEPTH} levels deep.`);
  }

  for (const api of SANDBOX_APIS) {
    const source = scriptSources.find(({ text }) => api.pattern.test(text));
    if (source) {
      issues.warning(api.code, api.message, { node: source.node, attr: source.attr, fix: api.fix });
    }
  }

  if (!title) {
    issues.warning("no-title", "No <title> found; Postplan will use a generic title.");
  }

  return result({
    issues,
    title,
    hasScripts,
    bytes,
    externalImageHosts: [...externalImageHosts].sort()
  });
}

// Validates a whole upload: one page, or a folder of pages that link to each
// other by relative path. Enforces the caller's limits and capabilities, so
// /api/uploads and the /api/check preflight always agree.
export function validateUpload(pages, { maxBytes = Infinity, maxPages = Infinity, inlineScripts = true } = {}) {
  const issues = [];
  const results = [];
  const multiPage = Array.isArray(pages) && pages.length > 1;

  if (!Array.isArray(pages) || pages.length === 0) {
    issues.push(uploadIssue("empty", "Upload has no HTML pages."));
    return uploadResult({ issues, pages: results, totalBytes: 0, hasScripts: false });
  }

  if (pages.length > maxPages) {
    issues.push(uploadIssue("too-many-pages", `Upload has ${pages.length} pages; the limit is ${maxPages}.`));
    return uploadResult({ issues, pages: [], totalBytes: 0, hasScripts: false });
  }

  const seen = new Set();
  for (const page of pages) {
    const path = page?.path;
    const pathProblem = pagePathProblem(path);
    if (pathProblem) {
      issues.push(uploadIssue("page-path", pathProblem));
      continue;
    }
    if (seen.has(path)) {
      issues.push(uploadIssue("page-path", `Page path "${path}" appears twice.`));
      continue;
    }
    seen.add(path);

    const validation = validateHtml(page.html);
    results.push({ path, html: page.html, ...validation });
    issues.push(...validation.issues.map((issue) => (multiPage ? { path, ...issue } : issue)));
  }

  if (!seen.has("index.html")) {
    issues.push(uploadIssue("missing-index", "Uploads need an index.html page."));
  }

  const totalBytes = results.reduce((sum, page) => sum + page.bytes, 0);
  if (totalBytes > maxBytes) {
    issues.push(
      uploadIssue("too-large", sizeMessage(totalBytes, maxBytes), {
        fix: "Reduce the upload size or split the report into separate drafts."
      })
    );
  }

  const hasScripts = results.some((page) => page.hasScripts);
  if (hasScripts && !inlineScripts) {
    issues.push(
      uploadIssue("scripts-not-enabled", "Inline JavaScript is not enabled for this upload.", {
        fix: "Keep the requested interactivity and check the server's capabilities."
      })
    );
  }

  return uploadResult({ issues, pages: results, totalBytes, hasScripts });
}

// The single-line form of an issue, used for human output and for the
// `errors`/`warnings` string arrays older CLIs print.
export function formatIssue(issue) {
  const location = issue.line ? `line ${issue.line}:${issue.column}` : null;
  const where = [issue.path, location].filter(Boolean).join(" ");
  const count = issue.count > 1 ? ` (${issue.count} places)` : "";
  const fix = issue.fix ? ` Fix: ${issue.fix}` : "";
  return `${where ? `${where}: ` : ""}${issue.message}${count}${fix}`;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

export function pagePathProblem(path) {
  if (typeof path !== "string" || !path) return "Page path is missing.";
  const segments = path.split("/");
  if (path.length > MAX_PAGE_PATH_LENGTH || segments.length > MAX_PAGE_PATH_SEGMENTS) {
    return `Page path "${path}" is too long.`;
  }
  if (!path.endsWith(".html") || !segments.every((segment) => PAGE_SEGMENT_PATTERN.test(segment))) {
    return `Page path "${path}" must be a relative .html path of letters, numbers, ".", "_", and "-".`;
  }
  const root = segments[0].replace(/\.html$/, "");
  if (RESERVED_PAGE_ROOTS.has(root.toLowerCase())) {
    return `Page path "${path}" uses the reserved name "${root}".`;
  }
  return null;
}

function sizeMessage(bytes, maxBytes) {
  return `HTML is ${bytes} bytes (${formatBytes(bytes)}); the limit for this upload is ${maxBytes} bytes (${formatBytes(maxBytes)}).`;
}

function uploadIssue(code, message, { fix } = {}) {
  return { level: "error", code, message, ...(fix ? { fix } : {}), count: 1 };
}

function uploadResult({ issues, pages, totalBytes, hasScripts }) {
  const index = pages.find((page) => page.path === "index.html") || pages[0];
  const ok = !issues.some((issue) => issue.level === "error");
  return {
    ok,
    errors: issues.filter((issue) => issue.level === "error").map(formatIssue),
    warnings: issues.filter((issue) => issue.level === "warning").map(formatIssue),
    issues,
    pages,
    totalBytes,
    hasScripts,
    title: index?.title ?? null
  };
}

// Runtime-specific hash adapters keep the validator portable to Workers and Node.
export async function hashUpload(pages, sha256) {
  const hashes = await Promise.all(pages.map(async page => ({ ...page, contentHash: await sha256(page.html) })));
  const manifest = hashes.map(page => page.path + "\0" + page.contentHash).sort().join("\n");
  return { pages: hashes, contentHash: hashes.length === 1 ? hashes[0].contentHash : await sha256(manifest) };
}

// Collects issues, merging repeats of the same problem into one entry with a
// count and the first location, so 500 identical findings stay readable.
function createIssueList() {
  const byKey = new Map();
  function add(level, code, message, { node, attr, fix } = {}) {
    const key = `${level}\0${code}\0${message}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    const location = node?.sourceCodeLocation;
    const start = (attr && location?.attrs?.[attr]) || location;
    byKey.set(key, {
      level,
      code,
      message,
      ...(fix ? { fix } : {}),
      ...(start ? { line: start.startLine, column: start.startCol } : {}),
      count: 1
    });
  }
  return {
    error: (...args) => add("error", ...args),
    warning: (...args) => add("warning", ...args),
    list: () => [...byKey.values()]
  };
}

function result({ issues, title, hasScripts, bytes, externalImageHosts }) {
  const list = issues.list();
  return {
    ok: !list.some((issue) => issue.level === "error"),
    errors: list.filter((issue) => issue.level === "error").map(formatIssue),
    warnings: list.filter((issue) => issue.level === "warning").map(formatIssue),
    issues: list,
    title,
    hasScripts,
    bytes,
    stats: { hasInlineScript: hasScripts, externalImageHosts }
  };
}

// True for paths that point at the author's machine or the draft's own host,
// where Postplan serves nothing but HTML pages.
function isLocalReference(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw.startsWith("#")) return false;
  return !/^(https?:|data:|blob:|\/\/)/.test(raw);
}

// Returns the lowercased host of an absolute http(s) (or protocol-relative) URL,
// or null for relative paths, data: URIs, and anything unparseable.
function externalHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = raw.startsWith("//") ? `https:${raw}` : raw;
  try {
    const url = new URL(candidate);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.hostname.toLowerCase();
    }
  } catch {
    // relative path, data: URI, etc. — not an external host
  }
  return null;
}

function collectText(node) {
  let value = "";
  for (const child of node.childNodes || []) {
    if (child.nodeName === "#text") value += child.value || "";
    value += collectText(child);
  }
  return value;
}
