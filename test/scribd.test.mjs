import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCES = ['../lib/core.js', '../lib/registry.js', '../providers/scribd.js']
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

const PREFIX = '44rcaaufnkggzpjq';
const VIEWER_CSS = '.newpage{white-space:nowrap;position:relative}.text_layer{transform:scale(.2);transform-origin:top left}'
  + '.text_layer span{position:absolute}.image_layer .absimg{position:absolute}';

function pageEntry(n, blur) {
  return 'docManager.addPage({ pageNum: ' + n + ' , fonts: [0,1], origWidth: 902 , origHeight: 1274 , '
    + 'containerElem: document.getElementById("outer_page_' + n + '"), blur: ' + (blur ? 'true' : 'false')
    + ' , contentUrl: "https://html.scribdassets.com/' + PREFIX + '/pages/' + n + '-hash' + n + '.jsonp" });';
}

function buildSource(options) {
  const opts = options || {};
  const pages = opts.pages === undefined ? 2 : opts.pages;
  const addPages = [];
  for (let i = 1; i <= pages; i++) addPages.push(pageEntry(i, opts.blurPage === i));

  return '<!doctype html><html><head><title>Báo cáo | Scribd</title>'
    + '<style>' + VIEWER_CSS + '</style>'
    + '<script>docManager.assetPrefix = "' + PREFIX + '";'
    + 'docManager.addFont( 0 , "", "ff0", "Times New Roman, Times, serif", "normal", "normal" );'
    + 'docManager.addFont( 1 , "b", "ff1", "Arial, Helvetica, sans-serif", "bold", "normal" );'
    + addPages.join('')
    + '</script></head><body><div id="outer_page_1"></div></body></html>';
}

function loadScribd(options) {
  const opts = options || {};
  const source = buildSource(opts);
  const documentStub = {
    title: 'Báo cáo | Scribd',
    documentElement: { outerHTML: source },
    querySelector: () => null,
    querySelectorAll: () => []
  };

  const context = {
    console,
    document: documentStub,
    location: {
      pathname: '/document/971473648/Bao-Cao',
      href: 'https://www.scribd.com/document/971473648/Bao-Cao',
      hostname: 'www.scribd.com'
    },
    chrome: { runtime: { getManifest: () => ({ version: '2.0.0' }) } },
    URL,
    AbortController,
    DOMParser: class {},
    fetch: opts.fetch || (() => Promise.reject(new Error('fetch not stubbed'))),
    setTimeout,
    clearTimeout,
    Promise
  };
  vm.createContext(context);
  APP_SOURCES.forEach((source, index) => {
    vm.runInContext(source, context, { filename: 'app' + index + '.js' });
  });
  return context.DocDown;
}

test('scribd provider is selected for document and asset hosts', () => {
  const DD = loadScribd();
  assert.equal(DD.getProvider('www.scribd.com').id, 'scribd');
  assert.equal(DD.getProvider('scribd.com').id, 'scribd');
  assert.equal(DD.getProvider('scribd.com.evil.test'), null);
  assert.equal(DD.isAllowedPrintOrigin('https://www.scribd.com'), true);
  assert.equal(DD.isAllowedPrintOrigin('https://scribd.com.evil.test'), false);
});

test('parseDocument reads pages, sizes, blur flags, fonts and viewer CSS', () => {
  const DD = loadScribd({ blurPage: 2 });
  const provider = DD.providerById('scribd');
  const doc = provider.parseDocument(buildSource({ blurPage: 2 }));

  assert.equal(doc.pageCount, 2);
  assert.equal(doc.assetPrefix, PREFIX);
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[0].pageNumber, 1);
  assert.equal(doc.pages[0].width, 902);
  assert.equal(doc.pages[0].height, 1274);
  assert.equal(doc.pages[0].blur, false);
  assert.equal(doc.pages[1].blur, true, 'blur flag must be read per page');
  assert.match(doc.pages[0].contentUrl, /\/pages\/1-hash1\.jsonp$/);
  assert.equal(doc.fonts.length, 2);
  assert.equal(doc.fonts[1].family, 'Arial, Helvetica, sans-serif');
  assert.match(doc.css, /\.text_layer\{/);
  assert.equal(provider.isAvailable(), true);
});

test('parseDocument refuses to invent pages without addPage entries', () => {
  const DD = loadScribd({ pages: 0 });
  assert.equal(DD.providerById('scribd').isAvailable(), false);
});

