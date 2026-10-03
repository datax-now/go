import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyKernelConfig } from "./verify-kernel-config.mjs";

test("published site exposes only DataX and fails verification on extra kernels", () => {
  const directory = mkdtempSync(join(tmpdir(), "datax-kernel-config-"));
  const kernel = "xeus/xeus-python-wasm-host/xpython";
  const spec = { kernel: "xpython", env_name: "xeus-python-wasm-host" };
  const config = {
    defaultKernelName: "xpython",
    xeusKernelPoolWarm: 0, xeusAutoPrewarm: false, xeusKernelPoolRecycleEnabled: true,
    "jupyter-config-data": { defaultKernelName: "xpython", federated_extensions: [{ name: "@jupyterlite/xeus-extension" }] },
  };
  function write(relative, data) { writeFileSync(join(directory, relative), JSON.stringify(data)); }
  try {
    mkdirSync(join(directory, kernel), { recursive: true });
    mkdirSync(join(directory, "lab"));
    write("xeus/kernels.json", [spec]);
    write(`${kernel}/kernel.json`, { display_name: "DataX", language: "python" });
    for (const relative of ["jupyter-lite.json", "lab/jupyter-lite.json"]) write(relative, config);
    verifyKernelConfig(directory);
    write("xeus/kernels.json", [spec, { kernel: "python", env_name: "pyodide" }]);
    assert.throws(() => verifyKernelConfig(directory), /only published/);
    write("xeus/kernels.json", [spec]);
    write("lab/jupyter-lite.json", {
      ...config, "jupyter-config-data": { ...config["jupyter-config-data"], federated_extensions: [{ name: "@jupyterlite/pyodide-kernel-extension" }] },
    });
    assert.throws(() => verifyKernelConfig(directory), /Pyodide must not be registered/);
    write("lab/jupyter-lite.json", config);
    mkdirSync(join(directory, "extensions/@jupyterlite/pyodide-kernel-extension"), { recursive: true });
    assert.throws(() => verifyKernelConfig(directory), /Pyodide assets must not be published/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("every bundled notebook selects DataX or inherits the DataX default", () => {
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".ipynb")) {
        const spec = JSON.parse(readFileSync(path, "utf8")).metadata?.kernelspec;
        if (spec) {
          assert.equal(spec.name, "xpython", path);
          assert.equal(spec.display_name, "DataX", path);
        }
      }
    }
  }
  visit(fileURLToPath(new URL("../notebooks/", import.meta.url)));
});
