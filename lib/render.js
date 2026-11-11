(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  DD.getPageClass = function (meta, pageNumber, html) {
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

  DD.buildPagesHtml = function (meta, results, options) {
    const opts = options || {};
    const siteName = opts.siteName || 'The site';
    return (results || []).map(function (result) {
      const pageNumber = result.pageNumber;
      const className = DD.getPageClass(meta, pageNumber, result.html);
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
          : siteName + ' does not send this page to non-subscribers, so it cannot be unblurred here.';
        inner = '<div class="pc"><div class="docdown-gated-page">' +
          '<div class="docdown-gated-title">' + DD.escapeHtml(title) + '</div>' +
          '<div class="docdown-gated-text">' + DD.escapeHtml(text) + '</div></div></div>';
      } else if (result.html) {
        inner = result.html;
      } else if (result.bgDataUrl) {
        inner = '<div class="pc"><img class="bi x0 y0 w1 h1" alt="" src="' +
          DD.escapeAttr(result.bgDataUrl) + '"></div>';
      } else {
        inner = '<div class="pc"><div class="docdown-empty">Page ' +
          DD.escapeHtml(pageNumber) + ' could not be loaded.</div></div>';
      }

      return '<div class="' + DD.escapeAttr(className) + '" data-page-no="' +
        DD.escapeAttr(pageNumber) + '" data-docdown-page="' + DD.escapeAttr(pageNumber) + '">' +
        inner + '</div>';
    }).join('');
  };

  DD.buildPrintHtml = function (options) {
    const opts = options || {};
    const title = DD.escapeHtml(opts.title || 'document');
    const fileName = DD.escapeHtml(DD.buildFileName(opts.title));
    const version = DD.escapeHtml(opts.version || DD.VERSION);
    const total = Number(opts.total) || 0;
    const css = DD.safeStyleText(opts.css || '');
    const pagesHtml = String(opts.pagesHtml || '');
    const part = opts.part && typeof opts.part === 'object' ? opts.part : null;

    let metaHtml = '<div class="docdown-toolbar-meta">' + total +
      ' pages &middot; ' + fileName + '</div>';
    let partButtons = '';
    if (part) {
      const partIndex = Number(part.index) || 0;
      const fromPage = Number(part.fromPage) || 0;
      const partTotal = Number(part.totalPages) || total;
      metaHtml = '<div class="docdown-toolbar-meta" id="docdown-toolbar-meta">Trang ' +
        fromPage + ' / ' + partTotal + ' \u00b7 phần ' + partIndex + '</div>';
      partButtons = '<button id="docdown-next" type="button" hidden>Phần tiếp theo</button>' +
        '<button id="docdown-merge" type="button" hidden>Ghép PDF</button>';
    }

    const printCss = [
      'html,body{margin:0!important;padding:0!important;background:#fff!important}',
      '.docdown-print-root{margin:0!important;padding:0!important}',
      '.docdown-pages{margin:0!important;padding:0!important}',
      '.p2hv .pf,.p2hv .pc,.p2hv .page-content,.p2hv .bi,.p2hv img{filter:none!important;-webkit-filter:none!important;opacity:1!important;visibility:visible!important;clip-path:none!important;-webkit-clip-path:none!important;mask-image:none!important;-webkit-mask-image:none!important}',
      '.p2hv .t{filter:none!important;-webkit-filter:none!important;opacity:1!important;clip-path:none!important;-webkit-clip-path:none!important;mask-image:none!important;-webkit-mask-image:none!important}',
      '.docdown-gated-page{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:36px;background:#fff;color:#111;text-align:center;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}',
      '.docdown-gated-title{font-size:24px;font-weight:700}',
      '.docdown-gated-text{max-width:430px;color:#555}',
      '.p2hv .pf{margin:0!important;box-shadow:none!important;page-break-after:always!important;page-break-inside:avoid!important}',
      '.p2hv .pf:last-child{page-break-after:auto!important}',
      '.docdown-toolbar{position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;gap:10px;align-items:center;padding:10px 14px;background:#1f2937;color:#fff;font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}',
      '.docdown-toolbar-title{font-weight:700}',
      '.docdown-toolbar-meta{opacity:.75}',
      '.docdown-toolbar-actions{margin-left:auto;display:flex;gap:8px}',
      '.docdown-toolbar button{appearance:none;border:0;border-radius:6px;padding:7px 12px;font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;cursor:pointer}',
      '.docdown-toolbar button:disabled{opacity:.5;cursor:wait}',
      '#docdown-print{background:#16a34a;color:#fff}',
      '#docdown-close{background:#374151;color:#fff}',
      '.docdown-gated-note{position:absolute;top:8px;left:8px;right:8px;z-index:5;background:rgba(153,27,27,.94);color:#fff;font:600 12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;padding:6px 8px;border-radius:4px}',
      '.docdown-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#666;font:14px system-ui,-apple-system,Segoe UI,sans-serif}',
      '@media print{.docdown-toolbar{display:none!important}body{background:#fff!important}.p2hv .pf{margin:0!important;box-shadow:none!important}}',
      '@media screen{body{background:#525659!important;padding:64px 16px 24px!important}.p2hv .pf{margin:0 auto 24px!important;box-shadow:0 2px 14px rgba(0,0,0,.35)!important}}'
    ].join('\n');

    return '<!doctype html><html><head><meta charset="utf-8"><title>' + title +
      '</title><style>' + css + '\n' + printCss + '</style></head><body class="docdown-print-body">' +
      '<div class="docdown-toolbar no-print"><div class="docdown-toolbar-title">DocDown v' + version +
      '</div>' + metaHtml +
      '<div class="docdown-toolbar-actions"><button id="docdown-print" type="button" disabled>Print / Save as PDF</button>' +
      partButtons +
      '<button id="docdown-close" type="button">Close</button></div></div>' +
      '<div class="p2hv docdown-print-root"><div class="docdown-pages">' + pagesHtml +
      '</div></div></body></html>';
  };
})();
