import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCES = ['../lib/core.js', '../lib/registry.js', '../providers/academia.js']
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

const DOC_PATH = '/42289459/Hands_on_Machine_Learning_with_Scikit_2E';
const DOC_HREF = 'https://www.academia.edu' + DOC_PATH;
const ASSET_BASE = 'https://attachments.academia-assets.com';

// Page descriptor in the shape the Academia viewer API returns.
function pageDef(number, options) {
  const opts = options || {};
  return {
    page_number: number,
    page_url: opts.url === undefined
      ? ASSET_BASE + '/3240049/' + number + '.html'
      : opts.url,
    width: opts.width,
    height: opts.height
  };
}

function loadAcademia(options) {
  const opts = options || {};
  const documentStub = {
    title: opts.title === undefined
      ? '(PDF) Hands-on Machine Learning | Academia.edu'
      : opts.title,
    querySelector(selector) {
      if (selector === '.attachment_preview[data-attachment]') {
        if (opts.attachment === undefined || opts.attachment === null) return null;
        return { getAttribute: () => opts.attachment };
      }
      if (selector === 'h1') {
        if (opts.heading === undefined || opts.heading === null) return null;
        return { textContent: opts.heading };
      }
      return null;
    },
    querySelectorAll: () => []
  };

  const context = {
    console,
    document: documentStub,
    location: {
      pathname: opts.pathname === undefined ? DOC_PATH : opts.pathname,
      href: opts.href === undefined ? DOC_HREF : opts.href,
      hostname: 'www.academia.edu'
    },
    chrome: { runtime: { getManifest: () => ({ version: '2.6.0' }) } },
    URL,
    AbortController,
    DOMParser: opts.DOMParser || class {},
    fetch: opts.fetch || (() => Promise.reject(new Error('fetch not stubbed'))),
    setTimeout,
    clearTimeout,
    Promise
  };
  vm.createContext(context);
  APP_SOURCES.forEach((source, index) => {
    vm.runInContext(source, context, { filename: 'app' + index + '.js' });
  });
  return {
    DD: context.DocDown,
    context,
    provider: context.DocDown.providerById('academia')
  };
}

const VOID_TAGS = new Set([
  'img', 'br', 'hr', 'input', 'meta', 'link', 'base', 'source', 'track', 'embed'
]);

function serializeNode(node) {
  const name = node.tagName.toLowerCase();
  let attrs = '';
  node._attrs.forEach((value, key) => {
    attrs += ' ' + key + '="' + value + '"';
  });
  if (VOID_TAGS.has(name)) return '<' + name + attrs + '>';
  const inner = node.text + node.children.map(serializeNode).join('');
  return '<' + name + attrs + '>' + inner + '</' + name + '>';
}

function selectorMatches(node, selector) {
  const attr = selector.match(/^([a-z0-9]+)\[([a-z0-9:._-]+)\]$/i);
  if (attr) {
    return node.tagName === attr[1].toUpperCase() &&
      node.getAttribute(attr[2]) !== null;
  }
  if (selector === '*') return true;
  return node.tagName === selector.toUpperCase();
}

// Minimal test-only DOM for preparePage. It implements only the operations the
// provider uses: tag/attribute selectors, attribute access, removal and
// serialisation. Real HTML parsing is browser behaviour and is not tested here.
function makeNode(tagName, attrs) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    _attrs: new Map(),
    children: [],
    parentNode: null,
    text: '',
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    getAttribute(name) {
      const key = String(name).toLowerCase();
      return node._attrs.has(key) ? node._attrs.get(key) : null;
    },
    setAttribute(name, value) {
      node._attrs.set(String(name).toLowerCase(), String(value));
    },
    removeAttribute(name) {
      node._attrs.delete(String(name).toLowerCase());
    },
    remove() {
      if (!node.parentNode) return;
      const siblings = node.parentNode.children;
      const at = siblings.indexOf(node);
      if (at !== -1) siblings.splice(at, 1);
      node.parentNode = null;
    },
    get attributes() {
      return Array.from(node._attrs, ([name, value]) => ({ name, value }));
    },
    get id() {
      return node.getAttribute('id') || '';
    },
    get textContent() {
      return node.text + node.children.map((child) => child.textContent).join('');
    },
    get outerHTML() {
      return serializeNode(node);
    },
    querySelectorAll(selector) {
      const selectors = String(selector)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const found = [];
      const walk = (current) => {
        current.children.forEach((child) => {
          if (selectors.some((part) => selectorMatches(child, part))) found.push(child);
          walk(child);
        });
      };
      walk(node);
      return found;
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] || null;
    }
  };

  Object.keys(attrs || {}).forEach((name) => node.setAttribute(name, attrs[name]));
  return node;
}

function makeDocument(root) {
  const hasId = (id) => !!root && root.getAttribute('id') === id;
  return {
    getElementById(id) {
      return hasId(id) ? root : null;
    },
    querySelector(selector) {
      if (selector === '#jpedal') return hasId('jpedal') ? root : null;
      return root ? root.querySelector(selector) : null;
    },
    querySelectorAll(selector) {
      return root ? root.querySelectorAll(selector) : [];
    }
  };
}

