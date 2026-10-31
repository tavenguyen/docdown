(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  DD.stripBlurClasses = function (el) {
    if (!el || !el.classList) return;
    Array.prototype.slice.call(el.classList).forEach(function (name) {
      if (/blur/i.test(name)) el.classList.remove(name);
    });
  };

  // Removes inline blur/opacity/mask overrides. `makeVisible` is false for
  // pdf2htmlEX text lines: their .ff0/.ff1 classes must keep controlling
  // visibility, otherwise hidden fallback text could be painted twice.
  DD.clearBlurStyles = function (el, makeVisible) {
    if (!el || !el.style) return;
    const props = [
      'filter', '-webkit-filter', 'opacity',
      'clip-path', '-webkit-clip-path', 'mask-image', '-webkit-mask-image'
    ];
    if (makeVisible) props.push('visibility');
    props.forEach(function (prop) {
      el.style.removeProperty(prop);
    });
    el.style.setProperty('filter', 'none', 'important');
    el.style.setProperty('-webkit-filter', 'none', 'important');
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('clip-path', 'none', 'important');
    el.style.setProperty('-webkit-clip-path', 'none', 'important');
    el.style.setProperty('mask-image', 'none', 'important');
    el.style.setProperty('-webkit-mask-image', 'none', 'important');
    if (makeVisible) el.style.setProperty('visibility', 'visible', 'important');
  };

  DD.stripPageBlur = function (root, makeRootVisible) {
    if (!root) return;
    const targets = [root];
    if (root.querySelectorAll) {
      Array.prototype.push.apply(
        targets,
        Array.prototype.slice.call(root.querySelectorAll('.pf, .pc, .page-content, .t, img'))
      );
    }
    targets.forEach(function (el) {
      DD.stripBlurClasses(el);
      const isTextLine = !!(el.classList && el.classList.contains('t'));
      DD.clearBlurStyles(el, el === root ? !!makeRootVisible : !isTextLine);
    });
  };

  // Sanitises a pdf2htmlEX page fragment and rewrites its images to safe URLs.
  DD.preparePageFragment = function (html, options) {
    const opts = options || {};
    if (!html) return '';
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    const body = doc.body;

    body.querySelectorAll(
      'script, iframe, object, embed, link, style, base, meta, form, input, button, textarea, select, video, audio, source, track, canvas, foreignObject'
    ).forEach(function (el) { el.remove(); });

    body.querySelectorAll('*').forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        const name = attr.name.toLowerCase();
        const value = String(attr.value || '');
        if (name.indexOf('on') === 0 || name === 'srcdoc' || name === 'formaction') {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'srcset') {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'style' && /javascript\s*:|expression\s*\(/i.test(value)) {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'href' || name === 'src' || name === 'xlink:href') {
          if (/^\s*(javascript|vbscript|data:text\/html)/i.test(value)) {
            el.removeAttribute(attr.name);
          }
        }
      });
    });

    body.querySelectorAll('img').forEach(function (img) {
      const src = String(img.getAttribute('src') || '').trim();
      if (!src) {
        img.remove();
        return;
      }

      if (/^bg[0-9a-f]+\.png$/i.test(src)) {
        const replacement = opts.bgDataUrl || opts.bgUrl || '';
        if (replacement) {
          img.setAttribute('src', replacement);
        } else {
          img.remove();
          return;
        }
      } else if (/^data:image\//i.test(src)) {
        // Allowed; already embedded.
      } else if (/^https?:/i.test(src)) {
        if (!DD.assetAllowed(src)) {
          img.remove();
          return;
        }
        if (opts.assetParam && src.indexOf('?') === -1 &&
          src.indexOf('/doc-assets.studocu.com/') !== -1) {
          img.setAttribute('src', src + opts.assetParam);
        }
      } else if (/^(#|about:)/i.test(src)) {
        img.remove();
        return;
      } else {
        try {
          let absolute = new URL(src, opts.baseUrl || 'https://localhost/').href;
          if (!DD.assetAllowed(absolute)) {
            img.remove();
            return;
          }
          if (opts.assetParam && absolute.indexOf('?') === -1) absolute += opts.assetParam;
          img.setAttribute('src', absolute);
        } catch (error) {
          img.remove();
          return;
        }
      }

      img.removeAttribute('srcset');
      img.removeAttribute('data-src');
      img.setAttribute('loading', 'eager');
      img.setAttribute('decoding', 'sync');
      img.style.filter = 'none';
      img.style.opacity = '1';
      img.style.visibility = 'visible';
    });

    body.querySelectorAll('a[href]').forEach(function (link) {
      const href = String(link.getAttribute('href') || '').trim();
      if (!/^https?:/i.test(href)) link.removeAttribute('href');
    });

    DD.stripPageBlur(body, false);
    return body.innerHTML;
  };
})();
