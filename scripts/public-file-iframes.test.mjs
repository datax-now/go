import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { patchCoreBundle, rewritePublicFileIframes } from "./patch-public-file-iframes.mjs";

test("public-file iframe URLs resolve to the current deployment before navigation", () => {
  const html = `<iframe src="https://datax-now.github.io/go/public-files/videos/demo%20clip.mp4"></iframe>
    <iframe src='https://datax.now/public-files/videos/other.mp4?download=1&amp;size=large'></iframe>
    <a href="https://datax-now.github.io/go/public-files/videos/link.mp4">link</a>
    <iframe src="https://example.com/public-files/videos/external.mp4"></iframe>`;

  assert.equal(rewritePublicFileIframes(html, "https://datax-now.readthedocs.io/en/latest/_static/lab/index.html"),
    `<iframe src="https://datax-now.readthedocs.io/en/latest/_static/public-files/videos/demo%20clip.mp4"></iframe>
    <iframe src='https://datax-now.readthedocs.io/en/latest/_static/public-files/videos/other.mp4?download=1&amp;size=large'></iframe>
    <a href="https://datax-now.github.io/go/public-files/videos/link.mp4">link</a>
    <iframe src="https://example.com/public-files/videos/external.mp4"></iframe>`);
  assert.match(
    rewritePublicFileIframes(html, "http://localhost:5797/lab/index.html"),
    /src="http:\/\/localhost:5797\/public-files\/videos\/demo%20clip\.mp4"/,
  );
});

test("JupyterLab's HTML renderer bundle is patched once and safely fails on an unknown build", t => {
  const directory = mkdtempSync(join(tmpdir(), "datax-public-file-iframe-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bundle = join(directory, "jlab_core.abc123.js");
  const original = 'function render(n){return i.innerHTML=o,i.getElementsByTagName("script").length>0}';
  writeFileSync(bundle, original);

  assert.equal(patchCoreBundle(directory), true);
  const patched = readFileSync(bundle, "utf8");
  assert.match(patched, /rewritePublicFileIframes/);
  assert.notEqual(patched, original);
  assert.equal(patchCoreBundle(directory), false, "an already-patched bundle should be left unchanged");

  const unknown = join(directory, "other.js");
  writeFileSync(unknown, "function render() {}");
  assert.throws(() => patchCoreBundle(unknown), /Could not locate JupyterLab's HTML renderer/);
});
