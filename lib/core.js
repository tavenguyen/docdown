(function () {
  'use strict';

  const DD = {};
  globalThis.DocDown = DD;

  DD.VERSION = (function () {
    try {
      return chrome.runtime.getManifest().version;
    } catch (error) {
      return '2.0.0';
    }
  })();

  DD.LOG_PREFIX = 'DocDown:';
  DD.log = function () {
    console.log.apply(console, [DD.LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
  };
  DD.warn = function () {
    console.warn.apply(console, [DD.LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
  };

  DD.MAX_PAGES = 300;
  DD.PAGE_CONCURRENCY = 2;
  DD.FETCH_TIMEOUT = 15000;
  DD.MAX_PDF_BYTES = 80 * 1024 * 1024;

  // Asset URLs are validated by the active provider. The registry replaces
  // this default with an allowlist check once providers are registered.
  DD.assetAllowed = function () {
    return false;
  };

  DD.escapeHtml = function (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  };
  DD.escapeAttr = DD.escapeHtml;

  DD.FILE_NAME_LIMIT = 120;
  // Chrome uses the print window's document.title as the default PDF file
  // name, so it must be a legal and reasonably short file name.
  DD.buildFileName = function (title, fallback) {
    let name = String(title === undefined || title === null ? '' : title);
    name = name.replace(/\s*[|\u2013\u2014-]\s*(?:studocu|studeersnel|tailieu(?:\.vn)?)\s*$/i, '');
    name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ');
    name = name.replace(/\s+/g, ' ').trim();
    name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (!name) name = String(fallback || 'document');

    const chars = Array.from(name);
    if (chars.length > DD.FILE_NAME_LIMIT) {
      name = chars.slice(0, DD.FILE_NAME_LIMIT).join('').trim();
    }
    return name;
  };

  // Defense in depth: the generated print document has no scripts, and the
  // extension page CSP blocks inline ones, but never write them at all.
  DD.stripScriptTags = function (html) {
    return String(html || '').replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  };

  DD.safeStyleText = function (css) {
    return String(css || '').replace(/<\/style/gi, '<\\/style');
  };

  DD.blobToDataUrl = function (blob) {
    return new Promise(function (resolve) {
      if (!blob || !blob.size) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = function () {
        resolve(typeof reader.result === 'string' ? reader.result : null);
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(blob);
    });
  };

  DD.fetchText = async function (url, timeoutMs) {
    if (!url || !DD.assetAllowed(url)) return null;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || DD.FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) return null;
      return await response.text();
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  DD.fetchDataUrl = async function (url, timeoutMs) {
    if (!url || !DD.assetAllowed(url)) return null;
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs || DD.FETCH_TIMEOUT);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) return null;
      return await DD.blobToDataUrl(await response.blob());
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  // Downloads a blob through a temporary anchor. The object URL is released
  // after the browser has had time to start the download.
  DD.saveBlob = function (blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName || 'document';
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  };

  // Best-effort page count from an uncompressed PDF table of contents. Returns
  // null when the page tree is only stored in compressed object streams.
  DD.countPdfPages = function (bytes) {
    try {
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const decoder = new TextDecoder('latin1');
      const chunk = 1 << 20;
      let text = '';
      for (let i = 0; i < view.length; i += chunk) {
        text += decoder.decode(view.subarray(i, Math.min(view.length, i + chunk)));
      }
      let max = 0;
      const pattern = /\/Count\s+(\d+)/g;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const value = Number(match[1]);
        if (value > max) max = value;
      }
      return max || null;
    } catch (error) {
      return null;
    }
  };

  DD.mapLimit = async function (items, limit, worker) {
    const list = Array.prototype.slice.call(items || []);
    const results = new Array(list.length);
    let next = 0;
    const count = Math.min(Math.max(1, Number(limit) || 1), list.length);
    const workers = [];
    for (let i = 0; i < count; i++) {
      workers.push((async function () {
        while (true) {
          const index = next++;
          if (index >= list.length) return;
          results[index] = await worker(list[index], index);
        }
      })());
    }
    await Promise.all(workers);
    return results;
  };

  DD.sleep = function (ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  };

  DD.debounce = function (fn, wait) {
    let timer = 0;
    function wrapped() {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        timer = 0;
        fn.apply(null, args);
      }, wait);
    }
    wrapped.cancel = function () {
      clearTimeout(timer);
      timer = 0;
    };
    return wrapped;
  };

  const COOKIE_EPOCH = 'Thu, 01 Jan 1970 00:00:00 GMT';

  // Best-effort reset of the current origin's client-side session state.
  // Cookies marked HttpOnly are invisible to document.cookie, so the server
  // session can survive; this clears the stale client state that usually
  // causes expired signed URLs.
  DD.resetSessionData = async function () {
    const summary = { supported: false, cookies: 0, storage: 0, caches: 0, idb: 0 };
    const hostname = (globalThis.location && globalThis.location.hostname) || '';
    if (!DD.isSupportedHost(hostname)) return summary;
    summary.supported = true;

    try {
      const cookie = (typeof document !== 'undefined' && document.cookie) || '';
      const names = [];
      cookie.split(';').forEach(function (part) {
        const name = part.split('=')[0].trim();
        if (name && names.indexOf(name) === -1) names.push(name);
      });
      const domains = [''].concat(DD.parentDomains(hostname));
      names.forEach(function (name) {
        domains.forEach(function (domain) {
          try {
            document.cookie = name + '=; expires=' + COOKIE_EPOCH + '; Max-Age=0; path=/' +
              (domain ? '; domain=' + domain : '');
            summary.cookies += 1;
          } catch (error) {
            // Ignore individual cookie failures and keep clearing the rest.
          }
        });
      });
    } catch (error) {
      // document.cookie can throw in restricted contexts.
    }

    ['localStorage', 'sessionStorage'].forEach(function (key) {
      try {
        const store = globalThis[key];
        if (store && typeof store.clear === 'function') {
          store.clear();
          summary.storage += 1;
        }
      } catch (error) {
        // Storage can be disabled (private mode, blocked third-party storage).
      }
    });

    try {
      const cacheStorage = globalThis.caches;
      if (cacheStorage && typeof cacheStorage.keys === 'function') {
        const keys = await cacheStorage.keys();
        for (let i = 0; i < keys.length; i++) {
          await cacheStorage.delete(keys[i]);
          summary.caches += 1;
        }
      }
    } catch (error) {
      // Cache Storage is optional.
    }

    try {
      const idb = globalThis.indexedDB;
      if (idb && typeof idb.databases === 'function') {
        const databases = (await idb.databases()) || [];
        await Promise.all(databases.map(function (info) {
          return new Promise(function (resolve) {
            if (!info || !info.name) { resolve(); return; }
            let request;
            try {
              request = idb.deleteDatabase(info.name);
            } catch (error) {
              resolve();
              return;
            }
            summary.idb += 1;
            request.onsuccess = resolve;
            request.onerror = resolve;
            request.onblocked = resolve;
          });
        }));
      }
    } catch (error) {
      // IndexedDB enumeration is Chrome 71+ and may be blocked.
    }

    return summary;
  };

  DD.RESET_MESSAGE = 'docdown-reset';

  function sendResetMessage(runtime, hostname) {
    return new Promise(function (resolve) {
      try {
        const pending = runtime.sendMessage(
          { type: DD.RESET_MESSAGE, hostname: hostname },
          function (response) {
            if (runtime.lastError) {
              resolve(null);
              return;
            }
            resolve(response || null);
          }
        );
        if (pending && typeof pending.then === 'function') {
          pending.then(function (response) {
            resolve(response || null);
          }, function () {
            resolve(null);
          });
        }
      } catch (error) {
        resolve(null);
      }
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(null); }, ms);
      promise.then(function (value) {
        clearTimeout(timer);
        resolve(value);
      }, function () {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  // Asks the service worker to wipe cookies (including HttpOnly) and browsing
  // data. Falls back to the in-page reset when the worker is unavailable.
  DD.requestFullReset = async function (timeoutMs) {
    const chromeApi = globalThis.chrome;
    const runtime = chromeApi && chromeApi.runtime;
    const hostname = (globalThis.location && globalThis.location.hostname) || '';

    if (runtime && runtime.id && typeof runtime.sendMessage === 'function') {
      const response = await withTimeout(
        sendResetMessage(runtime, hostname),
        Number(timeoutMs) || 8000
      );
      if (response && response.ok) {
        return {
          supported: true,
          full: true,
          cookies: Number(response.cookies) || 0,
          browsingData: !!response.browsingData,
          storage: 0,
          caches: 0,
          idb: 0
        };
      }
    }

    const local = await DD.resetSessionData();
    local.fallback = true;
    return local;
  };
})();
