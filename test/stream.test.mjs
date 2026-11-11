import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const CORE_SOURCE = fs.readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8');
const UI_SOURCE = fs.readFileSync(new URL('../content/ui.js', import.meta.url), 'utf8');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createWindowStub() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      if (list.indexOf(fn) === -1) list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    },
    dispatch(type, event) {
      (listeners.get(type) || []).slice().forEach((fn) => fn(event));
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    }
  };
}

function loadUi(timers) {
  const windowStub = createWindowStub();
  const context = {
    console,
    window: windowStub,
    document: { body: {} },
    chrome: {
      runtime: {
        getURL: (path) => 'chrome-extension://abc/' + path
      }
    },
    URL,
    setTimeout: timers ? timers.setTimeout : setTimeout,
    clearTimeout: timers ? timers.clearTimeout : clearTimeout,
    setInterval: timers ? timers.setInterval : setInterval,
    clearInterval: timers ? timers.clearInterval : clearInterval,
    Promise
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(CORE_SOURCE, context, { filename: 'core.js' });
  vm.runInContext(UI_SOURCE, context, { filename: 'ui.js' });

  return { DD: context.DocDown, windowStub, context };
}

function createPrintWindow() {
  const messages = [];
  return {
    closed: false,
    messages: messages,
    postMessage(message, targetOrigin) {
      messages.push({ message: message, targetOrigin: targetOrigin });
    }
  };
}

function createStream(handlers, timers) {
  const env = loadUi(timers);
  const win = createPrintWindow();
  const stream = env.DD.ui.createPrintStream(win, handlers || {});
  const origin = env.DD.ui.printPageOrigin();
  return { ...env, win, stream, origin };
}

function reply(windowStub, win, origin, data, source, eventOrigin) {
  windowStub.dispatch('message', {
    source: source === undefined ? win : source,
    origin: eventOrigin === undefined ? origin : eventOrigin,
    data: data
  });
}

test('waitForReady pings the print tab until it reports ready', async () => {
  const { windowStub, win, stream, origin } = createStream();

  const ready = stream.waitForReady();
  assert.equal(win.messages.length, 1, 'a ping is sent immediately');
  assert.equal(plain(win.messages[0].message).type, 'docdown-print-ping');

  reply(windowStub, win, origin, { type: 'docdown-print-ready' });
  assert.equal(await ready, true);
  assert.equal(await stream.waitForReady(), true, 'ready is remembered');

  stream.close();
});

test('begin posts the skeleton fields and resolves on begun', async () => {
  const { windowStub, win, stream, origin } = createStream();
  const part = { index: 1, fromPage: 1, totalPages: 510 };

  const pending = stream.begin({
    html: '<html><body></body></html>',
    title: 'Tài liệu thử',
    fileName: 'Tài liệu thử - phần 1',
    part: part
  });

  assert.equal(win.messages.length, 1);
  assert.deepEqual(plain(win.messages[0].message), {
    type: 'docdown-print-begin',
    html: '<html><body></body></html>',
    title: 'Tài liệu thử',
    fileName: 'Tài liệu thử - phần 1',
    part: part
  });

  reply(windowStub, win, origin, {
    type: 'docdown-print-begun',
    partIndex: 1,
    baseline: { heap: 1, heapLimit: 2, nodes: 3, imageBytes: 4 }
  });

  const ack = await pending;
  assert.equal(ack.type, 'docdown-print-begun');
  assert.equal(ack.partIndex, 1);
  assert.equal(ack.baseline.nodes, 3);

  stream.close();
});

test('append posts the page batch and resolves on appended', async () => {
  const { windowStub, win, stream, origin } = createStream();

  const pending = stream.append({
    html: '<div class="pf" data-page-no="1"></div>',
    css: '.pf{color:red}',
    fromPage: 1,
    toPage: 2
  });

  assert.equal(win.messages.length, 1);
  assert.deepEqual(plain(win.messages[0].message), {
    type: 'docdown-print-append',
    html: '<div class="pf" data-page-no="1"></div>',
    css: '.pf{color:red}',
    fromPage: 1,
    toPage: 2
  });

  reply(windowStub, win, origin, {
    type: 'docdown-print-appended',
    fromPage: 1,
    toPage: 2,
    pages: 2,
    heap: 10,
    heapLimit: 20,
    nodes: 30,
    imageBytes: 40,
    markupBytes: 50
  });

  const ack = await pending;
  assert.equal(ack.type, 'docdown-print-appended');
  assert.equal(ack.pages, 2);
  assert.equal(ack.markupBytes, 50);

  stream.close();
});

test('a late append ack for another range does not settle the pending append', async () => {
  const { windowStub, win, stream, origin } = createStream();

  const pending = stream.append({
    html: '<div class="pf" data-page-no="1"></div>',
    css: '',
    fromPage: 1,
    toPage: 2
  });

  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });

  reply(windowStub, win, origin, {
    type: 'docdown-print-appended',
    fromPage: 2,
    toPage: 3,
    pages: 2
  });
  await Promise.resolve();
  assert.equal(settled, false, 'a different fromPage must be ignored');

  reply(windowStub, win, origin, {
    type: 'docdown-print-appended',
    fromPage: 1,
    toPage: 3,
    pages: 2
  });
  await Promise.resolve();
  assert.equal(settled, false, 'a different toPage must be ignored');

  reply(windowStub, win, origin, {
    type: 'docdown-print-appended',
    fromPage: 1,
    toPage: 2,
    pages: 2
  });

  const ack = await pending;
  assert.equal(ack.type, 'docdown-print-appended');
  assert.equal(ack.fromPage, 1);
  assert.equal(ack.toPage, 2);
  assert.equal(ack.pages, 2);

  stream.close();
});

