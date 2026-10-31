(function () {
  'use strict';

  const DD = globalThis.DocDown;
  if (!DD) return;

  const providers = [];
  DD.providers = providers;

  DD.registerProvider = function (provider) {
    if (!provider || typeof provider !== 'object') return false;
    if (typeof provider.id !== 'string' || !provider.id) return false;
    if (!Array.isArray(provider.domains) || !provider.domains.length) return false;
    if (providers.some(function (item) { return item.id === provider.id; })) return false;
    providers.push(provider);
    return true;
  };

  DD.providerById = function (id) {
    return providers.filter(function (item) { return item.id === id; })[0] || null;
  };

  // Returns the provider whose domain is the longest match for the hostname.
  // A provider domain matches the apex domain and every subdomain of it.
  DD.getProvider = function (hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host) return null;
    let match = null;
    providers.forEach(function (provider) {
      provider.domains.forEach(function (domain) {
        const name = String(domain || '').toLowerCase();
        if (!name) return;
        const isApex = host === name;
        const isSub = host.slice(-(name.length + 1)) === '.' + name;
        if (!isApex && !isSub) return;
        if (!match || name.length > match.domain.length) match = { provider: provider, domain: name };
      });
    });
    return match ? match.provider : null;
  };

  DD.isSupportedHost = function (hostname) {
    const host = hostname === undefined
      ? String((globalThis.location && globalThis.location.hostname) || '')
      : String(hostname || '');
    return !!DD.getProvider(host);
  };

  DD.parentDomains = function (hostname) {
    const provider = DD.getProvider(hostname);
    if (!provider) return [];
    return provider.domains.map(function (domain) { return '.' + String(domain).toLowerCase(); });
  };

  DD.assetOrigins = function () {
    const origins = [];
    providers.forEach(function (provider) {
      (provider.assetHosts || []).forEach(function (host) {
        const origin = 'https://' + String(host).toLowerCase();
        if (origins.indexOf(origin) === -1) origins.push(origin);
      });
    });
    return origins;
  };

  DD.assetAllowed = function (url) {
    if (!url) return false;
    return providers.some(function (provider) {
      return typeof provider.isAllowedAssetUrl === 'function' && provider.isAllowedAssetUrl(url);
    });
  };

  // The print preview runs on a chrome-extension:// page, so it only accepts
  // documents posted by tabs of a supported site.
  DD.isAllowedPrintOrigin = function (origin) {
    try {
      const parsed = new URL(String(origin || ''));
      if (parsed.protocol !== 'https:') return false;
      return DD.isSupportedHost(parsed.hostname);
    } catch (error) {
      return false;
    }
  };
})();
