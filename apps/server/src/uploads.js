import { hashUpload, validateUpload, pagePathProblem } from "@postplan/html-policy";
import { clientIp, requestId } from "./client-ip.js";
import { getConfig } from "./config.js";
import { sha256 } from "./crypto.js";
import { findOwnedDraft } from "./db.js";
import { HttpError } from "./http.js";
import { newDraftId, newInternalId } from "./ids.js";
import { commitPublication, currentVersion, findDraftBySlug, updateUnchangedDraft, versionPages } from "./publication.js";
import { getHomeUrl, getRequestBaseUrl } from "./public-url.js";
import { consumeRateLimit } from "./rate-limit.js";
import { renderNotFound } from "./render.js";
import { deleteHtmlObject, getHtmlObject, putHtmlObject } from "./storage.js";

function slugProblem(slug) {
  return typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)
    ? "Slug must contain 1 to 63 lowercase letters, digits, or internal hyphens." : null;
}

function uploadPages(body, optional = false) {
  if (body.html !== undefined && body.files !== undefined) {
    throw new HttpError(400, "Supply html or files, not both.");
  }
  if (body.html !== undefined) return [{ path: "index.html", html: body.html }];
  if (body.files !== undefined) {
    if (!Array.isArray(body.files)) throw new HttpError(400, "files must be an array of HTML pages.");
    return body.files;
  }
  return optional ? null : [];
}

function validateTarget(body) {
  if (body.draftId !== undefined && body.draftId !== null &&
      (typeof body.draftId !== "string" || !body.draftId)) {
    throw new HttpError(400, "draftId must be a nonempty string.");
  }
  if (body.slug !== undefined && slugProblem(body.slug)) {
    throw new HttpError(400, slugProblem(body.slug));
  }
}

async function resolveTarget(db, body, accountId) {
  const byId = body.draftId ? await findOwnedDraft(db, body.draftId, accountId) : null;
  if (body.draftId && !byId) throw new HttpError(404, "Draft not found.");
  const bySlug = body.slug !== undefined ? await findDraftBySlug(db, body.slug) : null;
  if (bySlug && (bySlug.account_id !== accountId || (byId && byId.id !== bySlug.id))) {
    throw new HttpError(409, "Slug is already in use.");
  }
  const draft = byId || bySlug;
  if (draft?.disabled_at) throw new HttpError(409, "Draft is disabled.");
  return draft;
}

function manifest(pages) {
  return pages.map(page => ({
    path: page.path, bytes: page.bytes ?? Number(page.file_size), title: page.title,
    hasScripts: page.hasScripts ?? Boolean(page.has_inline_script),
    contentHash: page.contentHash ?? page.content_hash
  }));
}

function publicationReceipt(c, { draftId, slug, versionId, versionNumber, title, validation, created, unchanged }) {
  const base = getHomeUrl({ publicBaseUrl: getConfig(c.env).publicBaseUrl,
    requestBaseUrl: getRequestBaseUrl(c.req.raw) });
  const pages = manifest(validation.pages);
  const suffix = pages.length > 1 ? "/" : "";
  const draftUrl = `${base}/d/${draftId}`;
  const auth = c.get("auth");
  return {
    ok: true, created, unchanged, draftId, slug, versionId, versionNumber,
    title, requestId: requestId(c.req.raw),
    publicUrl: slug ? `${base}/s/${slug}/` : `${draftUrl}${suffix}`,
    rawUrl: `${draftUrl}/raw`, versionUrl: `${draftUrl}/v/${versionNumber}${suffix}`,
    contentHash: validation.contentHash, totalBytes: validation.totalBytes,
    account: { id: auth.account_id, name: auth.account_name },
    pages, warnings: validation.warnings
  };
}

