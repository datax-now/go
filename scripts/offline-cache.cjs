const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function installOfflineCache(assets) {
  const original = maybeFromCache;
  const scope = new URL('./', self.location.href);
  const enabled = new URL(self.location.href).searchParams.get('enableCache') === 'true';
  const cacheName = 'datax-runtime-sha256-v2';
  const pending = new Map();
  const entries = Object.entries(assets);
  let preparation = null;
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
  maybeFromCache = async function(event) {
    const request = event.request;
    const relative = relativeFor(request);
    if (!enabled || !relative || request.method !== 'GET' || request.headers.has('Range')) return original(event);
    const asset = assets[relative];
    const key = keyFor(relative, asset);
    const canonical = new Request(new URL(asset.source || relative, scope).href, {
      method: request.method, headers: request.headers, credentials: request.credentials,
      mode: request.mode === 'navigate' ? 'same-origin' : request.mode,
      redirect: request.redirect, signal: request.signal,
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
          try { await cache.put(key, response.clone()); } catch {}
        }
        return response;
      })();
      pending.set(key, download);
      event.waitUntil(download.then(() => {}, () => {}).finally(() => pending.delete(key)));
    }
    return (await pending.get(key)).clone();
  };
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
            const response = await maybeFromCache({
              request: new Request(new URL(relative, scope).href),
              waitUntil() {},
            });
            if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + relative);
            if (!await cache.match(keyFor(relative, asset))) {
              throw new Error('Unable to store ' + relative + '. Check available browser storage.');
            }
            progress = { ...progress, completed: progress.completed + 1, bytes: progress.bytes + asset.size };
            report();
          } catch (error) { failure = new Error(relative + ': ' + error.message); }
        }
      }));
      if (failure) throw failure;
      try { await cache.put(readyKey, new Response('')); } catch {}
    })().finally(() => {
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
    const task = (async () => {
      if (event.data.type === 'datax-offline-status') {
        port.postMessage(await status());
        return;
      }
      ports.add(port);
      if (progress) port.postMessage(progress);
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
  if (state.downloading) {
    const qualifier = mode === 'automatic' ? ' automatically' : '';
    return 'Downloading offline' + qualifier + ': ' + state.completed + '/' + state.total;
  }
  if (state.ready) return 'Offline ready' + (mode === 'automatic' ? ' (automatic)' : '');
  return online ? 'Offline: not downloaded' : 'Offline: incomplete';
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
  style.textContent = '#datax-offline-control{display:flex;align-items:center;gap:8px;padding:2px 8px;font:12px var(--jp-ui-font-family,sans-serif);color:var(--jp-ui-font-color1,#222);background:var(--jp-layout-color1,#fff);max-width:100%;box-sizing:border-box}#datax-offline-control[data-floating]{position:fixed;bottom:0;right:0;z-index:1000;border:1px solid #aaa}#datax-offline-control button{font:inherit;color:inherit;background:var(--jp-layout-color2,#eee);border:1px solid #999;border-radius:3px;padding:3px 6px;cursor:pointer;flex-shrink:0}#datax-offline-control button:disabled{cursor:default;opacity:.65}@media(max-width:600px){#datax-offline-control{position:fixed;bottom:0;right:0;z-index:1000;max-width:100vw;flex-wrap:wrap;font-size:11px;gap:4px}}';
  document.head.append(style);
  panel.dataset.floating = '';
  document.body.append(panel);
  const observer = new MutationObserver(() => {
    const bar = document.querySelector('.jp-StatusBar-Right');
    if (bar) { delete panel.dataset.floating; bar.append(panel); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  let current = null;
  let channel = null;
  let kernelStatuses = null;
  let downloadMode = null;
  let lastLoggedProgress = 0;
  let lastLoggedError = null;
  let completionLogged = false;
  let stallTimer = null;
  function canAutoDownload() {
    return navigator.onLine && !!navigator.serviceWorker.controller && !!current
      && !current.ready && !current.downloading && !current.unavailable;
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
    channel?.port1.close();
    const requestChannel = new MessageChannel();
    channel = requestChannel;
    let responseTimeout = setTimeout(() => {
      if (channel !== requestChannel) return;
      requestChannel.port1.close();
      channel = null;
      current = { ...(current || {}), unavailable: true };
      label.textContent = 'Offline cache unavailable';
      panel.title = type === 'datax-offline-status'
        ? 'The offline service worker did not respond. Reload the app to retry.'
        : 'The offline download did not respond. Reload the app to retry.';
      button.disabled = true;
      updateIdleScheduler();
      console.error('[DataX.now] Offline service worker did not respond to ' + type + '.');
    }, 10000);
    let receivedResponse = false;
    requestChannel.port1.onmessage = event => {
      if (!receivedResponse) {
        clearTimeout(responseTimeout);
        responseTimeout = null;
        receivedResponse = true;
      }
      const state = event.data;
      current = state;
      clearTimeout(stallTimer);
      // A terminated worker drops its ports silently; resubscribing resumes from cached files.
      stallTimer = state.downloading ? setTimeout(() => request('datax-offline-download'), 60000) : null;
      button.disabled = state.downloading || state.ready || state.unavailable;
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
        panel.title = state.total + ' files; ' + Math.ceil(state.totalBytes / 1048576)
          + ' MiB; automatic download after 5 minutes with every kernel idle';
        label.textContent = offlineStatusText(state, downloadMode, navigator.onLine);
        if (state.ready && downloadMode === 'automatic' && !completionLogged) {
          console.info('[DataX.now] Automatic offline download complete. Offline use is ready.');
          completionLogged = true;
        }
      }
    };
    requestChannel.port1.onmessageerror = () => {
      clearTimeout(responseTimeout);
      responseTimeout = null;
      channel = null;
      label.textContent = 'Offline cache unavailable';
      panel.title = 'Could not read the offline service worker response.';
      button.disabled = true;
      console.error('[DataX.now] Could not read the offline service worker response.');
    };
    navigator.serviceWorker.controller.postMessage({ type }, [requestChannel.port2]);
  }
  async function startDownload(automatic = false) {
    if (automatic && !canAutoDownload()) return;
    const remaining = Math.ceil(((current?.totalBytes ?? 0) - (current?.bytes ?? 0)) / 1048576);
    if (!automatic && !confirm('Download ' + remaining + ' MiB for offline use on this device?')) return;
    downloadMode = automatic ? 'automatic' : 'manual';
    lastLoggedProgress = 0;
    lastLoggedError = null;
    completionLogged = false;
    if (automatic) {
      label.textContent = 'Starting automatic offline download';
      console.info('[DataX.now] Starting automatic offline download after five minutes with all kernels idle.');
    }
    try { await navigator.storage?.persist?.(); } catch {}
    button.disabled = true;
    request('datax-offline-download');
  }
  button.addEventListener('click', () => startDownload());
  navigator.serviceWorker.ready.then(() => request('datax-offline-status')).catch(() => {
    label.textContent = 'Offline cache unavailable';
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
  const stopKernelMonitor = monitorKernelActivity(statuses => {
    kernelStatuses = statuses;
    updateIdleScheduler();
  });
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    stopKernelMonitor();
    idleScheduler.dispose();
    clearTimeout(stallTimer);
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
    return fs.existsSync(packages) && fs.readdirSync(packages).some(name => name.endsWith('.tar.gz'));
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
    fs.copyFileSync(path.join(__dirname, 'conda-pypi-mapping.json'), path.join(directory, 'conda-pypi-mapping.json'));
    for (const name of fs.readdirSync(extension).filter(name => name.endsWith('.js'))) {
      const filename = path.join(extension, name);
      const source = fs.readFileSync(filename, 'utf8');
      if (source.includes(remote)) fs.writeFileSync(filename, source.split(remote).join(local));
    }
  }
  // Upstream pings the origin root, which is outside the worker scope on subpath deployments.
  const heartbeat = 'fetch("/api/service-worker-heartbeat")';
  const localHeartbeat = 'fetch(typeof document==="undefined"?"/api/service-worker-heartbeat":new URL("api/service-worker-heartbeat",new URL(JSON.parse(document.getElementById("jupyter-config-data").textContent).baseUrl||"../",document.baseURI)).href)';
  const client = 'datax-offline.js';
  fs.writeFileSync(path.join(directory, client), `${createKernelIdleScheduler.toString()}\n${monitorKernelActivity.toString()}\n${offlineStatusText.toString()}\n(${installOfflineUI.toString()})();\n`);
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
      ].includes(relative)) continue;
      if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(filename, 'utf8');
        let updated = source.split(heartbeat).join(localHeartbeat);
        if (updated.includes('_unregisterOldServiceWorkers(')) updated = patchServiceWorkerManager(updated);
        if (updated.includes('async _getServerDirectory(')) updated = patchContentsManager(updated);
        if (updated !== source) fs.writeFileSync(filename, updated);
      }
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
        const updated = html.includes('id="datax-offline-client"') ? html : html.replace('</body>', script + '</body>');
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

module.exports = { createKernelIdleScheduler, installOfflineCache, installOfflineUI, monitorKernelActivity, offlineStatusText, patchContentsManager, patchServiceWorkerManager, prepareOffline };