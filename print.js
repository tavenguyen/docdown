(function () {
  'use strict';

  const SH = globalThis.DocDown;
  if (!SH) return;

  const PREFIX = 'docdown-print';

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

  function applyPageSizes() {
    const pfs = Array.prototype.slice.call(document.querySelectorAll('.pf'));
    if (!pfs.length) return;

    const names = {};
    const rules = [];
    let index = 0;

    pfs.forEach(function (pf) {
      const rect = pf.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (!(width > 0 && height > 0)) return;
      const key = width + 'x' + height;
      if (!names[key]) {
        index += 1;
        names[key] = 'docdown-page-' + index;
        rules.push('@page ' + names[key] + ' { size: ' + width + 'px ' + height + 'px; margin: 0; }');
      }
      pf.style.setProperty('page', names[key]);
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

  function render(data) {
    const fileName = String(data.fileName || 'document');
    const html = SH.stripScriptTags(data.html);
    if (!html) {
      post({ type: PREFIX + '-failed' });
      return;
    }

    try {
      document.open();
      document.write(html);
      document.close();
    } catch (error) {
      post({ type: PREFIX + '-failed' });
      showError('Không ghi được bản in.');
      return;
    }

    setTitle(fileName);

    const printButton = document.getElementById('docdown-print');
    const closeButton = document.getElementById('docdown-close');

    window.addEventListener('beforeprint', function () {
      setTitle(fileName);
    });

    if (printButton) {
      // Printing from this page's own realm is what makes Chrome prefill the
      // Save as PDF file name, the same way Ctrl+P does.
      printButton.addEventListener('click', function () {
        setTitle(fileName);
        try { window.print(); } catch (error) { /* ignore */ }
      });
    }
    if (closeButton) {
      closeButton.addEventListener('click', function () {
        try { window.close(); } catch (error) { /* ignore */ }
      });
    }

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
    } catch (error) {
      // Nothing else can be shown in this tab.
    }
    const target = document.getElementById('docdown-error');
    if (target) target.textContent = String(message || 'Đã xảy ra lỗi.');
  }

  window.addEventListener('message', function (event) {
    if (!window.opener || event.source !== window.opener) return;
    if (!SH.isAllowedPrintOrigin(event.origin)) return;

    const data = event.data;
    if (!data || typeof data.type !== 'string') return;

    if (data.type === PREFIX + '-ping') {
      post({ type: PREFIX + '-ready' });
    } else if (data.type === PREFIX + '-doc') {
      render(data);
    } else if (data.type === PREFIX + '-error') {
      showError(data.message);
    }
  });

  function announce() {
    post({ type: PREFIX + '-ready' });
  }

  if (document.readyState === 'complete') announce();
  else window.addEventListener('load', announce, { once: true });
})();