function buildPageFixture(options) {
  const opts = options || {};
  const root = makeNode('div', {
    id: 'jpedal',
    style: 'line-height:16px; width:909px; height:1286px'
  });
  if (opts.empty) return root;

  const style = makeNode('style');
  style.text = '@font-face{src:url("' + ASSET_BASE + '/3240049/fonts/A_1r.woff")}';
  root.appendChild(style);

  root.appendChild(makeNode('script'));
  root.appendChild(makeNode('iframe'));
  root.appendChild(makeNode('object'));

  root.appendChild(makeNode('img', {
    src: '1/img/1.jpg',
    srcset: 'x',
    'data-src': 'y',
    loading: 'lazy'
  }));
  root.appendChild(makeNode('img', { src: 'https://evil.test/x.jpg' }));
  root.appendChild(makeNode('img', { src: '1/img/%2e%2e%2f1.jpg' }));

  const badLink = makeNode('a', { href: 'javascript:alert(1)' });
  badLink.text = 'bad';
  root.appendChild(badLink);

  const goodLink = makeNode('a', { href: 'https://www.academia.edu/x' });
  goodLink.text = 'good';
  root.appendChild(goodLink);

  root.appendChild(makeNode('image', {
    href: 'https://evil.test/x.svg',
    'xlink:href': 'https://evil.test/x.svg'
  }));

  const badStyle = makeNode('div', { style: 'background:url(https://evil.test/x.png)' });
  badStyle.text = 'bad style';
  root.appendChild(badStyle);

  const goodStyle = makeNode('div', {
    style: 'background:url(/3240049/1/img/1.png);left:10px'
  });
  goodStyle.text = 'good style';
  root.appendChild(goodStyle);

  const attrs = makeNode('div', { onclick: 'x()', srcdoc: 'x' });
  attrs.text = 'attrs';
  root.appendChild(attrs);

  return root;
}

test('academia provider is selected for the document host only', () => {
  const { DD } = loadAcademia();

  assert.equal(DD.getProvider('www.academia.edu').id, 'academia');
  assert.equal(DD.getProvider('academia.edu').id, 'academia');
  assert.equal(DD.getProvider('academia.edu.evil.test'), null);
  assert.equal(DD.isAllowedPrintOrigin('https://www.academia.edu'), true);
  assert.equal(DD.isAllowedPrintOrigin('https://www.academia.edu.evil.test'), false);
});

test('isDocumentPage accepts document routes and rejects everything else', () => {
  assert.equal(loadAcademia().provider.isDocumentPage(), true);
  assert.equal(loadAcademia({ pathname: '/42289459' }).provider.isDocumentPage(), true);

  for (const pathname of ['/login', '/search?q=1', '/user/foo']) {
    assert.equal(
      loadAcademia({ pathname }).provider.isDocumentPage(),
      false,
      pathname + ' must not look like a document'
    );
  }
});

test('attachmentIdFrom accepts the published attachment and bare ids', () => {
  const { provider } = loadAcademia();

  assert.equal(provider.attachmentIdFrom('Attachment_122969643'), 122969643);
  assert.equal(provider.attachmentIdFrom('attachment_000123'), 123);
  assert.equal(provider.attachmentIdFrom('123456'), 123456);

  for (const value of ['', 'Attachment_abc', '0', '-1', '12x', null]) {
    assert.equal(provider.attachmentIdFrom(value), 0, JSON.stringify(value));
  }
});

test('getAttachmentId reads the DOM and isAvailable follows it', () => {
  const missing = loadAcademia();
  assert.equal(missing.provider.getAttachmentId(), 0);
  assert.equal(missing.provider.isAvailable(), false);

  const present = loadAcademia({ attachment: 'Attachment_122969643' });
  assert.equal(present.provider.getAttachmentId(), 122969643);
  assert.equal(present.provider.isAvailable(), true);
});

test('getTitle prefers the h1 and strips the Academia suffixes', () => {
  const heading = loadAcademia({ heading: '(PDF) Hands-on Machine Learning with Scikit-Learn' });
  assert.equal(heading.provider.getTitle(), 'Hands-on Machine Learning with Scikit-Learn');

  const pipe = loadAcademia({ title: 'Hands-on Machine Learning | Academia.edu' });
  assert.equal(pipe.provider.getTitle(), 'Hands-on Machine Learning');

  const dash = loadAcademia({ title: 'Deep Learning - Academia.edu' });
  assert.equal(dash.provider.getTitle(), 'Deep Learning');
});

test('only the Academia attachment host and BuildVu paths are allowed', () => {
  const { provider } = loadAcademia();

  assert.equal(provider.isAllowedAssetUrl(ASSET_BASE + '/3240049/1.html'), true);
  assert.equal(provider.isAllowedAssetUrl(ASSET_BASE + '/3240049/1/img/1.jpg'), true);
  assert.equal(provider.isAllowedAssetUrl(ASSET_BASE + '/3240049/fonts/Cambria_1r.woff'), true);
  assert.equal(provider.isAllowedAssetUrl(ASSET_BASE + '/3240049/fonts/Cambria_1r.woff2'), true);

  assert.equal(provider.isAllowedAssetUrl('http://' + ASSET_BASE.replace('https://', '') + '/3240049/1.html'), false);
  assert.equal(provider.isAllowedAssetUrl('https://attachments.academia-assets.com.evil.test/3240049/1.html'), false);
  assert.equal(provider.isAllowedAssetUrl(ASSET_BASE + '/3240049/../secret.html'), false);
  assert.equal(provider.isAllowedAssetUrl(ASSET_BASE + '/3240049/secret.html'), false);
  assert.equal(provider.isAllowedAssetUrl(ASSET_BASE + '/3240049/1.html/extra'), false);
  assert.equal(provider.isAllowedAssetUrl('javascript:alert(1)'), false);
  assert.equal(provider.isAllowedAssetUrl(''), false);
});

