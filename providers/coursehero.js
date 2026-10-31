(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const DOMAINS = ['coursehero.com'];
  const PROP_MARKER = "_props_SsiDocumentLanding";
  // Toolbar width used when the viewer column is narrower (mobile). The page is
  // vector HTML, so normalising the width keeps the PDF readable everywhere.
  const TARGET_WIDTH = 1000;

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

  // Cleans one rendered page: keeps the text layer and its generated styles,
  // drops blurred artwork and anything executable.
  function preparePage(element) {
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

    return clone.innerHTML;
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
      pages.push({
        pageNumber: pageNumber,
        width: TARGET_WIDTH,
        height: Math.round(rawHeight * scale),
        rawWidth: rawWidth,
        rawHeight: rawHeight,
        scale: scale,
        html: preparePage(node)
      });
    });
    return pages;
  }

  function pageHtml(page) {
    return '<div class="pf docdown-ch-page" style="width:' + page.width + 'px;height:' +
      page.height + 'px" data-page-no="' + page.pageNumber + '">' +
      '<div class="docdown-ch-scale" style="width:' + page.rawWidth + 'px;height:' +
      page.rawHeight + 'px;transform:scale(' + page.scale + ');transform-origin:top left">' +
      page.html + '</div></div>';
  }

  function notePageHtml(width, height, total, missing, unlockUrl) {
    const link = safeUnlockUrl(unlockUrl);
    const action = link
      ? '<div class="docdown-gated-text"><a href="' + DD.escapeAttr(link) +
        '" target="_blank" rel="noopener">Mở khóa trên Course Hero</a></div>'
      : '';
    return '<div class="pf docdown-ch-page" style="width:' + width + 'px;height:' + height + 'px">' +
      '<div class="docdown-gated-page">' +
      '<div class="docdown-gated-title">Bản xem trước</div>' +
      '<div class="docdown-gated-text">Course Hero chỉ gửi ' + (total - missing) + '/' + total +
      ' trang cho tài khoản này. ' + missing + ' trang còn lại cần tài khoản hoặc lượt mở khóa, ' +
      'nên DocDown không dựng chúng.</div>' + action + '</div></div>';
  }

  function buildCss() {
    return [
      '.docdown-ch-page{position:relative;overflow:hidden;background:#fff}',
      '.docdown-ch-scale{position:relative;overflow:hidden;background:#fff}'
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
      const mode = classifyAccess(state.pages.length, total);
      const pagesHtml = state.pages.map(pageHtml).join('');
      const missing = Math.max(0, total - state.pages.length);
      const last = state.pages[state.pages.length - 1];
      const note = mode === 'preview' && missing
        ? notePageHtml(last.width, last.height, total, missing,
          state.info ? state.info.unlockUrl : '')
        : '';

      const html = DD.buildPrintHtml({
        title: document.title,
        version: DD.VERSION,
        css: buildCss(),
        pagesHtml: pagesHtml + note,
        total: state.pages.length + (missing ? 1 : 0)
      });

      const fileName = DD.buildFileName(document.title);
      const delivered = await DD.ui.deliverPrintDocument(win, html, fileName);
      if (!delivered) {
        throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
      }

      const status = mode === 'full'
        ? 'Đã tạo bản in đầy đủ (' + state.pages.length + ' trang)'
        : 'Đã tạo bản xem trước (' + state.pages.length + '/' + total +
          ' trang' + (missing ? ', ' + missing + ' trang còn khóa' : '') +
          ') — bản đầy đủ cần tài khoản';
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
    capturePages: capturePages,
    preparePage: preparePage,
    pageHtml: pageHtml,
    notePageHtml: notePageHtml,
    buildCss: buildCss,
    run: run
  };
  DD.registerProvider(provider);

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () { busy = false; }, { once: true });
  }
})();
