# DocDown

DocDown is a Chrome extension (Manifest V3) that saves documents you can
already open on a supported site. It adds a **Tải PDF** button to document
pages and downloads the file in one click.

- **TaiLieu.VN** — saves the original PDF that the page already serves from its
  public CDN, byte for byte.
- **Studocu** — rebuilds the document from the page assets the site sends, then
  opens a print-ready tab you can save as PDF.
- **Scribd** — rebuilds the document from the page layers the viewer loads, then
  opens the same print-ready tab.
- **SlideShare** — saves every slide from the viewer's slide images, one per
  page, through the same print-ready tab.
- **Course Hero** — rebuilds the pages the viewer renders for your account and
  marks the rest as locked.
- **Reset phiên** — clears cookies (including `HttpOnly`), storage, cache and
  service workers, then reloads the page. It signs you out.

## Install

1. Go to `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder (the folder containing `manifest.json`).
5. Open a document page on a supported site.

## Usage

### TaiLieu.VN

1. Open a document on `tailieu.vn/doc/…`.
2. Click **Tải PDF**.
3. Chrome saves the PDF with the document title as the file name.

The page reports the page count ("N trang"), and DocDown compares it with the
page count inside the PDF. When the public file is shorter than the document,
the status line says so, for example `bản xem trước 20/94 trang`; the full file
needs a TaiLieu.VN account or VIP access. DocDown never downloads the blurred
preview the site shows to non-members.

Some documents have no public PDF (for example uploaded Word files, or pages
whose HTML was never generated). On those pages the button stays hidden.

### Studocu

1. Open a document on a supported Studocu domain and wait for the viewer.
2. Click the green **Tải PDF** button at the bottom-right.
3. DocDown scans the document and opens a preview tab.
4. Check the pages, then click **Print / Save as PDF** in the preview toolbar.
5. In the print dialog, choose **Save as PDF**.

The preview never opens the print dialog by itself. Chrome suggests the document
title as the file name, for example
`Đề Cương Chi Tiết Học Phần Thực Tập Cơ Khí - BMPR230227.pdf`; the preview
toolbar shows the same name.

Premium-locked Studocu pages render as clean white pages with an explanation,
never as blurred previews in the PDF.

### Scribd

1. Open a document on `scribd.com/document/…`.
2. Click **Tải PDF** at the bottom-right.
3. Check the preview, then click **Print / Save as PDF**.

DocDown rebuilds each page from the text and image layers the viewer already
downloads, using the document's own fonts and page size. Pages Scribd marks as
blurred for your account render as white pages with a note; the blurred preview
is never embedded.

### SlideShare

1. Open a presentation on `slideshare.net/slideshow/…`.
2. Click **Tải PDF** at the bottom-right.
3. DocDown checks every slide image, then opens the preview; click
   **Print / Save as PDF**.

Each slide becomes one page at the presentation's own aspect ratio, using the
2048 px slide image. A slide whose image does not download is printed as a
white page with a note instead of a broken image.

### Course Hero

1. Open a document on `coursehero.com/file/…`.
2. Click **Tải PDF** at the bottom-right.
3. The preview shows the pages Course Hero renders for you, followed by a note
   page that lists how many pages were withheld.

Course Hero only sends the preview pages to visitors who are not signed in
(usually 2 of 8), and its background images are already redacted on the server.
DocDown keeps the readable text layer, drops the blurred artwork, and never
invents the pages the site did not send. Sign in with access to get more pages
rendered in the viewer.

### Reset phiên

Click the grey **Reset phiên** button above the green one, then click again
within 3 seconds. The extension removes every cookie of the current site
(including `HttpOnly`), `localStorage`, `sessionStorage`, Cache Storage,
IndexedDB, the HTTP cache, the site's service worker and the cached document
assets, then reloads the page. You land on the site as a first-time visitor:
signed out, consent banners again, slower first load.

This does not reset server-side limits. Premium pages stay locked, because the
server never sends their content to non-subscribers.

## Supported sites

| Site | How it saves |
|---|---|
| `tailieu.vn` | original PDF from `cdn.tailieu.vn`, with a preview warning when truncated |
| `studocu.com`, `studocu.vn`, `studocu.id`, `studeersnel.nl` | rebuild + print preview |
| `scribd.com` | rebuild from the viewer's page layers + print preview |
| `slideshare.net` | slide images from `image.slidesharecdn.com` + print preview |
| `coursehero.com` | preview pages rendered in the viewer (text layer only) |

## Limits

- DocDown only reuses files the server already sends to your browser. It does
  not guess URLs, fabricate page content, or embed blurred previews.
- TaiLieu.VN documents with a truncated public PDF are labelled as previews.
- Scribd pages flagged as blurred are printed as white note pages; the extension
  does not reconstruct content the site hides for your account.
- SlideShare presentations are saved from the slide images the viewer loads; the
  original PPTX/DOCX download stays behind SlideShare's own login flow.
- Course Hero is preview-only for visitors without an account: its server sends
  about 2 pages with redacted artwork, so the PDF is a labelled preview.
- Studocu documents over 300 pages are capped so the tab does not run out of
  memory.

## Credits

- **StuHack** by [isanchop](https://github.com/isanchop/stuhack), archived on
  2025-11-24 with no license file. The Studocu provider is an independent
  rewrite for the current Next.js viewer, so the MIT license below covers this
  repository only.
- Third-party agent skills: [`THIRD_PARTY_SKILLS.md`](THIRD_PARTY_SKILLS.md).

## Disclaimer

- Not affiliated with, endorsed by, or sponsored by Studocu, Studeersnel or
  TaiLieu.VN.
- Downloading documents may violate a site's Terms of Service or copyright law.
  Use it only for material you have the right to access, for personal study.
- Locked pages are never fabricated and blurred previews are never embedded;
  the extension only reuses assets the server already sent you.

## License

[MIT](LICENSE) © 2026 DocDown contributors.