test('isAllowedAssetUrl rejects raw and encoded path traversal', () => {
  const { provider } = loadAcademia();

  const first = ASSET_BASE + '/3240049/1/../1.html';
  const second = ASSET_BASE + '/999/../3240049/1.html';
  const encoded = ASSET_BASE + '/3240049/1/img/%2e%2e%2f1.jpg';

  assert.equal(provider.isAllowedAssetUrl(first), false);
  assert.equal(provider.isAllowedAssetUrl(second), false);
  assert.equal(provider.isAllowedAssetUrl(encoded), false);

  const meta = provider.normalizePageDefs([pageDef(1), pageDef(2, { url: encoded })]);
  assert.deepEqual(Array.from(meta.pages, (page) => page.page_number), [1],
    'a traversal page_url must be dropped');
});

// Regression guard for providers/academia.js:isAllowedAssetUrl. Relative
// BuildVu paths must be resolved against the asset host, not the Academia page
// origin, or normalizePageDefs drops every relative page_url the API returns.
test('asset paths are resolved against the attachment host', () => {
  const { provider } = loadAcademia();

  assert.equal(provider.isAllowedAssetUrl('/3240049/1/img/1.jpg'), true);
  assert.equal(provider.isAllowedAssetUrl('/3240049/fonts/Cambria_1r.woff'), true);
  assert.equal(provider.isAllowedAssetUrl('/3240049/fonts/Cambria_1r.woff2'), true);
});

test('pageDefsUrl points at the same-origin BuildVu page list', () => {
  const { provider } = loadAcademia();
  const url = provider.pageDefsUrl(42289459);

  assert.equal(
    url,
    '/v0/document_viewer/build_vu_page_defs/42289459?subdomain_param=api'
  );
  assert.equal(url.startsWith('/api/'), false,
    'the first route element is the api subdomain, not a path segment');
});

test('normalizePageDefs sorts pages, applies defaults and keeps the page count', () => {
  const { provider } = loadAcademia();

  const meta = provider.normalizePageDefs([pageDef(2), pageDef(1)]);
  assert.equal(meta.pages.length, 2);
  assert.deepEqual(Array.from(meta.pages, (page) => page.page_number), [1, 2]);
  assert.equal(meta.pages[0].width, 850);
  assert.equal(meta.pages[0].height, 1100);
  assert.equal(meta.totalPages, 2);

  assert.equal(provider.normalizePageDefs({ pages: [pageDef(1)], total_pages: 12 }).totalPages, 12);
  assert.equal(provider.normalizePageDefs({ page_defs: [pageDef(1)], page_count: 5 }).totalPages, 5);

  const sized = provider.normalizePageDefs([pageDef(1, { width: 612, height: 792 })]);
  assert.equal(sized.pages[0].width, 612);
  assert.equal(sized.pages[0].height, 792);
});

test('normalizePageDefs drops duplicate numbers and invalid page URLs', () => {
  const { provider } = loadAcademia();

  const meta = provider.normalizePageDefs([
    pageDef(1),
    pageDef(1),
    pageDef(2, { url: 'https://evil.test/3240049/2.html' }),
    pageDef(3, { url: 'http://attachments.academia-assets.com/3240049/3.html' })
  ]);

  assert.deepEqual(Array.from(meta.pages, (page) => page.page_number), [1]);
  assert.equal(meta.pages[0].page_url, ASSET_BASE + '/3240049/1.html');
});

test('normalizePageDefs returns null when no page is usable', () => {
  const { provider } = loadAcademia();

  for (const payload of [
    null,
    {},
    [],
    [pageDef(1, { url: 'https://evil.test/3240049/1.html' })]
  ]) {
    assert.equal(provider.normalizePageDefs(payload), null, JSON.stringify(payload));
  }
});

test('normalizePageDefs absolutises relative page URLs against the asset host', () => {
  const { provider } = loadAcademia();

  const meta = provider.normalizePageDefs([
    { page_number: 1, page_url: '/3240049/1.html', width: 909, height: 1286 }
  ]);

  assert.equal(meta.pages[0].page_url, ASSET_BASE + '/3240049/1.html');
  assert.equal(meta.pages[0].width, 909);
  assert.equal(meta.pages[0].height, 1286);

  const evil = provider.normalizePageDefs([
    { page_number: 1, page_url: '//evil.test/3240049/1.html' }
  ]);
  assert.equal(evil, null, 'a protocol-relative URL must not inherit the asset host');
});

