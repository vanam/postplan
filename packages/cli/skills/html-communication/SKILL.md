---
name: html-communication
description: Use when the user asks to communicate through an HTML document, or if they mention "HTML" with no additional context.
metadata:
  harness: [claude, codex]
  platform: [darwin, linux]
  scope: fleet
  requires: "npx (@vanam/postplan is run via npx)"
---

# HTML Communication

## When to Use

Use this skill when the user wants a plan, spec, write-up, findings, summary,
report, comparison, or set of UI mocks presented as readable HTML.

Do not use it for HTML that ships as part of a product.

## Document

Default to one self-contained HTML file. Use a folder when separate pages make
the document easier to read. Folders require `index.html`, contain only `.html`
files, and may use nested relative links such as `guide/setup.html` or
`../index.html`. Keep CSS, scripts, and SVG inline on each page; local image and
stylesheet files are not uploaded. Default server limits are 20 pages and
512 KiB total across all HTML files; `check` reports the account's actual limits.

- Write it like a spec, not a landing page: dense, scannable, no hero,
  decorative chrome, marketing voice, or em dashes.
- Default to true black (`#000`), white primary text, and dark gray only for
  secondary surfaces or accents.
- Make it mobile-readable with a responsive viewport and no fixed-width layout.
- Use semantic HTML, inline CSS, inline SVG, and HTTPS or data-URL images.
- Use an inline classic script only when interactivity materially helps. Keep
  scripted pages useful without JavaScript; the sandbox blocks storage, fetch,
  workers, frames, forms, and popups.
- In script-free files, give external links `target="_blank"` and
  `rel="noopener noreferrer"`. If any script exists, omit `target="_blank"`.

Never include external or module scripts, inline event handlers, `javascript:`
URLs, forms, frames, embeds, objects, applets, meta refresh, linked stylesheets,
secrets, private URLs, or local filesystem paths.

## UI Mocks

When the user asks for variants:

- Render real styled variants, not descriptions.
- Label them `A`, `B`, `C`... for easy selection.
- Lay them out for direct comparison.
- Keep one file across iterations so its Postplan URL stays stable.

## Publish

Martin has given standing permission to upload every artifact created or updated
with this skill. Upload is required, including in Auto mode. Do not ask for
separate permission or stop at the local file.

Run commands with `npx @vanam/postplan`; no repository checkout is needed.
The default server is `https://postplan.martinvana.com`. Upload requires an API key
from `POSTPLAN_API_KEY` or saved CLI credentials. Environment variables are
inherited by the CLI; `.env` files are not loaded automatically. If needed,
load them into the shell environment before invoking npx. Never print the key,
include it in the HTML, or commit it. Browser sign-in is disabled by default;
use `npx @vanam/postplan auth set <api-key>` to save an existing key rather than
relying on `auth login`.

1. Write the HTML file or folder locally.
2. Run `npx @vanam/postplan check <path> --json` before uploading. Use the same `--slug`
   option for check and upload if choosing a custom URL. Fix validation errors;
   an offline report validates local markup only and does not confirm readiness.
   If credentials are missing or rejected, request authentication before upload.
3. Run `npx @vanam/postplan upload <path> --json`, then report the local path and
   returned Postplan URL.

Re-upload the same absolute file or folder path to update its existing draft.
Identical HTML and script permission return the existing version as unchanged;
changed content creates a new version. Use `--draft <draft-id>` when explicitly
targeting a known draft. Use `--new` only when a separate draft is wanted;
it cannot be combined with `--draft` or `--slug`.

Use `--slug <name>` when a stable, readable URL helps. Slugs use 1 to 63
lowercase letters, digits, and internal hyphens and publish at `/s/<name>/`.
The same owned slug updates the same draft, regardless of the local path.
Choose an unused slug for a new artifact; reuse an owned slug only when updating
that artifact. A slug owned by another account is a conflict; choose another.
To rename an existing draft, supply both `--draft <draft-id>` and `--slug <name>`.

For example, publish a folder:

```sh
npx @vanam/postplan check ./plan --slug migration-plan --json
npx @vanam/postplan upload ./plan --slug migration-plan --json
```

Preserve requested interactivity when fixing validation or authentication errors.

Never open a browser or claim the document is hosted before upload succeeds.
Do not verify in a browser unless the user asks.
