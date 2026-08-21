# Postplan

Postplan is a Cloudflare Worker for publishing static HTML drafts. The npm package contains only the server implementation; clients use its HTTP API.

## Fork and deploy your own

1. Fork this repository on GitHub, clone the fork, and install its dependencies:

   ```sh
   git clone https://github.com/<your-account>/postplan.git
   cd postplan
   pnpm install
   ```

2. Create the Cloudflare resources. Keep the resource names shown here because they are shared by the generated Wrangler configuration.

   ```sh
   pnpm exec wrangler login
   pnpm exec wrangler d1 create postplan
   pnpm exec wrangler r2 bucket create postplan-drafts
   ```

   Save the `database_id` printed by the D1 command.

3. Enable GitHub Actions for the fork if GitHub asks, then open **Settings > Secrets and variables > Actions** and add these repository secrets:

   | Secret | Purpose |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | A scoped token that can deploy Workers, edit D1 and R2 resources, and edit Worker routes |
   | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account that owns the Worker and storage resources |
   | `POSTPLAN_DOMAIN_PRODUCTION` | The exact custom hostname, such as `plans.example.com` |
   | `POSTPLAN_D1_DATABASE_ID_PRODUCTION` | The `database_id` returned in step 2 |

4. Push to `master`. The deploy workflow generates `wrangler.production.jsonc`, applies D1 migrations, and deploys the Worker.

5. Set these Worker secrets once in **Workers & Pages > postplan > Settings > Variables and Secrets**:

   - `POSTPLAN_BOOTSTRAP_API_KEY` establishes the first administrative API key.
   - `POSTPLAN_SESSION_SECRET` signs browser sessions and must contain at least 32 random bytes.

   You can also generate the production config locally and use Wrangler:

   ```sh
   POSTPLAN_DOMAIN_PRODUCTION=plans.example.com \
   POSTPLAN_D1_DATABASE_ID_PRODUCTION=<database_id> \
   node scripts/generate-wrangler-config.js production

   pnpm exec wrangler secret put POSTPLAN_BOOTSTRAP_API_KEY --config wrangler.production.jsonc
   pnpm exec wrangler secret put POSTPLAN_SESSION_SECRET --config wrangler.production.jsonc
   ```

6. Check the deployment:

   ```sh
   curl --fail https://plans.example.com/healthz
   ```

The repository tracks only `wrangler.jsonc`. It contains the common Worker, assets, R2, cron, and local D1 settings. `scripts/generate-wrangler-config.js` merges the account-specific domain and D1 ID into `wrangler.<environment>.jsonc`; generated configs remain gitignored.

## Worker services

The server uses two Cloudflare bindings:

- `DB`, a D1 database containing accounts, API keys, draft metadata, audit events, identities, and rate-limit counters.
- `DRAFTS`, a private R2 bucket containing the exact uploaded HTML bytes.

The D1 ID in the checked-in Wrangler configuration is a placeholder used by local development and tests. Do not replace it with an account-specific production ID.

Apply the schema locally and start the Worker:

```sh
cp .dev.vars.example .dev.vars
pnpm run db:migrate
pnpm run dev
```

Local D1 and R2 data live under `.wrangler/state`.

## Use the npm client

This repository does not ship a CLI executable. `npx postplan` downloads the published Postplan client from npm and points it at this Worker.

Upload to a local Worker without signing in:

```sh
npx postplan upload ./plan.html --api-url http://localhost:8787
```

For a deployed Worker, pass its exact base URL. The client otherwise defaults to `https://postplan.dev`.

```sh
npx postplan upload ./plan.html \
  --description "Q3 warehouse migration plan" \
  --api-url https://plans.example.com
```

Anonymous uploads work, but they do not appear in your dashboard. Sign in before uploading drafts that should belong to your account:

```sh
npx postplan auth login --api-url https://plans.example.com
```

The command opens the Worker's API-key page. Generate a key there, then paste it into the terminal prompt. You can also save an existing key directly:

```sh
npx postplan auth set <api-key> --api-url https://plans.example.com
```

Once authenticated, list your drafts with:

```sh
npx postplan list --api-url https://plans.example.com
```

Uploading the same local file again creates a new version of its existing draft. Add `--new` to create a separate draft instead. The client stores credentials and local draft mappings in `~/.postplan`.

## HTTP API

Upload a draft by sending its HTML as JSON. Authentication is optional for uploads:

```sh
jq -n --rawfile html ./plan.html \
  '{html: $html, filename: "plan.html"}' \
  | curl --fail-with-body http://localhost:8787/api/uploads \
      --header 'Content-Type: application/json' \
      --data-binary @-
```

Add `Authorization: Bearer <api-key>` to associate an upload with an account. Supply the returned `draftId` in a later upload to create a new version of the same draft:

