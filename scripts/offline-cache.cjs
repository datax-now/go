const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const pwa = require('./pwa.cjs');

function installOfflineCache(assets) {
  const original = maybeFromCache;
  const scope = new URL('./', self.location.href);
  const enabled = new URL(self.location.href).searchParams.get('enableCache') === 'true';
  const cacheName = 'datax-runtime-sha256-v2';
  const pending = new Map();
  const cacheWriteErrors = new Map();
  const entries = Object.entries(assets);
  let preparation = null;
  let recordingCacheWriteErrors = false;
  const ports = new Set();
  const keyFor = (relative, asset) => {
    const key = new URL(relative, scope);
    key.searchParams.set('sha256', asset.sha256);
    if (relative.startsWith('xeus/')) key.searchParams.set('verified', 'local');
    return key.href;
  };
  function relativeFor(request) {
    const url = new URL(request.url);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return null;
    let relative = url.pathname.slice(scope.pathname.length);
    try { relative = relative.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/'); }
    catch { return null; }
    if (assets[relative]) return relative;
    if (relative === 'extensions/%40jupyterlite/xeus-extension/static/meriyah.umd.min.js' &&
        assets['xeus/xeus-python-wasm-host/meriyah.umd.min.js']) {
      return 'xeus/xeus-python-wasm-host/meriyah.umd.min.js';
    }
    if (assets[relative + 'index.html']) return relative + 'index.html';
    if (assets[relative + '/index.html']) return relative + '/index.html';
    if (assets[relative + '.asm']) return relative + '.asm';
    if (relative.endsWith('.tar.gz') && assets[relative.slice(0, -7) + '.tar.bz2']) {
      return relative.slice(0, -7) + '.tar.bz2';
    }
    return null;
  }
  if (typeof shouldDrop === 'function') {
    const drop = shouldDrop;
    shouldDrop = function(request, url) {
      if (enabled && request.method === 'GET' && !request.headers.has('Range') && relativeFor(request)) return false;
      return drop(request, url);
    };
  }
  async function fromOfflineCache(event) {
    const request = event.request;
    const relative = relativeFor(request);
    if (!enabled || !relative || request.method !== 'GET' || request.headers.has('Range')) return original(event);
    const asset = assets[relative];
    const key = keyFor(relative, asset);
    // No client signal: concurrent requests share the download, and one client's abort must not cancel it.
    const canonical = new Request(new URL(asset.source || relative, scope).href, {
      method: request.method, headers: request.headers, credentials: request.credentials,
      mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
      redirect: request.redirect,
    });
    if (relative.startsWith('xeus/')) {
      return original({ request: canonical, waitUntil: task => event.waitUntil(task) });
    }
    let cache;
    try {
      cache = await caches.open(cacheName);
      const cached = await cache.match(key);
      if (cached) return cached;
    } catch {
      return original(event);
    }
    if (!pending.has(key)) {
      const download = (async () => {
        const integrity = 'sha256-' + btoa(String.fromCharCode(...asset.sha256.match(/../g).map(byte => parseInt(byte, 16))));
        const verified = new Request(canonical, { integrity, cache: 'no-cache' });
        let response = typeof self.dataxFetchOfflineAsset === 'function'
          ? await self.dataxFetchOfflineAsset(verified)
          : await original({ request: verified, waitUntil: task => event.waitUntil(task) });
        if (asset.source && relative.endsWith('.html') && response.ok) {
          const headers = new Headers(response.headers);
          headers.set('Content-Type', 'text/html; charset=utf-8');
          headers.delete('Content-Encoding');
          headers.delete('Content-Length');
          response = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        }
        if (response.ok && response.status !== 206) {
          try {
            await cache.put(key, response.clone());
            cacheWriteErrors.delete(key);
          } catch (error) {
            if (recordingCacheWriteErrors) cacheWriteErrors.set(key, error);
          }
        }
        return response;
      })();
      pending.set(key, download);
      event.waitUntil(download.then(() => {}, () => {}).finally(() => pending.delete(key)));
    }
    return (await pending.get(key)).clone();
  }
  maybeFromCache = fromOfflineCache;
  const totalBytes = entries.reduce((total, [, asset]) => total + asset.size, 0);
  // Marks that the user opted into offline use, so later releases are cached before they activate.
  const readyKey = new URL('datax-offline-ready', scope).href;
  let progress = null;
  async function cachedKeys(cache) {
    return new Set((await cache.keys()).map(request => request.url));
  }
  async function status() {
    const keys = await cachedKeys(await caches.open(cacheName));
    let completed = 0;
    let bytes = 0;
    for (const [relative, asset] of entries) {
      if (keys.has(keyFor(relative, asset))) { completed++; bytes += asset.size; }
    }
    return { type: 'datax-offline', completed, total: entries.length, bytes, totalBytes,
      ready: completed === entries.length, downloading: preparation !== null };
  }
  function download() {
    if (preparation) return preparation;
    cacheWriteErrors.clear();
    recordingCacheWriteErrors = true;
    preparation = (async () => {
      const cache = await caches.open(cacheName);
      const keys = await cachedKeys(cache);
      const queue = entries.filter(([relative, asset]) => !keys.has(keyFor(relative, asset)));
      const missingBytes = queue.reduce((total, [, asset]) => total + asset.size, 0);
      progress = { type: 'datax-offline', completed: entries.length - queue.length, total: entries.length,
        bytes: totalBytes - missingBytes, totalBytes, ready: false, downloading: true };
      const report = () => { for (const subscriber of ports) subscriber.postMessage(progress); };
      report();
      let failure = null;
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (queue.length && !failure) {
          const [relative, asset] = queue.shift();
          try {
            // Later PWA wrappers can return files from a separate cache, which does not count toward readiness.
            const response = await fromOfflineCache({
              request: new Request(new URL(relative, scope).href),
              waitUntil() {},
            });
            if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + relative);
            const key = keyFor(relative, asset);
            if (!await cache.match(key)) {
              const writeError = cacheWriteErrors.get(key);
              cacheWriteErrors.delete(key);
              if (writeError) {
                throw new Error('Unable to store ' + relative + ': ' + String(writeError));
              }
              throw new Error('Unable to store ' + relative + '. Check available browser storage.');
            }
            cacheWriteErrors.delete(key);
            progress = { ...progress, completed: progress.completed + 1, bytes: progress.bytes + asset.size };
            report();
          } catch (error) { failure = new Error(relative + ': ' + error.message); }
        }
      }));
      if (failure) throw failure;
      try { await cache.put(readyKey, new Response('')); } catch {}
    })().finally(() => {
      recordingCacheWriteErrors = false;
      cacheWriteErrors.clear();
      preparation = null;
      progress = null;
    });
    return preparation;
  }
  self.addEventListener('install', event => {
    if (!enabled) return;
    // A failed download rejects the update, so the previous offline-ready release stays active.
    event.waitUntil(caches.open(cacheName)
      .then(cache => cache.match(readyKey), () => null)
      .then(optedIn => optedIn ? download() : undefined));
  });
  self.addEventListener('activate', event => {
    if (!enabled) return;
    const current = new Set(entries.map(([relative, asset]) => keyFor(relative, asset)).concat(readyKey));
    event.waitUntil(caches.open(cacheName).then(async cache => {
      const stale = (await cache.keys()).filter(request => !current.has(request.url));
      await Promise.all(stale.map(request => cache.delete(request)));
    }).catch(() => {}));
  });
  self.addEventListener('message', event => {
    if (!['datax-offline-status', 'datax-offline-download'].includes(event.data?.type)) return;
    const source = event.source?.url && new URL(event.source.url);
    if (!source || source.origin !== scope.origin || !source.pathname.startsWith(scope.pathname)) return;
    const port = event.ports?.[0];
    if (!port) return;
    if (!enabled) {
      port.postMessage({ type: 'datax-offline', unavailable: true, error: 'Offline caching is disabled in the app configuration.' });
      return;
    }
    // Acknowledge before CacheStorage access, which can be slow while other workers are starting.
    port.postMessage(progress || { type: 'datax-offline', checking: true, completed: 0, total: entries.length,
      bytes: 0, totalBytes, ready: false, downloading: false });
    const task = (async () => {
      if (event.data.type === 'datax-offline-status') {
        port.postMessage(await status());
        return;
      }
      ports.add(port);
      try {
        await download();
        const update = { ...await status(), downloading: false };
        for (const subscriber of ports) subscriber.postMessage(update);
      } catch (error) {
        for (const subscriber of ports) subscriber.postMessage({ type: 'datax-offline', error: error.message, ready: false, downloading: false });
      } finally {
        ports.clear();
      }
    })().catch(error => port.postMessage({ type: 'datax-offline', error: error.message, ready: false, downloading: false }));
    event.waitUntil(task);
  });
}