test('sanitizeCss allowlists url() values and strips active CSS', () => {
  const { provider } = loadAcademia();
  const allowedImage = ASSET_BASE + '/3240049/1/img/1.png';
  const allowedFont = ASSET_BASE + '/3240049/fonts/A_1r.woff';
  const css = '@import url("https://evil.test/x.css");'
    + '@font-face{font-family:X;src:url("' + ASSET_BASE + '/3240049/fonts/x.woff")}'
    + 'a{background:url("' + allowedImage + '")}'
    + '@font-face{font-family:Y;src:url(/3240049/fonts/A_1r.woff)}'
    + 'b{background:url("https://evil.test/x.png")}'
    + 'c{background:url("data:font/woff;base64,AAAA")}'
    + 'd{width:expression(alert(1));background:url(javascript:alert(1));'
    + 'behavior:url(x.htc);-moz-binding:url(x.xml)}'
    + 'e{background:url(vbscript:alert(1))}'
    + 'f{color:red}';

  const clean = provider.sanitizeCss(css);

  assert.ok(clean.includes('url("' + allowedImage + '")'),
    'an allowlisted image url survives');
  assert.ok(clean.includes('url("' + allowedFont + '")'),
    'a root-relative font url is absolutised');
  assert.equal(clean.includes('evil.test'), false, 'disallowed urls must not remain');
  assert.match(clean, /b\{background:none\}/, 'a disallowed url() becomes none');
  assert.ok(clean.includes('url("data:font/woff;base64,AAAA")'),
    'font data URLs survive');

  assert.ok(!clean.includes('@import'), 'imports must be stripped');
  assert.ok(!/expression\s*\(/i.test(clean), 'expression() must be stripped');
  assert.ok(!/javascript\s*:/i.test(clean), 'javascript URLs must be stripped');
  assert.ok(!/vbscript\s*:/i.test(clean), 'vbscript URLs must be stripped');
  assert.ok(!/behavior\s*:/i.test(clean), 'behavior must be stripped');
  assert.ok(!/-moz-binding\s*:/i.test(clean), '-moz-binding must be stripped');
  assert.match(clean, /@font-face/);
  assert.match(clean, /f\{color:red\}/);
});

test('fontUrls returns only unique allowlisted font files', () => {
  const { provider } = loadAcademia();
  const css = '@font-face{src:url("' + ASSET_BASE + '/3240049/fonts/A_1r.woff")}'
    + '@font-face{src:url("' + ASSET_BASE + '/3240049/fonts/A_1r.woff")}'
    + '@font-face{src:url("' + ASSET_BASE + '/3240049/fonts/B_1r.woff2")}'
    + '.x{background:url("' + ASSET_BASE + '/3240049/1/img/1.png")}'
    + '@font-face{src:url("https://evil.test/3240049/fonts/C_1r.woff")}'
    + '@font-face{src:url("' + ASSET_BASE + '/3240049/fonts/D_1r.ttf")}'
    + '@font-face{src:url("/3240049/fonts/E_1r.woff")}';

  assert.deepEqual(Array.from(provider.fontUrls(css)), [
    ASSET_BASE + '/3240049/fonts/A_1r.woff',
    ASSET_BASE + '/3240049/fonts/B_1r.woff2',
    ASSET_BASE + '/3240049/fonts/E_1r.woff'
  ]);
});

test('inlineFonts replaces fetched fonts and leaves failures alone', async () => {
  const { DD, provider } = loadAcademia();
  const first = ASSET_BASE + '/3240049/fonts/A_1r.woff';
  const second = ASSET_BASE + '/3240049/fonts/B_1r.woff2';
  const relative = '/3240049/fonts/C_1r.woff';
  const resolved = ASSET_BASE + relative;
  const image = ASSET_BASE + '/3240049/1/img/1.png';
  const css = '@font-face{src:url("' + first + '")}'
    + '.x{background:url("' + image + '")}'
    + '@font-face{src:url("' + second + '")}'
    + '@font-face{src:url("' + relative + '")}';

  DD.fetchDataUrl = async (url) => {
    if (url === first) return 'data:font/woff;base64,AAAA';
    if (url === resolved) return 'data:font/woff;base64,BBBB';
    return null;
  };

  const out = await provider.inlineFonts(css);

  assert.ok(out.includes('url("data:font/woff;base64,AAAA")'), 'fetched font is inlined');
  assert.ok(!out.includes(first), 'the original font URL is replaced');
  assert.ok(out.includes('url("data:font/woff;base64,BBBB")'),
    'a root-relative font is fetched by its absolute key and inlined');
  assert.ok(!out.includes(relative), 'the root-relative font URL is replaced');
  assert.ok(out.includes('url("' + second + '")'), 'a failed font keeps its URL');
  assert.ok(out.includes('url("' + image + '")'), 'non-font URLs are untouched');
});

test('pageHtml wraps fetched pages and renders a note when a page is missing', () => {
  const { provider } = loadAcademia();

  const normal = provider.pageHtml(
    { page_number: 2, width: 850, height: 1100, page_url: ASSET_BASE + '/3240049/2.html' },
    { markup: '<div id="jpedal">page two</div>', width: 840, height: 1090 }
  );
  assert.match(normal, /class="pf docdown-academia-page"/);
  assert.match(normal, /width:840px;height:1090px/);
  assert.match(normal, /data-page-no="2"/);
  assert.ok(normal.includes('<div id="jpedal">page two</div>'));

  const missing = provider.pageHtml({ page_number: 3, width: 850, height: 1100 });
  assert.match(missing, /docdown-gated-page/);
  assert.match(missing, /Page 3 is unavailable/);
  assert.match(missing, /data-page-no="3"/,
    'a missing page keeps its page number so the stream count stays correct');
  assert.ok(!missing.includes('jpedal'), 'a missing page must not embed fetched markup');

  const preview = provider.pageHtml(
    { page_number: 3, width: 850, height: 1100 },
    { preview: 'PREVIEW' }
  );
  assert.match(preview, /docdown-gated-page/);
  assert.ok(!preview.includes('PREVIEW'), 'a missing page must not embed a preview');
});

test('preparePage sanitises markup, styles and images and keeps the page size', () => {
  const root = buildPageFixture();
  const pageUrl = ASSET_BASE + '/3240049/1.html';
  const { provider } = loadAcademia({
    DOMParser: class {
      parseFromString() { return makeDocument(root); }
    }
  });

  const parts = provider.preparePage('<html>ignored by the stub</html>', pageUrl);
  assert.ok(parts, 'preparePage must find #jpedal');

  assert.equal(parts.width, 909);
  assert.equal(parts.height, 1286, 'line-height must not be read as the page height');
  assert.match(parts.css, /@font-face/);

  const markup = parts.markup;
  assert.ok(!/<style/i.test(markup), 'style tags must move into the shared CSS');
  assert.ok(!/<script/i.test(markup), 'scripts must be removed');
  assert.ok(!/<iframe/i.test(markup), 'iframes must be removed');
  assert.ok(!/<object/i.test(markup), 'objects must be removed');
  assert.ok(!/onclick/i.test(markup), 'event handler attributes must be removed');
  assert.ok(!/srcdoc/i.test(markup), 'srcdoc attributes must be removed');

  assert.ok(markup.includes('src="' + ASSET_BASE + '/3240049/1/img/1.jpg"'),
    'the first image src is absolutised');
  assert.ok(/<img\b[^>]*loading="eager"/.test(markup));
  assert.ok(/<img\b[^>]*decoding="sync"/.test(markup));
  assert.ok(!/srcset|data-src/i.test(markup), 'srcset/data-src must be removed');
  assert.equal((markup.match(/<img\b/g) || []).length, 1,
    'only the allowlisted image remains');
  assert.equal(markup.includes('%2e'), false, 'traversal images must be removed');
  assert.equal(markup.includes('evil.test'), false,
    'evil images, SVG urls and styles must be removed');

  assert.ok(!/href="javascript/i.test(markup), 'javascript links lose their href');
  assert.ok(markup.includes('href="https://www.academia.edu/x"'),
    'a normal link keeps its href');
  assert.ok(!/xlink:href/i.test(markup), 'xlink:href must be removed');
  assert.ok(!/<image\b[^>]*\bhref=/i.test(markup), 'SVG image href must be removed');

  assert.ok(!markup.includes('background:url(/3240049/1/img/1.png)'),
    'root-relative inline style urls are absolutised');
  assert.ok(markup.includes(ASSET_BASE + '/3240049/1/img/1.png'));
  assert.ok(markup.includes('left:10px'), 'safe inline style declarations are kept');
  assert.ok(markup.includes('background:none'), 'a disallowed inline style url becomes none');

  const empty = loadAcademia({
    DOMParser: class {
      parseFromString() { return makeDocument(null); }
    }
  });
  assert.equal(empty.provider.preparePage('<html></html>', pageUrl), null,
    'preparePage must refuse a page without #jpedal');
});

test('buildCss emits base rules once and strips unsafe CSS', () => {
  const { provider } = loadAcademia();
  const pageCss = '.text_layer{position:absolute}';
  const css = provider.buildCss([
    pageCss,
    pageCss,
    '@import url("https://evil.test/x.css");a{background:url(javascript:alert(1))}'
  ]);

  assert.match(css, /@page\{size:auto;margin:0\}/);
  assert.match(css, /\.docdown-academia-page\{position:relative/);
  assert.match(css, /\.text_layer\{position:absolute\}/);
  assert.equal(
    css.split('.text_layer{position:absolute}').length - 1,
    1,
    'identical repeated CSS blocks must print once'
  );
  assert.ok(!css.includes('@import'), 'imports must be stripped');
  assert.ok(!/javascript\s*:/i.test(css), 'javascript URLs must be stripped');
});

test('buildCss with a shared Set prints base rules and repeated page rules once', () => {
  const { provider } = loadAcademia();
  const seen = new Set();
  const pageCss = '.text_layer{position:absolute}';

  const first = provider.buildCss(pageCss, seen);
  assert.match(first, /@page\{size:auto;margin:0\}/);
  assert.match(first, /\.docdown-academia-page\{position:relative/);
  assert.match(first, /\.text_layer\{position:absolute\}/);
  assert.equal(seen.has('@page{size:auto;margin:0}'), true);
  assert.equal(seen.has('.docdown-academia-page{position:relative;overflow:hidden;background:#fff}'), true);
  assert.equal(seen.has('.text_layer{position:absolute}'), true);

  assert.equal(provider.buildCss(pageCss, seen), '',
    'a repeated batch contributes no duplicate CSS');

  const fresh = provider.buildCss(pageCss + '\n.text_layer{font-size:12px}', seen);
  assert.match(fresh, /\.text_layer\{font-size:12px\}/);
  assert.equal(fresh.includes('.text_layer{position:absolute}'), false,
    'already printed page rules are not repeated');
  assert.equal(fresh.includes('@page'), false,
    'base rules are not repeated in later batches');

  // Callers without a Set keep the old full-stylesheet behaviour.
  const full = provider.buildCss(pageCss);
  assert.match(full, /@page\{size:auto;margin:0\}/);
  assert.match(full, /\.text_layer\{position:absolute\}/);
});

test('fetchPageDefs requests the same-origin viewer endpoint', async () => {
  const calls = [];
  const { provider } = loadAcademia({
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => [pageDef(1), pageDef(2)] };
    }
  });

  const meta = await provider.fetchPageDefs(42289459);

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    '/v0/document_viewer/build_vu_page_defs/42289459?subdomain_param=api'
  );
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(meta.pages.length, 2);
  assert.equal(meta.totalPages, 2);
});

test('fetchPageDefs rejects HTTP errors, invalid ids and malformed payloads', async () => {
  let calls = 0;
  const failing = loadAcademia({
    fetch: async () => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    }
  });

  await assert.rejects(() => failing.provider.fetchPageDefs(42289459), /503/);
  assert.equal(calls, 1);

  calls = 0;
  const invalidId = loadAcademia({
    fetch: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => [] };
    }
  });
  await assert.rejects(() => invalidId.provider.fetchPageDefs(0), /hợp lệ/);
  await assert.rejects(() => invalidId.provider.fetchPageDefs('abc'), /hợp lệ/);
  assert.equal(calls, 0, 'an invalid id must never hit the network');

  const malformed = loadAcademia({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) })
  });
  await assert.rejects(() => malformed.provider.fetchPageDefs(42289459), /không gửi trang nào/);
});

