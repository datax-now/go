import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function createDeploymentManifest(directory, commit) {
  const root = resolve(directory);
  const files = {};
  const paths = (await listFiles(root))
    .filter(path => !["deployment.json", "datax-now.zip"].includes(relative(root, path)))
    .sort();

  for (const path of paths) {
    const name = relative(root, path).split(sep).join("/");
    files[name] = {
      bytes: (await stat(path)).size,
      sha256: await sha256(path),
    };
  }

  return { format: 1, commit, files };
}

export function resolveCommit(env = process.env, cwd = process.cwd()) {
  const environmentCommit = env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA;
  if (environmentCommit) {
    if (!/^[a-f0-9]{40,64}$/i.test(environmentCommit)) {
      throw new Error("Build environment supplied an invalid Git commit SHA");
    }
    return environmentCommit;
  }

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error("Could not determine build commit; set VERCEL_GIT_COMMIT_SHA or GITHUB_SHA outside a Git checkout");
  }
}

function validateManifest(manifest, url) {
  if (
    manifest?.format !== 1 ||
    !/^[a-f0-9]{40,64}$/i.test(manifest.commit ?? "") ||
    !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
  ) {
    throw new Error(`Invalid deployment manifest from ${url}`);
  }
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (!Number.isSafeInteger(entry?.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/i.test(entry.sha256 ?? "")) {
      throw new Error(`Invalid file entry '${path}' in deployment manifest from ${url}`);
    }
  }
}

function manifestUrl(target) {
  const base = new URL(target);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  base.search = "";
  base.hash = "";
  return new URL("deployment.json", base).href;
}

export async function verifyDeployments(targets, expectedCommit = null, fetchImpl = fetch) {
  if (!targets.length) throw new Error("Provide at least one deployment URL");

  const deployments = await Promise.all(targets.map(async target => {
    const url = manifestUrl(target);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    const manifest = await response.json();
    validateManifest(manifest, url);
    if (expectedCommit && manifest.commit !== expectedCommit) {
      throw new Error(`${url} serves ${manifest.commit}, expected ${expectedCommit}`);
    }
    return { url, manifest };
  }));

  const reference = deployments[0].manifest;
  const fileInventory = JSON.stringify(Object.entries(reference.files).sort(([a], [b]) => a.localeCompare(b)));
  for (const { url, manifest } of deployments.slice(1)) {
    if (manifest.commit !== reference.commit) {
      throw new Error(`${url} serves commit ${manifest.commit}, not ${reference.commit}`);
    }
    if (JSON.stringify(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) !== fileInventory) {
      throw new Error(`${url} has different asset hashes from ${deployments[0].url}`);
    }
  }

  return deployments.map(({ url, manifest }) => ({
    url,
    commit: manifest.commit,
    files: Object.keys(manifest.files).length,
  }));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "write" && args.length === 1) {
    const directory = resolve(args[0]);
    const commit = resolveCommit(process.env, dirname(directory));
    const manifest = await createDeploymentManifest(directory, commit);
    await writeFile(resolve(directory, "deployment.json"), `${JSON.stringify(manifest)}\n`);
    console.log(`Wrote deployment manifest for ${commit} (${Object.keys(manifest.files).length} files)`);
    return;
  }

  if (command === "verify" && args.length >= 2) {
    const expectedCommit = args[0] === "-" ? null : args[0];
    const deployments = await verifyDeployments(args.slice(1), expectedCommit);
    for (const deployment of deployments) {
      console.log(`${deployment.url}: ${deployment.commit} (${deployment.files} files)`);
    }
    return;
  }

  throw new Error(
    "Usage: deployment-manifest.mjs write <dist-dir> | verify <expected-commit|-> <base-url> [base-url ...]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}