const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONTENT_SECURITY_POLICY = "base-uri 'self'; object-src 'none'";
const PERMISSIONS_POLICY = 'camera=(self), microphone=(self), geolocation=(self), fullscreen=(self)';
// [portrait px width, portrait px height, CSS device width, CSS device height, pixel ratio] for iOS launch images.
const SPLASH_SIZES = [
  [1125, 2436, 375, 812, 3], [1242, 2688, 414, 896, 3], [1170, 2532, 390, 844, 3], [1284, 2778, 428, 926, 3],
  [1179, 2556, 393, 852, 3], [1290, 2796, 430, 932, 3], [1206, 2622, 402, 874, 3], [1320, 2868, 440, 956, 3],
  [1260, 2736, 420, 912, 3], [750, 1334, 375, 667, 2], [828, 1792, 414, 896, 2], [1536, 2048, 768, 1024, 2],
  [1620, 2160, 810, 1080, 2], [1640, 2360, 820, 1180, 2], [1488, 2266, 744, 1133, 2], [1668, 2224, 834, 1112, 2],
  [1668, 2388, 834, 1194, 2], [1668, 2420, 834, 1210, 2], [2048, 2732, 1024, 1366, 2], [2064, 2752, 1032, 1376, 2],
];

function installPwaNavigation(fallbackAssets, contentSecurityPolicy, permissionsPolicy) {
  const original = maybeFromCache;
  const scope = new URL('./', self.location.href);
  const enabled = new URL(self.location.href).searchParams.get('enableCache') === 'true';
  const cacheName = 'datax-pwa-fallback-v1';
  const keyFor = asset => new URL(asset.relative + '?sha256=' + asset.sha256, scope).href;
  const secureNavigation = response => {
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', contentSecurityPolicy);
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Permissions-Policy', permissionsPolicy);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  self.addEventListener('install', event => {
    if (!enabled) return;
    event.waitUntil((async () => {
      const cache = await caches.open(cacheName);
      await Promise.all(fallbackAssets.map(async asset => {
        const key = keyFor(asset);
        if (await cache.match(key)) return;
        const request = new Request(new URL(asset.source || asset.relative, scope).href, {
          credentials: 'same-origin', cache: 'no-cache',
          integrity: 'sha256-' + btoa(String.fromCharCode(...asset.sha256.match(/../g).map(byte => parseInt(byte, 16)))),
        });
        const response = await (self.dataxFetchOfflineAsset ? self.dataxFetchOfflineAsset(request) : fetch(request));
        if (!response.ok) throw new Error('Could not cache offline fallback: HTTP ' + response.status);
        const headers = new Headers(response.headers);
        if (asset.relative.endsWith('.html')) headers.set('Content-Type', 'text/html; charset=utf-8');
        headers.delete('Content-Encoding');
        headers.delete('Content-Length');
        await cache.put(key, new Response(await response.arrayBuffer(), { headers }));
      }));
    })().catch(error => {
      // Optional fallback caching must not discard an otherwise usable isolated runtime.
      console.error('[DataX.now] Could not prepare the offline fallback.', error);
    }));
  });
  self.addEventListener('activate', event => {
    if (!enabled) return;
    const current = new Set(fallbackAssets.map(keyFor));
    event.waitUntil(caches.open(cacheName).then(async cache => {
      await Promise.all((await cache.keys()).filter(request => !current.has(request.url)).map(request => cache.delete(request)));
    }));
  });
  maybeFromCache = async function(event) {
    const request = event.request;
    const url = new URL(request.url);
    const inScope = url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
    const asset = fallbackAssets.find(asset => new URL(asset.relative, scope).pathname === url.pathname);
    if (enabled && inScope && request.method === 'GET' && !request.headers.has('Range')) {
      if (asset) {
        const cached = await (await caches.open(cacheName)).match(keyFor(asset));
        if (cached) return cached;
      }
      if (request.mode === 'navigate') {
        try {
          const response = await original(event);
          if (response.ok || response.status < 500) return secureNavigation(response);
        } catch (error) {
          if (error?.name !== 'TypeError' && error?.name !== 'NetworkError') throw error;
          console.warn('[DataX.now] Navigation unavailable; serving the offline fallback.', error);
        }
        const fallback = fallbackAssets.find(asset => asset.relative === 'offline.html');
        const cached = fallback && await (await caches.open(cacheName)).match(keyFor(fallback));
        if (cached) {
          // Relative links must resolve from the deployment root, not the failed navigation.
          const html = (await cached.text()).replace('<head>', '<head><base href="' + scope.pathname + '">');
          const headers = new Headers(cached.headers);
          headers.set('Content-Type', 'text/html; charset=utf-8');
          return secureNavigation(new Response(html, { status: 503, headers }));
        }
        throw new TypeError('The page is unavailable and the offline fallback has not been cached.');
      }
    }
    return original(event);
  };
}

