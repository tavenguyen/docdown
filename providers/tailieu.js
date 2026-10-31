(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const DOMAINS = ['tailieu.vn'];
  const CDN_HOSTS = new Set(['cdn.tailieu.vn']);
  const SOURCE_PREFIX = '/files/source/';
  const HTML_PREFIX = '/files/html/';
  // Reading the page count decodes the whole file to a string, so skip that
  // step for large PDFs to keep the tab's memory bounded.
  const COUNT_LIMIT_BYTES = 25 * 1024 * 1024;

  // Nuxt serialises its payload with devalue: every string, number, object and
  // array lives in one flat array and every slot holds an index into it.
  // Tagged entries such as ["ShallowReactive", 3] wrap another index.
  const TAGS = new Set([
    'ShallowReactive', 'Reactive', 'Ref', 'ShallowRef', 'EmptyRef',
    'Date', 'Set', 'Map', 'BigInt', 'RegExp',
    'NaN', 'Infinity', '-Infinity', '-0', 'null', 'undefined'
  ]);

  let busy = false;
  let cached = null;

  function isDocumentPage() {
    try {
      return /^\/doc\/[^/]+\.html$/.test(location.pathname);
    } catch (error) {
      return false;
    }
  }

  function readPayload() {
    const el = document.getElementById('__NUXT_DATA__');
    if (!el) return null;
    try {
      const data = JSON.parse(el.textContent || '[]');
      return Array.isArray(data) ? data : null;
    } catch (error) {
      DD.warn('Could not parse __NUXT_DATA__', error);
      return null;
    }
  }

  function resolve(data, ref) {
    if (typeof ref !== 'number') return ref;
    const value = data[ref];
    if (Array.isArray(value) && value.length === 2 &&
      typeof value[0] === 'string' && TAGS.has(value[0]) &&
      typeof value[1] === 'number') {
      return resolve(data, value[1]);
    }
    return value;
  }

  function findPageEntry(data) {
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if ('document' in value && 'page' in value && 'sample' in value) return value;
    }
    return null;
  }

  // Resolves the document title, public PDF URL and displayed page count.
  function parsePageData(data) {
    if (!Array.isArray(data)) return null;
    const entry = findPageEntry(data);
    if (!entry) return null;

    const docRef = resolve(data, entry.document);
    const doc = docRef && typeof docRef === 'object' ? docRef : {};
    const title = String(resolve(data, doc.document_title) || document.title || '').trim();
    const sample = String(resolve(data, entry.sample) || '').trim();
    const numpage = Number(resolve(data, doc.document_numpage));

    return {
      title: title,
      pdfUrl: sample,
      documentPages: Number.isFinite(numpage) && numpage > 0 ? numpage : 0,
      dateTime: String(resolve(data, entry.dateTime) || ''),
      cssPath: String(resolve(data, entry.urlCss) || '')
    };
  }

  function headlinePageCount() {
    const nodes = [
      '.headline .like .text',
      '.headline .text',
      '.like .text'
    ];
    for (let i = 0; i < nodes.length; i++) {
      let el = null;
      try {
        el = document.querySelector(nodes[i]);
      } catch (error) {
        el = null;
      }
      const match = el && el.textContent ? el.textContent.match(/(\d+)\s*trang/i) : null;
      if (match) return Number(match[1]);
    }
    try {
      const bodyText = (document.body && document.body.innerText) || '';
      const match = bodyText.match(/(\d+)\s*trang/i);
      if (match) return Number(match[1]);
    } catch (error) {
      // innerText is unavailable in some documents.
    }
    return 0;
  }

  function isAllowedAssetUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url, (globalThis.location && globalThis.location.href) || undefined);
      if (parsed.protocol !== 'https:') return false;
      if (!CDN_HOSTS.has(parsed.hostname.toLowerCase())) return false;
      
      if (parsed.pathname.indexOf('..') !== -1) return false;
      return parsed.pathname.indexOf(SOURCE_PREFIX) === 0 ||
        parsed.pathname.indexOf(HTML_PREFIX) === 0;
    } catch (error) {
      return false;
    }
  }

  function isPdfUrl(url) {
    if (!url || !isAllowedAssetUrl(url)) return false;
    try {
      return /\.pdf$/i.test(new URL(url).pathname);
    } catch (error) {
      return false;
    }
  }

  function pdfFileName(title) {
    const base = DD.buildFileName(title);
    return /\.pdf$/i.test(base) ? base : base + '.pdf';
  }

  function inspect() {
    const href = (globalThis.location && globalThis.location.href) || '';
    if (cached && cached.href === href) return cached.info;

    const page = parsePageData(readPayload());
    const info = page
      ? {
        title: page.title || DD.buildFileName(document.title),
        pdfUrl: isPdfUrl(page.pdfUrl) ? page.pdfUrl : '',
        documentPages: page.documentPages,
        pageCount: headlinePageCount(),
        fileName: pdfFileName(page.title || document.title)
      }
      : null;

    cached = { href: href, info: info };
    return info;
  }

  function isAvailable() {
    const info = inspect();
    return !!(info && info.pdfUrl);
  }

  function formatMb(bytes) {
    return (Number(bytes) / 1048576).toFixed(1) + ' MB';
  }

  // The site compares its own page count with the file it serves. When the
  // public file is shorter, say so instead of pretending it is complete.
  function buildStatus(info, bytes, pages) {
    let message = 'Đã tải ' + info.fileName + ' (' + formatMb(bytes);
    if (pages) message += ', ' + pages + ' trang';
    message += ')';
    if (pages && info.pageCount && pages < info.pageCount) {
      message += '. Đây là bản xem trước ' + pages + '/' + info.pageCount +
        ' trang; bản đầy đủ cần đăng nhập hoặc tài khoản VIP.';
    }
    return message;
  }

  async function run() {
    if (busy) return;
    busy = true;

    DD.ui.setState('working', 'Đang kiểm tra tài liệu…');
    DD.ui.progress(0, 3, 'Đang kiểm tra tài liệu…');

    try {
      const info = inspect();
      if (!info || !info.pdfUrl) {
        throw new Error('Trang này không công khai file PDF để tải.');
      }

      DD.ui.progress(1, 3, 'Đang tải PDF…');
      const controller = new AbortController();
      const timer = setTimeout(function () { controller.abort(); }, 120000);
      let response;
      try {
        response = await fetch(info.pdfUrl, {
          credentials: 'omit',
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new Error('Máy chủ trả về lỗi ' + response.status + '.');
      }

      const declared = Number(response.headers.get('content-length'));
      if (declared > DD.MAX_PDF_BYTES) {
        throw new Error('File PDF quá lớn (' + formatMb(declared) + ').');
      }

      const blob = await response.blob();
      if (!blob.size) throw new Error('File PDF rỗng.');
      if (blob.size > DD.MAX_PDF_BYTES) {
        throw new Error('File PDF quá lớn (' + formatMb(blob.size) + ').');
      }

      DD.ui.progress(2, 3, 'Đang lưu ' + formatMb(blob.size) + '…');
      let pages = null;
      if (blob.size <= COUNT_LIMIT_BYTES) {
        try {
          pages = await DD.countPdfPages(await blob.arrayBuffer());
        } catch (error) {
          pages = null;
        }
      }

      DD.saveBlob(blob, info.fileName);
      const message = buildStatus(info, blob.size, pages);

      DD.ui.progress(3, 3, message);
      DD.ui.setState('ready', message);
    } catch (error) {
      const message = 'Không tải được PDF: ' +
        (error && error.message ? error.message : 'lỗi không xác định');
      DD.warn(message);
      DD.ui.setState('error', message);
      DD.ui.toast(message, 'error');
    } finally {
      busy = false;
    }
  }

  const provider = {
    id: 'tailieu',
    label: 'TaiLieu.VN',
    domains: DOMAINS,
    assetHosts: Array.from(CDN_HOSTS),
    actionLabel: 'Tải PDF',
    busyLabel: 'Đang tải…',
    isDocumentPage: isDocumentPage,
    isAvailable: isAvailable,
    isAllowedAssetUrl: isAllowedAssetUrl,
    inspect: inspect,
    parsePageData: parsePageData,
    buildStatus: buildStatus,
    run: run
  };
  DD.registerProvider(provider);

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () { busy = false; }, { once: true });
  }
})();