// Upstream JupyterLite activates and claims every update immediately, which switches a page that is still
// starting the previous cached release onto the new release's assets. Updates instead wait until a page
// can reload before starting, or until every app tab has closed.
function installUpdateLifecycle() {
  if (typeof self.skipWaiting !== 'function') return;
  const skipWaiting = self.skipWaiting.bind(self);
  self.skipWaiting = () => Promise.resolve();
  const scope = new URL('./', self.location.href);
  const markerCache = 'datax-sw-lifecycle-v1';
  const markerKey = new URL('datax-sw-lifecycle', scope).href;
  const inScope = url => {
    try {
      const parsed = new URL(url);
      return parsed.origin === scope.origin && parsed.pathname.startsWith(scope.pathname);
    } catch { return false; }
  };
  async function activeUsesHandshake() {
    try { return Boolean(await (await caches.open(markerCache)).match(markerKey)); }
    catch { return false; }
  }
  self.addEventListener('install', event => {
    // First installs must control the page, and pages from releases without the handshake cannot request activation.
    event.waitUntil((async () => {
      if (!self.registration?.active || !await activeUsesHandshake()) await skipWaiting();
    })());
  });
  self.addEventListener('activate', event => {
    event.waitUntil(caches.open(markerCache).then(cache => cache.put(markerKey, new Response(''))).catch(() => {}));
  });
  self.addEventListener('message', event => {
    if (event.data?.type !== 'datax-activate-update') return;
    const port = event.ports?.[0];
    const source = event.source;
    if (!port || !source?.url || !inScope(source.url)) return;
    event.waitUntil((async () => {
      let activating = false;
      try {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        activating = !windows.some(client => client.id !== source.id && inScope(client.url));
      } catch {}
      port.postMessage({ type: 'datax-activate-update', activating });
      if (activating) await skipWaiting();
    })());
  });
}