export function registerUploadRoutes(app, { requireAuth, readJsonBody, normalizeMetadata, cleanText, rateLimitResponse }) {
  app.post("/api/check", requireAuth, async c => {
    const config = getConfig(c.env);
    const auth = c.get("auth");
    const limit = await consumeRateLimit(c.env.DB, {
      keyPrefix: "check-key", identity: auth.id, ...config.checkRateLimit
    });
    if (!limit.allowed) return rateLimitResponse(c, limit.retryAfter, "Check rate limit exceeded.");
    const body = await readJsonBody(c.req.raw, config.uploadBodyBytes);
    const pages = uploadPages(body, true);
    const validation = pages === null ? { ok: true, errors: [], warnings: [], issues: [] }
      : validateUpload(pages, { maxBytes: config.maxHtmlBytes, maxPages: config.maxPages });
    let slug = null;
    if (body.slug !== undefined) {
      const problem = slugProblem(body.slug);
      const draft = problem ? null : await findDraftBySlug(c.env.DB, body.slug);
      const status = problem ? "invalid" : !draft ? "available"
        : draft.account_id !== auth.account_id ? "taken" : draft.disabled_at ? "disabled" : "owned";
      slug = { slug: body.slug, status, message: problem || (status === "taken" ? "Slug is already in use."
        : status === "disabled" ? "Draft is disabled." : null) };
      if (["invalid", "taken", "disabled"].includes(status)) {
        validation.ok = false;
        validation.errors.push(slug.message);
        validation.issues.push({ level: "error", code: `slug-${status}`, message: slug.message, count: 1 });
      }
    }
    return c.json({
      ok: validation.ok, account: { id: auth.account_id, name: auth.account_name, apiKeyName: auth.name },
      flags: [], limits: { maxBytes: config.maxHtmlBytes, maxPages: config.maxPages },
      capabilities: { inlineScripts: true, customUrls: true }, slug,
      ...(pages !== null ? { pages: manifest(validation.pages), totalBytes: validation.totalBytes } : {}),
      issues: validation.issues, errors: validation.errors, warnings: validation.warnings
    });
  });

  app.post("/api/uploads", requireAuth, async c => {
    const config = getConfig(c.env);
    const auth = c.get("auth");
    for (const limit of [
      { keyPrefix: "upload-ip", identity: clientIp(c.req.raw) || "unknown", ...config.uploadIpRateLimit },
      { keyPrefix: "upload-key", identity: auth.id, ...config.uploadKeyRateLimit }
    ]) {
      const result = await consumeRateLimit(c.env.DB, limit);
      if (!result.allowed) return rateLimitResponse(c, result.retryAfter);
    }
    const body = await readJsonBody(c.req.raw, config.uploadBodyBytes);
    validateTarget(body);
    const validation = validateUpload(uploadPages(body), { maxBytes: config.maxHtmlBytes, maxPages: config.maxPages });
    if (!validation.ok) return c.json({ ok: false, error: "HTML failed Postplan validation.",
      errors: validation.errors, warnings: validation.warnings, issues: validation.issues }, 422);
    Object.assign(validation, await hashUpload(validation.pages, sha256));
    const metadata = normalizeMetadata(body.metadata);
    const description = cleanText(body.description, 1000);
    const scriptsAllowed = validation.hasScripts;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existingDraft = await resolveTarget(c.env.DB, body, auth.account_id);
      const slug = body.slug ?? existingDraft?.slug ?? null;
      const title = validation.title || existingDraft?.title || cleanText(body.filename) || "Untitled Draft";
      const previous = existingDraft ? await currentVersion(c.env.DB, existingDraft.current_version_id) : null;
      if (previous && previous.content_hash === validation.contentHash &&
          Boolean(previous.scripts_allowed) === scriptsAllowed) {
        const input = { draftId: existingDraft.id, accountId: auth.account_id, versionId: previous.id,
          apiKeyId: auth.id, sourceIp: clientIp(c.req.raw), userAgent: cleanText(c.req.header("user-agent"), 1000),
          description, slug, previousSlug: existingDraft.slug };
        if (slug !== existingDraft.slug || (description !== null && description !== existingDraft.description)) {
          try {
            if (!await updateUnchangedDraft(c.env.DB, input)) continue;
          } catch (error) {
            if (String(error.message).includes("UNIQUE constraint failed: drafts.slug")) continue;
            throw error;
          }
        }
        return c.json(publicationReceipt(c, { draftId: existingDraft.id, slug, versionId: previous.id,
          versionNumber: Number(previous.version_number), title: existingDraft.title,
          validation, created: false, unchanged: true }));
      }
      const draftId = existingDraft?.id || newDraftId();
      const versionId = newInternalId();
      const pages = validation.pages.map(page => ({ ...page,
        objectKey: `drafts/${draftId}/versions/${versionId}/${page.path}` }));
      const written = [];
      try {
        for (const page of pages) {
          // Include the attempted key in cleanup even if a failed put stored bytes.
          written.push(page.objectKey);
          await putHtmlObject(c.env.DRAFTS, page.objectKey, page.html);
        }
        const versionNumber = await commitPublication(c.env.DB, {
          existingDraft, draftId, versionId, accountId: auth.account_id, apiKeyId: auth.id,
          objectKey: pages.find(page => page.path === "index.html").objectKey,
          title,
          description, slug, contentHash: validation.contentHash, fileSize: validation.totalBytes,
          sourceIp: clientIp(c.req.raw), userAgent: cleanText(c.req.header("user-agent"), 1000),
          originalFilename: cleanText(body.filename), requestId: requestId(c.req.raw),
          hasInlineScript: validation.hasScripts, scriptsAllowed,
          externalImageHosts: [...new Set(pages.flatMap(page => page.stats.externalImageHosts))].sort(),
          metadata, pages
        });
        if (versionNumber) return c.json(publicationReceipt(c, { draftId, slug, versionId, versionNumber, title,
          validation, created: !existingDraft, unchanged: false }), existingDraft ? 200 : 201);
      } catch (error) {
        await cleanup(c.env.DRAFTS, written);
        // A concurrent slug claim is retried against its now-current owner.
        if (String(error.message).includes("UNIQUE constraint failed: drafts.slug")) continue;
        throw error;
      }
      await cleanup(c.env.DRAFTS, written);
    }
    throw new HttpError(409, "Draft changed concurrently. Retry the upload.");
  });

  app.get("/s/:slug", redirectSlug);
  app.get("/s/:slug/*", redirectSlug);
  app.get("/d/:draftId", servePage);
  app.get("/d/:draftId/*", servePage);
}

