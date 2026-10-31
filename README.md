# StudocuDown

A Manifest V3 browser extension that adds a **Tải PDF** button to Studocu
document pages. It rebuilds the document from the signed page assets the site
already sends to your browser, then opens a print-ready tab where you can choose
**Save as PDF**. It also ships a **Reset phiên** button that wipes the site back
to a first-visit state.

> **Status:** 1.0.0. Independent rewrite of
> [isanchop/stuhack](https://github.com/isanchop/stuhack) for the current
> Next.js Studocu viewer, with a full cookie/cache reset and a rewritten
> download pipeline.

## Features

- Floating **Tải PDF** button on document pages.
- A **Reset phiên** button that wipes the site back to a first-visit state:
  cookies (including `HttpOnly`), `localStorage`, `sessionStorage`, Cache Storage,
  IndexedDB, HTTP cache, and service workers, then reloads the page. Two clicks
  are required so it cannot fire by accident. You will be signed out.
- Works on `studocu.com`, `studocu.vn`, `studocu.id`, and `studeersnel.nl`.
- Fetches all pages directly from the signed `doc-assets.studocu.com` URLs, so
  long documents do not need to be scrolled page by page.
- Keeps both the text layer and the figure/background layer.
- Removes premium banners and blur overlays where the page exposes the content.
- Renders premium-locked pages as clean white pages with an explanation,
  never as blurred previews in the PDF.
- Uses only two permissions (`cookies`, `browsingData`) scoped to the four
  Studocu domains, no tracking, and no remote code.

## Install

1. Go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (the folder containing `manifest.json`).
5. Open a Studocu document page.

## Usage

1. Open a document on a supported Studocu domain.
2. Wait for the viewer to load.
3. Click the green **Tải PDF** button at the bottom-right.
4. StudocuDown scans the document and opens a new tab with the assembled pages.
5. In the print dialog, choose **Save as PDF**.

The print tab also has a **Print / Save as PDF** button if the dialog does not
open automatically.

### Reset phiên

Click the grey **Reset phiên** button above the green one, then click it again
within 3 seconds. StudocuDown asks its service worker to remove every Studocu cookie
(including `HttpOnly` session cookies), `localStorage`, `sessionStorage`, Cache
Storage, IndexedDB, the HTTP cache, and the site's service worker, then reloads
the page. The result is the same as visiting the site for the first time:

- you are **signed out** and must log in again;
- cookie banners and consent prompts appear again;
- the first load is slower because every asset is re-downloaded.

This does **not** reset Studocu's server-side limits. Premium pages stay locked,
because the server never sends their content to non-subscribers.

## How it works

The current Studocu viewer is a Next.js app. It embeds document access data in
`#__NEXT_DATA__`:

- `documentAccess.objectKey`
- `documentAccess.signedQueryParams`
- `document.numberOfPages`

The extension builds the signed URLs for each page:

- background/figure layer: `bg{page in hex}.png`
- text layer: `{objectKey}{page}.page`
- clear full-page raster, when present: `pages/page{page}.webp`
- document stylesheet: `{objectKey}.css`

Blurred previews (`pages/blurred/...`) are deliberately never downloaded or
embedded in the PDF.

It fetches those assets with limited concurrency, sanitises the page HTML,
converts images to data URLs, and assembles a minimal print document using the
original pdf2htmlEX CSS. No part of the Studocu page head or scripts is copied
into the print window.

If `#__NEXT_DATA__` is unavailable or the signed URLs fail, the extension falls
back to cloning the pages currently rendered in the viewer.

## Limitations

- Some premium pages are never sent to non-subscribers in any form. Those pages
  become clean white pages with a **premium-locked** note; the blurred preview is
  deliberately not embedded in the PDF. No client-side extension can recover
  text the server did not send, and clearing cookies does not unlock it.
- Signed URLs expire. Start the download while the document page is still open.
- **Reset phiên signs you out.** A full reset deletes the session cookie, so a
  document that requires login will not load until you sign in again.
- Very large documents are capped at 300 pages per run to limit memory use.
- The generated document is intended for personal study. Downloading content may
  violate Studocu's terms or copyright law; use it only for material you have
  the right to access.

## Privacy and security

- `manifest.json` declares **two permissions**: `cookies` and `browsingData`,
  plus host permissions for the four Studocu domains only. Chrome warns that the
  extension can read and change cookies and clear browsing data.
- Those permissions exist for one reason: the **Reset phiên** button must remove
  `HttpOnly` session cookies, HTTP cache, and the site's service worker, none of
  which a content script can reach. There is no other use of either API.
- The service worker accepts a single message type (`studocudown-reset`), rejects
  messages from other extension IDs, and rejects hostnames outside the four
  supported domains.
- The reset is scoped to the site family of the current page: pressing it on
  `studocu.vn` never clears `studocu.com` cookies or data, and the asset hosts
  (`doc-assets`, `website-assets`) are only used for cache removal.
- The extension only fetches from `doc-assets.studocu.com` and
  `website-assets.studocu.com`.
- Fetched page HTML is sanitised: scripts, iframes, event handlers, and
  `javascript:` URLs are removed.
- Nothing is sent to a third-party server.
- The print document is built in a same-origin `about:blank` tab and is never
  uploaded.

## Development

```text
background.js  service worker: validated reset request -> cookies + browsingData
content/
  core.js      shared namespace, metadata parsing, URL builders, sanitising, fetch
  ui.js        floating buttons (download, reset session), panel, toast, print window
  pages.js     banner removal, blur removal, scoped mutation observer
  download.js  scan -> fetch -> assemble -> print
style.css      extension UI and no-filter overrides
test/
  core.test.mjs
  background.test.mjs
```

Run the tests:

```powershell
node --test test/core.test.mjs test/background.test.mjs
```

Check syntax and manifest:

```powershell
Get-ChildItem content\*.js, background.js | ForEach-Object { node --check $_.FullName }
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

## Troubleshooting

- **No button:** confirm the URL is a document page and the domain is supported.
  Reload the page after installing or updating the extension.
- **Popup blocked:** allow popups for the Studocu site, then click the button
  again.
- **Blank or missing pages:** open DevTools, check the Console and Network tabs
  for 403 responses. Signed URLs may have expired; reload the document first, or
  press **Reset phiên** twice to clear stale session state.
- **Reset phiên signed me out:** that is expected. The full reset deletes the
  `HttpOnly` session cookie, so you land on the site as a first-time visitor and
  must log in again.
- **Reset phiên only clears storage:** the service worker did not answer, so the
  content script fell back to the in-page reset (`localStorage`, Cache Storage,
  IndexedDB, non-`HttpOnly` cookies). Reload the extension in
  `chrome://extensions` and try again.
- **Print layout:** keep the default paper size in the print dialog; StudocuDown adds
  `@page` rules for each page size it finds.
- **Premium-locked white page:** Studocu did not send that page's content, so the
  PDF shows a white note page instead of a blurred preview. Clearing cookies
  cannot unlock server-gated content.

## Credits

- Original project: **StuHack** by
  [isanchop](https://github.com/isanchop/stuhack) — archived on 2025-11-24 and
  published without a license file. StudocuDown is an independent rewrite for the
  current Next.js viewer; none of the original source files are reused, so the
  MIT license below covers this repository only.
- Third-party agent skills used during development are documented in
  [`THIRD_PARTY_SKILLS.md`](THIRD_PARTY_SKILLS.md).

## Disclaimer

- Not affiliated with, endorsed by, or sponsored by Studocu or Studeersnel.
- Downloading documents may violate Studocu's Terms of Service or copyright law.
  Use it only for material you have the right to access, for personal study.
- Premium-locked pages are never fabricated and blurred previews are never
  embedded in the PDF: the extension only reuses assets the server already sent
  to your browser.
- You are responsible for how you use this extension and for the icon/assets you
  bundle with your own fork.

## License

[MIT](LICENSE) © 2026 StudocuDown contributors.