// Browser timers throw "Illegal invocation" when called as methods of another object.
function createKernelIdleScheduler(onIdle, delayMs = 300000, now = () => Date.now(),
  timerApi = { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: id => clearTimeout(id) }) {
  let idleSince = null;
  let timer = null;
  let attempted = false;
  let statuses = null;
  let canStart = false;
  function clearTimer() {
    if (timer !== null) timerApi.clearTimeout(timer);
    timer = null;
  }
  function evaluate() {
    clearTimer();
    if (statuses === null || statuses.some(status => status !== 'idle')) {
      idleSince = null;
      attempted = false;
      return;
    }
    if (idleSince === null) idleSince = now();
    if (!canStart || attempted) return;
    const remaining = delayMs - (now() - idleSince);
    if (remaining <= 0) {
      attempted = true;
      onIdle();
      return;
    }
    timer = timerApi.setTimeout(() => {
      timer = null;
      evaluate();
    }, remaining);
  }
  return {
    update(nextStatuses, allowed) {
      statuses = nextStatuses;
      canStart = allowed;
      evaluate();
    },
    dispose: clearTimer,
  };
}

function monitorKernelActivity(onChange, getApp = () => window.jupyterapp,
  timerApi = { setInterval: (callback, delay) => setInterval(callback, delay), clearInterval: id => clearInterval(id) }) {
  let manager = null;
  let models = [];
  const connections = new Map();
  function publish() {
    onChange(models.map(model => connections.get(model.id)?.connection.status ?? 'unknown'));
  }
  function clearConnections() {
    for (const { connection, onStatusChanged } of connections.values()) {
      connection.statusChanged.disconnect(onStatusChanged);
      connection.dispose();
    }
    connections.clear();
  }
  function refresh() {
    const nextManager = getApp()?.serviceManager?.kernels;
    if (!nextManager) {
      manager = null;
      models = [];
      clearConnections();
      onChange(null);
      return;
    }
    if (manager !== nextManager) {
      clearConnections();
      manager = nextManager;
    }
    try {
      models = Array.from(manager.running());
    } catch {
      models = [];
      onChange(null);
      return;
    }
    const ids = new Set(models.map(model => model.id));
    for (const [id, { connection, onStatusChanged }] of connections) {
      if (!ids.has(id)) {
        connection.statusChanged.disconnect(onStatusChanged);
        connection.dispose();
        connections.delete(id);
      }
    }
    for (const model of models) {
      if (connections.has(model.id)) continue;
      try {
        const connection = manager.connectTo({ model, handleComms: false });
        const onStatusChanged = publish;
        connection.statusChanged.connect(onStatusChanged);
        connections.set(model.id, { connection, onStatusChanged });
      } catch {}
    }
    publish();
  }
  refresh();
  const interval = timerApi.setInterval(refresh, 1000);
  return () => {
    timerApi.clearInterval(interval);
    clearConnections();
  };
}

