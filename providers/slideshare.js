(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const DOMAINS = ['slideshare.net'];
  const IMAGE_HOST = 'image.slidesharecdn.com';
  const DEFAULT_SIZE = { quality: 75, width: 2048 };
  // slideDimensions are PDF points (A4 = 595x842, Letter = 612x792). CSS works
  // in 96 dpi pixels, so convert to keep the printed page at the right size.
  const PT_TO_PX = 96 / 72;
  const PRELOAD_CONCURRENCY = 4;
  const PRELOAD_TIMEOUT = 15000;

  let busy = false;
  let cached = null;

  function isDocumentPage() {
    try {
      return /^\/slideshow\/[^/]+\/\d+\/?$/.test(location.pathname);
    } catch (error) {
      return false;
    }
  }

  function readShow() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el) return null;
    try {
      const data = JSON.parse(el.textContent || '{}');
      const props = data && data.props && data.props.pageProps;
      return (props && props.slideshow) || null;
    } catch (error) {
      DD.warn('Could not parse __NEXT_DATA__', error);
      return null;
    }
  }

  function bestSize(sizes) {
    const list = Array.isArray(sizes) ? sizes.filter(function (size) {
      return size && Number(size.width) > 0 && Number(size.quality) > 0;
    }) : [];
    if (!list.length) return DEFAULT_SIZE;
    return list.slice().sort(function (a, b) { return Number(b.width) - Number(a.width); })[0];
  }

  function safeSegment(value) {
    return !!value && /^[A-Za-z0-9._-]+$/.test(value) && value.indexOf('..') === -1;
  }

  // Turns the embedded payload into the small shape the downloader needs.
  function normalizeShow(show) {
    if (!show || typeof show !== 'object') return null;
    if (show.isPrivate === true || show.isViewable === false) return null;

    const total = Number(show.totalSlides);
    if (!Number.isFinite(total) || total <= 0) return null;

    const slides = show.slides || {};
    const host = String(slides.host || '');
    if (host !== 'https://' + IMAGE_HOST && host !== 'https://image.slidesharecdn.com') return null;
    if (!safeSegment(slides.imageLocation) || !safeSegment(slides.title)) return null;

    const dims = show.slideDimensions || {};
    const widthPt = Number(dims.width) > 0 ? Number(dims.width) : 595;
    const heightPt = Number(dims.height) > 0 ? Number(dims.height) : 842;
    const width = Math.round(widthPt * PT_TO_PX);
    const height = Math.round(heightPt * PT_TO_PX);

    return {
      title: String(show.title || document.title || 'slideshow'),
      totalSlides: total,
      width: width,
      height: height,
      host: host,
      imageLocation: slides.imageLocation,
      slug: slides.title,
      size: bestSize(slides.imageSizes)
    };
  }

  function buildSlideUrl(show, pageNumber) {
    if (!show) return '';
    return show.host + '/' + show.imageLocation + '/' + show.size.quality + '/' +
      show.slug + '-' + pageNumber + '-' + show.size.width + '.jpg';
  }

  function isAllowedAssetUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url, (globalThis.location && globalThis.location.href) || undefined);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.hostname.toLowerCase() !== IMAGE_HOST) return false;
      if (parsed.pathname.indexOf('..') !== -1) return false;
      return /^\/[A-Za-z0-9._-]+\/\d{2}\/[A-Za-z0-9._-]+\.jpg$/i.test(parsed.pathname);
    } catch (error) {
      return false;
    }
  }

  function buildCss() {
    return [
      '.docdown-slide{position:relative;overflow:hidden;background:#fff}',
      '.docdown-slide img{display:block;width:100%;height:100%;object-fit:contain;background:#fff}'
    ].join('\n');
  }

  function pageHtml(show, pageNumber, url, ok) {
    const size = 'style="width:' + show.width + 'px;height:' + show.height + 'px"';
    if (!ok || !url) {
      return '<div class="pf docdown-slide" ' + size + '>' +
        '<div class="docdown-gated-page">' +
        '<div class="docdown-gated-title">Slide ' + pageNumber + ' could not be loaded</div>' +
        '<div class="docdown-gated-text">The slide image did not download. Reload the ' +
        'presentation and try again.</div>' +
        '</div></div>';
    }
    return '<div class="pf docdown-slide" ' + size + ' data-page-no="' + pageNumber + '">' +
      '<img src="' + DD.escapeAttr(url) + '" alt="" loading="eager" decoding="sync"></div>';
  }

  // Slide images come from a CDN without CORS headers, so they can only be
  // displayed through <img>. Preloading checks each one before printing.
  function preloadImage(url) {
    return new Promise(function (resolve) {
      let img = new Image();
      let done = false;
      const timer = setTimeout(function () { finish(false); }, PRELOAD_TIMEOUT);

      function finish(ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        img = null;
        resolve(ok);
      }

      img.onload = function () { finish(true); };
      img.onerror = function () { finish(false); };
      img.src = url;
    });
  }

  function getShow() {
    const href = (globalThis.location && globalThis.location.href) || '';
    if (cached && cached.href === href) return cached.show;
    const show = normalizeShow(readShow());
    cached = { href: href, show: show };
    return show;
  }

  function isAvailable() {
    return !!getShow();
  }

  async function run() {
    if (busy) return;
    busy = true;

    // Must be called synchronously from the click handler.
    const win = DD.ui.openPrintWindow();
    if (!win) {
      busy = false;
      DD.ui.toast('Trình duyệt đã chặn tab in. Hãy cho phép popup cho SlideShare rồi thử lại.', 'error');
      return;
    }

    try {
      DD.ui.setState('working', 'Đang đọc tài liệu…');
      const show = getShow();
      if (!show) {
        throw new Error('Không đọc được dữ liệu slide của tài liệu này.');
      }

      const total = Math.min(show.totalSlides, DD.MAX_PAGES);
      if (show.totalSlides > DD.MAX_PAGES) {
        DD.ui.toast('Tài liệu có ' + show.totalSlides + ' slide; chỉ xử lý ' +
          DD.MAX_PAGES + ' slide đầu để tránh tốn RAM.', 'error');
      }

      const slides = [];
      for (let n = 1; n <= total; n++) {
        slides.push({ pageNumber: n, url: buildSlideUrl(show, n) });
      }

      DD.ui.progress(0, total, 'Đang kiểm tra 0/' + total + ' ảnh…');
      let checked = 0;
      const results = await DD.mapLimit(slides, PRELOAD_CONCURRENCY, async function (slide) {
        const ok = isAllowedAssetUrl(slide.url) && await preloadImage(slide.url);
        checked += 1;
        DD.ui.progress(checked, total, 'Đang kiểm tra ' + checked + '/' + total + ' ảnh…');
        return { pageNumber: slide.pageNumber, url: slide.url, ok: ok };
      });

      const failed = results.filter(function (result) { return !result.ok; });
      if (failed.length === results.length) {
        throw new Error('Không tải được ảnh slide nào từ SlideShare.');
      }

      const pagesHtml = results.map(function (result) {
        return pageHtml(show, result.pageNumber, result.url, result.ok);
      }).join('');

      const html = DD.buildPrintHtml({
        title: show.title,
        version: DD.VERSION,
        css: buildCss(),
        pagesHtml: pagesHtml,
        total: total
      });

      const fileName = DD.buildFileName(show.title);
      const delivered = await DD.ui.deliverPrintDocument(win, html, fileName);
      if (!delivered) {
        throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
      }

      let status = 'Đã tạo bản in (' + total + ' slide';
      if (failed.length) status += ', ' + failed.length + ' lỗi';
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
    id: 'slideshare',
    label: 'SlideShare',
    domains: DOMAINS,
    assetHosts: [IMAGE_HOST],
    actionLabel: 'Tải PDF',
    busyLabel: 'Đang kiểm tra…',
    isDocumentPage: isDocumentPage,
    isAvailable: isAvailable,
    isAllowedAssetUrl: isAllowedAssetUrl,
    normalizeShow: normalizeShow,
    buildSlideUrl: buildSlideUrl,
    pageHtml: pageHtml,
    buildCss: buildCss,
    run: run
  };
  DD.registerProvider(provider);

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', function () { busy = false; }, { once: true });
  }
})();
