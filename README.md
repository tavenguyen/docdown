# StudocuDown

StudocuDown is a Chrome extension (Manifest V3) that rebuilds a Studocu
document from the page assets the site already sends, then opens a print-ready
tab you can save as PDF. It adds two buttons to document pages: **Tải PDF** and
**Reset phiên**.

## Features

- **Tải PDF** fetches every page from the signed `doc-assets.studocu.com` URLs,
  so long documents do not need to be scrolled page by page.
- Keeps both the text layer and the figure/background layer.
- Removes premium banners and blur overlays where the page exposes the content.
- Renders premium-locked pages as clean white pages with an explanation, never as
  blurred previews in the PDF.
- **Reset phiên** clears cookies (including `HttpOnly`), storage, cache and
  service workers, then reloads the page. It signs you out.
- Works on `studocu.com`, `studocu.vn`, `studocu.id`, and `studeersnel.nl`.

## Install

1. Go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (the folder containing `manifest.json`).
5. Open a Studocu document page.

## Usage

1. Open a document on a supported Studocu domain and wait for the viewer.
2. Click the green **Tải PDF** button at the bottom-right.
3. StudocuDown scans the document and opens a preview tab.
4. Check the pages, then click **Print / Save as PDF** in the preview toolbar.
5. In the print dialog, choose **Save as PDF**.

The preview never opens the print dialog by itself. Chrome suggests the document
title as the file name, for example
`Đề Cương Chi Tiết Học Phần Thực Tập Cơ Khí - BMPR230227.pdf`; the preview
toolbar shows the same name.

### Reset phiên

Click the grey **Reset phiên** button above the green one, then click again
within 3 seconds. The extension removes every Studocu cookie (including
`HttpOnly`), `localStorage`, `sessionStorage`, Cache Storage, IndexedDB, the HTTP
cache, and the site's service worker, then reloads the page. You land on the site
as a first-time visitor: signed out, consent banners again, slower first load.

This does not reset Studocu's server-side limits. Premium pages stay locked,
because the server never sends their content to non-subscribers.

## Limitations

- Some premium pages are never sent to non-subscribers. They become clean white
  pages with a **premium-locked** note; the blurred preview is never embedded and
  clearing cookies does not unlock them.
- Signed URLs expire. Start the download while the document page is still open.
- **Reset phiên signs you out.** A document that requires login will not load
  until you sign in again.
- Very large documents are capped at 300 pages per run to limit memory use.

## Privacy and security

- `manifest.json` asks for `cookies` and `browsingData`, plus host permissions for
  the four Studocu domains. Chrome warns about both when you install it.
- Those permissions exist for **Reset phiên** only: removing `HttpOnly` cookies,
  the HTTP cache and the site's service worker. A reset on `studocu.vn` never
  touches `studocu.com` data.
- The service worker accepts one message type (`studocudown-reset`) and rejects
  messages from other extension IDs and hostnames outside the four domains. The
  print preview accepts a document only from the page that opened it.
- The extension fetches only `doc-assets.studocu.com` and
  `website-assets.studocu.com`, sanitises the HTML it receives (scripts, iframes,
  event handlers, `javascript:` URLs and `<script>` blocks removed), and sends
  nothing to a third-party server.

## Troubleshooting

- **No button:** confirm the URL is a document page and the domain is supported.
  Reload the page after installing or updating the extension.
- **Blank or missing pages:** check the Network tab for 403 responses. Signed URLs
  may have expired; reload the document, then try **Reset phiên**.
- **Reset phiên signed me out:** that is expected. The reset deletes the
  `HttpOnly` session cookie, so sign in again.
- **Reset phiên only cleared storage:** the service worker did not answer. Reload
  the extension in `chrome://extensions` and try again.
- **Premium-locked white page:** Studocu did not send that page, so the PDF shows a
  white note page. Clearing cookies cannot unlock server-gated content.

## Credits

- **StuHack** by [isanchop](https://github.com/isanchop/stuhack), archived on
  2025-11-24 with no license file. StudocuDown is an independent rewrite for the
  current Next.js viewer, so the MIT license below covers this repository only.
- Third-party agent skills: [`THIRD_PARTY_SKILLS.md`](THIRD_PARTY_SKILLS.md).

## Disclaimer

- Not affiliated with, endorsed by, or sponsored by Studocu or Studeersnel.
- Downloading documents may violate Studocu's Terms of Service or copyright law.
  Use it only for material you have the right to access, for personal study.
- Premium-locked pages are never fabricated and blurred previews are never
  embedded; the extension only reuses assets the server already sent you.

## License

[MIT](LICENSE) © 2026 StudocuDown contributors.