function offlineStatusText(state, mode, online, controlled = true) {
  if (!controlled) return 'Offline: waiting for app control';
  if (state.error) {
    return mode === 'automatic' ? 'Automatic offline download failed' : 'Offline download incomplete';
  }
  if (state.checking) return 'Offline: checking cached files';
  if (state.downloading) {
    const qualifier = mode === 'automatic' ? ' automatically' : '';
    return 'Downloading offline' + qualifier + ': ' + state.completed + '/' + state.total;
  }
  if (state.ready) return 'Offline ready' + (!online ? ' (disconnected)' : mode === 'automatic' ? ' (automatic)' : '');
  return online ? 'Offline: not downloaded' : 'Offline: incomplete';
}

function allowsAutomaticOfflineDownload(connection) {
  return !connection?.saveData && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType);
}

function installOfflineUI() {
  if (!('serviceWorker' in navigator)) return;
  const panel = document.createElement('div');
  panel.id = 'datax-offline-control';
  const label = document.createElement('span');
  label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  label.textContent = navigator.serviceWorker.controller ? 'Offline: checking' : 'Offline: waiting for app control';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Download for offline use';
  button.title = 'Automatically downloads after all kernels stay idle for five minutes.';
  button.disabled = true;
  panel.append(label, button);
  const style = document.createElement('style');
  style.textContent = '#datax-offline-control{display:flex;align-items:center;gap:8px;padding:2px 8px;font:12px var(--jp-ui-font-family,sans-serif);color:var(--jp-ui-font-color1,#222);background:var(--jp-layout-color1,#fff);max-width:100%;box-sizing:border-box}#datax-offline-control[data-floating]{position:fixed;bottom:0;right:0;z-index:1000;border:1px solid #aaa}#datax-offline-control button{font:inherit;color:inherit;background:var(--jp-layout-color2,#eee);border:1px solid #999;border-radius:3px;padding:3px 6px;cursor:pointer;flex-shrink:0}#datax-offline-control button:disabled{cursor:default;opacity:.65}@media(max-width:600px){#datax-offline-control{max-width:calc(100vw - env(safe-area-inset-left,0px) - env(safe-area-inset-right,0px));flex-wrap:wrap;font-size:11px;gap:4px}#datax-offline-control[data-floating]{bottom:calc(env(safe-area-inset-bottom,0px) + var(--jp-statusbar-height,24px));right:env(safe-area-inset-right,0px)}}';
  document.head.append(style);
  // The 24px status bar clips 44px touch targets, so narrow screens float the control above it.
  const narrow = window.matchMedia?.('(max-width: 600px)');
  function place() {
    const bar = document.querySelector('.jp-StatusBar-Right');
    const target = bar && !narrow?.matches ? bar : document.body;
    if (target === bar) delete panel.dataset.floating;
    else panel.dataset.floating = '';
    if (panel.parentElement !== target) target.append(panel);
    return !!bar;
  }
  place();
  const observer = new MutationObserver(() => { if (place()) observer.disconnect(); });
  observer.observe(document.body, { childList: true, subtree: true });
  narrow?.addEventListener?.('change', place);
  let current = null;
  let channel = null;
  let kernelStatuses = null;
  let downloadMode = null;
  let lastLoggedProgress = 0;
  let lastLoggedError = null;
  let completionLogged = false;
  let stallTimer = null;
  let responseTimeout = null;
  let startingDownload = false;
  function canAutoDownload() {
    return navigator.onLine && allowsAutomaticOfflineDownload(navigator.connection)
      && !startingDownload && !!navigator.serviceWorker.controller && !!current
      && !current.ready && !current.checking && !current.downloading && !current.unavailable;
  }
  const idleScheduler = createKernelIdleScheduler(() => startDownload(true));
  const updateIdleScheduler = () => idleScheduler.update(kernelStatuses, canAutoDownload());
  function request(type) {
    if (!navigator.serviceWorker.controller) {
      if (type === 'datax-offline-status') {
        label.textContent = 'Offline: waiting for app control';
        panel.title = 'Waiting for the service worker to control this page.';
        button.disabled = true;
      }
      return;
    }
    clearTimeout(responseTimeout);
    channel?.port1.close();
    const requestChannel = new MessageChannel();
    channel = requestChannel;
    function failRequest(error) {
      if (channel !== requestChannel) return;
      clearTimeout(responseTimeout);
      clearTimeout(stallTimer);
      requestChannel.port1.close();
      channel = null;
      current = { ...(current || {}), unavailable: true, checking: false, downloading: false, error };
      label.textContent = 'Offline cache unavailable';
      panel.title = error + ' Select Retry offline check to try again.';
      button.textContent = 'Retry offline check';
      button.disabled = false;
      button.hidden = false;
      updateIdleScheduler();
      console.error('[DataX.now] ' + error);
    }
    responseTimeout = setTimeout(() => {
      failRequest('Offline service worker did not respond to ' + type + '.');
    }, 10000);
    requestChannel.port1.onmessage = event => {
      if (channel !== requestChannel) return;
      clearTimeout(responseTimeout);
      responseTimeout = null;
      const state = event.data;
      current = state;
      clearTimeout(stallTimer);
      if (state.checking) {
        button.disabled = true;
        label.textContent = offlineStatusText(state, downloadMode, navigator.onLine);
        panel.title = 'The service worker is checking cached files.';
        updateIdleScheduler();
        responseTimeout = setTimeout(() => failRequest('Offline cache check did not finish within 60 seconds.'), 60000);
        return;
      }
      // A terminated worker drops its ports silently; resubscribing resumes from cached files.
      stallTimer = state.downloading ? setTimeout(() => request('datax-offline-download'), 60000) : null;
      button.disabled = !!(state.downloading || state.ready || state.unavailable);
      button.hidden = state.ready;
      updateIdleScheduler();
      if (state.error) {
        label.textContent = state.unavailable
          ? 'Offline cache unavailable'
          : offlineStatusText(state, downloadMode, navigator.onLine);
        panel.title = state.error;
        button.textContent = 'Retry offline download';
        if (lastLoggedError !== state.error) {
          console.error('[DataX.now] Offline download failed:', state.error);
          lastLoggedError = state.error;
        }
      } else if (state.downloading) {
        label.textContent = offlineStatusText(state, downloadMode, navigator.onLine);
        if (downloadMode === 'automatic' && state.total > 0) {
          const progress = Math.floor(state.completed * 100 / state.total / 10) * 10;
          if (progress >= 10 && progress > lastLoggedProgress) {
            console.info('[DataX.now] Automatic offline download ' + progress + '% complete.');
            lastLoggedProgress = progress;
          }
        }
      } else {
        button.textContent = 'Download for offline use';
        panel.title = state.ready
          ? 'The bundled app and runtime are cached. New packages, remote APIs, and AI providers still require a connection. Export important notebooks as a backup.'
          : 'Installing the app does not download its runtime. ' + state.total + ' files; '
            + Math.ceil(state.totalBytes / 1048576)
            + ' MiB; automatic download after 5 minutes with every kernel idle';
        label.textContent = offlineStatusText(state, downloadMode, navigator.onLine);
        if (state.ready && downloadMode === 'automatic' && !completionLogged) {
          console.info('[DataX.now] Automatic offline download complete. Offline use is ready.');
          completionLogged = true;
        }
      }
    };
    requestChannel.port1.onmessageerror = () => {
      failRequest('Could not read the offline service worker response.');
    };
    navigator.serviceWorker.controller.postMessage({ type }, [requestChannel.port2]);
  }
  async function startDownload(automatic = false) {
    if (automatic && !canAutoDownload()) return;
    if (startingDownload || current?.downloading) return;
    const remaining = Math.ceil(((current?.totalBytes ?? 0) - (current?.bytes ?? 0)) / 1048576);
    if (!automatic && !confirm('Download ' + remaining + ' MiB for offline use on this device?')) return;
    startingDownload = true;
    button.disabled = true;
    downloadMode = automatic ? 'automatic' : 'manual';
    lastLoggedProgress = 0;
    lastLoggedError = null;
    completionLogged = false;
    if (automatic) {
      label.textContent = 'Starting automatic offline download';
      console.info('[DataX.now] Starting automatic offline download after five minutes with all kernels idle.');
    }
    try {
      let estimate;
      try { estimate = await navigator.storage?.estimate?.(); }
      catch (error) { console.warn('[DataX.now] Could not estimate available browser storage.', error); }
      const bytesNeeded = Math.max(0, (current?.totalBytes ?? 0) - (current?.bytes ?? 0));
      if (estimate && Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)
          && bytesNeeded > estimate.quota - estimate.usage) {
        label.textContent = 'Not enough browser storage for offline use';
        panel.title = 'Free browser storage, then retry. Saved notebooks have not been deleted.';
        console.error('[DataX.now] Insufficient browser storage for the offline download.', estimate);
        button.disabled = false;
        return;
      }
      try {
        const persisted = await navigator.storage?.persist?.();
        if (persisted === false) console.warn('[DataX.now] Persistent storage was not granted; export important notebooks as a backup.');
      } catch (error) {
        console.warn('[DataX.now] Could not request persistent browser storage.', error);
      }
      request('datax-offline-download');
    } finally {
      startingDownload = false;
      updateIdleScheduler();
    }
  }
  button.addEventListener('click', () => {
    if (current?.unavailable) request('datax-offline-status');
    else startDownload();
  });
  navigator.serviceWorker.ready.then(() => request('datax-offline-status')).catch(error => {
    label.textContent = 'Offline cache unavailable';
    console.error('[DataX.now] Could not connect to the offline service worker.', error);
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    request(current?.downloading ? 'datax-offline-download' : 'datax-offline-status');
    updateIdleScheduler();
  });
  window.addEventListener('online', () => {
    if (!current?.downloading) request('datax-offline-status');
    updateIdleScheduler();
  });
  window.addEventListener('offline', () => { if (!current?.downloading) request('datax-offline-status'); });
  navigator.connection?.addEventListener('change', updateIdleScheduler);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      request(current?.downloading ? 'datax-offline-download' : 'datax-offline-status');
      updateIdleScheduler();
    }
  });
  const stopKernelMonitor = monitorKernelActivity(statuses => {
    kernelStatuses = statuses;
    updateIdleScheduler();
  });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopKernelMonitor();
    idleScheduler.dispose();
    clearTimeout(stallTimer);
    clearTimeout(responseTimeout);
    channel?.port1.close();
    channel = null;
  });
}

