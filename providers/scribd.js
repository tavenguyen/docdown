(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const DOMAINS = ['scribd.com'];
  const PAGE_HOST = 'html.scribdassets.com';
  // Page images are published on the legacy html.scribd.com host but served
  // from the same CDN bucket under html.scribdassets.com.
  const IMAGE_HOST_ALIASES = {
    'html.scribd.com': 'html.scribdassets.com'
  };
  const CONCURRENCY = 4;

  let busy = false;
  let cached = null;

  function isDocumentPage() {
    try {
      return /^\/document\/\d+/.test(location.pathname);
    } catch (error) {
      return false;
    }
  }

  function pageSource() {
    const href = (globalThis.location && globalThis.location.href) || '';
    if (cached && cached.href === href) return cached.source;
    const source = document.documentElement ? document.documentElement.outerHTML : '';
    cached = { href: href, source: source, doc: null };
    return source;
  }

  function numberAfter(body, name) {
    const match = body.match(new RegExp(name + ':\\s*(\\d+)'));
    return match ? Number(match[1]) : 0;
  }

  function stringAfter(body, name) {
    const match = body.match(new RegExp(name + ':\\s*"([^"]*)"'));
    return match ? match[1] : '';
  }

  // The viewer ships every page descriptor in the document HTML, including a
  // per-page JSONP URL, the page size and the blur flag.
  function parseDocument(source) {
    const pageCount = Number((String(source).match(/"page_count":\s*(\d+)/) || [])[1]) || 0;
    const assetPrefix = (String(source).match(/docManager\.assetPrefix\s*=\s*"([^"]+)"/) || [])[1] || '';

    const pages = [];
    const pagePattern = /docManager\.addPage\(\{([\s\S]*?)\}\)/g;
    let pageMatch;
    while ((pageMatch = pagePattern.exec(source)) !== null) {
      const body = pageMatch[1];
      const pageNumber = numberAfter(body, 'pageNum');
      const contentUrl = stringAfter(body, 'contentUrl');
      if (!pageNumber || !contentUrl) continue;
      pages.push({
        pageNumber: pageNumber,
        contentUrl: contentUrl,
        width: numberAfter(body, 'origWidth') || 0,
        height: numberAfter(body, 'origHeight') || 0,
        blur: /blur:\s*true/.test(body)
      });
    }
    pages.sort(function (a, b) { return a.pageNumber - b.pageNumber; });

    const fonts = [];
    const fontPattern = /docManager\.addFont\(\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g;
    let fontMatch;
    while ((fontMatch = fontPattern.exec(source)) !== null) {
      fonts.push({
        id: Number(fontMatch[1]),
        cls: fontMatch[3],
        family: fontMatch[4],
        weight: fontMatch[5],
        style: fontMatch[6]
      });
    }

    const viewerCss = findViewerCss(source);

    return {
      title: document.title || '',
      pageCount: pageCount || pages.length,
      assetPrefix: assetPrefix,
      pages: pages,
      fonts: fonts,
      css: viewerCss
    };
  }

  // The viewer stylesheet is the first style block that defines both
  // .text_layer and .newpage. It has no external imports.
  function findViewerCss(source) {
    const pattern = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const css = match[1];
      if (css.indexOf('.text_layer{') !== -1 && css.indexOf('.newpage{') !== -1) {
        return css;
      }
    }
    return '';
  }

  function isAllowedAssetUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url, (globalThis.location && globalThis.location.href) || undefined);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.hostname.toLowerCase() !== PAGE_HOST) return false;
      if (parsed.pathname.indexOf('..') !== -1) return false;
      return /^\/[a-z0-9]+\/(?:pages|images|fonts)\//i.test(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function isPdfUrl(url) {
    return !!(url && /^https:\/\/html\.scribdassets\.com\/[a-z0-9]+\/pages\/[^/]+\.jsonp$/i.test(url));
  }

  // The viewer loads a page as JSONP, but the payload is plain JSON inside the
  // callback. Parse it instead of executing Scribd's script.
  function parsePageJsonp(text) {
    const source = String(text || '');
    const start = source.indexOf('(');
    const end = source.lastIndexOf(')');
    if (start === -1 || end <= start) throw new Error('unexpected page payload');
    const data = JSON.parse(source.slice(start + 1, end));
    const fragment = Array.isArray(data) ? data[0] : data;
    if (typeof fragment !== 'string' || fragment.indexOf('<') === -1) {
      throw new Error('unexpected page payload');
    }
    return fragment;
  }

  function fontCss(prefix, fonts) {
    return fonts.map(function (font) {
      const file = String(font.id).padStart(4, '0') + '.woff2';
      const url = 'https://' + PAGE_HOST + '/' + prefix + '/fonts/' + file;
      if (!isAllowedAssetUrl(url)) return '';
      return '@font-face{font-family:"scribd-' + font.cls + '";src:url(' + url +
        ') format("woff2");font-display:swap}' +
        '.' + font.cls + '{font-family:"scribd-' + font.cls + '","' + font.family +
        '";font-weight:' + font.weight + ';font-style:' + font.style + '}';
    }).join('\n');
  }

  function safeCss(css) {
    return String(css || '')
      .replace(/@import[^;]*;/gi, '')
      .replace(/expression\s*\(/gi, '')
      .replace(/javascript\s*:/gi, '');
  }

  function resolveImageUrl(value) {
    try {
      const parsed = new URL(value, (globalThis.location && globalThis.location.href) || undefined);
      const host = IMAGE_HOST_ALIASES[parsed.hostname.toLowerCase()] || parsed.hostname.toLowerCase();
      const rewritten = 'https://' + host + parsed.pathname + parsed.search;
      return isAllowedAssetUrl(rewritten) ? rewritten : '';
    } catch (error) {
      return '';
    }
  }

  // Sanitises one page fragment: keeps the text/image layers, rewrites the
  // sprite host to the HTTPS CDN and drops every executable part.
  function preparePage(fragment) {
    const parsed = new DOMParser().parseFromString(String(fragment || ''), 'text/html');
    const body = parsed.body;

    body.querySelectorAll(
      'script, iframe, object, embed, link, style, base, meta, form, input, button, textarea, select, video, audio, source, track, canvas, foreignObject'
    ).forEach(function (el) { el.remove(); });

    body.querySelectorAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '');
        if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'formaction') {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'style' && /javascript\s*:|expression\s*\(/i.test(value)) {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'href' || name === 'src' || name === 'xlink:href') {
          if (/^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
            el.removeAttribute(attr.name);
          }
        }
      });
      if (el.classList) {
        Array.prototype.slice.call(el.classList).forEach(function (token) {
          if (/blur/i.test(token)) el.classList.remove(token);
        });
      }
    });

    body.querySelectorAll('img').forEach(function (img) {
      const original = img.getAttribute('orig') || '';
      img.removeAttribute('orig');
      if (original) {
        const src = resolveImageUrl(original);
        if (src) img.setAttribute('src', src);
      }
      const src = String(img.getAttribute('src') || '').trim();
      img.removeAttribute('srcset');
      if (!src || !/^https:/i.test(src) || !isAllowedAssetUrl(src)) {
        img.remove();
        return;
      }
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
    });

    body.querySelectorAll('a[href]').forEach(function (link) {
      const href = String(link.getAttribute('href') || '').trim();
      if (!/^https?:/i.test(href)) link.removeAttribute('href');
    });

    return body.innerHTML;
  }

  function pageHtml(page, fragment) {
    const width = page.width || 0;
    const height = page.height || 0;
    const size = 'style="width:' + width + 'px;height:' + height + 'px"';
    if (page.blur) {
      return '<div class="pf docdown-scribd-page" ' + size + '>' +
        '<div class="docdown-gated-page">' +
        '<div class="docdown-gated-title">Page ' + page.pageNumber + ' is locked</div>' +
        '<div class="docdown-gated-text">Scribd marks this page as blurred for readers ' +
        'without access, so DocDown leaves it blank instead of embedding a preview.</div>' +
        '</div></div>';
    }
    return '<div class="pf docdown-scribd-page" ' + size + ' data-page-no="' +
      page.pageNumber + '">' + fragment + '</div>';
  }

  function buildCss(doc) {
    return [
      '@page{size:auto;margin:0}',
      '.docdown-scribd-page{position:relative;overflow:hidden;background:#fff}',
      '.docdown-scribd-page .newpage{background:#fff}',
      safeCss(doc.css),
      fontCss(doc.assetPrefix, doc.fonts)
    ].filter(Boolean).join('\n');
  }

  async function fetchPage(page) {
    if (!isPdfUrl(page.contentUrl)) {
      throw new Error('Page ' + page.pageNumber + ': unexpected URL');
    }
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, DD.FETCH_TIMEOUT);
    try {
      const response = await fetch(page.contentUrl, {
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) throw new Error('Page ' + page.pageNumber + ': HTTP ' + response.status);
      return parsePageJsonp(await response.text());
    } finally {
      clearTimeout(timer);
    }
  }

  async function buildPages(doc, total) {
    const prepared = {};
    let done = 0;
    await DD.mapLimit(doc.pages, CONCURRENCY, async function (page) {
      if (page.pageNumber > total) return;
      if (!page.blur) {
        try {
          prepared[page.pageNumber] = preparePage(await fetchPage(page));
        } catch (error) {
          DD.warn('Could not load Scribd page ' + page.pageNumber, error);
          prepared[page.pageNumber] = '';
        }
      }
      done += 1;
      DD.ui.progress(done, total, 'Đang tải trang ' + done + '/' + total + '…');
    });
    return prepared;
  }

  function getDoc() {
    pageSource();
    if (!cached.doc) cached.doc = parseDocument(cached.source);
    return cached.doc;
  }

  function isAvailable() {
    const doc = getDoc();
    return !!(doc && doc.pages.length);
  }

  async function run() {
    if (busy) return;
    busy = true;

    // Must be called synchronously from the click handler.
    const win = DD.ui.openPrintWindow();
    if (!win) {
      busy = false;
      DD.ui.toast('Trình duyệt đã chặn tab in. Hãy cho phép popup cho Scribd rồi thử lại.', 'error');
      return;
    }

    try {
      DD.ui.setState('working', 'Đang quét tài liệu…');
      const doc = getDoc();
      if (!doc || !doc.pages.length) {
        throw new Error('Không tìm thấy dữ liệu trang của tài liệu này.');
      }

      const total = Math.min(doc.pages.length, DD.MAX_PAGES);
      if (doc.pages.length > DD.MAX_PAGES) {
        DD.ui.toast('Tài liệu có ' + doc.pages.length + ' trang; chỉ xử lý ' +
          DD.MAX_PAGES + ' trang đầu để tránh tốn RAM.', 'error');
      }

      DD.ui.progress(0, total, 'Đang tải 0/' + total + ' trang…');
      const prepared = await buildPages(doc, total);

      const pages = doc.pages.slice(0, total);
      const missing = pages.filter(function (page) {
        return !page.blur && !prepared[page.pageNumber];
      });
      if (missing.length === pages.length) {
        throw new Error('Không tải được trang nào từ Scribd.');
      }

      const pagesHtml = pages.map(function (page) {
        return pageHtml(page, prepared[page.pageNumber] || '');
      }).join('');

      const html = DD.buildPrintHtml({
        title: doc.title,
        version: DD.VERSION,
        css: buildCss(doc),
        pagesHtml: pagesHtml,
        total: total
      });

      const fileName = DD.buildFileName(doc.title);
      const delivered = await DD.ui.deliverPrintDocument(win, html, fileName);
      if (!delivered) {
        throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
      }

      const locked = pages.filter(function (page) { return page.blur; }).length;
      let status = 'Đã tạo bản in (' + total + ' trang';
      if (locked) status += ', ' + locked + ' bị khóa';
      if (missing.length) status += ', ' + missing.length + ' lỗi';
      status += ')';
      DD.ui.progress(total, total, status);
      DD.ui.setState('ready', status);
    } catch (error) {
      const message = 'Không tải được tài liệu: ' +
        (error && error.message ? error.message : 'lỗi không xác định');
      DD.warn(message);
      DD.ui.setState('error', message);
      DD.ui.toast(message, 'error');
      DD.ui.showPrintError(win, message);
    } finally {
      busy = false;
    }
  }

  const provider = {
    id: 'scribd',
    label: 'Scribd',
    domains: DOMAINS,
    assetHosts: [PAGE_HOST],
    actionLabel: 'Tải PDF',
    busyLabel: 'Đang quét…',
    isDocumentPage: isDocumentPage,
    isAvailable: isAvailable,
    isAllowedAssetUrl: isAllowedAssetUrl,
    parseDocument: parseDocument,
    parsePageJsonp: parsePageJsonp,
    buildCss: buildCss,
    pageHtml: pageHtml,
    run: run
  };
  DD.registerProvider(provider);

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () { busy = false; }, { once: true });
  }
})();
