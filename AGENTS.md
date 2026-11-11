# Agent Rules — DocDown

## Skills

Project-local skills live in `.opencode/skills/`. Load the matching skill with
the `skill` tool before acting.

- New feature / rewrite: `planning-and-task-breakdown` → `incremental-implementation` → `test-driven-development` → `code-review-and-quality`
- Bug / regression: `debugging-and-error-recovery` → `test-driven-development` → `code-review-and-quality`
- Security review: `security-and-hardening`
- Performance / RAM: `performance-optimization` (measure first, optimize only what the evidence shows)
- Refactor / simplify: `code-simplification`
- Chrome extension / manifest / content script: `chrome-extensions`

## Non-negotiable

- Do not claim work is complete without evidence: tests, syntax checks, JSON
  validation, or documented browser verification.
- Read the existing code before changing it. Do not delete unfamiliar work.
- Prefer the smallest change that fixes the root cause.
- Do not add a runtime dependency without explicit approval.

## Verification

Run these before reporting completion:

```powershell
Get-ChildItem lib\*.js, providers\*.js, content\*.js, background.js, print.js | ForEach-Object { node --check $_.FullName }
node --test test/core.test.mjs test/tailieu.test.mjs test/scribd.test.mjs test/slideshare.test.mjs test/coursehero.test.mjs test/academia.test.mjs test/manifest.test.mjs test/background.test.mjs test/print.test.mjs
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

For the browser path, load the unpacked extension and test:

- a free document on `studocu.vn` and `studocu.com`, including a 375 px viewport;
- a TaiLieu.VN document with a full public PDF, one with a truncated PDF, and
  one without a public PDF, including a 375 px viewport;
- a Scribd document that loads every page, and one with blurred pages, including
  a 375 px viewport;
- a SlideShare presentation, including a 375 px viewport;
- a Course Hero file, confirming the preview note and that no blurred image is
  embedded, including a 375 px viewport;
- an Academia.edu work page, confirming the viewer pages render as text and
  fonts (not screenshots), missing pages become white note pages, and the
  375 px viewport still saves a PDF.

## Architecture

- `lib/` holds site-agnostic code: `core.js` (namespace, fetch, files, reset),
  `sanitize.js` (page fragment sanitising), `render.js` (print document),
  `registry.js` (provider lookup, host and asset allowlists).
- `providers/<id>.js` owns everything site-specific. It registers itself with
  `DocDown.registerProvider({ id, domains, assetHosts, isDocumentPage,
  isAvailable, isAllowedAssetUrl, actionLabel, run, start })`.
- Adding a site means adding one provider file plus manifest entries. Do not
  branch on hostnames inside `lib/`.

## DocDown constraints

- Manifest V3 only. Do not add permissions unless the feature cannot work
  without them.
- Approved permissions: `cookies` and `browsingData`, plus `host_permissions`
  for the four Studocu domains, `tailieu.vn`, `scribd.com`, `scribdassets.com`,
  `slideshare.net`, `slidesharecdn.com`, `coursehero.com`, `academia.edu` and
  `attachments.academia-assets.com`. They exist for the
  Reset phiên flow (removing `HttpOnly` cookies, HTTP cache, and service
  workers) and for site detection. Ask before adding more.
- Only fetch from:
  - `https://doc-assets.studocu.com/` and `https://website-assets.studocu.com/`;
  - `https://cdn.tailieu.vn/files/source/` and `https://cdn.tailieu.vn/files/html/`;
  - `https://html.scribdassets.com/<prefix>/pages/`, `/images/` and `/fonts/`;
  - `https://image.slidesharecdn.com/<location>/<quality>/<slug>-<n>-<width>.jpg`
    (displayed with `<img>` only: the CDN sends no CORS headers);
  - Course Hero pages are read from the rendered DOM; only clear
    `https://www.coursehero.com/asset/bg/<hash>/…` artwork may be embedded, never
    a `/blur/` path. Do not strip CSS blur classes or filters: a page counts as
    readable only when the server already sent the clear content;
  - Academia.edu page HTML, images and fonts from
    `https://attachments.academia-assets.com/<attachmentId>/` only. Page CSS is
    extracted, sanitised, and injected once into the print document; it is never
    kept inside the fetched fragment.
- Validate every fetched URL: HTTPS, allowlisted host, no path traversal, and
  the expected file type before saving.
- Sanitize fetched page HTML: remove `script`, `iframe`, `object`, `embed`,
  `link`, `style`, `on*` attributes, and `javascript:` URLs.
- Never use `eval`, `new Function`, or unsanitized `innerHTML` with fetched
  content.
- Content scripts: use `document_idle`, specific domain matches, a scoped and
  debounced `MutationObserver`, and cleanup on `pagehide`.
- Limit concurrent fetches to 6 or fewer. Release data URLs, blobs, and large
  strings after use.
- Keep the extension bundle under 100 KB if feasible.
- Test on `studocu.vn`, `studocu.com` and `tailieu.vn`, including a 375 px
  mobile viewport.
- Locked/premium pages must be rendered as white note pages with an
  explanation. Never embed a blurred preview in the PDF and never fabricate
  content the server did not send. A truncated TaiLieu.VN PDF is labelled as a
  preview instead of being padded out.
