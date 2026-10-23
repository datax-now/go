#!/usr/bin/env bash
# Build entrypoint for hosts that build from Git: Vercel and Cloudflare Pages.
#
# It reuses the canonical, integrity-verified site that the GitHub Pages workflow
# publishes for this exact commit, so every host serves identical bytes. If that
# artifact cannot be obtained, it falls back to an independent ./build.sh run.
#
# Environment:
#   DATAX_ARTIFACT_ONLY=1             fail instead of building when no artifact is available
#   DATAX_ARTIFACT_WAIT_SECONDS=<n>   how long to wait for the commit's artifact
#                                     (default: 900 for production builds, 0 otherwise)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

platform="local"
production=false
if [ -n "${VERCEL:-}" ]; then
  platform="vercel"
  [ "${VERCEL_ENV:-}" = "production" ] && production=true
elif [ -n "${CF_PAGES:-}" ]; then
  platform="cloudflare"
  [ "${CF_PAGES_BRANCH:-}" = "main" ] && production=true
fi

if [ -z "${DATAX_ARTIFACT_WAIT_SECONDS:-}" ]; then
  # Preview and branch builds have no published artifact, so waiting would only delay the fallback build.
  if [ "$production" = true ]; then DATAX_ARTIFACT_WAIT_SECONDS=900; else DATAX_ARTIFACT_WAIT_SECONDS=0; fi
fi
export DATAX_ARTIFACT_WAIT_SECONDS

echo "Platform: ${platform} (production=${production}, artifact wait ${DATAX_ARTIFACT_WAIT_SECONDS}s)"

restored=false
status=0
python3 scripts/deployment-artifact.py restore --force --allow-missing || status=$?
if [ "$status" -eq 0 ]; then
  restored=true
elif [ "${DATAX_ARTIFACT_ONLY:-}" = "1" ]; then
  echo "ERROR: no usable canonical artifact and DATAX_ARTIFACT_ONLY=1" >&2
  exit "$status"
else
  echo "No usable canonical artifact (status ${status}); building independently with ./build.sh"
  bash ./build.sh
fi

if command -v node >/dev/null 2>&1; then
  node scripts/pwa.cjs verify dist
else
  echo "WARNING: node is unavailable; skipping the PWA verification" >&2
fi
test -s dist/deployment.json

if [ "$platform" = "cloudflare" ]; then
  python3 scripts/prepare-cloudflare.py dist --in-place
fi

echo "Site ready in dist/ (canonical artifact: ${restored})"
