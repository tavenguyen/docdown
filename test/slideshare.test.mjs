import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const APP_SOURCES = ['../lib/core.js', '../lib/registry.js', '../providers/slideshare.js']
  .map((path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

const TITLE = 'Thiết bị cô đặc dung dịch nước cam';
const LOCATION = 'thitbccdungdchnccammtnilmvicginoncngtunhontrungtmvinngsutnhpliu2000kgh-231025055945-067dd9ba';
const SLUG = 'Thi-t-b-co-d-c-dung-d-ch-n-c-cam-m-t-n-i-lam-vi-c-gian-do-n-co-ng-tu-n-hoan-trung-tam-v-i-nang-su-t-nh-p-li-u-2000kgh-docx';

function makeShow(overrides) {
  return {
    title: TITLE,
    totalSlides: 51,
    isViewable: true,
    isPrivate: false,
    slideDimensions: { width: 595, height: 842 },
    slides: {
      host: 'https://image.slidesharecdn.com',
      imageLocation: LOCATION,
      title: SLUG,
      imageSizes: [
        { quality: 85, width: 320 },
        { quality: 85, width: 638 },
        { quality: 75, width: 2048 }
      ]
    },
    ...(overrides || {})
  };
}

function payloadFor(show) {
  return JSON.stringify({ props: { pageProps: { slideshow: show } } });
}

function loadSlideshare(options) {
  const opts = options || {};
  const text = opts.payload === undefined ? payloadFor(makeShow(opts.show)) : opts.payload;
  const pathname = opts.pathname === undefined
    ? '/slideshow/thit-b-c-c-dung-dch-nc-cam-mt-ni-lm-vic-gin-on-c-ng-tun-hon-trung-tm-vi-nng-sut-nhp-liu-2000kghdocx/262700601'
    : opts.pathname;

  const documentStub = {
    title: TITLE,
    getElementById: (id) => (id === '__NEXT_DATA__' ? { textContent: text } : null),
    querySelector: () => null,
    querySelectorAll: () => []
  };

  const context = {
    console,
    document: documentStub,
    location: {
      pathname: pathname,
      href: 'https://www.slideshare.net' + pathname,
      hostname: 'www.slideshare.net'
    },
    chrome: { runtime: { getManifest: () => ({ version: '2.2.0' }) } },
    URL,
    AbortController,
    Image: class {},
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

test('slideshare provider is selected for the document host', () => {
  const DD = loadSlideshare();
  assert.equal(DD.getProvider('www.slideshare.net').id, 'slideshare');
  assert.equal(DD.getProvider('slideshare.net').id, 'slideshare');
  assert.equal(DD.getProvider('slideshare.net.evil.test'), null);
  assert.equal(DD.isAllowedPrintOrigin('https://www.slideshare.net'), true);
  assert.equal(DD.isAllowedPrintOrigin('https://html.scribdassets.com'), false);
});

test('normalizeShow reads title, count, dimensions and the largest image size', () => {
  const DD = loadSlideshare();
  const provider = DD.providerById('slideshare');
  const show = provider.normalizeShow(makeShow());

  assert.equal(show.title, TITLE);
  assert.equal(show.totalSlides, 51);
  assert.equal(show.width, 793, 'A4 width in CSS px');
  assert.equal(show.height, 1123, 'A4 height in CSS px');
  assert.equal(show.imageLocation, LOCATION);
  assert.equal(show.slug, SLUG);
  assert.deepEqual(show.size, { quality: 75, width: 2048 });
  assert.equal(provider.isAvailable(), true);
});

test('normalizeShow rejects private, unviewable and malformed slideshows', () => {
  const DD = loadSlideshare();
  const provider = DD.providerById('slideshare');

  assert.equal(provider.normalizeShow(makeShow({ isPrivate: true })), null);
  assert.equal(provider.normalizeShow(makeShow({ isViewable: false })), null);
  assert.equal(provider.normalizeShow(makeShow({ totalSlides: 0 })), null);
  assert.equal(provider.normalizeShow(makeShow({ slides: { ...makeShow().slides, host: 'https://evil.test' } })), null);
  assert.equal(provider.normalizeShow(makeShow({ slides: { ...makeShow().slides, imageLocation: '../etc' } })), null);
  assert.equal(provider.normalizeShow(makeShow({ slides: { ...makeShow().slides, title: 'a/b' } })), null);
  assert.equal(provider.normalizeShow(null), null);
});

test('buildSlideUrl points at the 2048 JPEG for any slide number', () => {
  const DD = loadSlideshare();
  const provider = DD.providerById('slideshare');
  const show = provider.normalizeShow(makeShow());

  assert.equal(
    provider.buildSlideUrl(show, 1),
    'https://image.slidesharecdn.com/' + LOCATION + '/75/' + SLUG + '-1-2048.jpg'
  );
  assert.equal(
    provider.buildSlideUrl(show, 51),
    'https://image.slidesharecdn.com/' + LOCATION + '/75/' + SLUG + '-51-2048.jpg'
  );
});

test('only SlideShare slide images on the CDN are allowed', () => {
  const DD = loadSlideshare();
  const provider = DD.providerById('slideshare');
  const good = 'https://image.slidesharecdn.com/' + LOCATION + '/75/' + SLUG + '-1-2048.jpg';

  assert.equal(provider.isAllowedAssetUrl(good), true);
  assert.equal(provider.isAllowedAssetUrl(good.replace('https://', 'http://')), false);
  assert.equal(provider.isAllowedAssetUrl(good.replace('image.slidesharecdn.com', 'image.slidesharecdn.com.evil.test')), false);
  assert.equal(provider.isAllowedAssetUrl('https://cdn.slidesharecdn.com/' + LOCATION + '/75/a-1-2048.jpg'), false);
  assert.equal(provider.isAllowedAssetUrl('https://image.slidesharecdn.com/' + LOCATION + '/75/../../evil.jpg'), false);
});

test('pageHtml renders one image per slide and a note page when the image fails', () => {
  const DD = loadSlideshare();
  const provider = DD.providerById('slideshare');
  const show = provider.normalizeShow(makeShow());
  const url = provider.buildSlideUrl(show, 2);

  const normal = provider.pageHtml(show, 2, url, true);
  assert.match(normal, /class="pf docdown-slide"/);
  assert.match(normal, /width:793px;height:1123px/);
  assert.ok(normal.includes('src="' + url + '"'));

  const failed = provider.pageHtml(show, 2, url, false);
  assert.match(failed, /docdown-gated-page/);
  assert.match(failed, /Slide 2 could not be loaded/);
  assert.ok(!failed.includes('src='), 'failed slide must not embed the image');
});

test('buildCss keeps slides fitted to their own page size', () => {
  const DD = loadSlideshare();
  const css = DD.providerById('slideshare').buildCss();
  assert.match(css, /\.docdown-slide img\{display:block/);
  assert.match(css, /object-fit:contain/);
});

test('isAvailable is false without a page payload or on another path', () => {
  const noPayload = loadSlideshare({ payload: '{}' });
  assert.equal(noPayload.providerById('slideshare').isAvailable(), false);

  const otherPath = loadSlideshare({ pathname: '/slideshow/embed_code/key/abc' });
  assert.equal(otherPath.providerById('slideshare').isDocumentPage(), false);
  assert.equal(loadSlideshare().providerById('slideshare').isDocumentPage(), true);
});
