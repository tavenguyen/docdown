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

  // Streaming multi-part budgets. A part is one print document; the print tab
  // appends pages to it and then starts the next part on demand.
  const STREAM = {
    PROBE_PAGES: 16,
    BATCH_PAGES: 24,
    BATCH_MAX_BYTES: 6 * 1024 * 1024,
    PART_MAX_PAGES: 256,
    PART_MIN_PAGES: 32,
    PART_BUDGET_BYTES: 192 * 1024 * 1024,
    DOM_FACTOR: 6,
    NODE_BUDGET: 500000,
    HEAP_BUDGET_BYTES: 256 * 1024 * 1024,
    HEAP_SCALE: 2,
    STATIC_CAPACITY: 150,
    MAX_DOCUMENT_PAGES: 2000
  };

  let provider = null;
  let busy = false;
  let observer = null;
  let pagehideBound = false;
  let session = null;
  let activeStream = null;
  let unloading = false;

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

  function finiteNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  // Chooses how many pages fit in one print document. The probe measures one
  // batch; DOM and heap costs are extrapolated per page.
  function planCapacity(measure, probe) {
    if (!probe || typeof probe !== 'object') return STREAM.STATIC_CAPACITY;
    const pages = Number(probe.pages);
    if (!Number.isFinite(pages) || pages <= 0) return STREAM.STATIC_CAPACITY;

    const markupBytes = finiteNumber(probe.markupBytes);
    const cssBytes = finiteNumber(probe.cssBytes);
    const imageBytes = finiteNumber(probe.imageBytes);
    const nodeCount = finiteNumber(probe.nodes);
    if (markupBytes === null && cssBytes === null &&
      imageBytes === null && nodeCount === null) {
      return STREAM.STATIC_CAPACITY;
    }

    const markupPerPage = nonNegativeNumber(markupBytes) / pages;
    const cssPerPage = nonNegativeNumber(cssBytes) / pages;
    const imagePerPage = nonNegativeNumber(imageBytes) / pages;
    const nodePerPage = nonNegativeNumber(nodeCount) / pages;

    const heap = measure && typeof measure === 'object' ? finiteNumber(measure.heap) : null;
    const heapLimit = measure && typeof measure === 'object' ? finiteNumber(measure.heapLimit) : null;
    const baselineHeap = finiteNumber(probe.heap);
    let heapPerPage = null;
    if (heap !== null && heapLimit !== null && heapLimit > 0 && baselineHeap !== null) {
      heapPerPage = (heap - baselineHeap) / pages;
    }

    const byteCap = Math.floor(STREAM.PART_BUDGET_BYTES /
      Math.max(1, STREAM.DOM_FACTOR * markupPerPage + cssPerPage + imagePerPage));
    const nodeCap = Math.floor(STREAM.NODE_BUDGET / Math.max(1, nodePerPage));
    let heapCap = Infinity;
    if (heapPerPage !== null && Number.isFinite(heapPerPage) && heapPerPage > 0) {
      heapCap = Math.floor(STREAM.HEAP_BUDGET_BYTES / (STREAM.HEAP_SCALE * heapPerPage));
    }

    const capped = Math.min(STREAM.PART_MAX_PAGES, byteCap, nodeCap, heapCap);
    return Math.max(STREAM.PART_MIN_PAGES, Math.min(STREAM.PART_MAX_PAGES, capped));
  }

  // Pages per append batch, bounded by the part's remaining room, the pages
  // left in the document, and the 6 MB batch budget.
  function planBatch(remainingInPart, avgMarkupBytes, pagesLeft) {
    const remaining = Math.floor(Number(remainingInPart));
    const left = Math.floor(Number(pagesLeft));
    const average = Number(avgMarkupBytes);
    const byteLimit = Math.max(1, Math.floor(STREAM.BATCH_MAX_BYTES /
      Math.max(1, Number.isFinite(average) && average > 0 ? average : 1)));
    if (!Number.isFinite(remaining) || remaining < 1) return 1;
    if (!Number.isFinite(left) || left < 1) return 1;
    return Math.max(1, Math.min(STREAM.BATCH_PAGES, remaining, left, byteLimit));
  }

  // Shrinks the next part when the print tab is under heap pressure and grows
  // it when there is plenty of headroom.
  function adjustCapacity(capacity, lastMeasure) {
    const current = Number(capacity);
    const safe = Number.isFinite(current) && current > 0 ? current : STREAM.PART_MAX_PAGES;
    if (!lastMeasure || typeof lastMeasure !== 'object') return Math.round(safe);
    const heap = Number(lastMeasure.heap);
    const heapLimit = Number(lastMeasure.heapLimit);
    if (!Number.isFinite(heap) || !Number.isFinite(heapLimit) || heapLimit <= 0) {
      return Math.round(safe);
    }
    const ratio = heap / heapLimit;
    if (ratio > 0.65) return Math.max(STREAM.PART_MIN_PAGES, Math.floor(safe * 0.75));
    if (ratio < 0.35) return Math.min(STREAM.PART_MAX_PAGES, Math.ceil(safe * 1.15));
    return Math.round(safe);
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
  async function inlineFonts(css, fontCache) {
    const source = String(css === undefined || css === null ? '' : css);
    const urls = fontUrls(source);
    if (!urls.length) return source;

    const cache = fontCache instanceof Map ? fontCache : null;
    const values = new Map();
    try {
      await DD.mapLimit(urls, FONT_CONCURRENCY, async function (url) {
        try {
          if (cache && cache.has(url)) {
            const cached = cache.get(url);
            if (cached) {
              values.set(url, cached);
              return;
            }
          }
          const value = await DD.fetchDataUrl(url, FONT_TIMEOUT);
          if (value) {
            values.set(url, value);
            if (cache) cache.set(url, value);
          }
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

    const markup = root.outerHTML;
    const css = cssParts.join('\n');
    return {
      markup: markup,
      css: css,
      width: size.width,
      height: size.height,
      markupBytes: markup.length,
      cssBytes: css.length,
      nodeCount: root.querySelectorAll('*').length + 1,
      imageCount: root.querySelectorAll('img').length
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
        'px;height:' + defHeight + 'px" data-page-no="' + pageNumber + '">' +
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

  function buildCss(pageCss, seen) {
    const list = Array.isArray(pageCss) ? pageCss : [pageCss];
    const cleaned = list.map(sanitizeCss).filter(function (css) {
      return css.trim();
    }).join('\n');

    const baseRules = [
      '@page{size:auto;margin:0}',
      '.docdown-academia-page{position:relative;overflow:hidden;background:#fff}',
      '.docdown-academia-page #jpedal{max-width:none}'
    ];

    // Existing callers get the full stylesheet every time. The tag check also
    // accepts a Set created in another realm (for example in a test harness).
    const shared = !!seen &&
      Object.prototype.toString.call(seen) === '[object Set]';
    if (!shared) {
      return baseRules.concat([dedupeCss(cleaned)]).filter(Boolean).join('\n');
    }

    // Streaming callers share one Set across a part: the first batch gets the
    // base rules, later batches only the page rules they have not seen yet.
    const fresh = [];
    baseRules.concat(splitCss(cleaned)).forEach(function (block) {
      if (!block || seen.has(block)) return;
      seen.add(block);
      fresh.push(block);
    });
    return fresh.join('\n');
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

  function createSessionStream(win) {
    return DD.ui.createPrintStream(win, {
      onPrev: onPrintPrev,
      onNext: onPrintNext,
      onPrinted: onPrintPrinted,
      onFailed: onPrintFailed,
      onClosed: onPrintClosed
    });
  }

  function detachStream(stream) {
    if (!stream) return;
    try {
      if (typeof stream.close === 'function') stream.close();
    } catch (error) {
      // The print tab may already be gone.
    }
    if (activeStream === stream) activeStream = null;
  }

  function createSession(meta) {
    if (!meta || !Array.isArray(meta.pages) || !meta.pages.length) {
      throw new Error('Academia không gửi trang nào cho tài liệu này.');
    }

    const maxReturned = positiveNumber(meta.pages[meta.pages.length - 1].page_number);
    if (!maxReturned) {
      throw new Error('Academia trả về số trang không hợp lệ.');
    }
    if (maxReturned > STREAM.MAX_DOCUMENT_PAGES) {
      throw new Error('Academia báo ' + maxReturned + ' trang, vượt giới hạn an toàn ' +
        STREAM.MAX_DOCUMENT_PAGES + ' trang.');
    }

    const usableEnd = maxReturned;
    const declared = Math.max(positiveNumber(meta.totalPages), usableEnd);
    const totalPages = Math.min(declared, STREAM.MAX_DOCUMENT_PAGES);

    const byNumber = new Map();
    meta.pages.forEach(function (def) {
      if (def && def.page_number <= usableEnd) byNumber.set(def.page_number, def);
    });

    return {
      title: getTitle(),
      totalPages: totalPages,
      usableEnd: usableEnd,
      byNumber: byNumber,
      fontCache: new Map(),
      nextPage: 1,
      partIndex: 0,
      history: [],
      cursor: 0,
      capacity: STREAM.PART_MAX_PAGES,
      avgMarkupBytes: 0,
      partCssBytes: 0,
      partCssSeen: new Set(),
      failedPages: new Set(),
      current: null,
      resume: null,
      failureHandled: false,
      win: null,
      stream: null
    };
  }

  // Missing descriptors become white note pages, so a batch always covers a
  // contiguous page range and no page number is ever dropped.
  function defsForPageRange(sess, fromPage, toPage) {
    const defs = [];
    for (let page = fromPage; page <= toPage; page++) {
      defs.push(sess.byNumber.get(page) || {
        page_number: page,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        page_url: ''
      });
    }
    return defs;
  }

  async function fetchPageParts(def) {
    if (!def || !def.page_url) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await DD.sleep(750);
      let text = null;
      try {
        text = await DD.fetchText(def.page_url, PAGE_TIMEOUT);
      } catch (error) {
        DD.warn('Could not fetch Academia page ' + def.page_number, error);
      }
      if (!text) continue;
      try {
        const parts = preparePage(text, def.page_url);
        if (parts) return parts;
      } catch (error) {
        DD.warn('Could not prepare Academia page ' + def.page_number, error);
      }
    }
    return null;
  }

  async function loadBatch(sess, defs, partIndex, replay) {
    const total = defs.length;
    const fromPage = defs[0].page_number;
    const toPage = defs[total - 1].page_number;
    let done = 0;

    return DD.mapLimit(defs, PAGE_CONCURRENCY, async function (def) {
      const parts = await fetchPageParts(def);
      done += 1;
      if (parts) sess.failedPages.delete(def.page_number);
      else sess.failedPages.add(def.page_number);

      DD.ui.progress(Math.min(sess.usableEnd, fromPage + done - 1), sess.totalPages,
        (replay ? 'Đang dựng lại phần ' : 'Đang tải phần ') + partIndex + ': ' +
        done + '/' + total + ' trang (trang ' + fromPage + '–' + toPage + ')…');
      return parts;
    });
  }

  // print.js reports the markup bytes of the batch it just appended, so the
  // per-page average is batch bytes divided by batch pages.
  function batchAverageMarkup(ack, batchPages, fallbackBatchBytes) {
    if (!(batchPages > 0)) return 0;
    const bytes = ack && finiteNumber(ack.markupBytes);
    if (bytes !== null) return Math.max(0, bytes) / batchPages;
    const fallback = Number(fallbackBatchBytes);
    return Number.isFinite(fallback) && fallback > 0 ? fallback / batchPages : 0;
  }

  async function appendBatch(sess, stream, defs, parts, fromPage, toPage) {
    const css = await inlineFonts(buildCss(parts.map(function (part) {
      return part && part.css ? part.css : '';
    }), sess.partCssSeen), sess.fontCache);

    let markupTotal = 0;
    let cssTotal = 0;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i].markupBytes) markupTotal += parts[i].markupBytes;
      if (parts[i] && parts[i].cssBytes) cssTotal += parts[i].cssBytes;
    }

    const html = defs.map(function (def, index) {
      return pageHtml(def, parts[index]);
    }).join('');

    const ack = await stream.append({
      html: html,
      css: css,
      fromPage: fromPage,
      toPage: toPage
    });

    // The print tab owns the pages now. Drop this batch's markup and text so a
    // large document never keeps every prepared page in memory.
    for (let i = 0; i < parts.length; i++) parts[i] = null;
    return { ack: ack || {}, markupTotal: markupTotal, cssTotal: cssTotal };
  }

  function budgetExceeded(measure, totalMarkupBytes, totalCssBytes) {
    if (!measure || typeof measure !== 'object') return false;
    let markupBytes = finiteNumber(totalMarkupBytes);
    if (markupBytes === null) markupBytes = finiteNumber(measure.markupBytes);
    let cssBytes = finiteNumber(totalCssBytes);
    if (cssBytes === null) cssBytes = finiteNumber(measure.cssBytes);
    const imageBytes = finiteNumber(measure.imageBytes);
    if (markupBytes !== null || cssBytes !== null || imageBytes !== null) {
      const estimated = STREAM.DOM_FACTOR * Math.max(0, markupBytes || 0) +
        Math.max(0, cssBytes || 0) +
        Math.max(0, imageBytes || 0);
      if (estimated >= STREAM.PART_BUDGET_BYTES) return true;
    }

    const nodes = Number(measure.nodes);
    if (Number.isFinite(nodes) && nodes >= STREAM.NODE_BUDGET) return true;

    const heap = Number(measure.heap);
    const heapLimit = Number(measure.heapLimit);
    if (Number.isFinite(heap) && Number.isFinite(heapLimit) && heapLimit > 0) {
      if (heap >= STREAM.HEAP_BUDGET_BYTES) return true;
      if (heap / heapLimit >= 0.65) return true;
    }
    return false;
  }

  function historyAt(index) {
    if (!session || !Array.isArray(session.history)) return null;
    return session.history[index - 1] || null;
  }

  function nextPartExists(sess) {
    return !!(sess && sess.history[sess.cursor]) ||
      !!(sess && sess.nextPage <= sess.usableEnd);
  }

  function resumeForTarget(target, capacity) {
    return {
      partStartPage: target.fromPage,
      toPage: target.toPage || null,
      replay: !!target.replay,
      partIndex: target.index,
      capacity: capacity,
      fileName: target.fileName || ''
    };
  }

  function onPrintNext(data) {
    if (busy || !session || session.resume) return;
    const sess = session;
    const fromPart = Number(data && data.partIndex);
    if (Number.isFinite(fromPart) && fromPart > 0 && fromPart !== sess.cursor) return;
    const upcoming = sess.history[sess.cursor] || null;
    if (!upcoming && sess.nextPage > sess.usableEnd) return;

    if (!sess.win || !sess.stream || sess.win.closed) {
      const stream = sess.stream;
      const target = upcoming || {
        index: sess.partIndex + 1,
        fromPage: sess.nextPage,
        toPage: null,
        replay: false,
        fileName: ''
      };
      sess.stream = null;
      sess.win = null;
      sess.resume = resumeForTarget(target, sess.capacity);
      detachStream(stream);
      DD.ui.setState('ready', 'Tab in đã đóng. Bấm "Tải PDF" để mở lại và tiếp tục từ trang ' +
        target.fromPage + '.');
      return;
    }

    busy = true;
    const task = upcoming
      ? startPart(sess.win, sess.stream, {
        index: upcoming.index,
        fromPage: upcoming.fromPage,
        toPage: upcoming.toPage,
        fileName: upcoming.fileName,
        replay: true
      })
      : startPart(sess.win, sess.stream);
    task.then(function () {
      busy = false;
    }, function (error) {
      failSession(error, session && session.win);
      busy = false;
    });
  }

  function onPrintPrev(data) {
    if (busy || !session || session.resume) return;
    const sess = session;
    const fromPart = Number(data && data.partIndex);
    if (Number.isFinite(fromPart) && fromPart > 0 && fromPart !== sess.cursor) return;
    const target = sess.history[sess.cursor - 2];
    if (!target) return;

    if (!sess.win || !sess.stream || sess.win.closed) {
      const stream = sess.stream;
      sess.stream = null;
      sess.win = null;
      sess.resume = resumeForTarget({
        index: target.index,
        fromPage: target.fromPage,
        toPage: target.toPage,
        replay: true,
        fileName: target.fileName
      }, target.toPage - target.fromPage + 1);
      detachStream(stream);
      DD.ui.setState('ready', 'Tab in đã đóng. Bấm "Tải PDF" để mở lại phần ' +
        target.index + ' (trang ' + target.fromPage + '–' + target.toPage + ').');
      return;
    }

    busy = true;
    startPart(sess.win, sess.stream, {
      index: target.index,
      fromPage: target.fromPage,
      toPage: target.toPage,
      fileName: target.fileName,
      replay: true
    }).then(function () {
      busy = false;
    }, function (error) {
      failSession(error, session && session.win);
      busy = false;
    });
  }

  function onPrintPrinted(data) {
    const printed = Number(data && data.partIndex);
    const partIndex = Number.isFinite(printed) && printed > 0
      ? printed
      : (session && session.partIndex) || 0;
    let message = partIndex ? 'Đã in phần ' + partIndex + '.' : 'Đã in xong.';
    if (session && nextPartExists(session)) {
      const next = session.history[session.cursor]
        ? session.history[session.cursor].index
        : session.partIndex + 1;
      message += ' Bấm "Phần tiếp theo" trong tab in để mở phần ' + next + '.';
    } else {
      message += ' Bấm "Ghép PDF" trong tab in nếu cần ghép các phần.';
    }
    DD.ui.progressText(message);
  }

  function onPrintFailed(data) {
    const stage = data && data.stage ? String(data.stage) : 'in';
    const detail = data && data.message ? String(data.message) : 'Tab in báo lỗi.';
    failSession(new Error('Không tạo được bản in (' + stage + '): ' + detail));
  }

  function onPrintClosed() {
    if (unloading) return;
    const stream = activeStream || (session && session.stream);

    if (session) {
      const activeCurrent = session.current;
      const viewed = historyAt(session.cursor);
      let resume = null;

      if (activeCurrent) {
        resume = {
          partStartPage: activeCurrent.fromPage,
          toPage: activeCurrent.toPage || null,
          replay: !!activeCurrent.replay,
          partIndex: activeCurrent.partIndex || session.partIndex,
          capacity: activeCurrent.replay
            ? Math.max(1, activeCurrent.toPage - activeCurrent.fromPage + 1)
            : Math.max(1, Math.min(STREAM.PART_MAX_PAGES,
              Number(activeCurrent.capacity) || STREAM.PART_MAX_PAGES)),
          fileName: activeCurrent.fileName || ''
        };
      } else if (viewed && session.cursor < session.history.length) {
        // The user closed the tab while reviewing an older part. Reopen that
        // exact part instead of skipping forward.
        resume = resumeForTarget({
          index: viewed.index,
          fromPage: viewed.fromPage,
          toPage: viewed.toPage,
          replay: true,
          fileName: viewed.fileName
        }, viewed.toPage - viewed.fromPage + 1);
      } else if (session.nextPage <= session.usableEnd) {
        resume = {
          partStartPage: session.nextPage,
          toPage: null,
          replay: false,
          partIndex: session.partIndex + 1,
          capacity: session.capacity || STREAM.PART_MAX_PAGES,
          fileName: ''
        };
      } else if (viewed) {
        resume = resumeForTarget({
          index: viewed.index,
          fromPage: viewed.fromPage,
          toPage: viewed.toPage,
          replay: true,
          fileName: viewed.fileName
        }, viewed.toPage - viewed.fromPage + 1);
      }

      if (resume) session.resume = resume;
      session.failureHandled = true;
        session.current = null;
      session.stream = null;
      session.win = null;
      const target = resume && resume.partStartPage
        ? resume.partStartPage
        : session.nextPage;
      DD.ui.setState('ready', 'Tab in đã đóng. Bấm "Tải PDF" để mở lại và tiếp tục từ trang ' +
        target + '.');
    }

    detachStream(stream);
    busy = false;
  }

  function failSession(error, win) {
    if (unloading) {
      busy = false;
      return;
    }
    const message = 'Không tải được tài liệu: ' +
      (error && error.message ? error.message : 'lỗi không xác định');

    if (session && session.failureHandled) {
      busy = false;
      return;
    }

    if (!session) {
      busy = false;
      DD.warn(message);
      DD.ui.setState('error', message);
      DD.ui.toast(message, 'error');
      if (win && !activeStream && typeof DD.ui.showPrintError === 'function') {
        DD.ui.showPrintError(win, message);
      }
      return;
    }

    session.failureHandled = true;
    const activeCurrent = session.current;
    let resume;
    if (activeCurrent && activeCurrent.replay && activeCurrent.toPage) {
      resume = {
        partStartPage: activeCurrent.fromPage,
        toPage: activeCurrent.toPage,
        replay: true,
        partIndex: activeCurrent.partIndex || session.partIndex,
        capacity: Math.max(1, activeCurrent.toPage - activeCurrent.fromPage + 1),
        fileName: activeCurrent.fileName || ''
      };
    } else {
      const current = activeCurrent || {
        fromPage: session.nextPage,
        capacity: session.capacity || STREAM.PART_MAX_PAGES
      };
      const capacity = Number(current.capacity) || STREAM.PART_MAX_PAGES;
      resume = {
        partStartPage: current.fromPage,
        toPage: null,
        replay: false,
        partIndex: activeCurrent
          ? (activeCurrent.partIndex || session.partIndex)
          : session.partIndex + 1,
        capacity: Math.max(STREAM.PART_MIN_PAGES, Math.floor(capacity / 2)),
        fileName: ''
      };
    }
    session.resume = resume;
    busy = false;
    DD.warn(message);
    DD.ui.setState('error', message);
    DD.ui.toast(message, 'error');
    if (win && !win.closed && session && !session.current &&
      session.partIndex === 0 && typeof DD.ui.showPrintError === 'function') {
      DD.ui.showPrintError(win, message);
    }
  }

  async function startPart(win, stream, target) {
    const sess = session;
    if (!sess || !win || !stream || (!target && sess.nextPage > sess.usableEnd)) return;

    const replay = !!(target && target.replay);
    const partIndex = replay ? Number(target.index) : sess.partIndex + 1;
    const fromPage = replay ? Number(target.fromPage) : sess.nextPage;
    const fixedEnd = replay ? Number(target.toPage) : 0;
    if (!Number.isFinite(partIndex) || partIndex < 1 ||
      !Number.isFinite(fromPage) || fromPage < 1 ||
      fromPage > sess.usableEnd) return;
    if (replay && (!Number.isFinite(fixedEnd) || fixedEnd < fromPage)) return;

    sess.failureHandled = false;
    let capacity = replay
      ? fixedEnd - fromPage + 1
      : (Number(sess.capacity) > 0 ? Math.floor(sess.capacity) : STREAM.PART_MAX_PAGES);
    capacity = Math.max(1, Math.min(STREAM.PART_MAX_PAGES, capacity));
    sess.current = {
      fromPage: fromPage,
      capacity: capacity,
      partIndex: partIndex,
      toPage: replay ? fixedEnd : null,
      replay: replay,
      fileName: replay ? (target.fileName || '') : ''
    };
    sess.partMarkupBytes = 0;
    sess.partCssBytes = 0;
    sess.partCssSeen = new Set();

    const title = sess.title;
    const skeleton = DD.buildPrintHtml({
      title: title,
      version: DD.VERSION,
      css: '',
      pagesHtml: '',
      total: sess.totalPages,
      part: { index: partIndex, fromPage: fromPage, totalPages: sess.totalPages }
    });

    DD.ui.setState('working', replay
      ? 'Đang dựng lại phần ' + partIndex + ' (trang ' + fromPage + '–' + fixedEnd + ')…'
      : 'Đang mở phần ' + partIndex + ' (từ trang ' + fromPage + ')…');
    const begun = await stream.begin({
      html: skeleton,
      title: title,
      fileName: DD.buildFileName(title) + ' - phần ' + partIndex,
      part: { index: partIndex, fromPage: fromPage, totalPages: sess.totalPages }
    });
    const baseline = begun && begun.baseline ? begun.baseline : {};

    let pagesInPart = 0;
    let lastAppended = fromPage - 1;
    let lastAck = null;
    let averageMarkup = Number(sess.avgMarkupBytes) > 0
      ? Number(sess.avgMarkupBytes)
      : 0;

    // Only a new first part probes. A replay already knows its exact range and
    // must not re-plan or change the part boundaries.
    if (!replay && partIndex === 1) {
      const probeCount = Math.min(
        STREAM.PROBE_PAGES,
        sess.usableEnd - fromPage + 1,
        capacity
      );
      if (probeCount > 0) {
        const probeDefs = defsForPageRange(sess, fromPage, fromPage + probeCount - 1);
        const probeParts = await loadBatch(sess, probeDefs, partIndex);
        const probeResult = await appendBatch(
          sess,
          stream,
          probeDefs,
          probeParts,
          probeDefs[0].page_number,
          probeDefs[probeDefs.length - 1].page_number
        );
        lastAck = probeResult.ack;
        pagesInPart = probeCount;
        lastAppended = fromPage + probeCount - 1;
        sess.partMarkupBytes += probeResult.markupTotal;
        sess.partCssBytes += probeResult.cssTotal;
        averageMarkup = batchAverageMarkup(lastAck, probeCount, probeResult.markupTotal);

        const baseNodes = Number(baseline.nodes) || 0;
        const probeNodes = Math.max(0, (Number(lastAck.nodes) || 0) - baseNodes);
        const baseImages = Number(baseline.imageBytes) || 0;
        const probeImages = Math.max(0, (Number(lastAck.imageBytes) || 0) - baseImages);
        capacity = planCapacity(lastAck, {
          pages: pagesInPart,
          markupBytes: lastAck.markupBytes == null
            ? sess.partMarkupBytes
            : lastAck.markupBytes,
          cssBytes: lastAck.cssBytes == null
            ? sess.partCssBytes
            : lastAck.cssBytes,
          imageBytes: probeImages,
          heap: baseline.heap,
          nodes: probeNodes
        });
        sess.current.capacity = capacity;
      }
    }

    if (replay) {
      let page = fromPage;
      while (page <= fixedEnd) {
        const endPage = Math.min(fixedEnd, page + STREAM.BATCH_PAGES - 1);
        const batchDefs = defsForPageRange(sess, page, endPage);
        const batchParts = await loadBatch(sess, batchDefs, partIndex, true);
        const batchResult = await appendBatch(
          sess,
          stream,
          batchDefs,
          batchParts,
          batchDefs[0].page_number,
          batchDefs[batchDefs.length - 1].page_number
        );
        pagesInPart += batchDefs.length;
        lastAppended = endPage;
        lastAck = batchResult.ack;
        sess.partMarkupBytes += batchResult.markupTotal;
        sess.partCssBytes += batchResult.cssTotal;
        page = endPage + 1;
      }
    } else {
      while (pagesInPart < capacity && lastAppended < sess.usableEnd &&
        !budgetExceeded(lastAck, sess.partMarkupBytes, sess.partCssBytes)) {
        const pagesLeft = sess.usableEnd - lastAppended;
        const remainingInPart = capacity - pagesInPart;
        if (remainingInPart < 1 || pagesLeft < 1) break;

        const batchSize = planBatch(remainingInPart, averageMarkup, pagesLeft);
        const startPage = lastAppended + 1;
        const endPage = Math.min(sess.usableEnd, startPage + batchSize - 1);
        const batchDefs = defsForPageRange(sess, startPage, endPage);
        if (!batchDefs.length) break;

        const batchParts = await loadBatch(sess, batchDefs, partIndex);
        const batchResult = await appendBatch(
          sess,
          stream,
          batchDefs,
          batchParts,
          batchDefs[0].page_number,
          batchDefs[batchDefs.length - 1].page_number
        );
        const previousPages = pagesInPart;
        pagesInPart += batchDefs.length;
        lastAppended = endPage;
        lastAck = batchResult.ack;
        sess.partMarkupBytes += batchResult.markupTotal;
        sess.partCssBytes += batchResult.cssTotal;

        const batchAverage = batchAverageMarkup(
          lastAck,
          batchDefs.length,
          batchResult.markupTotal
        );
        if (batchAverage > 0) {
          averageMarkup = previousPages > 0
            ? ((averageMarkup * previousPages) + (batchAverage * batchDefs.length)) / pagesInPart
            : batchAverage;
          sess.avgMarkupBytes = averageMarkup;
        }
        sess.current.capacity = capacity;
      }
    }

    sess.avgMarkupBytes = averageMarkup;
    const endPage = lastAppended;
    const hasPrev = partIndex > 1;
    const hasNext = replay
      ? (partIndex < sess.history.length || endPage < sess.usableEnd)
      : endPage < sess.usableEnd;
    const fileName = replay
      ? (target.fileName || (DD.buildFileName(title) + ' - phần ' + partIndex +
        ' (trang ' + fromPage + '–' + endPage + ')'))
      : (DD.buildFileName(title) + ' - phần ' + partIndex +
        ' (trang ' + fromPage + '–' + endPage + ')');

    DD.ui.setState('working', 'Đang chốt phần ' + partIndex +
      ' (trang ' + fromPage + '–' + endPage + ')…');
    await stream.finalize({
      fileName: fileName,
      fromPage: fromPage,
      toPage: endPage,
      hasNext: hasNext,
      hasPrev: hasPrev,
      title: title,
      totalPages: sess.totalPages
    });

    if (!replay) {
      sess.nextPage = endPage + 1;
      sess.partIndex = partIndex;
      sess.capacity = adjustCapacity(capacity, lastAck);
      sess.history[partIndex - 1] = {
        index: partIndex,
        fromPage: fromPage,
        toPage: endPage,
        fileName: fileName
      };
    }
    sess.cursor = partIndex;
    sess.current = null;

    if (!hasNext) {
      const failedCount = sess.failedPages ? sess.failedPages.size : 0;
      const usableEnd = sess.usableEnd;
      const totalPages = sess.totalPages;
      let message = 'Đã tạo phần cuối (trang ' + fromPage + '–' + endPage + ')';
      if (failedCount) message += ', ' + failedCount + ' trang lỗi';
      if (totalPages > usableEnd) {
        message += ', Academia chỉ gửi ' + usableEnd + '/' + totalPages + ' trang';
      }
      message += '. Bấm "Ghép PDF" trong tab in để ghép các phần.';

      DD.ui.setState('idle');
      DD.ui.toast(message, 'success', { duration: 10000 });
      return;
    }

    const message = replay
      ? 'Đã dựng lại phần ' + partIndex + ' (trang ' + fromPage + '–' + endPage +
        '). Bấm "Phần tiếp theo" trong tab in để mở phần ' + (partIndex + 1) + '.'
      : 'Đã tạo phần ' + partIndex + ' (trang ' + fromPage + '–' + endPage +
        '). Bấm "Phần tiếp theo" trong tab in để tải phần ' + (partIndex + 1) + '.';
    DD.ui.progress(endPage, Math.max(endPage, sess.totalPages), message);
    DD.ui.setState('ready', message);
  }

  async function run() {
    if (busy) return;
    busy = true;
    unloading = false;

    // When the tab is still open, the toolbar owns navigation. Do not start a
    // new part from the FAB; after a failure the resume state explicitly allows
    // a retry.
    if (session && session.win && !session.win.closed && !session.resume) {
      if (session.cursor > 0) {
        const hasNext = nextPartExists(session);
        busy = false;
        DD.ui.setState('ready', hasNext
          ? 'Phần ' + session.cursor + ' đã sẵn sàng. Bấm "Phần tiếp theo" trong tab in để mở phần ' +
            (session.history[session.cursor] ? session.history[session.cursor].index : session.partIndex + 1) + '.'
          : 'Phần cuối đã sẵn sàng. Bấm "Ghép PDF" trong tab in để ghép các phần.');
        return;
      }
    }

    let win = session && session.win && !session.win.closed ? session.win : null;

    // Must be called synchronously from the click handler when a new tab is
    // needed: a fresh session, or resuming after the print tab was closed.
    if (!win) {
      if (session && session.stream) {
        detachStream(session.stream);
        session.stream = null;
      } else if (!session && activeStream) {
        detachStream(activeStream);
      }
      win = DD.ui.openPrintWindow();
      if (!win) {
        busy = false;
        DD.ui.toast(
          'Trình duyệt đã chặn tab in. Hãy cho phép popup cho Academia.edu rồi thử lại.',
          'error'
        );
        return;
      }
      if (session) {
        session.win = null;
        session.stream = null;
      }
    }

    try {
      if (!session) {
        DD.ui.setState('working', 'Đang đọc tài liệu…');
        const attachmentId = getAttachmentId();
        if (!attachmentId) {
          throw new Error('Không tìm thấy mã tài liệu Academia trên trang này.');
        }
        const meta = await fetchPageDefs(attachmentId);
        session = createSession(meta);
      }

      session.win = win;
      if (!session.stream) {
        session.stream = createSessionStream(win);
        activeStream = session.stream;
      } else if (activeStream !== session.stream) {
        activeStream = session.stream;
      }

      if (win.closed) throw new Error('Tab in đã bị đóng trước khi bắt đầu.');
      await session.stream.waitForReady();

      if (!session.resume && session.history.length) {
        // The tab was closed without the onClosed callback. Reopen the part the
        // user was viewing, or continue with the next unseen part.
        const viewed = historyAt(session.cursor);
        if (session.cursor < session.history.length) {
          session.resume = resumeForTarget({
            index: viewed.index,
            fromPage: viewed.fromPage,
            toPage: viewed.toPage,
            replay: true,
            fileName: viewed.fileName
          }, viewed.toPage - viewed.fromPage + 1);
        } else if (session.nextPage <= session.usableEnd) {
          session.resume = {
            partStartPage: session.nextPage,
            toPage: null,
            replay: false,
            partIndex: session.partIndex + 1,
            capacity: session.capacity || STREAM.PART_MAX_PAGES,
            fileName: ''
          };
        } else if (viewed) {
          session.resume = resumeForTarget({
            index: viewed.index,
            fromPage: viewed.fromPage,
            toPage: viewed.toPage,
            replay: true,
            fileName: viewed.fileName
          }, viewed.toPage - viewed.fromPage + 1);
        }
      }

      if (session.resume) {
        const resume = session.resume;
        session.current = null;
        session.resume = null;
            session.failureHandled = false;

        if (resume.replay && Number(resume.toPage) >= Number(resume.partStartPage)) {
          const index = Number(resume.partIndex);
          const stored = historyAt(index);
          await startPart(win, session.stream, stored
            ? {
              index: stored.index,
              fromPage: stored.fromPage,
              toPage: stored.toPage,
              fileName: stored.fileName,
              replay: true
            }
            : {
              index: index,
              fromPage: Number(resume.partStartPage),
              toPage: Number(resume.toPage),
              fileName: resume.fileName || '',
              replay: true
            });
          return;
        }

        const resumePage = Number(resume.partStartPage);
        session.nextPage = Number.isFinite(resumePage) && resumePage > 0
          ? Math.min(session.usableEnd, Math.floor(resumePage))
          : session.nextPage;
        const resumeCapacity = Number(resume.capacity);
        if (Number.isFinite(resumeCapacity) && resumeCapacity > 0) {
          session.capacity = Math.max(1, Math.min(STREAM.PART_MAX_PAGES,
            Math.floor(resumeCapacity)));
        }
        const resumePartIndex = Number(resume.partIndex);
        if (Number.isFinite(resumePartIndex) && resumePartIndex > 0) {
          // startPart() increments the part index, so restore one less to
          // resume the same failed/closed part instead of skipping it.
          session.partIndex = Math.max(0, Math.floor(resumePartIndex) - 1);
        }
      }

      session.failureHandled = false;
      await startPart(win, session.stream);
    } catch (error) {
      failSession(error, win);
    } finally {
      busy = false;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () {
      unloading = true;
      busy = false;
      if (session) {
        if (session.fontCache) session.fontCache.clear();
        session.stream = null;
      }
      detachStream(activeStream);
      activeStream = null;
    }, { once: true });
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
    STREAM: STREAM,
    planCapacity: planCapacity,
    planBatch: planBatch,
    adjustCapacity: adjustCapacity,
    start: start,
    run: run
  };
  DD.registerProvider(provider);
})();
