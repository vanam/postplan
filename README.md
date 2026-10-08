# Postplan

Postplan is a Cloudflare Worker for publishing HTML drafts. This pnpm monorepo contains the Cloudflare server in `apps/server`, the publishable `postplan` CLI in `packages/cli`, and their shared validator in `packages/html-policy`.

## Fork and deploy your own

1. Fork this repository on GitHub, clone the fork, and install its dependencies:

   ```sh
   git clone https://github.com/<your-account>/postplan.git
   cd postplan
   pnpm install
   ```

2. Create the Cloudflare resources. Keep the resource names shown here because they are shared by the generated Wrangler configuration.

   ```sh
   pnpm --filter @postplan/server exec wrangler login
   pnpm --filter @postplan/server exec wrangler d1 create postplan
   pnpm --filter @postplan/server exec wrangler r2 bucket create postplan-drafts
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
   pnpm run config:generate production

   pnpm --filter @postplan/server exec wrangler secret put POSTPLAN_BOOTSTRAP_API_KEY --config wrangler.production.jsonc
   pnpm --filter @postplan/server exec wrangler secret put POSTPLAN_SESSION_SECRET --config wrangler.production.jsonc
   ```

6. Check the deployment:

   ```sh
   curl --fail https://plans.example.com/healthz
   ```

The server tracks only `apps/server/wrangler.jsonc`. It contains the common Worker, assets, R2, cron, and local D1 settings. `apps/server/scripts/generate-wrangler-config.js` merges the account-specific domain and D1 ID into `apps/server/wrangler.<environment>.jsonc`; generated configs remain gitignored.

## Worker services

The server uses two Cloudflare bindings:

- `DB`, a D1 database containing accounts, API keys, draft metadata, audit events, identities, and rate-limit counters.
- `DRAFTS`, a private R2 bucket containing the exact uploaded HTML bytes.

The D1 ID in the checked-in Wrangler configuration is a placeholder used by local development and tests. Do not replace it with an account-specific production ID.

Apply the schema locally and start the Worker:

```sh
cp apps/server/.dev.vars.example apps/server/.dev.vars
pnpm run db:migrate
pnpm run dev
```

Local D1 and R2 data live under `apps/server/.wrangler/state`. Existing root-level local state is left untouched; move it there manually if you want to reuse it.

## Use the npm client

The CLI in `packages/cli` is copied from the published `postplan@0.0.5` package, with only its client dependencies. `npx postplan` still downloads the published client from npm. To run this repository's copy, use `pnpm cli`:

```sh
pnpm cli --help
pnpm cli auth set <api-key> --api-url http://localhost:8787
pnpm cli upload ./plan.html --api-url http://localhost:8787
```

The Worker supports single-page and folder uploads, path-based custom slugs, readiness checks, and sandboxed classic inline scripts. Use the repository CLI until this copy is published. See [the CLI README](packages/cli/README.md) for packaging and source details.

Authenticate with the local Worker before uploading:

```sh
pnpm cli auth set <api-key> --api-url http://localhost:8787
pnpm cli upload ./plan.html --api-url http://localhost:8787
```

This repository's CLI defaults to `https://postplan.martinvana.com`. For another deployed Worker, pass its exact base URL. Until this copy is published, `npx postplan` runs the upstream npm release; pass `--api-url https://postplan.martinvana.com` to target this server.

```sh
npx postplan upload ./plan.html \
  --description "Q3 warehouse migration plan" \
  --api-url https://plans.example.com
```

Uploads require a valid API key and belong to its account. Sign in before uploading:

```sh
npx postplan auth login --api-url https://plans.example.com
```

The command prints the Worker's API-key page URL. Generate a key there, then paste it into the terminal prompt. You can also save an existing key directly:

```sh
npx postplan auth set <api-key> --api-url https://plans.example.com
```

Once authenticated, list your drafts with:

```sh
npx postplan list --api-url https://plans.example.com
```

Uploading the same local file or folder again updates its existing draft. Identical content and script permission return the current version as unchanged; changed content creates a new version. Add `--new` to create a separate draft instead. The client stores credentials and local draft mappings in `~/.postplan`.

```sh
pnpm cli check ./site --slug warehouse-plan
pnpm cli upload ./site --slug warehouse-plan --json
pnpm cli upload ./site --draft <draft-id> --slug renamed-plan
```

Folders require `index.html` and contain HTML pages only. Relative page links work, including nested paths; images must already use HTTPS or data URLs. Slugs use `/s/<slug>/` on the same hostname.

## HTTP API

Upload a draft by sending its HTML as JSON with a valid API key:

