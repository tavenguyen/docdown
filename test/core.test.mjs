import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const coreSource = fs.readFileSync(new URL('../content/core.js', import.meta.url), 'utf8');

function loadCore(overrides) {
  const context = {
    console,
    chrome: { runtime: { getManifest: () => ({ version: '0.7.0' }) } },
    document: {
      title: 'Fallback title',
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null
    },
    location: {
      pathname: '/document/test',
      href: 'https://www.studocu.vn/document/test',
      hostname: 'www.studocu.vn'
    },
    URL,
    AbortController,
    FileReader: class {},
    DOMParser: class {},
    setTimeout,
    clearTimeout,
    Promise
  };
  Object.assign(context, overrides || {});
  vm.createContext(context);
  vm.runInContext(coreSource, context, { filename: 'core.js' });
  return context.DocDown;
}

function createCookieDocument(initialCookie) {
  const writes = [];
  const doc = {
    title: 'Fallback title',
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null
  };
  Object.defineProperty(doc, 'cookie', {
    get() { return initialCookie; },
    set(value) { writes.push(String(value)); }
  });
  return { doc, writes };
}

const SH = loadCore();

test('parseDocumentMeta reads page count, object key and wrapper classes', () => {
  const props = {
    document: { numberOfPages: 2, title: 'Test document' },
    documentAccess: {
      objectKey: 'abc123',
      url: 'https://doc-assets.studocu.com/abc123/html/',
      signedQueryParams: { global: '?sig=1' },
      hasBlurredPages: false
    },
    pageDataList: [
      { pageHtmlWrapper: '<div id="pf1" class="pf w0 h0" data-page-no="1">' },
      { pageHtmlWrapper: '<div id="pf2" class="pf w1 h1" data-page-no="2">' }
    ]
  };

  const meta = SH.parseDocumentMeta(props, { title: 'fallback', pageCount: 2 });
  assert.equal(meta.pageCount, 2);
  assert.equal(meta.objectKey, 'abc123');
  assert.equal(meta.baseUrl, 'https://doc-assets.studocu.com/abc123/html/');
  assert.equal(meta.pageClasses[0], 'pf w0 h0');
  assert.equal(meta.pageClasses[1], 'pf w1 h1');
  assert.equal(meta.hasPageList, false);
  assert.equal(meta.canFetch, true);
});

test('parseDocumentMeta rejects unsafe object keys', () => {
  const meta = SH.parseDocumentMeta({
    document: { numberOfPages: 1 },
    documentAccess: { objectKey: '../evil', signedQueryParams: { global: '?sig=1' } }
  }, { pageCount: 1 });
  assert.equal(meta.objectKey, '');
  assert.equal(meta.canFetch, false);
});

test('buildUrls uses hex backgrounds and decimal text pages', () => {
  const meta = {
    objectKey: 'abc123',
    baseUrl: 'https://doc-assets.studocu.com/abc123/html/',
    signedParams: { global: '?sig=1' },
    pageParams: {}
  };
  const urls = SH.buildUrls(meta, 10);
  const base = 'https://doc-assets.studocu.com/abc123/html/';
  assert.equal(urls.bgUrl, base + 'bga.png?sig=1');
  assert.equal(urls.textUrl, base + 'abc12310.page?sig=1');
  assert.equal(urls.clearPageUrl, base + 'pages/page10.webp?sig=1');
  assert.equal(urls.cssUrl, base + 'abc123.css?sig=1');
});

test('per-page signed params override global text params', () => {
  const meta = {
    objectKey: 'abc123',
    baseUrl: 'https://doc-assets.studocu.com/abc123/html/',
    signedParams: { global: '?g=1', png: '?png=1', css: '?css=1', blurredPage: '?blur=1' },
    pageParams: { 1: '?page=1' }
  };
  assert.match(SH.buildUrls(meta, 1).textUrl, /\?page=1$/);
  assert.match(SH.buildUrls(meta, 2).textUrl, /\?g=1$/);
  assert.match(SH.buildUrls(meta, 1).bgUrl, /\?png=1$/);
  assert.match(SH.buildUrls(meta, 1).clearPageUrl, /\?g=1$/);
});