```json
{
  "html": "<!doctype html><title>Plan</title><h1>Updated plan</h1>",
  "filename": "plan.html",
  "description": "Q3 warehouse migration plan",
  "draftId": "existing-draft-id"
}
```

Authenticated endpoints use the same bearer header:

- `GET /api/me`
- `GET /api/drafts`
- `POST /api/api-keys`
- `POST /api/api-keys/:apiKeyId/revoke`
- `DELETE /api/drafts/:draftId`
- `POST /api/drafts/:draftId/disable`

Set `POSTPLAN_BOOTSTRAP_API_KEY` to establish the first administrative API key. A signed-in user can also create and revoke keys at `/settings/api-keys`.

## Configuration

Set these secrets with `wrangler secret put` in production:

- `POSTPLAN_BOOTSTRAP_API_KEY` enables the initial administrative account. The Worker creates or updates its D1 row when the key is first used.
- `POSTPLAN_SESSION_SECRET` signs browser sessions and OAuth state. If it is absent, browser authentication routes return `503`; uploads and draft serving continue to work.

The generated production configuration sets `POSTPLAN_PUBLIC_BASE_URL` to `https://<POSTPLAN_DOMAIN_PRODUCTION>`. For local development, set it in `.dev.vars`.

You can set these optional ordinary variables in the shared `vars` section of `wrangler.jsonc`; the generator preserves them:

- `SHOO_BASE_URL` defaults to `https://shoo.dev`.
- `MAX_HTML_BYTES` defaults to `524288`.
- `UPLOAD_BODY_LIMIT` defaults to `2mb`.
- `UPLOAD_IP_RATE_LIMIT_WINDOW_MS` and `UPLOAD_IP_RATE_LIMIT_MAX` default to `60000` and `60`.
- `UPLOAD_RATE_LIMIT_WINDOW_MS` and `UPLOAD_RATE_LIMIT_MAX` default to `60000` and `30`.
- `KEY_MINT_RATE_LIMIT_WINDOW_MS` and `KEY_MINT_RATE_LIMIT_MAX` default to `3600000` and `10`.

Postplan supports one exact hostname per request. It does not route drafts by subdomain.

## Manual deployment

Generate an account-specific config, apply migrations, and deploy:

```sh
POSTPLAN_DOMAIN_PRODUCTION=plans.example.com \
POSTPLAN_D1_DATABASE_ID_PRODUCTION=<database_id> \
node scripts/generate-wrangler-config.js production

pnpm run db:migrate:remote
pnpm run deploy
pnpm exec wrangler secret put POSTPLAN_BOOTSTRAP_API_KEY --config wrangler.production.jsonc
pnpm exec wrangler secret put POSTPLAN_SESSION_SECRET --config wrangler.production.jsonc
```

Check the deployment:

```sh
curl --fail https://plans.example.com/healthz
jq -n --rawfile html ./plan.html \
  '{html: $html, filename: "plan.html"}' \
  | curl --fail-with-body https://plans.example.com/api/uploads \
      --header 'Content-Type: application/json' \
      --data-binary @-
```

The daily scheduled handler removes expired rate-limit rows. It does not delete drafts or HTML objects.

## Browser sign-in

`/dashboard` lists a signed-in account's drafts and `/settings/api-keys` manages its API keys. Sign-in uses [shoo](https://github.com/pingdotgg/shoo) with PKCE and an ES256 ID token. Postplan stores the stable `pairwise_sub` identity plus profile fields approved by the user, then issues its own 30-day HMAC-signed session cookie.

Uploads made with an API key belong to that key's account. Anonymous uploads belong to the shared public-upload account.

Each draft version records the Cloudflare client IP and `CF-Ray` request ID, client and Git metadata, CI metadata, file size, content hash, inline-script presence, and external image hosts. Client-supplied Git and CI fields are audit data only.

## HTML policy

Postplan permits inline classic JavaScript at upload time, but the serving CSP prevents scripts from running in a browser. The validator rejects:

- External or module scripts.
- Inline event-handler attributes and JavaScript URLs.
- Forms, iframes, embeds, objects, applets, and `srcdoc`.
- Meta refresh redirects and unsafe inline CSS constructs.
- Documents larger than the configured byte or nesting limits.

Draft responses use `script-src 'none'`, `connect-src 'none'`, and `form-action 'none'`. The Worker serves the stored R2 body without rewriting it.

## Draft URLs

Every draft uses path-style URLs:

- `/d/<draft-id>`
- `/d/<draft-id>/raw`
- `/d/<draft-id>/v/<number>`
- `/d/<draft-id>/v/<number>/raw`

The canonical and `/raw` forms return the same HTML bytes. Responses include `X-Postplan-Draft-Id` and `X-Postplan-Draft-Version`.

## Verification

```sh
pnpm test
pnpm run check:bundle
pnpm pack --dry-run
```

The test suite runs inside the Cloudflare Workers runtime with isolated D1 and R2 bindings.
