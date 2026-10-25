import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import pwa from './pwa.cjs';
import offline from './offline-cache.cjs';
import fingerprints from './fingerprint-runtime.cjs';

test('generated PWA resources and script integrity remain portable and reproducible on every host', t => {
  const directory = mkdtempSync(join(tmpdir(), 'datax-pwa-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const route of ['', 'lab', 'repl', 'tree']) {
    mkdirSync(join(directory, route), { recursive: true });
    const prefix = route ? '..' : '.';
    writeFileSync(join(directory, route, 'index.html'),
      `<html><head>${route ? '<title>DataX.now</title><meta name="viewport" content="width=device-width, initial-scale=1">' : ''}
      <script src="${prefix}/z-build/app.js"></script></head><body></body></html>`);
  }
  mkdirSync(join(directory, 'z-build'));
  mkdirSync(join(directory, 'xeus'));
  writeFileSync(join(directory, 'lab/jupyter-lite.json'), JSON.stringify({ 'jupyter-config-data': { exposeAppInBrowser: true } }));
  writeFileSync(join(directory, 'z-build/app.js'), 'fetch("/api/service-worker-heartbeat")');
  writeFileSync(join(directory, 'service-worker.js'), 'function maybeFromCache() {} self.addEventListener("fetch", () => {});');
  writeFileSync(join(directory, 'manifest.webmanifest'), JSON.stringify({
    name: 'DataX.now', short_name: 'DataX.now', description: 'Browser-based notebooks',
    display: 'standalone', background_color: '#fff', theme_color: '#f7dc1e',
  }));
  pwa.preparePwa(directory);
  const assets = offline.prepareOffline(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.webmanifest')));
  assert.equal(manifest.start_url, './lab/index.html');
  assert.equal(manifest.id, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.lang, 'en');
  assert.equal(manifest.orientation, 'any');
  assert.deepEqual(manifest.display_override, ['standalone', 'minimal-ui']);
  assert.deepEqual(manifest.categories, ['education', 'productivity', 'developer']);
  assert.deepEqual(manifest.screenshots.map(entry => entry.form_factor), ['wide', 'narrow']);
  for (const screenshot of manifest.screenshots) {
    const png = readFileSync(join(directory, screenshot.src));
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, screenshot.sizes);
    assert.ok(screenshot.label);
  }
  assert.deepEqual(manifest.file_handlers, [{ action: './lab/index.html', accept: { 'application/x-ipynb+json': ['.ipynb'] } }]);
  assert.equal(manifest.launch_handler, undefined, 'shortcuts and file launches keep opening their own window');
  for (const icon of manifest.icons) {
    const png = readFileSync(join(directory, icon.src));
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
    if (icon.purpose === 'maskable') assert.equal(png[25], 2, 'maskable artwork has an opaque RGB background');
  }
  const touch = readFileSync(join(directory, 'apple-touch-icon.png'));
  assert.equal(touch.readUInt32BE(16), 180);
  for (const route of ['', 'lab', 'repl', 'tree']) {
    const filename = join(directory, route, 'index.html');
    const html = readFileSync(filename, 'utf8');
    assert.match(html, /<html lang="en"/);
    assert.match(html, /viewport-fit=cover/);
    assert.match(html, /<title>DataX.now<\/title>/);
    assert.match(html, /rel="manifest"/);
    assert.match(html, /name="description"/i);
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /mobile-web-app-capable/);
    assert.match(html, /apple-mobile-web-app-status-bar-style/);
    assert.match(html, /application\/ld\+json/);
    assert.match(html, /property="og:image"/);
    assert.equal((html.match(/rel="apple-touch-startup-image"/g) || []).length, pwa.SPLASH_SIZES.length * 2);
    for (const prefix of ['/', '/go/', '/en/latest/_static/']) {
      const base = new URL(prefix, 'https://example.com');
      for (const resource of [manifest.start_url, manifest.scope, manifest.id,
        ...manifest.icons.map(icon => icon.src), ...manifest.screenshots.map(entry => entry.src),
        ...manifest.file_handlers.map(handler => handler.action)]) {
        const resolved = new URL(resource, base);
        assert.equal(resolved.origin, base.origin);
        assert.ok(resolved.pathname.startsWith(prefix), resource);
      }
      const url = new URL((route ? route + '/' : '') + 'index.html', base);
      for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const resource = new URL(href, url);
        if (resource.origin === url.origin) assert.ok(resource.pathname.startsWith(prefix), href);
      }
    }
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*integrity="([^"]+)"/g)];
    assert.equal(scripts.length, 3, 'all three statically linked scripts have integrity values');
    for (const [, src, integrity] of scripts) {
      const bytes = readFileSync(join(directory, route, src));
      assert.equal(integrity, 'sha384-' + createHash('sha384').update(bytes).digest('base64'));
    }
  }
  assert.match(readFileSync(join(directory, 'z-build/app.js'), 'utf8'), /new URL/);
  const lab = join(directory, 'lab/index.html');
  writeFileSync(lab, readFileSync(lab, 'utf8').replace(/<link rel="apple-touch-startup-image"[^>]*>\n?/g, '').replace('</head>',
    '<link rel="apple-touch-startup-image" href="../splash-1170x2532.png" media="stale">\n</head>'));
  pwa.preparePwa(directory);
  assert.equal((readFileSync(lab, 'utf8').match(/rel="apple-touch-startup-image"/g) || []).length, pwa.SPLASH_SIZES.length * 2,
    'launch images are refreshed on already patched pages');
  assert.doesNotMatch(readFileSync(lab, 'utf8'), /media="stale"/);
  assert.deepEqual(offline.prepareOffline(directory), assets, 'metadata, inventory and integrity generation are idempotent');
  fingerprints.fingerprintRuntime(directory, []);
  assert.match(readFileSync(join(directory, 'service-worker.js'), 'utf8'), /function installPwaNavigation/);
  assert.ok(assets['offline.html'].source.endsWith('.offline'), 'fallback uses the mirror-verifiable HTML copy');
  pwa.verifyPwa(directory);
  const rejectsChange = (name, change, message) => {
    const filename = join(directory, name);
    const original = readFileSync(filename);
    writeFileSync(filename, change(original));
    assert.throws(() => pwa.verifyPwa(directory), message);
    writeFileSync(filename, original);
  };
  rejectsChange('manifest.webmanifest', bytes => {
    const changed = JSON.parse(bytes);
    changed.start_url = '/lab/index.html';
    return JSON.stringify(changed);
  }, /within the deployment scope/);
  rejectsChange('manifest.webmanifest', bytes => {
    const changed = JSON.parse(bytes);
    delete changed.theme_color;
    return JSON.stringify(changed);
  }, /Missing PWA manifest field: theme_color/);
  rejectsChange('icon-192x192.png', bytes => {
    const changed = Buffer.from(bytes);
    changed.writeUInt32BE(180, 16);
    return changed;
  }, /Invalid PWA install icon dimensions/);
  rejectsChange('lab/jupyter-lite.json', () => JSON.stringify({ exposeAppInBrowser: true, 'jupyter-config-data': {} }),
    /exposeAppInBrowser/);
  rejectsChange('manifest.webmanifest', bytes => {
    const changed = JSON.parse(bytes);
    changed.screenshots[1].sizes = '780x2000';
    return JSON.stringify(changed);
  }, /Invalid PWA screenshot/);
  rejectsChange('screenshot-wide.png', bytes => {
    const changed = Buffer.from(bytes);
    changed.writeUInt32BE(1200, 16);
    return changed;
  }, /Invalid PWA screenshot dimensions/);
  rejectsChange('manifest.webmanifest', bytes => {
    const changed = JSON.parse(bytes);
    changed.file_handlers[0].action = '/lab/index.html';
    return JSON.stringify(changed);
  }, /outside the deployment|within the deployment scope/);
  rejectsChange('manifest.webmanifest', bytes => {
    const changed = JSON.parse(bytes);
    delete changed.file_handlers;
    return JSON.stringify(changed);
  }, /Missing PWA file handler/);
  rejectsChange('splash-2532x1170.png', bytes => {
    const changed = Buffer.from(bytes);
    changed.writeUInt32BE(1170, 16);
    return changed;
  }, /Invalid PWA iOS launch image dimensions/);
  rejectsChange('lab/index.html', bytes => bytes.toString().replace('../manifest.webmanifest', '/manifest.webmanifest'),
    /outside the deployment/);
  rejectsChange('datax-pwa.js', bytes => bytes.toString() + '\n// changed after integrity generation\n',
    /Incorrect script integrity/);
  rejectsChange('service-worker.js', () => 'function maybeFromCache() {}', /Missing service-worker integration/);
  rejectsChange('service-worker.js', bytes => bytes.toString().replace('addEventListener("fetch"', 'addEventListener("message"'),
    /Missing service-worker fetch handler/);
});

