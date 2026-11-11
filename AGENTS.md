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
Get-ChildItem lib\*.js, providers\*.js, content\*.js, background.js, print.js, merge.js | ForEach-Object { node --check $_.FullName }
node --test test/core.test.mjs test/tailieu.test.mjs test/scribd.test.mjs test/slideshare.test.mjs test/coursehero.test.mjs test/academia.test.mjs test/manifest.test.mjs test/background.test.mjs test/print.test.mjs test/stream.test.mjs test/merge.test.mjs
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
- an Academia.edu work with about 510 pages: part 1 must cover pages 1–256
  (the 16-page probe is inside part 1, never a separate part), **Phần tiếp
  theo** must replace the same print tab with part 2, pages 257–510, and the
  saved names must include the part and range, for example
  `… - phần 1 (trang 1–256).pdf` and `… - phần 2 (trang 257–510).pdf`; the last
  part must show **Ghép PDF**, and the merge page must accept both saved PDFs,
  check the expected 510-page total and produce one PDF with continuous page
  order, including at a 375 px viewport;
- close the Academia print tab mid-part, click **Tải PDF**, and confirm it
  resumes at the first page of the unfinished part without redoing a part that
  was already saved;
- confirm Academia missing/gated pages become white note pages and that no
  blurred or fabricated page is embedded.

## Architecture

- `lib/` holds site-agnostic code: `core.js` (namespace, fetch, files, reset),
  `sanitize.js` (page fragment sanitising), `render.js` (print document),
  `registry.js` (provider lookup, host and asset allowlists).
- `providers/<id>.js` owns everything site-specific. It registers itself with
  `DocDown.registerProvider({ id, domains, assetHosts, isDocumentPage,
  isAvailable, isAllowedAssetUrl, actionLabel, run, start })`.
- `print.html`/`print.js` is the print page. `content/ui.js` provides
  `DD.ui.createPrintStream`, the postMessage protocol used by streamed
  providers: ping/ready, begin, append, final, next, printed and failed. One
  print tab is reused; each part replaces the tab's document, and the tab
  reports DOM, image and heap measurements back so the provider can size the
  next part.
- `merge.html`/`merge.js` is the local PDF merge page. It sorts the selected
  part PDFs by the part number in their file names, validates the total page
  count, and merges them with `vendor/pdf-lib.min.js`. `vendor/` holds vendored
  code and its license only; it is not part of the content-script bundle and is
  never fetched at runtime.
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
- Approved vendored dependency: `pdf-lib` 1.17.1 (MIT) at
  `vendor/pdf-lib.min.js` (license at `vendor/pdf-lib.LICENSE`), loaded only by
  `merge.html`. This is an explicit exception to the 100 KB bundle guideline:
  the file is about 525 KB (~513 KiB). Do not add another vendored library or
  load pdf-lib from a CDN. It must not be referenced by `manifest.json`,
  `background.js`, `print.html`, or content scripts, and the merge page must
  not fetch anything or upload the selected PDFs. No new permissions.
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
- Academia.edu has no fixed 300-page cap; do not reintroduce one. Use the
  memory-adaptive streaming planner in `providers/academia.js`: probe 16 pages
  inside part 1 (never as a separate part), at most 256 pages per part, and
  shrink down to 32 pages under RAM pressure or after a failed part. A normal
  510-page work is pages 1–256 and 257–510. Reuse one print tab and never keep
  every part in memory at once. `MAX_DOCUMENT_PAGES` 2000 is only a safety
  guard against corrupt metadata, not a user-facing page cap. Missing/gated
  pages stay white note pages; never embed blurred or fabricated content.
- Locked/premium pages must be rendered as white note pages with an
  explanation. Never embed a blurred preview in the PDF and never fabricate
  content the server did not send. A truncated TaiLieu.VN PDF is labelled as a
  preview instead of being padded out.
