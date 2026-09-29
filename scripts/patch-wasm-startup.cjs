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
  const files = fs.readdirSync(workers)
    .filter(name => name.includes('.worker.') && name.endsWith('.js'))
    .map(name => [path.join(workers, name), patchWorker])
    .filter(([file]) => fs.readFileSync(file, 'utf8').includes('instantiateWasmWithProfiling'));
  if (!files.length) throw new Error('No Xeus WASM workers found');
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

module.exports = { patchWorker, patchRuntime, patchLibraries, patchDirectory };
if (require.main === module) patchDirectory(process.argv[2] || 'dist');