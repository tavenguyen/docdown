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

test('clear assets are rewritten to absolute URLs for the print page', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const clear = '/asset/bg/' + HASH + '/splits/page-1-html-bg-abc.webp';
  const blurred = '/asset/bg/blur/' + HASH + '/splits/page-1-html-bg-abc.webp';

  assert.equal(provider.absoluteAssetUrl(clear), 'https://www.coursehero.com' + clear);
  assert.equal(provider.absoluteAssetUrl(blurred), '');
  assert.equal(provider.absoluteAssetUrl('https://evil.test/asset/bg/' + HASH + '/x.webp'), '');

  const css = provider.rewriteCssUrls(
    '.a{background:url(' + clear + ')}.b{background:url(' + blurred + ')}.c{background:url(https://evil.test/x.png)}'
  );
  assert.ok(css.includes('url("https://www.coursehero.com' + clear + '")'), 'clear artwork stays');
  assert.equal((css.match(/none/g) || []).length, 2, 'blurred and foreign URLs are neutralised');
});

test('access is full only when every page was rendered', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  assert.equal(provider.classifyAccess(2, 8), 'preview');
  assert.equal(provider.classifyAccess(8, 8), 'full');
  assert.equal(provider.classifyAccess(0, 8), 'preview');
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

test('the preview note links to the official unlock page only when it is valid', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');

  assert.equal(provider.safeUnlockUrl('/unlock-document/256415136/x/'),
    'https://www.coursehero.com/unlock-document/256415136/x/');
  assert.equal(provider.safeUnlockUrl('https://evil.test/x'), '');
  assert.equal(provider.safeUnlockUrl(''), '');

  const html = provider.notePageHtml(1000, 774, 8, 6, '/unlock-document/256415136/x/');
  assert.ok(html.includes('href="https://www.coursehero.com/unlock-document/256415136/x/"'));
  assert.ok(html.includes('rel="noopener"'));
  assert.ok(html.includes('Mở khóa trên Course Hero'));

  const without = provider.notePageHtml(1000, 774, 8, 6, 'javascript:alert(1)');
  assert.ok(!without.includes('href='), 'an invalid unlock URL must not be linked');
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

test('classifyPage separates full, partial and locked pages', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');

  assert.equal(provider.classifyPage(null), 'locked');
  assert.equal(provider.classifyPage({ redactions: [] }), 'full');
  assert.equal(provider.classifyPage({
    redactions: [{ x: 0, y: 0, w: 10, h: 10, reason: 'blurred' }]
  }), 'partial');
  assert.equal(provider.classifyPage({
    redactions: [{ x: 0, y: 0, w: 4, h: 4, reason: 'foreign' }]
  }), 'full', 'a small foreign icon alone does not make the page partial');
  assert.equal(provider.classifyPage({ redactions: [], unresolved: true }), 'partial');
});

test('summarize counts captured, partial and locked pages', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const summary = provider.summarize([
    { status: 'full' },
    { status: 'partial' },
    { status: 'full' }
  ], 8);

  assert.equal(summary.total, 8);
  assert.equal(summary.captured, 3);
  assert.equal(summary.full, 2);
  assert.equal(summary.partial, 1);
  assert.equal(summary.locked, 5);
  assert.equal(summary.mode, 'preview');
});

test('summarize reports partial when every page is captured but one is redacted', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const summary = provider.summarize([{ status: 'full' }, { status: 'partial' }], 2);

  assert.equal(summary.mode, 'partial');
  assert.equal(summary.locked, 0);
  assert.equal(summary.partial, 1);
});

test('summarize reports full when every page is clear', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const summary = provider.summarize([{ status: 'full' }, { status: 'full' }], 2);

  assert.equal(summary.mode, 'full');
  assert.equal(summary.partial, 0);
  assert.equal(summary.locked, 0);
});

test('coverageOf counts overlapping rects once and clips them to the page', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const half = { x: 0, y: 0, w: 100, h: 50 };

  assert.equal(provider.coverageOf([half], 100, 100), 0.5);
  assert.equal(provider.coverageOf([half, half], 100, 100), 0.5, 'overlap is not double counted');
  assert.equal(provider.coverageOf([{ x: -50, y: -50, w: 400, h: 400 }], 100, 100), 1);
  assert.equal(provider.coverageOf([], 100, 100), 0);
  assert.equal(provider.coverageOf([{ x: 0, y: 0, w: 0, h: 0 }], 100, 100), 0);
  assert.equal(provider.coverageOf([half], 0, 0), 0, 'a page with no size has no coverage');
});

test('pageHtml draws the redaction overlay without leaking the asset URL', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.pageHtml({
    pageNumber: 1,
    width: 1000,
    height: 800,
    rawWidth: 1000,
    rawHeight: 800,
    scale: 1,
    html: '<div class="t">x</div>',
    redactions: [{ x: 12, y: 340, w: 820, h: 96, reason: 'blurred' }]
  });

  assert.match(html, /docdown-ch-redactions/);
  assert.match(html, /left:12px;top:340px;width:820px;height:96px/);
  assert.ok(!/\/blur\//.test(html), 'the blurred asset URL must not reach the PDF');
  assert.ok(!/https?:\/\/www\.coursehero\.com\/asset/.test(html), 'no asset URL in the overlay');
});

