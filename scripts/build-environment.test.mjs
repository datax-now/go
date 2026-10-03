import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const build = readFileSync(new URL("../build.sh", import.meta.url), "utf8");
const initialization = build.split("# Pinned dependency versions")[0];
const liteBuild = build.split('echo "Building JupyterLite..."')[1]
  .split('rm -rf "$PWD/dist/extensions/@jupyterlite/pyodide-kernel-extension"')[0];

test("Vercel initializes reproducible metadata without a Git checkout", t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-vercel-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, "build.sh");
  writeFileSync(script, initialization + '\nprintf "%s\\n" "$SOURCE_DATE_EPOCH"\n');
  const env = { ...process.env, VERCEL_GIT_COMMIT_SHA: "a".repeat(40) };
  delete env.SOURCE_DATE_EPOCH;
  const result = spawnSync("bash", [script], { cwd: directory, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "0", "all hosts must use the same Git-independent default");
});

test("metadata timestamp overrides are preserved and invalid overrides fail explicitly", t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-build-epoch-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, "build.sh");
  writeFileSync(script, initialization + '\nprintf "%s\\n" "$SOURCE_DATE_EPOCH"\n');
  const run = epoch => spawnSync("bash", [script], {
    cwd: directory, encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: epoch },
  });
  const overridden = run("1780000000");
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.equal(overridden.stdout.trim(), "1780000000");
  const invalid = run("not-a-timestamp");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /SOURCE_DATE_EPOCH must be a nonnegative Unix timestamp/);
});

test("JupyterLite does not inherit the metadata epoch, and later normalization still does", () => {
  const result = spawnSync("bash", ["-c", `
    set -euo pipefail
    export SOURCE_DATE_EPOCH=1780000000
    JUPYTER_LITE_BUILD_ARGS=(--contents notebooks --output-dir dist)
    mamba_run_deploy() {
      [[ "$*" == "jupyter lite build --contents notebooks --output-dir dist" ]]
      python3 -c 'import os; assert "SOURCE_DATE_EPOCH" not in os.environ, "SOURCE_DATE_EPOCH leaked into JupyterLite"'
    }
    ${liteBuild}
    [[ "$SOURCE_DATE_EPOCH" == "1780000000" ]]
    python3 -c 'import os; assert os.environ["SOURCE_DATE_EPOCH"] == "1780000000"'
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
