(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const provider = DD.getProvider(location.hostname);
  if (!provider) return;

  function boot() {
    if (!provider.isDocumentPage()) return;
    if (typeof provider.start === 'function') provider.start();
    DD.ui.mount(provider);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.addEventListener('pagehide', function () {
    if (DD.ui) DD.ui.cleanup();
  }, { once: true });
})();