async function cleanup(bucket, keys) {
  await Promise.all(keys.map(key => deleteHtmlObject(bucket, key).catch(error => {
    console.error("Could not remove unreferenced R2 object:", error);
  })));
}

async function redirectSlug(c) {
  const draft = await findDraftBySlug(c.env.DB, c.req.param("slug"));
  if (!draft || draft.disabled_at) return c.html(renderNotFound(), 404);
  const prefix = `/s/${c.req.param("slug")}`;
  const suffix = new URL(c.req.url).pathname.slice(prefix.length) || "/";
  return c.redirect(`/d/${draft.id}${suffix}${new URL(c.req.url).search}`, 302);
}

// Resolve explicit version/raw prefixes before validating the remaining page path.
async function servePage(c) {
  const url = new URL(c.req.url);
  const prefix = `/d/${c.req.param("draftId")}`;
  let parts = url.pathname.slice(prefix.length).split("/").filter(Boolean);
  let number;
  if (parts[0] === "v") {
    if (!/^[1-9]\d*$/.test(parts[1] || "")) return c.html(renderNotFound(), 404);
    number = Number(parts[1]);
    if (!Number.isSafeInteger(number)) return c.html(renderNotFound(), 404);
    parts = parts.slice(2);
  }
  const raw = parts[0] === "raw";
  if (raw) parts = parts.slice(1);
  const path = parts.join("/") || "index.html";
  if (pagePathProblem(path) || /%|\\|\/\//.test(url.pathname)) return c.html(renderNotFound(), 404);
  const version = await c.env.DB.prepare(`SELECT v.id, v.version_number, v.scripts_allowed
    FROM drafts d JOIN draft_versions v ON ${number === undefined ? "v.id = d.current_version_id" : "v.draft_id = d.id AND v.version_number = ?"}
    WHERE d.id = ? AND d.deleted_at IS NULL AND d.disabled_at IS NULL`)
    .bind(...(number === undefined ? [c.req.param("draftId")] : [number, c.req.param("draftId")])).first();
  if (!version) return c.html(renderNotFound(), 404);
  if (!parts.length && !raw && !url.pathname.endsWith("/")) {
    const pages = await versionPages(c.env.DB, version.id);
    if (pages.length > 1) return c.redirect(`${url.pathname}/${url.search}`, 302);
  }
  const page = await c.env.DB.prepare("SELECT object_key FROM draft_version_pages WHERE version_id = ? AND path = ?")
    .bind(version.id, path).first();
  if (!page) return c.html(renderNotFound(), 404);
  const object = await getHtmlObject(c.env.DRAFTS, page.object_key);
  if (!object) return c.html(renderNotFound(), 404);
  return new Response(object.body, { headers: {
    "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": draftContentSecurityPolicy(Boolean(version.scripts_allowed)),
    "X-Content-Type-Options": "nosniff", "X-Postplan-Draft-Id": c.req.param("draftId"),
    "X-Postplan-Draft-Version": String(version.version_number)
  } });
}

export function draftContentSecurityPolicy(scriptsAllowed) {
  return ["default-src 'none'", scriptsAllowed ? "sandbox allow-scripts" : "sandbox",
    scriptsAllowed ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "script-src-attr 'none'", "style-src 'unsafe-inline'", "img-src https: data:",
    "connect-src 'none'", "worker-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
}
