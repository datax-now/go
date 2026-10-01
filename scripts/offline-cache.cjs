const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
    const canonical = new Request(new URL(relative, scope).href, {
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
        const response = await fetch(new Request(canonical, { integrity, cache: 'no-cache' }));
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
  async function status() {
    const cache = await caches.open(cacheName);
    const keys = new Set((await cache.keys()).map(request => request.url));
    let completed = 0;
    let bytes = 0;
    for (const [relative, asset] of entries) {
      if (keys.has(keyFor(relative, asset))) { completed++; bytes += asset.size; }
    }
    return { type: 'datax-offline', completed, total: entries.length, bytes,
      totalBytes: entries.reduce((total, [, asset]) => total + asset.size, 0),
      ready: completed === entries.length, downloading: preparation !== null };
  }
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
      if (!preparation) {
        preparation = (async () => {
          const cache = await caches.open(cacheName);
          const initial = await status();
          let completed = initial.completed;
          let bytes = initial.bytes;
          const queue = [];
          for (const [relative, asset] of entries) {
            if (!await cache.match(keyFor(relative, asset))) queue.push([relative, asset]);
          }
          const report = () => {
            const update = { ...initial, completed, bytes, ready: false, downloading: true };
            for (const subscriber of ports) subscriber.postMessage(update);
          };
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
                completed++;
                bytes += asset.size;
                report();
              } catch (error) { failure = new Error(relative + ': ' + error.message); }
            }
          }));
          if (failure) throw failure;
        })();
      }
      try {
        await preparation;
        const update = { ...await status(), downloading: false };
        for (const subscriber of ports) subscriber.postMessage(update);
      } catch (error) {
        for (const subscriber of ports) subscriber.postMessage({ type: 'datax-offline', error: error.message, ready: false, downloading: false });
      } finally {
        preparation = null;
        ports.clear();
      }
    })().catch(error => port.postMessage({ type: 'datax-offline', error: error.message, ready: false, downloading: false }));
    event.waitUntil(task);
  });
}

function installOfflineUI() {
  if (!('serviceWorker' in navigator)) return;
  const panel = document.createElement('div');
  panel.id = 'datax-offline-control';
  const label = document.createElement('span');
  label.setAttribute('role', 'status');
  label.setAttribute('aria-live', 'polite');
  label.textContent = 'Offline: checking';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Download for offline use';
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
  function request(type) {
    if (!navigator.serviceWorker.controller) return;
    channel?.port1.close();
    channel = new MessageChannel();
    channel.port1.onmessage = event => {
      const state = event.data;
      current = state;
      button.disabled = state.downloading || state.ready || state.unavailable;
      button.hidden = state.ready;
      if (state.error) {
        label.textContent = state.unavailable ? 'Offline cache unavailable' : 'Offline download incomplete';
        panel.title = state.error;
        button.textContent = 'Retry offline download';
      } else {
        panel.title = state.total + ' files; ' + Math.ceil(state.totalBytes / 1048576) + ' MiB';
        label.textContent = state.ready ? 'Offline ready' : state.downloading
          ? 'Downloading offline: ' + state.completed + '/' + state.total
          : navigator.onLine ? 'Offline: not downloaded' : 'Offline: incomplete';
      }
    };
    navigator.serviceWorker.controller.postMessage({ type }, [channel.port2]);
  }
  button.addEventListener('click', async () => {
    const remaining = Math.ceil(((current?.totalBytes ?? 0) - (current?.bytes ?? 0)) / 1048576);
    if (!confirm('Download ' + remaining + ' MiB for offline use on this device?')) return;
    try { await navigator.storage?.persist?.(); } catch {}
    button.disabled = true;
    request('datax-offline-download');
  });
  navigator.serviceWorker.ready.then(() => request('datax-offline-status')).catch(() => {
    label.textContent = 'Offline cache unavailable';
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => request('datax-offline-status'));
  window.addEventListener('online', () => request('datax-offline-status'));
  window.addEventListener('offline', () => { if (!current?.downloading) request('datax-offline-status'); });
}

function prepareOffline(directory) {
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
  const client = 'datax-offline.js';
  fs.writeFileSync(path.join(directory, client), `(${installOfflineUI.toString()})();\n`);
  const assets = {};
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) { visit(filename); continue; }
      if (!entry.isFile()) continue;
      const relative = path.relative(directory, filename).split(path.sep).map(encodeURIComponent).join('/');
      if (['service-worker.js', 'deployment.json', 'datax-now.zip', 'cors_server.py'].includes(relative)) continue;
      if (entry.name === 'index.html') {
        const html = fs.readFileSync(filename, 'utf8');
        const script = `<script id="datax-offline-client" src="${path.relative(path.dirname(filename), path.join(directory, client)).split(path.sep).join('/')}" defer></script>`;
        const updated = html.includes('id="datax-offline-client"') ? html : html.replace('</body>', script + '</body>');
        if (updated !== html) fs.writeFileSync(filename, updated);
      }
      const bytes = fs.readFileSync(filename);
      assets[relative] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    }
  }
  visit(directory);
  return assets;
}

module.exports = { installOfflineCache, installOfflineUI, prepareOffline };