// ---------------------------------------------------------------------------
// Streaming / multi-part planning (STREAM, planCapacity, planBatch, adjust)
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = 1024 * 1024;

const EXPECTED_STREAM = {
  PROBE_PAGES: 16,
  BATCH_PAGES: 24,
  BATCH_MAX_BYTES: 6 * MB,
  PART_MAX_PAGES: 256,
  PART_MIN_PAGES: 32,
  PART_BUDGET_BYTES: 192 * MB,
  DOM_FACTOR: 6,
  NODE_BUDGET: 500000,
  HEAP_BUDGET_BYTES: 256 * MB,
  HEAP_SCALE: 2,
  STATIC_CAPACITY: 150,
  MAX_DOCUMENT_PAGES: 2000
};

function textProbe(pages) {
  return {
    pages: pages,
    markupBytes: 60 * KB * pages,
    cssBytes: 35 * KB * pages,
    imageBytes: 0,
    nodes: 1500 * pages
  };
}

// Mirrors the part loop in providers/academia.js:startPart, but only the parts
// that matter for partitioning: the first part owns the 16-page probe and then
// keeps appending until the capacity is full. It is a test-only derivation; the
// provider itself is not modified.
function simulateParts(provider, totalPages, capacity, avgMarkupBytes) {
  const parts = [];
  let nextPage = 1;
  let partIndex = 0;

  while (nextPage <= totalPages) {
    partIndex += 1;
    const fromPage = nextPage;
    let pagesInPart = 0;
    let lastAppended = fromPage - 1;

    if (partIndex === 1) {
      const probeCount = Math.min(
        provider.STREAM.PROBE_PAGES,
        totalPages - fromPage + 1,
        capacity
      );
      pagesInPart = probeCount;
      lastAppended = fromPage + probeCount - 1;
    }

    while (pagesInPart < capacity && lastAppended < totalPages) {
      const pagesLeft = totalPages - lastAppended;
      const remainingInPart = capacity - pagesInPart;
      const batchSize = provider.planBatch(remainingInPart, avgMarkupBytes, pagesLeft);
      lastAppended += batchSize;
      pagesInPart += batchSize;
    }

    parts.push({
      partIndex: partIndex,
      fromPage: fromPage,
      toPage: lastAppended,
      pages: pagesInPart
    });
    nextPage = lastAppended + 1;
  }

  return parts;
}

