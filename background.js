importScripts('lib/core.js', 'lib/registry.js', 'providers/studocu.js', 'providers/tailieu.js', 'providers/scribd.js');

const DD = globalThis.DocDown;
if (!DD) throw new Error('DocDown core did not load');

const RESET_MESSAGE = 'docdown-reset';
const SITE_DATA = {
  cache: true,
  cacheStorage: true,
  cookies: true,
  indexedDB: true,
  localStorage: true,
  serviceWorkers: true
};
// browsingData removes cookies per site (eTLD+1), so asset origins must never
// be part of a cookie wipe requested for the site that owns them.
const ASSET_DATA = {
  cache: true,
  cacheStorage: true,
  indexedDB: true,
  serviceWorkers: true
};

// chrome.cookies.remove needs an https URL matching the cookie's domain/path.
function cookieUrl(cookie) {
  const domain = String(cookie.domain || '').replace(/^\./, '');
  let path = String(cookie.path || '/');
  if (path.charAt(0) !== '/') path = '/' + path;
  return 'https://' + domain + path;
}

function buildSiteOrigins(hostname) {
  const origins = [];
  DD.parentDomains(hostname).forEach(function (domain) {
    const apex = domain.replace(/^\./, '');
    origins.push('https://' + apex);
    origins.push('https://www.' + apex);
  });
  origins.push('https://' + hostname);
  return origins.filter(function (value, index) {
    return origins.indexOf(value) === index;
  });
}

// Only touch the cookie store that belongs to the tab that asked, so a reset
// in a normal window cannot wipe an unrelated incognito profile.
async function getStores(sender) {
  let stores = [];
  try {
    stores = await chrome.cookies.getAllCookieStores();
  } catch (error) {
    stores = [];
  }
  if (!Array.isArray(stores) || !stores.length) stores = [{ id: '0' }];

  const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  if (tabId === null) return stores;

  const scoped = stores.filter(function (store) {
    return Array.isArray(store.tabIds) && store.tabIds.indexOf(tabId) !== -1;
  });
  return scoped.length ? scoped : stores;
}

async function removeCookies(domain, stores) {
  let removed = 0;
  for (let i = 0; i < stores.length; i++) {
    let cookies;
    try {
      cookies = await chrome.cookies.getAll({ domain: domain, storeId: stores[i].id });
    } catch (error) {
      continue;
    }
    if (!Array.isArray(cookies)) continue;

    for (let j = 0; j < cookies.length; j++) {
      const cookie = cookies[j];
      if (!cookie || !cookie.name) continue;
      const details = {
        url: cookieUrl(cookie),
        name: String(cookie.name),
        storeId: stores[i].id
      };
      if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
      try {
        await chrome.cookies.remove(details);
        removed += 1;
      } catch (error) {
        // Keep clearing the remaining cookies.
      }
    }
  }
  return removed;
}

async function clearBrowsingData(siteOrigins) {
  let cleared = true;
  try {
    await chrome.browsingData.remove({ origins: siteOrigins }, SITE_DATA);
  } catch (error) {
    // Retry with the first origin only; some Chrome builds reject the rest.
    cleared = false;
    try {
      await chrome.browsingData.remove({ origins: [siteOrigins[0]] }, SITE_DATA);
      cleared = true;
    } catch (retryError) {
      cleared = false;
    }
  }

  try {
    await chrome.browsingData.remove({ origins: DD.assetOrigins() }, ASSET_DATA);
  } catch (error) {
    // Asset cache is best effort and never blocks the cookie reset.
  }
  return cleared;
}

async function handleReset(message, sender) {
  if (!message || message.type !== RESET_MESSAGE) return null;
  if (!sender || (sender.id && sender.id !== chrome.runtime.id)) {
    return { ok: false, error: 'sender' };
  }

  const hostname = String(message.hostname || '').toLowerCase();
  if (!hostname || !DD.isSupportedHost(hostname)) return { ok: false, error: 'host' };

  const stores = await getStores(sender);
  const domains = DD.parentDomains(hostname).map(function (domain) {
    return domain.replace(/^\./, '');
  });

  let removed = 0;
  for (let i = 0; i < domains.length; i++) {
    removed += await removeCookies(domains[i], stores);
  }

  const browsingData = await clearBrowsingData(buildSiteOrigins(hostname));
  return { ok: true, cookies: removed, browsingData: browsingData };
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== RESET_MESSAGE) return false;
  handleReset(message, sender).then(function (result) {
    sendResponse(result || { ok: false, error: 'unknown' });
  }, function (error) {
    sendResponse({ ok: false, error: String((error && error.message) || error) });
  });
  return true;
});
