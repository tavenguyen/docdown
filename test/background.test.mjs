import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCES = ['../lib/core.js', '../lib/registry.js', '../providers/studocu.js', '../providers/tailieu.js', '../providers/scribd.js']
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const backgroundSource = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');

function loadBackground(options) {
  const opts = options || {};
  const calls = {
    removed: [],
    browsingData: [],
    stores: 0
  };

  const stores = opts.stores || [
    { id: '0', tabIds: [1, 2] },
    { id: '1', tabIds: [9] }
  ];

  const cookiesByStore = opts.cookiesByStore || {
    '0': [
      { name: 'session', domain: '.studocu.vn', path: '/', secure: true, httpOnly: true },
      { name: 'theme', domain: 'www.studocu.vn', path: '/', secure: true, httpOnly: false }
    ],
    '1': [
      { name: 'session', domain: '.studocu.vn', path: '/', secure: true, httpOnly: true }
    ]
  };

  let listener = null;

  const chrome = {
    runtime: {
      id: 'extension-id',
      getManifest: () => ({ version: '0.8.0' }),
      onMessage: {
        addListener(fn) { listener = fn; }
      }
    },
    cookies: {
      async getAllCookieStores() {
        calls.stores += 1;
        return stores;
      },
      async getAll(details) {
        const list = cookiesByStore[details.storeId] || [];
        return list.filter((cookie) =>
          cookie.domain === details.domain ||
          cookie.domain === '.' + details.domain ||
          cookie.domain.endsWith('.' + details.domain));
      },
      async remove(details) {
        calls.removed.push(details);
        return { name: details.name };
      }
    },
    browsingData: {
      async remove(spec, data) {
        calls.browsingData.push({ spec, data });
        if (opts.browsingDataError) throw new Error(opts.browsingDataError);
        return undefined;
      }
    }
  };

  const context = {
    console,
    chrome,
    importScripts() {},
    URL,
    setTimeout,
    clearTimeout,
    Promise
  };
  vm.createContext(context);
  APP_SOURCES.forEach((source, index) => {
    vm.runInContext(source, context, { filename: 'app' + index + '.js' });
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });

  function send(message, sender) {
    return new Promise((resolve) => {
      if (!listener) {
        resolve('NO_LISTENER');
        return;
      }
      const handled = listener(message, sender, resolve);
      if (!handled) resolve('NOT_HANDLED');
    });
  }

  return { calls, send, DocDown: context.DocDown };
}

test('reset message removes cookies and browsing data for the sender tab', async () => {
  const { calls, send } = loadBackground();

  const result = await send(
    { type: 'docdown-reset', hostname: 'www.studocu.vn' },
    { id: 'extension-id', tab: { id: 1, url: 'https://www.studocu.vn/document/x' } }
  );

  assert.equal(result.ok, true);
  assert.equal(result.cookies, 2, 'both cookies of the sender store are removed');
  assert.deepEqual(calls.removed.map((d) => d.name).sort(), ['session', 'theme']);
  assert.ok(calls.removed.every((d) => d.url.startsWith('https://')), 'removal uses https URLs');
  assert.ok(
    calls.removed.some((d) => d.url === 'https://studocu.vn/'),
    'parent-domain cookie is addressed without the leading dot'
  );
  assert.ok(
    !calls.removed.some((d) => d.storeId === '1'),
    'other cookie stores are left alone when the sender tab is known'
  );

  assert.equal(calls.browsingData.length, 2);
  const site = calls.browsingData[0];
  assert.ok(site.spec.origins.includes('https://www.studocu.vn'));
  assert.ok(site.spec.origins.includes('https://studocu.vn'));
  assert.equal(site.spec.origins.includes('https://doc-assets.studocu.com'), false,
    'asset origins must stay out of the site cookie wipe');
  assert.equal(site.data.cache, true);
  assert.equal(site.data.serviceWorkers, true);
  assert.equal(site.data.cookies, true);
  assert.equal(site.data.indexedDB, true);
  assert.equal(site.data.cacheStorage, true);
  assert.equal(site.data.history, undefined, 'must never clear browser history');
  assert.equal(site.data.downloads, undefined, 'must never clear downloads');

  const assets = calls.browsingData[1];
  assert.deepEqual(Array.from(assets.spec.origins), [
    'https://doc-assets.studocu.com',
    'https://website-assets.studocu.com',
    'https://cdn.tailieu.vn',
    'https://html.scribdassets.com'
  ]);
  assert.equal(assets.data.cache, true);
  assert.equal(assets.data.serviceWorkers, true);
  assert.equal(assets.data.cookies, undefined,
    'browsingData treats cookies per site, so asset origins must not wipe studocu.com cookies');
});

test('reset message is rejected for unsupported hosts', async () => {
  const { calls, send } = loadBackground();

  const result = await send(
    { type: 'docdown-reset', hostname: 'evil.test' },
    { id: 'extension-id', tab: { id: 1 } }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'host');
  assert.equal(calls.removed.length, 0);
  assert.equal(calls.browsingData.length, 0);
});

test('messages from another extension id are rejected', async () => {
  const { calls, send } = loadBackground();

  const result = await send(
    { type: 'docdown-reset', hostname: 'www.studocu.com' },
    { id: 'someone-else', tab: { id: 1 } }
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, 'sender');
  assert.equal(calls.removed.length, 0);
});

test('unrelated messages are not handled', async () => {
  const { send } = loadBackground();
  const result = await send({ type: 'something-else' }, { id: 'extension-id' });
  assert.equal(result, 'NOT_HANDLED');
});

test('when the sender tab is unknown, every cookie store is cleared', async () => {
  const { calls, send } = loadBackground();

  const result = await send({ type: 'docdown-reset', hostname: 'www.studocu.vn' }, { id: 'extension-id' });

  assert.equal(result.ok, true);
  assert.equal(result.cookies, 3);
  assert.ok(calls.removed.some((d) => d.storeId === '1'));
});

test('browsing data failure still reports the cookie removal', async () => {
  const { send } = loadBackground({ browsingDataError: 'not permitted' });

  const result = await send(
    { type: 'docdown-reset', hostname: 'www.studocu.vn' },
    { id: 'extension-id', tab: { id: 1 } }
  );

  assert.equal(result.ok, true);
  assert.equal(result.cookies, 2);
  assert.equal(result.browsingData, false);
});