test('STREAM exposes the exact streaming budgets', () => {
  const { provider } = loadAcademia();
  assert.deepEqual({ ...provider.STREAM }, EXPECTED_STREAM);
});

test('planCapacity bounds a typical text probe by byte, node and heap caps', () => {
  const { provider } = loadAcademia();
  const pages = provider.STREAM.PROBE_PAGES;
  const baseline = 100 * MB;
  const heapLimit = 4 * 1024 * MB;
  const probe = { ...textProbe(pages), heap: baseline };

  // Low heap growth leaves the byte and node caps in control, so the part
  // reaches the 256-page clamp.
  assert.equal(
    provider.planCapacity({ heap: baseline + 5 * MB, heapLimit: heapLimit }, probe),
    provider.STREAM.PART_MAX_PAGES
  );

  // High heap growth is deliberately conservative: 50 MB over 16 pages means
  // heapCap = floor(256 MB / (2 * 50 MB / 16)) = 40. This is the RAM guard
  // doing its job, not a page-count bug.
  const capacity = provider.planCapacity(
    { heap: baseline + 50 * MB, heapLimit: heapLimit },
    probe
  );
  assert.equal(capacity, 40);
  assert.ok(capacity >= provider.STREAM.PART_MIN_PAGES);

  // Without a heap sample the byte and node caps also allow all 256 pages.
  assert.equal(provider.planCapacity({}, probe), provider.STREAM.PART_MAX_PAGES);
});

