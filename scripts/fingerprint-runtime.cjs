const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const offline = require('./offline-cache.cjs');
const pwa = require('./pwa.cjs');

// Ordered by priority: a host later in the list is only tried after every earlier one failed.
const DEFAULT_MIRROR_ORIGINS = [
  'https://datax-now.readthedocs.io/en/latest/_static/',
  'https://datax-now.github.io/go/',
  'https://datax.now/',
  'https://datax-now.pages.dev/',
];

function installRuntimeCache(hashes, mirrorOrigins = [], buildCommit = null, assetHashes = {}) {
  const original = maybeFromCache;
  const scope = new URL('./', self.location.href);
  const mirrors = [].concat(mirrorOrigins || []).filter(Boolean)
    .map(origin => new URL(origin.endsWith('/') ? origin : `${origin}/`));
  const enabled = new URL(self.location.href).searchParams.get('enableCache') === 'true';
  const cacheName = 'datax-runtime-sha256-v2';
  const pending = new Map();
  const manifests = new Map();
  const coolingUntil = new Map();
  const cooldownMs = 60000;
  // When no mirror can serve a file, transient local failures (rate limits, resets) get a bounded retry.
  const localRetryDelaysMs = [1000, 2000, 4000, 8000];
  // A stalled connection never fails on its own (Chrome gives up after five minutes), which left cold kernels
  // waiting silently. Downloads that stop making progress are aborted and handled like any transient failure.
  const responseTimeoutMs = 45000;
  const idleTimeoutMs = 30000;
  const hexOf = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  const hashOfIntegrity = integrity => {
    const match = /^sha256-([A-Za-z0-9+/]+={0,2})$/.exec(integrity || '');
    return match ? hexOf(Uint8Array.from(atob(match[1]), character => character.charCodeAt(0))) : null;
  };
  // SRI makes fetch() resolve only after the whole body arrived, hiding progress, so the hash is verified here instead.
  async function guardedFetch(request, expectedHash = null) {
    expectedHash = expectedHash || hashOfIntegrity(request.integrity);
    if (request.integrity && !expectedHash) return fetch(request);
    const controller = new AbortController();
    let timer = null;
    let stalled = false;
    const arm = delay => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; controller.abort(); }, delay);
    };
    try {
      arm(responseTimeoutMs);
      const response = await fetch(new Request(request, { integrity: '', signal: controller.signal }));
      if (!response.body) return response;
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        arm(idleTimeoutMs);
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
      }
      clearTimeout(timer);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (expectedHash && response.ok && hexOf(await crypto.subtle.digest('SHA-256', bytes)) !== expectedHash) {
        // Retrying the same origin would return the same wrong bytes; only a mirror can help.
        throw Object.assign(new TypeError(`Integrity check failed for ${request.url}`), { dataxIntegrity: true });
      }
      const headers = new Headers(response.headers);
      headers.delete('Content-Encoding');
      headers.set('Content-Length', String(size));
      return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      if (stalled) {
        console.warn(`[DataX.now] Download stalled and was aborted for retry: ${request.url}`);
        throw new TypeError(`Download stalled: ${request.url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  const isCooling = origin => (coolingUntil.get(origin) ?? 0) > Date.now();
  const cool = origin => coolingUntil.set(origin, Date.now() + cooldownMs);
  const isBlocked = response => [429, 502, 503, 504].includes(response.status)
    || response.headers.get('cf-mitigated') === 'challenge';
  function loadMirrorManifest(base) {
    if (!manifests.has(base.href)) {
      manifests.set(base.href, guardedFetch(new Request(new URL('deployment.json', base).href, {
        mode: 'cors', credentials: 'omit', cache: 'no-cache',
      })).then(response => response.ok ? response.json() : null)
        .catch(() => null)
        .then(manifest => { if (!manifest?.files) manifests.delete(base.href); return manifest?.files ? manifest : null; }));
    }
    return manifests.get(base.href);
  }
  function assetPathFor(url) {
    const base = [scope, ...mirrors]
      .filter(candidate => candidate.origin === url.origin && url.pathname.startsWith(candidate.pathname))
      .sort((left, right) => right.pathname.length - left.pathname.length)[0];
    if (!base) return null;
    try {
      return url.pathname.slice(base.pathname.length).split('/')
        .map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
    } catch { return null; }
  }
  async function fetchWithMirrors(request, fetchOriginal) {
    if (request.method !== 'GET' || request.headers.has('Range')) return fetchOriginal();
    const url = new URL(request.url);
    const runtimePath = url.pathname.match(/(\/xeus\/.+)$/);
    const runtimeHash = runtimePath && hashes[runtimePath[1].slice(1)];
    const assetPath = assetPathFor(url);
    const assetHash = assetPath && assetHashes[assetPath];
    const isManifest = url.pathname.endsWith('/manifest.webmanifest');
    const isDeployment = url.hostname === 'readthedocs.io' || url.hostname.endsWith('.readthedocs.io')
      || mirrors.some(base => base.origin === url.origin);
    // Hosts outside the mirror set (e.g. Vercel, previews) still retry their own files after transient failures.
    const isOwnScope = url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
    const mirrorPath = runtimeHash
      ? runtimePath[1]
      : assetHash ? `/${assetPath}`
      : isManifest ? '/manifest.webmanifest' : null;
    if (!(isDeployment || isOwnScope) || !mirrorPath) return fetchOriginal();
    let failedResponse = null;
    let failedError = null;
    async function tryOriginal() {
      try {
        const response = await fetchOriginal();
        if (!isBlocked(response)) return response;
        failedResponse = response;
        failedError = null;
      } catch (error) {
        if (error?.name !== 'TypeError') throw error;
        failedError = error;
        failedResponse = null;
      }
      return null;
    }
    const triedOriginal = !isCooling(url.origin);
    if (triedOriginal) {
      const response = await tryOriginal();
      if (response) return response;
      cool(url.origin);
    }
    for (const base of isDeployment ? mirrors : []) {
      if (base.origin === url.origin || isCooling(base.origin)) continue;
      const mirrorUrl = new URL(mirrorPath.slice(1), base);
      mirrorUrl.search = url.search;
      const mirrorRequest = { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-cache' };
      const expectedHash = runtimeHash || assetHash;
      if (expectedHash) {
        const manifest = await loadMirrorManifest(base);
        const mirrorHash = manifest?.files[decodeURIComponent(mirrorPath.slice(1))]?.sha256;
        if (manifest && mirrorHash !== expectedHash) continue;
      }
      try {
        const response = await guardedFetch(new Request(mirrorUrl.href, mirrorRequest), expectedHash);
        if (response.ok) return response;
        if (isBlocked(response)) cool(base.origin);
      } catch (error) {
        if (error?.name !== 'TypeError') throw error;
        cool(base.origin);
      }
    }
    for (const delay of triedOriginal ? localRetryDelaysMs : [0, ...localRetryDelaysMs]) {
      if (failedError?.dataxIntegrity) break;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const response = await tryOriginal();
      if (response) return response;
    }
    if (failedResponse) return failedResponse;
    throw failedError;
  }
  self.dataxFetchOfflineAsset = request => fetchWithMirrors(request, () => guardedFetch(request));
  async function fetchRuntime(request, hash) {
    return fetchWithMirrors(request, () => guardedFetch(request, hash));
  }
  maybeFromCache = async function(event) {
    const request = event.request;
    const url = new URL(request.url);
    const relative = url.pathname.slice(scope.pathname.length);
    const hash = url.origin === scope.origin && url.pathname.startsWith(scope.pathname)
      ? hashes[relative] : null;
    if (request.headers.has('Range')) return fetch(request);
    if (!hash || request.method !== 'GET' || !enabled) {
      const response = fetchWithMirrors(request, () => original(event));
      // The manifest is optional metadata; a blocked fetch must not surface as an uncaught rejection.
      return url.pathname.endsWith('/manifest.webmanifest')
        ? response.catch(() => new Response(null, { status: 503 }))
        : response;
    }
    const key = new URL(relative, scope);
    key.searchParams.set('sha256', hash);
    // Older entries may contain mirror bytes verified against a different build's hash.
    key.searchParams.set('verified', 'local');
    // Concurrent requests share this download, so one client's abort (reload, closed worker) must not cancel it.
    const verifiedRequest = new Request(request, { cache: 'no-cache', signal: null });
    let cache;
    try {
      cache = await caches.open(cacheName);
      const cached = await cache.match(key.href);
      if (cached) return cached;
    } catch {
      return fetchRuntime(verifiedRequest, hash);
    }
    if (!pending.has(key.href)) {
      const download = (async () => {
        const response = await fetchRuntime(verifiedRequest, hash);
        if (response.ok && response.status !== 206) {
          try {
            await cache.put(key.href, response.clone());
            const keys = await cache.keys();
            await Promise.all(keys.filter(entry => {
              const previous = new URL(entry.url);
              return previous.pathname === key.pathname && previous.href !== key.href;
            }).map(entry => cache.delete(entry)));
          } catch {}
        }
        return response;
      })();
      pending.set(key.href, download);
      event.waitUntil(download.then(() => {}, () => {}).finally(() => pending.delete(key.href)));
    }
    return (await pending.get(key.href)).clone();
  };
}

function fingerprintRuntime(directory, mirrorOrigins = DEFAULT_MIRROR_ORIGINS, buildCommit = null) {
  const runtime = path.join(directory, 'xeus');
  const worker = path.join(directory, 'service-worker.js');
  const marker = '\n;/* datax-runtime-fingerprints */\n';
  if (!fs.existsSync(runtime)) throw new Error('Missing xeus runtime: cannot fingerprint an incomplete build');
  const hashes = {};
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isFile()) {
        const relative = path.relative(directory, filename).split(path.sep).map(encodeURIComponent).join('/');
        hashes[relative] = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      }
    }
  }
  const assets = offline.prepareOffline(directory);
  const assetHashes = {};
  for (const [relative, asset] of Object.entries(assets)) {
    assetHashes[relative] = asset.sha256;
    if (asset.source) assetHashes[asset.source] = asset.sha256;
  }
  visit(runtime);
  const source = fs.readFileSync(worker, 'utf8').split(marker)[0];
  fs.writeFileSync(worker, source + marker + `(${installRuntimeCache.toString()})(${JSON.stringify(hashes)}, ${JSON.stringify(mirrorOrigins)}, ${JSON.stringify(buildCommit)}, ${JSON.stringify(assetHashes)});\n` +
    `(${offline.installOfflineCache.toString()})(${JSON.stringify(assets)});\n` +
    (assets['offline.html'] ? `(${pwa.installPwaNavigation.toString()})(${JSON.stringify(pwa.fallbackInventory(assets))}, ${JSON.stringify(pwa.CONTENT_SECURITY_POLICY)}, ${JSON.stringify(pwa.PERMISSIONS_POLICY)});\n` : '') +
    `(${offline.installUpdateLifecycle.toString()})();\n`);
  console.log(`Fingerprinted ${Object.keys(hashes).length} runtime files for cache-first reuse`);
  return hashes;
}

module.exports = { DEFAULT_MIRROR_ORIGINS, fingerprintRuntime, installRuntimeCache };
if (require.main === module) {
  // Comma-separated, in priority order; an empty value disables failover.
  const configured = process.env.DATAX_RUNTIME_MIRROR_ORIGIN;
  const mirrorOrigins = configured === undefined
    ? DEFAULT_MIRROR_ORIGINS
    : configured.split(',').map(origin => origin.trim()).filter(Boolean);
  fingerprintRuntime(process.argv[2] || 'dist', mirrorOrigins, process.env.DATAX_BUILD_COMMIT || null);
}