# JupyterLite on Read the Docs

This repository builds a browser-based JupyterLite site and publishes it as
static documentation with Read the Docs. The build uses the checked-in wheel
and WebAssembly runtime inputs, so the Read the Docs project does not need a
second application host.

## Read the Docs setup

1. Create or import this repository in Read the Docs.
2. Use the checked-in `.readthedocs.yaml` configuration.
3. Build the `latest` version.
4. Open the JupyterLite application from the documentation page at
   `/_static/lab/`.

The RTD build runs `./build.sh -c` before Sphinx builds the documentation. The
generated site is copied under the documentation `_static/` directory.

DataX (`xpython`) is the only published kernel. The Pyodide kernel is not a
build dependency, and incremental builds uninstall previously installed
Pyodide packages before assembling the site.

All hosts use the same on-demand kernel settings. Background pool warm-up is
disabled; on-demand worker reuse retains its existing default. Kernels still
start automatically when opening a notebook. A cold start may take longer than
acquiring a prewarmed worker.
The build also patches the kernel message queue to wait for initialization and
filesystem mounting before delivering messages, preserving their arrival order.
Initialization failures reject that readiness wait instead of leaving it pending.
The bundled WASM kernel registers Python widget comm targets during startup,
before JupyterLab's control-channel probe or the first cell. It also preserves
explicit comm IDs and retains the comm module safely in its callbacks.
Keeping the runtime settings identical across hosts also lets offline downloads
recover verified configuration files from a mirror when RTD serves a challenge.

## Customize the site

- Put notebooks and data files in `notebooks/`.
- Change the first-visit notebook in `jupyter-lite.json` and `overrides.json`.
- Adjust application settings in `jupyter-lite.json`.
- Add or remove runtime packages in `environment-wasm-host.yml`.
- Keep the wheel filenames in `environment-deploy.yml` synchronized with
  `built-in-wheels/` using `built-in-wheels/update_wheel_references.py`.

The `built-in-wheels/` and `built-in-conda/` directories are deployment inputs,
not build output. Keep them in the repository so a clean RTD build is
self-contained.

## Local verification

The build script targets Linux x86-64 and downloads Micromamba on its first
run. To reproduce the RTD build locally:

```bash
./build.sh -c
```

The static result is written to `dist/`. A local server must provide the
cross-origin isolation headers required by the WebAssembly runtime. Vercel and
Cloudflare set these headers directly. Read the Docs provides COOP, so its
service worker adds COEP to controlled app navigations; GitHub Pages provides
neither header, so the service worker adds both. On a first visit to either
static host, a preflight registers the service worker and waits for it to
control the page before JupyterLite starts. Each registration, readiness, and
control wait allows up to two minutes for a
cold browser profile rather than failing after 15 seconds. The preflight's
active registration is retained when JupyterLite starts: version changes check
for a normal service-worker update in the current scope instead of unregistering
workers (including workers belonging to other deployment paths). A network-blocked
update is reported and retried on a later visit without discarding the working
registration. The app loader stays paused while
controlled navigations retry (up to three attempts) until cross-origin
isolation is available, so notebooks and warmed kernels are not started in a
document that is about to reload. If isolation still cannot be enabled, the
page reports an error instead of starting a kernel that cannot work. The
service worker also adds COEP and CORP to dedicated-worker script responses
(such as `coincident.worker.*.js`), which Chrome blocks otherwise.
Generated web-manifest shortcuts use relative URLs so they stay within the
deployment path on Read the Docs and GitHub Pages.

Each build writes `dist/deployment.json` with its checked-out Git commit and a
SHA-256 inventory of the static assets. Compare the active GitHub Pages, Vercel
and Cloudflare deployments, listed in priority order, with:

```bash
node scripts/deployment-manifest.mjs verify - \
  https://datax-now.github.io/go/ \
  https://datax.now/ \
  https://datax-now.pages.dev/
```