test('planCapacity ignores a negative heap delta after a GC', () => {
  const { provider } = loadAcademia();
  const pages = provider.STREAM.PROBE_PAGES;
  const probe = { ...textProbe(pages), heap: 200 * MB };
  const measure = { heap: 150 * MB, heapLimit: 4 * 1024 * MB };

  const capacity = provider.planCapacity(measure, probe);

  assert.ok(capacity > provider.STREAM.PART_MIN_PAGES,
    'a negative heap delta must not force the part to the minimum');
  assert.equal(capacity, provider.STREAM.PART_MAX_PAGES,
    'the byte and node caps still allow the normal 256-page part');

  const images = provider.planCapacity(measure, {
    ...textProbe(pages),
    heap: 200 * MB,
    imageBytes: 8 * MB * pages
  });
  assert.equal(images, provider.STREAM.PART_MIN_PAGES,
    'a negative heap delta falls back to the image byte cap');
});

test('planCapacity shrinks byte-heavy and node-heavy documents', () => {
  const { provider } = loadAcademia();
  const pages = provider.STREAM.PROBE_PAGES;

  const images = provider.planCapacity({}, {
    pages: pages,
    markupBytes: 60 * KB * pages,
    cssBytes: 35 * KB * pages,
    imageBytes: 8 * MB * pages,
    nodes: 1500 * pages
  });
  assert.equal(images, provider.STREAM.PART_MIN_PAGES,
    '8 MB of images per page must fall to the minimum part size');
  assert.ok(images <= 40);

  const nodes = provider.planCapacity({}, {
    pages: pages,
    markupBytes: 60 * KB * pages,
    cssBytes: 35 * KB * pages,
    imageBytes: 0,
    nodes: 50000 * pages
  });
  assert.equal(nodes, provider.STREAM.PART_MIN_PAGES,
    '50k nodes per page must fall to the minimum part size');
  assert.ok(nodes <= 64);
});

test('planCapacity falls back to STATIC_CAPACITY when it has no metrics', () => {
  const { provider } = loadAcademia();

  assert.equal(provider.planCapacity({}, { pages: 16 }), provider.STREAM.STATIC_CAPACITY);
  assert.equal(provider.planCapacity(null, null), provider.STREAM.STATIC_CAPACITY);
  assert.equal(provider.planCapacity({}, {}), provider.STREAM.STATIC_CAPACITY);
  assert.equal(provider.planCapacity({}, { pages: 0, markupBytes: 1 }),
    provider.STREAM.STATIC_CAPACITY);
});

test('planCapacity always clamps to PART_MIN_PAGES..PART_MAX_PAGES', () => {
  const { provider } = loadAcademia();
  const min = provider.STREAM.PART_MIN_PAGES;
  const max = provider.STREAM.PART_MAX_PAGES;
  const pages = provider.STREAM.PROBE_PAGES;

  const probes = [
    { pages: pages, markupBytes: 0, cssBytes: 0, imageBytes: 0, nodes: 0 },
    { pages: pages, markupBytes: 1e15, cssBytes: 0, imageBytes: 0, nodes: 0 },
    { pages: pages, markupBytes: 0, cssBytes: 1e15, imageBytes: 0, nodes: 0 },
    { pages: pages, markupBytes: 0, cssBytes: 0, imageBytes: 1e15, nodes: 0 },
    { pages: pages, markupBytes: 0, cssBytes: 0, imageBytes: 0, nodes: 1e15 },
    { pages: pages, markupBytes: -1, cssBytes: -1, imageBytes: -1, nodes: -1 },
    { pages: 1, markupBytes: 1, cssBytes: 1, imageBytes: 1, nodes: 1 }
  ];
  const measures = [
    {},
    { heap: 0, heapLimit: 0 },
    { heap: 0, heapLimit: 100 },
    { heap: 150 * MB, heapLimit: 4 * 1024 * MB }
  ];

  probes.forEach((probe) => {
    measures.forEach((measure) => {
      const capacity = provider.planCapacity(measure, { ...probe, heap: 100 * MB });
      assert.ok(Number.isInteger(capacity), 'capacity must be an integer: ' + capacity);
      assert.ok(capacity >= min && capacity <= max,
        'capacity ' + capacity + ' escaped ' + min + '..' + max);
    });
  });
});

test('planBatch respects the default, byte, remaining and pages-left limits', () => {
  const { provider } = loadAcademia();

  assert.equal(provider.planBatch(100, 60 * KB, 100), provider.STREAM.BATCH_PAGES);
  assert.equal(provider.planBatch(24, 60 * KB, 510), 24);
  assert.equal(provider.planBatch(100, 1 * MB, 100), 6,
    'a 6 MB batch holds six 1 MB pages');
  assert.equal(provider.planBatch(10, 60 * KB, 100), 10, 'remaining room wins');
  assert.equal(provider.planBatch(100, 60 * KB, 7), 7, 'pages left wins');
  assert.equal(provider.planBatch(100, 0, 100), provider.STREAM.BATCH_PAGES);

  for (const args of [
    [0, 60 * KB, 100],
    [100, 1e15, 100],
    [100, 60 * KB, 0],
    [NaN, 60 * KB, 100],
    [100, 60 * KB, NaN]
  ]) {
    assert.equal(provider.planBatch(...args), 1, JSON.stringify(args));
  }
  assert.ok(provider.planBatch(100, NaN, 100) >= 1,
    'a non-finite average must still return at least one page');
});

