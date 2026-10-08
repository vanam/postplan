# Postplan CLI

Upload static HTML drafts to a Postplan server:

```sh
npx @vanam/postplan auth set <api-key> --api-url https://plans.example.com
npx @vanam/postplan upload ./plan.html --api-url https://plans.example.com
npx @vanam/postplan list --api-url https://plans.example.com
```

This repository's CLI defaults to `https://postplan.martinvana.com`. Use `--api-url` or `POSTPLAN_API_URL` to override it. Uploads require a valid API key. Credentials and draft mappings are stored in `~/.postplan`. Uploading the same file again updates its draft; `--new` creates a separate draft. `npx postplan` selects the upstream package; use `npx @vanam/postplan` for this fork after its first publication. You can also install it with `npm install --global @vanam/postplan` and run `postplan` directly.

Run `pnpm cli --help` for all commands from this repository. The Worker supports folders, path-based slugs, authenticated readiness checks, unchanged uploads, and classic inline scripts in a sandbox.

Browser sign-in is disabled by default on this server. Use the bootstrap key or another key created through the API. `auth login` requires the server to opt in to browser sign-in with `POSTPLAN_WEB_AUTH_ENABLED=true`.

```sh
pnpm cli check ./site --slug warehouse-plan
pnpm cli upload ./site --slug warehouse-plan --json
pnpm cli upload ./site --draft <draft-id> --slug renamed-plan
```

Folders need `index.html` and contain HTML pages only, with a default limit of 20 pages and 512 KiB total. Slugs use `/s/<slug>/` on the server's hostname. The same slug updates its owned draft. Unchanged HTML returns the current version; changing content creates a version. JSON receipts include version URLs, hashes, byte counts, account details, and page manifests.

Without credentials, `check` validates markup locally and exits with a report marked `offline: true` and `ok: false`. It cannot verify publication readiness, account limits, or slug ownership. Upload always requires authentication. `POSTPLAN_API_KEY` can supply the key through the environment; `.env` is not loaded automatically.

## Local development

From the repository root, install with `pnpm install` and run:

```sh
pnpm cli --help
pnpm cli auth set <api-key> --api-url http://localhost:8787
pnpm cli upload ./plan.html --api-url http://localhost:8787
pnpm --filter ./packages/cli test
```

To build the npm tarball without publishing:

```sh
pnpm pack:cli
npx --yes --package ./postplan-cli.tgz postplan --help
```

## npm releases

`.github/workflows/publish-cli.yml` runs on pushes to `master` that change `packages/cli/**` or `packages/html-policy/**`. The shared validator is included because it is bundled into the CLI. Server-only changes and root lockfile changes alone do not trigger a CLI release.

The workflow tests both packages, builds the tarball, verifies its executable, and publishes through npm trusted publishing. If the version in `packages/cli/package.json` already exists on npm, it skips publication. Bump that version in the same commit as changes you want to release. The workflow does not commit version changes or require an npm token.

One-time setup for the new `@vanam/postplan` package:

1. Publish the initial package from the repository root after running the CLI and validator tests:
   ```sh
   pnpm --filter ./packages/cli --filter ./packages/html-policy test
   pnpm pack:cli
   npm login
   npm publish ./postplan-cli.tgz --access public
   ```
2. In the npm package settings, add a GitHub Actions trusted publisher with organization/user `vanam`, repository `postplan`, and workflow filename `publish-cli.yml`. Leave the environment field empty and allow direct publishing.
3. Bump the CLI version for the next release and push the change to `master`. Complete that first automated publication within two days of creating the trusted publisher configuration, or npm requires you to recreate it.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for account setup and authentication requirements. Published package versions cannot be overwritten.

## Source

The CLI and validator started from the MIT-licensed [postplan@0.0.5 npm release](https://www.npmjs.com/package/postplan/v/0.0.5). The default API URL and authentication behavior are adapted for this server. The shared validator lives in `packages/html-policy`; the build includes it in `dist/postplan.js`. Use the root `pack:cli` command to build explicitly even when lifecycle scripts are disabled. The tarball needs only Commander and parse5 from npm, with no workspace dependencies at runtime. The upstream server implementation and server-only dependencies are excluded.

The bundled `html-communication` and `postplan-read` skills come from Martin's local `C:\Users\Martin\.agents\skills` directory. The read skill's URL description is updated for this server. The upstream deprecated `postplan` alias is not included.