function patchServiceWorkerManager(source) {
  const marker = '/* datax-preserve-service-worker */';
  if (source.includes(marker)) return source;
  let count = 0;
  const patched = source.replace(
    /async _unregisterOldServiceWorkers\(([\w$]+)\)\{let ([\w$]+)=`\$\{\1\}-version`,([\w$]+)=localStorage\.getItem\(\2\);if\(\3&&\3!==([\w$]+)\|\|!\3\)\{[\s\S]*?\}localStorage\.setItem\(\2,\4\)\}/g,
    (_, url, key, stored, version) => {
      count++;
      return `async _unregisterOldServiceWorkers(${url}){${marker}
        const ${key}=${url}+"-version",${stored}=localStorage.getItem(${key});
        if(${stored}&&${stored}!==${version}||!${stored}){
          const registration=await navigator.serviceWorker.getRegistration(${url});
          if(registration){
            try{await registration.update()}catch(error){
              if(error?.name!=="TypeError"&&error?.name!=="NetworkError")throw error;
              console.warn("[DataX.now] Could not update the service worker; keeping the active isolated runtime.",error);
              return;
            }
          }
        }
        localStorage.setItem(${key},${version});
      }`;
    },
  );
  if (count !== 1) throw new Error(`Expected one service-worker version handler, found ${count}`);
  return patched;
}