test('isAllowedAssetUrl only accepts Studocu asset hosts over HTTPS', () => {
  assert.equal(SH.isAllowedAssetUrl('https://doc-assets.studocu.com/a/b.png'), true);
  assert.equal(SH.isAllowedAssetUrl('https://website-assets.studocu.com/fonts/a.woff'), true);
  assert.equal(SH.isAllowedAssetUrl('https://doc-assets.studocu.com.evil.test/a.png'), false);
  assert.equal(SH.isAllowedAssetUrl('http://doc-assets.studocu.com/a.png'), false);
  assert.equal(SH.isAllowedAssetUrl('https://evil.test/a.png'), false);
  assert.equal(SH.isAllowedAssetUrl('javascript:alert(1)'), false);
});

test('escapeHtml escapes attribute-sensitive characters', () => {
  assert.equal(SH.escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('getPageClass uses wrapper class, then html classes, then default', () => {
  const meta = { pageClasses: ['pf w0 h0'] };
  assert.equal(SH.getPageClass(meta, 1, ''), 'pf w0 h0');
  assert.equal(SH.getPageClass({ pageClasses: [] }, 1, '<div class="pc pc1 w3 h4"></div>'), 'pf w3 h4');
  assert.equal(SH.getPageClass({ pageClasses: [] }, 1, ''), 'pf w0 h0');
});

test('buildPagesHtml labels gated and missing pages', () => {
  const html = SH.buildPagesHtml(
    { pageClasses: ['pf w0 h0', 'pf w0 h0', 'pf w0 h0'] },
    [
      { pageNumber: 1, gated: false, html: '<div class="pc">one</div>' },
      { pageNumber: 2, gated: true, blurDataUrl: 'data:image/webp;base64,AA' },
      { pageNumber: 3, gated: false }
    ]
  );
  assert.match(html, /class="pf w0 h0"/);
  assert.match(html, /<div class="pc">one<\/div>/);
  assert.match(html, /premium-locked/);
  assert.match(html, /docdown-gated-page/);
  assert.match(html, /Page 3 could not be loaded/);
  assert.ok(!html.includes('data:image/webp'), 'gated page must not embed a blurred image');
  assert.ok(!html.includes('src="data:image'), 'gated page must not embed any preview');
});

test('buildPrintHtml escapes the title and style terminator', () => {
  const html = SH.buildPrintHtml({
    title: 'A <b>title</b>',
    version: '0.6.0',
    css: 'body{color:red}</style><script>alert(1)</script>',
    pagesHtml: '<div class="pf"></div>',
    total: 1
  });
  assert.match(html, /<title>A &lt;b&gt;title&lt;\/b&gt;<\/title>/);
  assert.ok(html.includes('<\\/style><script>alert(1)</script>'));
  assert.match(html, /id="docdown-print"/);
  assert.match(html, /<div class="pf"><\/div>/);
  assert.match(html, /filter:none!important/);
  assert.match(html, /docdown-gated-page/);
});

test('stripBlurClasses removes dynamic CSS-module blur classes', () => {
  const classes = ['pf', 'Viewer_blurred__x1', 'w0', 'BlurredPage_abc'];
  const el = { classList: classes };
  el.classList.remove = (name) => {
    const index = classes.indexOf(name);
    if (index !== -1) classes.splice(index, 1);
  };
  SH.stripBlurClasses(el);
  assert.equal(classes.join(' '), 'pf w0');
});

test('clearBlurStyles removes inline blur and only forces visibility when asked', () => {
  const props = { filter: 'blur(4px)', opacity: '0.2', visibility: 'hidden' };
  const style = {
    removeProperty: (name) => { delete props[name]; },
    setProperty: (name, value) => { props[name] = value; }
  };
  SH.clearBlurStyles({ style }, true);
  assert.equal(props.filter, 'none');
  assert.equal(props.opacity, '1');
  assert.equal(props.visibility, 'visible');

  const textProps = { visibility: 'hidden' };
  const textStyle = {
    removeProperty: (name) => { delete textProps[name]; },
    setProperty: (name, value) => { textProps[name] = value; }
  };
  SH.clearBlurStyles({ style: textStyle }, false);
  assert.equal(textProps.visibility, 'hidden', 'text lines keep inline/class visibility');
});

test('isSupportedHost accepts Studocu domains and rejects lookalikes', () => {
  const LocalSH = loadCore();
  assert.equal(LocalSH.isSupportedHost('www.studocu.vn'), true);
  assert.equal(LocalSH.isSupportedHost('studocu.com'), true);
  assert.equal(LocalSH.isSupportedHost('www.studocu.id'), true);
  assert.equal(LocalSH.isSupportedHost('www.studeersnel.nl'), true);
  assert.equal(LocalSH.isSupportedHost('studocu.com.evil.test'), false);
  assert.equal(LocalSH.isSupportedHost('evil.test'), false);
});

test('resetSessionData clears cookies, storage, caches and IndexedDB on a supported host', async () => {
  const { doc, writes } = createCookieDocument('session=abc; theme=dark');
  const localStore = { cleared: false, clear() { this.cleared = true; } };
  const sessionStore = { cleared: false, clear() { this.cleared = true; } };
  const deletedCaches = [];
  const removedDatabases = [];

  const LocalSH = loadCore({
    document: doc,
    localStorage: localStore,
    sessionStorage: sessionStore,
    caches: {
      keys: async () => ['precache-v1', 'runtime'],
      delete: async (key) => { deletedCaches.push(key); return true; }
    },
    indexedDB: {
      databases: async () => [{ name: 'studocu-db' }],
      deleteDatabase(name) {
        removedDatabases.push(name);
        const request = {};
        setTimeout(() => { if (request.onsuccess) request.onsuccess(); }, 0);
        return request;
      }
    }
  });

  const summary = await LocalSH.resetSessionData();

  assert.equal(summary.supported, true);
  assert.equal(localStore.cleared, true);
  assert.equal(sessionStore.cleared, true);
  assert.deepEqual(deletedCaches, ['precache-v1', 'runtime']);
  assert.deepEqual(removedDatabases, ['studocu-db']);

  assert.ok(writes.length > 0, 'cookies should be expired');
  assert.ok(writes.every((value) => /Max-Age=0/.test(value) && /path=\//.test(value)));
  const names = writes.map((value) => value.split('=')[0]);
  assert.ok(names.includes('session'));
  assert.ok(names.includes('theme'));
  assert.ok(writes.some((value) => value.includes('domain=.studocu.vn')));
  assert.equal(summary.cookies, writes.length);
});

test('resetSessionData refuses to touch anything on an unsupported host', async () => {
  const { doc, writes } = createCookieDocument('session=abc');
  const localStore = { cleared: false, clear() { this.cleared = true; } };

  const LocalSH = loadCore({
    document: doc,
    localStorage: localStore,
    location: { pathname: '/', href: 'https://evil.test/', hostname: 'evil.test' }
  });

  const summary = await LocalSH.resetSessionData();

  assert.equal(summary.supported, false);
  assert.equal(localStore.cleared, false);
  assert.equal(writes.length, 0);
});

test('resetSessionData tolerates missing browser APIs', async () => {
  const { doc } = createCookieDocument('');
  const LocalSH = loadCore({ document: doc });

  const summary = await LocalSH.resetSessionData();

  assert.equal(summary.supported, true);
  assert.equal(summary.storage, 0);
  assert.equal(summary.caches, 0);
  assert.equal(summary.idb, 0);
});

test('requestFullReset falls back to the local reset without a background worker', async () => {
  const { doc, writes } = createCookieDocument('a=1');
  const LocalSH = loadCore({ document: doc });

  const result = await LocalSH.requestFullReset();

  assert.equal(result.supported, true);
  assert.equal(result.fallback, true);
  assert.ok(writes.length > 0, 'fallback still expires visible cookies');
});

test('requestFullReset reports the background worker result', async () => {
  let sent = null;
  const LocalSH = loadCore({
    chrome: {
      runtime: {
        id: 'extension-id',
        getManifest: () => ({ version: '0.8.0' }),
        sendMessage(message, callback) {
          sent = message;
          callback({ ok: true, cookies: 5, browsingData: true });
        }
      }
    }
  });

  const result = await LocalSH.requestFullReset();

  assert.equal(sent.type, 'docdown-reset');
  assert.equal(sent.hostname, 'www.studocu.vn');
  assert.equal(result.full, true);
  assert.equal(result.cookies, 5);
  assert.equal(result.fallback, undefined);
});

test('requestFullReset falls back when the worker refuses', async () => {
  const localStore = { cleared: false, clear() { this.cleared = true; } };
  const LocalSH = loadCore({
    localStorage: localStore,
    chrome: {
      runtime: {
        id: 'extension-id',
        getManifest: () => ({ version: '0.8.0' }),
        sendMessage(message, callback) { callback({ ok: false, error: 'host' }); }
      }
    }
  });

  const result = await LocalSH.requestFullReset();

  assert.equal(result.fallback, true);
  assert.equal(localStore.cleared, true);
});

test('buildFileName keeps a normal Vietnamese document title intact', () => {
  const title = 'Đề Cương Chi Tiết Học Phần Thực Tập Cơ Khí - BMPR230227';
  assert.equal(SH.buildFileName(title), title);
});

test('buildFileName strips the Studocu site suffix', () => {
  assert.equal(SH.buildFileName('Bài giảng | Studocu'), 'Bài giảng');
  assert.equal(SH.buildFileName('Bài giảng - Studocu'), 'Bài giảng');
  assert.equal(SH.buildFileName('College - Studeersnel'), 'College');
});

test('buildFileName replaces illegal file name characters', () => {
  assert.equal(SH.buildFileName('a/b:c*d?"e"<f>|g'), 'a b c d e f g');
  assert.equal(SH.buildFileName('  nhiều    khoảng trắng  '), 'nhiều khoảng trắng');
});

test('buildFileName limits length and falls back when empty', () => {
  assert.equal(SH.buildFileName('x'.repeat(300)).length, 120);
  assert.equal(SH.buildFileName(''), 'document');
  assert.equal(SH.buildFileName(null), 'document');
  assert.equal(SH.buildFileName('***'), 'document');
});

test('buildPrintHtml shows the PDF file name in the preview toolbar', () => {
  const title = 'Đề Cương Chi Tiết Học Phần Thực Tập Cơ Khí - BMPR230227';
  const html = SH.buildPrintHtml({ title, pagesHtml: '', total: 12 });
  assert.ok(html.includes('12 pages &middot; ' + title), 'toolbar must show the suggested file name');
  assert.match(html, /<title>Đề Cương/);
});

test('isAllowedPrintOrigin accepts only the four Studocu domains', () => {
  assert.equal(SH.isAllowedPrintOrigin('https://www.studocu.vn'), true);
  assert.equal(SH.isAllowedPrintOrigin('https://studocu.com'), true);
  assert.equal(SH.isAllowedPrintOrigin('https://www.studocu.id'), true);
  assert.equal(SH.isAllowedPrintOrigin('https://www.studeersnel.nl'), true);
  assert.equal(SH.isAllowedPrintOrigin('https://studocu.com.evil.test'), false);
  assert.equal(SH.isAllowedPrintOrigin('http://www.studocu.vn'), false);
  assert.equal(SH.isAllowedPrintOrigin('chrome-extension://abc'), false);
  assert.equal(SH.isAllowedPrintOrigin(''), false);
});

test('stripScriptTags removes script blocks before printing', () => {
  assert.equal(
    SH.stripScriptTags('<p>a</p><script>alert(1)</script><p>b</p>'),
    '<p>a</p><p>b</p>'
  );
  assert.equal(SH.stripScriptTags('<script src="x"></script>ok'), 'ok');
  assert.equal(SH.stripScriptTags(''), '');
});

test('mapLimit preserves order and respects the concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await SH.mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(Array.from(result), [2, 4, 6, 8, 10]);
  assert.ok(maxActive <= 2, 'max concurrency was ' + maxActive);
});
