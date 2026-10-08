import { Hono } from "hono";
import { clientIp, requestId } from "./client-ip.js";
import { getConfig, requireBinding } from "./config.js";
import { contentHash, randomToken, sha256 } from "./crypto.js";
import {
  createDraftVersion,
  findApiKeyByToken,
  findOwnedDraft,
  findPublicDraftVersion,
  isoNow
} from "./db.js";
import { listAccountDrafts } from "./drafts.js";
import { validateHtml } from "./html-policy.js";
import { newDraftId, newInternalId } from "./ids.js";
import { getDraftPublicUrl, getDraftRawUrl, getHomeUrl, getRequestBaseUrl } from "./public-url.js";
import { consumeRateLimit } from "./rate-limit.js";
import { renderHome, renderNotFound } from "./render.js";
import { deleteHtmlObject, getHtmlObject, putHtmlObject } from "./storage.js";
import { registerWebRoutes } from "./web.js";

const encoder = new TextEncoder();

export function createApp() {
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/favicon.ico", (c) => c.env.ASSETS.fetch(c.req.raw));

  app.get("/", (c) => {
    const config = getConfig(c.env);
    return c.html(
      renderHome({
        publicBaseUrl: getHomeUrl({
          publicBaseUrl: config.publicBaseUrl,
          requestBaseUrl: getRequestBaseUrl(c.req.raw)
        })
      })
    );
  });

  app.get("/healthz", async (c) => {
    try {
      await requireBinding("DB", c.env.DB).prepare("SELECT 1").first();
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ ok: false, error: error.message }, 503);
    }
  });

  app.get("/api/me", requireAuth, (c) => {
    const auth = c.get("auth");
    return c.json({
      accountId: auth.account_id,
      accountName: auth.account_name,
      apiKeyId: auth.id,
      apiKeyName: auth.name
    });
  });

  app.get("/api/drafts", requireAuth, async (c) => {
    const config = getConfig(c.env);
    const drafts = await listAccountDrafts(c.env.DB, c.get("auth").account_id, {
      publicBaseUrl: config.publicBaseUrl,
      requestBaseUrl: getRequestBaseUrl(c.req.raw)
    });
    return c.json({ ok: true, drafts });
  });

  app.post("/api/api-keys", requireAuth, async (c) => {
    const config = getConfig(c.env);
    const body = await readJsonBody(c.req.raw, config.uploadBodyBytes);
    const token = `pp_${randomToken(32)}`;
    const apiKeyId = newInternalId();
    const name = cleanText(body?.name) || "API Key";
    await c.env.DB.prepare(
      `
        INSERT INTO api_keys (id, account_id, name, key_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
    )
      .bind(apiKeyId, c.get("auth").account_id, name, await sha256(token), isoNow())
      .run();
    return c.json({ ok: true, apiKey: { id: apiKeyId, name }, token }, 201);
  });

  app.post("/api/api-keys/:apiKeyId/revoke", requireAuth, async (c) => {
    const result = await c.env.DB.prepare(
      `
        UPDATE api_keys SET revoked_at = ?
        WHERE id = ? AND account_id = ? AND revoked_at IS NULL
      `
    )
      .bind(isoNow(), c.req.param("apiKeyId"), c.get("auth").account_id)
      .run();
    if (!result.meta.changes) {
      return c.json({ ok: false, error: "API key not found." }, 404);
    }
    return c.json({ ok: true });
  });

  app.post("/api/uploads", requireAuth, async (c) => {
    const config = getConfig(c.env);
    const ip = clientIp(c.req.raw) || "anonymous";
    const ipLimit = await consumeRateLimit(c.env.DB, {
      keyPrefix: "upload-ip",
      identity: ip,
      ...config.uploadIpRateLimit
    });
    if (!ipLimit.allowed) return rateLimitResponse(c, ipLimit.retryAfter);

    const auth = c.get("auth");
    const keyLimit = await consumeRateLimit(c.env.DB, {
      keyPrefix: "upload-key",
      identity: auth.id,
      ...config.uploadKeyRateLimit
    });
    if (!keyLimit.allowed) return rateLimitResponse(c, keyLimit.retryAfter);

    const body = await readJsonBody(c.req.raw, config.uploadBodyBytes);
    const { html, filename, draftId } = body || {};
    const description = cleanText(body?.description, 1000);
    const metadata = normalizeMetadata(body?.metadata);
    const validation = validateHtml(html, { maxBytes: config.maxHtmlBytes });
    if (!validation.ok) {
      return c.json(
        { ok: false, errors: validation.errors, warnings: validation.warnings },
        422
      );
    }

    const existingDraft = draftId
      ? await findOwnedDraft(c.env.DB, draftId, auth.account_id)
      : null;
    if (draftId && !existingDraft) {
      return c.json({ ok: false, error: "Draft not found." }, 404);
    }

    const resolvedDraftId = existingDraft?.id || newDraftId();
    const versionId = newInternalId();
    const objectKey = `drafts/${resolvedDraftId}/versions/${versionId}.html`;
    const title = validation.title || existingDraft?.title || filename || "Untitled Draft";
    const sourceRequestId = requestId(c.req.raw);
    const stats = validation.stats || { hasInlineScript: false, externalImageHosts: [] };
    await putHtmlObject(c.env.DRAFTS, objectKey, html);

    let stored;
    try {
      stored = await createDraftVersion(c.env.DB, {
        existingDraft,
        draftId: resolvedDraftId,
        accountId: auth.account_id,
        apiKeyId: auth.id,
        versionId,
        objectKey,
        title,
        description,
        contentHash: await contentHash(html),
        fileSize: encoder.encode(html).byteLength,
        sourceIp: clientIp(c.req.raw),
        userAgent: cleanText(c.req.header("user-agent"), 1000),
        originalFilename: cleanText(filename),
        requestId: sourceRequestId,
        hasInlineScript: stats.hasInlineScript,
        externalImageHosts: stats.externalImageHosts,
        metadata
      });
      if (!stored) throw new HttpError(404, "Draft not found.");
    } catch (error) {
      await deleteHtmlObject(c.env.DRAFTS, objectKey).catch((cleanupError) => {
        console.error("Could not remove unreferenced R2 object:", cleanupError);
      });
      throw error;
    }

    const urlOptions = {
      draftId: resolvedDraftId,
      publicBaseUrl: config.publicBaseUrl,
      requestBaseUrl: getRequestBaseUrl(c.req.raw)
    };
    return c.json(
      {
        ok: true,
        draftId: resolvedDraftId,
        versionId,
        versionNumber: stored.versionNumber,
        title,
        requestId: sourceRequestId,
        publicUrl: getDraftPublicUrl(urlOptions),
        rawUrl: getDraftRawUrl(urlOptions),
        warnings: validation.warnings
      },
      draftId ? 200 : 201
    );
  });

  app.delete("/api/drafts/:draftId", requireAuth, async (c) => {
    const result = await c.env.DB.prepare(
      `
        UPDATE drafts SET deleted_at = ?, updated_at = ?
        WHERE id = ? AND account_id = ? AND deleted_at IS NULL
      `
    )
      .bind(isoNow(), isoNow(), c.req.param("draftId"), c.get("auth").account_id)
      .run();
    if (!result.meta.changes) {
      return c.json({ ok: false, error: "Draft not found." }, 404);
    }
    return c.json({ ok: true });
  });

  app.post("/api/drafts/:draftId/disable", requireAuth, async (c) => {
    const config = getConfig(c.env);
    const body = await readJsonBody(c.req.raw, config.uploadBodyBytes);
    const reason = cleanText(body?.reason) || "Disabled by owner.";
    const now = isoNow();
    const result = await c.env.DB.prepare(
      `
        UPDATE drafts SET disabled_at = ?, disabled_reason = ?, updated_at = ?
        WHERE id = ? AND account_id = ? AND deleted_at IS NULL
      `
    )
      .bind(now, reason, now, c.req.param("draftId"), c.get("auth").account_id)
      .run();
    if (!result.meta.changes) {
      return c.json({ ok: false, error: "Draft not found." }, 404);
    }
    return c.json({ ok: true });
  });

  registerWebRoutes(app);

  app.get("/d/:draftId", serveDraft);
  app.get("/d/:draftId/raw", serveDraft);
  app.get("/d/:draftId/v/:versionNumber", serveDraft);
  app.get("/d/:draftId/v/:versionNumber/raw", serveDraft);

  app.notFound((c) => c.html(renderNotFound(), 404));
  app.onError((error, c) => {
    const status = error.statusCode || 500;
    if (status >= 500) console.error(error);
    return c.json(
      { ok: false, error: status >= 500 ? "Internal server error." : error.message },
      status
    );
  });

  return app;
}

async function serveDraft(c) {
  const rawVersion = c.req.param("versionNumber");
  const versionNumber = rawVersion === undefined ? undefined : Number(rawVersion);
  if (
    versionNumber !== undefined &&
    (!Number.isInteger(versionNumber) || versionNumber < 1)
  ) {
    return c.html(renderNotFound(), 404);
  }

  const { draft, version } = await findPublicDraftVersion(
    c.env.DB,
    c.req.param("draftId"),
    versionNumber
  );
  if (!draft || !version) return c.html(renderNotFound(), 404);

  const object = await getHtmlObject(c.env.DRAFTS, version.object_key);
  if (!object) return c.html(renderNotFound(), 404);
  return new Response(object.body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": draftContentSecurityPolicy(),
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Postplan-Draft-Id": draft.id,
      "X-Postplan-Draft-Version": String(Number(version.version_number))
    }
  });
}

async function requireAuth(c, next) {
  const auth = await optionalAuth(c);
  if (!auth) {
    return c.json({ ok: false, error: "Missing or invalid API key." }, 401);
  }
  c.set("auth", auth);
  await next();
}

async function optionalAuth(c) {
  const header = c.req.header("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return findApiKeyByToken(
    c.env.DB,
    match[1].trim(),
    getConfig(c.env).bootstrapApiKey
  );
}

async function readJsonBody(request, maxBytes) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new HttpError(413, "Request body is too large.");
  }

  const text = await request.text();
  if (encoder.encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "Request body is too large.");
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function normalizeMetadata(value) {
  const metadata = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    repoOrg: cleanText(metadata.repoOrg),
    repoName: cleanText(metadata.repoName),
    repoHost: cleanText(metadata.repoHost),
    cliVersion: cleanText(metadata.cliVersion),
    gitBranch: cleanText(metadata.gitBranch),
    gitCommitSha: cleanText(metadata.gitCommitSha),
    gitCommitSubject: cleanText(metadata.gitCommitSubject),
    gitDirty: typeof metadata.gitDirty === "boolean" ? metadata.gitDirty : null,
    ciRunUrl: cleanText(metadata.ciRunUrl, 1000),
    ciActor: cleanText(metadata.ciActor),
    ciProvider: cleanText(metadata.ciProvider),
    fileSha256: cleanText(metadata.fileSha256)
  };
}

function rateLimitResponse(c, retryAfter) {
  c.header("Retry-After", String(retryAfter));
  return c.json({ ok: false, error: "Upload rate limit exceeded." }, 429);
}

function draftContentSecurityPolicy() {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src https: data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join("; ");
}

function cleanText(value, maxLength = 255) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}
