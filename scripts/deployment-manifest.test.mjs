import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeploymentManifest, resolveCommit, verifyDeployments } from "./deployment-manifest.mjs";

const commit = "a".repeat(40);

test("uses the Vercel commit SHA when building without a Git checkout", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deployment-no-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(resolveCommit({ VERCEL_GIT_COMMIT_SHA: commit }, directory), commit);
});

test("uses GitHub's commit SHA and rejects malformed build metadata", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deployment-no-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(resolveCommit({ GITHUB_SHA: commit }, directory), commit);
  assert.throws(() => resolveCommit({ VERCEL_GIT_COMMIT_SHA: "not-a-commit" }, directory), /invalid Git commit SHA/);
  assert.throws(() => resolveCommit({}, directory), /Could not determine build commit/);
});

test("the checked-out commit wins over the dispatching ref's GITHUB_SHA", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deployment-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "release");

  assert.equal(resolveCommit({ GITHUB_SHA: commit }, directory), git("rev-parse", "HEAD"));
});

test("manifest hashes deployment files and excludes its generated metadata", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deployment-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "assets", "runtime.wasm"), "runtime");
  await writeFile(join(directory, "deployment.json"), "old manifest");

  const manifest = await createDeploymentManifest(directory, commit);
  assert.equal(manifest.commit, commit);
  assert.deepEqual(Object.keys(manifest.files), ["assets/runtime.wasm"]);
  assert.equal(manifest.files["assets/runtime.wasm"].bytes, 7);
  assert.equal(manifest.files["assets/runtime.wasm"].sha256,
    createHash("sha256").update("runtime").digest("hex"));
});

test("verifier accepts matching mirrors and rejects stale or divergent mirrors", async () => {
  const manifest = { format: 1, commit, files: { "index.html": { bytes: 4, sha256: "b".repeat(64) } } };
  const otherCommit = { ...manifest, commit: "c".repeat(40) };
  const otherFiles = { ...manifest, files: { "index.html": { bytes: 4, sha256: "d".repeat(64) } } };
  const responses = new Map([
    ["https://one.example/deployment.json", manifest],
    ["https://two.example/en/latest/_static/deployment.json", manifest],
  ]);
  const fetchManifest = async url => new Response(JSON.stringify(responses.get(url)));

  assert.equal((await verifyDeployments([
    "https://one.example",
    "https://two.example/en/latest/_static",
  ], commit, fetchManifest)).length, 2);
  await assert.rejects(verifyDeployments(["https://one.example"], "e".repeat(40), fetchManifest), /expected/);

  const rtdBase = "https://two.example/en/latest/_static";
  responses.set(`${rtdBase}/deployment.json`, otherCommit);
  await assert.rejects(verifyDeployments(["https://one.example", rtdBase], null, fetchManifest), /not/);
  responses.set(`${rtdBase}/deployment.json`, otherFiles);
  await assert.rejects(verifyDeployments(["https://one.example", rtdBase], null, fetchManifest), /different asset hashes/);
});