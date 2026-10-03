import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import test from "node:test";
import fingerprints from "./fingerprint-runtime.cjs";
import startup from "./patch-wasm-startup.cjs";
import offline from "./offline-cache.cjs";

const root = new URL("../", import.meta.url);
test("duplicate libraries are removed only after worker fetch aliases are installed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-library-dedup-"));
  const runtime = "xeus/xeus-python-wasm-host/";
  const extension = "extensions/@jupyterlite/xeus-extension/static/";
  try {
    for (const folder of [runtime, runtime + "bin/", extension]) mkdirSync(join(directory, folder), { recursive: true });
    writeFileSync(join(directory, runtime, "libR.so.asm"), "shared library");
    writeFileSync(join(directory, runtime + "bin/", "libR.so.asm"), "shared library");
    writeFileSync(join(directory, extension, "libR.so.asm"), "shared library");
    writeFileSync(join(directory, runtime, "different.so.asm"), "canonical");
    writeFileSync(join(directory, extension, "different.so.asm"), "different");
    assert.throws(() => startup.compactLibraries(directory), /without a kernel worker/);
    assert.equal(readFileSync(join(directory, runtime + "bin/", "libR.so.asm"), "utf8"), "shared library");
    writeFileSync(join(directory, extension, "kernel.worker.test.js"), "globalThis.started = true;");
    assert.deepEqual(startup.compactLibraries(directory), { removedFiles: 2, savedBytes: 28 });
    assert.throws(() => readFileSync(join(directory, runtime + "bin/", "libR.so.asm")), /ENOENT/);
    assert.equal(readFileSync(join(directory, extension, "different.so.asm"), "utf8"), "different");
    assert.deepEqual(startup.compactLibraries(directory), { removedFiles: 0, savedBytes: 0 });
    for (const prefix of ["/", "/go/", "/en/latest/_static/"]) {
      const calls = [];
      const context = vm.createContext({
        URL, Request,
        location: { href: `https://example.com${prefix}${extension}kernel.worker.test.js` },
        fetch(input, options) { calls.push([input, options]); return Promise.resolve(new Response("ok")); },
      });
      vm.runInContext(readFileSync(join(directory, extension, "kernel.worker.test.js"), "utf8"), context);
      assert.equal(context.started, true);
      await context.fetch(new Request(`https://example.com${prefix}${runtime}bin/libR.so.asm?x=1`, {
        headers: { Range: "bytes=0-3" }, credentials: "omit",
      }));
      assert.equal(calls[0][0].url, `https://example.com${prefix}${runtime}libR.so.asm?x=1`);
      assert.equal(calls[0][0].headers.get("Range"), "bytes=0-3");
      assert.equal(calls[0][0].credentials, "omit");
      await context.fetch("./libR.so", { cache: "no-cache" });
      assert.equal(calls[1][0], `https://example.com${prefix}${runtime}libR.so.asm`);
      assert.equal(calls[1][1].cache, "no-cache");
      const external = `https://other.example${prefix}${extension}libR.so.asm`;
      await context.fetch(external);
      assert.equal(calls[2][0], external);
    }
    writeFileSync(join(directory, extension, "kernel.worker.test.js"), "");
    writeFileSync(join(directory, runtime, "custom.so.bin"), "custom");
    writeFileSync(join(directory, extension, "custom.so.bin"), "custom");
    startup.compactLibraries(directory, ".bin");
    assert.match(readFileSync(join(directory, extension, "kernel.worker.test.js"), "utf8"),
      /static\/custom\.so":"xeus\/xeus-python-wasm-host\/custom\.so\.bin/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const build = readFileSync(new URL("build.sh", root), "utf8");
test("build does not generate a deployment archive", () => {
  assert.doesNotMatch(build, /DATAX_BUILD_ARCHIVE|datax-now\.zip|zipfile/);
});

test("Vercel allows cross-origin reads for verified mirror assets", () => {
  const config = JSON.parse(readFileSync(new URL("vercel.json", root), "utf8"));
  const allAssets = config.headers.find(({ source }) => source === "/(.*)");
  assert.ok(allAssets.headers.some(({ key, value }) => key === "Access-Control-Allow-Origin" && value === "*"));
});

test("build publishes local package assets without generator scripts", () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-built-in-publish-"));
  const conda = join(directory, "source/conda");
  const wheels = join(directory, "source/wheels");
  const destination = join(directory, "dist/built-in-local");
  const publish = build.split('echo "Publishing built-in local package store..."')[1]
    ?.split('echo "Normalizing empack metadata and writing built-in local manifest..."')[0];
  try {
    assert.ok(publish, "build publication block should exist");
    mkdirSync(join(conda, "noarch"), { recursive: true });
    mkdirSync(join(conda, "emscripten-wasm32"), { recursive: true });
    mkdirSync(wheels, { recursive: true });
    writeFileSync(join(conda, "generate_repodata.py"), "build helper");
    writeFileSync(join(conda, "noarch/repodata.json"), "{}");
    writeFileSync(join(conda, "noarch/demo.conda"), "package");
    writeFileSync(join(wheels, "generate_index.py"), "build helper");
    writeFileSync(join(wheels, "index.json"), '{"packages":{}}');
    writeFileSync(join(wheels, "demo.whl"), "wheel");
    const result = spawnSync("bash", ["-c", `mamba_run_deploy() { :; }\n${publish}`], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUILTIN_CONDA_DIR: conda,
        BUILTIN_RUNTIME_WHEELS_DIR: wheels,
        BUILTIN_LOCAL_DIST_DIR: destination,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(destination, "conda/noarch/demo.conda"), "utf8"), "package");
    assert.equal(readFileSync(join(destination, "pip/demo.whl"), "utf8"), "wheel");
    assert.equal(readFileSync(join(destination, "pip/index.json"), "utf8"), '{"packages":{}}');
    assert.throws(() => readFileSync(join(destination, "conda/generate_repodata.py")), /ENOENT/);
    assert.throws(() => readFileSync(join(destination, "pip/generate_index.py")), /ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const patch = build.split('echo "Patching service worker cache version..."')[1]
  .split("python3 << 'EOFPATCH'\n")[1].split("\nEOFPATCH")[0];
const isolationHeadersPatch = build.split('echo "Patching service worker navigation responses for isolation headers..."')[1]
  .split("python3 << 'EOFPATCH'\n")[1].split("\nEOFPATCH")[0];
const staticHostBootstrapPatch = build.split('echo "Patching static-host app bootstrap for cross-origin isolation..."')[1]
  .split("python3 << 'EOFPATCH'\n")[1].split("\nEOFPATCH")[0];
const brandingPatch = build.split('echo "🎨 Applying DataX.now branding..."')[1]
  .split("python3 <<'PY'\n")[1].split("\nPY")[0];
const runtimeConfigPatch = build.split('echo "Restoring custom runtime config into built jupyter-lite.json files..."')[1]
  .split("python3 << 'EOFPATCH'\n")[1].split("\nEOFPATCH")[0];
const upstream = `const CACHE="precache";let enableCache=!1;
function onActivate(e){enableCache="true"===new URL(location.href).searchParams.get("enableCache"),e.waitUntil(self.clients.claim())}
async function onFetch(event){event.respondWith(maybeFromCache(event))}
async function maybeFromCache(e){let{request:a}=e;if(!enableCache)return await fetch(a);let t=await fromCache(a);return t?e.waitUntil(refetch(a)):(t=await fetch(a),e.waitUntil(updateCache(a,t.clone()))),t}
async function openCache(){return await caches.open("precache")}
async function fromCache(e){let a=await openCache(),t=await a.match(e);return t&&404!==t.status?t:null}
async function updateCache(request,response){return (await openCache()).put(request,response)}
async function refetch(e){let a=await fetch(e);return await updateCache(e,a),a}`;

test("built app configs preserve service-worker caching from the source config", () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-offline-config-"));
  try {
    mkdirSync(join(directory, "temp/jupyterlite-lite-dir"), { recursive: true });
    mkdirSync(join(directory, "dist/lab"), { recursive: true });
    writeFileSync(join(directory, "temp/jupyterlite-lite-dir/jupyter-lite.json"), readFileSync(new URL("jupyter-lite.json", root)));
    for (const relative of ["dist/jupyter-lite.json", "dist/lab/jupyter-lite.json"]) writeFileSync(join(directory, relative), "{}");
    const result = spawnSync("python3", ["-c", runtimeConfigPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    for (const relative of ["dist/jupyter-lite.json", "dist/lab/jupyter-lite.json"]) {
      const config = JSON.parse(readFileSync(join(directory, relative), "utf8"));
      assert.equal(config.enableServiceWorkerCache, true);
      assert.equal(config["jupyter-config-data"].enableServiceWorkerCache, true);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("manifest shortcuts stay within the deployment subpath", () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-manifest-scope-"));
  mkdirSync(join(directory, "dist"));
  try {
    writeFileSync(join(directory, "dist/manifest.webmanifest"), JSON.stringify({
      name: "JupyterLite", short_name: "JupyterLite", scope: "./", start_url: "./",
      icons: [
        { src: "./icon-120x120.png", type: "image/png", sizes: "120x120" },
        { src: "./icon-512x512.png", type: "image/png", sizes: "512x512" },
      ],
      shortcuts: [{ name: "JupyterLite", url: "/lab" }, { name: "Replite", url: "/repl?toolbar=1" }],
    }));
    const result = spawnSync("python3", ["-c", brandingPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(directory, "dist/manifest.webmanifest"), "utf8"));
    assert.equal(manifest.id, "./");
    assert.equal(manifest.theme_color, "#f7dc1e");
    assert.deepEqual(manifest.icons, [
      { src: "./icon-512x512.png", type: "image/png", sizes: "512x512", purpose: "any maskable" },
    ]);
    for (const shortcut of manifest.shortcuts) {
      assert.ok(new URL(shortcut.url, "https://example.com/datax-now/").pathname.startsWith("/datax-now/"));
    }
    assert.equal(manifest.shortcuts[1].url, "./repl?toolbar=1");
    const second = spawnSync("python3", ["-c", brandingPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "dist/manifest.webmanifest"), "utf8")), manifest);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("controlled app navigations add COOP and COEP without changing other responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-isolation-headers-"));
  mkdirSync(join(directory, "dist"));
  const workerPath = join(directory, "dist/service-worker.js");
  const generated = "async function onFetch(e){let n=maybeFromCache(e);n&&e.respondWith(n)}async function maybeFromCache(e){return await fetch(e.request)}";
  try {
    writeFileSync(workerPath, generated);
    const result = spawnSync("python3", ["-c", isolationHeadersPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const patched = readFileSync(workerPath, "utf8");
    const second = spawnSync("python3", ["-c", isolationHeadersPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(workerPath, "utf8"), patched, "patch should be idempotent");

    const sourceResponse = new Response("app shell", { status: 200, statusText: "OK" });
    const fetchCalls = [];
    let queuedResponses = [];
    const context = vm.createContext({
      Headers,
      Response,
      async fetch(input, options) {
        fetchCalls.push([input, options]);
        return queuedResponses.shift() ?? sourceResponse;
      },
    });
    vm.runInContext(patched, context);

    async function fetchThroughWorker(mode, destination = "", headers = new Headers()) {
      let intercepted;
      context.onFetch({
        request: {
          mode,
          destination,
          url: "https://example.com/lab/index.html",
          headers,
          credentials: "include",
        },
        respondWith(response) { intercepted = response; },
      });
      return intercepted;
    }

    const workerScript = await fetchThroughWorker("same-origin", "worker");
    assert.equal(workerScript.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    assert.equal(workerScript.headers.get("Cross-Origin-Resource-Policy"), "same-origin");

    const navigation = await fetchThroughWorker("navigate");
    assert.equal(navigation.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    assert.equal(navigation.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assert.equal(navigation.status, 200);
    assert.equal(navigation.statusText, "OK");
    assert.equal(await navigation.text(), "app shell");

    queuedResponses = [
      new Response(null, { status: 304 }),
      new Response("fresh app", { status: 200, statusText: "OK" }),
    ];
    const conditionalNavigation = await fetchThroughWorker(
      "navigate",
      "",
      new Headers({ "If-None-Match": 'W/"cached-app"' }),
    );
    assert.equal(conditionalNavigation.status, 200);
    assert.equal(conditionalNavigation.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    assert.equal(await conditionalNavigation.text(), "fresh app");
    assert.equal(fetchCalls[2][0].headers.get("If-None-Match"), 'W/"cached-app"');
    assert.equal(fetchCalls[3][0], "https://example.com/lab/index.html");
    assert.equal(fetchCalls[3][1].cache, "no-store");
    assert.equal(fetchCalls[3][1].credentials, "include");
    assert.equal(fetchCalls[3][1].mode, "same-origin");
    assert.equal(fetchCalls[3][1].headers.get("If-None-Match"), null);

    const subresource = await fetchThroughWorker("cors");
    assert.equal(subresource, sourceResponse, "subresource responses should pass through untouched");
    assert.equal(subresource.headers.has("Cross-Origin-Embedder-Policy"), false);

    writeFileSync(
      workerPath,
      patched.replace('headers.set("Cross-Origin-Opener-Policy","same-origin");', ""),
    );
    const upgrade = spawnSync("python3", ["-c", isolationHeadersPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.match(readFileSync(workerPath, "utf8"), /Cross-Origin-Opener-Policy/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("static-host app startup waits for an isolated service-worker-controlled page", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-static-host-bootstrap-"));
  mkdirSync(join(directory, "dist/lab"), { recursive: true });
  const appPath = join(directory, "dist/lab/index.html");
  writeFileSync(appPath, `<!doctype html><html><head>
<script>
(async function () {
  const { pathname, origin, search, hash } = window.location;
  if (!pathname.endsWith("index.html")) {
    window.location.href = origin + pathname + "/" + search + hash;
    return;
  }
  await import('../config-utils.js?_=test');
}.call(this));
</script>
<script id="datax-rtd-coep-bootstrap">legacy()</script>
</head><body></body></html>`);
  try {
    const result = spawnSync("python3", ["-c", staticHostBootstrapPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const html = readFileSync(appPath, "utf8");
    const bootstrap = html.match(/<script id="datax-rtd-coep-bootstrap">([\s\S]*?)<\/script>/)?.[1];
    const loader = html.match(/<script>([\s\S]*?datax-rtd-coep-loader-gate[\s\S]*?)<\/script>/)?.[1];
    assert.ok(bootstrap, "bootstrap should be inserted before the app loader");
    assert.ok(loader, "the JupyterLite loader should wait for the bootstrap");
    assert.ok(html.indexOf(bootstrap) < html.indexOf(loader));
    const appLoader = loader.replace(/await import\([\s\S]*?\);/, "globalThis.dataxAppStarted = true;");
    assert.doesNotMatch(appLoader, /await import\(/);

    function createPage(hostname, href, ready, sessionValues = new Map()) {
      let controller = null;
      let reloads = 0;
      const listeners = new Set();
      const registrations = [];
      const errors = [];
      const serviceWorker = {
        ready,
        get controller() { return controller; },
        register(url, options) {
          registrations.push({ url, options });
          return Promise.resolve({});
        },
        addEventListener(type, listener) { if (type === "controllerchange") listeners.add(listener); },
        removeEventListener(type, listener) { if (type === "controllerchange") listeners.delete(listener); },
      };
      const location = new URL(href);
      const context = vm.createContext({
        URL,
        location: {
          hostname,
          href: location.href,
          pathname: location.pathname,
          origin: location.origin,
          search: location.search,
          hash: location.hash,
          reload() { reloads++; },
        },
        navigator: { serviceWorker },
        crossOriginIsolated: false,
        sessionStorage: {
          getItem(key) { return sessionValues.get(key) ?? null; },
          setItem(key, value) { sessionValues.set(key, String(value)); },
          removeItem(key) { sessionValues.delete(key); },
        },
        document: {
          createElement() { return { style: {}, setAttribute() {} }; },
          documentElement: { append() {} },
        },
        console: {
          error(...args) { errors.push(args.join(" ")); },
          info() {},
          warn() {},
        },
        setTimeout,
        clearTimeout,
      });
      context.window = context;
      return {
        context,
        registrations,
        errors,
        sessionValues,
        setController(value) { controller = value; },
        controllerChanged() { for (const listener of listeners) listener(); },
        get controllerListeners() { return listeners.size; },
        get reloads() { return reloads; },
      };
    }

    for (const [hostname, href, scope] of [
      ["datax-now.readthedocs.io", "https://datax-now.readthedocs.io/en/latest/_static/lab/index.html", "/en/latest/_static/"],
      ["datax-now.github.io", "https://datax-now.github.io/go/lab/index.html", "/go/"],
    ]) {
      let resolveReady;
      const ready = new Promise(resolve => { resolveReady = resolve; });
      const page = createPage(hostname, href, ready);
      vm.runInContext(bootstrap, page.context);
      vm.runInContext(appLoader, page.context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(page.context.dataxAppStarted, undefined, `${hostname} must not start JupyterLite before service-worker control`);
      assert.equal(page.registrations.length, 1);
      assert.equal(page.registrations[0].url, new URL("../service-worker.js?enableCache=true", href).href);
      assert.equal(page.registrations[0].options.scope, scope);

      resolveReady({});
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(
        page.errors.length,
        0,
        `${hostname} should not fail while waiting for service-worker control: ${page.errors.join("; ")}`,
      );
      assert.equal(page.reloads, 0, `${hostname} should wait until the service worker controls the page`);
      assert.equal(page.controllerListeners, 1, `${hostname} should be waiting for controllerchange`);
      page.setController({});
      page.controllerChanged();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(
        page.errors.length,
        0,
        `${hostname} should not fail after controllerchange: ${page.errors.join("; ")}`,
      );
      assert.equal(page.reloads, 1, `${hostname} should reload after the service worker takes control`);
      assert.equal(page.context.dataxAppStarted, undefined, `${hostname} must not start JupyterLite in the reloading document`);
      assert.equal(page.errors.length, 0);

      page.context.crossOriginIsolated = true;
      vm.runInContext(bootstrap, page.context);
      vm.runInContext(appLoader, page.context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(page.context.dataxAppStarted, true, `${hostname} should start JupyterLite after isolation is available`);
      assert.equal(page.sessionValues.size, 0, "successful isolation should clear the retry counter");
    }

    const exhaustedState = new Map([["datax-static-host-isolation-attempts-v2", "3"]]);
    const exhausted = createPage(
      "datax-now.github.io",
      "https://datax-now.github.io/go/lab/index.html",
      Promise.resolve({}),
      exhaustedState,
    );
    vm.runInContext(bootstrap, exhausted.context);
    vm.runInContext(appLoader, exhausted.context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(exhausted.context.dataxAppStarted, undefined, "the app must stay stopped if isolation cannot be enabled");
    assert.equal(exhausted.errors.length, 1, "the blocked app should report an explicit error");
    assert.equal(exhausted.sessionValues.size, 0, "the user should be able to retry after reloading");

    const preview = createPage(
      "datax-preview.vercel.app",
      "https://datax-preview.vercel.app/lab/index.html",
      Promise.resolve({}),
    );
    vm.runInContext(bootstrap, preview.context);
    vm.runInContext(appLoader, preview.context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(preview.context.dataxAppStarted, true, "direct-header deployments should not wait for a service worker reload");
    assert.equal(preview.registrations.length, 0);

    const patchedAgain = spawnSync("python3", ["-c", staticHostBootstrapPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(patchedAgain.status, 0, patchedAgain.stderr);
    const upgradedHtml = readFileSync(appPath, "utf8");
    assert.equal(upgradedHtml.split('id="datax-rtd-coep-bootstrap"').length - 1, 1);
    assert.equal(upgradedHtml.split("datax-rtd-coep-loader-gate").length - 1, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime cache rejects mismatched bytes and retries without poisoning the hash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-integrity-"));
  const stored = new Map();
  const tasks = [];
  let body = "previous deployment";
  let downloads = 0;
  try {
    mkdirSync(join(directory, "xeus"));
    writeFileSync(join(directory, "xeus/runtime.wasm"), "current deployment");
    writeFileSync(join(directory, "service-worker.js"), "");
    fingerprints.fingerprintRuntime(directory);
    const context = vm.createContext({
      URL, Request, Response, btoa,
      self: { addEventListener() {}, location: { href: "https://example.com/service-worker.js?enableCache=true" } },
      caches: { async open() { return {
        async match(key) { return stored.get(key)?.clone(); },
        async put(key, response) { stored.set(key, response.clone()); },
        async keys() { return [...stored.keys()].map(key => new Request(key)); },
        async delete(request) { return stored.delete(request.url); },
      }; } },
      async maybeFromCache() { throw new Error("Unexpected fallback"); },
      async fetch(request) {
        downloads++;
        assert.equal(request.cache, "no-cache");
        return fetch(`data:application/octet-stream,${encodeURIComponent(body)}`, {
          integrity: request.integrity,
        });
      },
    });
    vm.runInContext(readFileSync(join(directory, "service-worker.js"), "utf8"), context);
    const event = {
      request: new Request("https://example.com/xeus/runtime.wasm"),
      waitUntil(task) { tasks.push(task); },
    };
    await assert.rejects(context.maybeFromCache(event), /fetch failed/);
    await Promise.all(tasks);
    assert.equal(stored.size, 0);
    body = "current deployment";
    assert.equal(await (await context.maybeFromCache(event)).text(), body);
    await Promise.all(tasks);
    assert.equal(stored.size, 1);
    assert.equal(await (await context.maybeFromCache(event)).text(), body);
    assert.equal(downloads, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("RTD challenges retry fingerprinted runtime assets and the web manifest", async () => {
  const requests = [];
  const packageHash = createHash("sha256").update("verified package").digest("hex");
  const packageIntegrity = `sha256-${Buffer.from(packageHash, "hex").toString("base64")}`;
  const mirrorPackageHash = createHash("sha256").update("mirror build package").digest("hex");
  const mirrorPackageIntegrity = `sha256-${Buffer.from(mirrorPackageHash, "hex").toString("base64")}`;
  const packagePath = "xeus/xeus-python-wasm-host/kernel_packages/openssl-4.0.2-hb2bca66_0.tar.gz";
  const runtimePath = "xeus/xeus-python-wasm-host/xpython.wasm";
  let failRtdRequest = false;
  let clock = 0;
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa,
    Date: { now: () => clock },
    location: { href: "https://datax-now.readthedocs.io/en/latest/_static/service-worker.js" },
    caches: { async open() { return {
      async match() { return null; },
      async put() {},
      async keys() { return []; },
      async delete() { return false; },
    }; } },
    async fetch(request) {
      requests.push(request);
      if (new URL(request.url).origin === "https://datax-now.readthedocs.io") {
        if (failRtdRequest) throw new TypeError("Failed to fetch");
        return new Response("RTD rate limit", { status: 429 });
      }
      if (new URL(request.url).pathname === "/go/manifest.webmanifest") {
        return new Response('{"name":"DataX.now"}', { status: 200 });
      }
      if (new URL(request.url).pathname === "/go/deployment.json") {
        return new Response(JSON.stringify({ files: { [packagePath]: { sha256: mirrorPackageHash } } }));
      }
      const body = request.url.endsWith(packagePath) ? "mirror build package" : "verified package";
      return fetch(`data:application/octet-stream,${encodeURIComponent(body)}`, {
        integrity: request.integrity,
      });
    },
  });
  vm.runInContext("maybeFromCache = async event => fetch(event.request)", context);
  context.self = context;
  context.hashes = { [packagePath]: packageHash, [runtimePath]: packageHash };
  vm.runInContext(`(${fingerprints.installRuntimeCache.toString()})(hashes, "https://datax-now.github.io/go/")`, context);

  const response = await context.maybeFromCache({ request: new Request(
    `https://datax-now.readthedocs.io/en/latest/_static/${packagePath}`,
    {
      headers: { Authorization: "Bearer private" },
    },
  ), waitUntil() {} });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "mirror build package");
  assert.equal(requests.length, 3);
  assert.equal(new URL(requests[1].url).href, "https://datax-now.github.io/go/deployment.json");
  assert.equal(new URL(requests[2].url).href,
    "https://datax-now.github.io/go/xeus/xeus-python-wasm-host/kernel_packages/openssl-4.0.2-hb2bca66_0.tar.gz");
  assert.equal(requests[2].mode, "cors");
  assert.equal(requests[2].credentials, "omit");
  assert.equal(requests[2].headers.has("Authorization"), false);
  assert.equal(requests[2].integrity, mirrorPackageIntegrity, "mirror bytes are checked against the mirror's own manifest");

  clock += 61000;
  const manifest = await context.maybeFromCache({
    request: new Request("https://datax-now.readthedocs.io/en/latest/_static/manifest.webmanifest"),
    waitUntil() {},
  });
  assert.equal(manifest.status, 200);
  assert.equal(await manifest.text(), '{"name":"DataX.now"}');
  assert.equal(new URL(requests[4].url).href, "https://datax-now.github.io/go/manifest.webmanifest");
  assert.equal(requests[4].credentials, "omit");
  assert.equal(requests[4].integrity, "", "manifest fallback does not claim runtime integrity");

  clock += 61000;
  const runtime = await context.maybeFromCache({
    request: new Request(
      `https://datax-now.readthedocs.io/en/latest/_static/${runtimePath}`,
    ),
    waitUntil() {},
  });
  assert.equal(runtime.status, 200);
  assert.equal(new URL(requests[6].url).href, "https://datax-now.github.io/go/xeus/xeus-python-wasm-host/xpython.wasm");
  assert.equal(requests[6].integrity, packageIntegrity, "runtime mirror response remains integrity-checked");

  const unrelated = await context.maybeFromCache({
    request: new Request("https://datax-now.readthedocs.io/en/latest/_static/jupyter-lite.json"),
    waitUntil() {},
  });
  assert.equal(unrelated.status, 429);
  assert.equal(requests.length, 8, "unrelated RTD rate limits must not retry on the mirror");

  clock += 61000;
  failRtdRequest = true;
  const failedNetworkRequest = await context.maybeFromCache({
    request: new Request(
      `https://datax-now.readthedocs.io/en/latest/_static/${packagePath}`,
    ),
    waitUntil() {},
  });
  assert.equal(failedNetworkRequest.status, 200);
  assert.equal(requests.length, 10, "a rejected RTD fetch should retry once on the mirror");
  assert.equal(new URL(requests[9].url).origin, "https://datax-now.github.io");
  assert.equal(new URL(requests[9].url).pathname,
    "/go/xeus/xeus-python-wasm-host/kernel_packages/openssl-4.0.2-hb2bca66_0.tar.gz");
});

test("failed hosts fail over in priority order, skipping stale mirrors and cooling hosts", async () => {
  const release = "a".repeat(40);
  const runtimePath = "xeus/xeus-python-wasm-host/xpython.wasm";
  const bytes = "runtime bytes";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const requests = [];
  let clock = 0;
  const manifests = {
    "https://datax.now/deployment.json": { commit: "b".repeat(40), files: { [runtimePath]: { sha256: "c".repeat(64) } } },
    "https://datax-now.pages.dev/deployment.json": { commit: release, files: { [runtimePath]: { sha256 } } },
  };
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa,
    Date: { now: () => clock },
    location: { href: "https://datax-now.github.io/go/service-worker.js" },
    caches: { async open() { throw new Error("cache disabled"); } },
    async fetch(request) {
      requests.push(request.url);
      const url = new URL(request.url);
      if (url.origin === "https://datax-now.github.io" && clock < 61000) return new Response("", { status: 503 });
      if (url.origin === "https://datax-now.readthedocs.io") return new Response("", { status: 429 });
      if (manifests[request.url]) return new Response(JSON.stringify(manifests[request.url]));
      return fetch(`data:application/octet-stream,${encodeURIComponent(bytes)}`, { integrity: request.integrity });
    },
  });
  vm.runInContext("maybeFromCache = async event => fetch(event.request)", context);
  context.self = context;
  context.hashes = { [runtimePath]: sha256 };
  context.mirrors = fingerprints.DEFAULT_MIRROR_ORIGINS;
  vm.runInContext(`(${fingerprints.installRuntimeCache.toString()})(hashes, mirrors, "${release}")`, context);
  const load = () => context.maybeFromCache({
    request: new Request(`https://datax-now.github.io/go/${runtimePath}`),
    waitUntil() {},
  });

  assert.equal(await (await load()).text(), bytes);
  assert.deepEqual(requests, [
    `https://datax-now.github.io/go/${runtimePath}`,
    "https://datax-now.readthedocs.io/en/latest/_static/deployment.json",
    `https://datax-now.readthedocs.io/en/latest/_static/${runtimePath}`,
    "https://datax.now/deployment.json",
    "https://datax-now.pages.dev/deployment.json",
    `https://datax-now.pages.dev/${runtimePath}`,
  ], "priority order is RTD, Vercel, Cloudflare after GitHub Pages fails; the stale Vercel release is never used");

  requests.length = 0;
  assert.equal(await (await load()).text(), bytes);
  assert.deepEqual(requests, [`https://datax-now.pages.dev/${runtimePath}`],
    "hosts in cooldown are skipped without another round trip");

  requests.length = 0;
  clock += 61000;
  assert.equal(await (await load()).text(), bytes);
  assert.deepEqual(requests, [`https://datax-now.github.io/go/${runtimePath}`],
    "the preferred host is used again once its cooldown expires");
});

test("mirrors on another release serve byte-identical runtime files", async () => {
  const runtimePath = "xeus/xeus-python-wasm-host/stats.so.asm";
  const bytes = "shared library";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const requests = [];
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, Date,
    location: { href: "https://datax-now.readthedocs.io/en/latest/_static/service-worker.js" },
    caches: { async open() { throw new Error("cache disabled"); } },
    async fetch(request) {
      requests.push(request.url);
      const url = new URL(request.url);
      // A Cloudflare challenge page fails the SRI check as a network error.
      if (url.hostname.endsWith("readthedocs.io")) throw new TypeError("Failed to fetch. SRI's integrity checks failed.");
      if (url.pathname.endsWith("/deployment.json")) {
        return new Response(JSON.stringify({ commit: "d".repeat(40), files: { [runtimePath]: { sha256 } } }));
      }
      return fetch(`data:application/octet-stream,${encodeURIComponent(bytes)}`, { integrity: request.integrity });
    },
  });
  vm.runInContext("maybeFromCache = async event => fetch(event.request)", context);
  context.self = context;
  context.hashes = { [runtimePath]: sha256 };
  context.mirrors = fingerprints.DEFAULT_MIRROR_ORIGINS;
  vm.runInContext(`(${fingerprints.installRuntimeCache.toString()})(hashes, mirrors, "${"a".repeat(40)}")`, context);
  const response = await context.maybeFromCache({
    request: new Request(`https://datax-now.readthedocs.io/en/latest/_static/${runtimePath}`),
    waitUntil() {},
  });
  assert.equal(await response.text(), bytes);
  assert.equal(requests.at(-1), `https://datax-now.github.io/go/${runtimePath}`);
});

test("hosts outside the deployment set never fail over", async () => {
  const requests = [];
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa,
    location: { href: "http://localhost:8000/service-worker.js" },
    async fetch(request) { requests.push(request.url); return new Response("", { status: 503 }); },
  });
  vm.runInContext("maybeFromCache = async event => fetch(event.request)", context);
  context.self = context;
  context.hashes = { "xeus/runtime.wasm": "a".repeat(64) };
  context.mirrors = fingerprints.DEFAULT_MIRROR_ORIGINS;
  vm.runInContext(`(${fingerprints.installRuntimeCache.toString()})(hashes, mirrors)`, context);
  const response = await context.maybeFromCache({
    request: new Request("http://localhost:8000/xeus/runtime.wasm"),
    waitUntil() {},
  });
  assert.equal(response.status, 503);
  assert.deepEqual(requests, ["http://localhost:8000/xeus/runtime.wasm"]);
});

test("range requests bypass both runtime and upstream caches", async () => {
  const context = vm.createContext({
    URL, Request, Response,
    self: { location: { href: "https://example.com/service-worker.js?enableCache=true" } },
    caches: { async open() { throw new Error("Unexpected cache access"); } },
    async maybeFromCache() { return new Response("full cached body"); },
    async fetch(request) {
      assert.equal(request.headers.get("Range"), "bytes=0-3");
      return new Response("part", { status: 206 });
    },
  });
  vm.runInContext(`(${fingerprints.installRuntimeCache.toString()})({});`, context);
  const response = await context.maybeFromCache({
    request: new Request("https://example.com/xeus/runtime.wasm", {
      headers: { Range: "bytes=0-3" },
    }),
    waitUntil() { throw new Error("Unexpected cache update"); },
  });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "part");
});

test("cross-origin fonts bypass service-worker caching", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-external-"));
  try {
    mkdirSync(join(directory, "dist/xeus/xeus-python-wasm-host"), { recursive: true });
    writeFileSync(join(directory, "dist/xeus/xeus-python-wasm-host/xpython.js"), "runtime");
    writeFileSync(join(directory, "dist/service-worker.js"), upstream);
    const result = spawnSync("python3", ["-c", patch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const second = spawnSync("python3", ["-c", patch], { cwd: directory, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(directory, "dist/service-worker.js"), "utf8").split("origin!==location.origin)return;").length, 2);
    const context = vm.createContext({
      URL, Request, Response, Headers,
      location: { href: "https://example.com/service-worker.js?enableCache=true", origin: "https://example.com" },
      self: { clients: { async claim() {} } },
      caches: { async open() { throw new Error("Cross-origin cache access"); } },
      async fetch() { return new Response("font"); },
    });
    vm.runInContext(readFileSync(join(directory, "dist/service-worker.js"), "utf8"), context);
    let intercepted = false;
    context.onFetch({
      request: new Request("https://fonts.googleapis.com/css2?family=Geist"),
      respondWith() { intercepted = true; },
    });
    assert.equal(intercepted, false, "external requests should use the browser network path");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service worker does not cache rate-limited manifest responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-manifest-"));
  try {
    mkdirSync(join(directory, "dist/xeus/xeus-python-wasm-host"), { recursive: true });
    writeFileSync(join(directory, "dist/xeus/xeus-python-wasm-host/xpython.js"), "runtime");
    writeFileSync(join(directory, "dist/service-worker.js"), upstream);
    const result = spawnSync("python3", ["-c", patch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    let writes = 0;
    const context = vm.createContext({
      URL, Request, Response, Headers,
      enableCache: true,
      location: { href: "https://example.com/service-worker.js?enableCache=true", origin: "https://example.com" },
      self: { clients: { async claim() {} } },
      caches: { async open() { return {
        async match() { return null; },
        async put() { writes++; },
      }; } },
      async fetch() { return new Response("Too Many Requests", { status: 429 }); },
    });
    vm.runInContext(readFileSync(join(directory, "dist/service-worker.js"), "utf8"), context);
    const tasks = [];
    const response = await context.maybeFromCache({
      request: new Request("https://example.com/manifest.webmanifest"),
      waitUntil(task) { tasks.push(task); },
    });
    await Promise.all(tasks);
    assert.equal(response.status, 429);
    assert.equal(writes, 0, "host rate limits must never become cached manifest responses");
    let downloads = 0;
    context.caches.open = async () => ({
      async match() { return new Response("old rate limit", { status: 429 }); },
      async put() { writes++; },
    });
    context.fetch = async () => { downloads++; return new Response("manifest", { status: 200 }); };
    assert.equal(await (await context.maybeFromCache({
      request: new Request("https://example.com/manifest.webmanifest"),
      waitUntil(task) { tasks.push(task); },
    })).text(), "manifest");
    assert.equal(downloads, 1, "previously cached rate limits must be ignored");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fingerprints reuse runtime bodies after restart and invalidate binary-only changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-fingerprints-"));
  const stored = new Map();
  let downloads = 0;
  let fallbackCalls = 0;
  const cache = {
    async match(key) { return stored.get(key)?.clone(); },
    async put(key, response) { stored.set(key, response.clone()); },
    async keys() { return [...stored.keys()].map(key => new Request(key)); },
    async delete(request) { return stored.delete(request.url); },
  };
  function startWorker() {
    const context = vm.createContext({
      URL, Request, Response, btoa,
      enableCache: false,
      self: { addEventListener() {}, location: { href: "https://example.com/_static/service-worker.js?enableCache=true" } },
      caches: { async open() { return cache; } },
      async maybeFromCache() { fallbackCalls++; return new Response("fallback"); },
      async fetch(request) {
        if (request.headers.has("Range")) return new Response("part", { status: 206 });
        downloads++;
        return new Response("runtime body");
      },
    });
    vm.runInContext(readFileSync(join(directory, "service-worker.js"), "utf8"), context);
    return context;
  }
  async function load(context, pathname = "xeus/runtime.wasm", options) {
    const tasks = [];
    const response = await context.maybeFromCache({
      request: new Request(`https://example.com/_static/${pathname}`, options),
      waitUntil(task) { tasks.push(task); },
    });
    const body = await response.text();
    await Promise.all(tasks);
    return body;
  }
  try {
    mkdirSync(join(directory, "xeus"));
    writeFileSync(join(directory, "xeus/runtime.wasm"), "binary-v1");
    writeFileSync(join(directory, "xeus/runtime.js"), "unchanged loader");
    writeFileSync(join(directory, "service-worker.js"), "");
    const first = fingerprints.fingerprintRuntime(directory);
    assert.match(first["xeus/runtime.wasm"], /^[a-f0-9]{64}$/);
    const worker = startWorker();
    assert.deepEqual(await Promise.all([load(worker), load(worker)]), ["runtime body", "runtime body"]);
    assert.equal(downloads, 1, "parallel kernels must share the first download");
    assert.equal(await load(startWorker()), "runtime body");
    assert.equal(downloads, 1, "reload must transfer no runtime body");
    assert.equal(await load(worker, "xeus/runtime.wasm", { headers: { Range: "bytes=0-3" } }), "part");
    assert.equal(await load(worker, "jupyter-lite.json"), "fallback");
    assert.equal(fallbackCalls, 1);
    writeFileSync(join(directory, "xeus/runtime.wasm"), "binary-v2");
    const second = fingerprints.fingerprintRuntime(directory);
    assert.notEqual(first["xeus/runtime.wasm"], second["xeus/runtime.wasm"]);
    assert.equal(first["xeus/runtime.js"], second["xeus/runtime.js"]);
    assert.equal(await load(startWorker()), "runtime body");
    assert.equal(downloads, 2, "changed binary must download once");
    assert.equal(stored.size, 1, "superseded versions of this file must be removed");
    const failing = startWorker();
    failing.caches.open = async () => { throw new Error("Storage unavailable"); };
    assert.equal(await load(failing), "runtime body");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime URL rewrites preserve validators and do not amplify rate limits or challenges", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-rewrite-"));
  try {
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist/service-worker.js"), "");
    for (const label of ["safe file extension conversion", "conda package URL extension fallback"]) {
      const section = build.split(`echo "Patching service worker for ${label}..."`)[1];
      const script = section.split("<< 'EOFPATCH'\n")[1].split("\nEOFPATCH")[0];
      const result = spawnSync("python3", ["-c", script], { cwd: directory, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const requests = [];
    let status = 304;
    let headers = {};
    let networkFailure = false;
    const context = vm.createContext({
      URL, Request,
      location: { href: "https://example.com/service-worker.js" },
      async fetch(input, init) {
        const request = new Request(input, init);
        requests.push(request);
        if (networkFailure) throw new TypeError("fetch failed");
        return new Response(null, { status, headers });
      },
    });
    context.self = context;
    vm.runInContext(readFileSync(join(directory, "dist/service-worker.js"), "utf8"), context);
    for (const [source, target] of [
      ["/xeus/library.so", "/xeus/library.so.asm"],
      ["/xeus/library.so.asm", "/xeus/library.so.asm"],
      ["/xeus/package.whl", "/xeus/package.whl.asm"],
      ["/emscripten-wasm32/package.tar.gz", "/emscripten-wasm32/package.tar.bz2"],
    ]) {
      requests.length = 0;
      const response = await context.fetch(new Request(`https://example.com${source}`, {
        headers: { "If-None-Match": '"runtime-v1"', Range: "bytes=0-9" },
        credentials: "include",
        integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        cache: "no-cache",
      }));
      assert.equal(requests.length, 1, "304 must not trigger alias retries");
      assert.equal(new URL(requests[0].url).pathname, target);
      assert.equal(requests[0].headers.get("If-None-Match"), '"runtime-v1"');
      assert.equal(requests[0].headers.get("Range"), "bytes=0-9");
      assert.equal(requests[0].credentials, "include");
      assert.equal(requests[0].integrity, "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
      assert.equal(requests[0].cache, "no-cache");
      assert.equal(response.status, 304);
    }
    for (const limitedStatus of [429, 503, 403]) {
      status = limitedStatus;
      headers = limitedStatus === 403 ? { "cf-mitigated": "challenge" } : { "Retry-After": "60" };
      requests.length = 0;
      const response = await context.fetch(new Request("https://example.com/xeus/library.so"));
      assert.equal(response.status, limitedStatus);
      assert.equal(requests.length, 1, "rate limits and challenges must not trigger alias retries");
    }
    networkFailure = true;
    requests.length = 0;
    await assert.rejects(context.fetch(new Request("https://example.com/xeus/library.so")), /fetch failed/);
    assert.equal(requests.length, 1, "network or integrity failures must not trigger alias retries");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline downloads recover indexed assets from mirrors only when their hashes match", async () => {
  const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
  const mirror = "https://datax-now.github.io/go/";
  const relative = "api/contents/how-to/all.json";
  const body = '{"notebooks":[]}';
  const sha256 = createHash("sha256").update(body).digest("hex");
  const runtimeRelative = "xeus/xeus-python-wasm-host/xpython.wasm";
  const runtimeBody = "verified kernel runtime";
  const runtimeHash = createHash("sha256").update(runtimeBody).digest("hex");
  const assets = {
    [relative]: { sha256, size: Buffer.byteLength(body) },
    [runtimeRelative]: { sha256: runtimeHash, size: Buffer.byteLength(runtimeBody) },
  };
  const hashes = { [runtimeRelative]: runtimeHash };
  const mirrorHashes = { [relative]: sha256, [runtimeRelative]: runtimeHash };
  const stored = new Map();
  const requests = [];
  let message;
  const cache = {
    async match(key) { return stored.get(key.url ?? key)?.clone(); },
    async put(key, response) { stored.set(key.url ?? key, response.clone()); },
    async keys() { return [...stored.keys()].map(key => new Request(key)); },
    async delete(key) { return stored.delete(key.url ?? key); },
  };
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, assets, hashes, mirrorHashes,
    mirrors: [mirror], buildCommit: "a".repeat(40),
    self: {
      location: { href: scope + "service-worker.js?enableCache=true" },
      addEventListener(type, listener) { if (type === "message") message = listener; },
    },
    caches: { async open() { return cache; } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch(request) {
      requests.push(request.url);
      const url = new URL(request.url);
      if (url.origin === new URL(scope).origin) throw new TypeError("Failed to fetch. SRI's integrity checks failed.");
      if (url.pathname === "/go/deployment.json") {
        return new Response(JSON.stringify({
          commit: "b".repeat(40), files: {
            [relative]: { sha256 }, [runtimeRelative]: { sha256: runtimeHash },
          },
        }));
      }
      const bytes = url.pathname.endsWith("/" + runtimeRelative) ? runtimeBody : body;
      return fetch("data:application/octet-stream," + encodeURIComponent(bytes), { integrity: request.integrity });
    },
  });
  vm.runInContext(
    `(${fingerprints.installRuntimeCache.toString()})(hashes, mirrors, buildCommit, mirrorHashes);` +
      `(${offline.installOfflineCache.toString()})(assets);`,
    context,
  );
  const updates = [];
  const tasks = [];
  message({
    data: { type: "datax-offline-download" }, source: { url: scope + "lab/" },
    ports: [{ postMessage(update) { updates.push(update); } }],
    waitUntil(task) { tasks.push(task); },
  });

  return Promise.all(tasks).then(async () => {
    assert.equal(updates.at(-1).ready, true);
    for (const path of [relative, runtimeRelative]) {
      assert.ok(requests.includes(scope + path));
      assert.ok(requests.includes(mirror + path));
    }
    assert.ok(requests.includes(mirror + "deployment.json"));
    assert.equal(stored.size, 3, "both assets and the offline-ready marker are cached");

    stored.clear();
    requests.length = 0;
    const unexpectedHash = createHash("sha256").update("different runtime").digest("hex");
    assets[runtimeRelative].sha256 = unexpectedHash;
    mirrorHashes[runtimeRelative] = unexpectedHash;
    const failedUpdates = [];
    const failedTasks = [];
    message({
      data: { type: "datax-offline-download" }, source: { url: scope + "lab/" },
      ports: [{ postMessage(update) { failedUpdates.push(update); } }],
      waitUntil(task) { failedTasks.push(task); },
    });
    await Promise.all(failedTasks);
    assert.equal(failedUpdates.at(-1).ready, false);
    assert.match(failedUpdates.at(-1).error, new RegExp(runtimeRelative));
    assert.equal(stored.has(scope + runtimeRelative + "?sha256=" + unexpectedHash), false,
      "different runtime bytes must not be cached under this build's hash");
  });
});

test("offline downloads resume, verify every asset, and survive worker restarts", async () => {
  const stored = new Map();
  const bodies = { "lab/index.html": "app shell", "extensions/%40jupyterlite/widget.js": "widget", "api/contents/all.json": "notebook", "xeus/runtime.wasm": "runtime", "xeus/xeus-python-wasm-host/meriyah.umd.min.js": "parser" };
  const assets = Object.fromEntries(Object.entries(bodies).map(([relative, body]) => [relative, {
    sha256: createHash("sha256").update(body).digest("hex"), size: body.length,
  }]));
  let online = true;
  let fail = "extensions/%40jupyterlite/widget.js";
  let rejectWrites = false;
  const downloads = [];
  const scope = "https://example.com/en/latest/_static/";
  const cache = {
    async match(key) { return stored.get(key)?.clone(); },
    async put(key, response) { if (rejectWrites) throw new Error("Quota exceeded"); stored.set(key, response.clone()); },
    async keys() { return [...stored.keys()].map(key => new Request(key)); },
    async delete(request) { return stored.delete(request.url); },
  };
  function startWorker() {
    let message;
    const context = vm.createContext({
      URL, Request, Response, btoa, assets,
      self: { location: { href: scope + "service-worker.js?enableCache=true" }, addEventListener(type, listener) { if (type === "message") message = listener; } },
      caches: { async open() { return cache; } },
      async maybeFromCache(event) { return context.fetch(event.request); },
      async fetch(request) {
        if (!online) throw new TypeError("Network is offline");
        const relative = new URL(request.url).pathname.slice(new URL(scope).pathname.length);
        downloads.push(relative);
        if (relative === fail) return new Response("unavailable", { status: 503 });
        assert.equal(request.integrity, "sha256-" + Buffer.from(assets[relative].sha256, "hex").toString("base64"));
        return new Response(bodies[relative]);
      },
    });
    context.hashes = Object.fromEntries(Object.entries(assets).filter(([relative]) => relative.startsWith("xeus/")).map(([relative, asset]) => [relative, asset.sha256]));
    vm.runInContext(`function shouldDrop(request, url) { return url.pathname.includes('/api/'); }
      (${fingerprints.installRuntimeCache.toString()})(hashes);(${offline.installOfflineCache.toString()})(assets);`, context);
    return {
      context,
      async send(type, source = scope + "lab/") {
        const updates = [];
        const tasks = [];
        message({ data: { type }, source: { url: source }, ports: [{ postMessage(update) { updates.push(update); } }], waitUntil(task) { tasks.push(task); } });
        await Promise.all(tasks);
        return updates;
      },
    };
  }
  const worker = startWorker();
  const failed = await worker.send("datax-offline-download");
  assert.match(failed.at(-1).error, /503/);
  assert.equal(failed.at(-1).ready, false);
  assert.equal(stored.size, 2);
  fail = null;
  downloads.length = 0;
  const resumed = await worker.send("datax-offline-download");
  assert.equal(resumed.at(-1).ready, true);
  assert.deepEqual(downloads, ["extensions/%40jupyterlite/widget.js", "xeus/runtime.wasm", "xeus/xeus-python-wasm-host/meriyah.umd.min.js"]);
  online = false;
  const restarted = startWorker();
  assert.equal((await restarted.send("datax-offline-status")).at(-1).ready, true);
  for (const [relative, body] of Object.entries(bodies)) {
    const request = new Request(scope + relative.replace("%40", "@") + "?cachebust=1");
    assert.equal(restarted.context.shouldDrop(request, new URL(request.url)), false);
    const response = await restarted.context.maybeFromCache({ request, waitUntil() {} });
    assert.equal(await response.text(), body);
  }
  const dynamic = new Request(scope + "api/drive/unsaved.ipynb");
  const parser = await restarted.context.maybeFromCache({ request: new Request(scope + "extensions/@jupyterlite/xeus-extension/static/meriyah.umd.min.js"), waitUntil() {} });
  assert.equal(await parser.text(), "parser");
  assert.equal(restarted.context.shouldDrop(dynamic, new URL(dynamic.url)), true);
  assert.deepEqual(await restarted.send("datax-offline-download", "https://unrelated.example/lab/"), []);
  stored.clear();
  online = true;
  rejectWrites = true;
  const quota = await restarted.send("datax-offline-download");
  assert.match(quota.at(-1).error, /browser storage/);
  assert.equal(quota.at(-1).ready, false);
  assert.equal(stored.size, 0);
});

test("offline-ready installs cache the next release before activating and prune stale entries", async () => {
  const scope = "https://example.com/go/";
  const stored = new Map();
  const cache = {
    async match(key) { return stored.get(key.url ?? key)?.clone(); },
    async put(key, response) { stored.set(key.url ?? key, response.clone()); },
    async keys() { return [...stored.keys()].map(key => new Request(key)); },
    async delete(request) { return stored.delete(request.url); },
  };
  let online = true;
  const downloads = [];
  function startWorker(bodies) {
    const listeners = {};
    const assets = Object.fromEntries(Object.entries(bodies).map(([relative, body]) => [relative, {
      sha256: createHash("sha256").update(body).digest("hex"), size: body.length,
    }]));
    const context = vm.createContext({
      URL, Request, Response, btoa, assets,
      self: { location: { href: scope + "service-worker.js?enableCache=true" }, addEventListener(type, listener) { listeners[type] = listener; } },
      caches: { async open() { return cache; } },
      async maybeFromCache(event) { return context.fetch(event.request); },
      async fetch(request) {
        if (!online) throw new TypeError("Network is offline");
        const relative = new URL(request.url).pathname.slice(new URL(scope).pathname.length);
        downloads.push(relative);
        return new Response(bodies[relative]);
      },
    });
    context.hashes = Object.fromEntries(Object.entries(assets).filter(([relative]) => relative.startsWith("xeus/")).map(([relative, asset]) => [relative, asset.sha256]));
    vm.runInContext(`(${fingerprints.installRuntimeCache.toString()})(hashes);(${offline.installOfflineCache.toString()})(assets);`, context);
    const dispatch = async (type, extra = {}) => {
      const tasks = [];
      listeners[type]({ ...extra, waitUntil(task) { tasks.push(task); } });
      return Promise.all(tasks);
    };
    return { assets, dispatch };
  }
  const keyFor = (relative, asset) => scope + relative + "?sha256=" + asset.sha256;
  const first = startWorker({ "lab/index.html": "shell v1", "xeus/runtime.wasm": "runtime" });
  await first.dispatch("install");
  assert.deepEqual(downloads, [], "installs do not download before the user opts in");
  const updates = [];
  await first.dispatch("message", {
    data: { type: "datax-offline-download" }, source: { url: scope + "lab/" },
    ports: [{ postMessage(update) { updates.push(update); } }],
  });
  assert.equal(updates.at(-1).ready, true);
  assert.ok(stored.has(scope + "datax-offline-ready"));

  const second = startWorker({ "lab/index.html": "shell v2", "xeus/runtime.wasm": "runtime" });
  downloads.length = 0;
  online = false;
  await assert.rejects(second.dispatch("install"), /offline/);
  assert.ok(stored.has(keyFor("lab/index.html", first.assets["lab/index.html"])), "the previous release stays complete");
  online = true;
  await second.dispatch("install");
  assert.deepEqual(downloads, ["lab/index.html"], "only changed assets are downloaded");
  await second.dispatch("activate");
  assert.deepEqual([...stored.keys()].sort(), [
    scope + "datax-offline-ready",
    keyFor("lab/index.html", second.assets["lab/index.html"]),
    keyFor("xeus/runtime.wasm", second.assets["xeus/runtime.wasm"]),
  ].sort());
});

test("offline download subscribers receive current progress immediately", async () => {
  const scope = "https://example.com/go/";
  const listeners = {};
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const stored = new Map();
  const assets = { "big.wasm": { sha256: createHash("sha256").update("big").digest("hex"), size: 3 } };
  const context = vm.createContext({
    URL, Request, Response, btoa, assets,
    self: { location: { href: scope + "service-worker.js?enableCache=true" }, addEventListener(type, listener) { listeners[type] = listener; } },
    caches: { async open() { return {
      async match(key) { return stored.get(key.url ?? key)?.clone(); },
      async put(key, response) { stored.set(key.url ?? key, response.clone()); },
      async keys() { return [...stored.keys()].map(key => new Request(key)); },
    }; } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch() { await gate; return new Response("big"); },
  });
  vm.runInContext(`(${offline.installOfflineCache.toString()})(assets);`, context);
  const send = updates => {
    const tasks = [];
    listeners.message({
      data: { type: "datax-offline-download" }, source: { url: scope + "lab/" },
      ports: [{ postMessage(update) { updates.push(update); } }], waitUntil(task) { tasks.push(task); },
    });
    return Promise.all(tasks);
  };
  const first = [];
  const firstDone = send(first);
  while (!first.length) await new Promise(resolve => setImmediate(resolve));
  const second = [];
  const secondDone = send(second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(second[0]?.downloading, true, "a resubscribed client must not wait for the next file");
  release();
  await Promise.all([firstDone, secondDone]);
  assert.equal(first.at(-1).ready, true);
});

test("offline auto-download waits for five continuous idle minutes", () => {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const timerApi = {
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, due: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const advance = milliseconds => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.due > now) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  let downloads = 0;
  const scheduler = offline.createKernelIdleScheduler(
    () => downloads++, 300000, () => now, timerApi,
  );
  scheduler.update(["idle"], true);
  advance(299000);
  scheduler.update(["busy"], true);
  advance(10000);
  scheduler.update(["idle"], true);
  advance(299999);
  assert.equal(downloads, 0);
  advance(1);
  assert.equal(downloads, 1);
  scheduler.update(["idle"], true);
  assert.equal(downloads, 1, "one idle period should trigger at most one automatic attempt");
  scheduler.update(["busy"], true);
  scheduler.update(["idle"], false);
  advance(300000);
  assert.equal(downloads, 1, "automatic downloads wait until they can start");
  scheduler.update(["idle"], true);
  assert.equal(downloads, 2, "a delayed start can proceed once downloading is available");
  scheduler.dispose();
});

test("offline status distinguishes controller wait and automatic download lifecycle", () => {
  assert.equal(offline.offlineStatusText({}, null, true, false), "Offline: waiting for app control");
  assert.equal(offline.offlineStatusText({ downloading: true, completed: 2, total: 10 }, "automatic", true),
    "Downloading offline automatically: 2/10");
  assert.equal(offline.offlineStatusText({ ready: true }, "automatic", true), "Offline ready (automatic)");
  assert.equal(offline.offlineStatusText({ error: "quota exceeded" }, "automatic", true),
    "Automatic offline download failed");
  assert.equal(offline.offlineStatusText({}, null, false), "Offline: incomplete");
});

test("kernel activity monitor tracks every running kernel and disposes removed connections", () => {
  const models = [{ id: "first", status: "idle" }];
  const connections = new Map();
  let refresh;
  const manager = {
    running: () => models,
    connectTo({ model }) {
      const listeners = new Set();
      const connection = {
        get status() { return model.status; },
        statusChanged: {
          connect(listener) { listeners.add(listener); },
          disconnect(listener) { listeners.delete(listener); },
        },
        dispose() { this.disposed = true; },
        emit() { for (const listener of listeners) listener(); },
      };
      connections.set(model.id, connection);
      return connection;
    },
  };
  const updates = [];
  const stop = offline.monitorKernelActivity(
    statuses => updates.push(statuses),
    () => ({ serviceManager: { kernels: manager } }),
    { setInterval(callback) { refresh = callback; return 1; }, clearInterval() {} },
  );
  assert.deepEqual(updates.at(-1), ["idle"]);
  models.push({ id: "second", status: "busy" });
  refresh();
  assert.deepEqual(updates.at(-1), ["idle", "busy"]);
  models[1].status = "idle";
  connections.get("second").emit();
  assert.deepEqual(updates.at(-1), ["idle", "idle"]);
  models.shift();
  refresh();
  assert.deepEqual(updates.at(-1), ["idle"]);
  assert.equal(connections.get("first").disposed, true);
  stop();
  assert.equal(connections.get("second").disposed, true);
});

test("generated offline client includes the kernel idle monitor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-offline-client-"));
  try {
    mkdirSync(join(directory, "lab"), { recursive: true });
    writeFileSync(join(directory, "lab/index.html"), "<body></body>");
    offline.prepareOffline(directory);
    const client = join(directory, "datax-offline.js");
    const source = readFileSync(client, "utf8");
    assert.match(source, /function createKernelIdleScheduler/);
    assert.match(source, /function monitorKernelActivity/);
    assert.match(source, /function offlineStatusText/);
    const result = spawnSync(process.execPath, ["--check", client], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const elements = [];
    const makeElement = tagName => {
      const element = {
        tagName,
        children: [],
        dataset: {},
        listeners: {},
        setAttribute() {},
        append(...children) { this.children.push(...children); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
      };
      elements.push(element);
      return element;
    };
    const serviceWorkerListeners = {};
    const timeouts = new Map();
    let nextTimeout = 0;
    const document = {
      head: makeElement("head"),
      body: makeElement("body"),
      createElement: makeElement,
      querySelector() { return null; },
    };
    const serviceWorker = {
      controller: null,
      ready: Promise.resolve(),
      addEventListener(type, listener) { serviceWorkerListeners[type] = listener; },
    };
    const context = vm.createContext({
      document,
      navigator: { onLine: true, serviceWorker },
      window: {
        jupyterapp: { serviceManager: { kernels: { running: () => [] } } },
        addEventListener() {},
      },
      MutationObserver: class { observe() {} disconnect() {} },
      MessageChannel: class {
        constructor() {
          this.port1 = { onmessage: null, close() {} };
          this.port2 = { postMessage: data => this.port1.onmessage?.({ data }) };
        }
      },
      // Browsers reject timer calls whose receiver is not the global object.
      setInterval() { if (this !== undefined) throw new TypeError("Illegal invocation"); return 1; },
      clearInterval() { if (this !== undefined) throw new TypeError("Illegal invocation"); },
      setTimeout(callback, delay) {
        if (this !== undefined) throw new TypeError("Illegal invocation");
        const id = ++nextTimeout; timeouts.set(id, { callback, delay }); return id;
      },
      clearTimeout(id) { if (this !== undefined) throw new TypeError("Illegal invocation"); timeouts.delete(id); },
      console: { info() {}, error() {} },
    });
    vm.runInContext(source, context);
    const panel = document.body.children[0];
    const label = panel.children[0];
    assert.equal(label.textContent, "Offline: waiting for app control");
    await new Promise(resolve => setImmediate(resolve));
    serviceWorker.controller = {
      postMessage(_message, [port]) {
        port.postMessage({ completed: 0, total: 4, bytes: 0, totalBytes: 4096, ready: false, downloading: false });
      },
    };
    serviceWorkerListeners.controllerchange();
    assert.equal(label.textContent, "Offline: not downloaded");
    assert.ok(!panel.children[1].disabled);
    for (const timer of timeouts.values()) assert.notEqual(timer.delay, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local verification server serves generated manifest bytes unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-offline-server-"));
  try {
    const manifest = JSON.stringify({ name: "DataX.now", icons: [{ src: "icon.png" }], shortcuts: [{ url: "./lab/" }] });
    writeFileSync(join(directory, "manifest.webmanifest"), manifest);
    const script = `
import http.client
import http.server
import sys
import threading
from functools import partial
sys.path.insert(0, sys.argv[1])
from cors_server import CORSRequestHandler
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), partial(CORSRequestHandler, directory=sys.argv[2]))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
client = http.client.HTTPConnection('127.0.0.1', server.server_port)
client.request('GET', '/manifest.webmanifest?version=test')
response = client.getresponse()
assert response.status == 200
sys.stdout.write(response.read().decode())
client.close()
server.shutdown()
server.server_close()
`;
    const result = spawnSync("python3", ["-c", script, new URL(".", root).pathname, directory], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, manifest);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("kernel package mapping is bundled locally for pages and workers on every deployment path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-offline-mapping-"));
  const extension = "extensions/@jupyterlite/xeus-extension/static/";
  try {
    mkdirSync(join(directory, extension), { recursive: true });
    writeFileSync(join(directory, extension, "mapping.js"), 'fetch("https://raw.githubusercontent.com/prefix-dev/parselmouth/main/files/compressed_mapping.json")');
    const assets = offline.prepareOffline(directory);
    assert.ok(assets["conda-pypi-mapping.json"]);
    const patched = readFileSync(join(directory, extension, "mapping.js"), "utf8");
    assert.equal(patched.includes("raw.githubusercontent.com"), false);
    for (const prefix of ["/", "/go/", "/en/latest/_static/"]) {
      for (const worker of [true, false]) {
        let fetched;
        const context = vm.createContext({
          URL,
          location: { href: "https://example.com" + prefix + extension + "worker.js" },
          ...(worker ? {} : { document: { baseURI: "https://example.com" + prefix + "lab/", getElementById() { return { textContent: '{"baseUrl":"../"}' }; } } }),
          fetch(url) { fetched = url; return Promise.resolve(); },
        });
        await vm.runInContext(patched, context);
        assert.equal(fetched, "https://example.com" + prefix + "conda-pypi-mapping.json");
      }
    }
    assert.deepEqual(offline.prepareOffline(directory), assets);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("service-worker heartbeat stays within subpath deployments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-heartbeat-"));
  try {
    mkdirSync(join(directory, "build"));
    writeFileSync(join(directory, "build/manager.js"), 'fetch("/api/service-worker-heartbeat")');
    offline.prepareOffline(directory);
    const patched = readFileSync(join(directory, "build/manager.js"), "utf8");
    for (const prefix of ["/", "/go/", "/en/latest/_static/"]) {
      let fetched;
      const context = vm.createContext({
        URL,
        document: { baseURI: "https://example.com" + prefix + "lab/", getElementById() { return { textContent: '{"baseUrl":"../"}' }; } },
        fetch(url) { fetched = url; },
      });
      vm.runInContext(patched, context);
      assert.equal(fetched, "https://example.com" + prefix + "api/service-worker-heartbeat");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const directoryWorker = mkdtempSync(join(tmpdir(), "datax-heartbeat-sw-"));
  try {
    mkdirSync(join(directoryWorker, "dist/xeus/xeus-python-wasm-host"), { recursive: true });
    writeFileSync(join(directoryWorker, "dist/xeus/xeus-python-wasm-host/xpython.js"), "runtime");
    writeFileSync(join(directoryWorker, "dist/service-worker.js"), upstream.replace(
      "async function onFetch(event){",
      'async function onFetch(event){let t=new URL(event.request.url);if("/api/service-worker-heartbeat"===t.pathname)return void event.respondWith(new Response("ok"));',
    ));
    const result = spawnSync("python3", ["-c", patch], { cwd: directoryWorker, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(directoryWorker, "dist/service-worker.js"), "utf8"),
      /t\.pathname\.endsWith\("\/api\/service-worker-heartbeat"\)/);
  } finally { rmSync(directoryWorker, { recursive: true, force: true }); }
});

test("offline inventory includes lazy assets but excludes archives and mutable deployment metadata", () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-offline-inventory-"));
  try {
    mkdirSync(join(directory, "lab"));
    mkdirSync(join(directory, "xeus/xeus-python-wasm-host/built-in-local/conda"), { recursive: true });
    writeFileSync(join(directory, "lab/index.html"), "<html><head></head><body></body></html>");
    for (const name of ["service-worker.js", "deployment.json", "datax-now.zip", "cors_server.py", "lazy.js"]) writeFileSync(join(directory, name), "asset");
    writeFileSync(join(directory, "xeus/xeus-python-wasm-host/built-in-local/conda/generate_repodata.py"), "build helper");
    writeFileSync(join(directory, "sample.py"), "runtime asset");
    const first = offline.prepareOffline(directory);
    assert.deepEqual(offline.prepareOffline(directory), first, "generation is idempotent");
    assert.deepEqual(Object.keys(first).sort(), ["datax-offline.js", "lab/index.html", "lazy.js", "sample.py"]);
    assert.match(readFileSync(join(directory, "lab/index.html"), "utf8"), /src="..\/datax-offline.js"/);
    for (const [relative, asset] of Object.entries(first)) {
      const bytes = readFileSync(join(directory, relative));
      assert.equal(asset.sha256, createHash("sha256").update(bytes).digest("hex"));
      assert.equal(asset.size, bytes.length);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("offline HTML remains integrity-checked when the host injects addons", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-offline-html-"));
  const stored = new Map();
  const requests = [];
  let online = true;
  try {
    mkdirSync(join(directory, "lab"));
    writeFileSync(join(directory, "lab/index.html"), "<html><head></head><body>app</body></html>");
    const assets = offline.prepareOffline(directory);
    const expected = readFileSync(join(directory, "lab/index.html"), "utf8");
    const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
    const context = vm.createContext({
      URL, Request, Response, Headers, btoa, assets,
      self: { location: { href: scope + "service-worker.js?enableCache=true" }, addEventListener() {} },
      async maybeFromCache(event) { return context.fetch(event.request); },
      caches: { async open() { return {
        async match(key) { return stored.get(key)?.clone(); },
        async put(key, response) { stored.set(key, response.clone()); },
      }; } },
      async fetch(request) {
        if (!online) throw new TypeError("Network is offline");
        requests.push(request);
        const relative = new URL(request.url).pathname.slice(new URL(scope).pathname.length);
        let bytes = readFileSync(join(directory, relative), "utf8");
        if (relative.endsWith(".html")) bytes = bytes.replace("</head>", '<script src="/addons.js"></script></head>');
        return fetch("data:application/octet-stream," + encodeURIComponent(bytes), { integrity: request.integrity });
      },
    });
    vm.runInContext(`(${offline.installOfflineCache.toString()})(assets)`, context);
    async function navigate(relative) {
      const tasks = [];
      const response = await context.maybeFromCache({ request: new Request(scope + relative), waitUntil(task) { tasks.push(task); } });
      await Promise.all(tasks);
      assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
      assert.equal(await response.text(), expected);
    }
    await navigate("lab/index.html");
    assert.equal(requests.length, 1);
    assert.ok(requests[0].integrity.startsWith("sha256-"));
    online = false;
    await navigate("lab/?path=Offline.ipynb");
    assert.equal(requests.length, 1);
    online = true;
    stored.clear();
    writeFileSync(join(directory, "lab/index.html.offline"), "corrupted shell");
    await assert.rejects(navigate("lab/index.html"), /fetch failed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("offline app navigation survives a new notebook query after the worker restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-offline-navigation-"));
  const stored = new Map();
  let online = true;
  try {
    mkdirSync(join(directory, "dist/xeus/xeus-python-wasm-host"), { recursive: true });
    writeFileSync(join(directory, "dist/xeus/xeus-python-wasm-host/xpython.js"), "runtime");
    writeFileSync(join(directory, "dist/service-worker.js"), upstream);
    const result = spawnSync("python3", ["-c", patch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const assets = { "lab/index.html": { sha256: createHash("sha256").update("app shell").digest("hex"), size: 9 } };
    function startWorker() {
      const context = vm.createContext({
        URL, Request, Response, Headers, btoa,
        location: { href: "https://example.com/go/service-worker.js?enableCache=true", origin: "https://example.com" },
        self: { location: { href: "https://example.com/go/service-worker.js?enableCache=true" }, addEventListener() {}, clients: { async claim() {} } },
        caches: { async open() { return {
          async match(request) { return stored.get(request.url ?? request)?.clone(); },
          async put(request, response) { stored.set(request.url ?? request, response.clone()); },
        }; } },
        async fetch() {
          if (!online) throw new TypeError("Network is offline");
          return new Response("app shell");
        },
      });
      vm.runInContext(readFileSync(join(directory, "dist/service-worker.js"), "utf8"), context);
      context.assets = assets;
      vm.runInContext(`(${offline.installOfflineCache.toString()})(assets)`, context);
      return context;
    }
    async function navigate(context, path) {
      const tasks = [];
      const response = await context.maybeFromCache({
        request: new Request("https://example.com/go/" + path),
        waitUntil(task) { tasks.push(task); },
      });
      await Promise.all(tasks);
      return response.text();
    }
    assert.equal(await navigate(startWorker(), "lab/index.html"), "app shell");
    online = false;
    assert.equal(await navigate(startWorker(), "lab/?path=Offline.ipynb"), "app shell");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service worker caches across restarts and revalidates without runtime bodies", async () => {
  const config = JSON.parse(readFileSync(new URL("jupyter-lite.json", root)));
  assert.equal(config["jupyter-config-data"].enableServiceWorkerCache, true);
  const directory = mkdtempSync(join(tmpdir(), "datax-cache-"));
  try {
    mkdirSync(join(directory, "dist/xeus/xeus-python-wasm-host"), { recursive: true });
    writeFileSync(join(directory, "dist/xeus/xeus-python-wasm-host/xpython.js"), "runtime");
    writeFileSync(join(directory, "dist/service-worker.js"), upstream);
    const result = spawnSync("python3", ["-c", patch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const generated = readFileSync(join(directory, "dist/service-worker.js"), "utf8");
    let cached = new Response("runtime", { headers: { ETag: '"runtime-v1"' } });
    let changed = false;
    const opened = [];
    const context = vm.createContext({
      URL, Request, Response, Headers,
      location: { href: "https://example.com/service-worker.js?enableCache=true", origin: "https://example.com" },
      self: { clients: { async claim() {} } },
      caches: {
        async open(name) {
          opened.push(name);
          return {
            async match() { return cached.clone(); },
            async put(request, response) { cached = response.clone(); },
          };
        },
      },
      async fetch(request) {
        assert.equal(request.headers.get("If-None-Match"), '"runtime-v1"');
        return changed
          ? new Response("updated", { headers: { ETag: '"runtime-v2"' } })
          : new Response(null, { status: 304 });
      },
    });
    vm.runInContext(generated, context);
    assert.equal(vm.runInContext("enableCache", context), true);
    const request = new Request("https://example.com/xeus/xpython.wasm");
    assert.equal(await (await context.refetch(request)).text(), "runtime");
    assert.ok(opened.every(name => /^precache-[a-f0-9]+$/.test(name)));
    changed = true;
    assert.equal(await (await context.refetch(request)).text(), "updated");
    assert.equal(await cached.text(), "updated");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});