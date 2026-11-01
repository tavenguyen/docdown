(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const DOMAINS = ['coursehero.com'];
  const PROP_MARKER = "_props_SsiDocumentLanding";
  // Toolbar width used when the viewer column is narrower (mobile). The page is
  // vector HTML, so normalising the width keeps the PDF readable everywhere.
  const TARGET_WIDTH = 1000;
  // A redacted region smaller than this share of the page is left unmarked: it
  // is decorative chrome, not content, and marking it only adds noise.
  const MIN_MARK_RATIO = 0.003;
  // Below this share a redaction does not change the page status on its own.
  const MIN_STATUS_COVERAGE = 0.005;
  const REDACTION_ATTRS = [
    'src', 'data-src', 'orig', 'srcset', 'data-background-image', 'data-background'
  ];

  let busy = false;
  let cached = null;

  function isDocumentPage() {
    try {
      return /^\/file\/\d+/.test(location.pathname);
    } catch (error) {
      return false;
    }
  }

  // The inline literal is sometimes double-escaped depending on how the page
  // was rendered, so try the raw string and the unescaped variants.
  function parseProps(body) {
    const attempts = [
      body,
      body.replace(/\\"/g, '"'),
      body.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    ];
    for (let i = 0; i < attempts.length; i++) {
      try {
        return JSON.parse(attempts[i]);
      } catch (error) {
        // Try the next shape.
      }
    }
    return null;
  }

  // Course Hero serialises its page props as an escaped object literal inside
  // an inline script. Unescape the quotes and parse it; never execute it.
  function decodePayload(source) {
    const text = String(source || '');
    const marker = text.indexOf(PROP_MARKER);
    if (marker === -1) return null;
    const eq = text.indexOf('=', marker);
    const end = text.indexOf('</script>', marker);
    if (eq === -1 || end === -1 || end <= eq) return null;

    const body = text.slice(eq + 1, end).trim();
    try {
      const data = parseProps(body);
      if (!data || typeof data !== 'object') return null;
      const values = Object.keys(data).map(function (key) { return data[key]; });
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value && value.viewerProps && value.viewerProps.documentContent) return value;
      }
      return null;
    } catch (error) {
      DD.warn('Could not parse Course Hero page props', error);
      return null;
    }
  }

  function readInfo(viewer) {
    if (!viewer || !viewer.viewerProps) return null;
    const content = viewer.viewerProps.documentContent || {};
    const info = content.documentInfo || {};
    const pageCount = Number(info.page_count) || 0;
    if (!pageCount) return null;
    return {
      pageCount: pageCount,
      previewPageCount: Number(info.previewPageCount) || 0,
      isLoggedIn: !!info.isLoggedIn,
      permission: String(viewer.realPermissionType || ''),
      subscription: String(viewer.subscriptionType || ''),
      fileHash: String(info.filehash || ''),
      unlockUrl: String(info.unlockUrl || '')
    };
  }

  function isBlurredUrl(url) {
    return /\/blur\//i.test(String(url || ''));
  }

  function absoluteAssetUrl(url) {
    if (!url) return '';
    try {
      const parsed = new URL(String(url), 'https://www.coursehero.com/');
      if (parsed.protocol !== 'https:') return '';
      if (parsed.hostname.toLowerCase() !== 'www.coursehero.com') return '';
      if (parsed.pathname.indexOf('..') !== -1) return '';
      if (!/^\/asset\/bg\/[a-f0-9]+\//i.test(parsed.pathname)) return '';
      if (isBlurredUrl(parsed.pathname)) return '';
      return parsed.href;
    } catch (error) {
      return '';
    }
  }

  function isAllowedAssetUrl(url) {
    return !!absoluteAssetUrl(url);
  }

  // Rewrites every url() in a stylesheet: blurred artwork is dropped, clear
  // Course Hero assets become absolute (the print page is a chrome-extension
  // origin, so a relative path would 404), everything else is neutralised.
  function rewriteCssUrls(css) {
    return String(css || '').replace(/url\((['"]?)([^)'"]+)\1\)/gi, function (full, quote, url) {
      if (isBlurredUrl(url)) return 'none';
      const absolute = absoluteAssetUrl(url);
      return absolute ? 'url("' + absolute + '")' : 'none';
    });
  }

  function safeCss(css) {
    return rewriteCssUrls(css)
      .replace(/@import[^;]*;/gi, '')
      .replace(/expression\s*\(/gi, '')
      .replace(/javascript\s*:/gi, '');
  }

  function classifyAccess(captured, total) {
    if (!total) return 'preview';
    return captured >= total ? 'full' : 'preview';
  }

  function safeUnlockUrl(url) {
    const value = String(url || '');
    if (!/^\/unlock-document\/\d+\//.test(value)) return '';
    return 'https://www.coursehero.com' + value;
  }

  // Why an element is going to disappear from the printed page. `blurred` is
  // the site's own redaction; `foreign` is artwork DocDown may not embed.
  function redactionReasonOf(element) {
    if (!element || !element.getAttribute) return '';
    let reason = '';
    REDACTION_ATTRS.forEach(function (name) {
      const value = element.getAttribute(name);
      if (!value) return;
      if (isBlurredUrl(value)) {
        reason = reason || 'blurred';
        return;
      }
      const isImageSource = name === 'src' || name === 'data-src' || name === 'orig';
      if (isImageSource && /^https?:/i.test(value) && !absoluteAssetUrl(value)) {
        reason = reason || 'foreign';
      }
    });
    const style = element.getAttribute('style');
    if (style && isBlurredUrl(style)) reason = reason || 'blurred';
    return reason;
  }

  function relativeRect(element, pageRect) {
    if (!pageRect || !element || !element.getBoundingClientRect) return null;
    let box = null;
    try {
      box = element.getBoundingClientRect();
    } catch (error) {
      return null;
    }
    if (!box || !(box.width > 0 && box.height > 0)) return null;
    return {
      x: box.left - pageRect.left,
      y: box.top - pageRect.top,
      w: box.width,
      h: box.height
    };
  }

  // Records where content was dropped, so the printed page can say so instead
  // of turning into a blank sheet. Only geometry is kept: never the asset URL.
  function collectRedactions(root, pageRect) {
    const rects = [];
    let unresolved = false;
    if (!root || !root.querySelectorAll) return { rects: rects, unresolved: unresolved };

    const nodes = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
    nodes.forEach(function (element) {
      const reason = redactionReasonOf(element);
      if (!reason) return;
      const rect = relativeRect(element, pageRect);
      if (!rect) {
        // Seen, but its position is unknown (virtualised or hidden node).
        unresolved = true;
        return;
      }
      rects.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, reason: reason });
    });

    // A blur inside a stylesheet cannot be tied back to one element, so the
    // page is marked as partly redacted without drawing a block.
    Array.prototype.slice.call(root.querySelectorAll('style')).forEach(function (style) {
      if (isBlurredUrl(style.textContent || '')) unresolved = true;
    });

    return { rects: rects, unresolved: unresolved };
  }

  // Union area of the redacted rects as a share of the page. A 64x64 grid keeps
  // overlapping rects from being counted twice.
  function coverageOf(rects, width, height) {
    const list = Array.isArray(rects) ? rects : [];
    if (!list.length || !(width > 0) || !(height > 0)) return 0;
    const cols = 64;
    const rows = 64;
    const grid = new Uint8Array(cols * rows);
    const epsilon = 1e-9;

    list.forEach(function (rect) {
      if (!rect) return;
      const x0 = Math.max(0, Math.min(width, Number(rect.x) || 0));
      const y0 = Math.max(0, Math.min(height, Number(rect.y) || 0));
      const x1 = Math.max(0, Math.min(width, (Number(rect.x) || 0) + (Number(rect.w) || 0)));
      const y1 = Math.max(0, Math.min(height, (Number(rect.y) || 0) + (Number(rect.h) || 0)));
      if (!(x1 > x0) || !(y1 > y0)) return;
      const colFrom = Math.floor(x0 / width * cols);
      const colTo = Math.min(cols - 1, Math.floor((x1 - epsilon) / width * cols));
      const rowFrom = Math.floor(y0 / height * rows);
      const rowTo = Math.min(rows - 1, Math.floor((y1 - epsilon) / height * rows));
      for (let row = rowFrom; row <= rowTo; row++) {
        for (let col = colFrom; col <= colTo; col++) grid[row * cols + col] = 1;
      }
    });

    let marked = 0;
    for (let i = 0; i < grid.length; i++) marked += grid[i];
    return marked / grid.length;
  }

  function classifyPage(page) {
    if (!page) return 'locked';
    const rects = Array.isArray(page.redactions) ? page.redactions : [];
    const blurred = rects.some(function (rect) {
      return rect && rect.reason === 'blurred';
    });
    if (blurred || page.unresolved) return 'partial';
    if (typeof page.coverage === 'number' && page.coverage >= MIN_STATUS_COVERAGE) return 'partial';
    return 'full';
  }

  function summarize(pages, total) {
    const list = Array.isArray(pages) ? pages : [];
    const declared = Math.max(0, Number(total) || 0);
    const captured = list.length;
    let partial = 0;
    list.forEach(function (page) {
      if (page && page.status === 'partial') partial += 1;
    });
    const locked = Math.max(0, declared - captured);
    const full = captured - partial;
    let mode = 'full';
    if (locked) mode = 'preview';
    else if (partial) mode = 'partial';
    return {
      total: Math.max(declared, captured),
      captured: captured,
      full: full,
      partial: partial,
      locked: locked,
      mode: mode
    };
  }

  function redactionOverlayHtml(redactions, width, height) {
    const list = Array.isArray(redactions) ? redactions : [];
    if (!list.length || !(width > 0) || !(height > 0)) return '';
    const minArea = width * height * MIN_MARK_RATIO;
    const blocks = [];

    list.forEach(function (rect) {
      if (!rect) return;
      const x = Math.max(0, Math.min(width, Number(rect.x) || 0));
      const y = Math.max(0, Math.min(height, Number(rect.y) || 0));
      const w = Math.min(width - x, Number(rect.w) || 0);
      const h = Math.min(height - y, Number(rect.h) || 0);
      if (!(w > 0) || !(h > 0)) return;
      if (w * h < minArea) return;
      blocks.push('<span class="docdown-ch-redacted" style="left:' + Math.round(x) +
        'px;top:' + Math.round(y) + 'px;width:' + Math.round(w) +
        'px;height:' + Math.round(h) + 'px"></span>');
    });

    if (!blocks.length) return '';
    return '<div class="docdown-ch-redactions">' + blocks.join('') + '</div>';
  }

  function partialNoteHtml(page) {
    const source = page || {};
    const label = DD.escapeHtml(String(source.pageNumber === undefined ? '' : source.pageNumber));
    const coverage = typeof source.coverage === 'number' && isFinite(source.coverage)
      ? Math.max(0, Math.min(1, source.coverage))
      : null;
    const percent = coverage === null ? 0 : Math.round(coverage * 100);
    const share = percent > 0
      ? percent + '% nội dung bị Course Hero làm mờ.'
      : 'một phần nội dung bị Course Hero làm mờ.';
    return '<div class="docdown-ch-note">Trang ' + label + ': ' + share + '</div>';
  }

  // Cleans one rendered page: keeps the text layer and its generated styles,
  // drops blurred artwork and anything executable, and reports what was dropped.
  function preparePage(element, pageRect) {
    const redactionInfo = collectRedactions(element, pageRect);
    const clone = element.cloneNode(true);

    clone.querySelectorAll(
      'script, iframe, object, embed, link, base, meta, form, input, button, textarea, select, video, audio, source, track, canvas, foreignObject'
    ).forEach(function (el) { el.remove(); });

    clone.querySelectorAll('style').forEach(function (style) {
      const css = safeCss(style.textContent || '');
      if (!css.trim()) style.remove();
      else style.textContent = css;
    });

    clone.querySelectorAll('img').forEach(function (img) {
      const raw = img.getAttribute('src') || img.getAttribute('data-src') ||
        img.getAttribute('orig') || '';
      const absolute = absoluteAssetUrl(raw);
      const keep = ['class', 'style', 'width', 'height'];
      Array.prototype.slice.call(img.attributes).forEach(function (attr) {
        if (keep.indexOf(attr.name.toLowerCase()) === -1) img.removeAttribute(attr.name);
      });
      if (img.getAttribute('style')) {
        img.setAttribute('style', rewriteCssUrls(img.getAttribute('style')));
      }
      if (!absolute) {
        img.remove();
        return;
      }
      img.setAttribute('src', absolute);
      img.setAttribute('alt', '');
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
    });

    clone.querySelectorAll('*').forEach(function (el) {
      if (el.tagName === 'IMG') return;
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '');
        if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'formaction') {
          el.removeAttribute(attr.name);
          return;
        }
        // Bookkeeping attributes carry the original URLs (including blurred
        // ones) and are not needed to render the page.
        if (name === 'data-props' || name === 'data-originaltag' ||
          name === 'data-background-image' || name === 'data-background') {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'style') {
          const rewritten = rewriteCssUrls(value).replace(/javascript\s*:/gi, '');
          if (rewritten !== value) el.setAttribute('style', rewritten);
          return;
        }
        if (name === 'src' || name === 'srcset') {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'href') {
          if (!/^https?:/i.test(value)) el.removeAttribute(attr.name);
          return;
        }
        if (isBlurredUrl(value)) el.removeAttribute(attr.name);
      });

      if (el.classList) {
        Array.prototype.slice.call(el.classList).forEach(function (token) {
          if (/paywall|unlock/i.test(token)) el.classList.remove(token);
        });
      }
      const testId = String(el.getAttribute('data-testid') || '');
      if (/paywall|unlock|upgrade/i.test(testId)) el.remove();
    });

    return {
      html: clone.innerHTML,
      redactions: redactionInfo.rects,
      coverage: pageRect
        ? coverageOf(redactionInfo.rects, pageRect.width, pageRect.height)
        : 0,
      unresolved: redactionInfo.unresolved
    };
  }

  function capturePages() {
    const nodes = Array.prototype.slice.call(
      document.querySelectorAll('[data-html-viewer-page]')
    );
    const pages = [];
    nodes.forEach(function (node) {
      const pageNumber = Number(node.getAttribute('data-html-viewer-page')) || pages.length + 1;
      if (!node.querySelector('.t')) return;

      const box = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      const rawWidth = box && box.width > 0 ? box.width : node.offsetWidth;
      const rawHeight = box && box.height > 0 ? box.height : node.offsetHeight;
      if (!(rawWidth > 0 && rawHeight > 0)) return;

      const scale = TARGET_WIDTH / rawWidth;
      const prepared = preparePage(node, box);
      pages.push({
        pageNumber: pageNumber,
        width: TARGET_WIDTH,
        height: Math.round(rawHeight * scale),
        rawWidth: rawWidth,
        rawHeight: rawHeight,
        scale: scale,
        html: prepared.html,
        redactions: prepared.redactions,
        coverage: prepared.coverage,
        unresolved: prepared.unresolved,
        status: classifyPage(prepared)
      });
    });
    return pages;
  }

  function pageHtml(page) {
    const redactions = Array.isArray(page.redactions) ? page.redactions : [];
    const overlay = redactionOverlayHtml(redactions, page.rawWidth, page.rawHeight);
    const note = classifyPage(page) === 'partial' ? partialNoteHtml(page) : '';
    return '<div class="pf docdown-ch-page" style="width:' + page.width + 'px;height:' +
      page.height + 'px" data-page-no="' + page.pageNumber + '">' +
      '<div class="docdown-ch-scale" style="width:' + page.rawWidth + 'px;height:' +
      page.rawHeight + 'px;transform:scale(' + page.scale + ');transform-origin:top left">' +
      overlay + page.html + '</div>' + note + '</div>';
  }

  function notePageHtml(width, height, total, missing, unlockUrl, partial) {
    const link = safeUnlockUrl(unlockUrl);
    const action = link
      ? '<div class="docdown-gated-text"><a href="' + DD.escapeAttr(link) +
        '" target="_blank" rel="noopener">Mở khóa trên Course Hero</a></div>'
      : '';
    const captured = Math.max(0, total - missing);
    const title = missing > 0 ? 'Bản xem trước' : 'Bản in một phần';
    const partialLine = partial > 0
      ? ' Trong đó ' + partial + ' trang bị làm mờ một phần, chỉ đọc được phần còn lại.'
      : '';
    const lockedLine = missing > 0
      ? ' ' + missing + ' trang còn lại cần tài khoản hoặc lượt mở khóa, ' +
        'nên DocDown không dựng chúng.'
      : '';
    return '<div class="pf docdown-ch-page" style="width:' + width + 'px;height:' + height + 'px">' +
      '<div class="docdown-gated-page">' +
      '<div class="docdown-gated-title">' + title + '</div>' +
      '<div class="docdown-gated-text">Course Hero chỉ gửi ' + captured + '/' + total +
      ' trang cho tài khoản này.' + partialLine + lockedLine + '</div>' + action + '</div></div>';
  }

  function buildCss() {
    return [
      '.docdown-ch-page{position:relative;overflow:hidden;background:#fff}',
      '.docdown-ch-scale{position:relative;overflow:hidden;background:#fff;isolation:isolate}',
      '.docdown-ch-redactions{position:absolute;inset:0;z-index:-1;pointer-events:none}',
      '.docdown-ch-redacted{position:absolute;background:repeating-linear-gradient(' +
        '45deg,rgba(229,231,235,.65) 0 6px,rgba(243,244,246,.65) 6px 12px);' +
        'border:1px dashed #9ca3af;box-sizing:border-box}',
      '.docdown-ch-note{position:absolute;right:8px;bottom:8px;z-index:5;max-width:70%;' +
        'background:rgba(180,83,9,.94);color:#fff;' +
        'font:600 12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;' +
        'padding:6px 8px;border-radius:4px}'
    ].join('\n');
  }

  function getState() {
    const href = (globalThis.location && globalThis.location.href) || '';
    if (cached && cached.href === href) return cached;
    const viewer = decodePayload(document.documentElement ? document.documentElement.outerHTML : '');
    const info = readInfo(viewer);
    const pages = capturePages();
    cached = { href: href, info: info, pages: pages };
    return cached;
  }

  function isAvailable() {
    return getState().pages.length > 0;
  }

  function buildStatus(summary) {
    const pages = summary.captured;
    const partial = summary.partial
      ? ', ' + summary.partial + ' trang bị làm mờ một phần'
      : '';
    if (summary.mode === 'full') {
      return 'Đã tạo bản in đầy đủ (' + pages + ' trang)';
    }
    if (summary.mode === 'partial') {
      return 'Đã tạo bản in (' + pages + ' trang' + partial +
        ') — phần bị làm mờ cần tài khoản';
    }
    const locked = summary.locked ? ', ' + summary.locked + ' trang còn khóa' : '';
    return 'Đã tạo bản xem trước (' + pages + '/' + summary.total +
      ' trang' + partial + locked + ') — bản đầy đủ cần tài khoản';
  }

  async function run() {
    if (busy) return;
    busy = true;

    // Must be called synchronously from the click handler.
    const win = DD.ui.openPrintWindow();
    if (!win) {
      busy = false;
      DD.ui.toast('Trình duyệt đã chặn tab in. Hãy cho phép popup cho Course Hero rồi thử lại.', 'error');
      return;
    }

    try {
      DD.ui.setState('working', 'Đang đọc tài liệu…');
      const state = getState();
      if (!state.pages.length) {
        throw new Error('Course Hero không gửi trang nào DocDown đọc được.');
      }

      const total = state.info ? state.info.pageCount : state.pages.length;
      const summary = summarize(state.pages, total);
      const pagesHtml = state.pages.map(pageHtml).join('');
      const last = state.pages[state.pages.length - 1];
      const note = (summary.locked || summary.partial)
        ? notePageHtml(last.width, last.height, summary.total, summary.locked,
          state.info ? state.info.unlockUrl : '', summary.partial)
        : '';

      const html = DD.buildPrintHtml({
        title: document.title,
        version: DD.VERSION,
        css: buildCss(),
        pagesHtml: pagesHtml + note,
        total: state.pages.length + (note ? 1 : 0)
      });

      const fileName = DD.buildFileName(document.title);
      const delivered = await DD.ui.deliverPrintDocument(win, html, fileName);
      if (!delivered) {
        throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
      }

      const status = buildStatus(summary);
      DD.ui.progress(1, 1, status);
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
    id: 'coursehero',
    label: 'Course Hero',
    domains: DOMAINS,
    assetHosts: ['www.coursehero.com'],
    actionLabel: 'Tải PDF',
    busyLabel: 'Đang đọc…',
    isDocumentPage: isDocumentPage,
    isAvailable: isAvailable,
    isAllowedAssetUrl: isAllowedAssetUrl,
    decodePayload: decodePayload,
    readInfo: readInfo,
    isBlurredUrl: isBlurredUrl,
    absoluteAssetUrl: absoluteAssetUrl,
    rewriteCssUrls: rewriteCssUrls,
    classifyAccess: classifyAccess,
    safeUnlockUrl: safeUnlockUrl,
    collectRedactions: collectRedactions,
    coverageOf: coverageOf,
    classifyPage: classifyPage,
    summarize: summarize,
    redactionOverlayHtml: redactionOverlayHtml,
    partialNoteHtml: partialNoteHtml,
    capturePages: capturePages,
    preparePage: preparePage,
    pageHtml: pageHtml,
    notePageHtml: notePageHtml,
    buildCss: buildCss,
    buildStatus: buildStatus,
    run: run
  };
  DD.registerProvider(provider);

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () { busy = false; }, { once: true });
  }
})();