function patchContentsManager(source) {
  const marker = '/* datax-retry-bundled-directory */';
  if (source.includes(marker)) return source;
  let count = 0;
  const patched = source.replace(
    /async _getServerDirectory\([\w$]+\)\{[\s\S]*?(?=async _ensureDirectoryExists\()/g,
    method => {
      count++;
      const utilities = method.match(/([\w$]+)\.PageConfig\.getOption\("contentsAllJsonFile"\)/)?.[1];
      if (!utilities) throw new Error('Could not locate bundled-directory configuration utilities');
      return `async _getServerDirectory(directory){${marker}
        if(this._serverContents.has(directory))return this._serverContents.get(directory);
        const listing=new Map(),file=${utilities}.PageConfig.getOption("contentsAllJsonFile");
        if(!file){this._serverContents.set(directory,listing);return listing}
        const url=${utilities}.URLExt.join(${utilities}.PageConfig.getBaseUrl(),"api/contents",directory,file);
        try{
          const response=await fetch(url);
          if(!response.ok)throw new Error("HTTP "+response.status);
          const model=JSON.parse(await response.text());
          if(!Array.isArray(model.content))throw new Error("Invalid bundled directory listing");
          for(const entry of model.content)listing.set(entry.name,entry);
        }catch(error){
          console.error("[DataX.now] Could not load bundled directory "+url+"; refresh the file browser to retry.",error);
          throw error;
        }
        this._serverContents.set(directory,listing);
        return listing;
      }`;
    },
  );
  if (count !== 1) throw new Error(`Expected one bundled-directory loader, found ${count}`);
  return patched;
}

function normalizeContentsMetadata(directory, timestamp) {
  if (!fs.existsSync(directory)) return;
  function normalize(model) {
    for (const key of ['created', 'last_modified']) {
      if (typeof model[key] === 'string') model[key] = timestamp;
    }
    if (Array.isArray(model.content)) model.content.forEach(normalize);
  }
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) normalizeContentsMetadata(filename, timestamp);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      const model = JSON.parse(fs.readFileSync(filename, 'utf8'));
      normalize(model);
      fs.writeFileSync(filename, JSON.stringify(model, null, 2) + '\n');
    }
  }
}