function emitter() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event = {}) { for (const listener of listeners.get(type) || []) listener(event); },
    async emitAsync(type, event = {}) {
      await Promise.all([...listeners.get(type) || []].map(listener => listener(event)));
    },
  };
}

function uiHarness({ userAgent = 'Chrome', standalone = false, reply = { activating: true },
  initialWaiting = true, updateImpl = async () => {}, windowExtras = {} } = {}) {
  const elements = [];
  const element = tag => {
    const value = { ...emitter(), tag, children: [], attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      append(...children) { this.children.push(...children); } };
    elements.push(value);
    return value;
  };
  const worker = { ...emitter(), ready: null };
  let messages = 0;
  const waiting = {
    postMessage(data, [port]) {
      messages++;
      assert.equal(data.type, 'datax-activate-update');
      port.postMessage(reply);
      if (reply.activating) queueMicrotask(() => worker.emit('controllerchange'));
    },
  };
  let updateChecks = 0;
  const registration = { ...emitter(), waiting: initialWaiting ? waiting : null, installing: null,
    async update() { updateChecks++; await updateImpl(); } };
  worker.ready = Promise.resolve(registration);
  const window = { ...emitter(), matchMedia: () => ({ matches: standalone }), ...windowExtras };
  const values = new Map();
  let reloads = 0;
  const errors = [];
  const warnings = [];
  const document = { ...emitter(), visibilityState: 'visible', createElement: element, body: { append() {} } };
  const navigator = { userAgent, onLine: true, serviceWorker: worker };
  let now = 100000;
  const context = vm.createContext({
    document, navigator, Date: { now: () => now },
    window, location: { reload() { reloads++; } }, confirm: () => true,
    MessageChannel: class {
      constructor() {
        this.port1 = { close() {}, onmessage: null };
        this.port2 = { postMessage: data => this.port1.onmessage?.({ data }) };
      }
    },
    sessionStorage: {
      getItem: key => values.get(key),
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    },
    setTimeout, clearTimeout, console: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(`(${pwa.installPwaUI.toString()})();`, context);
  const [panel, status, update, dismiss, actions] = elements;
  return { panel, status, update, dismiss, actions,
    window, document, navigator, worker, registration, waiting, values, errors, warnings,
    advance: milliseconds => { now += milliseconds; },
    get updateChecks() { return updateChecks; },
    get messages() { return messages; }, get reloads() { return reloads; } };
}

test('installation is left to the browser without a custom prompt on desktop or iOS', async () => {
  for (const options of [{}, { userAgent: 'iPhone' }, { userAgent: 'iPhone', standalone: true }]) {
    const ui = uiHarness({ ...options, initialWaiting: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.panel.hidden, true);
    assert.equal(ui.status.textContent || '', '');
    assert.deepEqual(ui.panel.children, [ui.status, ui.actions]);
    assert.deepEqual(ui.actions.children, [ui.update, ui.dismiss], 'no custom installation button');
    let prevented = false;
    let prompts = 0;
    ui.window.emit('beforeinstallprompt', {
      preventDefault() { prevented = true; },
      async prompt() { prompts++; },
    });
    assert.equal(prevented, false, 'native browser installation UI is not suppressed');
    assert.equal(prompts, 0, 'the app does not trigger an installation dialog');
    assert.equal(ui.panel.hidden, true);
    ui.window.emit('appinstalled');
    assert.equal(ui.panel.hidden, true);
  }
});

test('browser installation events do not interrupt update notifications', async () => {
  const ui = uiHarness({ initialWaiting: false });
  await new Promise(resolve => setImmediate(resolve));
  ui.registration.waiting = ui.waiting;
  const next = { ...emitter(), state: 'installed' };
  ui.registration.installing = next;
  ui.registration.emit('updatefound');
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.dismiss.textContent, 'Dismiss');
  assert.equal(ui.dismiss.attributes['aria-label'], 'Dismiss app notification');
  assert.equal(ui.update.hidden, false);
  ui.window.emit('beforeinstallprompt');
  ui.window.emit('appinstalled');
  assert.equal(ui.panel.hidden, false);
  assert.match(ui.status.textContent, /Save notebooks before updating/);
  ui.dismiss.emit('click');
  assert.equal(ui.panel.hidden, true, 'update notifications can still be dismissed');
});

test('notebooks launched from the operating system open as unique browser copies once the app is ready', async () => {
  let consumer;
  const saved = [];
  const opened = [];
  const app = {
    restored: Promise.resolve(),
    serviceManager: { contents: {
      async get(path, options) {
        assert.equal(path, '');
        assert.equal(options.content, true);
        return { content: [{ name: 'report.ipynb' }, { name: 'report (1).ipynb' }] };
      },
      async save(path, model) { saved.push([path, model]); return model; },
    } },
    commands: { async execute(id, args) { opened.push([id, args.path]); } },
  };
  const launched = (name, text) => ({ async getFile() { return { name, async text() { return text; } }; } });
  const notebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
  const ui = uiHarness({ initialWaiting: false, windowExtras: { launchQueue: { setConsumer(callback) { consumer = callback; } } } });
  assert.equal(typeof consumer, 'function');
  consumer({ files: [] });
  assert.equal(ui.panel.hidden, true, 'ordinary launches are ignored');
  consumer({ files: [
    launched('report.ipynb', JSON.stringify(notebook)),
    launched('../evil:name.ipynb', JSON.stringify(notebook)),
    launched('notes.ipynb', '{"not":"a notebook"}'),
  ] });
  // The app registers itself after the launch is queued.
  ui.window.jupyterapp = app;
  for (let index = 0; index < 100 && !ui.status.textContent; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(saved.map(([path]) => path), ['report (2).ipynb', '_evil_name.ipynb']);
  assert.deepEqual(JSON.parse(JSON.stringify(saved[0][1])), { type: 'notebook', format: 'json', content: notebook });
  assert.deepEqual(opened, [['docmanager:open', 'report (2).ipynb'], ['docmanager:open', '_evil_name.ipynb']]);
  assert.match(ui.status.textContent, /Opened report \(2\)\.ipynb, _evil_name\.ipynb as a browser copy; edits are not written back/);
  assert.match(ui.status.textContent, /Could not open notes\.ipynb/);
  assert.equal(ui.panel.hidden, false);
  assert.equal(ui.errors.length, 1);
});

test('release updates require consent, preserve the multi-tab handshake, and suppress repeat activation after reload', async () => {
  const ui = uiHarness();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.update.hidden, false);
  assert.equal(ui.messages, 0);
  await Promise.all([ui.update.emitAsync('click'), ui.update.emitAsync('click')]);
  assert.equal(ui.messages, 1);
  assert.equal(ui.reloads, 1);
  assert.equal(ui.values.get('datax-sw-update-reload'), '1');
  const blocked = uiHarness({ reply: { activating: false } });
  await new Promise(resolve => setImmediate(resolve));
  await blocked.update.emitAsync('click');
  assert.equal(blocked.reloads, 0);
  assert.equal(blocked.values.has('datax-sw-update-reload'), false);
  assert.match(blocked.status.textContent, /Close other/);
  assert.equal(blocked.update.disabled, false);
});

test('updates discovered after app startup are shown without reloading a running kernel', async () => {
  const ui = uiHarness({ initialWaiting: false });
  await new Promise(resolve => setImmediate(resolve));
  const next = { ...emitter(), state: 'installing' };
  ui.registration.installing = next;
  ui.registration.emit('updatefound');
  ui.registration.waiting = ui.waiting;
  next.state = 'installed';
  next.emit('statechange');
  assert.equal(ui.update.hidden, false);
  assert.equal(ui.messages, 0);
  assert.equal(ui.reloads, 0);
});

test('an update already installing when registration becomes ready is still observed', async () => {
  const ui = uiHarness({ initialWaiting: false });
  const next = { ...emitter(), state: 'installing' };
  ui.registration.installing = next;
  await new Promise(resolve => setImmediate(resolve));
  ui.registration.emit('updatefound');
  ui.registration.waiting = ui.waiting;
  next.state = 'installed';
  next.emit('statechange');
  assert.equal(ui.update.hidden, false);
  assert.equal(ui.messages, 0);
  assert.equal(ui.reloads, 0);
});

test('returning to a visible online app checks updates with throttling and no concurrent requests', async () => {
  let finish;
  const ui = uiHarness({ initialWaiting: false,
    updateImpl: () => new Promise(resolve => { finish = resolve; }) });
  await new Promise(resolve => setImmediate(resolve));
  await ui.document.emitAsync('visibilitychange');
  assert.equal(ui.updateChecks, 0);
  ui.advance(60000);
  ui.document.visibilityState = 'hidden';
  await ui.window.emitAsync('online');
  assert.equal(ui.updateChecks, 0);
  ui.document.visibilityState = 'visible';
  ui.navigator.onLine = false;
  await ui.document.emitAsync('visibilitychange');
  assert.equal(ui.updateChecks, 0);
  ui.navigator.onLine = true;
  const checking = ui.document.emitAsync('visibilitychange');
  await ui.window.emitAsync('online');
  assert.equal(ui.updateChecks, 1);
  finish();
  await checking;
  await ui.window.emitAsync('online');
  assert.equal(ui.updateChecks, 1);
  ui.advance(60000);
  ui.registration.waiting = ui.waiting;
  await ui.window.emitAsync('online');
  assert.equal(ui.updateChecks, 1, 'a waiting update does not need another download check');
  assert.equal(ui.reloads, 0);
});

test('failed update checks retain the current app and can be retried later', async () => {
  const ui = uiHarness({ initialWaiting: false, updateImpl: async () => { throw new TypeError('network unavailable'); } });
  await new Promise(resolve => setImmediate(resolve));
  ui.advance(60000);
  await ui.document.emitAsync('visibilitychange');
  assert.equal(ui.warnings.length, 1);
  assert.equal(ui.reloads, 0);
  ui.advance(60000);
  await ui.window.emitAsync('online');
  assert.equal(ui.updateChecks, 2);
});

test('small offline fallback and security headers stay in scope without claiming full app readiness', async () => {
  for (const prefix of ['/', '/go/', '/en/latest/_static/']) {
    const scope = 'https://example.com' + prefix;
    const stored = new Map();
    const handlers = new Map();
    const cache = {
      async match(key) { return stored.get(key.url || key)?.clone(); },
      async put(key, value) { stored.set(key.url || key, value.clone()); },
      async keys() { return [...stored.keys()].map(url => new Request(url)); },
      async delete(key) { return stored.delete(key.url || key); },
    };
    const files = { 'offline.html': '<html><head></head><body>offline</body></html>', 'icon-192x192.png': 'png' };
    const assets = Object.entries(files).map(([relative, bytes]) => ({
      relative, sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(relative.endsWith('.html') ? { source: relative + '.offline' } : {}),
    }));
    let available = false;
    let calls = 0;
    const context = vm.createContext({
      URL, Request, Response, Headers, btoa, console,
      caches: { async open(name) { assert.equal(name, 'datax-pwa-fallback-v1'); return cache; } },
      self: {
        location: { href: scope + 'service-worker.js?enableCache=true' },
        addEventListener(type, handler) { handlers.set(type, handler); },
        async dataxFetchOfflineAsset(request) {
          const name = new URL(request.url).pathname.slice(prefix.length).replace(/\.offline$/, '');
          assert.equal(request.integrity, 'sha256-' + createHash('sha256').update(files[name]).digest('base64'));
          return new Response(files[name]);
        },
      },
      async maybeFromCache() { calls++; if (!available) throw new TypeError('offline'); return new Response('app'); },
    });
    vm.runInContext(`(${pwa.installPwaNavigation.toString()})(${JSON.stringify(assets)},
      ${JSON.stringify(pwa.CONTENT_SECURITY_POLICY)}, ${JSON.stringify(pwa.PERMISSIONS_POLICY)});`, context);
    let installation;
    handlers.get('install')({ waitUntil: value => { installation = value; } });
    await installation;
    assert.equal(stored.size, 2);
    assert.ok(![...stored.keys()].some(key => key.includes('datax-offline-ready')));
    const request = { url: scope + 'lab/index.html?path=other.ipynb', mode: 'navigate', method: 'GET', headers: new Headers() };
    const result = await context.maybeFromCache({ request, waitUntil() {} });
    assert.equal(result.status, 503);
    assert.match(await result.text(), new RegExp(`<base href="${prefix}">`));
    assert.equal(result.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(result.headers.get('Content-Security-Policy'), pwa.CONTENT_SECURITY_POLICY);
    assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
    available = true;
    const online = await context.maybeFromCache({ request, waitUntil() {} });
    assert.equal(await online.text(), 'app');
    assert.equal(online.headers.get('Permissions-Policy'), pwa.PERMISSIONS_POLICY);
    const image = await context.maybeFromCache({ request: { ...request, url: scope + 'icon-192x192.png', mode: 'cors' }, waitUntil() {} });
    assert.equal(await image.text(), 'png');
    assert.equal(calls, 2, 'cached fallback assets do not download again');
    const before = stored.size;
    await context.maybeFromCache({ request: { ...request, headers: new Headers({ Range: 'bytes=0-10' }) }, waitUntil() {} });
    assert.equal(calls, 3, 'byte ranges bypass fallback cache');
    assert.equal(stored.size, before);
    stored.set(scope + 'offline.html?sha256=old', new Response('old'));
    let activation;
    handlers.get('activate')({ waitUntil: value => { activation = value; } });
    await activation;
    assert.equal(stored.size, 2, 'only the current fallback version is retained');
  }
});

test('full offline download stores assets already cached by the PWA fallback', async () => {
  const icon = { 'icon-192x192.png': 'png' };
  const app = {
    ...icon,
    'offline.html': '<html><head></head><body>offline</body></html>',
    'lab/index.html': '<html><head></head><body>app</body></html>',
    'xeus/runtime.wasm': 'runtime',
  };
  for (const [prefix, files] of [['/', icon], ['/', app], ['/go/', app], ['/en/latest/_static/', app]]) {
    const scope = 'https://example.com' + prefix;
    const stores = new Map();
    const handlers = new Map();
    const assets = Object.fromEntries(Object.entries(files).map(([relative, body]) => [relative, {
      sha256: createHash('sha256').update(body).digest('hex'), size: Buffer.byteLength(body),
      ...(relative.endsWith('.html') ? { source: relative + '.offline' } : {}),
    }]));
    const hashes = Object.fromEntries(Object.entries(assets)
      .filter(([relative]) => relative.startsWith('xeus/')).map(([relative, asset]) => [relative, asset.sha256]));
    let online = true;
    let rejectIconWrites = false;
    const requests = [];
    const context = vm.createContext({
      URL, Request, Response, Headers, btoa, atob, AbortController,
      crypto: globalThis.crypto, setTimeout, clearTimeout, console,
      caches: { async open(name) {
        if (!stores.has(name)) stores.set(name, new Map());
        const stored = stores.get(name);
        return {
          async match(key) { return stored.get(key.url ?? key)?.clone(); },
          async put(key, response) {
            if (rejectIconWrites && name === 'datax-runtime-sha256-v2'
                && (key.url ?? key).includes('icon-192x192.png')) {
              throw Object.assign(new Error('Storage quota exceeded'), { name: 'QuotaExceededError' });
            }
            stored.set(key.url ?? key, response.clone());
          },
          async keys() { return [...stored.keys()].map(url => new Request(url)); },
        };
      } },
      self: {
        location: { href: scope + 'service-worker.js?enableCache=true' },
        addEventListener(type, handler) {
          if (!handlers.has(type)) handlers.set(type, []);
          handlers.get(type).push(handler);
        },
      },
      async maybeFromCache(event) { return context.fetch(event.request); },
      async fetch(request) {
        assert.equal(online, true, 'offline request must use cached bytes: ' + request.url);
        const relative = new URL(request.url).pathname.slice(prefix.length).replace(/\.offline$/, '');
        requests.push(relative);
        assert.ok(files[relative], relative);
        return new Response(files[relative]);
      },
    });
    vm.runInContext(
      `(${fingerprints.installRuntimeCache.toString()})(${JSON.stringify(hashes)});` +
      `(${offline.installOfflineCache.toString()})(${JSON.stringify(assets)});` +
      `(${pwa.installPwaNavigation.toString()})(${JSON.stringify(pwa.fallbackInventory(assets))},
        ${JSON.stringify(pwa.CONTENT_SECURITY_POLICY)}, ${JSON.stringify(pwa.PERMISSIONS_POLICY)});`,
      context,
    );
    const dispatch = async (type, extra = {}) => {
      const tasks = [];
      for (const handler of handlers.get(type)) handler({ ...extra, waitUntil(task) { tasks.push(task); } });
      await Promise.all(tasks);
    };
    const send = async type => {
      const updates = [];
      await dispatch('message', {
        data: { type }, source: { url: scope + 'lab/' },
        ports: [{ postMessage(update) { updates.push(update); } }],
      });
      return updates.at(-1);
    };
    await dispatch('install');
    assert.equal(stores.get('datax-pwa-fallback-v1').size, pwa.fallbackInventory(assets).length);
    assert.equal((await send('datax-offline-status')).ready, false);
    requests.length = 0;
    const result = await send('datax-offline-download');
    assert.equal(result.ready, true, result.error);
    assert.equal(result.completed, Object.keys(assets).length);
    assert.equal(result.bytes, result.totalBytes);
    const runtime = stores.get('datax-runtime-sha256-v2');
    for (const [relative, asset] of Object.entries(assets)) {
      const key = scope + relative + '?sha256=' + asset.sha256
        + (relative.startsWith('xeus/') ? '&verified=local' : '');
      assert.equal(await runtime.get(key)?.clone().text(), files[relative], relative);
    }
    assert.ok(runtime.has(scope + 'datax-offline-ready'));
    online = false;
    const count = requests.length;
    assert.equal((await send('datax-offline-download')).ready, true, 'a completed download can be retried offline');
    for (const [relative, body] of Object.entries(files)) {
      const response = await context.maybeFromCache({ request: new Request(scope + relative), waitUntil() {} });
      assert.equal(await response.text(), body);
    }
    assert.equal(requests.length, count);
    const iconKey = scope + 'icon-192x192.png?sha256=' + assets['icon-192x192.png'].sha256;
    runtime.delete(iconKey);
    online = true;
    rejectIconWrites = true;
    const failed = await send('datax-offline-download');
    assert.equal(failed.ready, false, 'the fallback cache must not mask a failed full-cache write');
    assert.match(failed.error, /icon-192x192\.png: Unable to store .*QuotaExceededError: Storage quota exceeded/);
    assert.equal((await send('datax-offline-status')).ready, false);
    rejectIconWrites = false;
    requests.length = 0;
    assert.equal((await send('datax-offline-download')).ready, true);
    assert.deepEqual(requests, ['icon-192x192.png'], 'retries must reuse other fully cached assets');
  }
});

test('offline download checks quota, reports persistence failures, and prevents concurrent starts', async () => {
  for (const enoughStorage of [false, true]) {
    const elements = [];
    const makeElement = tag => {
      const element = { ...emitter(), tag, dataset: {}, children: [], setAttribute() {},
        append(...children) { this.children.push(...children); } };
      elements.push(element);
      return element;
    };
    const document = { ...emitter(), createElement: makeElement,
      head: makeElement('head'), body: makeElement('body'), querySelector: () => null, visibilityState: 'visible' };
    const requests = [];
    const state = { totalBytes: 10 * 1048576, bytes: 0, total: 10, completed: 0, ready: false };
    const worker = { ...emitter(), ready: Promise.resolve(), controller: {
      postMessage(data, [port]) { requests.push(data.type); port.postMessage(state); },
    } };
    let confirms = 0;
    let persistenceRequests = 0;
    const errors = [];
    const warnings = [];
    const context = vm.createContext({
      document, window: { ...emitter() },
      navigator: { onLine: true, serviceWorker: worker, storage: {
        async estimate() { return { quota: enoughStorage ? 100 * 1048576 : 5 * 1048576, usage: 0 }; },
        async persist() { persistenceRequests++; return false; },
      } },
      confirm() { confirms++; return true; },
      console: { info() {}, warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
      MutationObserver: class { observe() {} disconnect() {} },
      MessageChannel: class {
        constructor() {
          this.port1 = { onmessage: null, close() {} };
          this.port2 = { postMessage: data => this.port1.onmessage?.({ data }) };
        }
      },
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
    });
    vm.runInContext(`${offline.offlineStatusText.toString()}
      (${offline.installOfflineUI.toString()})();`, context);
    await new Promise(resolve => setImmediate(resolve));
    const panel = elements.find(element => element.id === 'datax-offline-control');
    const [label, button] = panel.children;
    button.emit('click');
    button.emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(confirms, 1);
    assert.equal(requests.filter(type => type === 'datax-offline-download').length, enoughStorage ? 1 : 0);
    assert.equal(persistenceRequests, enoughStorage ? 1 : 0);
    if (enoughStorage) {
      assert.equal(warnings.length, 1, 'a declined persistence request must be reported');
    } else {
      assert.match(label.textContent, /Not enough browser storage/);
      assert.equal(button.disabled, false);
      assert.equal(errors.length, 1);
    }
    const before = requests.length;
    document.emit('visibilitychange');
    assert.equal(requests.length, before + 1, 'returning from background refreshes offline state');
  }
});

test('offline control floats above the status bar on narrow screens and docks into it on wide screens', () => {
  const makeElement = tag => ({ ...emitter(), tag, dataset: {}, children: [], parentElement: null, setAttribute() {},
    append(...children) {
      for (const child of children) {
        if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
        child.parentElement = this;
        this.children.push(child);
      }
    } });
  const bar = makeElement('div');
  let barReady = false;
  let mutate;
  let disconnected = false;
  const media = { ...emitter(), matches: true };
  const document = { ...emitter(), createElement: makeElement, head: makeElement('head'), body: makeElement('body'),
    querySelector: selector => (selector === '.jp-StatusBar-Right' && barReady ? bar : null), visibilityState: 'visible' };
  const context = vm.createContext({
    document, window: { ...emitter(), matchMedia: query => { assert.equal(query, '(max-width: 600px)'); return media; } },
    navigator: { onLine: true, serviceWorker: { ...emitter(), ready: new Promise(() => {}), controller: null } },
    console: { info() {}, warn() {}, error() {} },
    MutationObserver: class {
      constructor(callback) { mutate = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(`${offline.offlineStatusText.toString()}
    (${offline.installOfflineUI.toString()})();`, context);
  const panel = document.body.children.find(element => element.id === 'datax-offline-control');
  assert.equal(panel.dataset.floating, '');
  barReady = true;
  mutate();
  assert.equal(disconnected, true);
  assert.equal(panel.parentElement, document.body, 'the 24px status bar would clip 44px touch targets on phones');
  assert.equal(panel.dataset.floating, '');
  media.matches = false;
  media.emit('change');
  assert.equal(panel.parentElement, bar);
  assert.equal('floating' in panel.dataset, false);
  assert.equal(document.body.children.includes(panel), false);
  media.matches = true;
  media.emit('change');
  assert.equal(panel.parentElement, document.body);
  const style = document.head.children.find(element => element.tag === 'style').textContent;
  assert.match(style, /\[data-floating\]\{bottom:calc\(env\(safe-area-inset-bottom,0px\) \+ var\(--jp-statusbar-height,24px\)\)/);
});

test('host policies match the shared service-worker policies and do not disable notebook execution', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
  const headers = new Map(vercel.headers[0].headers.map(header => [header.key, header.value]));
  assert.equal(headers.get('Content-Security-Policy'), pwa.CONTENT_SECURITY_POLICY);
  assert.equal(headers.get('Permissions-Policy'), pwa.PERMISSIONS_POLICY);
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('Strict-Transport-Security'), 'max-age=31536000');
  assert.doesNotMatch(pwa.CONTENT_SECURITY_POLICY, /script-src|connect-src|default-src/);
  const cloudflare = readFileSync(new URL('../cloudflare/_headers', import.meta.url), 'utf8');
  assert.ok(cloudflare.includes(pwa.CONTENT_SECURITY_POLICY));
  assert.match(cloudflare, /Strict-Transport-Security: max-age=31536000/);
  const css = readFileSync(new URL('../assets/datax-pwa.css', import.meta.url), 'utf8');
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /touch-action: manipulation/);
  assert.match(css, /#jp-plugin-playground-log-badge \{\s*bottom: calc\(var\(--datax-safe-bottom\) \+ 88px\)/, 'log badge clears the floating offline control');
  const rtd = readFileSync(new URL('../.readthedocs.yaml', import.meta.url), 'utf8');
  assert.ok(rtd.indexOf('python scripts/deployment-artifact.py restore') <
    rtd.indexOf('node scripts/pwa.cjs verify dist'), 'RTD verifies the restored artifact before Sphinx publishes it');
  const prepareSite = readFileSync(new URL('../.github/actions/prepare-site/action.yml', import.meta.url), 'utf8');
  assert.match(prepareSite, /node scripts\/pwa\.cjs verify dist/);
  const build = readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
  assert.ok(build.indexOf('scripts/fingerprint-runtime.cjs') < build.indexOf('scripts/pwa.cjs" verify dist'));
});
