import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import offline from "./offline-cache.cjs";
import { createDeploymentManifest } from "./deployment-manifest.mjs";

const build = readFileSync(new URL("../build.sh", import.meta.url), "utf8");
const initialization = build.split("# Pinned dependency versions")[0];
const liteBuild = build.split('echo "Building JupyterLite..."')[1]
  .split('rm -rf "$PWD/dist/extensions/@jupyterlite/pyodide-kernel-extension"')[0];
const publicFilesPatch = build.split('echo "Publishing directly accessible files..."')[1]
  .split("python3 <<'PY'\n")[1].split("\nPY")[0];

test("Vercel initializes build metadata without a Git checkout, ignoring an injected epoch of 0", t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-vercel-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = join(directory, "build.sh");
  writeFileSync(script, initialization + '\nprintf "%s\\n" "$SOURCE_DATE_EPOCH"\n');
  const run = extra => {
    const env = { ...process.env, VERCEL_GIT_COMMIT_SHA: "a".repeat(40), ...extra };
    if (!extra.SOURCE_DATE_EPOCH) delete env.SOURCE_DATE_EPOCH;
    return spawnSync("bash", [script], { cwd: directory, env, encoding: "utf8" });
  };
  const before = Math.floor(Date.now() / 1000);
  for (const result of [run({}), run({ SOURCE_DATE_EPOCH: "0" })]) {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Number(result.stdout.trim()) >= before, "built-in files must never be stamped as 1970");
  }
  assert.match(run({ SOURCE_DATE_EPOCH: "0" }).stderr, /SOURCE_DATE_EPOCH=0/);
});

test("a build without any commit information fails immediately instead of after the long build", t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-no-commit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "scripts"));
  copyFileSync(new URL("../build.sh", import.meta.url), join(directory, "build.sh"));
  copyFileSync(new URL("./deployment-manifest.mjs", import.meta.url), join(directory, "scripts/deployment-manifest.mjs"));
  const env = { ...process.env };
  for (const name of ["VERCEL_GIT_COMMIT_SHA", "CF_PAGES_COMMIT_SHA", "GITHUB_SHA", "GIT_DIR"]) delete env[name];
  const result = spawnSync("bash", [join(directory, "build.sh")], { cwd: directory, env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /cannot determine the build commit/);
  assert.doesNotMatch(result.stdout, /Micromamba|Downloading/);
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

test("public files are copied outside notebook contents into the deployment root", async t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-public-files-build-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "public-files/videos"), { recursive: true });
  mkdirSync(join(directory, "dist/files/examples/data"), { recursive: true });
  writeFileSync(join(directory, "public-files/videos/demo.mp4"), "video bytes");
  writeFileSync(join(directory, "dist/files/examples/data/notebook-content.txt"), "notebook data");
  const result = spawnSync("python3", ["-c", publicFilesPatch], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(directory, "dist/public-files/videos/demo.mp4"), "utf8"), "video bytes");
  assert.equal(readFileSync(join(directory, "dist/files/examples/data/notebook-content.txt"), "utf8"), "notebook data");
  assert.match(result.stdout, /Published 1 files under dist\/public-files\//);
  const manifest = await createDeploymentManifest(join(directory, "dist"), "a".repeat(40));
  assert.ok(manifest.files["public-files/videos/demo.mp4"], "public files are included in the published deployment inventory");

  const collision = spawnSync("python3", ["-c", publicFilesPatch], { cwd: directory, encoding: "utf8" });
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /public files destination already exists/);
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

test("kernel archives are normalized with the pinned deployment Python before inventory hashing", () => {
  assert.match(build, /DATAX_BUILD_PYTHON="\$DEPLOY_PREFIX\/bin\/python" node "\$REPO_ROOT\/scripts\/fingerprint-runtime\.cjs" dist/);
  const offline = readFileSync(new URL("./offline-cache.cjs", import.meta.url), "utf8");
  assert.ok(offline.indexOf("normalize-kernel-packages.py") < offline.indexOf("assets[relative] ="));
});