test('append retries once when the print tab does not acknowledge', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const timers = { setTimeout, clearTimeout, setInterval, clearInterval };
  const { windowStub, win, stream, origin } = createStream({}, timers);

  const pending = stream.append({ html: 'x', fromPage: 1, toPage: 1 });
  assert.equal(win.messages.length, 1);

  t.mock.timers.tick(120000);
  assert.equal(win.messages.length, 2, 'the request is retried after the timeout');
  assert.equal(plain(win.messages[1].message).type, 'docdown-print-append');

  reply(windowStub, win, origin, {
    type: 'docdown-print-appended',
    fromPage: 1,
    toPage: 1,
    pages: 1
  });

  const ack = await pending;
  assert.equal(ack.pages, 1);
  stream.close();
});

test('finalize waits for the finalized response type, not just any reply', async () => {
  const { windowStub, win, stream, origin } = createStream();

  const pending = stream.finalize({
    fileName: 'Tài liệu thử - phần 1',
    fromPage: 1,
    toPage: 10,
    hasNext: true,
    title: 'Tài liệu thử',
    totalPages: 20
  });

  assert.equal(win.messages.length, 1);
  assert.deepEqual(plain(win.messages[0].message), {
    type: 'docdown-print-final',
    fileName: 'Tài liệu thử - phần 1',
    fromPage: 1,
    toPage: 10,
    hasNext: true,
    title: 'Tài liệu thử',
    totalPages: 20
  });

  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });

  reply(windowStub, win, origin, { type: 'docdown-print-begun', partIndex: 1 });
  await Promise.resolve();
  assert.equal(settled, false, 'an unrelated message must not settle finalize');

  reply(windowStub, win, origin, {
    type: 'docdown-print-finalized',
    partIndex: 1,
    fromPage: 1,
    toPage: 10
  });

  const ack = await pending;
  assert.equal(ack.type, 'docdown-print-finalized');
  assert.equal(ack.toPage, 10);

  stream.close();
});

test('next, printed and failed events reach their handlers', async () => {
  const seen = {};
  const { windowStub, win, stream, origin } = createStream({
    onNext(data) { seen.next = data; },
    onPrinted(data) { seen.printed = data; },
    onFailed(data) { seen.failed = data; }
  });

  reply(windowStub, win, origin, { type: 'docdown-print-next', partIndex: 2 });
  reply(windowStub, win, origin, { type: 'docdown-print-printed', partIndex: 2 });

  const pending = stream.append({ html: 'x', fromPage: 1, toPage: 1 });
  reply(windowStub, win, origin, {
    type: 'docdown-print-failed',
    stage: 'append',
    message: 'boom'
  });

  const error = await pending.then(() => null, (reason) => reason);
  assert.equal(error && error.message, 'boom');
  assert.equal(error && error.stage, 'append');
  assert.equal(seen.next.partIndex, 2);
  assert.equal(seen.printed.partIndex, 2);
  assert.equal(seen.failed.stage, 'append');
  assert.equal(seen.failed.message, 'boom');

  stream.close();
});

test('messages from another source or origin are ignored', async () => {
  const { windowStub, win, stream, origin } = createStream();

  const pending = stream.begin({ html: '<html></html>' });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });

  reply(windowStub, win, origin, { type: 'docdown-print-begun', partIndex: 1 },
    { notThePrintWindow: true });
  await Promise.resolve();
  assert.equal(settled, false, 'a message from another source is ignored');

  reply(windowStub, win, origin, { type: 'docdown-print-begun', partIndex: 1 },
    undefined, 'https://evil.test');
  await Promise.resolve();
  assert.equal(settled, false, 'a message from another origin is ignored');

  reply(windowStub, win, origin, { type: 'docdown-print-begun', partIndex: 1 });
  const ack = await pending;
  assert.equal(ack.partIndex, 1);

  stream.close();
});

test('close removes the listeners and rejects a pending request', async () => {
  const { windowStub, win, stream } = createStream();

  const pending = stream.append({ html: 'x', fromPage: 1, toPage: 1 });
  assert.equal(windowStub.listenerCount('message'), 1);
  assert.equal(windowStub.listenerCount('pagehide'), 1);

  stream.close();

  const error = await pending.then(() => null, (reason) => reason);
  assert.match(error.message, /Đã đóng kết nối tab in/);
  assert.equal(windowStub.listenerCount('message'), 0);
  assert.equal(windowStub.listenerCount('pagehide'), 0);

  stream.close();
  assert.equal(win.messages.length, 1, 'closing does not post anything else');
});
