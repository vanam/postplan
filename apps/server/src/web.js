import { getConfig } from "./config.js";
import { clientIp } from "./client-ip.js";
import { findOrCreateAccountForIdentity, isoNow } from "./db.js";
import { randomToken, sha256 } from "./crypto.js";
import { newInternalId } from "./ids.js";
import { getAccountDraftWithVersions, listAccountDrafts } from "./drafts.js";
import { getHomeUrl, getRequestBaseUrl } from "./public-url.js";
import { consumeRateLimit } from "./rate-limit.js";
import { buildAuthorizeUrl, buildPkce, exchangeCode, verifyIdToken } from "./shoo.js";
import {
  clearAuthStateCookie,
  clearSessionCookie,
  createAuthStateCookie,
  createSessionCookie,
  readAuthState,
  readSession
} from "./web-auth.js";
import {
  renderAuthError,
  renderApiKey,
  renderApiKeys,
  renderDashboard,
  renderDraftDetail,
  renderSignIn
} from "./render-web.js";

export function registerWebRoutes(app) {
  app.get("/auth/sign-in", requireConfigured, async (c) => {
    const config = getConfig(c.env);
    const { verifier, challenge, state } = await buildPkce();
    const next = safeNextPath(c.req.query("next"));
    const redirectUri = callbackUrl(config, c.req.raw);
    appendCookie(
      c,
      await createAuthStateCookie(
        { state, verifier, next },
        config.sessionSecret,
        { secure: isSecure(c.req.raw) }
      )
    );
    return c.redirect(
      buildAuthorizeUrl({
        shooBaseUrl: config.shooBaseUrl,
        redirectUri,
        state,
        challenge
      })
    );
  });

  app.get("/auth/callback", requireConfigured, async (c) => {
    const config = getConfig(c.env);
    appendCookie(c, clearAuthStateCookie({ secure: isSecure(c.req.raw) }));

    if (c.req.query("error") === "access_denied") {
      return c.html(
        renderAuthError({
          message:
            "Sign-in was cancelled or consent was declined. Postplan uses your email and profile picture to identify your account. Retry and approve to continue."
        }),
        403
      );
    }

    const authState = await readAuthState(c.req.raw, config.sessionSecret);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!authState || !state || state !== authState.state) {
      return c.html(
        renderAuthError({ message: "Sign-in expired or state mismatch. Please retry." }),
        400
      );
    }
    if (!code) {
      return c.html(renderAuthError({ message: "Missing authorization code." }), 400);
    }

    let claims;
    try {
      const redirectUri = callbackUrl(config, c.req.raw);
      const tokens = await exchangeCode({
        shooBaseUrl: config.shooBaseUrl,
        code,
        verifier: authState.verifier,
        redirectUri
      });
      claims = await verifyIdToken(tokens.id_token, {
        shooBaseUrl: config.shooBaseUrl,
        audOrigin: webOrigin(config, c.req.raw)
      });
    } catch (error) {
      console.error("shoo sign-in failed:", error.message);
      return c.html(
        renderAuthError({ message: "Sign-in could not be completed. Please retry." }),
        502
      );
    }

    const account = await findOrCreateAccountForIdentity(c.env.DB, {
      provider: "shoo",
      subject: claims.pairwise_sub,
      profile: {
        email: claimText(claims.email),
        emailVerified:
          typeof claims.email_verified === "boolean" ? claims.email_verified : null,
        displayName: claimText(claims.name),
        pictureUrl: claimText(claims.picture),
        piiSubject: claimText(claims.pii_sub)
      }
    });

    appendCookie(
      c,
      await createSessionCookie(account, config.sessionSecret, {
        secure: isSecure(c.req.raw)
      })
    );
    return c.redirect(safeNextPath(authState.next));
  });

  app.post("/auth/sign-out", (c) => {
    appendCookie(c, clearSessionCookie({ secure: isSecure(c.req.raw) }));
    return c.redirect("/");
  });

  app.get("/dashboard", requireConfigured, async (c) => {
    const config = getConfig(c.env);
    const session = await readSession(c.req.raw, config.sessionSecret);
    if (!session) return c.html(renderSignIn({ next: "/dashboard" }));

    const drafts = await listAccountDrafts(c.env.DB, session.accountId, {
      publicBaseUrl: config.publicBaseUrl,
      requestBaseUrl: getRequestBaseUrl(c.req.raw)
    });
    return c.html(renderDashboard({ session, drafts }));
  });

  app.get("/dashboard/drafts/:draftId", requireConfigured, async (c) => {
    const config = getConfig(c.env);
    const session = await readSession(c.req.raw, config.sessionSecret);
    if (!session) return c.html(renderSignIn({ next: "/dashboard" }));

    const result = await getAccountDraftWithVersions(
      c.env.DB,
      session.accountId,
      c.req.param("draftId"),
      {
        publicBaseUrl: config.publicBaseUrl,
        requestBaseUrl: getRequestBaseUrl(c.req.raw)
      }
    );
    if (!result) return c.notFound();
    return c.html(
      renderDraftDetail({ session, draft: result.draft, versions: result.versions })
    );
  });

  app.get("/settings/api-keys", requireConfigured, async (c) => {
    const config = getConfig(c.env);
    const session = await readSession(c.req.raw, config.sessionSecret);
    if (!session) return c.html(renderSignIn({ next: "/settings/api-keys" }));
    return c.html(
      renderApiKeys({
        session,
        keys: await listAccountApiKeys(c.env.DB, session.accountId)
      })
    );
  });

  app.get("/cli/auth", (c) => c.redirect("/settings/api-keys"));

  app.post("/settings/api-keys", requireConfigured, async (c) => {
    const config = getConfig(c.env);
    const session = await readSession(c.req.raw, config.sessionSecret);
    if (!session) return c.html(renderSignIn({ next: "/settings/api-keys" }));

    const limit = await consumeRateLimit(c.env.DB, {
      keyPrefix: "key-mint",
      identity: session.accountId || clientIp(c.req.raw) || "anonymous",
      ...config.keyMintRateLimit
    });
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfter));
      return c.json({ ok: false, error: "API key rate limit exceeded." }, 429);
    }

    const token = `pp_${randomToken(32)}`;
    const keyName = `Web · ${new Date().toISOString().slice(0, 10)}`;
    await c.env.DB.prepare(
      "INSERT INTO api_keys (id, account_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(newInternalId(), session.accountId, keyName, await sha256(token), isoNow())
      .run();

    return c.html(renderApiKey({ session, token, keyName }));
  });

  app.post("/settings/api-keys/:apiKeyId/revoke", requireConfigured, async (c) => {
    const config = getConfig(c.env);
    const session = await readSession(c.req.raw, config.sessionSecret);
    if (!session) return c.html(renderSignIn({ next: "/settings/api-keys" }));

    await c.env.DB.prepare(
      `
        UPDATE api_keys SET revoked_at = ?
        WHERE id = ? AND account_id = ? AND revoked_at IS NULL
      `
    )
      .bind(isoNow(), c.req.param("apiKeyId"), session.accountId)
      .run();
    return c.redirect("/settings/api-keys");
  });
}

async function requireConfigured(c, next) {
  const config = getConfig(c.env);
  if (!config.sessionSecret || !config.publicBaseUrl) {
    return c.html(
      renderAuthError({
        message:
          "Web sign-in is not configured on this deployment (POSTPLAN_SESSION_SECRET / POSTPLAN_PUBLIC_BASE_URL)."
      }),
      503
    );
  }
  await next();
}

async function listAccountApiKeys(db, accountId) {
  const result = await db
    .prepare(
      `
        SELECT id, name, created_at, last_used_at
        FROM api_keys
        WHERE account_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC
      `
    )
    .bind(accountId)
    .all();
  return result.results;
}

function webOrigin(config, request) {
  return getHomeUrl({
    publicBaseUrl: config.publicBaseUrl,
    requestBaseUrl: getRequestBaseUrl(request)
  });
}

function callbackUrl(config, request) {
  return `${webOrigin(config, request)}/auth/callback`;
}

function claimText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function safeNextPath(value) {
  if (typeof value !== "string") return "/dashboard";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/dashboard";
  }
  return value;
}

function appendCookie(c, value) {
  c.header("Set-Cookie", value, { append: true });
}

function isSecure(request) {
  return new URL(request.url).protocol === "https:";
}
