const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const offline = require('./offline-cache.cjs');

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
  const integrityOf = hex => 'sha256-' + btoa(String.fromCharCode(...hex.match(/../g).map(byte => parseInt(byte, 16))));
  const isCooling = origin => (coolingUntil.get(origin) ?? 0) > Date.now();
  const cool = origin => coolingUntil.set(origin, Date.now() + cooldownMs);
  const isBlocked = response => [429, 502, 503, 504].includes(response.status)
    || response.headers.get('cf-mitigated') === 'challenge';
  // Builds on different hosts embed their own paths in runtime files, so bytes differ between hosts.
  function loadMirrorManifest(base) {
    if (!manifests.has(base.href)) {
      manifests.set(base.href, fetch(new Request(new URL('deployment.json', base).href, {
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
  async function fetchWithMirrors(request, fetchOriginal, strictAssetHash = false) {
    if (!mirrors.length || request.method !== 'GET' || request.headers.has('Range')) {
      return fetchOriginal();
    }
    const url = new URL(request.url);
    const runtimePath = url.pathname.match(/(\/xeus\/.+)$/);
    const runtimeHash = runtimePath && hashes[runtimePath[1].slice(1)];
    const assetPath = assetPathFor(url);
    const assetHash = assetPath && assetHashes[assetPath];
    const isManifest = url.pathname.endsWith('/manifest.webmanifest');
    const isDeployment = url.hostname === 'readthedocs.io' || url.hostname.endsWith('.readthedocs.io')
      || mirrors.some(base => base.origin === url.origin);
    const mirrorPath = runtimeHash
      ? runtimePath[1]
      : assetHash ? `/${assetPath}`
      : isManifest ? '/manifest.webmanifest' : null;
    if (!isDeployment || !mirrorPath) return fetchOriginal();
    let failedResponse = null;
    let failedError = null;
    if (!isCooling(url.origin)) {
      try {
        const response = await fetchOriginal();
        if (!isBlocked(response)) return response;
        failedResponse = response;
      } catch (error) {
        if (error?.name !== 'TypeError') throw error;
        failedError = error;
      }
      cool(url.origin);
    }
    for (const base of mirrors) {
      if (base.origin === url.origin || isCooling(base.origin)) continue;
      const mirrorUrl = new URL(mirrorPath.slice(1), base);
      mirrorUrl.search = url.search;
      const mirrorRequest = { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-cache' };
      if (runtimeHash || assetHash) {
        const manifest = await loadMirrorManifest(base);
        const expectedHash = runtimeHash || assetHash;
        const mirrorHash = manifest?.files[decodeURIComponent(mirrorPath.slice(1))]?.sha256;
        const exactHashRequired = !!assetHash && (!runtimeHash || strictAssetHash);
        if (exactHashRequired && manifest && mirrorHash !== assetHash) continue;
        // Another release is safe only for byte-identical files; otherwise two builds would be mixed.
        if (manifest && buildCommit && manifest.commit !== buildCommit && mirrorHash !== expectedHash) continue;
        mirrorRequest.integrity = integrityOf(exactHashRequired ? assetHash : mirrorHash ?? expectedHash);
      }
      try {
        const response = await fetch(new Request(mirrorUrl.href, mirrorRequest));
        if (response.ok) return response;
        if (isBlocked(response)) cool(base.origin);
      } catch (error) {
        if (error?.name !== 'TypeError') throw error;
        cool(base.origin);
      }
    }
    if (failedResponse) return failedResponse;
    if (failedError) throw failedError;
    return fetchOriginal();
  }
  self.dataxFetchOfflineAsset = request => fetchWithMirrors(request, () => fetch(request), true);
  async function fetchRuntime(request) {
    return fetchWithMirrors(request, () => fetch(request));
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
    const integrity = integrityOf(hash);
    const verifiedRequest = new Request(request, { integrity, cache: 'no-cache' });
    let cache;
    try {
      cache = await caches.open(cacheName);
      const cached = await cache.match(key.href);
      if (cached) return cached;
    } catch {
      return fetchRuntime(verifiedRequest);
    }
    if (!pending.has(key.href)) {
      const download = (async () => {
        const response = await fetchRuntime(verifiedRequest);
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
    `(${offline.installOfflineCache.toString()})(${JSON.stringify(assets)});\n`);
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