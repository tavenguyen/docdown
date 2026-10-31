import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCES = ['../lib/core.js', '../lib/registry.js', '../providers/coursehero.js']
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

const HASH = '6943787cd603c2a23b40c1d9ea9a251771bd5b20';

function viewerProps(overrides) {
  return {
    subscriptionType: 'logged-out',
    realPermissionType: 'basic',
    viewerProps: {
      documentContent: {
        htmlPreviews: [
          { html: '', page: 1, bgUrl: '/asset/bg/blur/' + HASH + '/splits/page-1-html-bg-abc.webp' },
          { html: '', page: 2, bgUrl: '/asset/bg/blur/' + HASH + '/splits/page-2-html-bg-def.webp' },
          { html: '', page: 3, bgUrl: '' }
        ],
        documentInfo: {
          page_count: 8,
          previewPageCount: 1,
          isLoggedIn: false,
          filehash: HASH,
          unlockUrl: '/unlock-document/256415136/x/'
        }
      }
    },
    ...(overrides || {})
  };
}

function payloadScript(props) {
  const json = JSON.stringify({ 'cm91dGU=': props || viewerProps() });
  return '<html><body><script>window[\'_props_SsiDocumentLanding\'] = '
    + json.replace(/"/g, '\\"') + '</script></body></html>';
}

function loadCourseHero(options) {
  const opts = options || {};
  const source = opts.source === undefined ? payloadScript() : opts.source;
  const pathname = opts.pathname === undefined
    ? '/file/256415136/NR-548-Interview-Documentation-Assignment-Template-week-6docx/'
    : opts.pathname;

  const documentStub = {
    title: 'Comprehensive Psychiatric Interview Template | Course Hero',
    documentElement: { outerHTML: source },
    querySelector: () => null,
    querySelectorAll: () => []
  };

  const context = {
    console,
    document: documentStub,
    location: {
      pathname: pathname,
      href: 'https://www.coursehero.com' + pathname,
      hostname: 'www.coursehero.com'
    },
    chrome: { runtime: { getManifest: () => ({ version: '2.3.0' }) } },
    URL,
    AbortController,
    DOMParser: class {},
    setTimeout,
    clearTimeout,
    Promise
  };
  vm.createContext(context);
  APP_SOURCES.forEach((sourceText, index) => {
    vm.runInContext(sourceText, context, { filename: 'app' + index + '.js' });
  });
  return context.DocDown;
}

test('coursehero provider is selected for the file host', () => {
  const DD = loadCourseHero();
  assert.equal(DD.getProvider('www.coursehero.com').id, 'coursehero');
  assert.equal(DD.getProvider('coursehero.com').id, 'coursehero');
  assert.equal(DD.getProvider('coursehero.com.evil.test'), null);
  assert.equal(DD.isAllowedPrintOrigin('https://www.coursehero.com'), true);
  assert.equal(DD.isAllowedPrintOrigin('https://www.slideshare.net'), false);
});

test('decodePayload unescapes the inline props and readInfo finds the page count', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');

  const viewer = provider.decodePayload(payloadScript());
  assert.ok(viewer, 'payload must parse');
  const info = provider.readInfo(viewer);
  assert.equal(info.pageCount, 8);
  assert.equal(info.previewPageCount, 1);
  assert.equal(info.isLoggedIn, false);
  assert.equal(info.fileHash, HASH);
});

test('decodePayload tolerates missing or broken payloads', () => {
  const DD = loadCourseHero({ source: '<html><body>nothing</body></html>' });
  assert.equal(DD.providerById('coursehero').decodePayload('<html></html>'), null);
  assert.equal(DD.providerById('coursehero').decodePayload(null), null);
});

test('blurred artwork is detected and never allowed', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const clear = 'https://www.coursehero.com/asset/bg/' + HASH + '/splits/page-1-html-bg-abc.webp';
  const blurred = 'https://www.coursehero.com/asset/bg/blur/' + HASH + '/splits/page-1-html-bg-abc.webp';

  assert.equal(provider.isBlurredUrl(blurred), true);
  assert.equal(provider.isBlurredUrl(clear), false);
  assert.equal(provider.isAllowedAssetUrl(clear), true);
  assert.equal(provider.isAllowedAssetUrl(blurred), false, 'blur assets must be rejected');
  assert.equal(provider.isAllowedAssetUrl(clear.replace('https://', 'http://')), false);
  assert.equal(provider.isAllowedAssetUrl('https://www.coursehero.com.evil.test/asset/bg/' + HASH + '/x.webp'), false);
  assert.equal(provider.isAllowedAssetUrl('https://www.coursehero.com/asset/bg/' + HASH + '/../../x.webp'), false);
});

test('pageHtml wraps the rendered page at the normalised width', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.pageHtml({
    pageNumber: 2,
    width: 1000,
    height: 774,
    rawWidth: 1011,
    rawHeight: 782,
    scale: 1000 / 1011,
    html: '<div class="t">x</div>'
  });

  assert.match(html, /class="pf docdown-ch-page"/);
  assert.match(html, /width:1000px;height:774px/);
  assert.match(html, /transform:scale\(0\.989/);
  assert.match(html, /data-page-no="2"/);
  assert.match(html, /<div class="t">x<\/div>/);
});

test('the preview note states how many pages are missing', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.notePageHtml(1000, 774, 8, 6);

  assert.match(html, /docdown-gated-page/);
  assert.match(html, /Bản xem trước/);
  assert.match(html, /2\/8 trang/);
  assert.match(html, /6 trang còn lại/);
});

test('buildCss keeps the page box hidden and white', () => {
  const DD = loadCourseHero();
  const css = DD.providerById('coursehero').buildCss();
  assert.match(css, /\.docdown-ch-page\{position:relative;overflow:hidden/);
  assert.match(css, /\.docdown-ch-scale\{position:relative/);
});

test('isAvailable is false when the viewer rendered no text page', () => {
  const DD = loadCourseHero();
  assert.equal(DD.providerById('coursehero').isAvailable(), false);
  assert.equal(DD.providerById('coursehero').isDocumentPage(), true);

  const other = loadCourseHero({ pathname: '/file/256415136/' });
  assert.equal(other.providerById('coursehero').isDocumentPage(), true);

  const notFile = loadCourseHero({ pathname: '/homework-help/' });
  assert.equal(notFile.providerById('coursehero').isDocumentPage(), false);
});
