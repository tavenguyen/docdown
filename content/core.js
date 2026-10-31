(function () {
  'use strict';

  const SH = {};
  globalThis.StudocuDown = SH;

  SH.VERSION = (function () {
    try {
      return chrome.runtime.getManifest().version;
    } catch (error) {
      return '1.0.0';
    }
  })();

  SH.LOG_PREFIX = 'StudocuDown:';
  SH.log = function () {
    console.log.apply(console, [SH.LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
  };
  SH.warn = function () {
    console.warn.apply(console, [SH.LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
  };

  SH.DOC_ASSETS = 'https://doc-assets.studocu.com/';
  SH.ASSET_HOSTS = new Set(['doc-assets.studocu.com', 'website-assets.studocu.com']);
  SH.SUPPORTED_DOMAINS = ['studocu.com', 'studocu.vn', 'studocu.id', 'studeersnel.nl'];
  SH.MAX_PAGES = 300;
  SH.PAGE_CONCURRENCY = 2;
  SH.FETCH_TIMEOUT = 15000;

  SH.parentDomains = function (hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return [];
    return SH.SUPPORTED_DOMAINS.filter(function (domain) {
      return host === domain || host.slice(-(domain.length + 1)) === '.' + domain;
    }).map(function (domain) { return '.' + domain; });
  };

  SH.isSupportedHost = function (hostname) {
    const host = hostname === undefined
      ? String((globalThis.location && globalThis.location.hostname) || '')
      : String(hostname || '');
    return SH.parentDomains(host).length > 0;
  };

  SH.isDocumentPage = function () {
    try {
      return /\/document\//.test(location.pathname) ||
        !!document.getElementById('page-container') ||
        !!document.querySelector('.p2hv .pf');
    } catch (error) {
      return false;
    }
  };

  SH.getViewerPages = function () {
    return Array.prototype.slice.call(
      document.querySelectorAll('#page-container .pf, .p2hv .pf')
    ).filter(function (pf) {
      return !pf.closest('#studocudown-print-root');
    });
  };

  SH.getPageProps = function () {
    const el = document.querySelector('#__NEXT_DATA__');
    if (!el) return null;
    try {
      const data = JSON.parse(el.textContent || '{}');
      return (data && data.props && data.props.pageProps) || null;
    } catch (error) {
      SH.warn('Could not parse __NEXT_DATA__', error);
      return null;
    }
  };

  SH.getTitle = function () {
    const h1 = document.querySelector('h1');
    const heading = h1 && h1.textContent ? h1.textContent.trim() : '';
    return heading || document.title || 'document';
  };

  SH.pickParam = function (params, keys) {
    if (!params || typeof params !== 'object') return '';
    for (let i = 0; i < keys.length; i++) {
      const value = params[keys[i]];
      if (typeof value === 'string' && value) return value;
    }
    return '';
  };

  // Pure: converts pageProps into the shape used by the downloader.
  SH.parseDocumentMeta = function (pageProps, fallback) {
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
    if (!baseUrl && objectKey) baseUrl = SH.DOC_ASSETS + objectKey + '/html/';
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
  };

  SH.getDocumentMeta = function () {
    const viewerPages = SH.getViewerPages();
    const fallback = {
      title: SH.getTitle(),
      pageCount: viewerPages.length,
      pageClasses: viewerPages.map(function (pf) { return pf.className || ''; })
    };
    return SH.parseDocumentMeta(SH.getPageProps(), fallback);
  };

  SH.buildUrls = function (meta, pageNumber) {
    const empty = { bgUrl: '', textUrl: '', clearPageUrl: '', cssUrl: '' };
    if (!meta || !meta.objectKey || !meta.baseUrl) return empty;

    const params = meta.signedParams || {};
    const pageParams = meta.pageParams || {};
    const bgParam = SH.pickParam(params, ['png', 'global']);
    const textParam = pageParams[pageNumber] || SH.pickParam(params, ['html', 'global']);
    const clearParam = SH.pickParam(params, ['global', 'blurredPage', 'png']);
    const cssParam = SH.pickParam(params, ['css', 'global']);
    const base = meta.baseUrl;
    const key = meta.objectKey;

    return {
      bgUrl: bgParam ? base + 'bg' + pageNumber.toString(16) + '.png' + bgParam : '',
      textUrl: textParam ? base + key + pageNumber + '.page' + textParam : '',
      clearPageUrl: clearParam ? base + 'pages/page' + pageNumber + '.webp' + clearParam : '',
      cssUrl: cssParam ? base + key + '.css' + cssParam : ''
    };
  };

  SH.isAllowedAssetUrl = function (url) {
    if (!url) return false;
    try {
      const base = (globalThis.location && globalThis.location.href) || 'https://www.studocu.vn/';
      const parsed = new URL(url, base);
      if (parsed.protocol !== 'https:') return false;
      if (!SH.ASSET_HOSTS.has(parsed.hostname.toLowerCase())) return false;
      if (parsed.pathname.indexOf('..') !== -1) return false;
      return true;
    } catch (error) {
      return false;
    }
  };

  SH.escapeHtml = function (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };
  SH.escapeAttr = SH.escapeHtml;

  SH.FILE_NAME_LIMIT = 120;

  // Chrome uses the print window's document.title as the default PDF file
  // name, so it must be a legal and reasonably short file name.
  SH.buildFileName = function (title, fallback) {
    let name = String(title === undefined || title === null ? '' : title);
    name = name.replace(/\s*[|\u2013\u2014-]\s*(studocu|studeersnel)\s*$/i, '');
    name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ');
    name = name.replace(/\s+/g, ' ').trim();
    name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (!name) name = String(fallback || 'document');

    const chars = Array.from(name);
    if (chars.length > SH.FILE_NAME_LIMIT) {
      name = chars.slice(0, SH.FILE_NAME_LIMIT).join('').trim();
    }
    return name;
  };

  SH.stripBlurClasses = function (el) {
    if (!el || !el.classList) return;
    Array.prototype.slice.call(el.classList).forEach(function (name) {
      if (/blur/i.test(name)) el.classList.remove(name);
    });
  };

  // Removes inline blur/opacity/mask overrides. `makeVisible` is false for
  // pdf2htmlEX text lines: their .ff0/.ff1 classes must keep controlling
  // visibility, otherwise hidden fallback text could be painted twice.
  SH.clearBlurStyles = function (el, makeVisible) {
    if (!el || !el.style) return;
    const props = [
      'filter', '-webkit-filter', 'opacity',
      'clip-path', '-webkit-clip-path', 'mask-image', '-webkit-mask-image'
    ];
    if (makeVisible) props.push('visibility');
    props.forEach(function (prop) {
      el.style.removeProperty(prop);
    });
    el.style.setProperty('filter', 'none', 'important');
    el.style.setProperty('-webkit-filter', 'none', 'important');
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('clip-path', 'none', 'important');
    el.style.setProperty('-webkit-clip-path', 'none', 'important');
    el.style.setProperty('mask-image', 'none', 'important');
    el.style.setProperty('-webkit-mask-image', 'none', 'important');
    if (makeVisible) el.style.setProperty('visibility', 'visible', 'important');
  };

  SH.stripPageBlur = function (root, makeRootVisible) {
    if (!root) return;
    const targets = [root];
    if (root.querySelectorAll) {
      Array.prototype.push.apply(
        targets,
        Array.prototype.slice.call(root.querySelectorAll('.pf, .pc, .page-content, .t, img'))
      );
    }
    targets.forEach(function (el) {
      SH.stripBlurClasses(el);
      const isTextLine = !!(el.classList && el.classList.contains('t'));
      SH.clearBlurStyles(el, el === root ? !!makeRootVisible : !isTextLine);
    });
  };

  SH.blobToDataUrl = function (blob) {
    return new Promise(function (resolve) {
      if (!blob || !blob.size) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        resolve(typeof reader.result === 'string' ? reader.result : null);
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(blob);
    });
  };

  SH.fetchText = async function (url, timeoutMs) {
    if (!url || !SH.isAllowedAssetUrl(url)) return null;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || SH.FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) return null;
      return await response.text();
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  SH.fetchDataUrl = async function (url, timeoutMs) {
    if (!url || !SH.isAllowedAssetUrl(url)) return null;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || SH.FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) return null;
      return await SH.blobToDataUrl(await response.blob());
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  SH.mapLimit = async function (items, limit, worker) {
    const list = Array.prototype.slice.call(items || []);
    const results = new Array(list.length);
    let next = 0;
    const count = Math.min(Math.max(1, Number(limit) || 1), list.length);
    const workers = [];
    for (let i = 0; i < count; i++) {
      workers.push((async function () {
        while (true) {
          const index = next++;
          if (index >= list.length) return;
          results[index] = await worker(list[index], index);
        }
      })());
    }
    await Promise.all(workers);
    return results;
  };

  SH.sleep = function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  };

  SH.debounce = function (fn, wait) {
    let timer = 0;
    function wrapped() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        timer = 0;
        fn.apply(null, args);
      }, wait);
    }
    wrapped.cancel = function () {
      clearTimeout(timer);
      timer = 0;
    };
    return wrapped;
  };

  SH.safeStyleText = function (css) {
    return String(css || '').replace(/<\/style/gi, '<\\/style');
  };

  // Sanitises a pdf2htmlEX page fragment and rewrites its images to safe URLs.
  SH.preparePageFragment = function (html, options) {
    const opts = options || {};
    if (!html) return '';
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    const body = doc.body;

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
        if (name === 'srcset') {
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
    });

    body.querySelectorAll('img').forEach(function (img) {
      const src = String(img.getAttribute('src') || '').trim();
      if (!src) {
        img.remove();
        return;
      }

      if (/^bg[0-9a-f]+\.png$/i.test(src)) {
        const replacement = opts.bgDataUrl || opts.bgUrl || '';
        if (replacement) {
          img.setAttribute('src', replacement);
        } else {
          img.remove();
          return;
        }
      } else if (/^data:image\//i.test(src)) {
        // Allowed; already embedded.
      } else if (/^https?:/i.test(src)) {
        if (!SH.isAllowedAssetUrl(src)) {
          img.remove();
          return;
        }
        if (opts.assetParam && src.indexOf('?') === -1 &&
          src.indexOf('/doc-assets.studocu.com/') !== -1) {
          img.setAttribute('src', src + opts.assetParam);
        }
      } else if (/^(#|about:)/i.test(src)) {
        img.remove();
        return;
      } else {
        try {
          let absolute = new URL(src, opts.baseUrl || SH.DOC_ASSETS).href;
          if (!SH.isAllowedAssetUrl(absolute)) {
            img.remove();
            return;
          }
          if (opts.assetParam && absolute.indexOf('?') === -1) absolute += opts.assetParam;
          img.setAttribute('src', absolute);
        } catch (error) {
          img.remove();
          return;
        }
      }

      img.removeAttribute('srcset');
      img.removeAttribute('data-src');
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
      img.style.filter = 'none';
      img.style.opacity = '1';
      img.style.visibility = 'visible';
    });

    body.querySelectorAll('a[href]').forEach(function (link) {
      const href = String(link.getAttribute('href') || '').trim();
      if (!/^https?:/i.test(href)) link.removeAttribute('href');
    });

    SH.stripPageBlur(body, false);
    return body.innerHTML;
  };

  SH.getPageClass = function (meta, pageNumber, html) {
    let className = (meta && meta.pageClasses && meta.pageClasses[pageNumber - 1]) || '';
    className = className.split(/\s+/).filter(function (token) {
      return token && !/blur/i.test(token);
    }).join(' ');
    const hasWidth = /\bw[0-9a-f]+\b/i.test(className);
    const hasHeight = /\bh[0-9a-f]+\b/i.test(className);

    if (!/\bpf\b/.test(className) || !hasWidth || !hasHeight) {
      const match = /class="([^"]+)"/i.exec(html || '');
      if (match) {
        const width = (match[1].match(/\bw[0-9a-f]+\b/i) || [])[0];
        const height = (match[1].match(/\bh[0-9a-f]+\b/i) || [])[0];
        if (width && height) className = 'pf ' + width + ' ' + height;
      }
    }
    if (!/\bpf\b/.test(className) || !/\bw[0-9a-f]+\b/i.test(className) ||
      !/\bh[0-9a-f]+\b/i.test(className)) {
      className = 'pf w0 h0';
    }
    return className.replace(/\s+/g, ' ').trim();
  };

  SH.buildPagesHtml = function (meta, results) {
    return (results || []).map(function (result) {
      const pageNumber = result.pageNumber;
      const className = SH.getPageClass(meta, pageNumber, result.html);
      let inner = '';

      if (result.gated) {
        // Never embed a blurred preview in the PDF. A locked/unavailable page
        // becomes a clean white page with an explicit explanation.
        const unavailable = result.reason === 'unavailable';
        const title = unavailable
          ? 'Page ' + pageNumber + ' could not be loaded'
          : 'Page ' + pageNumber + ' is premium-locked';
        const text = unavailable
          ? 'The page content could not be fetched. Reload the document and try again.'
          : 'Studocu does not send this page to non-subscribers, so it cannot be unblurred here.';
        inner = '<div class="pc"><div class="studocudown-gated-page">' +
          '<div class="studocudown-gated-title">' + SH.escapeHtml(title) + '</div>' +
          '<div class="studocudown-gated-text">' + SH.escapeHtml(text) + '</div></div></div>';
      } else if (result.html) {
        inner = result.html;
      } else if (result.bgDataUrl) {
        inner = '<div class="pc"><img class="bi x0 y0 w1 h1" alt="" src="' +
          SH.escapeAttr(result.bgDataUrl) + '"></div>';
      } else {
        inner = '<div class="pc"><div class="studocudown-empty">Page ' +
          SH.escapeHtml(pageNumber) + ' could not be loaded.</div></div>';
      }

      return '<div class="' + SH.escapeAttr(className) + '" data-page-no="' +
        SH.escapeAttr(pageNumber) + '" data-studocudown-page="' + SH.escapeAttr(pageNumber) + '">' +
        inner + '</div>';
    }).join('');
  };

  SH.buildPrintHtml = function (options) {
    const opts = options || {};
    const title = SH.escapeHtml(opts.title || 'document');
    const version = SH.escapeHtml(opts.version || SH.VERSION);
    const total = Number(opts.total) || 0;
    const css = SH.safeStyleText(opts.css || '');
    const pagesHtml = String(opts.pagesHtml || '');

    const printCss = [
      'html,body{margin:0!important;padding:0!important;background:#fff!important}',
      '.studocudown-print-root{margin:0!important;padding:0!important}',
      '.studocudown-pages{margin:0!important;padding:0!important}',
      '.p2hv .pf,.p2hv .pc,.p2hv .page-content,.p2hv .bi,.p2hv img{filter:none!important;-webkit-filter:none!important;opacity:1!important;visibility:visible!important;clip-path:none!important;-webkit-clip-path:none!important;mask-image:none!important;-webkit-mask-image:none!important}',
      '.p2hv .t{filter:none!important;-webkit-filter:none!important;opacity:1!important;clip-path:none!important;-webkit-clip-path:none!important;mask-image:none!important;-webkit-mask-image:none!important}',
      '.studocudown-gated-page{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:36px;background:#fff;color:#111;text-align:center;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}',
      '.studocudown-gated-title{font-size:24px;font-weight:700}',
      '.studocudown-gated-text{max-width:430px;color:#555}',
      '.p2hv .pf{margin:0!important;box-shadow:none!important;page-break-after:always!important;page-break-inside:avoid!important}',
      '.p2hv .pf:last-child{page-break-after:auto!important}',
      '.studocudown-toolbar{position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:10px;align-items:center;padding:10px 14px;background:#1f2937;color:#fff;font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}',
      '.studocudown-toolbar-title{font-weight:700}',
      '.studocudown-toolbar-meta{opacity:.75}',
      '.studocudown-toolbar-actions{margin-left:auto;display:flex;gap:8px}',
      '.studocudown-toolbar button{appearance:none;border:0;border-radius:6px;padding:7px 12px;font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer}',
      '.studocudown-toolbar button:disabled{opacity:.5;cursor:wait}',
      '#studocudown-print{background:#16a34a;color:#fff}',
      '#studocudown-close{background:#374151;color:#fff}',
      '.studocudown-gated-note{position:absolute;top:8px;left:8px;right:8px;z-index:5;background:rgba(153,27,27,.94);color:#fff;font:600 12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;padding:6px 8px;border-radius:4px}',
      '.studocudown-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#666;font:14px system-ui,-apple-system,Segoe UI,sans-serif}',
      '@media print{.studocudown-toolbar{display:none!important}body{background:#fff!important}.p2hv .pf{margin:0!important;box-shadow:none!important}}',
      '@media screen{body{background:#525659!important;padding:64px 16px 24px!important}.p2hv .pf{margin:0 auto 24px!important;box-shadow:0 2px 14px rgba(0,0,0,.35)!important}}'
    ].join('\n');

    return '<!doctype html><html><head><meta charset="utf-8"><title>' + title +
      '</title><style>' + css + '\n' + printCss + '</style></head><body class="studocudown-print-body">' +
      '<div class="studocudown-toolbar no-print"><div class="studocudown-toolbar-title">StudocuDown v' + version +
      '</div><div class="studocudown-toolbar-meta">' + total + ' pages</div>' +
      '<div class="studocudown-toolbar-actions"><button id="studocudown-print" type="button" disabled>Print / Save as PDF</button>' +
      '<button id="studocudown-close" type="button">Close</button></div></div>' +
      '<div class="p2hv studocudown-print-root"><div class="studocudown-pages">' + pagesHtml +
      '</div></div></body></html>';
  };

  SH.domPageHtml = function (pageNumber) {
    const pages = SH.getViewerPages();
    const page = pages[pageNumber - 1];
    if (!page) return '';
    const clone = page.cloneNode(true);
    clone.removeAttribute('style');
    clone.querySelectorAll(
      '[data-studocudown-button], .studocudown-fab, .studocudown-panel, .studocudown-gated-note, ' +
      '[class*="PremiumPageClarification"]'
    ).forEach(function (el) { el.remove(); });

    SH.stripPageBlur(clone, true);

    clone.querySelectorAll('.page-content, .pc').forEach(function (el) {
      el.style.setProperty('display', 'block', 'important');
    });

    clone.querySelectorAll('img').forEach(function (img) {
      img.removeAttribute('srcset');
      img.removeAttribute('data-src');
      const src = String(img.getAttribute('src') || '');
      const clear = src.replace('/pages/blurred/', '/pages/').replace('/blurred/', '/');
      if (clear && clear !== src) {
        img.setAttribute('data-studocudown-original', src);
        img.setAttribute('src', clear);
      }
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
    });

    return SH.preparePageFragment(clone.outerHTML, { baseUrl: SH.DOC_ASSETS });
  };

  const COOKIE_EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';

  // Best-effort reset of the current origin's client-side session state.
  // Cookies marked HttpOnly are invisible to document.cookie, so the server
  // session can survive; this clears the stale client state that usually
  // causes expired signed URLs.
  SH.resetSessionData = async function () {
    const summary = { supported: false, cookies: 0, storage: 0, caches: 0, idb: 0 };
    const hostname = (globalThis.location && globalThis.location.hostname) || '';
    if (!SH.isSupportedHost(hostname)) return summary;
    summary.supported = true;

    try {
      const cookie = (typeof document !== 'undefined' && document.cookie) || '';
      const names = [];
      cookie.split(';').forEach(function (part) {
        const name = part.split('=')[0].trim();
        if (name && names.indexOf(name) === -1) names.push(name);
      });
      const domains = [''].concat(SH.parentDomains(hostname));
      names.forEach(function (name) {
        domains.forEach(function (domain) {
          try {
            document.cookie = name + '=; expires=' + COOKIE_EPOCH + '; Max-Age=0; path=/' +
              (domain ? '; domain=' + domain : '');
            summary.cookies += 1;
          } catch (error) {
            // Ignore individual cookie failures and keep clearing the rest.
          }
        });
      });
    } catch (error) {
      // document.cookie can throw in restricted contexts.
    }

    ['localStorage', 'sessionStorage'].forEach(function (key) {
      try {
        const store = globalThis[key];
        if (store && typeof store.clear === 'function') {
          store.clear();
          summary.storage += 1;
        }
      } catch (error) {
        // Storage can be disabled (private mode, blocked third-party storage).
      }
    });

    try {
      const cacheStorage = globalThis.caches;
      if (cacheStorage && typeof cacheStorage.keys === 'function') {
        const keys = await cacheStorage.keys();
        for (let i = 0; i < keys.length; i++) {
          await cacheStorage.delete(keys[i]);
          summary.caches += 1;
        }
      }
    } catch (error) {
      // Cache Storage is optional.
    }

    try {
      const idb = globalThis.indexedDB;
      if (idb && typeof idb.databases === 'function') {
        const databases = (await idb.databases()) || [];
        await Promise.all(databases.map(function (info) {
          return new Promise(function (resolve) {
            if (!info || !info.name) { resolve(); return; }
            let request;
            try {
              request = idb.deleteDatabase(info.name);
            } catch (error) {
              resolve();
              return;
            }
            summary.idb += 1;
            request.onsuccess = resolve;
            request.onerror = resolve;
            request.onblocked = resolve;
          });
        }));
      }
    } catch (error) {
      // IndexedDB enumeration is Chrome 71+ and may be blocked.
    }

    return summary;
  };

  SH.RESET_MESSAGE = 'studocudown-reset';

  function sendResetMessage(runtime, hostname) {
    return new Promise(function (resolve) {
      try {
        const pending = runtime.sendMessage(
          { type: SH.RESET_MESSAGE, hostname: hostname },
          function (response) {
            if (runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(response || null);
          }
        );
        if (pending && typeof pending.then === 'function') {
          pending.then(function (response) {
            resolve(response || null);
          }, function () {
            resolve(null);
          });
        }
      } catch (error) {
        resolve(null);
      }
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(null); }, ms);
      promise.then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function () {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  // Asks the service worker to wipe cookies (including HttpOnly) and browsing
  // data. Falls back to the in-page reset when the worker is unavailable.
  SH.requestFullReset = async function (timeoutMs) {
    const chromeApi = globalThis.chrome;
    const runtime = chromeApi && chromeApi.runtime;
    const hostname = (globalThis.location && globalThis.location.hostname) || '';

    if (runtime && runtime.id && typeof runtime.sendMessage === 'function') {
      const response = await withTimeout(
        sendResetMessage(runtime, hostname),
        Number(timeoutMs) || 8000
      );
      if (response && response.ok) {
        return {
          supported: true,
          full: true,
          cookies: Number(response.cookies) || 0,
          browsingData: !!response.browsingData,
          storage: 0,
          caches: 0,
          idb: 0
        };
      }
    }

    const local = await SH.resetSessionData();
    local.fallback = true;
    return local;
  };
})();
