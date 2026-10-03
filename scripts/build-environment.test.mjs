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

test("kernel archives are normalized with the pinned deployment Python before inventory hashing", () => {
  assert.match(build, /DATAX_BUILD_PYTHON="\$DEPLOY_PREFIX\/bin\/python" node "\$REPO_ROOT\/scripts\/fingerprint-runtime\.cjs" dist/);
  const offline = readFileSync(new URL("./offline-cache.cjs", import.meta.url), "utf8");
  assert.ok(offline.indexOf("normalize-kernel-packages.py") < offline.indexOf("assets[relative] ="));
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
