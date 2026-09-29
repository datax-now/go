const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function installRuntimeCache(hashes, mirrorOrigin = 'https://datax-now.github.io/go/') {
  const original = maybeFromCache;
  const scope = new URL('./', self.location.href);
  const mirrorBase = new URL(mirrorOrigin.endsWith('/') ? mirrorOrigin : `${mirrorOrigin}/`);
  const enabled = new URL(self.location.href).searchParams.get('enableCache') === 'true';
  const cacheName = 'datax-runtime-sha256-v2';
  const pending = new Map();
  let mirrorFiles;
  // Builds on different hosts embed their own paths in runtime files, so bytes differ between hosts.
  function loadMirrorFiles() {
    mirrorFiles ??= fetch(new Request(new URL('deployment.json', mirrorBase).href, {
      mode: 'cors', credentials: 'omit', cache: 'no-cache',
    })).then(response => response.ok ? response.json() : null)
      .then(manifest => manifest?.files ?? null)
      .catch(() => null)
      .then(files => { if (!files) mirrorFiles = undefined; return files; });
    return mirrorFiles;
  }
  async function fetchReadTheDocsAssetWithMirror(request, fetchOriginal) {
    if (!mirrorOrigin || request.method !== 'GET' || request.headers.has('Range')) {
      return fetchOriginal();
    }
    const url = new URL(request.url);
    const runtimePath = url.pathname.match(/(\/xeus\/.+)$/);
    const runtimeHash = runtimePath && hashes[runtimePath[1].slice(1)];
    const runtimeIntegrity = runtimeHash
      ? 'sha256-' + btoa(String.fromCharCode(...runtimeHash.match(/../g).map(byte => parseInt(byte, 16))))
      : null;
    const isManifest = url.pathname.endsWith('/manifest.webmanifest');
    const isReadTheDocs = url.hostname === 'readthedocs.io' || url.hostname.endsWith('.readthedocs.io');
    const mirrorPath = runtimePath && runtimeIntegrity
      ? runtimePath[1]
      : isManifest ? '/manifest.webmanifest' : null;
    if (!isReadTheDocs || !mirrorPath) return fetchOriginal();
    const mirrorUrl = new URL(mirrorPath.slice(1), mirrorBase);
    mirrorUrl.search = url.search;
    let response;
    try {
      response = await fetchOriginal();
      if (response.status !== 429 && response.headers.get('cf-mitigated') !== 'challenge') return response;
    } catch (error) {
      if (error?.name !== 'TypeError') throw error;
    }
    const mirrorRequest = {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-cache',
    };
    if (runtimeIntegrity) {
      const mirrorHash = (await loadMirrorFiles())?.[decodeURIComponent(runtimePath[1].slice(1))]?.sha256;
      mirrorRequest.integrity = mirrorHash
        ? 'sha256-' + btoa(String.fromCharCode(...mirrorHash.match(/../g).map(byte => parseInt(byte, 16))))
        : runtimeIntegrity;
    }
    return fetch(new Request(mirrorUrl.href, mirrorRequest));
  }
  async function fetchRuntime(request) {
    return fetchReadTheDocsAssetWithMirror(request, () => fetch(request));
  }
  maybeFromCache = async function(event) {
    const request = event.request;
    const url = new URL(request.url);
    const relative = url.pathname.slice(scope.pathname.length);
    const hash = url.origin === scope.origin && url.pathname.startsWith(scope.pathname)
      ? hashes[relative] : null;
    if (request.headers.has('Range')) return fetch(request);
    if (!hash || request.method !== 'GET' || !enabled) {
      const response = fetchReadTheDocsAssetWithMirror(request, () => original(event));
      // The manifest is optional metadata; a blocked fetch must not surface as an uncaught rejection.
      return url.pathname.endsWith('/manifest.webmanifest')
        ? response.catch(() => new Response(null, { status: 503 }))
        : response;
    }
    const key = new URL(relative, scope);
    key.searchParams.set('sha256', hash);
    const integrity = 'sha256-' + btoa(String.fromCharCode(...hash.match(/../g).map(byte => parseInt(byte, 16))));
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

function fingerprintRuntime(directory, mirrorOrigin = 'https://datax-now.github.io/go/') {
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
  visit(runtime);
  const source = fs.readFileSync(worker, 'utf8').split(marker)[0];
  fs.writeFileSync(worker, source + marker + `(${installRuntimeCache.toString()})(${JSON.stringify(hashes)}, ${JSON.stringify(mirrorOrigin)});\n`);
  console.log(`Fingerprinted ${Object.keys(hashes).length} runtime files for cache-first reuse`);
  return hashes;
}

module.exports = { fingerprintRuntime, installRuntimeCache };
if (require.main === module) {
  fingerprintRuntime(process.argv[2] || 'dist', process.env.DATAX_RUNTIME_MIRROR_ORIGIN || 'https://datax-now.github.io/go/');
}