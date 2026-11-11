(function () {
  'use strict';

  const SH = globalThis.DocDown;
  if (!SH) return;

  const PREFIX = 'docdown-print';

  // Shared by the single-shot and streamed flows. The listeners below are
  // registered once so repeated renders cannot leak them.
  let currentFileName = null;
  let currentTitle = '';
  let currentTotalPages = 0;
  let currentPartIndex = null;
  let appendedThrough = null;
  let streaming = false;
  let listenerGeneration = 0;

  function post(message) {
    try {
      if (!window.opener || window.opener.closed) return;
      window.opener.postMessage(message, '*');
    } catch (error) {
      // The opener may already be closed.
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Race a promise against a timer without leaving the timer running.
  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(); }, ms);
      promise.then(function () {
        clearTimeout(timer);
        resolve();
      }, function () {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  function setTitle(fileName) {
    try {
      if (document.title !== fileName) document.title = fileName;
    } catch (error) {
      // The document may be mid-write.
    }
  }

  function waitForImage(img, timeoutMs) {
    return new Promise(function (resolve) {
      if (!img || img.complete) {
        resolve();
        return;
      }
      let finished = false;
      const timer = setTimeout(finish, timeoutMs || 4000);
      function finish() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        img.removeEventListener('load', finish);
        img.removeEventListener('error', finish);
        resolve();
      }
      img.addEventListener('load', finish);
      img.addEventListener('error', finish);
    });
  }

  // Measuring every page before writing any page property keeps this to one
  // layout pass instead of one forced reflow per page.
  function applyPageSizes() {
    const pfs = Array.prototype.slice.call(document.querySelectorAll('.pf'));
    if (!pfs.length) return;

    const planned = [];
    pfs.forEach(function (pf) {
      const rect = pf.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (!(width > 0 && height > 0)) return;
      planned.push({
        pf: pf,
        width: width,
        height: height,
        key: width + 'x' + height
      });
    });

    const names = {};
    const rules = [];
    let index = 0;
    planned.forEach(function (item) {
      if (!names[item.key]) {
        index += 1;
        names[item.key] = 'docdown-page-' + index;
        rules.push('@page ' + names[item.key] + ' { size: ' + item.width +
          'px ' + item.height + 'px; margin: 0; }');
      }
    });

    planned.forEach(function (item) {
      item.pf.style.setProperty('page', names[item.key]);
    });

    let style = document.getElementById('docdown-page-sizes');
    if (!style) {
      style = document.createElement('style');
      style.id = 'docdown-page-sizes';
      document.head.appendChild(style);
    }
    style.textContent = rules.length ? rules.join('\n') : '@page { size: A4 portrait; margin: 0; }';
  }

  // The DOM fallback can carry a blurred preview whose clear sibling never
  // loaded. Hide it and label the page instead of printing a blurred sheet.
  function hideBrokenImages() {
    Array.prototype.slice.call(document.images || []).forEach(function (img) {
      if (!img.getAttribute('data-docdown-original')) return;
      if (img.complete && img.naturalWidth > 0) return;
      img.style.setProperty('display', 'none', 'important');
      const page = img.closest('.pf');
      if (page && !page.querySelector('.docdown-gated-note')) {
        const note = document.createElement('div');
        note.className = 'docdown-gated-note';
        note.textContent = 'Preview only — the clear image is not available.';
        page.appendChild(note);
      }
    });
  }

  async function prepare(fileName) {
    const printButton = document.getElementById('docdown-print');
    try {
      if (document.fonts && document.fonts.ready) {
        await withTimeout(document.fonts.ready, 4000);
      }
    } catch (error) {
      // Font loading is best-effort.
    }

    const images = Array.prototype.slice.call(document.images || []);
    await Promise.all(images.map(function (img) {
      return waitForImage(img, 4000);
    }));

    hideBrokenImages();

    try {
      applyPageSizes();
    } catch (error) {
      // Page sizing is best-effort.
    }

    setTitle(fileName);
    if (printButton) printButton.disabled = false;
    try { window.focus(); } catch (error) { /* ignore */ }
  }

  function measure() {
    const memory = globalThis.performance && globalThis.performance.memory;
    let imageBytes = 0;
    Array.prototype.slice.call(document.images || []).forEach(function (img) {
      if (!img || !img.complete) return;
      imageBytes += (img.naturalWidth || 0) * (img.naturalHeight || 0) * 4;
    });
    return {
      heap: memory ? memory.usedJSHeapSize : null,
      heapLimit: memory ? memory.jsHeapSizeLimit : null,
      nodes: document.getElementsByTagName ? document.getElementsByTagName('*').length : 0,
      imageBytes: imageBytes
    };
  }

  function openMergePage() {
    try {
      const runtime = globalThis.chrome && globalThis.chrome.runtime;
      if (!runtime || typeof runtime.getURL !== 'function') return;
      const url = runtime.getURL('merge.html') +
        '?title=' + encodeURIComponent(currentTitle) +
        '&total=' + encodeURIComponent(String(currentTotalPages));
      window.open(url, '_blank');
    } catch (error) {
      // The extension context can be reloading.
    }
  }

  // Wires the freshly written toolbar. document.open() discarded the previous
  // nodes, so this runs after each skeleton render.
  function bindToolbar() {
    const printButton = document.getElementById('docdown-print');
    if (printButton) {
      // Printing from this page's own realm is what makes Chrome prefill the
      // Save as PDF file name, the same way Ctrl+P does.
      printButton.addEventListener('click', function () {
        if (currentFileName) setTitle(currentFileName);
        try { window.print(); } catch (error) { /* ignore */ }
      });
    }

    const closeButton = document.getElementById('docdown-close');
    if (closeButton) {
      closeButton.addEventListener('click', function () {
        try { window.close(); } catch (error) { /* ignore */ }
      });
    }

    const nextButton = document.getElementById('docdown-next');
    if (nextButton) {
      nextButton.addEventListener('click', function () {
        post({ type: PREFIX + '-next', partIndex: currentPartIndex });
        nextButton.disabled = true;
        nextButton.textContent = 'Đang chuẩn bị phần tiếp theo…';
      });
    }

    const mergeButton = document.getElementById('docdown-merge');
    if (mergeButton) {
      mergeButton.addEventListener('click', openMergePage);
    }
  }

  function postAppended(fromPage, toPage, metrics, markupBytes) {
    post({
      type: PREFIX + '-appended',
      fromPage: fromPage,
      toPage: toPage,
      pages: document.querySelectorAll('[data-page-no]').length,
      heap: metrics.heap,
      heapLimit: metrics.heapLimit,
      nodes: metrics.nodes,
      imageBytes: metrics.imageBytes,
      markupBytes: markupBytes
    });
  }

  function beginStreaming(data) {
    const part = data.part && typeof data.part === 'object' ? data.part : null;
    if (!part) {
      post({
        type: PREFIX + '-failed',
        stage: 'begin',
        message: 'Thiếu thông tin phần in.'
      });
      return;
    }

    const partIndex = Number(part.index);
    const fromPage = Number(part.fromPage);
    const totalPages = Number(part.totalPages) || 0;
    if (!Number.isFinite(partIndex) || !Number.isFinite(fromPage)) {
      post({
        type: PREFIX + '-failed',
        stage: 'begin',
        message: 'Số trang của phần in không hợp lệ.'
      });
      return;
    }

    const html = SH.stripScriptTags(data.html);
    if (!html) {
      post({
        type: PREFIX + '-failed',
        stage: 'begin',
        message: 'Thiếu nội dung bản in.'
      });
      showError('Không ghi được bản in.');
      return;
    }

    try {
      document.open();
      document.write(html);
      document.close();
      bindWindowListeners();
    } catch (error) {
      post({
        type: PREFIX + '-failed',
        stage: 'begin',
        message: 'Không ghi được bản in.'
      });
      showError('Không ghi được bản in.');
      return;
    }

    streaming = true;
    currentPartIndex = partIndex;
    currentTitle = String(data.title || '');
    currentTotalPages = totalPages;
    currentFileName = String(data.fileName || 'document');
    appendedThrough = fromPage - 1;

    const printButton = document.getElementById('docdown-print');
    if (printButton) printButton.disabled = true;
    const nextButton = document.getElementById('docdown-next');
    if (nextButton) nextButton.hidden = true;
    const mergeButton = document.getElementById('docdown-merge');
    if (mergeButton) mergeButton.hidden = true;

    bindToolbar();

    // The baseline must be read after the skeleton has been laid out.
    setTimeout(function () {
      if (!streaming || currentPartIndex !== partIndex) return;
      const baseline = measure();
      post({
        type: PREFIX + '-begun',
        partIndex: partIndex,
        baseline: {
          heap: baseline.heap,
          heapLimit: baseline.heapLimit,
          nodes: baseline.nodes,
          imageBytes: baseline.imageBytes
        }
      });
    }, 0);
  }

  function appendStreaming(data) {
    if (!streaming || appendedThrough === null) {
      post({
        type: PREFIX + '-failed',
        stage: 'append',
        message: 'Chưa bắt đầu phần in.'
      });
      return;
    }

    const html = SH.stripScriptTags(data.html);
    const css = String(data.css || '');
    const fromPage = Number(data.fromPage);
    const toPage = Number(data.toPage);

    if (!Number.isFinite(fromPage) || !Number.isFinite(toPage)) {
      post({
        type: PREFIX + '-failed',
        stage: 'append',
        message: 'Số trang của phần in không hợp lệ.'
      });
      return;
    }

    if (fromPage <= appendedThrough) {
      // A retry for pages that are already in the DOM: do not duplicate them,
      // just report the current measurements again.
      postAppended(fromPage, toPage, measure(), html.length);
      return;
    }

    if (fromPage !== appendedThrough + 1) {
      post({
        type: PREFIX + '-failed',
        stage: 'append',
        message: 'Trang bắt đầu ' + fromPage + ' không nối tiếp trang ' +
          appendedThrough + '.'
      });
      return;
    }

    const container = document.querySelector('.docdown-pages');
    if (!container) {
      post({
        type: PREFIX + '-failed',
        stage: 'append',
        message: 'Không tìm thấy vùng chứa trang in.'
      });
      return;
    }

    try {
      if (css) {
        const style = document.createElement('style');
        style.textContent = SH.safeStyleText(css);
        document.head.appendChild(style);
      }
      container.insertAdjacentHTML('beforeend', html);
    } catch (error) {
      post({
        type: PREFIX + '-failed',
        stage: 'append',
        message: 'Không chèn được trang in.'
      });
      return;
    }

    appendedThrough = toPage;
    postAppended(fromPage, toPage, measure(), html.length);
  }

  async function finalizeStreaming(data) {
    if (!streaming || currentPartIndex === null) {
      post({
        type: PREFIX + '-failed',
        stage: 'final',
        message: 'Chưa bắt đầu phần in.'
      });
      return;
    }

    const fromPage = Number(data.fromPage);
    const toPage = Number(data.toPage);
    const totalPages = Number(data.totalPages);
    const hasNext = !!data.hasNext;

    currentFileName = String(data.fileName || currentFileName || 'document');
    currentTitle = String(data.title || currentTitle || '');
    if (Number.isFinite(totalPages) && totalPages > 0) currentTotalPages = totalPages;

    const meta = document.getElementById('docdown-toolbar-meta') ||
      document.querySelector('.docdown-toolbar-meta');
    if (meta) {
      meta.textContent = 'Trang ' + fromPage + '–' + toPage + ' / ' +
        currentTotalPages + ' · phần ' + currentPartIndex;
    }

    try {
      await prepare(currentFileName);
    } catch (error) {
      post({
        type: PREFIX + '-failed',
        stage: 'final',
        message: 'Không chuẩn bị được bản in.'
      });
      return;
    }

    const printButton = document.getElementById('docdown-print');
    if (printButton) printButton.disabled = false;

    const nextButton = document.getElementById('docdown-next');
    if (nextButton) {
      nextButton.hidden = !hasNext;
      if (hasNext) {
        nextButton.disabled = false;
        nextButton.textContent = 'Phần tiếp theo';
      }
    }

    const mergeButton = document.getElementById('docdown-merge');
    if (mergeButton) mergeButton.hidden = hasNext;

    setTitle(currentFileName);
    post({
      type: PREFIX + '-finalized',
      partIndex: currentPartIndex,
      fromPage: fromPage,
      toPage: toPage
    });
  }

  // The single-shot path used by the other providers. The written document and
  // the messages it emits are unchanged.
  function render(data) {
    const fileName = String(data.fileName || 'document');
    const html = SH.stripScriptTags(data.html);
    if (!html) {
      post({ type: PREFIX + '-failed' });
      return;
    }

    streaming = false;
    appendedThrough = null;
    currentPartIndex = null;
    currentTitle = '';
    currentTotalPages = 0;

    try {
      document.open();
      document.write(html);
      document.close();
      bindWindowListeners();
    } catch (error) {
      post({ type: PREFIX + '-failed' });
      showError('Không ghi được bản in.');
      return;
    }

    currentFileName = fileName;
    setTitle(fileName);

    bindToolbar();

    post({ type: PREFIX + '-rendered' });
    prepare(fileName);
  }

  function showError(message) {
    try {
      document.open();
      document.write('<!doctype html><html><head><meta charset="utf-8"><title>DocDown</title>' +
        '<style>body{margin:0;padding:24px;background:#fff;color:#111;font:15px/1.5 system-ui,sans-serif}' +
        'h1{margin:0 0 8px;font-size:18px}p{margin:0;color:#b91c1c}</style></head><body>' +
        '<h1>DocDown</h1><p id="docdown-error"></p></body></html>');
      document.close();
      bindWindowListeners();
    } catch (error) {
      // Nothing else can be shown in this tab.
    }
    const target = document.getElementById('docdown-error');
    if (target) target.textContent = String(message || 'Đã xảy ra lỗi.');
  }

  function onMessage(event) {
    if (!window.opener || event.source !== window.opener) return;
    if (!SH.isAllowedPrintOrigin(event.origin)) return;

    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === PREFIX + '-ping') {
      post({ type: PREFIX + '-ready' });
    } else if (data.type === PREFIX + '-begin') {
      beginStreaming(data);
    } else if (data.type === PREFIX + '-append') {
      appendStreaming(data);
    } else if (data.type === PREFIX + '-final') {
      finalizeStreaming(data);
    } else if (data.type === PREFIX + '-doc') {
      render(data);
    } else if (data.type === PREFIX + '-error') {
      showError(data.message);
    }
  }

  function onBeforePrint() {
    if (currentFileName) setTitle(currentFileName);
  }

  function onAfterPrint() {
    post({ type: PREFIX + '-printed', partIndex: currentPartIndex });
  }

  // document.open() drops every listener registered on the window, so the tab
  // rebinds after each document.close(). The generation token keeps stale
  // wrappers inert in test doubles where removeEventListener is a stub.
  function bindWindowListeners() {
    listenerGeneration += 1;
    const generation = listenerGeneration;

    window.addEventListener('message', function (event) {
      if (generation !== listenerGeneration) return;
      onMessage(event);
    });
    window.addEventListener('beforeprint', function () {
      if (generation !== listenerGeneration) return;
      onBeforePrint();
    });
    window.addEventListener('afterprint', function () {
      if (generation !== listenerGeneration) return;
      onAfterPrint();
    });
  }

  bindWindowListeners();

  function announce() {
    post({ type: PREFIX + '-ready' });
  }

  if (document.readyState === 'complete') announce();
  else window.addEventListener('load', announce, { once: true });
})();
