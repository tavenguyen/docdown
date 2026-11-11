import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCES = [
  '../lib/core.js',
  '../lib/registry.js',
  '../providers/studocu.js',
  '../providers/academia.js'
].map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const printSource = fs.readFileSync(new URL('../print.js', import.meta.url), 'utf8');

const ACADEMIA_ORIGIN = 'https://www.academia.edu';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePageElement(number) {
  return {
    pageNumber: number,
    style: {
      properties: {},
      setProperty(name, value) { this.properties[name] = value; }
    },
    getBoundingClientRect() {
      return { width: 850, height: 1100 };
    },
    getAttribute(name) {
      return name === 'data-page-no' ? String(number) : null;
    },
    querySelector() { return null; },
    appendChild() {}
  };
}

function createPrintContext(options) {
  const opts = options || {};
  const posts = [];
  const windowListeners = {};
  const elements = new Map();
  const state = {
    printed: 0,
    closed: 0,
    focused: 0,
    written: [],
    styles: [],
    inserted: [],
    opened: [],
    pages: [],
    nodesBase: opts.nodesBase === undefined ? 42 : opts.nodesBase,
    images: opts.images || [{
      complete: true,
      naturalWidth: 10,
      naturalHeight: 20,
      getAttribute() { return null; }
    }]
  };

  function createButton(id) {
    const button = {
      id,
      disabled: true,
      hidden: false,
      textContent: '',
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
  const prevButton = createButton('docdown-prev');
  const nextButton = createButton('docdown-next');
  const mergeButton = createButton('docdown-merge');
  prevButton.hidden = true;
  nextButton.hidden = true;
  mergeButton.hidden = true;

  const container = {
    insertAdjacentHTML(position, html) {
      const text = String(html);
      state.inserted.push(text);
      const pattern = /data-page-no="(\d+)"/g;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        state.pages.push(makePageElement(Number(match[1])));
      }
    }
  };

  // Real document.open() replaces the document and drops every window
  // listener. The tests can turn this off to model a no-op open() stub.
  function clearWindowListeners() {
    Object.keys(windowListeners).forEach((type) => {
      delete windowListeners[type];
    });
  }

  const documentStub = {
    readyState: 'complete',
    title: 'DocDown',
    fonts: { ready: Promise.resolve() },
    get images() { return state.images; },
    head: {
      appendChild(element) {
        if (element && element.id) elements.set(element.id, element);
        state.styles.push(element);
        return element;
      }
    },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll(selector) {
      const value = String(selector).trim();
      if (value === '.pf' || value === '[data-page-no]') return state.pages.slice();
      return [];
    },
    querySelector(selector) {
      if (selector === '.docdown-pages') return container;
      if (selector === '.docdown-toolbar-meta') {
        return elements.get('docdown-toolbar-meta') || null;
      }
      return null;
    },
    createElement(tagName) {
      const element = {
        tagName: String(tagName).toUpperCase(),
        id: '',
        className: '',
        hidden: false,
        textContent: '',
        style: {
          properties: {},
          setProperty(name, value) { this.properties[name] = value; }
        },
        classList: { add() {}, remove() {} },
        children: [],
        appendChild(child) {
          element.children.push(child);
          return child;
        }
      };
      return element;
    },
    getElementsByTagName(name) {
      return { length: name === '*' ? state.nodesBase + state.pages.length : 0 };
    },
    open() {
      if (opts.clearWindowListenersOnOpen !== false) clearWindowListeners();
    },
    write(html) { state.written.push(String(html)); },
    close() {}
  };

  const opener = {
    closed: false,
    postMessage(message) { posts.push(message); }
  };

  const windowStub = {
    opener,
    listeners: windowListeners,
    addEventListener(type, fn) {
      (windowListeners[type] = windowListeners[type] || []).push(fn);
    },
    removeEventListener() {},
    print() { state.printed += 1; },
    close() { state.closed += 1; },
    focus() { state.focused += 1; },
    open(url) { state.opened.push(url); return {}; },
    dispatch(type, event) {
      (windowListeners[type] || []).slice().forEach((fn) => fn(event));
    }
  };

  const context = {
    console,
    window: windowStub,
    document: documentStub,
    location: { href: 'chrome-extension://abc/print.html', protocol: 'chrome-extension:' },
    chrome: {
      runtime: {
        getManifest: () => ({ version: '1.0.0' }),
        getURL: (path) => 'chrome-extension://abc/' + path
      }
    },
    performance: {
      memory: {
        usedJSHeapSize: 1000000,
        jsHeapSizeLimit: 4000000000
      }
    },
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

  return {
    posts,
    state,
    printButton,
    closeButton,
    prevButton,
    nextButton,
    mergeButton,
    documentStub,
    deliver,
    windowStub,
    container
  };
}

function beginStream(ctx, options) {
  const opts = options || {};
  ctx.deliver(ACADEMIA_ORIGIN, {
    type: 'docdown-print-begin',
    html: opts.html === undefined
      ? '<!doctype html><html><head></head><body><div class="docdown-pages"></div></body></html>'
      : opts.html,
    title: opts.title === undefined ? 'Tài liệu thử' : opts.title,
    fileName: opts.fileName === undefined ? 'Tài liệu thử - phần 1' : opts.fileName,
    part: opts.part || { index: 1, fromPage: 1, totalPages: 510 }
  });
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

// ---------------------------------------------------------------------------
// Streaming print flow
// ---------------------------------------------------------------------------

test('streaming begin writes the skeleton, reports a baseline and keeps print disabled', async () => {
  const ctx = createPrintContext({ nodesBase: 37 });
  ctx.printButton.disabled = false;

  const html = '<!doctype html><html><head></head><body>' +
    '<div class="docdown-pages"></div><script>alert(1)<\/script></body></html>';
  beginStream(ctx, { html: html, title: 'Tài liệu thử', fileName: 'Tài liệu thử - phần 1' });
  await wait(20);

  assert.equal(ctx.state.written.length, 1, 'the skeleton is written once');
  assert.ok(ctx.state.written[0].includes('class="docdown-pages"'));
  assert.equal(ctx.state.written[0].includes('<script'), false,
    'scripts are stripped before the skeleton is written');

  const begun = ctx.posts.find((message) => message.type === 'docdown-print-begun');
  assert.ok(begun, 'begun is posted after the skeleton has been laid out');
  assert.equal(begun.partIndex, 1);
  assert.deepEqual(plain(begun.baseline), {
    heap: 1000000,
    heapLimit: 4000000000,
    nodes: 37,
    imageBytes: 800
  });
  assert.equal(ctx.printButton.disabled, true, 'print waits for the first append');
});

test('streaming append sanitises pages and CSS and posts the measurements', async () => {
  const ctx = createPrintContext({ nodesBase: 37 });
  beginStream(ctx);
  await wait(20);

  const html = '<script>bad()<\/script>' +
    '<div class="pf" data-page-no="1">one</div>' +
    '<div class="pf" data-page-no="2">two</div>' +
    '<div class="pf" data-page-no="3">three</div>';
  const stripped = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  const css = '.page{color:red}</style><script>x()<\/script>';

  ctx.deliver(ACADEMIA_ORIGIN, {
    type: 'docdown-print-append',
    html: html,
    css: css,
    fromPage: 1,
    toPage: 3
  });
  await wait(20);

  assert.equal(ctx.state.inserted.length, 1);
  assert.equal(ctx.state.inserted[0], stripped, 'the inserted HTML is sanitised');
  assert.equal(ctx.state.inserted[0].includes('<script'), false);
  assert.equal(ctx.state.pages.length, 3);

  const style = ctx.state.styles.find((item) =>
    String(item.textContent).includes('.page{color:red}'));
  assert.ok(style, 'the batch CSS is appended to head');
  assert.equal(style.textContent.includes('</style>'), false,
    'a closing style tag inside the CSS is escaped');

  const appended = ctx.posts.filter((message) =>
    message.type === 'docdown-print-appended').pop();
  assert.ok(appended);
  assert.equal(appended.fromPage, 1);
  assert.equal(appended.toPage, 3);
  assert.equal(appended.pages, 3);
  assert.equal(appended.heap, 1000000);
  assert.equal(appended.heapLimit, 4000000000);
  assert.equal(appended.nodes, 40, 'baseline nodes plus three pages');
  assert.equal(appended.imageBytes, 800);
  assert.equal(appended.markupBytes, stripped.length);
});

test('a duplicate streaming append is acknowledged without inserting pages twice', async () => {
  const ctx = createPrintContext();
  beginStream(ctx);
  await wait(20);

  const message = {
    type: 'docdown-print-append',
    html: '<div class="pf" data-page-no="1">one</div>' +
      '<div class="pf" data-page-no="2">two</div>',
    css: '',
    fromPage: 1,
    toPage: 2
  };

  ctx.deliver(ACADEMIA_ORIGIN, message);
  await wait(20);
  ctx.deliver(ACADEMIA_ORIGIN, message);
  await wait(20);

  assert.equal(ctx.state.inserted.length, 1, 'the retry must not insert again');
  assert.equal(ctx.state.pages.length, 2, 'the page count must not double');

  const appended = ctx.posts.filter((item) =>
    item.type === 'docdown-print-appended');
  assert.equal(appended.length, 2, 'both appends are acknowledged');
  assert.equal(appended[1].fromPage, 1);
  assert.equal(appended[1].toPage, 2);
  assert.equal(appended[1].pages, 2);
  assert.equal(appended[1].markupBytes, message.html.length);
});

test('a non-contiguous streaming append fails with stage append', async () => {
  const ctx = createPrintContext();
  beginStream(ctx);
  await wait(20);

  ctx.deliver(ACADEMIA_ORIGIN, {
    type: 'docdown-print-append',
    html: '<div class="pf" data-page-no="3"></div>',
    css: '',
    fromPage: 3,
    toPage: 3
  });
  await wait(20);

  assert.equal(ctx.state.inserted.length, 0);
  const failed = ctx.posts.find((message) => message.type === 'docdown-print-failed');
  assert.ok(failed);
  assert.equal(failed.stage, 'append');
  assert.match(failed.message, /không nối tiếp/);
});

test('streaming final names the file, enables print and offers the next part', async () => {
  const ctx = createPrintContext();
  beginStream(ctx, {
    title: 'Tài liệu thử',
    fileName: 'Tài liệu thử - phần 1',
    part: { index: 1, fromPage: 1, totalPages: 510 }
  });
  await wait(20);

  const fileName = 'Tài liệu thử - phần 1 (trang 1–3)';
  ctx.deliver(ACADEMIA_ORIGIN, {
    type: 'docdown-print-final',
    fileName: fileName,
    fromPage: 1,
    toPage: 3,
    hasNext: true,
    title: 'Tài liệu thử',
    totalPages: 510
  });
  await wait(30);

  assert.equal(ctx.documentStub.title, fileName);
  assert.equal(ctx.printButton.disabled, false);
  assert.equal(ctx.nextButton.hidden, false, 'next is shown while pages remain');
  assert.equal(ctx.nextButton.disabled, false);
  assert.equal(ctx.nextButton.textContent, 'Phần tiếp theo');
  assert.equal(ctx.mergeButton.hidden, true, 'merge waits for the last part');

  const finalized = ctx.posts.find((message) =>
    message.type === 'docdown-print-finalized');
  assert.ok(finalized);
  assert.equal(finalized.partIndex, 1);
  assert.equal(finalized.fromPage, 1);
  assert.equal(finalized.toPage, 3);
});

test('the last part offers merge and opens merge.html with the title and total', async () => {
  const ctx = createPrintContext();
  beginStream(ctx, {
    title: 'Tài liệu & mẫu',
    fileName: 'Tài liệu & mẫu - phần 2',
    part: { index: 2, fromPage: 257, totalPages: 510 }
  });
  await wait(20);

  ctx.deliver(ACADEMIA_ORIGIN, {
    type: 'docdown-print-final',
    fileName: 'Tài liệu & mẫu - phần 2 (trang 257–510)',
    fromPage: 257,
    toPage: 510,
    hasNext: false,
    title: 'Tài liệu & mẫu',
    totalPages: 510
  });
  await wait(30);

  assert.equal(ctx.nextButton.hidden, true, 'no next part after the last one');
  assert.equal(ctx.mergeButton.hidden, false, 'merge is shown for the last part');
  assert.equal(ctx.printButton.disabled, false);

  ctx.mergeButton.click();
  assert.equal(ctx.state.opened.length, 1);
  assert.equal(
    ctx.state.opened[0],
    'chrome-extension://abc/merge.html?title=' +
      encodeURIComponent('Tài liệu & mẫu') + '&total=510'
  );
});

test('clicking next posts docdown-print-next once and disables the button', async () => {
  const ctx = createPrintContext();
  beginStream(ctx);
  await wait(20);

  ctx.deliver(ACADEMIA_ORIGIN, {
    type: 'docdown-print-final',
    fileName: 'Tài liệu thử - phần 1 (trang 1–24)',
    fromPage: 1,
    toPage: 24,
    hasNext: true,
    title: 'Tài liệu thử',
    totalPages: 510
  });
  await wait(30);

  ctx.nextButton.click();

  const next = ctx.posts.filter((message) => message.type === 'docdown-print-next');
  assert.equal(next.length, 1);
  assert.equal(next[0].partIndex, 1);
  assert.equal(ctx.nextButton.disabled, true);
  assert.equal(ctx.nextButton.textContent, 'Đang chuẩn bị phần tiếp theo…');
});

test('a replayed part shows the previous button and posts docdown-print-prev', async () => {
  const ctx = createPrintContext();
  beginStream(ctx, {
    title: 'Tài liệu thử',
    fileName: 'Tài liệu thử - phần 2',
    part: { index: 2, fromPage: 257, totalPages: 510 }
  });
  await wait(20);

  ctx.deliver(ACADEMIA_ORIGIN, {
    type: 'docdown-print-final',
    fileName: 'Tài liệu thử - phần 2 (trang 257–510)',
    fromPage: 257,
    toPage: 510,
    hasPrev: true,
    hasNext: false,
    title: 'Tài liệu thử',
    totalPages: 510
  });
  await wait(30);

  assert.equal(ctx.prevButton.hidden, false, 'previous is shown after part 1');
  assert.equal(ctx.prevButton.disabled, false);
  assert.equal(ctx.prevButton.textContent, 'Phần trước');
  assert.equal(ctx.nextButton.hidden, true);
  assert.equal(ctx.mergeButton.hidden, false);

  ctx.prevButton.click();

  const prev = ctx.posts.filter((message) => message.type === 'docdown-print-prev');
  assert.equal(prev.length, 1);
  assert.equal(prev[0].partIndex, 2);
  assert.equal(ctx.prevButton.disabled, true);
  assert.equal(ctx.prevButton.textContent, 'Đang dựng lại phần trước…');
});

test('document.open drops window listeners and repeated begins handle each event once', async () => {
  const ctx = createPrintContext();
  beginStream(ctx, {
    fileName: 'file 1',
    part: { index: 1, fromPage: 1, totalPages: 510 }
  });
  await wait(10);
  beginStream(ctx, {
    fileName: 'file 2',
    part: { index: 2, fromPage: 257, totalPages: 510 }
  });
  await wait(20);

  // The fake open() clears the arrays like a real document.open(), and print.js
  // rebinds one fresh wrapper after each write.
  assert.equal((ctx.windowStub.listeners.message || []).length, 1);
  assert.equal((ctx.windowStub.listeners.beforeprint || []).length, 1);
  assert.equal((ctx.windowStub.listeners.afterprint || []).length, 1);

  ctx.documentStub.title = 'changed';
  ctx.windowStub.dispatch('beforeprint', {});
  assert.equal(ctx.documentStub.title, 'file 2',
    'beforeprint restores the current part file name');

  const printedBefore = ctx.posts.filter((message) =>
    message.type === 'docdown-print-printed').length;
  ctx.windowStub.dispatch('afterprint', {});
  const printed = ctx.posts.filter((message) =>
    message.type === 'docdown-print-printed');
  assert.equal(printed.length - printedBefore, 1,
    'afterprint runs exactly once after repeated begins');
  assert.equal(printed[printed.length - 1].partIndex, 2);

  const readyBefore = ctx.posts.filter((message) =>
    message.type === 'docdown-print-ready').length;
  ctx.deliver(ACADEMIA_ORIGIN, { type: 'docdown-print-ping' });
  const readyAfter = ctx.posts.filter((message) =>
    message.type === 'docdown-print-ready').length;
  assert.equal(readyAfter - readyBefore, 1,
    'the message handler also runs exactly once');
});

test('the generation token keeps stale listeners inert when open() is a no-op', async () => {
  const ctx = createPrintContext({ clearWindowListenersOnOpen: false });
  beginStream(ctx, {
    fileName: 'file 1',
    part: { index: 1, fromPage: 1, totalPages: 510 }
  });
  await wait(10);
  beginStream(ctx, {
    fileName: 'file 2',
    part: { index: 2, fromPage: 257, totalPages: 510 }
  });
  await wait(20);

  assert.ok((ctx.windowStub.listeners.message || []).length > 1,
    'a no-op open() lets the wrappers accumulate');
  assert.ok((ctx.windowStub.listeners.afterprint || []).length > 1,
    'a no-op open() lets afterprint wrappers accumulate');

  const readyBefore = ctx.posts.filter((message) =>
    message.type === 'docdown-print-ready').length;
  ctx.deliver(ACADEMIA_ORIGIN, { type: 'docdown-print-ping' });
  const readyAfter = ctx.posts.filter((message) =>
    message.type === 'docdown-print-ready').length;
  assert.equal(readyAfter - readyBefore, 1,
    'only the newest generation handles the message');

  const printedBefore = ctx.posts.filter((message) =>
    message.type === 'docdown-print-printed').length;
  ctx.windowStub.dispatch('afterprint', {});
  const printed = ctx.posts.filter((message) =>
    message.type === 'docdown-print-printed');
  assert.equal(printed.length - printedBefore, 1,
    'stale afterprint wrappers must not post');
  assert.equal(printed[printed.length - 1].partIndex, 2);
});