To include Read the Docs, put its static-assets base URL ending in
`/_static/` first. The verifier reports a mismatch if mirrors differ by commit or
asset bytes. `deployment.json` itself is excluded from the inventory because it
contains that inventory. The recorded commit is the checked-out Git `HEAD`;
`VERCEL_GIT_COMMIT_SHA` or `GITHUB_SHA` is used only when there is no checkout.

## Deployment priority

The four deployments are ranked by importance, and every ordered list in the
project follows this ranking. When hosts are otherwise equivalent, prefer the
one listed first:

1. Read the Docs
2. GitHub Pages
3. Vercel
4. Cloudflare Pages

The launch page links them in this order as separate choices, not as an
automatic redirect or cross-origin load balancer. Select one origin for each
session: browser storage and notebook files do not move when switching hosts.
GitHub Pages supplies isolation headers through its service worker on controlled
navigations, while Vercel and Cloudflare set them directly. The
sections below follow the same order.

### Browser caching

Before fingerprinting, the build removes byte-identical shared
library copies from the runtime `bin/` and extension static directories.
Kernel workers resolve those URLs to the single copy under
`xeus/xeus-python-wasm-host/`, so downloads and cache entries are shared too.
Libraries with different bytes are retained. This works without server
redirects on all four static hosts; package archives are left intact because
they populate the kernel filesystem.

Service-worker caching is enabled in `jupyter-lite.json`. After all runtime
patches, the build fingerprints every file under `dist/xeus/` with SHA-256 and
embeds the manifest in the service worker. Runtime files use content-addressed
Cache Storage keys: unchanged files are served locally without background
downloads or revalidation, and changed files are fetched on their next request.
Simultaneous kernel requests share a download. Existing runtime URLs stay stable;
fingerprints are local cache keys, not renamed server files. Other assets retain
background ETag revalidation. URL alias rewrites preserve these validators and
accept `304` responses without retrying.
Runtime cache misses revalidate the HTTP cache and require fetch integrity to
match the build's SHA-256 digest before returning or storing a response. A
deployment mismatch fails the download and can be retried; it is not cached
under the expected hash. Previously unverified runtime cache entries are not
reused, so this upgrade requires an initial runtime download. Byte-range requests
bypass service-worker caches and retain the server's partial-response behavior.
The Cloudflare Worker also handles conditional requests with body-free `304`
responses. Stable runtime URLs are not marked immutable.

The service worker leaves unrelated cross-origin requests (including Google
Fonts) to the browser and does not cache unsuccessful same-origin responses.
When a deployment host is blocked or unavailable, it retries the web manifest
and build-inventoried assets on the other hosts in priority order. Offline
downloads cache a mirror response only when its bytes match the build's
SHA-256; a different release can supply a file only when its manifest records
that same hash (see below).
Before returning a mirror response to a local application request, the service
worker wraps its decoded body as a local response. This also applies to cached
mirror responses: cross-origin response metadata would otherwise make isolated
pages reject classic scripts and other resources, even after a successful,
integrity-verified download. Normal same-origin responses are unchanged.
A cached asset can still be served while background revalidation fails; the host
must recover before uncached requests can succeed.

`%%js` runs in a kernel worker, where browser window APIs such as `alert()` are
not portable. The Quick Start example uses console output instead. A preload
warning for a service-worker-controlled bundle does not by itself indicate a
kernel initialization failure.

Run the focused regression checks with:

```bash
node --test scripts/build-environment.test.mjs scripts/service-worker-cache.test.mjs scripts/deployment-manifest.test.mjs scripts/kernel-config.test.mjs
```

After rebuilding and deploying, allow one initial load to populate the cache.
With DevTools **Disable cache** unchecked, refresh and inspect **Transferred**,
not the decoded resource size: unchanged runtime assets should come from the
service worker or revalidate with `304`, without another full body download.
Cache eviction, cleared site data, and private browsing can require downloads
again. PWA installation alone does not guarantee offline availability.

### Offline use

