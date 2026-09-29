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
static host, the app waits for JupyterLite's service worker to take control and
reloads until cross-origin isolation is available (up to three attempts). This
also covers a host that needs a second controlled navigation to add COEP. The
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
asset bytes. `deployment.json` itself and the generated ZIP are excluded from
the inventory to avoid a self-referential archive hash. The recorded commit is
the checked-out Git `HEAD`; `VERCEL_GIT_COMMIT_SHA` or `GITHUB_SHA` is used only
when there is no checkout.

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

The service worker leaves cross-origin requests (including Google Fonts) to the
browser and does not cache unsuccessful same-origin responses. When a
deployment host is blocked or unavailable, it retries the web manifest and
fingerprinted kernel runtime assets on the other hosts in priority order with
their SHA-256 integrity checks (see below).
A cached asset can still be served while background revalidation fails; the host
must recover before uncached requests can succeed.

`%%js` runs in a kernel worker, where browser window APIs such as `alert()` are
not portable. The Quick Start example uses console output instead. A preload
warning for a service-worker-controlled bundle does not by itself indicate a
kernel initialization failure.

Run the focused regression checks with:

```bash
node --test scripts/service-worker-cache.test.mjs scripts/deployment-manifest.test.mjs
```

After rebuilding and deploying, allow one initial load to populate the cache.
With DevTools **Disable cache** unchecked, refresh and inspect **Transferred**,
not the decoded resource size: unchanged runtime assets should come from the
service worker or revalidate with `304`, without another full body download.
Cache eviction, cleared site data, and private browsing can require downloads
again. PWA installation alone does not guarantee offline availability.

### Read the Docs 429 responses

`429 Too Many Requests (from service worker)` can be an upstream response
forwarded by the worker. A direct check of the reported runtime URL returned
`429` with `cf-mitigated: challenge`: Read the Docs' Cloudflare protection was
serving a challenge instead of the runtime file. This is not HTTP 419.
A background runtime fetch cannot complete an interactive HTML challenge.

For a 429, Cloudflare challenge, 502-504 response, or browser-level network
failure from any deployment host (`*.readthedocs.io`, GitHub Pages, Vercel or
Cloudflare Pages), the service worker retries fingerprinted files under
`/xeus/` on the other hosts in priority order: Read the Docs
(`https://datax-now.readthedocs.io/en/latest/_static/`), GitHub Pages
(`https://datax-now.github.io/go/`), Vercel (`https://datax.now/`), then
Cloudflare Pages (`https://datax-now.pages.dev/`). The current host is skipped,
and hosts outside this set (such as `localhost`) never fail over. A host that
failed is not contacted again for 60 seconds, so a blocked host costs one round
trip rather than one per file. A mirror whose `deployment.json` reports a
different commit than this build is skipped so runtime files from two releases
are never mixed.

These requests use CORS
without credentials and are integrity-checked against the SHA-256 recorded in
the mirror's `deployment.json` (builds on different hosts embed their own
paths and repack timestamps, so the bytes of a file differ between hosts; the
build's own digest is used only if the mirror manifest is unavailable). It also
retries `manifest.webmanifest` from the mirrors; that optional metadata request
does not gate kernel startup. Other resources and other 429 responses are not
retried. The client network must permit access to the mirror hosts; this fallback
does not remove the hosting provider's protection.
Every mirror must include CORS headers for `/xeus/`, `/deployment.json` and
`/manifest.webmanifest`, and must contain the same
runtime package filenames (a package version that floated between builds is
missing on the mirror). GitHub Pages and Cloudflare Pages send
`Access-Control-Allow-Origin: *` by default; do not repeat it in the Cloudflare
`_headers` file, which would duplicate the value. Set
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
1 GiB and warns above 95%; the ZIP is roughly a third of the site, so growth in
the runtime is the first thing to trim.

The workflow also places a ZIP of the complete deployment at the site root:

```text
https://<owner>.github.io/<repository>/datax-now.zip
```

The exact Pages URL and ZIP URL are printed in the deployment job summary after
each successful run. Vercel publishes the same archive at `/datax-now.zip`, and
Read the Docs publishes it at `/_static/datax-now.zip`. GitHub Pages does not
let the workflow configure custom COOP/COEP response headers. The app's service
worker adds both policies to controlled navigations and reloads the first visit
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
WebAssembly runtime. The 340 MB deployment ZIP is omitted because Pages cannot
host an asset that large; the RTD, Vercel, and GitHub Pages deployments continue
to publish it. The workflow verifies the deployed commit and isolation headers.

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