```sh
jq -n --rawfile html ./plan.html \
  '{html: $html, filename: "plan.html"}' \
  | curl --fail-with-body http://localhost:8787/api/uploads \
      --header 'Content-Type: application/json' \
      --header 'Authorization: Bearer <api-key>' \
      --data-binary @-
```

Requests with a missing, invalid, or revoked API key return `401`. Supply the returned `draftId` in a later upload to update the same draft:

```json
{
  "html": "<!doctype html><title>Plan</title><h1>Updated plan</h1>",
  "filename": "plan.html",
  "description": "Q3 warehouse migration plan",
  "draftId": "existing-draft-id"
}
```

Authenticated endpoints use the same bearer header:

- `POST /api/uploads`
- `POST /api/check`
- `GET /api/me`
- `GET /api/drafts`
- `POST /api/api-keys`
- `POST /api/api-keys/:apiKeyId/revoke`
- `DELETE /api/drafts/:draftId`
- `POST /api/drafts/:draftId/disable`

Set `POSTPLAN_BOOTSTRAP_API_KEY` to establish the first administrative API key. A signed-in user can also create and revoke keys at `/settings/api-keys`.

For folders, supply `files: [{path: "index.html", html: "..."}, ...]` instead of `html`. Paths must be unique relative `.html` paths; traversal, absolute paths, and reserved top-level names are rejected. An optional `slug` creates or updates an owned draft. Passing both `draftId` and `slug` renames that draft. Slug conflicts return `409`.

Upload receipts include `created`, `unchanged`, `draftId`, `slug`, `versionId`, `versionNumber`, `publicUrl`, `rawUrl`, `versionUrl`, `contentHash`, `totalBytes`, `account`, `pages`, and `warnings`. A folder hash includes its sorted paths and page hashes. Identical uploads do not allocate another version; description or slug changes still apply and are audited. Changing a stored version's script permission requires a new version.

`POST /api/check` accepts the same HTML or page collection and an optional slug, without publishing. An empty object checks readiness only. It returns `ok`, `account`, `flags`, `limits`, `capabilities`, `slug`, `issues`, `errors`, and `warnings`, plus `pages` and `totalBytes` when content is provided. Validation failures return HTTP 200 with `ok: false`; malformed input, authentication, body limits, and rate limits retain their error statuses. Slug statuses are `available`, `owned`, `taken`, `disabled`, or `invalid`; availability is advisory until upload commits.

The CLI can check markup locally without credentials or when the server is unreachable. Such reports are marked `offline: true` and `ok: false`: they do not verify account limits, script permission, or slug availability. An invalid key is an online authentication failure and never falls back to anonymous publishing.

## Configuration

Set these secrets with `wrangler secret put` in production:

- `POSTPLAN_BOOTSTRAP_API_KEY` enables the initial administrative account. The Worker creates or updates its D1 row when the key is first used.
- `POSTPLAN_SESSION_SECRET` signs browser sessions and OAuth state. If it is absent, browser authentication routes return `503`; uploads and draft serving continue to work.

The generated production configuration sets `POSTPLAN_PUBLIC_BASE_URL` to `https://<POSTPLAN_DOMAIN_PRODUCTION>`. For local development, set it in `apps/server/.dev.vars`.

You can set these optional ordinary variables in the shared `vars` section of `apps/server/wrangler.jsonc`; the generator preserves them:

- `SHOO_BASE_URL` defaults to `https://shoo.dev`.
- `MAX_HTML_BYTES` defaults to `524288` across all pages in one upload.
- `MAX_UPLOAD_PAGES` defaults to `20`.
- `UPLOAD_BODY_LIMIT` defaults to `2mb`.
- `UPLOAD_IP_RATE_LIMIT_WINDOW_MS` and `UPLOAD_IP_RATE_LIMIT_MAX` default to `60000` and `60`.
- `UPLOAD_RATE_LIMIT_WINDOW_MS` and `UPLOAD_RATE_LIMIT_MAX` default to `60000` and `30`.
- `KEY_MINT_RATE_LIMIT_WINDOW_MS` and `KEY_MINT_RATE_LIMIT_MAX` default to `3600000` and `10`.
- `CHECK_RATE_LIMIT_WINDOW_MS` and `CHECK_RATE_LIMIT_MAX` default to `60000` and `60`. Checks use a separate quota.

Postplan supports one exact hostname per request. It does not route drafts by subdomain.

## Manual deployment

Generate an account-specific config, apply migrations, and deploy:

```sh
POSTPLAN_DOMAIN_PRODUCTION=plans.example.com \
POSTPLAN_D1_DATABASE_ID_PRODUCTION=<database_id> \
pnpm run config:generate production

pnpm run db:migrate:remote
pnpm run deploy
pnpm --filter @postplan/server exec wrangler secret put POSTPLAN_BOOTSTRAP_API_KEY --config wrangler.production.jsonc
pnpm --filter @postplan/server exec wrangler secret put POSTPLAN_SESSION_SECRET --config wrangler.production.jsonc
```

