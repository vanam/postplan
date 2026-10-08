import { Hono } from "hono";
import { getConfig, requireBinding } from "./config.js";
import { randomToken, sha256 } from "./crypto.js";
import {
  findApiKeyByToken,
  isoNow
} from "./db.js";
import { listAccountDrafts } from "./drafts.js";
import { newInternalId } from "./ids.js";
import { getHomeUrl, getRequestBaseUrl } from "./public-url.js";
import { renderHome, renderNotFound } from "./render.js";
import { HttpError } from "./http.js";
import { registerUploadRoutes } from "./uploads.js";
import { registerWebRoutes } from "./web.js";

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
      apiKeyName: auth.name,
      flags: []
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

  registerUploadRoutes(app, { requireAuth, readJsonBody, normalizeMetadata, cleanText, rateLimitResponse });

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

  const chunks = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new HttpError(413, "Request body is too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body;
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

function rateLimitResponse(c, retryAfter, message = "Upload rate limit exceeded.") {
  c.header("Retry-After", String(retryAfter));
  return c.json({ ok: false, error: message }, 429);
}

function cleanText(value, maxLength = 255) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}
