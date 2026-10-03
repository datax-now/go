const fs = require('node:fs');
const path = require('node:path');

function replaceOnce(source, pattern, replacement, label) {
  let count = 0;
  const result = source.replace(pattern, (...args) => {
    count += 1;
    return typeof replacement === 'function' ? replacement(...args) : replacement;
  });
  if (count !== 1) throw new Error(`Expected one ${label}, found ${count}`);
  return result;
}

function patchWorker(source) {
  if (source.includes('dataxWasmStartupFailure')) return source;
  source = replaceOnce(source,
    /instantiateWasm:\(([\w$]+),([\w$]+)\)=>\(([\w$]+)\.instantiateWasmWithProfiling\(([^,]+),\1,\2\)\.catch\([\s\S]*?\}\),\{\}\)/g,
    (_, imports, receive, owner, binary) =>
      `instantiateWasm:(${imports},${receive})=>${owner}.instantiateWasmWithProfiling(${binary},${imports},${receive})`,
    'WASM instantiation callback');
  return replaceOnce(source,
    /async instantiateWasmWithProfiling\([^)]*\)\{[\s\S]*?\}get emscriptenMajorVersion/g,
    `async instantiateWasmWithProfiling(binaryWASM,imports,receiveInstance){
      const dataxWasmStartupFailure=true;
      const fetchStart=this.nowMs?.();
      const response=await fetch(binaryWASM);
      if(!response.ok){
        const challenge=response.headers.get("cf-mitigated")==="challenge";
        throw new Error("HTTP error fetching WASM! status: "+response.status+" URL: "+binaryWASM+
          (challenge?" (Cloudflare challenge blocked the kernel asset; the hosting administrator must allow static runtime downloads.)":""));
      }
      const bytes=await response.arrayBuffer();
      this.recordStartupPhase?.("wasm_fetch",fetchStart,{wasm_url:binaryWASM,wasm_bytes:bytes.byteLength});
      const instantiateStart=this.nowMs?.();
      const result=await WebAssembly.instantiate(bytes,imports);
      this.recordStartupPhase?.("wasm_instantiate",instantiateStart);
      receiveInstance(result.instance,result.module);
    }get emscriptenMajorVersion`,
    'WASM fetch implementation');
}

function patchRuntime(source) {
  if (source.includes('dataxRejectWasmStartup')) return source;
  return replaceOnce(source,
    'return new Promise((resolve,reject)=>{Module["instantiateWasm"](info,(mod,inst)=>{resolve(receiveInstance(mod,inst))})})',
    'return new Promise((resolve,reject)=>{Promise.resolve().then(()=>Module["instantiateWasm"](info,(mod,inst)=>{resolve(receiveInstance(mod,inst))})).catch(function dataxRejectWasmStartup(error){readyPromiseReject(error);reject(error)})})',
    'Emscripten startup promise');
}

