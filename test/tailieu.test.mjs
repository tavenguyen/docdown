import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCES = ['../lib/core.js', '../lib/registry.js', '../providers/tailieu.js']
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

const SAMPLE = 'https://cdn.tailieu.vn/files/source/2026/20261014/vispacex_27/ciforicrafop11.pdf';
const TITLE = 'Tài liệu Hệ thống lương thực thực phẩm | TaiLieu.VN';

// Mirrors the devalue payload Nuxt emits: every value is an index into one
// flat array, and reactive wrappers reference another index.
function payloadWith(sampleUrl) {
  return JSON.stringify([
    ['ShallowReactive', 1],
    { data: 2 },
    ['ShallowReactive', 3],
    { 'document-detail-he-thong-2985722': 4 },
    {
      code: 5,
      document: 6,
      page: 7,
      dateTime: 8,
      urlCss: 9,
      sample: 10,
      ishasHtml: 11
    },
    200,
    { document_title: 12, document_numpage: 13, document_isfree: 5 },
    [14, 15],
    '2026/20261014/2985722',
    '2026/20261014/2985722/ciforicrafop11.css',
    sampleUrl,
    true,
    TITLE,
    53,
    'ciforicrafop111',
    'ciforicrafop112'
  ]);
}

function loadTailieu(options) {
  const opts = options || {};
  const text = payloadWith(opts.sampleUrl === undefined ? SAMPLE : opts.sampleUrl);
  const headline = opts.headline === undefined ? '53 trang' : opts.headline;
  const pathname = opts.pathname || '/doc/tai-lieu-he-thong-2985722.html';

  const documentStub = {
    title: 'Tài liệu Hệ thống | TaiLieu.VN',
    getElementById: (id) => (id === '__NUXT_DATA__' ? { textContent: text } : null),
    querySelector: (selector) => (
      selector === '.headline .like .text' ? { textContent: headline } : null
    ),
    querySelectorAll: () => [],
    body: { innerText: headline }
  };

  const context = {
    console,
    document: documentStub,
    location: {
      pathname,
      href: 'https://tailieu.vn' + pathname,
      hostname: 'tailieu.vn'
    },
    chrome: { runtime: { getManifest: () => ({ version: '2.0.0' }) } },
    URL,
    AbortController,
    FileReader: class {},
    DOMParser: class {},
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

test('tailieu provider is selected for the document host and its CDN', () => {
  const DD = loadTailieu();
  assert.equal(DD.getProvider('tailieu.vn').id, 'tailieu');
  assert.equal(DD.getProvider('www.tailieu.vn').id, 'tailieu');
  assert.equal(DD.getProvider('cdn.tailieu.vn').id, 'tailieu');
  assert.equal(DD.getProvider('tailieu.vn.evil.test'), null);
  assert.equal(DD.getProvider('studocu.vn'), null);
  assert.equal(DD.isAllowedPrintOrigin('https://tailieu.vn'), true);
  assert.equal(DD.isAllowedPrintOrigin('https://cdn.tailieu.vn'), true);
});

test('inspect reads the title, PDF URL and displayed page count', () => {
  const DD = loadTailieu();
  const provider = DD.getProvider('tailieu.vn');
  const info = provider.inspect();

  assert.equal(info.pdfUrl, SAMPLE);
  assert.equal(info.title, TITLE);
  assert.equal(info.pageCount, 53);
  assert.equal(info.documentPages, 53);
  assert.equal(info.fileName, 'Tài liệu Hệ thống lương thực thực phẩm.pdf');
  assert.equal(provider.isAvailable(), true);
});

test('a missing headline does not invent a page count', () => {
  const DD = loadTailieu({ headline: '' });
  const info = DD.getProvider('tailieu.vn').inspect();
  assert.equal(info.pageCount, 0, 'payload page counts are unreliable');
  assert.equal(info.pdfUrl, SAMPLE, 'the PDF is still downloadable');
});

test('the status line warns when the public PDF is a preview', () => {
  const DD = loadTailieu();
  const provider = DD.getProvider('tailieu.vn');
  const info = provider.inspect();

  const full = provider.buildStatus(info, 2000000, 53);
  assert.ok(!full.includes('xem trước'), 'a complete file is not labelled as a preview');

  const preview = provider.buildStatus(info, 2000000, 20);
  assert.ok(preview.includes('bản xem trước 20/53 trang'));

  const unknown = provider.buildStatus({ ...info, pageCount: 0 }, 2000000, 20);
  assert.ok(!unknown.includes('xem trước'), 'no claim when the page count is unknown');
});

test('only the CDN PDF source is accepted', () => {
  const DD = loadTailieu();
  const provider = DD.getProvider('tailieu.vn');

  assert.equal(provider.isAllowedAssetUrl(SAMPLE), true);
  assert.equal(provider.isAllowedAssetUrl('http://cdn.tailieu.vn/files/source/a.pdf'), false);
  assert.equal(provider.isAllowedAssetUrl('https://tailieu.vn/files/source/a.pdf'), false);
  assert.equal(provider.isAllowedAssetUrl('https://cdn.tailieu.vn.evil.test/files/source/a.pdf'), false);
  assert.equal(provider.isAllowedAssetUrl('https://doc-assets.studocu.com/a/b.png'), false);
  assert.equal(provider.isAllowedAssetUrl('https://cdn.tailieu.vn/files/source/../../evil.pdf'), false,
    'path traversal normalises outside the allowed prefix');
});

test('a document without a public PDF is not available', () => {
  const DD = loadTailieu({ sampleUrl: '' });
  const provider = DD.getProvider('tailieu.vn');
  assert.equal(provider.isAvailable(), false);
  assert.equal(provider.inspect().pdfUrl, '');
});

test('non-PDF sample URLs are rejected', () => {
  const DD = loadTailieu({ sampleUrl: 'https://cdn.tailieu.vn/files/source/2026/a.docx' });
  assert.equal(DD.getProvider('tailieu.vn').isAvailable(), false);
});

test('the provider is only active on document pages', () => {
  const DD = loadTailieu({ pathname: '/nong-lam-thuy-san/' });
  assert.equal(DD.getProvider('tailieu.vn').isDocumentPage(), false);

  const other = loadTailieu();
  assert.equal(other.getProvider('tailieu.vn').isDocumentPage(), true);
});

test('inspect caches per URL', () => {
  const DD = loadTailieu();
  const provider = DD.getProvider('tailieu.vn');
  assert.equal(provider.inspect(), provider.inspect());
});
