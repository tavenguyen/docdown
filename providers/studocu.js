(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const DOC_ASSETS = 'https://doc-assets.studocu.com/';
  const ASSET_HOSTS = new Set(['doc-assets.studocu.com', 'website-assets.studocu.com']);
  const DOMAINS = ['studocu.com', 'studocu.vn', 'studocu.id', 'studeersnel.nl'];

  let provider = null;

  function getViewerPages() {
    return Array.prototype.slice.call(
      document.querySelectorAll('#page-container .pf, .p2hv .pf')
    ).filter(function (pf) {
      return !pf.closest('#docdown-print-root');
    });
  }

  function isDocumentPage() {
    try {
      return /\/document\//.test(location.pathname) ||
        !!document.getElementById('page-container') ||
        !!document.querySelector('.p2hv .pf');
    } catch (error) {
      return false;
    }
  }

  function getPageProps() {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el) return null;
    try {
      const data = JSON.parse(el.textContent || '{}');
      return (data && data.props && data.props.pageProps) || null;
    } catch (error) {
      DD.warn('Could not parse __NEXT_DATA__', error);
      return null;
    }
  }

  function getTitle() {
    const h1 = document.querySelector('h1');
    const heading = h1 && h1.textContent ? h1.textContent.trim() : '';
    return heading || document.title || 'document';
  }

  function pickParam(params, keys) {
    if (!params || typeof params !== 'object') return '';
    for (let i = 0; i < keys.length; i++) {
      const value = params[keys[i]];
      if (typeof value === 'string' && value) return value;
    }
    return '';
  }

  // Pure: converts pageProps into the shape used by the downloader.
  function parseDocumentMeta(pageProps, fallback) {
    const props = pageProps && typeof pageProps === 'object' ? pageProps : {};
    const doc = props.document && typeof props.document === 'object' ? props.document : null;
    const access = props.documentAccess && typeof props.documentAccess === 'object'
      ? props.documentAccess
      : null;
    const signed = (access && access.signedQueryParams) || {};
    const fb = fallback || {};

    let objectKey = access && access.objectKey ? String(access.objectKey) : '';
    if (objectKey && !/^[a-zA-Z0-9]+$/.test(objectKey)) objectKey = '';

    let baseUrl = access && access.url ? String(access.url) : '';
    if (!baseUrl && objectKey) baseUrl = DOC_ASSETS + objectKey + '/html/';
    if (baseUrl && baseUrl.charAt(baseUrl.length - 1) !== '/') baseUrl += '/';

    const pageParams = {};
    if (Array.isArray(signed.pages)) {
      signed.pages.forEach(function (page) {
        if (!page || typeof page !== 'object') return;
        const pageNumber = Number(page.pageNumber);
        if (pageNumber > 0 && typeof page.signedQueryParams === 'string' && page.signedQueryParams) {
          pageParams[pageNumber] = page.signedQueryParams;
        }
      });
    }

    const pageClasses = [];
    if (Array.isArray(props.pageDataList)) {
      props.pageDataList.forEach(function (page, index) {
        const wrapper = page && typeof page.pageHtmlWrapper === 'string' ? page.pageHtmlWrapper : '';
        const match = wrapper.match(/class="([^"]+)"/);
        if (match) pageClasses[index] = match[1];
      });
    }
    if (Array.isArray(fb.pageClasses)) {
      fb.pageClasses.forEach(function (className, index) {
        if (!pageClasses[index] && className) pageClasses[index] = String(className);
      });
    }

    const pageCount = Number(doc && doc.numberOfPages) ||
      Number(fb.pageCount) ||
      pageClasses.length ||
      0;

    if (!pageCount) return null;

    const documentTitle = (typeof document !== 'undefined' && document.title) || '';
    return {
      title: (doc && doc.title) || fb.title || documentTitle || 'document',
      pageCount: pageCount,
      objectKey: objectKey,
      baseUrl: baseUrl,
      signedParams: signed,
      pageParams: pageParams,
      hasPageList: Array.isArray(signed.pages),
      hasBlurredPages: !!(access && access.hasBlurredPages),
      pageClasses: pageClasses,
      canFetch: !!(baseUrl && objectKey)
    };
  }

  function getDocumentMeta() {
    const viewerPages = getViewerPages();
    const fallback = {
      title: getTitle(),
      pageCount: viewerPages.length,
      pageClasses: viewerPages.map(function (pf) { return pf.className || ''; })
    };
    return parseDocumentMeta(getPageProps(), fallback);
  }

  function buildUrls(meta, pageNumber) {
    const empty = { bgUrl: '', textUrl: '', clearPageUrl: '', cssUrl: '' };
    if (!meta || !meta.objectKey || !meta.baseUrl) return empty;

    const params = meta.signedParams || {};
    const pageParams = meta.pageParams || {};
    const bgParam = pickParam(params, ['png', 'global']);
    const textParam = pageParams[pageNumber] || pickParam(params, ['html', 'global']);
    const clearParam = pickParam(params, ['global', 'blurredPage', 'png']);
    const cssParam = pickParam(params, ['css', 'global']);
    const base = meta.baseUrl;
    const key = meta.objectKey;

    return {
      bgUrl: bgParam ? base + 'bg' + pageNumber.toString(16) + '.png' + bgParam : '',
      textUrl: textParam ? base + key + pageNumber + '.page' + textParam : '',
      clearPageUrl: clearParam ? base + 'pages/page' + pageNumber + '.webp' + clearParam : '',
      cssUrl: cssParam ? base + key + '.css' + cssParam : ''
    };
  }

  function isAllowedAssetUrl(url) {
    if (!url) return false;
    try {
      const base = (globalThis.location && globalThis.location.href) || 'https://www.studocu.vn/';
      const parsed = new URL(url, base);
      if (parsed.protocol !== 'https:') return false;
      if (!ASSET_HOSTS.has(parsed.hostname.toLowerCase())) return false;
      if (parsed.pathname.indexOf('..') !== -1) return false;
      return true;
    } catch (error) {
      return false;
    }
  }

  function domPageHtml(pageNumber) {
    const pages = getViewerPages();
    const page = pages[pageNumber - 1];
    if (!page) return '';
    const clone = page.cloneNode(true);
    clone.removeAttribute('style');
    clone.querySelectorAll(
      '[data-docdown-button], .docdown-fab, .docdown-panel, .docdown-gated-note, ' +
      '[class*="PremiumPageClarification"]'
    ).forEach(function (el) { el.remove(); });

    DD.stripPageBlur(clone, true);

    clone.querySelectorAll('.page-content, .pc').forEach(function (el) {
      el.style.setProperty('display', 'block', 'important');
    });

    clone.querySelectorAll('img').forEach(function (img) {
      img.removeAttribute('srcset');
      img.removeAttribute('data-src');
      const src = String(img.getAttribute('src') || '');
      const clear = src.replace('/pages/blurred/', '/pages/').replace('/blurred/', '/');
      if (clear && clear !== src) {
        img.setAttribute('data-docdown-original', src);
        img.setAttribute('src', clear);
      }
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
    });

    return DD.preparePageFragment(clone.outerHTML, { baseUrl: DOC_ASSETS });
  }

  // ---------------------------------------------------------------------
  // Page cleanup: premium banners and blurred previews.
  // ---------------------------------------------------------------------

  const BANNER_SELECTORS = [
    '.banner-wrapper',
    '[class*="InlineBanner_inline-banner"]',
    '[class*="PremiumBanner"]',
    '[class*="premium-banner"]',
    '[class*="premiumBanner"]',
    '[class*="PremiumPageClarificationBanner"]',
    '[class*="PremiumBannerHeader"]',
    '[class*="PremiumBannerBenefitsList"]',
    '[class*="PremiumBannerButtons"]',
    '[data-test-selector*="preview-banner"]',
    '[data-test-selector="modal-document-viewer-preview-message"]',
    '[class*="PremiumBadge"]',
    '[class*="premium-badge"]',
    '[class*="premiumBadge"]',
    '[class*="premiumTag"]',
    '[class*="premium-tag"]'
  ];

  function shouldRemove(el) {
    if (!el || !el.parentNode) return false;
    if (el.closest('#page-container')) return false;
    if (el.querySelector && el.querySelector('#page-container, .pf')) return false;
    return true;
  }

  function removeBanners() {
    BANNER_SELECTORS.forEach(function (selector) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (error) {
        return;
      }
      Array.prototype.forEach.call(nodes, function (el) {
        if (shouldRemove(el)) el.remove();
      });
    });

    const recommendations = document.getElementById('viewer-recommendations');
    if (recommendations) recommendations.remove();

    Array.prototype.forEach.call(
      document.querySelectorAll('#modal-overlay, [class*="PremiumOverlay"], [class*="premium-overlay"]'),
      function (el) {
        if (el.closest('#page-container')) return;
        const text = (el.textContent || '').toLowerCase();
        const className = typeof el.className === 'string' ? el.className : '';
        if (text.indexOf('premium') !== -1 || text.indexOf('upgrade') !== -1 ||
          /premium/i.test(className)) {
          el.style.setProperty('display', 'none', 'important');
        }
      }
    );
  }

  function applyNoFilter(el) {
    if (!el || !el.style) return;
    DD.stripBlurClasses(el);
    let computed;
    try {
      computed = getComputedStyle(el);
    } catch (error) {
      computed = null;
    }
    if (computed && computed.filter && computed.filter !== 'none') {
      el.style.setProperty('filter', 'none', 'important');
      el.style.setProperty('-webkit-filter', 'none', 'important');
    }
    if (computed && computed.opacity && computed.opacity !== '1') {
      el.style.setProperty('opacity', '1', 'important');
    }
    if (computed && computed.visibility && computed.visibility !== 'visible') {
      el.style.setProperty('visibility', 'visible', 'important');
    }
    if (computed && computed.clipPath && computed.clipPath !== 'none') {
      el.style.setProperty('clip-path', 'none', 'important');
    }
    if (computed && computed.maskImage && computed.maskImage !== 'none') {
      el.style.setProperty('mask-image', 'none', 'important');
      el.style.setProperty('-webkit-mask-image', 'none', 'important');
    }
    el.style.setProperty('pointer-events', 'auto', 'important');
    el.style.setProperty('user-select', 'auto', 'important');
    el.classList.add('docdown-nofilter');
  }

  function deblurUrl(url) {
    if (!url || url.indexOf('/blurred/') === -1) return null;
    return url.replace('/pages/blurred/', '/pages/').replace('/blurred/', '/');
  }

  function unblurImage(img) {
    if (!img) return;
    applyNoFilter(img);
    if (img.dataset.docdownUnblurred === '1') return;

    const src = img.getAttribute('src') || '';
    const dataSrc = img.getAttribute('data-src') || '';
    const srcset = img.getAttribute('srcset') || '';
    const clear = deblurUrl(src);

    if (clear && clear !== src) {
      img.dataset.docdownOriginal = src;
      img.dataset.docdownUnblurred = '1';
      img.removeAttribute('srcset');
      img.onerror = function () {
        img.onerror = null;
        if (img.dataset.docdownOriginal) img.src = img.dataset.docdownOriginal;
      };
      img.src = clear;
    } else if (dataSrc) {
      const clearData = deblurUrl(dataSrc);
      if (clearData && clearData !== dataSrc) {
        img.setAttribute('data-src', clearData);
        img.dataset.docdownUnblurred = '1';
      }
    }

    if (srcset && srcset.indexOf('/blurred/') !== -1) {
      img.setAttribute(
        'srcset',
        srcset.replace(/\/pages\/blurred\//g, '/pages/').replace(/\/blurred\//g, '/')
      );
      img.dataset.docdownUnblurred = '1';
    }
  }

  function removeBlur() {
    Array.prototype.forEach.call(
      document.querySelectorAll('#page-container .pf, .p2hv .pf, .page-content'),
      applyNoFilter
    );

    Array.prototype.forEach.call(
      document.querySelectorAll('#page-container img, .p2hv img'),
      unblurImage
    );

    Array.prototype.forEach.call(
      document.querySelectorAll('[class*="blur"], [class*="Blur"]'),
      function (el) {
        applyNoFilter(el);
      }
    );
  }

  function refresh() {
    if (!isDocumentPage()) {
      DD.ui.cleanup();
      return;
    }
    removeBanners();
    removeBlur();
    DD.ui.mount(provider);
  }

  const debouncedRefresh = DD.debounce(refresh, 600);
  let bodyObserver = null;
  let observedViewer = null;

  function attachViewer() {
    const viewer = document.getElementById('viewer-wrapper') ||
      document.getElementById('page-container');
    if (!viewer || viewer === observedViewer) return;
    observedViewer = viewer;
    refresh();
  }

  function isRelevantNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === 'viewer-wrapper' || node.id === 'page-container') return true;
    if (node.classList && (node.classList.contains('pf') || node.classList.contains('page-content'))) return true;
    return !!(node.querySelector && node.querySelector('#viewer-wrapper, #page-container, .pf, .page-content'));
  }

  function onMutations(mutations) {
    if (!isDocumentPage()) {
      DD.ui.cleanup();
      return;
    }
    let relevant = false;
    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];
      if (mutation.target && mutation.target.nodeType === 1) {
        if (mutation.target.id === 'viewer-wrapper' ||
          mutation.target.id === 'page-container' ||
          mutation.target.closest('#viewer-wrapper, #page-container')) {
          relevant = true;
          break;
        }
      }
      for (let j = 0; j < mutation.addedNodes.length; j++) {
        if (isRelevantNode(mutation.addedNodes[j])) {
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }
    if (!relevant) return;
    if (document.getElementById('viewer-wrapper') !== observedViewer) attachViewer();
    debouncedRefresh();
  }

  function onNavigation() {
    setTimeout(function () {
      if (!isDocumentPage()) return;
      attachViewer();
      refresh();
    }, 400);
  }

  function cleanup() {
    debouncedRefresh.cancel();
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
    window.removeEventListener('popstate', onNavigation);
  }

  function startWatcher() {
    if (!isDocumentPage()) return;
    attachViewer();
    refresh();

    if (!bodyObserver && document.body) {
      bodyObserver = new MutationObserver(onMutations);
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('popstate', onNavigation);
    window.addEventListener('pagehide', cleanup, { once: true });
  }

  // ---------------------------------------------------------------------
  // Download: signed asset pages, with a DOM capture fallback.
  // ---------------------------------------------------------------------

  let busy = false;

  async function inlineFonts(css) {
    const pattern = /url\((['"]?)(https:\/\/website-assets\.studocu\.com\/[^)'"]+)\1\)/g;
    const urls = [];
    let match;
    while ((match = pattern.exec(css)) !== null) {
      if (urls.indexOf(match[2]) === -1) urls.push(match[2]);
    }
    if (!urls.length) return css;

    const data = {};
    await DD.mapLimit(urls, 2, async function (url) {
      const value = await DD.fetchDataUrl(url);
      if (value) data[url] = value;
    });

    pattern.lastIndex = 0;
    return css.replace(pattern, function (full, quote, url) {
      return data[url] ? 'url("' + data[url] + '")' : full;
    });
  }

  async function fetchCss(meta) {
    let css = '';
    if (meta && meta.canFetch) {
      const url = buildUrls(meta, 1).cssUrl;
      if (url) css = await DD.fetchText(url);
    }
    if (!css) {
      const link = document.querySelector('link[href*="doc-assets.studocu.com"][href*=".css"]');
      if (link && isAllowedAssetUrl(link.href)) {
        css = await DD.fetchText(link.href);
      }
    }
    return css ? inlineFonts(css) : '';
  }

  async function fetchPage(meta, pageNumber) {
    const urls = buildUrls(meta, pageNumber);
    const knownGated = !!(meta.hasPageList && !meta.pageParams[pageNumber]);
    const result = {
      pageNumber: pageNumber,
      gated: knownGated,
      reason: knownGated ? 'locked' : '',
      html: '',
      bgDataUrl: '',
      bgUrl: urls.bgUrl
    };
    let clearTried = false;

    // A page missing from signedQueryParams.pages is server-gated. Do not
    // download or embed its blurred preview: render a clean white note page.
    if (knownGated) return result;

    // Scanned/unknown-gating documents that advertise blurred pages: try the
    // clear full-page raster first. The /pages/blurred/ variant is deliberately
    // never used in the PDF.
    if (!meta.hasPageList && meta.hasBlurredPages && urls.clearPageUrl) {
      clearTried = true;
      const clearPage = await DD.fetchDataUrl(urls.clearPageUrl);
      if (clearPage) {
        result.bgDataUrl = clearPage;
        return result;
      }
    }

    const values = await Promise.all([
      urls.textUrl ? DD.fetchText(urls.textUrl) : Promise.resolve(null),
      urls.bgUrl ? DD.fetchDataUrl(urls.bgUrl) : Promise.resolve(null)
    ]);
    const text = values[0];
    const bg = values[1];
    result.bgDataUrl = bg || '';

    if (text && text.indexOf('<') !== -1) {
      try {
        result.html = DD.preparePageFragment(text, {
          bgDataUrl: bg,
          bgUrl: urls.bgUrl,
          baseUrl: meta.baseUrl,
          assetParam: pickParam(meta.signedParams, ['png', 'global'])
        });
      } catch (error) {
        DD.warn('Could not prepare page ' + pageNumber, error);
      }
    }

    if (!result.html && meta.hasPageList) {
      // Text-layer document: a figure-only bg image is not a complete page.
      // Show an explicit unavailable page instead of a misleading partial one.
      result.bgDataUrl = '';
      result.gated = true;
      result.reason = 'unavailable';
      return result;
    }

    if (!result.html && !result.bgDataUrl) {
      // One last clear-asset attempt before labelling the page. If this fails,
      // use a white note page instead of a blurred image.
      if (urls.clearPageUrl && !clearTried) {
        const clearPage = await DD.fetchDataUrl(urls.clearPageUrl);
        if (clearPage) result.bgDataUrl = clearPage;
      }
      if (!result.bgDataUrl) {
        result.gated = true;
        result.reason = (!meta.hasPageList && meta.hasBlurredPages) ? 'locked' : 'unavailable';
      }
    }

    return result;
  }

  async function buildFromMeta(meta, win) {
    const total = Math.min(meta.pageCount, DD.MAX_PAGES);
    if (meta.pageCount > DD.MAX_PAGES) {
      DD.ui.toast(
        'Tài liệu có ' + meta.pageCount + ' trang; chỉ xử lý ' + DD.MAX_PAGES +
        ' trang đầu để tránh tốn RAM.',
        'error'
      );
    }

    DD.ui.progress(0, total, 'Đang quét tài liệu…');
    const cssPromise = fetchCss(meta);
    let done = 0;
    const pageNumbers = [];
    for (let i = 1; i <= total; i++) pageNumbers.push(i);

    const results = await DD.mapLimit(pageNumbers, DD.PAGE_CONCURRENCY, async function (pageNumber) {
      const result = await fetchPage(meta, pageNumber);
      done += 1;
      DD.ui.progress(done, total, 'Đang tải trang ' + done + '/' + total + '…');
      return result;
    });

    results.sort(function (a, b) { return a.pageNumber - b.pageNumber; });
    if (!results.length) {
      throw new Error('Không tìm thấy trang tài liệu.');
    }

    const locked = results.filter(function (result) {
      return result.gated && result.reason !== 'unavailable';
    }).map(function (result) { return result.pageNumber; });
    const failed = results.filter(function (result) {
      return result.gated && result.reason === 'unavailable';
    }).map(function (result) { return result.pageNumber; });

    if (locked.length) {
      DD.log(
        (results.length - locked.length) + '/' + results.length +
        ' pages fully recovered. Premium-locked pages: ' + locked.join(', ') +
        '. Studocu did not send their clear content; cookies cannot unlock it.'
      );
    }
    if (failed.length) {
      DD.warn('Pages that could not be loaded: ' + failed.join(', '));
    }

    const css = await cssPromise;
    const html = DD.buildPrintHtml({
      title: meta.title,
      version: DD.VERSION,
      css: css,
      pagesHtml: DD.buildPagesHtml(meta, results, { siteName: 'Studocu' }),
      total: results.length
    });

    const fileName = DD.buildFileName(meta.title);
    const delivered = await DD.ui.deliverPrintDocument(win, html, fileName);
    if (!delivered) {
      throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
    }
    DD.ui.progress(results.length, results.length, 'Sẵn sàng in');
    let status = 'Đã tạo bản in (' + results.length + ' trang';
    if (locked.length) status += ', ' + locked.length + ' bị khóa';
    if (failed.length) status += ', ' + failed.length + ' lỗi';
    status += ')';
    DD.ui.setState('ready', status);
  }

  async function captureDomPages() {
    const pfs = getViewerPages();
    if (!pfs.length) return '';
    const savedY = window.scrollY || 0;
    const parts = [];
    for (let i = 0; i < pfs.length; i++) {
      try {
        pfs[i].scrollIntoView({ block: 'center' });
      } catch (error) {
        // The page may have been detached; continue with the next one.
      }
      await DD.sleep(140);
      parts.push(domPageHtml(i + 1));
    }
    try {
      window.scrollTo(0, savedY);
    } catch (error) {
      // Ignore scroll restoration failures.
    }
    return parts.join('');
  }

  async function buildFromDom(win) {
    DD.ui.setState('working', 'Đang quét DOM…');
    DD.ui.progress(0, 1, 'Đang quét DOM…');
    const pagesHtml = await captureDomPages();
    if (!pagesHtml) throw new Error('Không tìm thấy trang tài liệu.');
    const total = getViewerPages().length;
    const html = DD.buildPrintHtml({
      title: getTitle(),
      version: DD.VERSION,
      css: '',
      pagesHtml: pagesHtml,
      total: total
    });
    const fileName = DD.buildFileName(getTitle());
    const delivered = await DD.ui.deliverPrintDocument(win, html, fileName);
    if (!delivered) {
      throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
    }
    DD.ui.setState('ready', 'Đã tạo bản in từ DOM (' + total + ' trang)');
  }

  function fail(win, message) {
    DD.warn(message);
    DD.ui.setState('error', message);
    DD.ui.toast(message, 'error');
    DD.ui.showPrintError(win, message);
  }

  async function startDownload() {
    if (busy) return;
    busy = true;

    // Must be called synchronously from the click handler.
    const win = DD.ui.openPrintWindow();
    if (!win) {
      busy = false;
      DD.ui.toast(
        'Trình duyệt đã chặn tab in. Hãy cho phép popup cho Studocu rồi thử lại.',
        'error'
      );
      return;
    }

    try {
      const meta = getDocumentMeta();
      if (meta && meta.canFetch) {
        try {
          await buildFromMeta(meta, win);
        } catch (error) {
          DD.warn('Signed asset build failed; falling back to DOM', error);
          await buildFromDom(win);
        }
      } else {
        await buildFromDom(win);
      }
    } catch (error) {
      fail(win, 'Không tải được tài liệu: ' +
        (error && error.message ? error.message : 'lỗi không xác định'));
    } finally {
      busy = false;
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () {
      busy = false;
    }, { once: true });
  }

  provider = {
    id: 'studocu',
    label: 'Studocu',
    domains: DOMAINS,
    assetHosts: Array.from(ASSET_HOSTS),
    actionLabel: 'Tải PDF',
    busyLabel: 'Đang quét…',
    isDocumentPage: isDocumentPage,
    isAllowedAssetUrl: isAllowedAssetUrl,
    parseDocumentMeta: parseDocumentMeta,
    buildUrls: buildUrls,
    getDocumentMeta: getDocumentMeta,
    start: startWatcher,
    run: startDownload
  };
  DD.registerProvider(provider);
})();
