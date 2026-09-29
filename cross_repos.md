# Cross-Repository Relationships (DataX / xeus-x ecosystem)

> Scope: the sibling repositories commonly checked out under `~/` that
> participate in building, deploying, or consuming the DataX / xeus-x
> WebAssembly Jupyter kernel. This document focuses on the **current** wheel-based
> contract between `xeus-x` and `datax_now`.

This document lives in `datax_now` because `datax_now` is the downstream
aggregator that turns the other repositories into a deployable JupyterLite site.

---

## 1. Repository inventory

| # | Repo (local path) | Upstream / fork | Role |
| --- | ------------------- | ----------------- | ------ |
| 1 | `xeus-x` | `MRYingLEE/xeus-x` | Builds the multi-language WASM kernel and publishes `jupyterlite_xeus_x-*.whl`. |
| 2 | `xeus-javascript-private` | Fork of `jupyter-xeus/xeus-javascript` (branch `xeus-x-integration`) | JS sub-kernel source; consumed by `xeus-x` as a git submodule at `src/xeus-javascript`. |
| 3 | `ai-agents-private` | `MRYingLEE/ai-agents-private` | AI agents TypeScript bundle (`xeus-x-ai_agents`). Consumed by `xeus-x` as a submodule at `src/ai_agents`. |
| 4 | `xeus-private` | Fork of `jupyterlite/xeus` (branch `xeus-x-integration`) | Provides Python addon `jupyterlite_xeus` + JupyterLab extension `@jupyterlite/xeus-extension` + worker runtime `@jupyterlite/xeus`. Shipped to `datax_now` as a pre-built wheel. |
| 5 | `xeus-runtime-package-service` | `MRYingLEE/xeus-runtime-package-service` | Shared TypeScript library used by two worker runtimes. |
| 6 | `ai` | Fork/branch (`sharable`) of `jupyterlite/ai` | Jupyter AI chat + completions extension. Shipped to `datax_now` as a pre-built wheel. |
| 7 | `datax_now_front` | `MRYingLEE/datax_now_front` | JupyterLab federated extension `datax-now-front`. Shipped to `datax_now` as a pre-built wheel. |
| 8 | `datax_now` *(this repo)* | `MRYingLEE/datax_now` | JupyterLite deployer. Consumes pre-built wheels from `built-in-wheels/`, assembles the static site, hosts notebooks, runs `cors_server.py`. |
| 9 | `vscode-datax` | `MRYingLEE/vscode-datax` | VS Code notebook extension. Loads the same xeus-x WASM kernel in a web/Node worker; fetches runtime assets from an HTTP server. |
| 10 | `duckdb-private` | `MRYingLEE/duckdb-private` | `rattler-build` pipeline producing DuckDB `emscripten-wasm32` conda packages for the WASM host environment. |
| 11 | `xeus-nodejs` | `MRYingLEE/xeus-nodejs` | Standalone Node.js WASM kernel. Currently not wired into any other repo. |
| 12 | `skills` | (general Copilot skills) | Editor/agent prompts only — no runtime coupling. |

---

## 2. Current build / deploy data-flow

```text
                         ┌──────────────────────────────┐
                         │  xeus-javascript-private     │ ──► submodule
                         │  ai-agents-private           │ ──► submodule
                         │  jupyter-xeus/xeus-python    │ ──► submodule
                         │  jupyter-xeus/xeus-r         │ ──► submodule
                         └──────────────┬───────────────┘
                                        │
                                        ▼
                    ┌──────────────────────────────────────┐
                    │  xeus-x  (./build-kernel.sh)         │
                    │  • Compiles xpython.js / xpython.wasm│
                    │  • Packages ai_agents bundle         │
                    │  • Packages hera R package           │
                    │  • Builds jupyterlite_xeus_x wheel   │
                    │  • Publishes wheel into              │
                    │    ../datax_now/built-in-wheels/     │
                    └──────────────┬───────────────────────┘
                                   │ wheel hand-off
                                   ▼
┌───────────────────────────────────────────────────────────────┐
│  datax_now  (./deploy.sh)                                    │
│  • Reads only local built-in-wheels/ and built-in-conda/     │
│  • Installs jupyterlite_xeus_x and companion wheels          │
│  • Uses installed payload at $DEPLOY_PREFIX/share/jupyter/   │
│    xeus-x/ as the source of truth                            │
│  • Patches jupyterlite_xeus.add_on.get_kernel_binaries()     │
│  • Emits dist/                                                │
└───────────────┬───────────────────────────────────────────────┘
                │
      ┌─────────┴──────────┐
      ▼                    ▼
┌───────────────┐   ┌────────────────────────────────────────────┐
│ Browser       │   │ vscode-datax (web + desktop)               │
│ (JupyterLite  │   │ • fetches xpython.js / xpython.wasm /      │
│  served from  │   │   empack_env_meta.json / kernel_packages   │
│  dist/)       │   │   from datax_now/cors_server.py            │
│               │   │ • shares @datax/xeus-runtime-package-      │
│               │   │   service with xeus-private worker         │
└───────────────┘   └────────────────────────────────────────────┘
```