While online, open the app and select **Download for offline use** in the status
bar, or leave all running kernels idle for five minutes to start the download
automatically. Manual downloads ask you to confirm the download size. Wait for
**Offline ready** before disconnecting. The status bar identifies automatic
downloads and reports their progress or failure; the browser console logs when
they start, reach progress milestones, complete, or fail. If the service worker
does not control the page yet, the status bar reports that while waiting.
This downloads the complete local application, lazy-loaded extensions, bundled
notebooks and data, and the WebAssembly kernel packages. The installed PWA can
then reopen, start a fresh kernel, run Python, and access locally saved
notebooks without an internet connection.
App navigation remains available when notebook query parameters change.
The idle monitor's kernel connections do not handle widget comms, leaving
comm ownership with notebook connections even when monitoring starts first.

The kernel's conda-to-PyPI name mapping is also bundled locally. Its build input,
`scripts/conda-pypi-mapping.json`, is a snapshot of prefix-dev/parselmouth's
`files/compressed_mapping.json` at commit
`345e9bfbd11d932d63df2bc1146511337f7ba5dd`; kernel startup does not fetch it from
GitHub.

Downloads are SHA-256 verified and reuse already cached files. An interrupted
download can be retried without starting over. Failed downloads or insufficient
browser storage never report readiness. The app requests persistent storage,
but browsers may decline it or evict data; the readiness check runs again when
the app opens. Once a download has completed, each later release downloads its
changed files before its service worker activates. Until that finishes, the
previous offline-ready release stays active and the update is retried on a
later visit. Activation then removes cached files that no current release
uses. If progress stalls, for example because the browser stopped the service
worker, the app resumes the download from the files already cached.
Offline files and notebooks belong to the selected origin and browser
profile, not to all deployment mirrors.
Timestamped build diagnostics (`xpython-deploy-manifest.json`) are not offline
dependencies and are excluded from the offline inventory, like `deployment.json`.
Their bytes differ between builds on different hosts and cannot be recovered
as integrity-verified runtime assets from a mirror.

Bundled directory indexes use a fixed metadata timestamp (`SOURCE_DATE_EPOCH`,
defaulting to `0`, the Unix epoch), not build time or checkout file timestamps.
This default is identical on all hosts and does not require `.git`, which Vercel
excludes from its build context. To override it, use the same value on every
mirror. The timestamp is excluded from the JupyterLite build subprocess:
JupyterLite 0.8.3 otherwise recursively timestamps the output directory's parent,
including Micromamba caches and broken sysroot symlinks. It remains available to
the post-build directory-index and offline-inventory normalization.
Generated HTML cache tokens use the referenced script's content
hash. These are normalized before offline copies and inventories are written,
so independently built mirrors can recover the same notebook/data listings
and application pages without weakening SHA-256 verification.
If a bundled directory download fails, the file browser reports the error
instead of caching an empty folder for the session. Refresh the file browser
to retry once connectivity recovers. Locally saved notebook metadata is unchanged.

Network-dependent notebook code, remote datasets, AI services, and packages not
included in the build still require internet access. External fonts may fall
back to local fonts. Keep important notebooks exported separately: installing
a PWA or granting persistent storage is not a backup.

### Read the Docs navigation failure

Read the Docs injects its add-ons script and metadata into served HTML after
the build. Those bytes differ from the build's SHA-256 inventory. Fetching that
HTML with integrity enabled fails, which can surface as `ERR_FAILED` when the
service worker controls an app navigation, even after a successful RTD build.

The build creates byte-identical `.html.offline` copies for HTML assets. The
offline cache fetches these non-HTML URLs with the original SHA-256 check and
restores the HTML content type before serving the original application URL.
This keeps navigation and offline downloads verified without depending on
host-injected HTML. Keep these copies in every deployment. Rebuild and redeploy
to apply this fix; existing deployments are not changed by a local code update.

### Read the Docs 429 responses

`429 Too Many Requests (from service worker)` can be an upstream response
forwarded by the worker. A direct check of the reported runtime URL returned
`429` with `cf-mitigated: challenge`: Read the Docs' Cloudflare protection was
serving a challenge instead of the runtime file. This is not HTTP 419.
A background runtime fetch cannot complete an interactive HTML challenge.