function installPwaUI() {
  const panel = document.createElement('aside');
  panel.id = 'datax-pwa-control';
  panel.setAttribute('aria-label', 'App updates and notifications');
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  const update = document.createElement('button');
  update.type = 'button';
  update.textContent = 'Save work and update';
  update.hidden = true;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss app notification');
  dismiss.addEventListener('click', () => { panel.hidden = true; });
  const actions = document.createElement('div');
  actions.className = 'datax-pwa-actions';
  actions.append(update, dismiss);
  panel.hidden = true;
  panel.append(status, actions);
  document.body.append(panel);
  let updating = false;
  let registration = null;
  let reloadOnChange = false;
  let checkingUpdate = false;
  let lastUpdateCheck = 0;
  const watchedWorkers = new WeakSet();
  const reloadKey = 'datax-sw-update-reload';
  const render = () => {
    panel.hidden = update.hidden && !status.textContent;
  };
  const report = message => { status.textContent = message; render(); };
  const openLaunchedFiles = async files => {
    let app = window.jupyterapp;
    for (let waited = 0; !app && waited < 120000; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250));
      app = window.jupyterapp;
    }
    if (!app) throw new Error('DataX.now did not finish loading.');
    await app.restored;
    const contents = app.serviceManager.contents;
    const listing = await contents.get('', { content: true });
    const taken = new Set((listing.content || []).map(item => item.name));
    const opened = [];
    const failed = [];
    for (const handle of files) {
      let label = 'file';
      try {
        const file = await handle.getFile();
        label = file.name;
        let content = null;
        try { content = JSON.parse(await file.text()); } catch {}
        if (!content || typeof content !== 'object' || !Array.isArray(content.cells)) {
          throw new Error('not a Jupyter notebook');
        }
        const stem = file.name.replace(/\.ipynb$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
          .replace(/^[.\s]+/, '').trim() || 'Untitled';
        let name = stem + '.ipynb';
        for (let index = 1; taken.has(name); index++) name = stem + ' (' + index + ').ipynb';
        taken.add(name);
        await contents.save(name, { type: 'notebook', format: 'json', content });
        await app.commands.execute('docmanager:open', { path: name });
        opened.push(name);
      } catch (error) {
        failed.push(label);
        console.error('[DataX.now] Could not open launched file ' + label + '.', error);
      }
    }
    report([
      opened.length ? 'Opened ' + opened.join(', ') + ' as a browser copy; edits are not written back to the original file.' : '',
      failed.length ? 'Could not open ' + failed.join(', ') + '.' : '',
    ].filter(Boolean).join(' '));
  };
  if (window.launchQueue?.setConsumer) {
    let launches = Promise.resolve();
    window.launchQueue.setConsumer(params => {
      if (!params?.files?.length) return;
      const files = [...params.files];
      launches = launches.then(() => openLaunchedFiles(files)).catch(error => {
        report('Could not open the selected notebook: ' + error.message);
        console.error('[DataX.now] Could not open launched files.', error);
      });
    });
  }
  if (!('serviceWorker' in navigator)) return;
  const worker = navigator.serviceWorker;
  const showUpdate = () => {
    if (!registration?.waiting) return;
    status.textContent = 'A new version is ready. Save notebooks before updating.';
    update.hidden = false;
    render();
  };
  const watchInstalling = () => {
    const next = registration?.installing;
    if (!next || watchedWorkers.has(next)) return;
    watchedWorkers.add(next);
    const onStateChange = () => {
      if (next.state === 'installed') showUpdate();
      if (next.state === 'redundant') {
        status.textContent = 'Update could not be downloaded. The current version is still available.';
        render();
      }
      if (next.state === 'installed' || next.state === 'redundant') {
        next.removeEventListener('statechange', onStateChange);
      }
    };
    next.addEventListener('statechange', onStateChange);
    onStateChange();
  };
  worker.ready.then(value => {
    registration = value;
    lastUpdateCheck = Date.now();
    registration.addEventListener('updatefound', watchInstalling);
    // Registration may already be installing when ready resolves.
    watchInstalling();
    showUpdate();
  }).catch(error => {
    status.textContent = 'App updates are unavailable.';
    render();
    console.error('[DataX.now] Could not watch for app updates.', error);
  });
  const checkForUpdate = async () => {
    if (!registration || checkingUpdate || updating || registration.waiting ||
        !navigator.onLine || document.visibilityState !== 'visible' ||
        Date.now() - lastUpdateCheck < 60000) return;
    checkingUpdate = true;
    lastUpdateCheck = Date.now();
    try {
      await registration.update();
      watchInstalling();
      showUpdate();
    } catch (error) {
      console.warn('[DataX.now] Could not check for app updates; keeping the current version.', error);
    } finally {
      checkingUpdate = false;
    }
  };
  document.addEventListener('visibilitychange', checkForUpdate);
  window.addEventListener('online', checkForUpdate);
  worker.addEventListener('controllerchange', () => {
    if (reloadOnChange) location.reload();
  });
  update.addEventListener('click', async () => {
    if (updating || !registration?.waiting) return;
    if (!confirm('Save your notebooks first. Reload DataX.now to apply this update? Running kernels will stop.')) return;
    updating = true;
    update.disabled = true;
    const channel = new MessageChannel();
    let timeout;
    let onControllerChange;
    try {
      sessionStorage.setItem(reloadKey, '1');
      reloadOnChange = true;
      const controlled = new Promise(resolve => {
        onControllerChange = resolve;
        worker.addEventListener('controllerchange', onControllerChange);
      });
      const result = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('The update worker did not respond.')), 10000);
        channel.port1.onmessage = event => resolve(event.data);
        registration.waiting.postMessage({ type: 'datax-activate-update' }, [channel.port2]);
      });
      clearTimeout(timeout);
      if (!result?.activating) {
        reloadOnChange = false;
        sessionStorage.removeItem(reloadKey);
        status.textContent = 'Close other DataX.now tabs, then select update again.';
      } else {
        status.textContent = 'Applying update...';
        await Promise.race([controlled, new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('The update did not take control. Reload to retry.')), 10000);
        })]);
      }
    } catch (error) {
      reloadOnChange = false;
      try { sessionStorage.removeItem(reloadKey); }
      catch (storageError) { console.warn('[DataX.now] Could not clear the update retry state.', storageError); }
      status.textContent = 'Could not apply update: ' + error.message;
      console.error('[DataX.now] Could not apply the app update.', error);
    } finally {
      clearTimeout(timeout);
      if (onControllerChange) worker.removeEventListener('controllerchange', onControllerChange);
      channel.port1.close();
      updating = false;
      update.disabled = false;
      render();
    }
  });
}

