(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const DOMAINS = ['academia.edu'];
  const ASSET_HOST = 'attachments.academia-assets.com';
  const ASSET_BASE = 'https://' + ASSET_HOST + '/';
  const PAGE_TIMEOUT = 20000;
  const FONT_TIMEOUT = 20000;
  const PAGE_CONCURRENCY = 4;
  const FONT_CONCURRENCY = 3;
  const REFRESH_DELAY = 500;
  const DEFAULT_WIDTH = 850;
  const DEFAULT_HEIGHT = 1100;

  let provider = null;
  let busy = false;
  let observer = null;
  let pagehideBound = false;

  function isDocumentPage() {
    try {
      return /^\/(\d+)(?:\/|$)/.test(location.pathname);
    } catch (error) {
      return false;
    }
  }

  // The page exposes "Attachment_122969643"; accept that form and a bare id.
  function attachmentIdFrom(value) {
    if (value === undefined || value === null) return 0;
    const text = String(value).trim();
    if (!text) return 0;

    let match = text.match(/^Attachment_(\d+)$/i);
    if (!match) match = text.match(/^(\d+)$/);
    if (!match) return 0;

    const id = Number(match[1]);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  // Content scripts run in an isolated world, so the viewer's window state is
  // not readable. The attachment id is published on the DOM instead.
  function getAttachmentId() {
    try {
      if (typeof document === 'undefined' || !document.querySelector) return 0;
      const node = document.querySelector('.attachment_preview[data-attachment]');
      if (!node || !node.getAttribute) return 0;
      return attachmentIdFrom(node.getAttribute('data-attachment'));
    } catch (error) {
      return 0;
    }
  }

  function getTitle() {
    let title = '';
    try {
      const heading = document.querySelector('h1');
      if (heading && heading.textContent) title = heading.textContent.trim();
    } catch (error) {
      title = '';
    }
    if (!title) {
      try {
        title = String(document.title || '').trim();
      } catch (error) {
        title = '';
      }
    }
    if (!title) return 'document';

    return title
      .replace(/^\(pdf\)\s*/i, '')
      .replace(/\s*[|\-\u2013\u2014]\s*Academia\.edu\s*$/i, '')
      .trim() || 'document';
  }

  function hasTraversal(value) {
    const raw = String(value === undefined || value === null ? '' : value);
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch (error) {
      return true;
    }
    const pattern = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
    return pattern.test(raw) || pattern.test(decoded);
  }

  function isAllowedAssetUrl(url) {
    if (!url) return false;
    if (hasTraversal(url)) return false;
    try {
      // BuildVu can publish relative paths; resolve them against the asset
      // host so they cannot be mistaken for the Academia page origin.
      const parsed = new URL(String(url), ASSET_BASE);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.hostname.toLowerCase() !== ASSET_HOST) return false;
      if (hasTraversal(parsed.pathname)) return false;
      return /^\/\d+\/(?:\d+\.html|\d+\/img\/[A-Za-z0-9._-]+\.(?:jpe?g|png|gif|webp)|fonts\/[A-Za-z0-9._-]+\.(?:woff2?|ttf|otf))$/i
        .test(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function pageDefsUrl(id) {
    return '/v0/document_viewer/build_vu_page_defs/' + String(id) +
      '?subdomain_param=api';
  }

  function positiveNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  // The viewer API returns an array of page descriptors; accept the wrapped
  // shapes too. Only pages with an allowlisted BuildVu URL are usable.
  function normalizePageDefs(payload) {
    if (!payload || typeof payload !== 'object') return null;

    let entries = null;
    if (Array.isArray(payload)) entries = payload;
    else if (Array.isArray(payload.pages)) entries = payload.pages;
    else if (Array.isArray(payload.page_defs)) entries = payload.page_defs;
    if (!entries) return null;

    const pages = [];
    const seen = new Set();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') continue;

      const pageNumber = Number(entry.page_number);
      if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
      if (seen.has(pageNumber)) continue;

      const rawUrl = entry.page_url === undefined || entry.page_url === null
        ? ''
        : String(entry.page_url);
      if (hasTraversal(rawUrl)) continue;

      let pageUrl = '';
      try {
        pageUrl = new URL(rawUrl, ASSET_BASE).href;
      } catch (error) {
        pageUrl = '';
      }
      if (!pageUrl || !isAllowedAssetUrl(pageUrl)) continue;

      seen.add(pageNumber);
      pages.push({
        page_number: pageNumber,
        page_url: pageUrl,
        width: positiveNumber(entry.width) || DEFAULT_WIDTH,
        height: positiveNumber(entry.height) || DEFAULT_HEIGHT
      });
    }

    if (!pages.length) return null;
    pages.sort(function (a, b) { return a.page_number - b.page_number; });

    let declared = 0;
    if (!Array.isArray(payload)) {
      declared = Math.floor(positiveNumber(payload.total_pages)) ||
        Math.floor(positiveNumber(payload.page_count)) || 0;
    }
    const largest = pages[pages.length - 1].page_number;
    return { pages: pages, totalPages: Math.max(declared, largest) };
  }

  // Same-origin viewer endpoint: it needs the tab's session cookies, so it
  // cannot go through DD.fetchText (which deliberately sends none).
  async function fetchPageDefs(id) {
    const attachmentId = Number(id);
    if (!Number.isSafeInteger(attachmentId) || attachmentId < 1) {
      throw new Error('Mã tài liệu Academia không hợp lệ.');
    }

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, PAGE_TIMEOUT);
    try {
      let response;
      try {
        response = await fetch(pageDefsUrl(attachmentId), {
          credentials: 'same-origin',
          signal: controller.signal
        });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw new Error('Academia phản hồi quá lâu khi lấy danh sách trang.');
        }
        throw new Error('Không lấy được danh sách trang từ Academia.');
      }

      if (!response || !response.ok) {
        DD.warn('Academia page defs failed: ' + pageDefsUrl(attachmentId) +
          ' HTTP ' + (response && response.status ? response.status : 'không xác định'));
        throw new Error('Academia trả về lỗi ' +
          (response && response.status ? response.status : 'không xác định') +
          ' khi lấy danh sách trang.');
      }

      let payload;
      try {
        if (typeof response.json === 'function') payload = await response.json();
        else payload = JSON.parse(await response.text());
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw new Error('Academia phản hồi quá lâu khi lấy danh sách trang.');
        }
        throw new Error('Dữ liệu trang của Academia không hợp lệ.');
      }

      const meta = normalizePageDefs(payload);
      if (!meta || !meta.pages.length) {
        throw new Error('Academia không gửi trang nào cho tài liệu này.');
      }
      return meta;
    } finally {
      clearTimeout(timer);
    }
  }

  function sanitizeCssUrls(css) {
    return String(css === undefined || css === null ? '' : css)
      .replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, function (full, quote, raw) {
        const value = String(raw).trim();
        if (/^data:(?:font\/|application\/font)/i.test(value)) return full;
        if (hasTraversal(value)) return 'none';
        if (!/^(?:\/|https:\/\/)/i.test(value)) return 'none';

        let absolute = '';
        try {
          absolute = new URL(value, ASSET_BASE).href;
        } catch (error) {
          return 'none';
        }
        return isAllowedAssetUrl(absolute) ? 'url("' + absolute + '")' : 'none';
      });
  }

  function sanitizeCss(css) {
    try {
      const cleaned = String(css === undefined || css === null ? '' : css)
        .replace(/@import[^;]*(?:;|$)/gi, '')
        .replace(/expression\s*\(/gi, '')
        .replace(/javascript\s*:/gi, '')
        .replace(/vbscript\s*:/gi, '')
        .replace(/behavior\s*:/gi, '')
        .replace(/-moz-binding\s*:/gi, '');
      return sanitizeCssUrls(cleaned);
    } catch (error) {
      return '';
    }
  }

  function sanitizeInlineStyle(value) {
    const text = String(value === undefined || value === null ? '' : value);
    if (/javascript\s*:|expression\s*\(/i.test(text)) return '';
    return sanitizeCssUrls(text);
  }

  function fontUrls(css) {
    const text = String(css === undefined || css === null ? '' : css);
    const urls = [];
    const pattern = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const raw = String(match[2]).trim();
      if (!raw || hasTraversal(raw)) continue;

      let parsed;
      try {
        parsed = new URL(raw, ASSET_BASE);
      } catch (error) {
        continue;
      }
      if (!/\/fonts\/[^/]+\.woff2?$/i.test(parsed.pathname)) continue;

      const absolute = parsed.href;
      if (!isAllowedAssetUrl(absolute)) continue;
      if (urls.indexOf(absolute) === -1) urls.push(absolute);
    }
    return urls;
  }

  // Fonts live on a CORS-less CDN; fetching them in the content script (which
  // has host permission) and inlining the data URL keeps the print page
  // self-contained.
  async function inlineFonts(css) {
    const source = String(css === undefined || css === null ? '' : css);
    const urls = fontUrls(source);
    if (!urls.length) return source;

    const values = new Map();
    try {
      await DD.mapLimit(urls, FONT_CONCURRENCY, async function (url) {
        try {
          const value = await DD.fetchDataUrl(url, FONT_TIMEOUT);
          if (value) values.set(url, value);
        } catch (error) {
          DD.warn('Could not inline Academia font ' + url, error);
        }
      });

      if (!values.size) return source;
      return source.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, function (full, quote, key) {
        let absolute = '';
        try {
          absolute = new URL(String(key).trim(), ASSET_BASE).href;
        } catch (error) {
          return full;
        }
        const value = values.get(absolute);
        return value ? 'url("' + value + '")' : full;
      });
    } finally {
      values.clear();
    }
  }

  function sizeFrom(text, name) {
    const match = String(text || '').match(
      new RegExp('(?:^|[;\\s"\'])' + name + '\\s*:\\s*(\\d+)px', 'i')
    );
    return match ? Number(match[1]) : 0;
  }

  function readPageSize(root, source) {
    const style = typeof root.getAttribute === 'function'
      ? String(root.getAttribute('style') || '')
      : '';
    let width = sizeFrom(style, 'width');
    let height = sizeFrom(style, 'height');

    if (!width || !height) {
      const tag = String(source || '').match(
        /<[a-z][^>]*\bid\s*=\s*["']jpedal["'][^>]*>/i
      );
      if (tag) {
        width = width || sizeFrom(tag[0], 'width');
        height = height || sizeFrom(tag[0], 'height');
      }
    }

    return {
      width: width || DEFAULT_WIDTH,
      height: height || DEFAULT_HEIGHT
    };
  }

  // Cleans one BuildVu page. Returns the sanitised root markup plus the page
  // stylesheets, which are injected once into the print document instead.
  function preparePage(html, pageUrl) {
    let parsed;
    try {
      parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
    } catch (error) {
      return null;
    }
    if (!parsed) return null;

    let root = null;
    if (typeof parsed.getElementById === 'function') {
      root = parsed.getElementById('jpedal');
    }
    if (!root && typeof parsed.querySelector === 'function') {
      root = parsed.querySelector('#jpedal');
    }
    if (!root) return null;

    const size = readPageSize(root, html);

    const styleNodes = [];
    function collectStyles(scope) {
      if (!scope || typeof scope.querySelectorAll !== 'function') return;
      Array.prototype.forEach.call(scope.querySelectorAll('style'), function (node) {
        if (styleNodes.indexOf(node) === -1) styleNodes.push(node);
      });
    }
    collectStyles(parsed);
    collectStyles(root);

    const cssParts = [];
    styleNodes.forEach(function (node) {
      const text = node.textContent || '';
      if (text.trim()) cssParts.push(text);
      node.remove();
    });

    root.querySelectorAll(
      'script, iframe, object, embed, link, base, meta, form, input, button, textarea, select, video, audio, source, track, canvas, foreignObject'
    ).forEach(function (el) { el.remove(); });

    const nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    nodes.forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '');
        if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'formaction') {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'srcset' || name === 'data-src') {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'style') {
          const safeStyle = sanitizeInlineStyle(value);
          if (!safeStyle) {
            el.removeAttribute(attr.name);
          } else if (safeStyle !== value) {
            el.setAttribute(attr.name, safeStyle);
          }
          return;
        }
        if (name === 'href' || name === 'src' || name === 'xlink:href') {
          const tagName = String(el.tagName || '').toUpperCase();
          if (tagName !== 'IMG' && tagName !== 'A') {
            el.removeAttribute(attr.name);
            return;
          }
          if (/^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
            el.removeAttribute(attr.name);
          }
        }
      });
    });

    root.querySelectorAll('img').forEach(function (img) {
      const src = String(img.getAttribute('src') || '').trim();
      if (!src || hasTraversal(src)) {
        img.remove();
        return;
      }

      let absolute = '';
      try {
        absolute = new URL(src, pageUrl).href;
      } catch (error) {
        absolute = '';
      }
      if (!absolute || !isAllowedAssetUrl(absolute)) {
        img.remove();
        return;
      }

      img.setAttribute('src', absolute);
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
    });

    root.querySelectorAll('a[href]').forEach(function (link) {
      const href = String(link.getAttribute('href') || '').trim();
      if (!/^https?:/i.test(href)) link.removeAttribute('href');
    });

    return {
      markup: root.outerHTML,
      css: cssParts.join('\n'),
      width: size.width,
      height: size.height
    };
  }

  function numericPageNumber(def) {
    const number = Number(def && def.page_number);
    return Number.isInteger(number) && number > 0 ? number : 0;
  }

  function dimension(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return fallback;
    return Math.max(1, Math.round(number));
  }

  function pageHtml(def, parts) {
    const source = def && typeof def === 'object' ? def : {};
    const pageNumber = numericPageNumber(source);
    const defWidth = dimension(source.width, DEFAULT_WIDTH);
    const defHeight = dimension(source.height, DEFAULT_HEIGHT);

    if (!parts || typeof parts !== 'object' ||
      typeof parts.markup !== 'string' || !parts.markup) {
      // Do not fabricate content: say the page was not sent instead.
      return '<div class="pf docdown-academia-page" style="width:' + defWidth +
        'px;height:' + defHeight + 'px">' +
        '<div class="docdown-gated-page">' +
        '<div class="docdown-gated-title">Page ' + pageNumber + ' is unavailable</div>' +
        '<div class="docdown-gated-text">Academia did not send this page to this browser.</div>' +
        '</div></div>';
    }

    const width = dimension(parts.width, defWidth);
    const height = dimension(parts.height, defHeight);
    return '<div class="pf docdown-academia-page" style="width:' + width +
      'px;height:' + height + 'px" data-page-no="' + pageNumber + '">' +
      parts.markup + '</div>';
  }

  // Splits CSS into top-level rules so the shared BuildVu stylesheet, which is
  // repeated inside every page, is only printed once.
  function splitCss(css) {
    const text = String(css || '');
    const blocks = [];
    let depth = 0;
    let start = 0;
    let quote = '';
    let comment = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      const next = text.charAt(i + 1);

      if (comment) {
        if (ch === '*' && next === '/') {
          comment = false;
          i += 1;
        }
        continue;
      }
      if (quote) {
        if (ch === '\\') {
          i += 1;
          continue;
        }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '/' && next === '*') {
        comment = true;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        continue;
      }
      if (ch === '}') {
        if (depth > 0) depth -= 1;
        if (depth === 0) {
          const block = text.slice(start, i + 1).trim();
          if (block) blocks.push(block);
          start = i + 1;
        }
        continue;
      }
      if (ch === ';' && depth === 0) {
        const block = text.slice(start, i + 1).trim();
        if (block) blocks.push(block);
        start = i + 1;
      }
    }

    const tail = text.slice(start).trim();
    if (tail) blocks.push(tail);
    return blocks;
  }

  function dedupeCss(css) {
    const seen = new Set();
    return splitCss(css).filter(function (block) {
      if (seen.has(block)) return false;
      seen.add(block);
      return true;
    }).join('\n');
  }

  function buildCss(pageCss) {
    const list = Array.isArray(pageCss) ? pageCss : [pageCss];
    const cleaned = list.map(sanitizeCss).filter(function (css) {
      return css.trim();
    }).join('\n');

    return [
      '@page{size:auto;margin:0}',
      '.docdown-academia-page{position:relative;overflow:hidden;background:#fff}',
      '.docdown-academia-page #jpedal{max-width:none}',
      dedupeCss(cleaned)
    ].filter(Boolean).join('\n');
  }

  function isAvailable() {
    return getAttachmentId() > 0;
  }

  function refresh() {
    if (!isDocumentPage()) {
      if (DD.ui && typeof DD.ui.cleanup === 'function') DD.ui.cleanup();
      return;
    }
    if (DD.ui && typeof DD.ui.mount === 'function') DD.ui.mount(provider);
  }

  const debouncedRefresh = DD.debounce(refresh, REFRESH_DELAY);

  function containsAttachment(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.classList && node.classList.contains('attachment_preview')) return true;
    return !!(node.querySelector && node.querySelector('.attachment_preview'));
  }

  function onMutations(mutations) {
    for (let i = 0; i < mutations.length; i++) {
      const target = mutations[i].target;
      if (target && target.closest && target.closest('.attachment_preview')) continue;
      const added = mutations[i].addedNodes || [];
      for (let j = 0; j < added.length; j++) {
        if (containsAttachment(added[j])) {
          debouncedRefresh();
          return;
        }
      }
    }
  }

  function cleanup() {
    debouncedRefresh.cancel();
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function start() {
    if (!isDocumentPage()) return;
    refresh();

    if (!pagehideBound && typeof window !== 'undefined') {
      pagehideBound = true;
      window.addEventListener('pagehide', cleanup, { once: true });
    }

    if (!observer && typeof MutationObserver === 'function' &&
      typeof document !== 'undefined' && document.body) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  async function run() {
    if (busy) return;
    busy = true;

    // Must be called synchronously from the click handler.
    const win = DD.ui.openPrintWindow();
    if (!win) {
      busy = false;
      DD.ui.toast(
        'Trình duyệt đã chặn tab in. Hãy cho phép popup cho Academia.edu rồi thử lại.',
        'error'
      );
      return;
    }

    try {
      DD.ui.setState('working', 'Đang đọc tài liệu…');

      const attachmentId = getAttachmentId();
      if (!attachmentId) {
        throw new Error('Không tìm thấy mã tài liệu Academia trên trang này.');
      }

      const meta = await fetchPageDefs(attachmentId);
      const maxReturned = meta.pages[meta.pages.length - 1].page_number;
      const total = Math.min(maxReturned, DD.MAX_PAGES);

      if (maxReturned > DD.MAX_PAGES) {
        DD.ui.toast('Tài liệu có ' + maxReturned + ' trang; chỉ xử lý ' +
          DD.MAX_PAGES + ' trang đầu để tránh tốn RAM.', 'error');
      }

      const byNumber = new Map();
      meta.pages.forEach(function (def) {
        if (def.page_number <= total) byNumber.set(def.page_number, def);
      });

      const available = [];
      for (let n = 1; n <= total; n++) {
        const def = byNumber.get(n);
        if (def) available.push(def);
      }

      const prepared = new Map();
      const failed = [];
      let done = 0;
      DD.ui.progress(0, total, 'Đang tải 0/' + total + ' trang…');

      await DD.mapLimit(available, PAGE_CONCURRENCY, async function (def) {
        let text = null;
        let parts = null;
        try {
          text = await DD.fetchText(def.page_url, PAGE_TIMEOUT);
        } catch (error) {
          DD.warn('Could not fetch Academia page ' + def.page_number, error);
        }
        if (text) {
          try {
            parts = preparePage(text, def.page_url);
          } catch (error) {
            DD.warn('Could not prepare Academia page ' + def.page_number, error);
          }
        }

        if (parts) prepared.set(def.page_number, parts);
        else failed.push(def.page_number);

        done += 1;
        DD.ui.progress(done, total, 'Đang tải ' + done + '/' + total + ' trang…');
      });

      if (prepared.size === 0) {
        throw new Error('Không tải được trang nào từ Academia.');
      }

      const cssBlocks = [];
      for (let n = 1; n <= total; n++) {
        const parts = prepared.get(n);
        if (!parts || !parts.css) continue;
        cssBlocks.push(parts.css);
        parts.css = '';
      }
      const css = await inlineFonts(buildCss(cssBlocks));

      const slots = [];
      for (let n = 1; n <= total; n++) {
        slots.push({
          def: byNumber.get(n) || {
            page_number: n,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            page_url: ''
          },
          parts: prepared.get(n) || null
        });
      }

      const title = getTitle();
      const html = DD.buildPrintHtml({
        title: title,
        version: DD.VERSION,
        css: css,
        pagesHtml: slots.map(function (slot) {
          return pageHtml(slot.def, slot.parts);
        }).join(''),
        total: total
      });

      const delivered = await DD.ui.deliverPrintDocument(
        win,
        html,
        DD.buildFileName(title)
      );
      if (!delivered) {
        throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
      }

      let status = 'Đã tạo bản in (' + total + ' trang';
      if (failed.length) status += ', ' + failed.length + ' lỗi';
      if (meta.totalPages > maxReturned) {
        status += ', Academia chỉ gửi ' + maxReturned + '/' + meta.totalPages + ' trang';
      }
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

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () { busy = false; }, { once: true });
  }

  provider = {
    id: 'academia',
    label: 'Academia.edu',
    domains: DOMAINS,
    assetHosts: [ASSET_HOST],
    actionLabel: 'Tải PDF',
    busyLabel: 'Đang tải…',
    isDocumentPage: isDocumentPage,
    isAvailable: isAvailable,
    isAllowedAssetUrl: isAllowedAssetUrl,
    attachmentIdFrom: attachmentIdFrom,
    getAttachmentId: getAttachmentId,
    getTitle: getTitle,
    pageDefsUrl: pageDefsUrl,
    normalizePageDefs: normalizePageDefs,
    fetchPageDefs: fetchPageDefs,
    sanitizeCss: sanitizeCss,
    sanitizeInlineStyle: sanitizeInlineStyle,
    fontUrls: fontUrls,
    inlineFonts: inlineFonts,
    preparePage: preparePage,
    pageHtml: pageHtml,
    buildCss: buildCss,
    start: start,
    run: run
  };
  DD.registerProvider(provider);
})();
