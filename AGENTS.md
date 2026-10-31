# Agent Rules — StudocuDown

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

- Do not claim work is complete without evidence: tests, syntax checks, JSON validation, or documented browser verification.
- Read the existing code before changing it. Do not delete unfamiliar work.
- Prefer the smallest change that fixes the root cause.
- Do not add a runtime dependency without explicit approval.

## Verification

Run these before reporting completion:

```powershell
Get-ChildItem content\*.js, background.js | ForEach-Object { node --check $_.FullName }
node --test test/core.test.mjs test/background.test.mjs
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

For the browser path, load the unpacked extension and test a free document on
`studocu.vn` and `studocu.com`, including a 375 px viewport.

## StudocuDown constraints

- Manifest V3 only. Do not add permissions unless the feature cannot work without them.
- Approved permissions: `cookies` and `browsingData`, plus `host_permissions` for
  the four Studocu domains. They exist only for the Reset phiên flow (removing
  `HttpOnly` cookies, HTTP cache, and service workers). Ask before adding more.
- Only fetch from `https://doc-assets.studocu.com/` and `https://website-assets.studocu.com/`.
- Sanitize fetched page HTML: remove `script`, `iframe`, `object`, `embed`, `link`, `style`, `on*` attributes, and `javascript:` URLs.
- Never use `eval`, `new Function`, or unsanitized `innerHTML` with fetched content.
- Content scripts: use `document_idle`, specific domain matches, a scoped and debounced `MutationObserver`, and cleanup on `pagehide`.
- Limit concurrent fetches to 6 or fewer. Release data URLs, blobs, and large strings after printing.
- Keep the extension bundle under 100 KB if feasible.
- Test on `studocu.vn` and `studocu.com`, including a 375 px mobile viewport.
- Locked/premium pages must be rendered as white note pages with an explanation. Never embed a blurred preview in the PDF and never fabricate content the server did not send.