function preparePwa(directory) {
  const assets = path.join(__dirname, '../assets');
  const names = ['icon-192x192.png', 'icon-512x512.png', 'icon-maskable-512x512.png', 'apple-touch-icon.png',
    'screenshot-wide.png', 'screenshot-narrow.png', 'datax-pwa.css', 'offline.html'];
  const splashSizes = SPLASH_SIZES;
  for (const [width, height] of splashSizes) {
    names.push(`splash-${width}x${height}.png`, `splash-${height}x${width}.png`);
  }
  for (const name of names) fs.copyFileSync(path.join(assets, name), path.join(directory, name));
  fs.writeFileSync(path.join(directory, 'datax-pwa.js'), `(${installPwaUI.toString()})();\n`);
  const manifestPath = path.join(directory, 'manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  Object.assign(manifest, {
    id: './', start_url: './lab/index.html', scope: './',
    orientation: 'any',
    display_override: ['standalone', 'minimal-ui'],
    lang: 'en', dir: 'ltr', categories: ['education', 'productivity', 'developer'],
    prefer_related_applications: false,
    icons: [
      { src: './icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './icon-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    screenshots: [
      { src: './screenshot-wide.png', sizes: '1280x800', type: 'image/png', form_factor: 'wide',
        label: 'Python notebook with a Matplotlib chart in DataX.now' },
      { src: './screenshot-narrow.png', sizes: '780x1688', type: 'image/png', form_factor: 'narrow',
        label: 'DataX.now notebook on a phone' },
    ],
    // Launched notebooks are copied into browser storage; see installPwaUI.
    file_handlers: [
      { action: './lab/index.html', accept: { 'application/x-ipynb+json': ['.ipynb'] } },
    ],
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const pages = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'index.html')))
    .map(entry => path.join(directory, entry.name, 'index.html'));
  if (fs.existsSync(path.join(directory, 'index.html'))) pages.push(path.join(directory, 'index.html'));
  for (const filename of pages) {
    let html = fs.readFileSync(filename, 'utf8');
    const prefix = path.relative(path.dirname(filename), directory).split(path.sep).join('/') || '.';
    const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
    if (/<meta name="viewport" content="[^"]*"\s*\/?>/i.test(html)) {
      html = html.replace(/<meta name="viewport" content="[^"]*"\s*\/?>/i, viewport);
    } else {
      html = html.replace('</head>', viewport + '\n</head>');
    }
    if (!/<title>/i.test(html)) html = html.replace('</head>', '<title>DataX.now</title>\n</head>');
    if (!/<html[^>]*\blang=/i.test(html)) html = html.replace(/<html\b/i, '<html lang="en"');
    if (!/<meta[^>]*name="description"/i.test(html)) {
      html = html.replace('</head>', '<meta name="description" content="Browser-based, multi-language data applications.">\n</head>');
    }
    if (!/<link[^>]*rel="manifest"/i.test(html)) {
      html = html.replace('</head>', `<link rel="manifest" crossorigin="use-credentials" href="${prefix}/manifest.webmanifest">\n</head>`);
    }
    const splash = splashSizes.flatMap(([width, height, deviceWidth, deviceHeight, ratio]) =>
      ['portrait', 'landscape'].map(orientation =>
        `<link rel="apple-touch-startup-image" href="${prefix}/splash-${orientation === 'portrait' ? width + 'x' + height : height + 'x' + width}.png" media="(device-width: ${deviceWidth}px) and (device-height: ${deviceHeight}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation})">`));
    html = html.replace(/<link rel="apple-touch-startup-image"[^>]*>\n?/g, '');
    if (html.includes('id="datax-pwa-metadata"')) {
      fs.writeFileSync(filename, html.replace('</head>', splash.join('\n') + '\n</head>'));
      continue;
    }
    const title = html.match(/<title>(.*?)<\/title>/)?.[1] || 'DataX.now';
    const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
    const canonical = path.relative(directory, filename).split(path.sep).join('/');
    const tags = [
      '<meta id="datax-pwa-metadata" name="theme-color" content="#f7dc1e">',
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '<meta name="mobile-web-app-capable" content="yes">',
      '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
      '<meta name="apple-mobile-web-app-title" content="DataX.now">',
      '<meta name="referrer" content="strict-origin-when-cross-origin">',
      `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`,
      `<link rel="apple-touch-icon" sizes="180x180" href="${prefix}/apple-touch-icon.png">`,
      `<link rel="canonical" href="${prefix}/${canonical}">`,
      `<meta property="og:title" content="${escape(title)}">`,
      '<meta property="og:description" content="Browser-based, multi-language data applications.">',
      '<meta property="og:image" content="https://datax-now.github.io/go/icon-512x512.png">',
      '<meta property="og:type" content="website">',
      `<link rel="stylesheet" href="${prefix}/datax-pwa.css">`,
      '<script type="application/ld+json">' + JSON.stringify({
        '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'DataX.now',
        applicationCategory: 'DeveloperApplication', operatingSystem: 'Web',
        description: 'Browser-based, multi-language data applications.',
      }) + '</script>',
      ...splash,
    ];
    html = html.replace('</head>', tags.join('\n') + '\n</head>')
      .replace('</body>', `<script id="datax-pwa-client" src="${prefix}/datax-pwa.js" defer></script>\n</body>`);
    fs.writeFileSync(filename, html);
  }
}