Check the deployment:

```sh
curl --fail https://plans.example.com/healthz
jq -n --rawfile html ./plan.html \
  '{html: $html, filename: "plan.html"}' \
  | curl --fail-with-body https://plans.example.com/api/uploads \
      --header 'Content-Type: application/json' \
      --header 'Authorization: Bearer <api-key>' \
      --data-binary @-
```

The daily scheduled handler removes expired rate-limit rows. It does not delete drafts or HTML objects.

## Browser sign-in

`/dashboard` lists a signed-in account's drafts and `/settings/api-keys` manages its API keys. Sign-in uses [shoo](https://github.com/pingdotgg/shoo) with PKCE and an ES256 ID token. Postplan stores the stable `pairwise_sub` identity plus profile fields approved by the user, then issues its own 30-day HMAC-signed session cookie.

Uploads belong to the API key's account.

Each draft version records the Cloudflare client IP and `CF-Ray` request ID, client and Git metadata, CI metadata, file size, content hash, inline-script presence, and external image hosts. Client-supplied Git and CI fields are audit data only.

## HTML policy

New authenticated versions may execute classic inline JavaScript in an opaque-origin CSP sandbox. Older versions remain script-blocked until reuploaded as a new version. JSON data blocks are inert and do not enable scripts. The validator rejects:

- External or module scripts.
- Inline event-handler attributes and JavaScript URLs.
- Forms, iframes, embeds, objects, applets, and `srcdoc`.
- Meta refresh redirects and unsafe inline CSS constructs.
- Documents larger than the configured byte or nesting limits.

Scripted versions use `sandbox allow-scripts` without `allow-same-origin`, with `script-src 'unsafe-inline'` and `script-src-attr 'none'`. Other versions use `sandbox` and `script-src 'none'`. All versions block network requests, workers, frames, forms, and base overrides. Sandbox restrictions also block storage, cookies, popups, and top navigation from an embedded draft. External HTTPS images and data images remain allowed. The Worker serves the stored R2 body without rewriting it.

## Draft URLs

Every draft uses path-style URLs:

- `/d/<draft-id>`
- `/d/<draft-id>/raw`
- `/d/<draft-id>/v/<number>`
- `/d/<draft-id>/v/<number>/raw`
- `/d/<draft-id>/guide/setup.html`
- `/d/<draft-id>/raw/guide/setup.html`
- `/d/<draft-id>/v/<number>/guide/setup.html`
- `/d/<draft-id>/v/<number>/raw/guide/setup.html`
- `/s/<slug>/` redirects to the stable draft route

Multi-page index URLs end in `/` so relative links resolve within the draft. Historical links stay within the selected version. Missing pages return 404. Top-level `raw` and `v` page names are reserved. Slugs use 1 to 63 lowercase letters, digits, and internal hyphens. Deleted drafts release slugs; disabled drafts reserve them.

The canonical and `/raw` forms return the same HTML bytes. Responses include `X-Postplan-Draft-Id` and `X-Postplan-Draft-Version`.

## Verification

For an opt-in end-to-end test against production, copy `.env.example` to `.env`, set `POSTPLAN_API_KEY` (preferably for a dedicated test account), and run:

```sh
pnpm test:e2e
```

The test defaults to `https://postplan.martinvana.com`; `POSTPLAN_API_URL` can override it. Node loads the gitignored `.env` on both PowerShell and Bash; existing shell variables take precedence. Missing credentials fail before any requests. The smoke test exercises every registered HTTP route: public pages, account info, key creation/revocation, checking, folder publishing, listing, slug redirects, current/raw/historical pages, disabling, and deletion. Web routes check anonymous sign-in guards, OAuth initiation, invalid callback rejection, and sign-out; they do not complete an OAuth login or verify signed-in dashboard/settings behavior.

It creates one draft and one API key, deletes/revokes only those resources in `finally`, and verifies the draft returns 404. Deletion is soft: audit records and stored HTML remain. This test is separate from `pnpm test` and does not run automatically during deployment.

```sh
pnpm test
pnpm test:integration
pnpm run check:bundle
pnpm pack:cli
```

The server tests run inside the Cloudflare Workers runtime with isolated D1 and R2 bindings. CLI tests run in Node with temporary credentials and a local HTTP server. Root scripts forward server commands to `apps/server`; `pnpm test` runs all three workspaces. `pnpm test:integration` uses disposable local D1/R2 state and test credentials on port 8897. `pnpm pack:cli` explicitly builds the CLI before packing, including when lifecycle scripts are disabled. The validator is bundled, so npm consumers do not need another workspace package.
