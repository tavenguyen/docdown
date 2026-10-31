(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const ui = {};
  DD.ui = ui;

  const IDS = {
    stack: 'docdown-fab-stack',
    button: 'docdown-download-button',
    reset: 'docdown-reset-button',
    panel: 'docdown-panel',
    panelText: 'docdown-panel-text',
    progress: 'docdown-progress-bar',
    toast: 'docdown-toast'
  };

  const RESET_LABEL = 'Reset phiên';
  const RESET_LABEL_ARMED = 'Xoá tất cả?';
  const RESET_HINT = 'Xoá cookie, cache và dữ liệu trang (đăng xuất tài khoản)';
  const RESET_HINT_ARMED = 'Bấm lần nữa để xoá cookie, cache và đăng xuất';
  const RESET_ARM_MS = 3000;

  const state = {
    provider: null,
    toastTimer: 0,
    panelTimer: 0,
    resetTimer: 0,
    resetArmed: false
  };

  function getStack() {
    return document.getElementById(IDS.stack);
  }

  function getButton() {
    return document.getElementById(IDS.button);
  }

  function getResetButton() {
    return document.getElementById(IDS.reset);
  }

  function getPanel() {
    return document.getElementById(IDS.panel);
  }

  function actionLabel() {
    return (state.provider && state.provider.actionLabel) || 'Tải PDF';
  }

  function createStack() {
    const stack = document.createElement('div');
    stack.id = IDS.stack;
    stack.className = 'docdown-fab-stack';
    return stack;
  }

  function createButton() {
    const button = document.createElement('button');
    button.id = IDS.button;
    button.type = 'button';
    button.className = 'docdown-fab';
    button.setAttribute('data-docdown-button', 'download');
    button.setAttribute('aria-label', 'Tải tài liệu thành PDF');
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg><span class="docdown-label">' + actionLabel() + '</span>';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      const provider = state.provider;
      if (provider && typeof provider.run === 'function') provider.run();
    });
    button.addEventListener('mousedown', function (event) {
      event.stopPropagation();
    });
    return button;
  }

  function setResetLabel(text) {
    const button = getResetButton();
    const label = button && button.querySelector('.docdown-label');
    if (label) label.textContent = text;
  }

  function disarmReset() {
    clearTimeout(state.resetTimer);
    state.resetTimer = 0;
    state.resetArmed = false;
    const button = getResetButton();
    if (!button) return;
    button.classList.remove('docdown-reset-armed');
    button.setAttribute('aria-label', RESET_HINT);
    setResetLabel(RESET_LABEL);
  }

  function armReset() {
    const button = getResetButton();
    if (!button || button.disabled) return;
    state.resetArmed = true;
    button.classList.add('docdown-reset-armed');
    button.setAttribute('aria-label', RESET_HINT_ARMED);
    setResetLabel(RESET_LABEL_ARMED);
    clearTimeout(state.resetTimer);
    state.resetTimer = setTimeout(disarmReset, RESET_ARM_MS);
  }

  async function runReset() {
    disarmReset();
    const button = getResetButton();
    if (button) button.disabled = true;

    const result = await DD.requestFullReset().catch(function () { return null; });

    if (!result || !result.supported) {
      if (button) button.disabled = false;
      ui.toast('Không xoá được dữ liệu trang này.', 'error');
      return;
    }

    const parts = [];
    if (result.cookies) parts.push(result.cookies + ' cookie');
    if (result.full) parts.push('cache');
    ui.toast('Đã xoá ' + (parts.length ? parts.join(' + ') : 'dữ liệu trang') +
      '. Đang tải lại…');
    setTimeout(function () {
      try {
        location.reload();
      } catch (error) {
        if (button) button.disabled = false;
      }
    }, 600);
  }

  function createResetButton() {
    const button = document.createElement('button');
    button.id = IDS.reset;
    button.type = 'button';
    button.className = 'docdown-fab docdown-fab-reset';
    button.setAttribute('data-docdown-button', 'reset');
    button.setAttribute('aria-label', RESET_HINT);
    button.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg><span class="docdown-label">' + RESET_LABEL + '</span>';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      if (state.resetArmed) {
        runReset();
      } else {
        armReset();
      }
    });
    button.addEventListener('mousedown', function (event) {
      event.stopPropagation();
    });
    return button;
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = IDS.panel;
    panel.className = 'docdown-panel';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.hidden = true;

    const text = document.createElement('div');
    text.className = 'docdown-panel-text';
    text.id = IDS.panelText;

    const track = document.createElement('div');
    track.className = 'docdown-progress';
    const bar = document.createElement('i');
    bar.id = IDS.progress;
    track.appendChild(bar);

    panel.appendChild(text);
    panel.appendChild(track);
    return panel;
  }

  // Mounts the floating buttons for a provider. Called again on viewer
  // mutations, so it must stay idempotent.
  ui.mount = function (provider) {
    if (provider) state.provider = provider;
    const active = state.provider;
    if (!active || (typeof active.isDocumentPage === 'function' && !active.isDocumentPage())) return;
    if (!document.body) return;
    let stack = getStack();
    if (!stack) {
      stack = createStack();
      document.body.appendChild(stack);
    }
    let button = getButton();
    if (!button) {
      button = stack.appendChild(createButton());
    } else {
      if (button.parentNode !== stack) stack.appendChild(button);
      const label = button.querySelector('.docdown-label');
      if (label && !button.disabled && label.textContent !== actionLabel()) {
        label.textContent = actionLabel();
      }
    }
    if (!getResetButton()) stack.insertBefore(createResetButton(), button);
    if (!getPanel()) document.body.appendChild(createPanel());
  };

  ui.setState = function (nextState, message) {
    const button = getButton();
    const panel = getPanel();
    const resetButton = getResetButton();
    const label = button && button.querySelector('.docdown-label');
    if (!button || !panel) return;

    panel.hidden = false;
    panel.classList.remove('docdown-panel-error', 'docdown-panel-ready');
    button.disabled = false;
    if (resetButton) resetButton.disabled = false;

    if (nextState === 'working') {
      button.disabled = true;
      if (resetButton) resetButton.disabled = true;
      if (label) label.textContent = (state.provider && state.provider.busyLabel) || 'Đang quét…';
      panel.classList.remove('docdown-panel-error', 'docdown-panel-ready');
    } else if (nextState === 'ready') {
      if (label) label.textContent = actionLabel();
      panel.classList.add('docdown-panel-ready');
    } else if (nextState === 'error') {
      if (label) label.textContent = 'Thử lại';
      panel.classList.add('docdown-panel-error');
    } else {
      if (label) label.textContent = actionLabel();
      panel.hidden = true;
    }

    if (message) ui.progressText(message);
  };

  ui.progressText = function (message) {
    const text = document.getElementById(IDS.panelText);
    if (text) text.textContent = message;
  };

  ui.progress = function (done, total, message) {
    const panel = getPanel();
    const bar = document.getElementById(IDS.progress);
    if (!panel || !bar) return;
    panel.hidden = false;
    const safeTotal = Math.max(1, Number(total) || 1);
    const safeDone = Math.min(safeTotal, Math.max(0, Number(done) || 0));
    bar.style.width = Math.round((safeDone / safeTotal) * 100) + '%';
    if (message) ui.progressText(message);
  };

  ui.toast = function (message, type) {
    let toast = document.getElementById(IDS.toast);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = IDS.toast;
      toast.setAttribute('role', 'alert');
      document.body.appendChild(toast);
    }
    toast.className = 'docdown-toast' + (type ? ' docdown-toast-' + type : '');
    toast.textContent = String(message || '');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      toast.classList.add('docdown-toast-hide');
      setTimeout(function () { toast.remove(); }, 300);
    }, 6000);
  };

  ui.printPageUrl = function () {
    try {
      return chrome.runtime.getURL('print.html');
    } catch (error) {
      return '';
    }
  };

  ui.printPageOrigin = function () {
    const url = ui.printPageUrl();
    if (!url) return '';
    try {
      return new URL(url).origin;
    } catch (error) {
      return '';
    }
  };

  ui.openPrintWindow = function () {
    // Must be called synchronously from the click handler to avoid popup blocking.
    const url = ui.printPageUrl();
    if (!url) return null;
    try {
      return window.open(url, '_blank');
    } catch (error) {
      return null;
    }
  };

  // The preview is an extension page, so it is cross-origin to the document
  // tab and receives the document through postMessage.
  ui.deliverPrintDocument = function (win, html, fileName) {
    return new Promise(function (resolve) {
      if (!win || win.closed) {
        resolve(false);
        return;
      }
      const origin = ui.printPageOrigin();
      const timeoutMs = 20000;
      let finished = false;
      let sent = false;
      let deadline = 0;
      let pinger = 0;

      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearInterval(pinger);
        window.removeEventListener('message', onMessage);
        resolve(ok);
      }

      function sendDocument() {
        if (sent || finished) return;
        sent = true;
        clearInterval(pinger);
        try {
          win.postMessage({
            type: 'docdown-print-doc',
            html: html,
            fileName: fileName
          }, origin);
        } catch (error) {
          finish(false);
        }
      }

      function onMessage(event) {
        if (event.source !== win) return;
        if (origin && event.origin !== origin) return;
        const data = event.data || {};
        if (data.type === 'docdown-print-ready') sendDocument();
        else if (data.type === 'docdown-print-rendered') finish(true);
        else if (data.type === 'docdown-print-failed') finish(false);
      }

      function ping() {
        if (finished) return;
        if (win.closed) {
          finish(false);
          return;
        }
        try {
          win.postMessage({ type: 'docdown-print-ping' }, origin);
        } catch (error) {
          finish(false);
        }
      }

      window.addEventListener('message', onMessage);
      ping();
      pinger = setInterval(ping, 300);
      deadline = setTimeout(function () { finish(false); }, timeoutMs);
    });
  };

  ui.showPrintError = function (win, message) {
    if (!win || win.closed) return;
    try {
      win.postMessage({
        type: 'docdown-print-error',
        message: String(message || '')
      }, ui.printPageOrigin());
    } catch (error) {
      // The tab may already be closed.
    }
  };

  ui.cleanup = function () {
    clearTimeout(state.toastTimer);
    clearTimeout(state.panelTimer);
    clearTimeout(state.resetTimer);
    state.resetTimer = 0;
    state.resetArmed = false;
    const stack = getStack();
    const button = getButton();
    const resetButton = getResetButton();
    const panel = getPanel();
    const toast = document.getElementById(IDS.toast);
    if (stack) stack.remove();
    if (button) button.remove();
    if (resetButton) resetButton.remove();
    if (panel) panel.remove();
    if (toast) toast.remove();
  };
})();