For a 429, Cloudflare challenge, 502-504 response, or browser-level network
failure from any deployment host (`*.readthedocs.io`, GitHub Pages, Vercel or
Cloudflare Pages), the service worker retries fingerprinted runtime files and
other build-inventoried assets on the other hosts in priority order: Read the Docs
(`https://datax-now.readthedocs.io/en/latest/_static/`), GitHub Pages
(`https://datax-now.github.io/go/`), Vercel (`https://datax.now/`), then
Cloudflare Pages (`https://datax-now.pages.dev/`). The current host is skipped,
and hosts outside this set (such as `localhost`) never fail over. A host that
failed is not contacted again for 60 seconds, so a blocked host costs one round
trip rather than one per file. For offline downloads, a mirror is accepted only
when its manifest records the exact hash expected by this build; mismatched
files are skipped, even if the mirror reports the same commit.

These requests use CORS without credentials. Runtime requests are checked
against the mirror's `deployment.json`; offline downloads additionally require
the exact build SHA-256 before caching, so host-specific runtime bytes are not
stored under another build's hash. If a mirror manifest is unavailable, the
request is still checked against the build's expected hash. The service worker
also retries `manifest.webmanifest`; that optional metadata request does not
gate kernel startup. Unindexed or unrelated resources are not retried. The
client network must permit access to the mirror hosts; this fallback does not
remove the hosting provider's protection.
Every mirror must include CORS headers for build-inventoried asset paths,
`/deployment.json` and `/manifest.webmanifest`, and must contain the same
runtime package filenames (a package version that floated between builds is
missing on the mirror). GitHub Pages and Cloudflare Pages send
`Access-Control-Allow-Origin: *` by default; do not repeat it in the Cloudflare
`_headers` file, which would duplicate the value. Vercel sets it on all static
assets. Set
`DATAX_RUNTIME_MIRROR_ORIGIN` at build time to a comma-separated list of base
URLs in priority order (an empty value disables failover). Use
`scripts/deployment-manifest.mjs verify` to confirm the hosts match before
promotion.

URL-alias retries remain disabled for 429 responses, Cloudflare challenges,
server errors, and network/integrity failures. Only ordinary 403/404 responses
try alternate extensions. Rebuild and redeploy to apply the change, then close
all tabs for this site and reopen it so the updated service worker can take
over.

- Stop repeated reloads or simultaneous kernel starts while blocked. Wait for
  `Retry-After` when supplied; otherwise allow a cooldown before trying again.
- Open the documentation page normally and complete any challenge presented.
  Keep browser caching enabled and avoid clearing site data as a routine fix:
  doing so forces runtime downloads again.
- If blocking persists, use the next deployment in priority order:
  <https://datax-now.github.io/go/lab/>, <https://datax.now/lab/> or
  <https://datax-now.pages.dev/lab/>.
  Browser notebooks and storage are origin-specific, so export important work
  before switching hosts; it will not appear there automatically.
- Ask Read the Docs support to review the block, supplying the failing URL,
  timestamp, HTTP status, and `cf-ray` response header. Do not share cookies.
  There is no repository build setting that disables their Cloudflare challenge.

Read the Docs documents its protection and automated-access guidance at
<https://docs.readthedocs.com/platform/stable/automated-access.html>.
Its API rate limits are separate from documentation asset hosting limits.

## GitHub Pages deployment

The `.github/workflows/deploy-github-pages.yml` workflow builds and publishes
the complete `dist/` directory to GitHub Pages when `master` changes. It can
also be started manually with **Run workflow** and a `release_ref`. In the repository settings,
set **Pages > Build and deployment > Source** to **GitHub Actions**.