test("bundled esbuild files are included in the offline and deployment inventories", async t => {
  assert.match(build, /ESBUILD_VERSION="0\.28\.2"/);

  const directory = mkdtempSync(join(tmpdir(), "datax-esbuild-offline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const packageDirectory = join(directory, "packages", "esbuild-wasm");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "browser.min.js"), "esbuild browser bundle");
  writeFileSync(join(packageDirectory, "esbuild.wasm"), "esbuild wasm module");

  const offlineAssets = offline.prepareOffline(directory, "0");
  const deployment = await createDeploymentManifest(directory, "a".repeat(40));
  for (const asset of ["packages/esbuild-wasm/browser.min.js", "packages/esbuild-wasm/esbuild.wasm"]) {
    assert.ok(offlineAssets[asset], `${asset} is available for offline download`);
    assert.ok(deployment.files[asset], `${asset} is included in deployment.json`);
  }
});

test("kernel archive normalization preserves payloads, links, modes and member order", t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-package-semantics-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = new URL("./normalize-kernel-packages.py", import.meta.url).pathname;
  const result = spawnSync("python3", ["-B", "-c", `
import importlib.util
import io
from pathlib import Path
import sys
import tarfile
spec = importlib.util.spec_from_file_location("normalizer", sys.argv[1])
normalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(normalizer)
root = Path(sys.argv[2])
archive = root / "package.tar.gz"
with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as output:
    directory = tarfile.TarInfo("lib")
    directory.type = tarfile.DIRTYPE
    directory.mode = 0o755
    output.addfile(directory)
    for name, content in [("lib/z-script", b"#!/bin/sh\\n"), ("lib/duplicate", b"old"), ("lib/duplicate", b"new"),
                          ("lib/" + "long-name-" * 20, b"long path")]:
        member = tarfile.TarInfo(name)
        member.size = len(content)
        member.mode = 0o751
        member.uid = member.gid = 1001
        member.uname = member.gname = "build-host"
        member.mtime = 1700000000.5
        member.pax_headers = {"atime": "1700000001.25", "ctime": "1700000002.5", "comment": "keep"}
        output.addfile(member, io.BytesIO(content))
    for name, kind in [("lib/a-hardlink", tarfile.LNKTYPE), ("lib/a-symlink", tarfile.SYMTYPE)]:
        member = tarfile.TarInfo(name)
        member.type = kind
        member.linkname = "lib/z-script" if kind == tarfile.LNKTYPE else "z-script"
        output.addfile(member)
def snapshot():
    with tarfile.open(archive, "r:gz") as source:
        result = []
        for member in source:
            payload = source.extractfile(member).read() if member.isfile() else None
            stable_pax = {key: value for key, value in member.pax_headers.items()
                          if key not in normalizer.VOLATILE_PAX_FIELDS}
            result.append((member.name, member.type, member.mode, member.size, member.linkname, stable_pax, payload))
        return result
before = snapshot()
assert normalizer.normalize_archive(archive, 123)
assert snapshot() == before, "normalization changed extraction semantics or file bytes"
with tarfile.open(archive, "r:gz") as source:
    for member in source:
        assert member.mtime == 123
        assert member.uid == member.gid == 0
        assert member.uname == member.gname == ""
        assert not normalizer.VOLATILE_PAX_FIELDS.intersection(member.pax_headers)
raw = archive.read_bytes()
assert raw[3] == 0 and raw[4:8] == b"\\0\\0\\0\\0", "gzip must omit filenames and use a fixed timestamp"
assert not normalizer.normalize_archive(archive, 123), "normalization must be idempotent"
assert archive.read_bytes() == raw
with tarfile.open(archive, "r:gz") as source:
    assert source.extractfile("lib/a-hardlink").read() == b"#!/bin/sh\\n"
bad = root / "corrupt.tar.gz"
bad.write_bytes(b"not an archive")
try:
    normalizer.normalize_archive(bad, 123)
except tarfile.ReadError:
    pass
else:
    raise AssertionError("corrupt archive must fail explicitly")
assert bad.read_bytes() == b"not an archive"
assert not list(root.glob(".datax-package-*")), "temporary output must be cleaned up"
`, script, directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const invalid = spawnSync("python3", [script, directory], {
    encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "invalid" },
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /SOURCE_DATE_EPOCH must be a nonnegative Unix timestamp/);
});

test("patched Quak conda ZIP entries are reproducible without changing their payloads", t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-quak-zip-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = new URL("./patch_quak_widget.py", import.meta.url).pathname;
  const result = spawnSync("python3", ["-B", "-c", `
import ast
from pathlib import Path
import sys
import textwrap
import zipfile
from unittest.mock import patch
root = Path(sys.argv[2])
source = Path(sys.argv[1]).read_text()
tree = ast.parse(source)
writer = next(node for node in ast.walk(tree)
              if isinstance(node, ast.With)
              and ast.get_source_segment(source, node.items[0].context_expr) == 'zipfile.ZipFile(temporary, "w")')
code = compile(textwrap.dedent(ast.get_source_segment(source, writer)), sys.argv[1], "exec")
contents = {"metadata.json": b'{"conda_pkg_format_version":2}',
            "pkg-quak.tar.zst": b"identical compressed patched widget",
            "info-quak.tar.zst": b"identical compressed paths metadata"}
outputs = []
for index, timestamp in enumerate([(2026, 10, 3, 14, 10, 0, 5, 276, 0), (2026, 10, 3, 14, 20, 0, 5, 276, 0)]):
    temporary = root / f"quak-{index}.conda"
    with patch("zipfile.time.localtime", return_value=timestamp):
        exec(code, {"zipfile": zipfile, "temporary": temporary, "contents": contents})
    with zipfile.ZipFile(temporary) as archive:
        assert {name: archive.read(name) for name in archive.namelist()} == contents
    outputs.append(temporary.read_bytes())
assert outputs[0] == outputs[1], "build-time ZIP timestamps prevent integrity-verified mirror fallback"
`, script, directory], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