function prepareOffline(directory, sourceDateEpoch = process.env.SOURCE_DATE_EPOCH) {
  if (sourceDateEpoch !== undefined) {
    if (!/^\d+$/.test(String(sourceDateEpoch)) || !Number.isSafeInteger(Number(sourceDateEpoch))) {
      throw new Error('SOURCE_DATE_EPOCH must be a nonnegative Unix timestamp');
    }
    const timestamp = new Date(Number(sourceDateEpoch) * 1000).toISOString();
    normalizeContentsMetadata(path.join(directory, 'api/contents'), timestamp);
  }
  const runtime = path.join(directory, 'xeus');
  if (fs.existsSync(runtime) && fs.readdirSync(runtime, { withFileTypes: true }).some(entry => {
    if (!entry.isDirectory()) return false;
    const packages = path.join(runtime, entry.name, 'kernel_packages');
    return fs.existsSync(path.join(runtime, entry.name, 'empack_env_meta.json'))
      || (fs.existsSync(packages) && fs.readdirSync(packages).some(name => name.endsWith('.tar.gz')));
  })) {
    const normalized = spawnSync(process.env.DATAX_BUILD_PYTHON || 'python3',
      [path.join(__dirname, 'normalize-kernel-packages.py'), directory], {
        encoding: 'utf8', env: { ...process.env, SOURCE_DATE_EPOCH: String(sourceDateEpoch ?? 0) },
      });
    if (normalized.error || normalized.status !== 0) {
      throw new Error('Kernel package normalization failed: ' +
        (normalized.error?.message || normalized.stderr || `exit ${normalized.status}`));
    }
    console.log(normalized.stdout.trim());
  }
  const extension = path.join(directory, 'extensions/@jupyterlite/xeus-extension/static');
  if (fs.existsSync(extension)) {
    const remote = '"https://raw.githubusercontent.com/prefix-dev/parselmouth/main/files/compressed_mapping.json"';
    const local = 'new URL("conda-pypi-mapping.json",typeof document==="undefined"?new URL("../../../../",globalThis.location.href):new URL(JSON.parse(document.getElementById("jupyter-config-data").textContent).baseUrl||"../",document.baseURI)).href';
    // Upstream fetches the mapping once per page and worker; a transient failure would break package installs for the session.
    const retrying = `(async url=>{for(let attempt=0;;attempt++){try{return await fetch(url)}catch(error){if(attempt>=4)throw error;await new Promise(resolve=>setTimeout(resolve,1000*2**attempt))}}})(${local})`;
    fs.copyFileSync(path.join(__dirname, 'conda-pypi-mapping.json'), path.join(directory, 'conda-pypi-mapping.json'));
    for (const name of fs.readdirSync(extension).filter(name => name.endsWith('.js'))) {
      const filename = path.join(extension, name);
      const source = fs.readFileSync(filename, 'utf8');
      const updated = source.split(`fetch(${remote})`).join(retrying).split(`fetch(${local})`).join(retrying)
        .split(remote).join(local);
      if (updated !== source) fs.writeFileSync(filename, updated);
    }
  }
  // Upstream pings the origin root, which is outside the worker scope on subpath deployments.
  const heartbeat = 'fetch("/api/service-worker-heartbeat")';
  const localHeartbeat = 'fetch(typeof document==="undefined"?"/api/service-worker-heartbeat":new URL("api/service-worker-heartbeat",new URL(JSON.parse(document.getElementById("jupyter-config-data").textContent).baseUrl||"../",document.baseURI)).href)';
  const client = 'datax-offline.js';
  fs.writeFileSync(path.join(directory, client), `${createKernelIdleScheduler.toString()}\n${monitorKernelActivity.toString()}\n${offlineStatusText.toString()}\n${allowsAutomaticOfflineDownload.toString()}\n(${installOfflineUI.toString()})();\n`);
  function patchJavaScript(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) patchJavaScript(filename);
      else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'service-worker.js') {
        const source = fs.readFileSync(filename, 'utf8');
        let updated = source.split(heartbeat).join(localHeartbeat);
        if (updated.includes('_unregisterOldServiceWorkers(')) updated = patchServiceWorkerManager(updated);
        if (updated.includes('async _getServerDirectory(')) updated = patchContentsManager(updated);
        if (updated !== source) fs.writeFileSync(filename, updated);
      }
    }
  }
  patchJavaScript(directory);
  const assets = {};
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) { visit(filename); continue; }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.html.offline')) continue;
      const relative = path.relative(directory, filename).split(path.sep).map(encodeURIComponent).join('/');
      if ([
        'service-worker.js', 'deployment.json', 'xpython-deploy-manifest.json', 'datax-now.zip', 'cors_server.py',
        'xeus/xeus-python-wasm-host/built-in-local/conda/generate_repodata.py',
      ].includes(relative) || entry.name.endsWith('.map')) continue;
      if (entry.name.endsWith('.html') && sourceDateEpoch !== undefined) {
        const html = fs.readFileSync(filename, 'utf8');
        const updated = html.replace(/([^"'<> \t\r\n?]+\.js)\?_=[a-f0-9]+/g, (match, script) => {
          const base = new URL(relative, 'https://datax.invalid/');
          const url = new URL(script, base);
          if (url.origin !== base.origin) return match;
          const target = path.join(directory, decodeURIComponent(url.pathname));
          const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
          return script + '?_=' + digest.slice(0, 12);
        });
        if (updated !== html) fs.writeFileSync(filename, updated);
      }
      if (entry.name === 'index.html') {
        const html = fs.readFileSync(filename, 'utf8');
        const script = `<script id="datax-offline-client" src="${path.relative(path.dirname(filename), path.join(directory, client)).split(path.sep).join('/')}" defer></script>`;
        let updated = html.includes('id="datax-offline-client"') ? html : html.replace('</body>', script + '</body>');
        if (updated.includes('id="datax-pwa-metadata"')) updated = pwa.addScriptIntegrity(updated, filename, directory);
        if (updated !== html) fs.writeFileSync(filename, updated);
      }
      const bytes = fs.readFileSync(filename);
      assets[relative] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
      if (entry.name.endsWith('.html')) {
        fs.writeFileSync(filename + '.offline', bytes);
        assets[relative].source = relative + '.offline';
      }
    }
  }
  visit(directory);
  return assets;
}

module.exports = { allowsAutomaticOfflineDownload, createKernelIdleScheduler, installOfflineCache, installOfflineUI, installUpdateLifecycle, monitorKernelActivity, offlineStatusText, patchContentsManager, patchServiceWorkerManager, prepareOffline };