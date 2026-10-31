(function () {
  'use strict';

  const SH = globalThis.StudocuDown;
  if (!SH) return;

  const download = {};
  SH.download = download;
  download.busy = false;

  async function inlineFonts(css) {
    const pattern = /url\((['"]?)(https:\/\/website-assets\.studocu\.com\/[^)'"]+)\1\)/g;
    const urls = [];
    let match;
    while ((match = pattern.exec(css)) !== null) {
      if (urls.indexOf(match[2]) === -1) urls.push(match[2]);
    }
    if (!urls.length) return css;

    const data = {};
    await SH.mapLimit(urls, 2, async function (url) {
      const value = await SH.fetchDataUrl(url);
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
      const url = SH.buildUrls(meta, 1).cssUrl;
      if (url) css = await SH.fetchText(url);
    }
    if (!css) {
      const link = document.querySelector('link[href*="doc-assets.studocu.com"][href*=".css"]');
      if (link && SH.isAllowedAssetUrl(link.href)) {
        css = await SH.fetchText(link.href);
      }
    }
    return css ? inlineFonts(css) : '';
  }

  async function fetchPage(meta, pageNumber) {
    const urls = SH.buildUrls(meta, pageNumber);
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
      const clearPage = await SH.fetchDataUrl(urls.clearPageUrl);
      if (clearPage) {
        result.bgDataUrl = clearPage;
        return result;
      }
    }

    const values = await Promise.all([
      urls.textUrl ? SH.fetchText(urls.textUrl) : Promise.resolve(null),
      urls.bgUrl ? SH.fetchDataUrl(urls.bgUrl) : Promise.resolve(null)
    ]);
    const text = values[0];
    const bg = values[1];
    result.bgDataUrl = bg || '';

    if (text && text.indexOf('<') !== -1) {
      try {
        result.html = SH.preparePageFragment(text, {
          bgDataUrl: bg,
          bgUrl: urls.bgUrl,
          baseUrl: meta.baseUrl,
          assetParam: SH.pickParam(meta.signedParams, ['png', 'global'])
        });
      } catch (error) {
        SH.warn('Could not prepare page ' + pageNumber, error);
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
        const clearPage = await SH.fetchDataUrl(urls.clearPageUrl);
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
    const total = Math.min(meta.pageCount, SH.MAX_PAGES);
    if (meta.pageCount > SH.MAX_PAGES) {
      SH.ui.toast(
        'Tài liệu có ' + meta.pageCount + ' trang; chỉ xử lý ' + SH.MAX_PAGES +
        ' trang đầu để tránh tốn RAM.',
        'error'
      );
    }

    SH.ui.progress(0, total, 'Đang quét tài liệu…');
    const cssPromise = fetchCss(meta);
    let done = 0;
    const pageNumbers = [];
    for (let i = 1; i <= total; i++) pageNumbers.push(i);

    const results = await SH.mapLimit(pageNumbers, SH.PAGE_CONCURRENCY, async function (pageNumber) {
      const result = await fetchPage(meta, pageNumber);
      done += 1;
      SH.ui.progress(done, total, 'Đang tải trang ' + done + '/' + total + '…');
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
      SH.log(
        (results.length - locked.length) + '/' + results.length +
        ' pages fully recovered. Premium-locked pages: ' + locked.join(', ') +
        '. Studocu did not send their clear content; cookies cannot unlock it.'
      );
    }
    if (failed.length) {
      SH.warn('Pages that could not be loaded: ' + failed.join(', '));
    }

    const css = await cssPromise;
    const html = SH.buildPrintHtml({
      title: meta.title,
      version: SH.VERSION,
      css: css,
      pagesHtml: SH.buildPagesHtml(meta, results),
      total: results.length
    });

    const fileName = SH.buildFileName(meta.title);
    const delivered = await SH.ui.deliverPrintDocument(win, html, fileName);
    if (!delivered) {
      throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
    }
    SH.ui.progress(results.length, results.length, 'Sẵn sàng in');
    let status = 'Đã tạo bản in (' + results.length + ' trang';
    if (locked.length) status += ', ' + locked.length + ' bị khóa';
    if (failed.length) status += ', ' + failed.length + ' lỗi';
    status += ')';
    SH.ui.setState('ready', status);
  }

  async function captureDomPages() {
    const pfs = SH.getViewerPages();
    if (!pfs.length) return '';
    const savedY = window.scrollY || 0;
    const parts = [];
    for (let i = 0; i < pfs.length; i++) {
      try {
        pfs[i].scrollIntoView({ block: 'center' });
      } catch (error) {
        // The page may have been detached; continue with the next one.
      }
      await SH.sleep(140);
      parts.push(SH.domPageHtml(i + 1));
    }
    try {
      window.scrollTo(0, savedY);
    } catch (error) {
      // Ignore scroll restoration failures.
    }
    return parts.join('');
  }

  async function buildFromDom(win) {
    SH.ui.setState('working', 'Đang quét DOM…');
    SH.ui.progress(0, 1, 'Đang quét DOM…');
    const pagesHtml = await captureDomPages();
    if (!pagesHtml) throw new Error('Không tìm thấy trang tài liệu.');
    const total = SH.getViewerPages().length;
    const html = SH.buildPrintHtml({
      title: SH.getTitle(),
      version: SH.VERSION,
      css: '',
      pagesHtml: pagesHtml,
      total: total
    });
    const fileName = SH.buildFileName(SH.getTitle());
    const delivered = await SH.ui.deliverPrintDocument(win, html, fileName);
    if (!delivered) {
      throw new Error('Không ghi được bản in. Tab in có thể đã bị đóng.');
    }
    SH.ui.setState('ready', 'Đã tạo bản in từ DOM (' + total + ' trang)');
  }

  function fail(win, message) {
    SH.warn(message);
    SH.ui.setState('error', message);
    SH.ui.toast(message, 'error');
    SH.ui.showPrintError(win, message);
  }

  download.start = async function () {
    if (download.busy) return;
    download.busy = true;

    // Must be called synchronously from the click handler.
    const win = SH.ui.openPrintWindow();
    if (!win) {
      download.busy = false;
      SH.ui.toast(
        'Trình duyệt đã chặn tab in. Hãy cho phép popup cho Studocu rồi thử lại.',
        'error'
      );
      return;
    }

    try {
      const meta = SH.getDocumentMeta();
      if (meta && meta.canFetch) {
        try {
          await buildFromMeta(meta, win);
        } catch (error) {
          SH.warn('Signed asset build failed; falling back to DOM', error);
          await buildFromDom(win);
        }
      } else {
        await buildFromDom(win);
      }
    } catch (error) {
      fail(win, 'Không tải được tài liệu: ' +
        (error && error.message ? error.message : 'lỗi không xác định'));
    } finally {
      download.busy = false;
    }
  };

  function boot() {
    if (!SH.isDocumentPage()) return;
    SH.pages.start();
    SH.ui.mount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.addEventListener('pagehide', function () {
    download.busy = false;
  }, { once: true });
})();
