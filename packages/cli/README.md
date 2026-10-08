# Postplan CLI

Upload static HTML drafts to a Postplan server:

```sh
npx postplan auth login --api-url https://plans.example.com
npx postplan upload ./plan.html --api-url https://plans.example.com
npx postplan list --api-url https://plans.example.com
```

This repository's CLI defaults to `https://postplan.martinvana.com`. Use `--api-url` or `POSTPLAN_API_URL` to override it. Uploads require a valid API key. Credentials and draft mappings are stored in `~/.postplan`. Uploading the same file again updates its draft; `--new` creates a separate draft. Until this copy is published, `npx postplan` runs the upstream npm release, so pass `--api-url https://postplan.martinvana.com` when using it.

Run `npx postplan --help` for all commands. Folder uploads, custom slugs, and online readiness checks require server support; this repository's Cloudflare Worker currently supports single-file uploads, authentication, and listing drafts.

## Local development

From the repository root, install with `pnpm install` and run:

```sh
pnpm cli --help
pnpm cli auth set <api-key> --api-url http://localhost:8787
pnpm cli upload ./plan.html --api-url http://localhost:8787
pnpm --filter postplan test
```

To build the npm tarball without publishing:

```sh
pnpm --filter postplan pack --out postplan-cli.tgz
npx --yes --package ./postplan-cli.tgz postplan --help
```

## Source

The CLI (`bin/postplan.js`), offline HTML validator (`src/html-policy.js`), and license come from the MIT-licensed [postplan@0.0.5 npm release](https://www.npmjs.com/package/postplan/v/0.0.5). The CLI's default API URL is changed to `https://postplan.martinvana.com`, and its slug help text is domain-independent. Its server implementation and server-only dependencies are excluded.

The bundled `html-communication` and `postplan-read` skills come from Martin's local `C:\Users\Martin\.agents\skills` directory. The read skill's URL description is updated for this server. The upstream deprecated `postplan` alias is not included.