function patchKernelMessages(source) {
  const marker = '/* datax-kernel-message-ready */';
  const rejectReady = '.then(this._ready.resolve.bind(this._ready),this._ready.reject.bind(this._ready))';
  if (source.includes(marker)) {
    if (!source.includes(rejectReady)) throw new Error('Kernel message barrier is missing initialization error propagation');
    return source;
  }
  source = replaceOnce(source,
    /async handleMessage\(([\w$]+)\)\{let ([\w$]+)="input_reply"!==\1\.header\.msg_type,([\w$]+)=async\(\)=>\{/g,
    match => match + marker + 'await this.ready;',
    'kernel message readiness barrier');
  return replaceOnce(source,
    '.then(this._ready.resolve.bind(this._ready))',
    rejectReady,
    'kernel initialization failure propagation');
}

function patchLibraries(source, suffix = '.asm') {
  if (source.includes('dataxLibraryURL')) return source;
  source = replaceOnce(source,
    'readAsync=async url=>{var response=await fetch(url,{credentials:"same-origin"});',
    `readAsync=async url=>{const dataxLibraryURL=new URL(url,globalThis.location.href);if(dataxLibraryURL.pathname.endsWith(".so")){dataxLibraryURL.pathname+=${JSON.stringify(suffix)};url=dataxLibraryURL.href;}var response=await fetch(url,{credentials:"same-origin"});`,
    'shared library URL loader');
  return replaceOnce(source,
    'removeRunDependency("loadDylibs")})',
    'removeRunDependency("loadDylibs")}).catch(error=>{ABORT=true;readyPromiseReject(error)})',
    'shared library startup rejection');
}

function patchDirectory(directory) {
  const workers = path.join(directory, 'extensions/@jupyterlite/xeus-extension/static');
  const scripts = fs.readdirSync(workers).filter(name => name.endsWith('.js'));
  const files = scripts
    .filter(name => name.includes('.worker.') && name.endsWith('.js'))
    .map(name => [path.join(workers, name), patchWorker])
    .filter(([file]) => fs.readFileSync(file, 'utf8').includes('instantiateWasmWithProfiling'));
  if (!files.length) throw new Error('No Xeus WASM workers found');
  const messageKernels = scripts.map(name => path.join(workers, name))
    .filter(file => fs.readFileSync(file, 'utf8').includes('this._messageQueue.then('));
  if (!messageKernels.length) throw new Error('No Xeus kernel message queues found');
  for (const file of messageKernels) {
    const existing = files.find(entry => entry[0] === file);
    if (existing) {
      const patch = existing[1];
      existing[1] = source => patchKernelMessages(patch(source));
    } else files.push([file, patchKernelMessages]);
  }
  const runtime = path.join(directory, 'xeus/xeus-python-wasm-host');
  const suffix = (process.env.SAFE_EXT_SUFFIXES || 'whl so').split(/\s+/).includes('so')
    ? (process.env.SAFE_ASM_EXT || '.asm') : '';
  for (const name of ['xpython.js', 'bin/xpython.js']) {
    files.push([path.join(runtime, name), source => patchLibraries(patchRuntime(source), suffix)]);
  }
  const updates = files.map(([file, patch]) => [file, patch(fs.readFileSync(file, 'utf8'))]);
  for (const [file, source] of updates) fs.writeFileSync(file, source);
  console.log(`Patched WASM startup failure propagation in ${updates.length} files`);
}

function installLibraryAliases(aliases) {
  const original = globalThis.fetch;
  const base = new URL('../../../../', globalThis.location.href);
  globalThis.fetch = function(input, options) {
    const url = new URL(input instanceof Request ? input.url : input, globalThis.location.href);
    if (url.origin === base.origin && url.pathname.startsWith(base.pathname)) {
      const target = aliases[decodeURIComponent(url.pathname.slice(base.pathname.length))];
      if (target) {
        url.pathname = base.pathname + target;
        input = input instanceof Request ? new Request(url.href, input) : url.href;
      }
    }
    return original.call(this, input, options);
  };
}

function compactLibraries(directory, suffix = '.asm') {
  const runtime = 'xeus/xeus-python-wasm-host/';
  const extension = 'extensions/@jupyterlite/xeus-extension/static/';
  const aliases = {};
  const duplicates = [];
  let savedBytes = 0;
  for (const folder of [runtime + 'bin/', extension]) {
    for (const name of fs.readdirSync(path.join(directory, folder)).sort()) {
      if (!/^[^/]+\.so(?:\.[^/]+)?$/.test(name)) continue;
      const duplicate = path.join(directory, folder, name);
      const canonical = path.join(directory, runtime, name);
      if (!fs.existsSync(canonical) || !fs.statSync(duplicate).isFile()) continue;
      const bytes = fs.readFileSync(duplicate);
      if (!bytes.equals(fs.readFileSync(canonical))) continue;
      const relative = folder + name;
      aliases[relative] = runtime + name;
      if (suffix && name.endsWith('.so' + suffix)) aliases[relative.slice(0, -suffix.length)] = runtime + name;
      duplicates.push(duplicate);
      savedBytes += bytes.length;
    }
  }
  if (!duplicates.length) return { removedFiles: 0, savedBytes: 0 };
  const workers = fs.readdirSync(path.join(directory, extension))
    .filter(name => name.includes('.worker.') && name.endsWith('.js'));
  if (!workers.length) throw new Error('Cannot remove shared libraries without a kernel worker');
  for (const name of workers) {
    const worker = path.join(directory, extension, name);
    const source = fs.readFileSync(worker, 'utf8');
    if (source.includes('/* datax-library-aliases */')) throw new Error('Library aliases already installed');
    fs.writeFileSync(worker, `;/* datax-library-aliases */\n(${installLibraryAliases.toString()})(${JSON.stringify(aliases)});\n` + source);
  }
  for (const filename of duplicates) fs.unlinkSync(filename);
  console.log(`Removed ${duplicates.length} duplicate shared libraries (${(savedBytes / 1048576).toFixed(1)} MiB)`);
  return { removedFiles: duplicates.length, savedBytes };
}

module.exports = { patchWorker, patchRuntime, patchKernelMessages, patchLibraries, patchDirectory, installLibraryAliases, compactLibraries };
if (require.main === module) {
  if (process.argv[3] === '--compact') compactLibraries(process.argv[2] || 'dist', process.env.SAFE_ASM_EXT || '.asm');
  else patchDirectory(process.argv[2] || 'dist');
}