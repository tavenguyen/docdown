import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCES = ['../lib/core.js', '../lib/registry.js', '../providers/studocu.js']
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const printSource = fs.readFileSync(new URL('../print.js', import.meta.url), 'utf8');

function createPrintContext() {
  const posts = [];
  const windowListeners = {};
  const elements = new Map();
  const state = { printed: 0, closed: 0, focused: 0, written: [] };

  function createButton(id) {
    const button = {
      id,
      disabled: true,
      _listeners: {},
      addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      },
      click() {
        (this._listeners.click || []).forEach((fn) => fn({ type: 'click' }));
      }
    };
    elements.set(id, button);
    return button;
  }

  const printButton = createButton('docdown-print');
  const closeButton = createButton('docdown-close');

  const documentStub = {
    readyState: 'complete',
    title: 'DocDown',
    fonts: { ready: Promise.resolve() },
    images: [],
    head: { appendChild() {} },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement() {
      return {
        style: { setProperty() {} },
        classList: { add() {} },
        appendChild() {},
        textContent: ''
      };
    },
    open() {},
    write(html) { state.written.push(html); },
    close() {}
  };

  const opener = {
    closed: false,
    postMessage(message) { posts.push(message); }
  };

  const windowStub = {
    opener,
    addEventListener(type, fn) {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
    removeEventListener() {},
    print() { state.printed += 1; },
    close() { state.closed += 1; },
    focus() { state.focused += 1; },
    dispatch(type, event) {
      (windowListeners[type] || []).forEach((fn) => fn(event));
    }
  };

  const context = {
    console,
    window: windowStub,
    document: documentStub,
    location: { href: 'chrome-extension://abc/print.html', protocol: 'chrome-extension:' },
    chrome: { runtime: { getManifest: () => ({ version: '1.0.0' }) } },
    URL,
    setTimeout,
    clearTimeout,
    Promise
  };
  context.globalThis = context;

  vm.createContext(context);
  APP_SOURCES.forEach((source, index) => {
    vm.runInContext(source, context, { filename: 'app' + index + '.js' });
  });
  vm.runInContext(printSource, context, { filename: 'print.js' });

  function deliver(origin, data) {
    windowStub.dispatch('message', { source: opener, origin, data });
  }

  return { posts, state, printButton, closeButton, documentStub, deliver, windowStub };
}

test('print page renders the posted document and names the tab', async () => {
  const ctx = createPrintContext();

  ctx.deliver('https://www.studocu.vn', {
    type: 'docdown-print-doc',
    html: '<!doctype html><html><body><div class="pf"></div></body></html>',
    fileName: 'Đề Cương Chi Tiết Học Phần Thực Tập Cơ Khí - BMPR230227'
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(ctx.documentStub.title, 'Đề Cương Chi Tiết Học Phần Thực Tập Cơ Khí - BMPR230227');
  assert.ok(ctx.posts.some((m) => m.type === 'docdown-print-rendered'));
  assert.ok(ctx.state.written[0].includes('class="pf"'));
  assert.equal(ctx.printButton.disabled, false, 'print button is enabled after loading');
});

test('the print button prints from the page itself', async () => {
  const ctx = createPrintContext();
  ctx.deliver('https://www.studocu.vn', {
    type: 'docdown-print-doc',
    html: '<html><body><div class="pf"></div></body></html>',
    fileName: 'Ten file'
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  ctx.printButton.click();
  assert.equal(ctx.state.printed, 1);
  assert.equal(ctx.documentStub.title, 'Ten file');
});

test('documents from an unexpected origin are ignored', async () => {
  const ctx = createPrintContext();
  ctx.deliver('https://evil.test', {
    type: 'docdown-print-doc',
    html: '<html><body>evil</body></html>',
    fileName: 'evil'
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(ctx.documentStub.title, 'DocDown', 'title must not change');
  assert.equal(ctx.state.written.length, 0, 'nothing may be written');
});

test('script tags inside a posted document are stripped', async () => {
  const ctx = createPrintContext();
  ctx.deliver('https://www.studocu.com', {
    type: 'docdown-print-doc',
    html: '<html><body><script>alert(1)<\/script><p>ok</p></body></html>',
    fileName: 'x'
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(ctx.state.written.length, 1);
  assert.ok(!ctx.state.written[0].includes('<script'), 'script blocks must be removed');
  assert.ok(ctx.state.written[0].includes('<p>ok</p>'));
});

test('error messages replace the page with a readable note', () => {
  const ctx = createPrintContext();
  ctx.deliver('https://www.studocu.vn', {
    type: 'docdown-print-error',
    message: 'Không tải được tài liệu'
  });
  assert.ok(ctx.state.written.length === 1);
});