GitHub Pages sites may not exceed 1 GB. The workflow fails before upload above
1 GiB and warns above 95%; growth in the runtime is the first thing to trim.
The deployment job summary prints the Pages URL after each successful run.
GitHub Pages does not let the workflow configure custom COOP/COEP response
headers. The app's service worker adds both policies to controlled navigations
and reloads the first visit
after taking control; use a browser with service worker support. Read the Docs,
Vercel, and Cloudflare provide server headers or a service-worker fallback as
well.

## Vercel deployment

Vercel can build the same static JupyterLite site using the checked-in
`vercel.json` configuration. It runs `./build.sh`, publishes `dist/`, and
applies the cross-origin isolation headers required by the WebAssembly runtime.
The `.vercelignore` file excludes local environments and generated output while
keeping the wheel, conda, runtime-wheel, and notebook inputs available to the
build.

Manifest generation uses Vercel's `VERCEL_GIT_COMMIT_SHA` because Vercel build
containers do not include the repository's `.git` directory. In Vercel project
settings, enable **Environment Variables > Enable access to System Environment
Variables** so the release manifest records the actual Git commit.

The Vercel project `datax-now-readthedocs` uses staged production deployments:
automatic custom-domain assignment is disabled (`autoAssignCustomDomains: false`).
Builds from the production branch are available at deployment-specific URLs for
review, while the production domain remains on the previously promoted build.
If Deployment Protection is enabled, an unauthenticated manifest request on a
staged URL redirects to Vercel SSO. Browsers report that cross-origin redirect
as a manifest CORS error; sign in to the deployment before testing its assets.
After checking a staged deployment, promote that exact deployment without a
rebuild:

```bash
vercel promote <reviewed-deployment-url>
```

For a manually initiated build, stage it explicitly with
`vercel --prod --skip-domain` before reviewing and promoting it. The production
domains `datax.now` and `www.datax.now` are assigned to this project; do not use
either production domain to test an unpromoted deployment.

## Cloudflare deployment

Cloudflare Pages can host the site directly on its Free plan, which allows up
to 20,000 files per site and 25 MiB (26,214,400 bytes) per file. The workflow
checks those limits against the exact upload on every deployment and fails
before upload if a future build exceeds either one.

The `deploy-cloudflare.yml` workflow uploads `dist/` directly with Wrangler;
it does not use R2 or deploy a Worker. It prepares a Pages-only copy, gzip-
compresses assets that exceed the per-file limit, and adds matching
`Content-Encoding` rules plus the COOP/COEP isolation headers required by the
WebAssembly runtime. The workflow verifies the deployed commit and isolation
headers.

1. Create a Cloudflare Pages **Direct Upload** project named `datax-now` and
  set its production branch to `master`.
2. Create an API token with **Account > Cloudflare Pages > Edit** permission.
   Store it and the account ID as GitHub Actions secrets
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Run **Deploy JupyterLite to Cloudflare** from **Actions > Run workflow**,
   selecting the same `release_ref` used for other mirrors when aligning a
   release. The workflow publishes the selected build to the Pages production
   branch and verifies `https://datax-now.pages.dev/`.

Deployment remains manual and serialized by the `cloudflare-production`
GitHub Actions environment. Configure required reviewers there if production
deployments should require approval. Pages deployments use a different origin
from Read the Docs and Vercel, so browser storage and notebook files do not
move between hosts. The previous Worker and R2 bucket are not changed or deleted
by this workflow; remove them separately only after verifying Pages and when
their existing release assets are no longer needed.

## Repository layout

| Path | Purpose |
| --- | --- |
| `.readthedocs.yaml` | Read the Docs build configuration |
| `build.sh` | Clean or incremental JupyterLite build |
| `docs/` | Minimal RTD documentation shell |
| `notebooks/` | Content published into JupyterLite |
| `environment-deploy.yml` | Build-time Python and JupyterLite dependencies |
| `environment-wasm-host.yml` | Browser kernel runtime packages |
| `built-in-wheels/` | Checked-in Python wheels used by the build |
| `built-in-conda/` | Checked-in WebAssembly conda packages |
| `cloudflare/` | Cloudflare Pages response headers |
