(function () {
  'use strict';

  const SH = globalThis.DocDown;
  if (!SH) return;

  const pages = {};
  SH.pages = pages;

  const BANNER_SELECTORS = [
    '.banner-wrapper',
    '[class*="InlineBanner_inline-banner"]',
    '[class*="PremiumBanner"]',
    '[class*="premium-banner"]',
    '[class*="premiumBanner"]',
    '[class*="PremiumPageClarificationBanner"]',
    '[class*="PremiumBannerHeader"]',
    '[class*="PremiumBannerBenefitsList"]',
    '[class*="PremiumBannerButtons"]',
    '[data-test-selector*="preview-banner"]',
    '[data-test-selector="modal-document-viewer-preview-message"]',
    '[class*="PremiumBadge"]',
    '[class*="premium-badge"]',
    '[class*="premiumBadge"]',
    '[class*="premiumTag"]',
    '[class*="premium-tag"]'
  ];

  function shouldRemove(el) {
    if (!el || !el.parentNode) return false;
    if (el.closest('#page-container')) return false;
    if (el.querySelector && el.querySelector('#page-container, .pf')) return false;
    return true;
  }

  pages.removeBanners = function () {
    BANNER_SELECTORS.forEach(function (selector) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch (error) {
        return;
      }
      Array.prototype.forEach.call(nodes, function (el) {
        if (shouldRemove(el)) el.remove();
      });
    });

    const recommendations = document.getElementById('viewer-recommendations');
    if (recommendations) recommendations.remove();

    Array.prototype.forEach.call(
      document.querySelectorAll('#modal-overlay, [class*="PremiumOverlay"], [class*="premium-overlay"]'),
      function (el) {
        if (el.closest('#page-container')) return;
        const text = (el.textContent || '').toLowerCase();
        const className = typeof el.className === 'string' ? el.className : '';
        if (text.indexOf('premium') !== -1 || text.indexOf('upgrade') !== -1 ||
          /premium/i.test(className)) {
          el.style.setProperty('display', 'none', 'important');
        }
      }
    );
  };

  function applyNoFilter(el) {
    if (!el || !el.style) return;
    SH.stripBlurClasses(el);
    let computed;
    try {
      computed = getComputedStyle(el);
    } catch (error) {
      computed = null;
    }
    if (computed && computed.filter && computed.filter !== 'none') {
      el.style.setProperty('filter', 'none', 'important');
      el.style.setProperty('-webkit-filter', 'none', 'important');
    }
    if (computed && computed.opacity && computed.opacity !== '1') {
      el.style.setProperty('opacity', '1', 'important');
    }
    if (computed && computed.visibility && computed.visibility !== 'visible') {
      el.style.setProperty('visibility', 'visible', 'important');
    }
    if (computed && computed.clipPath && computed.clipPath !== 'none') {
      el.style.setProperty('clip-path', 'none', 'important');
    }
    if (computed && computed.maskImage && computed.maskImage !== 'none') {
      el.style.setProperty('mask-image', 'none', 'important');
      el.style.setProperty('-webkit-mask-image', 'none', 'important');
    }
    el.style.setProperty('pointer-events', 'auto', 'important');
    el.style.setProperty('user-select', 'auto', 'important');
    el.classList.add('docdown-nofilter');
  }

  function deblurUrl(url) {
    if (!url || url.indexOf('/blurred/') === -1) return null;
    return url.replace('/pages/blurred/', '/pages/').replace('/blurred/', '/');
  }

  function unblurImage(img) {
    if (!img) return;
    applyNoFilter(img);
    if (img.dataset.docdownUnblurred === '1') return;

    const src = img.getAttribute('src') || '';
    const dataSrc = img.getAttribute('data-src') || '';
    const srcset = img.getAttribute('srcset') || '';
    const clear = deblurUrl(src);

    if (clear && clear !== src) {
      img.dataset.docdownOriginal = src;
      img.dataset.docdownUnblurred = '1';
      img.removeAttribute('srcset');
      img.onerror = function () {
        img.onerror = null;
        if (img.dataset.docdownOriginal) img.src = img.dataset.docdownOriginal;
      };
      img.src = clear;
    } else if (dataSrc) {
      const clearData = deblurUrl(dataSrc);
      if (clearData && clearData !== dataSrc) {
        img.setAttribute('data-src', clearData);
        img.dataset.docdownUnblurred = '1';
      }
    }

    if (srcset && srcset.indexOf('/blurred/') !== -1) {
      img.setAttribute(
        'srcset',
        srcset.replace(/\/pages\/blurred\//g, '/pages/').replace(/\/blurred\//g, '/')
      );
      img.dataset.docdownUnblurred = '1';
    }
  }

  pages.removeBlur = function () {
    Array.prototype.forEach.call(
      document.querySelectorAll('#page-container .pf, .p2hv .pf, .page-content'),
      applyNoFilter
    );

    Array.prototype.forEach.call(
      document.querySelectorAll('#page-container img, .p2hv img'),
      unblurImage
    );

    Array.prototype.forEach.call(
      document.querySelectorAll('[class*="blur"], [class*="Blur"]'),
      function (el) {
        applyNoFilter(el);
      }
    );
  };

  pages.refresh = function () {
    if (!SH.isDocumentPage()) {
      if (SH.ui) SH.ui.cleanup();
      return;
    }
    pages.removeBanners();
    pages.removeBlur();
    if (SH.ui) SH.ui.mount();
  };

  const debouncedRefresh = SH.debounce(pages.refresh, 600);
  let bodyObserver = null;
  let observedViewer = null;

  function attachViewer() {
    const viewer = document.getElementById('viewer-wrapper') ||
      document.getElementById('page-container');
    if (!viewer || viewer === observedViewer) return;
    observedViewer = viewer;
    pages.refresh();
  }

  function isRelevantNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === 'viewer-wrapper' || node.id === 'page-container') return true;
    if (node.classList && (node.classList.contains('pf') || node.classList.contains('page-content'))) return true;
    return !!(node.querySelector && node.querySelector('#viewer-wrapper, #page-container, .pf, .page-content'));
  }

  function onMutations(mutations) {
    if (!SH.isDocumentPage()) {
      if (SH.ui) SH.ui.cleanup();
      return;
    }
    let relevant = false;
    for (let i = 0; i < mutations.length; i++) {
      const mutation = mutations[i];
      if (mutation.target && mutation.target.nodeType === 1) {
        if (mutation.target.id === 'viewer-wrapper' ||
          mutation.target.id === 'page-container' ||
          mutation.target.closest('#viewer-wrapper, #page-container')) {
          relevant = true;
          break;
        }
      }
      for (let j = 0; j < mutation.addedNodes.length; j++) {
        if (isRelevantNode(mutation.addedNodes[j])) {
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }
    if (!relevant) return;
    if (document.getElementById('viewer-wrapper') !== observedViewer) attachViewer();
    debouncedRefresh();
  }

  function onNavigation() {
    setTimeout(function () {
      if (!SH.isDocumentPage()) return;
      attachViewer();
      pages.refresh();
    }, 400);
  }

  function cleanup() {
    debouncedRefresh.cancel();
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
    window.removeEventListener('popstate', onNavigation);
  }

  pages.start = function () {
    if (!SH.isDocumentPage()) return;
    attachViewer();
    pages.refresh();

    if (!bodyObserver && document.body) {
      bodyObserver = new MutationObserver(onMutations);
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    window.addEventListener('popstate', onNavigation);
    window.addEventListener('pagehide', cleanup, { once: true });
  };
})();