test('page JSONP is parsed as data, not executed', () => {
  const DD = loadScribd();
  const provider = DD.providerById('scribd');
  const fragment = '<div class="newpage" id="page1"><div class=text_layer>x</div></div>';
  const text = 'window.page1_callback(' + JSON.stringify([fragment]) + ');';

  assert.equal(provider.parsePageJsonp(text), fragment);
  assert.throws(() => provider.parsePageJsonp('not jsonp'), /unexpected page payload/);
  assert.throws(() => provider.parsePageJsonp('cb(["no markup"])'), /unexpected page payload/);
});

test('only the Scribd CDN page, image and font paths are allowed', () => {
  const DD = loadScribd();
  const provider = DD.providerById('scribd');
  const base = 'https://html.scribdassets.com/' + PREFIX + '/';

  assert.equal(provider.isAllowedAssetUrl(base + 'pages/1-hash1.jsonp'), true);
  assert.equal(provider.isAllowedAssetUrl(base + 'images/1-hash1.png'), true);
  assert.equal(provider.isAllowedAssetUrl(base + 'fonts/0001.woff2'), true);
  assert.equal(provider.isAllowedAssetUrl('http://html.scribdassets.com/' + PREFIX + '/pages/1.jsonp'), false);
  assert.equal(provider.isAllowedAssetUrl('https://html.scribdassets.com.evil.test/' + PREFIX + '/pages/1.jsonp'), false);
  assert.equal(provider.isAllowedAssetUrl('https://html.scribdassets.com/' + PREFIX + '/secret/1.jsonp'), false);
  assert.equal(provider.isAllowedAssetUrl('https://evil.test/' + PREFIX + '/pages/1.jsonp'), false);
  assert.equal(provider.isAllowedAssetUrl(''), false);
});

test('buildCss emits font faces and strips unsafe CSS', () => {
  const DD = loadScribd();
  const provider = DD.providerById('scribd');
  const doc = provider.parseDocument(buildSource());
  doc.css += '@import url("https://evil.test/x.css");a{background:url(javascript:alert(1))}';

  const css = provider.buildCss(doc);
  assert.match(css, /@font-face\{font-family:"scribd-ff0"/);
  assert.match(css, /font-family:"scribd-ff1","Arial, Helvetica, sans-serif"/);
  assert.match(css, /\.docdown-scribd-page\{position:relative/);
  assert.ok(!css.includes('@import'), 'imports must be stripped');
  assert.ok(!/javascript\s*:/i.test(css), 'javascript URLs must be stripped');
});

test('locked pages render a white note page, never a preview', () => {
  const DD = loadScribd();
  const provider = DD.providerById('scribd');
  const locked = provider.pageHtml({ pageNumber: 3, width: 902, height: 1274, blur: true }, 'PREVIEW');
  assert.match(locked, /docdown-gated-page/);
  assert.match(locked, /Page 3 is locked/);
  assert.ok(!locked.includes('PREVIEW'), 'locked page must not embed the fetched fragment');

  const normal = provider.pageHtml({ pageNumber: 1, width: 902, height: 1274, blur: false }, '<div class="newpage"></div>');
  assert.match(normal, /class="pf docdown-scribd-page"/);
  assert.match(normal, /width:902px;height:1274px/);
  assert.match(normal, /<div class="newpage">/);
});

test('a transient fetch failure is retried with a cache reload', async () => {
  const calls = [];
  const DD = loadScribd({
    fetch: async (url, init) => {
      calls.push(init);
      if (calls.length < 3) throw new TypeError('Failed to fetch');
      return {
        ok: true,
        status: 200,
        text: async () => 'window.page1_callback(["<div>x</div>"])'
      };
    }
  });
  DD.sleep = async () => {};

  const fragment = await DD.providerById('scribd').fetchPage({
    pageNumber: 1,
    contentUrl: 'https://html.scribdassets.com/abc123/pages/1-hash1.jsonp'
  });

  assert.equal(fragment, '<div>x</div>');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].cache, undefined, 'first attempt uses the default cache');
  assert.equal(calls[1].cache, 'reload', 'retry bypasses a poisoned cache entry');
});

test('a page that keeps failing stops after three attempts', async () => {
  let calls = 0;
  const DD = loadScribd({
    fetch: async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    }
  });
  DD.sleep = async () => {};

  await assert.rejects(
    () => DD.providerById('scribd').fetchPage({
      pageNumber: 278,
      contentUrl: 'https://html.scribdassets.com/abc123/pages/278-hash278.jsonp'
    }),
    /Failed to fetch/
  );
  assert.equal(calls, 3);
});

test('large documents lower the fetch concurrency', () => {
  const DD = loadScribd();
  const provider = DD.providerById('scribd');
  assert.equal(provider.pageConcurrency(18), 4);
  assert.equal(provider.pageConcurrency(150), 4);
  assert.equal(provider.pageConcurrency(151), 3);
  assert.equal(provider.pageConcurrency(293), 3);
});