test('adjustCapacity shrinks under pressure, grows with headroom and keeps normal values', () => {
  const { provider } = loadAcademia();

  assert.equal(provider.adjustCapacity(256, { heap: 66, heapLimit: 100 }), 192);
  assert.equal(provider.adjustCapacity(256, { heap: 34, heapLimit: 100 }), 256,
    'growth is capped at PART_MAX_PAGES');
  assert.equal(provider.adjustCapacity(100, { heap: 50, heapLimit: 100 }), 100);
  assert.equal(provider.adjustCapacity(32, { heap: 99, heapLimit: 100 }), 32,
    'shrink never goes below PART_MIN_PAGES');
  assert.equal(provider.adjustCapacity(256, null), 256);
  assert.equal(provider.adjustCapacity(256, { heap: NaN, heapLimit: 100 }), 256);
});

test('510 pages split into 256 + 254 and the 16-page probe joins the first part', () => {
  const { provider } = loadAcademia();
  const totalPages = 510;

  const capacity = provider.planCapacity({}, textProbe(provider.STREAM.PROBE_PAGES));
  assert.equal(capacity, provider.STREAM.PART_MAX_PAGES);

  const parts = simulateParts(provider, totalPages, capacity, 60 * KB);

  assert.equal(parts.length, 2);
  assert.deepEqual(
    parts.map((part) => [part.fromPage, part.toPage, part.pages]),
    [[1, 256, 256], [257, 510, 254]]
  );
  assert.equal(parts[0].pages, 256, 'the first part is full, not just the probe');
  assert.notEqual(parts[0].pages, provider.STREAM.PROBE_PAGES,
    'the probe must not be finalized as its own part');
  assert.equal(parts.some((part) => part.toPage === provider.STREAM.PROBE_PAGES), false);
  assert.equal(parts[0].fromPage, 1);
  assert.equal(parts[0].toPage, 256);
});

test('resuming a failed part keeps its part index instead of skipping it', async () => {
  const pages = Array.from({ length: 50 }, (_, index) => pageDef(index + 1));
  const { DD, provider } = loadAcademia({
    attachment: 'Attachment_123',
    title: 'Resume test',
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => pages
    }),
    DOMParser: class {
      parseFromString() {
        const root = makeNode('div', {
          id: 'jpedal',
          style: 'width:850px;height:1100px'
        });
        root.text = 'page';
        return makeDocument(root);
      }
    }
  });

  DD.fetchText = async () => '<html></html>';
  DD.buildPrintHtml = () => '<!doctype html><html><body></body></html>';

  const beginCalls = [];
  let handlers = null;
  let failFirstPartTwo = true;
  const win = { closed: false, postMessage() {} };
  const stream = {
    async waitForReady() { return true; },
    async begin(payload) {
      beginCalls.push(payload.part.index);
      if (payload.part.index === 2 && failFirstPartTwo) {
        failFirstPartTwo = false;
        throw new Error('part 2 failed');
      }
      return {
        type: 'docdown-print-begun',
        partIndex: payload.part.index,
        baseline: {
          heap: 100 * MB,
          heapLimit: 4 * 1024 * MB,
          nodes: 100,
          imageBytes: 0
        }
      };
    },
    async append(payload) {
      const count = payload.toPage - payload.fromPage + 1;
      return {
        type: 'docdown-print-appended',
        fromPage: payload.fromPage,
        toPage: payload.toPage,
        pages: count,
        heap: 100 * MB,
        heapLimit: 4 * 1024 * MB,
        nodes: 100 + count * 1500,
        imageBytes: count * 8 * MB,
        markupBytes: count * 60 * KB
      };
    },
    async finalize() {
      return { type: 'docdown-print-finalized' };
    },
    close() {}
  };

  DD.ui = {
    openPrintWindow: () => win,
    createPrintStream: (target, callbacks) => {
      handlers = callbacks;
      return stream;
    },
    setState() {},
    progress() {},
    progressText() {},
    toast() {},
    showPrintError() {},
    cleanup() {},
    mount() {}
  };

  await provider.run();

  assert.deepEqual(beginCalls, [1], 'the first run opens part 1');
  assert.ok(handlers && typeof handlers.onNext === 'function');

  handlers.onNext();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(beginCalls, [1, 2],
    'the next-part action opens part 2 and fails');

  await provider.run();

  assert.deepEqual(beginCalls, [1, 2, 2],
    'resuming retries part 2 instead of skipping to part 3');
});

test('preparePage reports positive markup, CSS, node and image metrics', () => {
  const root = buildPageFixture();
  const pageUrl = ASSET_BASE + '/3240049/1.html';
  const { provider } = loadAcademia({
    DOMParser: class {
      parseFromString() { return makeDocument(root); }
    }
  });

  const parts = provider.preparePage('<html>ignored by the stub</html>', pageUrl);
  assert.ok(parts, 'preparePage must find #jpedal');

  assert.equal(parts.width, 909);
  assert.equal(parts.height, 1286);
  assert.equal(parts.markupBytes, parts.markup.length);
  assert.equal(parts.cssBytes, parts.css.length);
  assert.ok(parts.markupBytes > 0, 'markupBytes must be positive');
  assert.ok(parts.cssBytes > 0, 'cssBytes must be positive');
  assert.equal(parts.imageCount, 1, 'only the allowlisted image is counted');
  assert.equal(parts.nodeCount, 8,
    'root + surviving img, links, svg image and divs');
  assert.ok(parts.nodeCount > parts.imageCount);
});
