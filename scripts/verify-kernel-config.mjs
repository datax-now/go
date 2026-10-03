import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyKernelConfig(directory) {
  const readJson = relative => JSON.parse(readFileSync(join(directory, relative), "utf8"));
  const kernels = readJson("xeus/kernels.json");
  assert.deepEqual(kernels, [{ kernel: "xpython", env_name: "xeus-python-wasm-host" }],
    "DataX must be the only published Xeus kernel");
  const spec = readJson("xeus/xeus-python-wasm-host/xpython/kernel.json");
  assert.equal(spec.display_name, "DataX");
  assert.equal(spec.language, "python");
  assert.equal(existsSync(join(directory, "extensions/@jupyterlite/pyodide-kernel-extension")), false,
    "Pyodide assets must not be published");

  const configs = ["jupyter-lite.json", ...readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, "jupyter-lite.json")))
    .map(entry => `${entry.name}/jupyter-lite.json`)];
  for (const relative of configs) {
    const data = readJson(relative);
    assert.equal(data.defaultKernelName, "xpython", `${relative}: default kernel must be DataX`);
    const config = data["jupyter-config-data"];
    assert.equal(config?.defaultKernelName, "xpython", `${relative}: app default must be DataX`);
    assert.equal(data.xeusKernelPoolWarm, 0, `${relative}: background warm-up must be disabled`);
    assert.equal(data.xeusAutoPrewarm, false, `${relative}: automatic prewarm must be disabled`);
    assert.equal(data.xeusKernelPoolRecycleEnabled, true, `${relative}: on-demand worker reuse must preserve the default`);
    assert.equal(config.federated_extensions?.some(extension => extension.name.includes("pyodide")) ?? false, false,
      `${relative}: Pyodide must not be registered`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyKernelConfig(process.argv[2] || "dist");
  console.log("Verified DataX is the only published kernel, with on-demand workers.");
}
