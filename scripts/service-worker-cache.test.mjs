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
test("deployment archive remains enabled by default and can be skipped", () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-archive-setting-"));
  const archivePatch = 'if [ "${DATAX_BUILD_ARCHIVE:-1}" = "1" ]; then' +
    build.split('if [ "${DATAX_BUILD_ARCHIVE:-1}" = "1" ]; then')[1].split('\necho ""')[0];
  mkdirSync(join(directory, "dist"));
  writeFileSync(join(directory, "dist/deployment.json"), "{}");
  try {
    const defaultEnv = { ...process.env };
    delete defaultEnv.DATAX_BUILD_ARCHIVE;
    const enabled = spawnSync("bash", ["-c", archivePatch], { cwd: directory, env: defaultEnv, encoding: "utf8" });
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(readFileSync(join(directory, "dist/datax-now.zip")).subarray(0, 2).toString(), "PK");
    rmSync(join(directory, "dist/datax-now.zip"));
    const disabled = spawnSync("bash", ["-c", archivePatch], {
      cwd: directory, env: { ...process.env, DATAX_BUILD_ARCHIVE: "0" }, encoding: "utf8",
    });
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.throws(() => readFileSync(join(directory, "dist/datax-now.zip")), /ENOENT/);
    assert.equal(readFileSync(join(directory, "dist/deployment.json"), "utf8"), "{}");
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
const upstream = `const CACHE="precache";let enableCache=!1;
function onActivate(e){enableCache="true"===new URL(location.href).searchParams.get("enableCache"),e.waitUntil(self.clients.claim())}
async function onFetch(event){event.respondWith(maybeFromCache(event))}
async function maybeFromCache(e){let{request:a}=e;if(!enableCache)return await fetch(a);let t=await fromCache(a);return t?e.waitUntil(refetch(a)):(t=await fetch(a),e.waitUntil(updateCache(a,t.clone()))),t}
async function openCache(){return await caches.open("precache")}
async function fromCache(e){let a=await openCache(),t=await a.match(e);return t&&404!==t.status?t:null}
async function updateCache(request,response){return (await openCache()).put(request,response)}
async function refetch(e){let a=await fetch(e);return await updateCache(e,a),a}`;

test("manifest shortcuts stay within the deployment subpath", () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-manifest-scope-"));
  mkdirSync(join(directory, "dist"));
  try {
    writeFileSync(join(directory, "dist/manifest.webmanifest"), JSON.stringify({
      name: "JupyterLite", short_name: "JupyterLite", scope: "./", start_url: "./",
      shortcuts: [{ name: "JupyterLite", url: "/lab" }, { name: "Replite", url: "/repl?toolbar=1" }],
    }));
    const result = spawnSync("python3", ["-c", brandingPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(directory, "dist/manifest.webmanifest"), "utf8"));
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
    const context = vm.createContext({
      Headers,
      Response,
      async fetch() { return sourceResponse; },
    });
    vm.runInContext(patched, context);

    async function fetchThroughWorker(mode, destination = "") {
      let intercepted;
      context.onFetch({
        request: { mode, destination, url: "https://example.com/lab/index.html" },
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

test("RTD and GitHub Pages bootstraps reload after the service worker takes control", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-static-host-bootstrap-"));
  mkdirSync(join(directory, "dist/lab"), { recursive: true });
  const appPath = join(directory, "dist/lab/index.html");
  writeFileSync(appPath, "<html><head></head><body></body></html>");
  try {
    const result = spawnSync("python3", ["-c", staticHostBootstrapPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const html = readFileSync(appPath, "utf8");
    const script = html.split('<script id="datax-rtd-coep-bootstrap">')[1]?.split("</script>")[0];
    assert.ok(script, "bootstrap should be inserted into the app head");

    for (const hostname of ["datax-now.readthedocs.io", "ying.github.io"]) {
      let controller = null;
      let reloaded = false;
      let resolveReady;
      const listeners = new Set();
      const values = new Map();
      const serviceWorker = {
        ready: new Promise(resolve => { resolveReady = resolve; }),
        get controller() { return controller; },
        addEventListener(type, listener) { if (type === "controllerchange") listeners.add(listener); },
        removeEventListener(type, listener) { if (type === "controllerchange") listeners.delete(listener); },
      };
      const context = vm.createContext({
        location: { hostname, reload() { reloaded = true; } },
        navigator: { serviceWorker },
        crossOriginIsolated: false,
        sessionStorage: {
          getItem(key) { return values.get(key) ?? null; },
          setItem(key, value) { values.set(key, value); },
          removeItem(key) { values.delete(key); },
        },
      });
      vm.runInContext(script, context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reloaded, false, "wait for JupyterLite's existing service-worker registration");
      resolveReady();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reloaded, false, "wait for the service worker to control the first page");

      controller = {};
      for (const listener of listeners) listener();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reloaded, true, `${hostname} should reload after the service worker takes control`);

      reloaded = false;
      vm.runInContext(script, context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reloaded, true, `${hostname} should retry when the first reload is not isolated`);

      reloaded = false;
      vm.runInContext(script, context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reloaded, true, `${hostname} should allow a third navigation`);

      reloaded = false;
      vm.runInContext(script, context);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(reloaded, false, "reload retries must be bounded");
    }

    const legacyHtml = html.replace(
      'if (!(location.hostname.endsWith(".readthedocs.io") || location.hostname.endsWith(".github.io")) || !("serviceWorker" in navigator)) return;',
      'if (!location.hostname.endsWith(".readthedocs.io") || crossOriginIsolated',
    );
    assert.notEqual(legacyHtml, html, "the generated bootstrap should include both static hosts");
    writeFileSync(appPath, legacyHtml);
    const upgrade = spawnSync("python3", ["-c", staticHostBootstrapPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.match(readFileSync(appPath, "utf8"), /\.github\.io/);
    assert.match(readFileSync(appPath, "utf8"), /attempts >= 3/);
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
      self: { location: { href: "https://example.com/service-worker.js?enableCache=true" } },
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
    "https://datax.now/deployment.json": { commit: "b".repeat(40), files: { [runtimePath]: { sha256 } } },
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
      self: { location: { href: "https://example.com/_static/service-worker.js?enableCache=true" } },
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