test('pageHtml omits the overlay when nothing was redacted', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.pageHtml({
    pageNumber: 1,
    width: 1000,
    height: 800,
    rawWidth: 1000,
    rawHeight: 800,
    scale: 1,
    html: '<div class="t">x</div>',
    redactions: []
  });

  assert.ok(!html.includes('docdown-ch-redactions'));
});

test('pageHtml drops rects too small to be worth marking', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.pageHtml({
    pageNumber: 1,
    width: 1000,
    height: 800,
    rawWidth: 1000,
    rawHeight: 800,
    scale: 1,
    html: '<div class="t">x</div>',
    redactions: [{ x: 0, y: 0, w: 2, h: 2, reason: 'blurred' }]
  });

  assert.ok(!html.includes('docdown-ch-redacted'));
});

test('a partial page carries an inline note naming the page and the share', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.partialNoteHtml({ pageNumber: 3, coverage: 0.182 });

  assert.match(html, /docdown-ch-note/);
  assert.match(html, /Trang 3/);
  assert.match(html, /18%/);
  assert.ok(!/<script/i.test(html));
});

test('partialNoteHtml escapes whatever page label it is given', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.partialNoteHtml({ pageNumber: '<b>x</b>', coverage: 0.5 });

  assert.ok(!html.includes('<b>'));
  assert.match(html, /&lt;b&gt;/);
});

test('partialNoteHtml never prints a zero percentage', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.partialNoteHtml({ pageNumber: 4, coverage: 0.001 });

  assert.ok(!html.includes('0%'), 'a rounding artifact must not read as "0% blurred"');
  assert.match(html, /một phần nội dung bị Course Hero làm mờ/);
});

test('the preview note says how many captured pages are only partly readable', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.notePageHtml(1000, 774, 8, 5, '', 2);

  assert.match(html, /3\/8 trang/);
  assert.match(html, /bị làm mờ một phần/);
});

test('the note drops the locked sentence when no page is locked', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const html = provider.notePageHtml(1000, 774, 3, 0, '', 1);

  assert.match(html, /Bản in một phần/);
  assert.ok(!html.includes('0 trang còn lại'), 'no page is locked, so do not say zero are');
});

function fakeNode(tag, attributes, box, styleText) {
  return {
    tagName: tag,
    textContent: styleText || '',
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    getBoundingClientRect() {
      return box || { left: 0, top: 0, width: 0, height: 0 };
    }
  };
}

function fakeRoot(children, styles) {
  return {
    getAttribute: function () { return null; },
    getBoundingClientRect: function () {
      return { left: 0, top: 0, width: 1000, height: 800 };
    },
    querySelectorAll: function (selector) {
      if (selector === '*') return children;
      if (selector === 'style') return styles || [];
      return [];
    }
  };
}

test('collectRedactions maps blurred and foreign artwork to page coordinates', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const HASH_LOCAL = '6943787cd603c2a23b40c1d9ea9a251771bd5b20';
  const pageRect = { left: 10, top: 20, width: 1000, height: 800 };

  const blurred = fakeNode('IMG', {
    src: '/asset/bg/blur/' + HASH_LOCAL + '/splits/page-1.webp'
  }, { left: 110, top: 220, width: 800, height: 100 });
  const clear = fakeNode('IMG', {
    src: '/asset/bg/' + HASH_LOCAL + '/splits/page-1.webp'
  }, { left: 0, top: 0, width: 500, height: 500 });
  const foreign = fakeNode('IMG', {
    src: 'https://cdn.example.test/logo.svg'
  }, { left: 0, top: 0, width: 20, height: 20 });
  const inlineBlur = fakeNode('DIV', {
    style: 'background-image:url(/asset/bg/blur/' + HASH_LOCAL + '/x.webp)'
  }, { left: 10, top: 20, width: 100, height: 50 });
  const plain = fakeNode('DIV', { style: 'color:red' }, { left: 0, top: 0, width: 10, height: 10 });

  const result = provider.collectRedactions(
    fakeRoot([blurred, clear, foreign, inlineBlur, plain]), pageRect
  );

  assert.equal(result.unresolved, false);
  assert.equal(result.rects.length, 3);
  assert.deepEqual(
    { x: result.rects[0].x, y: result.rects[0].y, w: result.rects[0].w, h: result.rects[0].h },
    { x: 100, y: 200, w: 800, h: 100 },
    'coordinates are relative to the page root'
  );
  assert.equal(result.rects[0].reason, 'blurred');
  assert.equal(result.rects[1].reason, 'foreign');
  assert.equal(result.rects[2].reason, 'blurred');
});

test('collectRedactions flags a stylesheet blur and an unmeasurable node', () => {
  const DD = loadCourseHero();
  const provider = DD.providerById('coursehero');
  const pageRect = { left: 0, top: 0, width: 1000, height: 800 };

  const hiddenBlur = fakeNode('IMG', {
    src: '/asset/bg/blur/abc/x.webp'
  }, null);
  const fromStylesheet = fakeRoot([], [
    fakeNode('STYLE', {}, null, '.p1{background:url(/asset/bg/blur/abc/y.webp)}')
  ]);

  assert.equal(provider.collectRedactions(fromStylesheet, pageRect).unresolved, true);
  assert.equal(provider.collectRedactions(fakeRoot([hiddenBlur]), pageRect).unresolved, true);
});
