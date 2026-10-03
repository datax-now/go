import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import fingerprints from "./fingerprint-runtime.cjs";
import startup from "./patch-wasm-startup.cjs";
import offline from "./offline-cache.cjs";
import { createDeploymentManifest } from "./deployment-manifest.mjs";

const root = new URL("../", import.meta.url);
test("first-visit service-worker management preserves isolation and survives blocked updates", async t => {
  const source = `const version="1.0"; class Manager {
    async _initialize(e){let{serviceWorker:t}=navigator,s=null;
      if(t.controller){let e=t.controller.scriptURL;await this._unregisterOldServiceWorkers(e),s=await t.getRegistration(e)||null}
      if(!s)s=await t.register(e);this.registration=s}
    async _unregisterOldServiceWorkers(e){let t=\`\${e}-version\`,s=localStorage.getItem(t);if(s&&s!==version||!s){console.info("New version, unregistering existing service workers.");let e=await navigator.serviceWorker.getRegistrations();await Promise.all(e.map(e=>e.unregister())),console.info("All existing service workers have been unregistered.")}localStorage.setItem(t,version)}
  } globalThis.Manager=Manager;`;
  const patched = offline.patchServiceWorkerManager(source);
  assert.equal(offline.patchServiceWorkerManager(patched), patched, "patch must be idempotent");
  assert.throws(() => offline.patchServiceWorkerManager("changed upstream code"), /Expected one service-worker version handler/);
  const directory = mkdtempSync(join(tmpdir(), "datax-worker-manager-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "build"));
  writeFileSync(join(directory, "build/manager.js"), source);
  const assets = offline.prepareOffline(directory);
  assert.equal(readFileSync(join(directory, "build/manager.js"), "utf8"), patched);
  assert.equal(assets["build/manager.js"].sha256, createHash("sha256").update(patched).digest("hex"),
    "the inventory must fingerprint the patched manager, not its original bytes");
  assert.deepEqual(offline.prepareOffline(directory), assets);
  for (const previousVersion of [null, "0.9", "1.0"]) {
    for (const blocked of [false, true]) {
      let registered = true;
      let updates = 0;
      let unregistrations = 0;
      let registrations = 0;
      const warnings = [];
      const values = new Map();
      const url = "https://datax-now.readthedocs.io/en/latest/_static/service-worker.js?enableCache=true";
      if (previousVersion) values.set(url + "-version", previousVersion);
      const registration = {
        async update() { updates++; if (blocked) throw new TypeError("Cloudflare blocked the worker update"); },
        async unregister() { unregistrations++; registered = false; },
      };
      const unrelated = { async unregister() { unregistrations++; } };
      const context = vm.createContext({
        navigator: { serviceWorker: {
          controller: { scriptURL: url },
          async getRegistration(scope) { assert.equal(scope, url); return registered ? registration : undefined; },
          async getRegistrations() { return [registration, unrelated]; },
          async register() { registrations++; throw new TypeError("Cloudflare blocked registration"); },
        } },
        localStorage: {
          getItem(key) { return values.get(key) ?? null; },
          setItem(key, value) { values.set(key, value); },
        },
        console: { info() {}, warn(...args) { warnings.push(args); } },
      });
      vm.runInContext(patched, context);
      const manager = new context.Manager();
      await manager._initialize(url);
      assert.equal(manager.registration, registration, "kernel startup must retain the preflight registration");
      assert.equal(unregistrations, 0, "neither the active worker nor other deployment scopes may be unregistered");
      assert.equal(registrations, 0);
      assert.equal(updates, previousVersion === "1.0" ? 0 : 1);
      assert.equal(warnings.length, blocked && previousVersion !== "1.0" ? 1 : 0,
        "blocked update checks must be reported without discarding the working registration");
      assert.equal(values.get(url + "-version"), blocked ? previousVersion ?? undefined : "1.0",
        "failed update checks must remain retryable on the next visit");
    }
  }
});

test("cold kernel messages wait for initialization and mounted filesystem in arrival order", async () => {
  const source = `class Kernel {
    constructor(initialize, mount) {
      this._messageQueue=Promise.resolve();this._activeKernelRequestCount=0;
      this._ready={promise:new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject}),
        resolve:()=>this.resolveReady(),reject:error=>this.rejectReady(error)};
      this.messages=[];
      this.initRemote=()=>initialize;this.initFileSystem=()=>mount;
      this.initRemote({}).then(()=>this.initFileSystem({})).then(this._ready.resolve.bind(this._ready));
    }
    get ready(){return this._ready.promise}
    async handleMessage(e){let t="input_reply"!==e.header.msg_type,s=async()=>{
      t&&(this._activeKernelRequestCount+=1),this._parent=e,this._parentHeader=e.header;
      try{await this._sendMessageToWorker(e)}finally{t&&(this._activeKernelRequestCount=Math.max(0,this._activeKernelRequestCount-1))}
    },i=this._messageQueue.then(s,s);this._messageQueue=i.then(()=>void 0,()=>void 0),await i}
    async _sendMessageToWorker(message){this.messages.push(message.header.msg_type)}
  }
  globalThis.Kernel=Kernel;`;
  const patched = startup.patchKernelMessages(source);
  const context = vm.createContext({});
  vm.runInContext(patched, context);
  let initialize;
  let mount;
  const kernel = new context.Kernel(
    new Promise(resolve => { initialize = resolve; }),
    new Promise(resolve => { mount = resolve; }),
  );
  const open = kernel.handleMessage({ header: { msg_type: "comm_open" } });
  const update = kernel.handleMessage({ header: { msg_type: "comm_msg" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kernel.messages.length, 0, "comm messages must not reach an uninitialized kernel");
  initialize();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kernel.messages.length, 0, "filesystem mounting must finish before comm messages");
  mount();
  await Promise.all([open, update]);
  assert.deepEqual([...kernel.messages], ["comm_open", "comm_msg"]);
  assert.equal(startup.patchKernelMessages(patched), patched, "patch must be idempotent");

  const failed = new context.Kernel(Promise.reject(new Error("Kernel initialization failed")), Promise.resolve());
  await assert.rejects(failed.handleMessage({ header: { msg_type: "kernel_info_request" } }), /Kernel initialization failed/);
  assert.equal(failed.messages.length, 0);
});

test("kernel IOPub output reaches live clients after the originating socket closes", () => {
  const source = `class Router {
    constructor(){this._clients=new Map();this._kernelClients=new Map()}
    send(e){let t="stdin"===e.channel?e.parent_header.session:e.header.session,s=this._clients.get(t);
      if(!s)return void console.warn(\`Trying to send message on removed socket for kernel \${kernelId}\`);
      let n=serialize(e);if("iopub"===e.channel){let e=this._kernelClients.get(kernelId);
        e?.forEach(e=>{this._clients.get(e)?.send(n)});return}
      s.send(n)}
  } globalThis.Router=Router;`;
  const warnings = [];
  const received = [];
  const context = vm.createContext({
    kernelId: "kernel", serialize: message => message,
    console: { warn(message) { warnings.push(message); } },
  });
  const patched = startup.patchSocketMessages(source);
  assert.equal(startup.patchSocketMessages(patched), patched);
  assert.throws(() => startup.patchSocketMessages("changed upstream code"), /Expected one kernel IOPub/);
  vm.runInContext(patched, context);
  const router = new context.Router();
  router._clients.set("notebook", { send(message) { received.push(message); } });
  router._kernelClients.set("kernel", new Set(["notebook"]));
  const output = { channel: "iopub", header: { session: "closed-probe" } };
  router.send(output);
  assert.deepEqual(received, [output], "IOPub must broadcast even without a live originating socket");
  assert.deepEqual(warnings, [], "a valid broadcast must not produce a removed-socket warning");
  router.send({ channel: "shell", header: { session: "closed-probe" } });
  assert.equal(warnings.length, 1, "orphaned direct replies must still be reported");
  const input = { channel: "stdin", header: { session: "kernel" }, parent_header: { session: "notebook" } };
  router.send(input);
  assert.equal(received.at(-1), input, "stdin must still reach the parent session");
});

test("Python comm exposure waits for pyjs readiness rather than timing out during cold downloads", () => {
  const source = `function __xeus_x_tryExposePythonCommOnModule(){
    if(typeof Module.exec_eval!=="function")return false;
    const comm=Module.exec_eval("import comm; comm");
    if(!comm)return false;
    Module.__xeus_x_pythonComm=comm.Comm;Module.__xeus_x_pythonCreateComm=comm.create_comm;return true;
  }
  function __xeus_x_ensurePythonCommOnModule(log){
    if(typeof Module==="undefined"){return}
    if(__xeus_x_tryExposePythonCommOnModule())return;
    let attempts=0;const poll=()=>{
      if(__xeus_x_tryExposePythonCommOnModule())return;
      if(++attempts>=100){log.warn("Module.__xeus_x_pythonComm was not exposed after waiting for pyjs init");return}
      setTimeout(poll,200);
    };setTimeout(poll,200);
  }
  __xeus_x_ensurePythonCommOnModule(console);
  function initialize(){Module.exec_eval=()=>pythonComm;Module._is_initialized=true;}`;
  const timers = [];
  const warnings = [];
  const pythonComm = { Comm() {}, create_comm() {} };
  const context = vm.createContext({
    Module: {}, pythonComm,
    setTimeout(callback) { timers.push(callback); },
    console: { warn(message) { warnings.push(message); } },
  });
  const patched = startup.patchCommInitialization(source);
  assert.equal(startup.patchCommInitialization(patched), patched);
  assert.throws(() => startup.patchCommInitialization("changed upstream code"), /Expected one Python comm initialization/);
  vm.runInContext(patched, context);
  for (let elapsed = 0; elapsed < 30000 && timers.length; elapsed += 200) timers.shift()();
  assert.deepEqual(warnings, [], "slow downloads before Python starts must not exhaust the comm exposure wait");
  assert.equal(timers.length, 0, "comm exposure must not poll an uninitialized interpreter");
  context.initialize();
  assert.equal(context.Module.__xeus_x_pythonComm, pythonComm.Comm, "Python initialization must trigger comm exposure");
  assert.equal(context.Module.__xeus_x_pythonCreateComm, pythonComm.create_comm);
  context.pythonComm = null;
  delete context.Module.__xeus_x_pythonComm;
  delete context.Module.__xeus_x_pythonCreateComm;
  context.initialize();
  for (let elapsed = 0; elapsed < 30000 && timers.length; elapsed += 200) timers.shift()();
  assert.equal(warnings.length, 1, "a genuine comm exposure failure after initialization must still be reported");
});

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
const configStaging = "for lite_file in " + build.split("for lite_file in ")[1]
  .split("# Validate notebook fallback")[0];
const dataIndexPatch = build.split("mamba_run_deploy python3 - <<'PYEOF'\nimport json\nfrom datetime")[1]
  .split("\nPYEOF")[0];
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
    for (const relative of ["dist/jupyter-lite.json", "dist/lab/jupyter-lite.json"]) {
      writeFileSync(join(directory, relative), JSON.stringify({
        "jupyter-config-data": { federated_extensions: [
          { name: "@jupyterlite/pyodide-kernel-extension" }, { name: "@jupyterlite/xeus-extension" },
        ] },
      }));
    }
    const result = spawnSync("python3", ["-c", runtimeConfigPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    for (const relative of ["dist/jupyter-lite.json", "dist/lab/jupyter-lite.json"]) {
      const config = JSON.parse(readFileSync(join(directory, relative), "utf8"));
      assert.equal(config.enableServiceWorkerCache, true);
      assert.equal(config["jupyter-config-data"].enableServiceWorkerCache, true);
      assert.deepEqual(config["jupyter-config-data"].federated_extensions, [{ name: "@jupyterlite/xeus-extension" }]);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("all deployment hosts publish the same on-demand DataX runtime config", async () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-host-config-"));
  const configs = [];
  try {
    for (const host of ["vercel", "github", "rtd"]) {
      const folder = join(directory, host);
      const lite = join(folder, "temp/jupyterlite-lite-dir");
      mkdirSync(lite, { recursive: true });
      mkdirSync(join(folder, "dist/consoles"), { recursive: true });
      writeFileSync(join(folder, "jupyter-lite.json"), readFileSync(new URL("jupyter-lite.json", root)));
      writeFileSync(join(folder, "dist/consoles/jupyter-lite.json"), "{}");
      const staging = spawnSync("bash", ["-c", configStaging], {
        cwd: folder, encoding: "utf8",
        env: { ...process.env, LITE_BUILD_DIR: lite, READTHEDOCS: host === "rtd" ? "True" : "" },
      });
      assert.equal(staging.status, 0, staging.stderr);
      const restore = spawnSync("python3", ["-c", runtimeConfigPatch], { cwd: folder, encoding: "utf8" });
      assert.equal(restore.status, 0, restore.stderr);
      configs.push(readFileSync(join(folder, "dist/consoles/jupyter-lite.json"), "utf8"));
    }
    const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
    const mirror = "https://datax-now.github.io/go/";
    const relative = "consoles/jupyter-lite.json";
    const sha256 = createHash("sha256").update(configs[2]).digest("hex");
    const mirrorHash = createHash("sha256").update(configs[1]).digest("hex");
    const stored = new Map();
    let message;
    const context = vm.createContext({
      URL, Request, Response, Headers, btoa,
      assets: { [relative]: { sha256, size: Buffer.byteLength(configs[2]) } },
      hashes: { [relative]: sha256 },
      self: {
        location: { href: scope + "service-worker.js?enableCache=true" },
        addEventListener(type, listener) { if (type === "message") message = listener; },
      },
      caches: { async open() { return {
        async match(key) { return stored.get(key.url ?? key)?.clone(); },
        async put(key, response) { stored.set(key.url ?? key, response.clone()); },
        async keys() { return [...stored.keys()].map(url => new Request(url)); },
      }; } },
      async maybeFromCache(event) { return context.fetch(event.request); },
      async fetch(request) {
        if (new URL(request.url).origin === new URL(scope).origin) {
          throw new TypeError("Fetch API cannot load RTD asset. SRI's integrity checks failed.");
        }
        if (request.url.endsWith("/deployment.json")) {
          return new Response(JSON.stringify({ files: { [relative]: { sha256: mirrorHash } } }));
        }
        return fetch("data:application/json," + encodeURIComponent(configs[1]), { integrity: request.integrity });
      },
    });
    vm.runInContext(
      `(${fingerprints.installRuntimeCache.toString()})({}, ["${mirror}"], null, hashes);` +
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
    await Promise.all(tasks);
    assert.equal(updates.at(-1).ready, true, updates.at(-1).error);
    assert.equal(configs[2], configs[0], "RTD's config must be byte-identical to its mirror for verified offline fallback");
    assert.equal(configs[1], configs[0]);
    const config = JSON.parse(configs[0]);
    assert.equal(config.defaultKernelName, "xpython");
    assert.equal(config.xeusKernelPoolWarm, 0);
    assert.equal(config.xeusAutoPrewarm, false);
    assert.equal(config.xeusKernelPoolRecycleEnabled, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("build inputs remove Pyodide even from reused deployment environments", () => {
  const environment = readFileSync(new URL("environment-deploy.yml", root), "utf8");
  assert.doesNotMatch(environment, /^\s*-\s+jupyterlite-pyodide-kernel/m);
  assert.match(build, /python -m pip uninstall[^\n]*jupyterlite-pyodide-kernel/);
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

    for (const mode of ["no-cors", "same-origin", "cors"]) {
      const mirrorResponse = new Response("verified mirror script", {
        headers: {
          "Content-Type": "text/javascript",
          "Content-Encoding": "br",
          "Content-Length": "10",
          ETag: '"mirror-etag"',
        },
      });
      Object.defineProperty(mirrorResponse, "type", { value: "cors" });
      queuedResponses = [mirrorResponse];
      const script = await fetchThroughWorker(mode, "script");
      assert.equal(script.type, "default", "mirror responses must be local before respondWith to avoid COEP/response-mode rejection");
      assert.equal(script.headers.get("Content-Type"), "text/javascript");
      assert.equal(script.headers.get("ETag"), '"mirror-etag"');
      assert.equal(script.headers.get("Content-Encoding"), null, "fetch has already decoded the mirror body");
      assert.equal(script.headers.get("Content-Length"), null);
      assert.equal(await script.text(), "verified mirror script");
    }

    writeFileSync(
      workerPath,
      patched.replace('headers.set("Cross-Origin-Opener-Policy","same-origin");', ""),
    );
    const upgrade = spawnSync("python3", ["-c", isolationHeadersPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(upgrade.status, 0, upgrade.stderr);
    assert.match(readFileSync(workerPath, "utf8"), /Cross-Origin-Opener-Policy/);

    const normalization = patched.match(/if\(response&&response\.type==="cors"\)\{[\s\S]*?response=new Response[\s\S]*?;\}/)?.[0];
    assert.ok(normalization);
    writeFileSync(workerPath, patched.replace(normalization, ""));
    const mirrorUpgrade = spawnSync("python3", ["-c", isolationHeadersPatch], { cwd: directory, encoding: "utf8" });
    assert.equal(mirrorUpgrade.status, 0, mirrorUpgrade.stderr);
    assert.equal(readFileSync(workerPath, "utf8"), patched, "existing builds must gain the mirror fix without changing isolation headers");
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

    function createPage(hostname, href, ready, sessionValues = new Map(), timers = { setTimeout, clearTimeout }) {
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
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
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

    let now = 0;
    let timerId = 0;
    const scheduled = new Map();
    const timers = {
      setTimeout(callback, delay) {
        const id = ++timerId;
        scheduled.set(id, { callback, at: now + delay });
        return id;
      },
      clearTimeout(id) { scheduled.delete(id); },
    };
    function advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of scheduled) {
        if (timer.at <= now) {
          scheduled.delete(id);
          timer.callback();
        }
      }
    }
    let finishRegistration;
    const slow = createPage("datax-now.github.io", "https://datax-now.github.io/go/lab/index.html",
      Promise.resolve({}), new Map(), timers);
    slow.context.navigator.serviceWorker.register = () => new Promise(resolve => { finishRegistration = resolve; });
    vm.runInContext(bootstrap, slow.context);
    vm.runInContext(appLoader, slow.context);
    advance(16000);
    await new Promise(resolve => setImmediate(resolve));
    finishRegistration({});
    slow.setController({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(slow.errors.length, 0, "a cold registration taking more than 15 seconds must still complete");
    assert.equal(slow.reloads, 1, "slow first visits must recover without a manual refresh");
    assert.equal(slow.context.dataxAppStarted, undefined, "the loader must remain gated until the isolated reload");
    assert.equal(scheduled.size, 0, "successful registration must clear its timeouts");

    for (const phase of ["ready", "controller"]) {
      let finishReady;
      const ready = new Promise(resolve => { finishReady = resolve; });
      const page = createPage("datax-now.github.io", "https://datax-now.github.io/go/lab/index.html",
        ready, new Map(), timers);
      vm.runInContext(bootstrap, page.context);
      vm.runInContext(appLoader, page.context);
      await new Promise(resolve => setImmediate(resolve));
      if (phase === "controller") {
        finishReady({});
        await new Promise(resolve => setImmediate(resolve));
      }
      advance(16000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(page.errors.length, 0, `cold ${phase} waits must allow more than 15 seconds`);
      assert.equal(page.context.dataxAppStarted, undefined);
      finishReady({});
      page.setController({});
      page.controllerChanged();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(page.reloads, 1);
      assert.equal(scheduled.size, 0);
    }

    const stalled = createPage("datax-now.github.io", "https://datax-now.github.io/go/lab/index.html",
      new Promise(() => {}), new Map(), timers);
    stalled.context.navigator.serviceWorker.register = () => new Promise(() => {});
    vm.runInContext(bootstrap, stalled.context);
    vm.runInContext(appLoader, stalled.context);
    advance(120000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stalled.errors.length, 1, "a permanently stalled registration must report an error");
    assert.equal(stalled.reloads, 0);
    assert.equal(stalled.context.dataxAppStarted, undefined);

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

test("RTD cold package downloads recover from independently packed byte-identical environments", async t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-packed-mirrors-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const relative = "xeus/xeus-python-wasm-host/kernel_packages/boost-scope_exit-1.92.0-h29704b6_0.tar.gz";
  for (const host of ["rtd", "github"]) {
    mkdirSync(join(directory, host, "xeus/xeus-python-wasm-host/kernel_packages"), { recursive: true });
    writeFileSync(join(directory, host, "service-worker.js"), "");
  }
  const fixture = spawnSync("python3", ["-c", `
import gzip
import io
import sys
import tarfile
from pathlib import Path
root = Path(sys.argv[1])
for host, timestamp, owner in [("rtd", 1700000000, 1000), ("github", 1800000000, 1001)]:
    path = root / host / sys.argv[2]
    with path.open("wb") as output:
        with gzip.GzipFile(filename=str(path), fileobj=output, mode="wb", mtime=timestamp) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                info = tarfile.TarInfo("include/boost/scope_exit.hpp")
                data = b"identical installed package contents"
                info.size = len(data)
                info.mtime = timestamp + 0.25
                info.uid = info.gid = owner
                info.uname = info.gname = host
                info.pax_headers = {"atime": str(timestamp + 0.5), "ctime": str(timestamp + 0.75)}
                archive.addfile(info, io.BytesIO(data))
`, directory, relative], { encoding: "utf8" });
  assert.equal(fixture.status, 0, fixture.stderr);
  const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
  const mirror = "https://datax-now.github.io/go/";
  const localHashes = fingerprints.fingerprintRuntime(join(directory, "rtd"), [mirror], "same-commit");
  const mirrorHashes = fingerprints.fingerprintRuntime(join(directory, "github"), [mirror], "same-commit");
  const localBytes = readFileSync(join(directory, "rtd", relative));
  const mirrorBytes = readFileSync(join(directory, "github", relative));
  const requests = [];
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, hashes: localHashes,
    self: { location: { href: scope + "service-worker.js?enableCache=true" } },
    caches: { async open() { throw new Error("cache unavailable in a cold profile"); } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch(request) {
      requests.push(request.url);
      if (request.url.startsWith(scope)) throw new TypeError("Failed to fetch. SRI's integrity checks failed.");
      if (request.url.endsWith("deployment.json")) {
        return new Response(JSON.stringify({ commit: "same-commit", files: {
          [relative]: { sha256: mirrorHashes[relative] },
        } }));
      }
      return fetch("data:application/octet-stream;base64," + mirrorBytes.toString("base64"), { integrity: request.integrity });
    },
  });
  vm.runInContext(`(${fingerprints.installRuntimeCache.toString()})(hashes, [${JSON.stringify(mirror)}], "same-commit")`, context);
  await assert.doesNotReject(async () => {
    const response = await context.maybeFromCache({ request: new Request(scope + relative), waitUntil() {} });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), localBytes);
    assert.ok(gunzipSync(localBytes).includes(Buffer.from("identical installed package contents")));
  }, "a blocked RTD package must remain downloadable from an independently built mirror");
  assert.ok(requests.includes(mirror + relative));
});

test("RTD cold kernel metadata recovers from independently ordered mirror environments", async t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-metadata-mirrors-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const relative = "xeus/xeus-python-wasm-host/empack_env_meta.json";
  const packages = [
    { name: "liblzma", version: "5.4.0", build: "h8b79025_1", filename: "liblzma-5.4.0-h8b79025_1.tar.gz",
      channel: "https://repo.prefix.dev/emscripten-forge-4x", depends: ["emscripten-abi >=4,<5.0a0"], subdir: "emscripten-wasm32" },
    { name: "pybind11", version: "2.13.6", build: "pyhc790b64_3", filename: "pybind11-2.13.6-pyhc790b64_3.tar.gz",
      channel: "conda-forge", depends: ["pybind11-global 2.13.6 *_3", "python >=3.9"], subdir: "noarch" },
  ];
  const channels = ["https://repo.prefix.dev/emscripten-forge-4x", "conda-forge"];
  for (const host of ["rtd", "github"]) {
    mkdirSync(join(directory, host, "xeus/xeus-python-wasm-host"), { recursive: true });
    writeFileSync(join(directory, host, "service-worker.js"), "");
    writeFileSync(join(directory, host, relative), JSON.stringify({
      prefix: "/", channels, packages: host === "rtd" ? packages : [...packages].reverse()
        .map(packageRecord => Object.fromEntries(Object.entries(packageRecord).reverse())),
    }, null, 2) + "\n");
  }
  const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
  const mirror = "https://datax-now.github.io/go/";
  const hashes = fingerprints.fingerprintRuntime(join(directory, "rtd"), [mirror]);
  const mirrorHashes = fingerprints.fingerprintRuntime(join(directory, "github"), [mirror]);
  const localBytes = readFileSync(join(directory, "rtd", relative));
  const metadata = JSON.parse(localBytes);
  assert.equal(metadata.prefix, "/");
  assert.deepEqual(metadata.channels, channels, "channel precedence must be preserved");
  assert.deepEqual(metadata.packages.sort((left, right) => left.name.localeCompare(right.name)), packages,
    "package records and dependency order must be preserved");
  assert.deepEqual(fingerprints.fingerprintRuntime(join(directory, "rtd"), [mirror]), hashes);
  assert.deepEqual(readFileSync(join(directory, "rtd", relative)), localBytes, "normalization must be idempotent");
  const mirrorBytes = readFileSync(join(directory, "github", relative));
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, hashes,
    self: { location: { href: scope + "service-worker.js?enableCache=true" } },
    caches: { async open() { throw new Error("cache unavailable in a cold profile"); } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch(request) {
      if (request.url.startsWith(scope)) throw new TypeError("Failed to fetch. SRI's integrity checks failed.");
      if (request.url.endsWith("deployment.json")) {
        return new Response(JSON.stringify({ files: { [relative]: { sha256: mirrorHashes[relative] } } }));
      }
      return fetch("data:application/json;base64," + mirrorBytes.toString("base64"), { integrity: request.integrity });
    },
  });
  vm.runInContext(`(${fingerprints.installRuntimeCache.toString()})(hashes, [${JSON.stringify(mirror)}])`, context);
  const response = await context.maybeFromCache({ request: new Request(scope + relative), waitUntil() {} });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), localBytes,
    "blocked RTD metadata must not prevent kernel initialization when the mirror has the same packages");
});

test("RTD restored artifacts recover build-specific WASM bytes from the Pages mirror", async t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-shared-artifact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pages = join(directory, "pages");
  const restored = join(directory, "rtd");
  const relative = "xeus/host/cairo.so.asm";
  const commit = "a".repeat(40);
  const bytes = Buffer.from("WASM bytes from the canonical build");
  mkdirSync(join(pages, "xeus/host"), { recursive: true });
  writeFileSync(join(pages, relative), bytes);
  writeFileSync(join(pages, "service-worker.js"), "");
  const hashes = fingerprints.fingerprintRuntime(pages);
  const manifest = await createDeploymentManifest(pages, commit);
  writeFileSync(join(pages, "deployment.json"), JSON.stringify(manifest));
  const transport = spawnSync("python3", ["-B", "-c", `
import importlib.util
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location("artifact", sys.argv[1])
artifact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(artifact)
root = Path(sys.argv[2])
artifact.pack(root / "pages", root / "site.tar.gz", sys.argv[3])
artifact.unpack(root / "site.tar.gz", root / "rtd", sys.argv[3])
`, new URL("./deployment-artifact.py", import.meta.url).pathname, directory, commit], { encoding: "utf8" });
  assert.equal(transport.status, 0, transport.stderr);
  assert.deepEqual(readFileSync(join(restored, "deployment.json")), readFileSync(join(pages, "deployment.json")));
  assert.deepEqual(readFileSync(join(restored, "service-worker.js")), readFileSync(join(pages, "service-worker.js")));

  const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
  const mirror = "https://datax-now.github.io/go/";
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, hashes,
    self: { location: { href: scope + "service-worker.js?enableCache=true" } },
    caches: { async open() { throw new Error("cold profile"); } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch(request) {
      if (request.url.startsWith(scope)) throw new TypeError("Failed to fetch. SRI's integrity checks failed.");
      if (request.url.endsWith("deployment.json")) return new Response(JSON.stringify(manifest));
      return fetch("data:application/octet-stream;base64," + bytes.toString("base64"), { integrity: request.integrity });
    },
  });
  const install = `(${fingerprints.installRuntimeCache.toString()})(hashes, [${JSON.stringify(mirror)}])`;
  const independentHash = createHash("sha256").update("same commit, independently built WASM").digest("hex");
  context.hashes = { [relative]: independentHash };
  vm.runInContext(install, context);
  const event = { request: new Request(scope + relative), waitUntil() {} };
  await assert.rejects(context.maybeFromCache(event), /SRI's integrity checks failed/);
  context.hashes = hashes;
  vm.runInContext(install, context);
  const response = await context.maybeFromCache(event);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(join(restored, relative)));
});

test("RTD challenges retry fingerprinted runtime assets and the web manifest", async () => {
  const requests = [];
  const packageHash = createHash("sha256").update("verified package").digest("hex");
  const packageIntegrity = `sha256-${Buffer.from(packageHash, "hex").toString("base64")}`;
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
        return new Response(JSON.stringify({ files: {
          [packagePath]: { sha256: packageHash }, [runtimePath]: { sha256: packageHash },
        } }));
      }
      const body = "verified package";
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
  assert.equal(await response.text(), "verified package");
  assert.equal(requests.length, 3);
  assert.equal(new URL(requests[1].url).href, "https://datax-now.github.io/go/deployment.json");
  assert.equal(new URL(requests[2].url).href,
    "https://datax-now.github.io/go/xeus/xeus-python-wasm-host/kernel_packages/openssl-4.0.2-hb2bca66_0.tar.gz");
  assert.equal(requests[2].mode, "cors");
  assert.equal(requests[2].credentials, "omit");
  assert.equal(requests[2].headers.has("Authorization"), false);
  assert.equal(requests[2].integrity, packageIntegrity, "mirror bytes must match this build's hash");

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

test("failed hosts fail over in priority order, skipping mismatched mirrors and cooling hosts", async () => {
  const release = "a".repeat(40);
  const runtimePath = "xeus/xeus-python-wasm-host/xpython.wasm";
  const bytes = "runtime bytes";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const requests = [];
  let clock = 0;
  const manifests = {
    "https://datax.now/deployment.json": { commit: release, files: { [runtimePath]: { sha256: "c".repeat(64) } } },
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
  ], "priority order is RTD, Vercel, Cloudflare after GitHub Pages fails; different bytes are rejected even at the same commit");

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

test("data directory listings are byte-identical across clean deployments and remain mirror-downloadable", async t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-data-index-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const listings = [];
  for (const [host, mtime] of [["github", 1000000000], ["rtd", 1700000000]]) {
    const folder = join(directory, host);
    mkdirSync(join(folder, "dist/files/data"), { recursive: true });
    mkdirSync(join(folder, "dist/api/contents"), { recursive: true });
    const file = join(folder, "dist/files/data/titanic.csv");
    writeFileSync(file, "PassengerId,Survived\n1,0\n");
    utimesSync(file, mtime, mtime);
    writeFileSync(join(folder, "dist/api/contents/all.json"), '{"content":[]}');
    const result = spawnSync("python3", ["-c", "import json\nfrom datetime" + dataIndexPatch], {
      cwd: folder, encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "1780000000" },
    });
    assert.equal(result.status, 0, result.stderr);
    const listing = readFileSync(join(folder, "dist/api/contents/data/all.json"), "utf8");
    assert.equal(JSON.parse(listing).content[0].name, "titanic.csv");
    listings.push(listing);
  }
  assert.equal(listings[0], listings[1], "build time and checkout mtimes must not invalidate the data listing's mirror hash");
  const integrity = "sha256-" + createHash("sha256").update(listings[0]).digest("base64");
  const response = await fetch("data:application/json," + encodeURIComponent(listings[1]), { integrity });
  assert.equal((await response.json()).content[0].name, "titanic.csv");
});

test("offline inventories normalize generated listing timestamps and HTML cache tokens before hashing", async t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-reproducible-offline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inventories = [];
  for (const token of ["aaaaaaa", "bbbbbbb"]) {
    const folder = join(directory, token);
    mkdirSync(join(folder, "api/contents/how-to"), { recursive: true });
    mkdirSync(join(folder, "lab"));
    const timestamp = token === "aaaaaaa" ? "2026-01-01T00:00:00Z" : "2026-10-01T00:00:00Z";
    writeFileSync(join(folder, "api/contents/how-to/all.json"), JSON.stringify({
      created: timestamp, last_modified: timestamp,
      content: [{ name: "example.ipynb", created: timestamp, last_modified: timestamp }],
    }));
    writeFileSync(join(folder, "config-utils.js"), "globalThis.started=true;");
    writeFileSync(join(folder, "lab/index.html"),
      `<html><script>import('../config-utils.js?_=${token}')</script></html>`);
    const assets = offline.prepareOffline(folder, 1780000000);
    const listing = JSON.parse(readFileSync(join(folder, "api/contents/how-to/all.json"), "utf8"));
    assert.equal(listing.content[0].name, "example.ipynb");
    assert.deepEqual(offline.prepareOffline(folder, 1780000000), assets, "normalization must be idempotent");
    assert.equal(readFileSync(join(folder, "lab/index.html.offline"), "utf8"),
      readFileSync(join(folder, "lab/index.html"), "utf8"));
    inventories.push(assets);
  }
  assert.deepEqual(inventories[0], inventories[1], "mirrors must agree on the exact bytes used for offline SRI");
  const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
  const mirror = "https://datax-now.github.io/go/";
  const assets = inventories[0];
  const stored = new Map();
  let message;
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, assets,
    self: {
      location: { href: scope + "service-worker.js?enableCache=true" },
      addEventListener(type, listener) { if (type === "message") message = listener; },
    },
    caches: { async open() { return {
      async match(key) { return stored.get(key.url ?? key)?.clone(); },
      async put(key, response) { stored.set(key.url ?? key, response.clone()); },
      async keys() { return [...stored.keys()].map(url => new Request(url)); },
    }; } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin === new URL(scope).origin) throw new TypeError("RTD challenge failed integrity");
      if (url.pathname.endsWith("/deployment.json")) {
        return new Response(JSON.stringify({ files: Object.fromEntries(Object.entries(inventories[1])
          .flatMap(([relative, asset]) => [[relative, asset], ...(asset.source ? [[asset.source, asset]] : [])])) }));
      }
      const relative = decodeURIComponent(url.pathname.slice(new URL(mirror).pathname.length));
      const bytes = readFileSync(join(directory, "bbbbbbb", relative));
      return fetch("data:application/octet-stream;base64," + bytes.toString("base64"), { integrity: request.integrity });
    },
  });
  vm.runInContext(
    `(${fingerprints.installRuntimeCache.toString()})({}, ["${mirror}"], null,
      Object.fromEntries(Object.entries(assets).flatMap(([path, asset]) =>
        [[path, asset.sha256], ...(asset.source ? [[asset.source, asset.sha256]] : [])])));` +
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
  await Promise.all(tasks);
  assert.equal(updates.at(-1).ready, true, updates.at(-1).error);
  assert.equal(updates.at(-1).completed, Object.keys(assets).length);
});

test("failed bundled directory requests surface an error and remain retryable instead of caching an empty data folder", async t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-contents-retry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "build"));
  const source = `globalThis.Contents=class {
    constructor(){this._serverContents=new Map}
    async _getServerDirectory(e){let t=this._serverContents.get(e)||new Map;if(!this._serverContents.has(e)){
      let s=u.PageConfig.getOption("contentsAllJsonFile");if(!s)return this._serverContents.set(e,t),t;
      let n=u.URLExt.join(u.PageConfig.getBaseUrl(),"api/contents",e,s);
      try{let e=await fetch(n);for(let s of JSON.parse(await e.text()).content)t.set(s.name,s)}
      catch(e){console.warn(\`don't worry, about \${e}... nothing's broken. If there had been a
          file at \${n}, you might see some more files.\`)}this._serverContents.set(e,t)}return t}
    async _ensureDirectoryExists(e){}
  };`;
  writeFileSync(join(directory, "build/contents.js"), source);
  offline.prepareOffline(directory);
  const patched = readFileSync(join(directory, "build/contents.js"), "utf8");
  let fetches = 0;
  let failure;
  const errors = [];
  const context = vm.createContext({
    u: {
      PageConfig: { getOption() { return "all.json"; }, getBaseUrl() { return "https://example.com/go/"; } },
      URLExt: { join: (...parts) => parts.join("/") },
    },
    console: { warn() {}, error(...args) { errors.push(args); } },
    async fetch() {
      fetches++;
      if (failure instanceof Error) throw failure;
      if (failure) return failure.clone();
      return new Response('{"content":[{"name":"titanic.csv","path":"data/titanic.csv"}]}');
    },
  });
  vm.runInContext(patched, context);
  for (failure of [new TypeError("Failed to fetch"), new Response("challenge", { status: 429 }),
    new Response("{}"), new Response("not JSON")]) {
    const contents = new context.Contents();
    await assert.rejects(contents._getServerDirectory("data"));
    assert.equal(contents._serverContents.has("data"), false);
    failure = null;
    const listing = await contents._getServerDirectory("data");
    assert.equal(listing.get("titanic.csv").path, "data/titanic.csv");
    const before = fetches;
    assert.equal(await contents._getServerDirectory("data"), listing);
    assert.equal(fetches, before, "successful listings retain the upstream cache behavior");
  }
  assert.equal(errors.length, 4, "each failure must be reported explicitly");
  offline.prepareOffline(directory);
  assert.equal(readFileSync(join(directory, "build/contents.js"), "utf8"), patched);
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

test("RTD runtime fallback cannot mark different mirror bytes as offline ready", async () => {
  const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
  const mirror = "https://datax-now.github.io/go/";
  const relative = "xeus/xeus-python-wasm-host/kernel_packages/lz4-c-1.10.0-h906537b_2.tar.gz";
  const body = "local build package";
  const mirrorBody = "different mirror package";
  const sha256 = createHash("sha256").update(body).digest("hex");
  const mirrorHash = createHash("sha256").update(mirrorBody).digest("hex");
  const stored = new Map();
  let message;
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa,
    hashes: { [relative]: sha256 },
    assets: { [relative]: { sha256, size: Buffer.byteLength(body) } },
    assetHashes: { [relative]: sha256 },
    self: {
      location: { href: scope + "service-worker.js?enableCache=true" },
      addEventListener(type, listener) { if (type === "message") message = listener; },
    },
    caches: { async open() { return {
      async match(key) { return stored.get(key.url ?? key)?.clone(); },
      async put(key, response) { stored.set(key.url ?? key, response.clone()); },
      async keys() { return [...stored.keys()].map(key => new Request(key)); },
      async delete(key) { return stored.delete(key.url ?? key); },
    }; } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch(request) {
      if (request.url.startsWith(scope)) {
        throw new TypeError("Fetch API cannot load RTD asset. SRI's integrity checks failed.");
      }
      if (request.url.endsWith("deployment.json")) {
        return new Response(JSON.stringify({ commit: "same-commit", files: { [relative]: { sha256: mirrorHash } } }));
      }
      return fetch("data:application/octet-stream," + encodeURIComponent(mirrorBody), { integrity: request.integrity });
    },
  });
  vm.runInContext(
    `(${fingerprints.installRuntimeCache.toString()})(hashes, [${JSON.stringify(mirror)}], "same-commit", assetHashes);` +
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
  await Promise.all(tasks);
  assert.equal(updates.at(-1).ready, false, "a mismatched kernel package must not report Offline ready");
  assert.match(updates.at(-1).error, /lz4-c/);
  assert.equal(stored.size, 0, "mirror bytes must not poison this build's runtime hash or readiness marker");
});

test("offline upgrades ignore old runtime entries without losing verified application assets", async () => {
  const scope = "https://example.com/go/";
  const bodies = { "lab/index.html": "verified shell", "xeus/runtime.wasm": "current runtime" };
  const assets = Object.fromEntries(Object.entries(bodies).map(([relative, body]) => [relative, {
    sha256: createHash("sha256").update(body).digest("hex"), size: Buffer.byteLength(body),
  }]));
  const runtimeKey = scope + "xeus/runtime.wasm?sha256=" + assets["xeus/runtime.wasm"].sha256;
  const shellKey = scope + "lab/index.html?sha256=" + assets["lab/index.html"].sha256;
  const stored = new Map([
    [runtimeKey, new Response("wrong mirror runtime")],
    [shellKey, new Response(bodies["lab/index.html"])],
    [scope + "datax-offline-ready", new Response("")],
  ]);
  const listeners = {};
  const downloads = [];
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, assets,
    hashes: { "xeus/runtime.wasm": assets["xeus/runtime.wasm"].sha256 },
    self: {
      location: { href: scope + "service-worker.js?enableCache=true" },
      addEventListener(type, listener) { listeners[type] = listener; },
    },
    caches: { async open() { return {
      async match(key) { return stored.get(key.url ?? key)?.clone(); },
      async put(key, response) { stored.set(key.url ?? key, response.clone()); },
      async keys() { return [...stored.keys()].map(key => new Request(key)); },
      async delete(key) { return stored.delete(key.url ?? key); },
    }; } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch(request) {
      const relative = new URL(request.url).pathname.slice(new URL(scope).pathname.length);
      downloads.push(relative);
      return fetch("data:application/octet-stream," + encodeURIComponent(bodies[relative]), { integrity: request.integrity });
    },
  });
  vm.runInContext(
    `(${fingerprints.installRuntimeCache.toString()})(hashes);(${offline.installOfflineCache.toString()})(assets);`,
    context,
  );
  const dispatch = async (type, extra = {}) => {
    const tasks = [];
    listeners[type]({ ...extra, waitUntil(task) { tasks.push(task); } });
    await Promise.all(tasks);
  };
  const updates = [];
  await dispatch("message", {
    data: { type: "datax-offline-status" }, source: { url: scope + "lab/" },
    ports: [{ postMessage(update) { updates.push(update); } }],
  });
  assert.equal(updates.at(-1).ready, false, "an old poisoned runtime key must not count toward readiness");
  await dispatch("install");
  assert.deepEqual(downloads, ["xeus/runtime.wasm"], "offline opt-in is preserved and verified app assets are reused");
  assert.equal(await stored.get(runtimeKey + "&verified=local").text(), bodies["xeus/runtime.wasm"]);
  await dispatch("activate");
  assert.equal(stored.has(runtimeKey), false, "activation prunes the unsafe legacy key");
  assert.equal(stored.has(shellKey), true);
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
  const keyFor = (relative, asset) => scope + relative + "?sha256=" + asset.sha256 +
    (relative.startsWith("xeus/") ? "&verified=local" : "");
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
    connectTo({ model, handleComms }) {
      assert.equal(handleComms, false, "the offline observer must not claim notebook widget comms during cold startup");
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
    for (const name of ["service-worker.js", "deployment.json", "xpython-deploy-manifest.json", "datax-now.zip", "cors_server.py", "lazy.js"]) writeFileSync(join(directory, name), "asset");
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

test("RTD offline download completes despite unavailable timestamped diagnostics", async t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-offline-diagnostics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "build"));
  mkdirSync(join(directory, "xeus"));
  writeFileSync(join(directory, "build/app.js"), "app bundle");
  writeFileSync(join(directory, "xeus/runtime.wasm"), "runtime bytes");
  writeFileSync(join(directory, "xpython-deploy-manifest.json"), '{"deploy_timestamp":"first build"}');
  const assets = offline.prepareOffline(directory);
  const hashes = { "xeus/runtime.wasm": assets["xeus/runtime.wasm"].sha256 };
  const assetHashes = Object.fromEntries(Object.entries(assets).map(([relative, asset]) => [relative, asset.sha256]));
  const scope = "https://datax-now.readthedocs.io/en/latest/_static/";
  const mirror = "https://datax-now.github.io/go/";
  const stored = new Map();
  const requests = [];
  const cache = {
    async match(key) { return stored.get(key.url ?? key)?.clone(); },
    async put(key, response) { stored.set(key.url ?? key, response.clone()); },
    async keys() { return [...stored.keys()].map(key => new Request(key)); },
    async delete(key) { return stored.delete(key.url ?? key); },
  };
  let message;
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, assets, hashes, assetHashes, mirrors: [mirror],
    self: {
      location: { href: scope + "service-worker.js?enableCache=true" },
      addEventListener(type, listener) { if (type === "message") message = listener; },
    },
    caches: { async open() { return cache; } },
    async maybeFromCache(event) { return context.fetch(event.request); },
    async fetch(request) {
      requests.push(request.url);
      const url = new URL(request.url);
      if (url.origin === new URL(scope).origin) throw new TypeError("SRI failed on RTD challenge");
      if (url.pathname === "/go/deployment.json") {
        return new Response(JSON.stringify({
          commit: "b".repeat(40),
          files: Object.fromEntries(Object.entries(assetHashes).map(([relative, sha256]) => [relative, { sha256 }])),
        }));
      }
      const relative = url.pathname.slice(new URL(mirror).pathname.length);
      const bytes = relative === "xpython-deploy-manifest.json"
        ? '{"deploy_timestamp":"different mirror build"}'
        : readFileSync(join(directory, relative), "utf8");
      return fetch("data:application/octet-stream," + encodeURIComponent(bytes), { integrity: request.integrity });
    },
  });
  vm.runInContext(
    `(${fingerprints.installRuntimeCache.toString()})(hashes, mirrors, null, assetHashes);` +
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
  await Promise.all(tasks);
  assert.equal(updates.at(-1).ready, true, updates.at(-1).error);
  assert.equal(updates.at(-1).completed, Object.keys(assets).length);
  assert.equal(updates.at(-1).bytes, Object.values(assets).reduce((total, asset) => total + asset.size, 0));
  assert.equal(stored.size, Object.keys(assets).length + 1, "every required asset and the readiness marker must be stored");
  assert.ok(requests.includes(mirror + "build/app.js"));
  assert.ok(requests.includes(mirror + "xeus/runtime.wasm"));
  assert.equal(requests.some(url => url.endsWith("/xpython-deploy-manifest.json")), false);
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