function addScriptIntegrity(html, filename, directory) {
  return html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g, (tag, src) => {
    if (/^[a-z]+:|^\/\//i.test(src)) return tag;
    const local = path.resolve(path.dirname(filename), src.split('?')[0]);
    if (!local.startsWith(path.resolve(directory) + path.sep)) throw new Error('Script is outside the deployment: ' + src);
    const integrity = crypto.createHash('sha384').update(fs.readFileSync(local)).digest('base64');
    return tag.replace(/\s+integrity="[^"]*"/g, '').replace('>', ` integrity="sha384-${integrity}">`);
  });
}

function fallbackInventory(assets) {
  return ['offline.html', 'icon-192x192.png'].filter(relative => assets[relative])
    .map(relative => ({ relative, ...assets[relative] }));
}

function verifyPwa(directory) {
  const root = path.resolve(directory);
  const base = new URL('https://datax.invalid/deployment/');
  const localFile = (resource, from = base) => {
    const url = new URL(resource, from);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error('PWA resource is outside the deployment: ' + resource);
    }
    const filename = path.resolve(root, decodeURIComponent(url.pathname.slice(base.pathname.length)));
    if (!filename.startsWith(root + path.sep)) throw new Error('Invalid PWA resource path: ' + resource);
    return filename;
  };
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  for (const field of ['name', 'short_name', 'description', 'id', 'start_url', 'scope', 'background_color', 'theme_color']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      throw new Error('Missing PWA manifest field: ' + field);
    }
  }
  if (!['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display) || manifest.prefer_related_applications === true) {
    throw new Error('PWA manifest does not allow browser installation');
  }
  const scope = new URL(manifest.scope, base);
  const start = new URL(manifest.start_url, base);
  if (scope.origin !== base.origin || !scope.pathname.startsWith(base.pathname) ||
      start.origin !== scope.origin || !start.pathname.startsWith(scope.pathname)) {
    throw new Error('PWA start URL must stay within the deployment scope');
  }
  fs.accessSync(localFile(manifest.start_url));
  if (!Array.isArray(manifest.icons)) throw new Error('Missing PWA manifest icons');
  const verifyPng = (resource, width, height, from = base, kind = 'install icon') => {
    const png = fs.readFileSync(localFile(resource, from));
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) {
      throw new Error(`Invalid PWA ${kind} dimensions: ` + resource);
    }
  };
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(entry => entry.sizes === `${size}x${size}` &&
      entry.type === 'image/png' && (entry.purpose || 'any').split(' ').includes('any'));
    if (!icon) throw new Error('Missing PWA install icon: ' + size);
    verifyPng(icon.src, size, size);
  }
  const maskable = manifest.icons.find(entry => entry.sizes === '512x512' &&
    entry.type === 'image/png' && (entry.purpose || '').split(' ').includes('maskable'));
  if (!maskable) throw new Error('Missing PWA maskable icon');
  verifyPng(maskable.src, 512, 512);
  const screenshots = Array.isArray(manifest.screenshots) ? manifest.screenshots : [];
  for (const formFactor of ['wide', 'narrow']) {
    if (!screenshots.some(entry => entry.form_factor === formFactor)) throw new Error('Missing PWA screenshot: ' + formFactor);
  }
  for (const screenshot of screenshots) {
    const [width, height] = String(screenshot.sizes).split('x').map(Number);
    // Chromium ignores install screenshots outside these bounds or whose orientation contradicts the form factor.
    if (!(Math.min(width, height) >= 320 && Math.max(width, height) <= 3840 &&
          Math.max(width, height) <= 2.3 * Math.min(width, height)) ||
        screenshot.type !== 'image/png' || !screenshot.label ||
        (screenshot.form_factor === 'wide') !== (width > height)) {
      throw new Error('Invalid PWA screenshot: ' + screenshot.src);
    }
    verifyPng(screenshot.src, width, height, base, 'screenshot');
  }
  const notebookHandler = (manifest.file_handlers || []).find(handler =>
    Object.values(handler.accept || {}).some(extensions => [].concat(extensions).includes('.ipynb')));
  if (!notebookHandler) throw new Error('Missing PWA file handler for .ipynb');
  const action = new URL(notebookHandler.action, base);
  if (action.origin !== scope.origin || !action.pathname.startsWith(scope.pathname)) {
    throw new Error('PWA file handler action must stay within the deployment scope');
  }
  fs.accessSync(localFile(notebookHandler.action));
  // File launches and the idle offline monitor need window.jupyterapp, which JupyterLite reads only from jupyter-config-data.
  const labConfig = JSON.parse(fs.readFileSync(path.join(root, 'lab', 'jupyter-lite.json'), 'utf8'));
  if (labConfig['jupyter-config-data']?.exposeAppInBrowser !== true) {
    throw new Error('JupyterLite lab config must set jupyter-config-data.exposeAppInBrowser');
  }
  for (const route of ['lab', 'repl', 'tree']) {
    const filename = path.join(root, route, 'index.html');
    const html = fs.readFileSync(filename, 'utf8');
    const pageUrl = new URL(route + '/index.html', base);
    if (!/<link\b[^>]*rel="manifest"[^>]*href="([^"]+)"/i.test(html) ||
        !/<meta\b[^>]*name="description"[^>]*content="[^"]+"/i.test(html) ||
        !/viewport-fit=cover/.test(html)) {
      throw new Error('Missing PWA metadata in ' + route);
    }
    const manifestLink = html.match(/<link\b[^>]*rel="manifest"[^>]*href="([^"]+)"/i)[1];
    if (localFile(manifestLink, pageUrl) !== path.join(root, 'manifest.webmanifest')) {
      throw new Error('Incorrect PWA manifest link in ' + route);
    }
    const appleIcon = html.match(/<link\b[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/i)?.[1];
    if (!appleIcon) throw new Error('Missing Apple touch icon in ' + route);
    verifyPng(appleIcon, 180, 180, pageUrl);
    for (const [tag, resource] of html.matchAll(/<link\b[^>]*rel="apple-touch-startup-image"[^>]*href="([^"]+)"[^>]*>/gi)) {
      const media = tag.match(/device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d+)\) and \(orientation: (portrait|landscape)/);
      if (!media) throw new Error('Invalid iOS launch image media query in ' + route + ': ' + resource);
      const [, deviceWidth, deviceHeight, ratio, orientation] = media;
      const [width, height] = [deviceWidth * ratio, deviceHeight * ratio];
      verifyPng(resource, orientation === 'portrait' ? width : height, orientation === 'portrait' ? height : width,
        pageUrl, 'iOS launch image');
    }
    for (const [, tag, src] of html.matchAll(/(<script\b[^>]*\bsrc="([^"]+)"[^>]*>)/gi)) {
      const integrity = tag.match(/\bintegrity="([^"]+)"/)?.[1];
      const expected = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(localFile(src, pageUrl))).digest('base64');
      if (integrity !== expected) throw new Error('Incorrect script integrity in ' + route + ': ' + src);
    }
    for (const name of ['datax-pwa.js', 'datax-offline.js', 'datax-pwa.css']) {
      if (!html.includes(name)) throw new Error('Missing PWA client resource in ' + route + ': ' + name);
      fs.accessSync(path.join(root, name));
    }
  }
  const worker = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
  for (const marker of ['installPwaNavigation', 'installOfflineCache', 'installUpdateLifecycle']) {
    if (!worker.includes(marker)) throw new Error('Missing service-worker integration: ' + marker);
  }
  if (!/\baddEventListener\(\s*['"]fetch['"]/.test(worker)) throw new Error('Missing service-worker fetch handler');
  fs.accessSync(path.join(root, 'offline.html'));
}

module.exports = { CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY, SPLASH_SIZES, addScriptIntegrity, installPwaNavigation, installPwaUI, preparePwa, fallbackInventory, verifyPwa };
if (require.main === module) {
  if (process.argv[2] === 'verify') {
    verifyPwa(process.argv[3] || 'dist');
    console.log('Verified PWA manifest, install icons, screenshots, file handling, launch images, routes, script integrity, and service-worker integration.');
  } else {
    preparePwa(process.argv[2] || 'dist');
  }
}