---

## 3. Explicit cross-repo dependencies

| Consumer | Producer | Mechanism | Evidence |
| ---------- | ---------- | ----------- | ---------- |
| `xeus-x` | `xeus-javascript-private` | git submodule `src/xeus-javascript` (branch `xeus-x-integration`) | `xeus-x/.gitmodules` |
| `xeus-x` | `ai-agents-private` | git submodule `src/ai_agents`; `npm install && npm run build` inside it | `xeus-x/build-kernel.sh` |
| `xeus-x` | `jupyter-xeus/xeus-python`, `jupyter-xeus/xeus-r` | vanilla upstream submodules | `xeus-x/.gitmodules` |
| `datax_now` | `xeus-x` | pre-built `jupyterlite_xeus_x-*.whl` copied into `built-in-wheels/` | `datax_now/environment-deploy.yml` |
| `datax_now` | `xeus-private` | pre-built `jupyterlite_xeus-*.whl` in `built-in-wheels/` | `datax_now/environment-deploy.yml` |
| `datax_now` | `ai` (jupyterlite-ai) | pre-built `jupyterlite_ai-*.whl` in `built-in-wheels/` | `datax_now/environment-deploy.yml` + `overrides.json` |
| `datax_now` | `datax_now_front` | pre-built `datax_now_front-*.whl` in `built-in-wheels/`; deploy.sh registers `datax-now-front` as a federated extension | `datax_now/deploy.sh` |
| `vscode-datax` | `xeus-runtime-package-service` | `file:` dependency | `vscode-datax/package.json` |
| `xeus-private/packages/xeus` | `xeus-runtime-package-service` | `file:` dependency | `xeus-private/packages/xeus/package.json` |
| `vscode-datax` | `datax_now` (running server) | default `datax.xeusAssetsUrl` points at the layout produced by `datax_now/deploy.sh` and served by `cors_server.py` | `vscode-datax/package.json` + `README.md` |
| `xeus-x` | `duckdb-private` | manual `cp output/*.tar.bz2 xeus-x/built-in-conda/emscripten-wasm32/` then regenerate repodata | `duckdb-private/README.md` |

---

## 4. Boundary rules that now matter

### 4.1 xeus-x → datax_now contract

Allowed:

- `xeus-x` writes the published wheel into `datax_now/built-in-wheels/`
- the wheel may expose kernel startup policy knobs (`XEUS_X_STARTUP_PROFILE`, `XEUS_X_BACKGROUND_WARM`) and worker-callable warm/status hooks for downstream runtimes

Not allowed:

- `xeus-x` should not run `datax_now/deploy.sh`
- `xeus-x` should not read `datax_now/dist` or `datax_now/notebooks`
- `xeus-x` should not call `datax_now/import-kernel.sh`

### 4.2 datax_now → xeus-x contract

Allowed:

- operators may place a `jupyterlite_xeus_x-*.whl` in `built-in-wheels/`
- downstream worker runtimes may consume the wheel's staged-startup hooks, but prewarm pooling and session reuse remain downstream responsibilities

Not allowed:

- `datax_now/deploy.sh` should not read `../xeus-x/dist/*`
- `datax_now/deploy.sh` should not compare against `xeus-x/build_wasm/*`
- `datax_now/deploy.sh` should not import kernel bundles from xeus-x

### 4.3 Source of truth

For the deployed kernel runtime, the source of truth is the installed wheel payload at:

```text
$DEPLOY_PREFIX/share/jupyter/xeus-x/
```

not the xeus-x checkout.

---

## 5. Remaining notable couplings

### 5.1 `jupyterlite_xeus` monkey-patch in deploy.sh

`datax_now/deploy.sh` still patches `site-packages/jupyterlite_xeus/add_on.py::get_kernel_binaries()` after installation. That remains a fragile runtime coupling to the internal shape of `xeus-private`.

### 5.2 Wheel filename pinning in YAML

`environment-deploy.yml` still pins exact wheel filenames. `built-in-wheels/update_wheel_references.py` keeps those filenames synchronized, but the coupling is still filename-based.

### 5.3 Shared sibling-workspace assumptions elsewhere

Several repos still assume sibling checkouts for `file:` npm dependencies or developer workflows. That broader workspace assumption remains outside the narrow xeus-x ↔ datax_now wheel boundary.

---

## 6. Suggested next simplifications

1. Upstream the `jupyterlite_xeus` monkey-patch into `xeus-private`.
2. Replace filename-pinned wheel entries with a manifest-driven or wildcard-based mechanism.
3. Add a workspace-level verification script for the remaining sibling-checkout assumptions.

---

## 7. Current status

As of 2026-06-12:

- `xeus-x/build-kernel.sh` builds the kernel and publishes a wheel into `datax_now/built-in-wheels/`
- `datax_now/deploy.sh` consumes only its local wheels/assets for xeus-x
- `datax_now/import-kernel.sh` has been removed
- older bundle-import documentation has been superseded by the wheel-only flow
