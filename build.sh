#!/bin/bash
set -euo pipefail

# ==============================================================================
# build.sh — Read the Docs JupyterLite deployment assembler
#
# Consumes the jupyterlite-xeus-x wheel from built-in-wheels/ and
# assembles the final JupyterLite dist/ directory.
#
# Usage:
#   ./build.sh          # Incremental build (reuses existing conda envs)
#   ./build.sh -c       # Clean local envs, then rebuild dist/
#
# Clean build (-c):
#   Clears local build environments before assembling dist/.
#
# Incremental build (default):
#   Reuses existing conda envs for faster iteration.
#
# To update the kernel, place a fresh jupyterlite_xeus_x wheel in
# built-in-wheels/, then rerun build.sh.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${SCRIPT_DIR}"
BUILTIN_WHEELS_DIR="${BUILTIN_WHEELS_DIR:-${REPO_ROOT}/built-in-wheels}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
if [[ ! "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]]; then
  echo "ERROR: SOURCE_DATE_EPOCH must be a nonnegative Unix timestamp." >&2
  exit 1
fi
export SOURCE_DATE_EPOCH

# ==============================================================================
# Pinned dependency versions
# ==============================================================================
MERIYAH_VERSION="6.1.4"
MERIYAH_SHA256="d545774b79cd9a3351c7822b595e1e95bdd1fc00a67a2e378f9a66efd6f1eead"

ESBUILD_VERSION="0.24.2"
ESBUILD_WASM_SHA256="e2b4b98297e04ef12981bafabf0a3c2d7c3c5cf6af603ef79d886deac3b5eeb3"
ESBUILD_JS_SHA256="d68f446f35b976d43867a8375c46eff2ab6b80b727e525959e63938589320f48"

HERA_TARBALL_NAME="r-hera-0.6.0-local_0.tar.gz"
R_PLOT_PACKAGE_REBUILDER="$REPO_ROOT/scripts/rebuild-r-plot-packages.sh"
R_SOURCE_CACHE_DIR="$REPO_ROOT/temp/r-source-packages"

# Safe file extension conversion: extensions to rename so enterprise gateways
# that block certain file types (e.g. *.whl, *.so) can still serve this site.
#
# Build time: blocked files in dist/ are renamed by appending SAFE_ASM_EXT
# (e.g. a.so → a.so.asm).  If SAFE_ALIAS_EXTS is set, physical copies are
# also created for each alias (e.g. a.so.zip, a.so.bin).
#
# Runtime: the service worker intercepts every fetch for a blocked file and
# tries SAFE_ASM_EXT first.  If that request fails (network error or HTTP
# error — meaning the gateway blocks it), it automatically falls back to the
# next alias extension in order, until one succeeds.  The first working
# extension is cached in memory so subsequent fetches skip the retry loop.
#
# Example: SAFE_ALIAS_EXTS="zip bin" means that if .asm is blocked the SW
# silently retries with .zip, then .bin — with all three files physically
# present on the server (a.so.asm, a.so.zip, a.so.bin).
#
# Override any variable before running build.sh to customise the behaviour.
SAFE_EXT_SUFFIXES="${SAFE_EXT_SUFFIXES:-whl so}"
SAFE_ASM_EXT="${SAFE_ASM_EXT:-.asm}"
SAFE_ALIAS_EXTS="${SAFE_ALIAS_EXTS:-}"

verify_integrity() {
  local file="$1"
  local expected_hash="$2"
  local actual_hash

  if [ -f "$file" ]; then
    actual_hash=$(sha256sum "$file" | cut -d' ' -f1)
    if [ "$actual_hash" = "$expected_hash" ]; then
      return 0
    else
      echo "  ⚠ Integrity check failed for $file"
      echo "    Expected: $expected_hash"
      echo "    Got:      $actual_hash"
      return 1
    fi
  fi

  return 1
}

# ==============================================================================
# Command-line argument parsing
# ==============================================================================
CLEAN_BUILD=false
# The public repository uses only the checked-in wheel payload.
AI_AGENTS_SOURCE_POLICY="${AI_AGENTS_SOURCE_POLICY:-wheel}"
AI_AGENTS_ALLOW_WHEEL_MISMATCH="${AI_AGENTS_ALLOW_WHEEL_MISMATCH:-0}"
# KERNEL_WHEEL_DIR is set after the deploy env is created and the wheel is installed
# It points to $DEPLOY_PREFIX/share/jupyter/xeus-x which is where the
# jupyterlite-xeus-x wheel deposits its payload (via the .data/data/ mechanism).
KERNEL_WHEEL_DIR=""  # resolved after env creation
AI_AGENTS_SOURCE_KIND="missing"
AI_AGENTS_FALLBACK_TO_WHEEL="false"
AI_AGENTS_DIGEST_MATCHES_WHEEL="unknown"

ai_agents_bundle_dir_exists() {
  local dir="${1:-}"
  [ -n "$dir" ] && [ -d "$dir" ] && [ -f "$dir/bundle.js" ]
}

extract_kernel_manifest_field() {
  local manifest_path="$1"
  local field_path="$2"

  python3 - "$manifest_path" "$field_path" <<'PY'
import json
import pathlib
import sys

manifest = pathlib.Path(sys.argv[1])
field_path = [segment for segment in sys.argv[2].split('.') if segment]
if not manifest.is_file():
    print('')
    raise SystemExit(0)

try:
    payload = json.loads(manifest.read_text(encoding='utf-8'))
except Exception:
    print('')
    raise SystemExit(0)

value = payload
for segment in field_path:
    if not isinstance(value, dict):
        value = ''
        break
    value = value.get(segment, '')

print(value if isinstance(value, str) else '')
PY
}

choose_preferred_ai_agents_dir() {
  local current="${1:-}"
  local candidate="${2:-}"

  if ai_agents_bundle_dir_exists "$current"; then
    printf '%s\n' "$current"
  elif ai_agents_bundle_dir_exists "$candidate"; then
    printf '%s\n' "$candidate"
  else
    printf '%s\n' ''
  fi
}

ai_agents_dir_digest() {
  local dir="$1"

  python3 - "$dir" <<'PY'
import hashlib
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
if not root.is_dir():
  print('missing')
  raise SystemExit(0)

digest = hashlib.sha256()
for child in sorted(node for node in root.rglob('*') if node.is_file()):
  rel_path = child.relative_to(root).as_posix()
  digest.update(rel_path.encode('utf-8'))
  digest.update(b'\0')
  digest.update(str(child.stat().st_size).encode('utf-8'))
  digest.update(b'\0')
  file_digest = hashlib.sha256()
  with child.open('rb') as handle:
    for chunk in iter(lambda: handle.read(1024 * 1024), b''):
      file_digest.update(chunk)
  digest.update(file_digest.hexdigest().encode('ascii'))
  digest.update(b'\n')
print(digest.hexdigest())
PY
}

resolve_ai_agents_source_dir() {
  local standalone_dir="${1:-}"
  local wheel_dir="${2:-}"
  local resolved=""

  case "$AI_AGENTS_SOURCE_POLICY" in
    standalone)
      if ai_agents_bundle_dir_exists "$standalone_dir"; then
        printf '%s\n' "$standalone_dir"
      fi
      ;;
    wheel)
      if ai_agents_bundle_dir_exists "$wheel_dir"; then
        printf '%s\n' "$wheel_dir"
      fi
      ;;
    auto)
      # Prefer checked-in package payloads over the wheel-embedded payload.
      # The standalone install (from xeus_x_ai_agents wheel in built-in-wheels/)
      # is the primary source of truth for AI agents content; the wheel-embedded
      # copy is a secondary fallback carried alongside kernel artifacts.
      resolved="$(choose_preferred_ai_agents_dir "$resolved" "$standalone_dir")"
      resolved="$(choose_preferred_ai_agents_dir "$resolved" "$wheel_dir")"
      printf '%s\n' "$resolved"
      ;;
    *)
      echo "ERROR: AI_AGENTS_SOURCE_POLICY must be 'auto', 'standalone', or 'wheel'" >&2
      exit 1
      ;;
  esac
}

ai_agents_source_kind() {
  local source_dir="${1:-}"
  local standalone_dir="${2:-}"
  local wheel_dir="${3:-}"

  if [ -z "$source_dir" ]; then
    printf '%s\n' 'missing'
    return 0
  fi

  case "$source_dir" in
    "$standalone_dir")
      printf '%s\n' 'standalone'
      return 0
      ;;
    "$wheel_dir")
      printf '%s\n' 'wheel'
      return 0
      ;;
  esac

  if [ -n "$wheel_dir" ] && [[ "$source_dir" == "$wheel_dir"/* ]]; then
    printf '%s\n' 'wheel'
  elif [ -n "$standalone_dir" ] && [[ "$source_dir" == "$standalone_dir"/* ]]; then
    printf '%s\n' 'standalone'
  else
    printf '%s\n' 'unknown'
  fi
}

check_ai_agents_source_matches_wheel_manifest() {
  local source_dir="$1"
  local wheel_dir="$2"

  AI_AGENTS_DIGEST_MATCHES_WHEEL="unknown"

  # Paths managed by dedicated packages (not baked into the kernel wheel
  # manifest) skip digest validation against the kernel payload.
  # - Standalone: installed by xeus_x_ai_agents wheel into share/jupyter/ai_agents/
  case "$source_dir" in
    */share/jupyter/ai_agents)
      AI_AGENTS_DIGEST_MATCHES_WHEEL="true"
      return 0
      ;;
  esac

  if ! ai_agents_bundle_dir_exists "$source_dir"; then
    return 0
  fi

  local wheel_manifest="$wheel_dir/kernel-bundle-manifest.json"
  if [ ! -f "$wheel_manifest" ]; then
    return 0
  fi

  local expected_digest
  expected_digest="$(extract_kernel_manifest_field "$wheel_manifest" 'artifacts.aiAgents.digestSha256')"
  if [ -z "$expected_digest" ]; then
    return 0
  fi

  local actual_digest
  actual_digest="$(ai_agents_dir_digest "$source_dir")"
  if [ "$actual_digest" != "$expected_digest" ]; then
    AI_AGENTS_DIGEST_MATCHES_WHEEL="false"
    echo "ERROR: AI agents source digest does not match installed wheel manifest" >&2
    echo "  source:   $source_dir" >&2
    echo "  actual:   $actual_digest" >&2
    echo "  expected: $expected_digest ($wheel_manifest)" >&2
    echo "Hint: rebuild xeus-x and wheel, set AI_AGENTS_SOURCE_POLICY=wheel, or set AI_AGENTS_ALLOW_WHEEL_MISMATCH=1 for an intentional override." >&2
    return 1
  fi

  AI_AGENTS_DIGEST_MATCHES_WHEEL="true"
  return 0
}

verify_ai_agents_source_matches_wheel_manifest() {
  local source_dir="$1"
  local wheel_dir="$2"
  local source_kind="${3:-$(ai_agents_source_kind "$source_dir" "$AI_AGENTS_SOURCE_STANDALONE" "$AI_AGENTS_SOURCE_WHEEL")}"

  if check_ai_agents_source_matches_wheel_manifest "$source_dir" "$wheel_dir"; then
    return 0
  fi

  case "$source_kind" in
    standalone)
      if [ "$AI_AGENTS_ALLOW_WHEEL_MISMATCH" = "1" ]; then
        echo "  ⚠ Proceeding with ${source_kind} AI agents bundle despite wheel-manifest mismatch because AI_AGENTS_ALLOW_WHEEL_MISMATCH=1" >&2
        return 0
      fi
      ;;
  esac

  return 1
}

extract_ai_agents_bundle_marker() {
  local bundle_js="$1"

  python3 - "$bundle_js" <<'PY'
import pathlib
import re
import sys

path = pathlib.Path(sys.argv[1])
if not path.is_file():
    print('missing')
    raise SystemExit(0)

content = path.read_text(encoding='utf-8', errors='ignore')
match = re.search(r'ai_agents-bundle-marker:[^\'\"]+', content)
print(match.group(0) if match else 'unknown')
PY
}

verify_ai_agents_copy() {
  local source_dir="$1"
  local dest_dir="$2"
  local source_marker="$3"
  local source_digest="$4"

  if ! ai_agents_bundle_dir_exists "$dest_dir"; then
    echo "ERROR: AI agents destination missing bundle.js: $dest_dir" >&2
    exit 1
  fi

  local dest_marker
  local dest_digest
  dest_marker="$(extract_ai_agents_bundle_marker "$dest_dir/bundle.js")"
  dest_digest="$(ai_agents_dir_digest "$dest_dir")"

  if [ "$dest_marker" != "$source_marker" ]; then
    echo "ERROR: AI agents marker mismatch after copy to $dest_dir" >&2
    echo "  source: $source_marker ($source_dir)" >&2
    echo "  dest:   $dest_marker" >&2
    exit 1
  fi

  if [ "$dest_digest" != "$source_digest" ]; then
    echo "ERROR: AI agents digest mismatch after copy to $dest_dir" >&2
    echo "  source: $source_digest ($source_dir)" >&2
    echo "  dest:   $dest_digest" >&2
    exit 1
  fi
}

verify_ai_agents_output_toggle_support() {
  local bundle_js="$1"

  if ! grep -Fq 'dataxNow?.showAgentStatementInOutput' "$bundle_js"; then
    echo "ERROR: AI agents bundle does not contain the dataxNow output-toggle guard" >&2
    echo "  bundle: $bundle_js" >&2
    echo "Rebuild and publish the xeus_x_ai_agents wheel before deploying." >&2
    return 1
  fi
}

usage() {
  echo "Usage: $0 [-c|--clean] [-h|--help]"
    echo ""
    echo "Options:"
    echo "  -c, --clean    Clean local envs, then rebuild dist/"
    echo "  -h, --help     Show this help message"
    echo ""
  echo "Incremental build (default): reuses existing conda envs."
    echo "Clean build (-c):            clears local envs before assembling dist/."
    echo ""
  echo "The xeus-x kernel is consumed via the jupyterlite-xeus-x wheel in"
  echo "built-in-wheels/.  To update the kernel, drop a new wheel there and rerun."
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -c|--clean)
            CLEAN_BUILD=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
          echo "Unknown option: $1" >&2
          usage 2 >&2
            ;;
    esac
done

if [ "$CLEAN_BUILD" = true ]; then
    echo "=========================================="
    echo "CLEAN BUILD MODE"
    echo "=========================================="
else
    echo "=========================================="
    echo "INCREMENTAL BUILD MODE"
    echo "(use -c or --clean for a full clean build)"
    echo "=========================================="
fi

cd "$REPO_ROOT"

if [ "$CLEAN_BUILD" = true ]; then
  echo ""
  echo "=========================================="
  echo "Refreshing local build environments..."
  echo "=========================================="
fi

# ==============================================================================
# ==============================================================================
# Suppress common CI warnings
# ==============================================================================
export LC_ALL=C.UTF-8
export LANG=C.UTF-8
export PIP_ROOT_USER_ACTION=ignore
export PYTHONWARNINGS="ignore::UserWarning"

# AI_AGENTS_SOURCE_BUILD is resolved from the installed wheel after the deploy
# environment is created.

# ==============================================================================
# Wheel references are maintained inside this repo only.
# ==============================================================================
echo "=========================================="
echo "Updating wheel references in YAML files..."
echo "=========================================="
if [ -f "built-in-wheels/update_wheel_references.py" ]; then
    python3 built-in-wheels/update_wheel_references.py || {
        echo "⚠️  Warning: Failed to update wheel references, continuing..."
    }
    if ! python3 built-in-wheels/update_wheel_references.py --validate-only; then
        echo "ERROR: Wheel references are stale or missing after refresh" >&2
        exit 1
    fi
else
    echo "⚠️  Warning: update_wheel_references.py not found, skipping wheel update"
fi
echo ""

# ==============================================================================
# ==============================================================================
# Micromamba setup
# ==============================================================================
if [ ! -f "$PWD/bin/micromamba" ]; then
    echo "Downloading Micromamba..."
    mkdir -p "$PWD/bin"
    _micromamba_archive="$(mktemp "${TMPDIR:-/tmp}/micromamba.XXXXXX.tar.bz2")"
    _micromamba_url="https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-linux-64.tar.bz2"
    _micromamba_sha256="8761c382127e6363bd9e0a2451aa3ef90d071a79133f736e2f759a3bf13040dd"
    cleanup_micromamba_archive() {
      rm -f "$_micromamba_archive"
    }
    trap cleanup_micromamba_archive EXIT

    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$_micromamba_url" -o "$_micromamba_archive"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$_micromamba_archive" "$_micromamba_url"
    else
      echo "ERROR: curl or wget is required to download Micromamba." >&2
      exit 1
    fi

    if command -v sha256sum >/dev/null 2>&1; then
      printf '%s  %s\n' "$_micromamba_sha256" "$_micromamba_archive" | sha256sum --check --status -
    elif command -v shasum >/dev/null 2>&1; then
      _actual_micromamba_sha256="$(shasum -a 256 "$_micromamba_archive" | awk '{print $1}')"
      [ "$_actual_micromamba_sha256" = "$_micromamba_sha256" ]
    else
      echo "ERROR: sha256sum or shasum is required to verify Micromamba." >&2
      exit 1
    fi || {
      echo "ERROR: Micromamba checksum verification failed." >&2
      exit 1
    }

    python3 - "$_micromamba_archive" "$PWD/bin" <<'PY'
import pathlib
import sys
import tarfile

archive_path = pathlib.Path(sys.argv[1])
dest_dir = pathlib.Path(sys.argv[2])
target_name = "bin/micromamba"

with tarfile.open(archive_path, mode="r:*") as tar:
    try:
        member = tar.getmember(target_name)
    except KeyError as exc:
        raise SystemExit(f"Micromamba archive missing {target_name}") from exc
    tar.extract(member, path=dest_dir.parent)
PY
    chmod +x "$PWD/bin/micromamba"
    cleanup_micromamba_archive
    trap - EXIT
else
    echo "Micromamba already present, skipping download."
fi

export MAMBA_ROOT_PREFIX="$PWD/micromamba"
export PATH="$PWD/bin:$PATH"

_micromamba_script_dir="$PWD"
mamba_run_deploy() {
  export MAMBA_ROOT_PREFIX="$_micromamba_script_dir/micromamba"
  "$_micromamba_script_dir/bin/micromamba" run -n jupyterlite-deploy "$@"
}

# Helper: resilient micromamba create with retries and cache-clean on failure
micromamba_create_with_retries() {
  local max_attempts=3
  local attempt=1
  local sleep_base=5
  local env_name=""
  local prefix_path=""
  local previous=""
  local arg=""

  for arg in "$@"; do
    case "$previous" in
      -n|--name)
        env_name="$arg"
        ;;
      -p|--prefix)
        prefix_path="$arg"
        ;;
    esac
    previous="$arg"
  done

  while [ $attempt -le $max_attempts ]; do
    echo "Attempt $attempt/$max_attempts: micromamba create $*"
    if "$_micromamba_script_dir/bin/micromamba" create "$@"; then
      return 0
    fi

    echo "micromamba create failed on attempt $attempt"
    if [ -n "$env_name" ] && [ -d "$MAMBA_ROOT_PREFIX/envs/$env_name" ]; then
      echo "Removing partially created environment: $MAMBA_ROOT_PREFIX/envs/$env_name"
      rm -rf "$MAMBA_ROOT_PREFIX/envs/$env_name"
    fi
    if [ -n "$prefix_path" ] && [ -d "$prefix_path" ]; then
      echo "Removing partially created prefix: $prefix_path"
      rm -rf "$prefix_path"
    fi
    echo "Running 'micromamba clean -a' to clear package cache (may fix corrupted cache)"
    "$_micromamba_script_dir/bin/micromamba" clean -a -y || true

    attempt=$((attempt + 1))
    if [ $attempt -le $max_attempts ]; then
      sleep_time=$((sleep_base * attempt))
      echo "Retrying after ${sleep_time}s..."
      sleep $sleep_time
    else
      echo "Exceeded max micromamba create attempts ($max_attempts)."
      return 1
    fi
  done
}
BUILTIN_CONDA_DIR="$PWD/built-in-conda"
BUILTIN_RUNTIME_WHEELS_DIR="$PWD/built-in-runtime-wheels"
BUILTIN_LOCAL_DIST_DIR="$PWD/dist/xeus/xeus-python-wasm-host/built-in-local"

LOCAL_CONDA_CHANNEL=""

# Helper function to check if an environment is functional
check_env_functional() {
    local env_name=$1
    local check_binary=$2
    
    if [ ! -d "$MAMBA_ROOT_PREFIX/envs/$env_name" ]; then
        return 1
    fi
    
    if [ -n "$check_binary" ] && [ ! -f "$MAMBA_ROOT_PREFIX/envs/$env_name/$check_binary" ]; then
        return 1
    fi
    
    return 0
}

# Clean up existing environments only if requested
if [ "$CLEAN_BUILD" = true ]; then
    echo "Cleaning up existing environments..."
    rm -rf $MAMBA_ROOT_PREFIX/envs/jupyterlite-deploy 2>/dev/null || true
    rm -rf $MAMBA_ROOT_PREFIX/envs/xeus-python-wasm-host 2>/dev/null || true
fi

# ==============================================================================
# Create deploy environment
# ==============================================================================
DEPLOY_ENV_HASH_FILE="$MAMBA_ROOT_PREFIX/envs/jupyterlite-deploy/.jupyterlite_env_spec_sha256"
DEPLOY_ENV_SPEC_HASH="$(sha256sum environment-deploy.yml | awk '{print $1}')"
DEPLOY_ENV_HASH_MATCH=false
if [ -f "$DEPLOY_ENV_HASH_FILE" ] && [ "$(cat "$DEPLOY_ENV_HASH_FILE")" = "$DEPLOY_ENV_SPEC_HASH" ]; then
  DEPLOY_ENV_HASH_MATCH=true
fi

if [ "$CLEAN_BUILD" = true ] || ! check_env_functional "jupyterlite-deploy" "bin/python" || [ "$DEPLOY_ENV_HASH_MATCH" != true ]; then
  echo "Creating deploy environment..."
  rm -rf "$MAMBA_ROOT_PREFIX/envs/jupyterlite-deploy"
  micromamba_create_with_retries -f environment-deploy.yml -n jupyterlite-deploy -y --quiet --log-level error
  printf '%s\n' "$DEPLOY_ENV_SPEC_HASH" > "$DEPLOY_ENV_HASH_FILE"
else
    echo "Deploy environment already exists and is functional, skipping creation."
fi

# ==============================================================================
# Prepare built-in conda channel metadata
# ==============================================================================
if [ -d "$BUILTIN_CONDA_DIR" ]; then
  echo "Preparing built-in conda channel metadata..."
  mamba_run_deploy python built-in-conda/generate_repodata.py "$BUILTIN_CONDA_DIR"
  mamba_run_deploy python built-in-conda/generate_repodata.py --validate-only "$BUILTIN_CONDA_DIR"
  if find "$BUILTIN_CONDA_DIR" -type f \( -name '*.tar.bz2' -o -name '*.conda' \) | grep -q .; then
    LOCAL_CONDA_CHANNEL="file://${BUILTIN_CONDA_DIR}"
    echo "Built-in conda channel enabled: $LOCAL_CONDA_CHANNEL"
  else
    echo "Built-in conda channel is empty, skipping local channel injection"
  fi
fi

if [ -d "$BUILTIN_RUNTIME_WHEELS_DIR" ]; then
  echo "Preparing built-in runtime wheel index..."
  mamba_run_deploy python built-in-runtime-wheels/generate_index.py "$BUILTIN_RUNTIME_WHEELS_DIR"
  mamba_run_deploy python built-in-runtime-wheels/generate_index.py --validate-only "$BUILTIN_RUNTIME_WHEELS_DIR"
fi

# ==============================================================================
# Create host environment (for JupyterLite xeus addon to discover packages)
# ==============================================================================
HOST_CHANNEL_ARGS=(-c conda-forge -c https://repo.prefix.dev/emscripten-forge-4x)
HOST_USE_LOCAL_CONDA_CHANNEL="${JUPYTERLITE_HOST_USE_LOCAL_CONDA_CHANNEL:-false}"
if [ -n "$LOCAL_CONDA_CHANNEL" ] && [ "$HOST_USE_LOCAL_CONDA_CHANNEL" = "true" ]; then
    HOST_CHANNEL_ARGS=(-c "$LOCAL_CONDA_CHANNEL" "${HOST_CHANNEL_ARGS[@]}")
fi

HOST_ENV_SPEC_FILE="$PWD/environment-wasm-host.yml"
HOST_ENV_HASH_FILE="$MAMBA_ROOT_PREFIX/envs/xeus-python-wasm-host/.jupyterlite_env_spec_sha256"
HOST_ENV_SPEC_HASH=""
HOST_ENV_HASH_MATCH=false

if [ -f "$HOST_ENV_SPEC_FILE" ]; then
  HOST_ENV_SPEC_HASH="$(sha256sum "$HOST_ENV_SPEC_FILE" | awk '{print $1}')"
  if [ -f "$HOST_ENV_HASH_FILE" ]; then
    CURRENT_HOST_ENV_HASH="$(cat "$HOST_ENV_HASH_FILE" 2>/dev/null || true)"
    if [ "$CURRENT_HOST_ENV_HASH" = "$HOST_ENV_SPEC_HASH" ]; then
      HOST_ENV_HASH_MATCH=true
    fi
  fi
fi

NEEDS_ENV_PATCHING=false
if [ "$CLEAN_BUILD" = true ] || ! check_env_functional "xeus-python-wasm-host" "lib/libxeus.a" || [ "$HOST_ENV_HASH_MATCH" != true ]; then
    echo "Creating host environment..."
  if [ "$HOST_ENV_HASH_MATCH" != true ] && [ "$CLEAN_BUILD" != true ]; then
    echo "Host environment spec changed (or hash missing), recreating xeus-python-wasm-host."
  fi
    rm -rf $MAMBA_ROOT_PREFIX/envs/xeus-python-wasm-host 2>/dev/null || true
    micromamba_create_with_retries -y -n xeus-python-wasm-host -f environment-wasm-host.yml \
      --platform=emscripten-wasm32 \
      --no-channel-priority --override-channels --quiet --log-level error \
      "${HOST_CHANNEL_ARGS[@]}"

  if [ -n "$HOST_ENV_SPEC_HASH" ]; then
    echo "$HOST_ENV_SPEC_HASH" > "$HOST_ENV_HASH_FILE"
  fi
    
    NEEDS_ENV_PATCHING=true
else
    echo "Host environment already exists and is functional, skipping creation."
fi

export DEPLOY_PREFIX=$MAMBA_ROOT_PREFIX/envs/jupyterlite-deploy
export PREFIX=$MAMBA_ROOT_PREFIX/envs/xeus-python-wasm-host
QUAK_PATCHER="$PWD/scripts/patch_quak_widget.py"

# Path where the jupyterlite-xeus-x wheel deposits its payload
KERNEL_WHEEL_DIR="$DEPLOY_PREFIX/share/jupyter/xeus-x"

# ==============================================================================
# Validate that the kernel wheel has been installed
# ==============================================================================
if [ ! -f "$KERNEL_WHEEL_DIR/bin/xpython.js" ]; then
    echo "ERROR: Kernel artifacts not found at $KERNEL_WHEEL_DIR"
    echo ""
    echo "The jupyterlite-xeus-x wheel must be present in built-in-wheels/ before"
    echo "running build.sh. Build xeus-x, let it publish into built-in-wheels/,"
    echo "or copy a compatible wheel into this repository and rerun build.sh."
    exit 1
fi

echo "Using kernel artifacts from installed wheel: $KERNEL_WHEEL_DIR"
if [ -f "$KERNEL_WHEEL_DIR/kernel-bundle-manifest.json" ]; then
  WHEEL_VERSION=$(python3 -c "
import json, pathlib
m = json.loads(pathlib.Path('$KERNEL_WHEEL_DIR/kernel-bundle-manifest.json').read_text())
print(m.get('producer', {}).get('commit', 'unknown')[:12])
" 2>/dev/null || echo 'unknown')
  echo "  ✓ kernel-bundle-manifest.json present (commit ${WHEEL_VERSION})"
fi

WHEEL_MANIFEST_PATH="$KERNEL_WHEEL_DIR/kernel-bundle-manifest.json"
WHEEL_KERNEL_JS_SHA256=""
WHEEL_KERNEL_WASM_SHA256=""
WHEEL_AI_AGENTS_DIGEST=""

# The deploy env may still have a previously installed wheel payload at this
# point. Defer AI agents source resolution until after built-in wheels are
# installed/refreshed below.
AI_AGENTS_SOURCE_WHEEL="$KERNEL_WHEEL_DIR/ai_agents"
AI_AGENTS_SOURCE_STANDALONE="$DEPLOY_PREFIX/share/jupyter/ai_agents"
AI_AGENTS_SOURCE_BUILD=""

# ==============================================================================
# Patch host environment (remove .so, fix CMake configs)
# ==============================================================================
if [ "$NEEDS_ENV_PATCHING" != true ]; then
    NEEDS_ENV_PATCHING=false
    if [ "$CLEAN_BUILD" = true ]; then
        NEEDS_ENV_PATCHING=true
    elif [ ! -f "$PREFIX/lib/cmake/xeus/xeusTargets-release.cmake.patched" ]; then
        NEEDS_ENV_PATCHING=true
    fi
fi

if [ "$NEEDS_ENV_PATCHING" = true ]; then
    echo "Removing shared libraries from wasm-host environment..."
    rm -f $PREFIX/lib/libxeus.so*
    rm -f $PREFIX/lib/libxeus-lite.so*
    rm -f $PREFIX/lib/libxeus-zmq.so*
    echo "Using static libraries only for WASM linking"

    echo "Patching CMake config files to use static libraries..."

if [ -f "$PREFIX/lib/cmake/xeus/xeusTargets-release.cmake" ]; then
  rm -f "$PREFIX/lib/cmake/xeus/xeusTargets-release.cmake"
  cat > "$PREFIX/lib/cmake/xeus/xeusTargets-release.cmake" << 'EOF'
set(CMAKE_IMPORT_FILE_VERSION 1)
set_property(TARGET xeus APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(xeus PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE "CXX"
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libxeus.a"
  )
list(APPEND _cmake_import_check_targets xeus )
list(APPEND _cmake_import_check_files_for_xeus "${_IMPORT_PREFIX}/lib/libxeus.a" )
set_property(TARGET xeus-static APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(xeus-static PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE "CXX"
  IMPORTED_LOCATION_RELEASE "${_IMPORT_PREFIX}/lib/libxeus.a"
  )
list(APPEND _cmake_import_check_targets xeus-static )
list(APPEND _cmake_import_check_files_for_xeus-static "${_IMPORT_PREFIX}/lib/libxeus.a" )
set(CMAKE_IMPORT_FILE_VERSION)
EOF
fi

# ==============================================================================
# Patch quak widget bundle for degenerate histogram domains in JupyterLite
# ==============================================================================
echo "🔧 Patching quak widget bundle for degenerate histogram domains..."
if [ -f "$QUAK_PATCHER" ]; then
  QUAK_WIDGET_PATHS=()
  # Some hosted build images may not mount /dev/fd, so avoid process substitution.
  quak_widget_paths="$(find "$PREFIX/lib" -path '*/site-packages/quak/widget.js' -type f 2>/dev/null | sort)"
  while IFS= read -r widget_path; do
    [[ -z "$widget_path" ]] && continue
    QUAK_WIDGET_PATHS+=("$widget_path")
  done <<< "$quak_widget_paths"

  cached_quak_widget_paths="$(find "$MAMBA_ROOT_PREFIX/pkgs" -path '*/site-packages/quak/widget.js' -type f 2>/dev/null | sort)"
  while IFS= read -r cached_widget_path; do
    [[ -z "$cached_widget_path" ]] && continue
    QUAK_WIDGET_PATHS+=("$cached_widget_path")
  done <<< "$cached_quak_widget_paths"

  if [ "${#QUAK_WIDGET_PATHS[@]}" -gt 0 ]; then
    python3 "$QUAK_PATCHER" "${QUAK_WIDGET_PATHS[@]}"
  else
    echo "  Info: Quak is not installed in the host environment; packed kernel packages will be checked after build"
  fi
else
  echo "  ⚠ Quak patcher script not found at $QUAK_PATCHER"
fi

if [ -f "$PREFIX/lib/cmake/xeus-lite/xeus-liteTargets-release.cmake" ]; then
  sed -i 's/libxeus-lite\.so/libxeus-lite.a/g' "$PREFIX/lib/cmake/xeus-lite/xeus-liteTargets-release.cmake"
fi

if [ -f "$PREFIX/lib/cmake/xeus-zmq/xeus-zmqTargets-release.cmake" ]; then
  sed -i 's/libxeus-zmq\.so/libxeus-zmq.a/g' "$PREFIX/lib/cmake/xeus-zmq/xeus-zmqTargets-release.cmake"
fi

    touch "$PREFIX/lib/cmake/xeus/xeusTargets-release.cmake.patched"
else
    echo "Environment already patched, skipping shared library removal and CMake patching."
fi

# Patch xeus-lite headers
if [ -f "$PREFIX/include/xeus/xserver_emscripten.hpp" ]; then
  sed -i 's/update_config_impl(xconfiguration& config) const override;/update_config_impl(xkernel_configuration\& config) const override;/g' "$PREFIX/include/xeus/xserver_emscripten.hpp"
fi

# ==============================================================================
# Rebuild the R plotting/evaluation package code with the deployment R version
# ==============================================================================
if [ ! -x "$R_PLOT_PACKAGE_REBUILDER" ]; then
  echo "ERROR: R package rebuild helper is missing or not executable:"
  echo "  $R_PLOT_PACKAGE_REBUILDER"
  exit 1
fi

"$R_PLOT_PACKAGE_REBUILDER" \
  "$DEPLOY_PREFIX/bin/R" \
  "$PREFIX/lib/R/library" \
  "$R_SOURCE_CACHE_DIR"

install_hera_from_wheel() {
    if [ ! -f "$DEPLOY_PREFIX/bin/R" ]; then
        echo "ERROR: R not found in deploy environment at $DEPLOY_PREFIX/bin/R"
        echo "The deploy environment may be incomplete. Try running with -c flag:"
        echo "  ./build.sh -c"
        exit 1
    fi

    # hera source from vendored kernel artifacts
    HERA_SRC="$KERNEL_WHEEL_DIR/hera"
    if [ ! -d "$HERA_SRC" ]; then
        echo "ERROR: hera R package source not found at $HERA_SRC"
        echo "Rebuild the kernel wheel and update built-in-wheels/ with the new wheel."
        exit 1
    fi

    echo "Installing hera R package in wasm-host environment..."

    libraries=(
      jsonlite rlang base64enc digest fastmap htmltools cli glue vctrs
    )

    for library in "${libraries[@]}"; do
      if [ -d "$PREFIX/lib/R/library/$library" ] && [ -d "$DEPLOY_PREFIX/lib/R/library/$library" ]; then
        echo "  Swap $library"
        mv "$PREFIX/lib/R/library/$library" "$PREFIX/lib/R/library/${library}.wasm-backup"
        cp -r "$DEPLOY_PREFIX/lib/R/library/$library" "$PREFIX/lib/R/library/$library"
      fi
    done

    echo "Installing hera..."
    local hera_install_status=0
    export R_LIBS=$PREFIX/lib/R/library
    ${DEPLOY_PREFIX}/bin/R CMD INSTALL "$HERA_SRC" \
      --no-byte-compile \
      --no-test-load \
      --library=$R_LIBS || hera_install_status=$?
    unset R_LIBS

    echo "Restoring WASM libraries..."
    for library in "${libraries[@]}"; do
      if [ -d "$PREFIX/lib/R/library/${library}.wasm-backup" ]; then
        echo "  Restore $library"
        rm -rf "$PREFIX/lib/R/library/$library"
        mv "$PREFIX/lib/R/library/${library}.wasm-backup" "$PREFIX/lib/R/library/$library"
      fi
    done

    if [ "$hera_install_status" -ne 0 ]; then
      echo "ERROR: hera installation failed with status $hera_install_status"
      return "$hera_install_status"
    fi
}

# ==============================================================================
# Copy pre-built kernel binaries into the host environment
# ==============================================================================
KERNEL_SPEC_DIR="$PREFIX/share/jupyter/kernels/xpython"

sync_kernel_runtime_from_wheel() {
  local source_dir="$1"

  echo "Copying pre-built kernel binaries from vendor..."

  cp -v "$source_dir/bin/xpython.js" "$PREFIX/bin/xpython.js"
  cp -v "$source_dir/bin/xpython.wasm" "$PREFIX/bin/xpython.wasm"

  mkdir -p "$KERNEL_SPEC_DIR"
  cp -f "$PREFIX/bin/xpython.js" "$KERNEL_SPEC_DIR/xpython.js"
  cp -f "$PREFIX/bin/xpython.wasm" "$KERNEL_SPEC_DIR/xpython.wasm"

  for logo in logo-32x32.png logo-64x64.png logo-svg.svg; do
    if [ -f "$source_dir/kernels/xpython/$logo" ]; then
      cp -f "$source_dir/kernels/xpython/$logo" "$KERNEL_SPEC_DIR/$logo"
      echo "  ✓ Copied $logo"
    fi
  done
}

sync_kernel_runtime_from_wheel "$KERNEL_WHEEL_DIR"

cat > "$KERNEL_SPEC_DIR/kernel.json" << "EOFKERNEL"
{
  "display_name": "DataX",
  "language": "python",
  "argv": [
    "xpython"
  ],
  "metadata": {
    "debugger": true,
    "kernel_provisioner": {
      "provisioner_name": "xeus-python-kernel"
    }
  }
}
EOFKERNEL

echo "  ✓ Kernel spec created at $KERNEL_SPEC_DIR/kernel.json"

# Remove unused xpython-raw kernelspec
RAW_SPEC_DIR="$PREFIX/share/jupyter/kernels/xpython-raw"
if [ -d "$RAW_SPEC_DIR" ]; then
  rm -rf "$RAW_SPEC_DIR"
  echo "  ✓ Removed unused xpython-raw kernelspec directory"
fi

# ==============================================================================
# Install Python dependencies for JupyterLite
# ==============================================================================
if [ -f requirements.txt ]; then
  echo "Installing Python dependencies from requirements.txt..."
  mamba_run_deploy python -m pip install --root-user-action=ignore -r requirements.txt
else
  echo "No requirements.txt found, skipping Python dependencies installation"
fi

# ==============================================================================
# Install built-in wheels
# ==============================================================================
echo "Installing built-in wheels..."
if [ -d "built-in-wheels" ]; then
  echo "Found built-in-wheels directory, installing packages..."

  SELECTED_WHEELS=()
  selected_wheels="$(python3 <<'EOF'
from pathlib import Path
import re

env_file = Path('environment-deploy.yml')
if not env_file.exists():
    raise SystemExit(0)

pattern = re.compile(r'^\s*-\s+((?:\./)?built-in-wheels/[^#\s]+\.whl)\s*$')
for raw in env_file.read_text(encoding='utf-8').splitlines():
    match = pattern.match(raw)
    if match:
        print(match.group(1))
EOF
  )"
  while IFS= read -r wheel_path; do
    [[ -z "$wheel_path" ]] && continue
    SELECTED_WHEELS+=("$wheel_path")
  done <<< "$selected_wheels"

  if [ "${#SELECTED_WHEELS[@]}" -eq 0 ]; then
    echo "Warning: no built-in wheels were referenced in environment-deploy.yml"
  else
    echo "Selected wheel files:"
    printf '  %s\n' "${SELECTED_WHEELS[@]}"
  fi

  for wheel in "${SELECTED_WHEELS[@]}"; do
    if [ -f "$wheel" ]; then
      echo "Installing $(basename "$wheel")..."
      mamba_run_deploy python -m pip install --root-user-action=ignore --force-reinstall --no-deps "$wheel"
    else
      echo "ERROR: Missing wheel referenced by environment-deploy.yml: $wheel" >&2
      exit 1
    fi
  done

  # Reinstall the selected custom Xeus addon after environment creation. The
  # manifest may resolve a different package state, but this wheel provides the
  # runtime hooks used by the variable inspector.
  XEUS_ADDON_WHEEL=""
  for wheel in "${SELECTED_WHEELS[@]}"; do
    case "$(basename "$wheel")" in
      jupyterlite_xeus-*.whl)
        XEUS_ADDON_WHEEL="$wheel"
        break
        ;;
    esac
  done
  if [ -n "$XEUS_ADDON_WHEEL" ] && [ -f "$XEUS_ADDON_WHEEL" ]; then
    echo "Installing $(basename "$XEUS_ADDON_WHEEL") without dependencies..."
    mamba_run_deploy python -m pip install --root-user-action=ignore --force-reinstall --no-deps "$XEUS_ADDON_WHEEL"
  else
    echo "ERROR: No jupyterlite_xeus addon wheel is selected by environment-deploy.yml" >&2
    exit 1
  fi

  echo "Verifying installed packages:"
  mamba_run_deploy python -m pip list | grep -iE "(datax[_-]now[_-]front|jupyterlite[_-]xeus|jupyterlite-ai|jupyterlab-ai-commands)" || echo "Built-in packages not found in pip list"

  mamba_run_deploy python - <<'EOF'
from importlib import metadata
import sys


def parse_version(raw: str):
    parts = []
    for token in raw.replace('-', '.').split('.'):
        if token.isdigit():
            parts.append(int(token))
        else:
            break
    return tuple(parts)


errors = []
try:
    lite_ai_version = metadata.version('jupyterlite-ai')
except metadata.PackageNotFoundError:
    errors.append('jupyterlite-ai is not installed')
else:
    if lite_ai_version != '0.19.0':
        errors.append(f'jupyterlite-ai version mismatch: expected 0.19.0, got {lite_ai_version}')

try:
    commands_version = metadata.version('jupyterlab-ai-commands')
except metadata.PackageNotFoundError:
    errors.append('jupyterlab-ai-commands is not installed')
else:
    parsed = parse_version(commands_version)
    if parsed < (0, 3, 1) or parsed >= (0, 4, 0):
        errors.append(
            'jupyterlab-ai-commands version mismatch: expected >=0.3.1,<0.4, '
            f'got {commands_version}'
        )

if errors:
    for error in errors:
        print(f'ERROR: {error}', file=sys.stderr)
    raise SystemExit(1)

print(f'  ✓ jupyterlite-ai version: {lite_ai_version}')
print(f'  ✓ jupyterlab-ai-commands version: {commands_version}')
EOF

  echo "Checking installed JupyterLab extensions:"
  PAGER=cat mamba_run_deploy jupyter labextension list 2>/dev/null || echo "Could not list extensions"

  echo "Ensuring jupyterlite_xeus runtime dependencies are installed..."
  mamba_run_deploy python -m pip install --root-user-action=ignore 'empack>=5.1.1,<7' || echo "Warning: Failed to install empack"
  mamba_run_deploy python - <<'EOF'
import importlib.util
print(f"  ✓ empack import available: {bool(importlib.util.find_spec('empack'))}")
EOF
  
  # Patch jupyterlite_xeus to resolve kernel binary path handling and allow
  # reusing a prebuilt xeus runtime without repacking the env during Lite build.
  echo "Patching jupyterlite_xeus get_kernel_binaries() function..."
  mamba_run_deploy python3 <<'EOFPATCH'
import os
import sys
from pathlib import Path

pyver = f'python{sys.version_info.major}.{sys.version_info.minor}'
site_packages = Path(sys.prefix) / 'lib' / pyver / 'site-packages'
addon_file = site_packages / 'jupyterlite_xeus' / 'add_on.py'

if addon_file.exists():
    content = addon_file.read_text()

    if 'path / (kernel_binary + ".js")' in content:
        print(f'  Already patched get_kernel_binaries: {addon_file}')
    else:
        original = '''        kernel_binary_js = Path(kernel_binary + ".js")
        kernel_binary_wasm = Path(kernel_binary + ".wasm")
        kernel_binary_data = Path(kernel_binary + ".data")'''
        fixed = '''        kernel_binary_js = path / (kernel_binary + ".js")
        kernel_binary_wasm = path / (kernel_binary + ".wasm")
        kernel_binary_data = path / (kernel_binary + ".data")'''

        if original in content:
            content = content.replace(original, fixed)
            print(f'  ✓ Patched get_kernel_binaries: {addon_file}')
        else:
            print(f'  ⚠ Could not find get_kernel_binaries block in {addon_file}')

    skip_pack_sentinel = 'JUPYTERLITE_SKIP_XEUS_PACK'
    if skip_pack_sentinel in content:
        print(f'  Already patched pack_prefix skip: {addon_file}')
    else:
        pack_prefix_hook = '''        # pack prefix packages
        yield from self.pack_prefix(env_name, prefix)
'''
        pack_prefix_replacement = '''        # pack prefix packages unless deploy provides a prebuilt xeus runtime
        if os.environ.get("JUPYTERLITE_SKIP_XEUS_PACK") == "1":
            return all_kernels
        yield from self.pack_prefix(env_name, prefix)
'''

        if pack_prefix_hook in content:
            content = content.replace(pack_prefix_hook, pack_prefix_replacement)
            print(f'  ✓ Patched pack_prefix skip: {addon_file}')
        else:
            print(f'  ⚠ Could not find pack_prefix hook in {addon_file}')

    addon_file.write_text(content)
else:
    print(f'  ⚠ File not found: {addon_file}')
EOFPATCH

  echo "Normalizing jupyterlite_xeus labextension metadata and startup logging..."
  mamba_run_deploy python3 <<'EOFPATCH'
import json
import sys
from pathlib import Path

prefix = Path(sys.prefix)
labextensions_root = prefix / 'share' / 'jupyter' / 'labextensions'

# The deployed JupyterLite 0.8.3 shell is built from stable JupyterLab 4.6.3
# artifacts. Some prebuilt extensions still ship prerelease or newer stable
# module-federation ranges in their remoteEntry bundle, even when their
# package.json advertises stable dependencies. Normalize those requests to the
# stable versions actually exposed by the CORE_OUTPUT bundle.
stable_dependency_versions = {
    '@jupyterlab/application': '4.6.3',
    '@jupyterlab/apputils': '4.7.3',
    '@jupyterlab/cells': '4.6.3',
    '@jupyterlab/codemirror': '4.6.3',
    '@jupyterlab/completer': '4.6.3',
    '@jupyterlab/coreutils': '6.6.3',
    '@jupyterlab/docmanager': '4.6.3',
    '@jupyterlab/docregistry': '4.6.3',
    '@jupyterlab/filebrowser': '4.6.3',
    '@jupyterlab/fileeditor': '4.6.3',
    '@jupyterlab/logconsole': '4.6.3',
    '@jupyterlab/nbformat': '4.6.3',
    '@jupyterlab/notebook': '4.6.3',
    '@jupyterlab/rendermime': '4.6.3',
    '@jupyterlab/services': '7.6.3',
    '@jupyterlab/settingregistry': '4.6.3',
    '@jupyterlab/statedb': '4.6.3',
    '@jupyterlab/statusbar': '4.6.3',
    '@jupyterlab/translation': '4.6.3',
    '@jupyterlab/ui-components': '4.6.3',
    '@jupyterlite/apputils': '0.8.3',
    '@jupyterlite/services': '0.8.3',
}

normalized_required_versions = {
    '0.7.0': '0.8.3',
    '~0.7.0': '~0.8.3',
    '^0.7.0': '^0.8.3',
    '4.5.7': '4.6.3',
    '4.6.7': '4.7.3',
    '7.5.7': '7.6.3',
    '>=4.5.6 <4.6.0': '>=4.6.3 <4.7.0',
    '>=4.6.6 <4.7.0': '>=4.7.3 <4.8.0',
    '>=6.4.0-alpha.0 <7.0.0': '>=6.6.3 <7.0.0',
    '^1.1.10 || ^2 || ^3 || ^4.0.0': '6.0.11',
    '^1 || ^2 || ^3 || ^4': '6.0.11',
    '^4.6.0-beta.0': '^4.6.3',
    '^4.6.0-beta.1': '^4.6.3',
    '^4.6.1': '^4.6.3',
    '^4.6.2': '^4.6.3',
    '^4.7.0-beta.0': '^4.7.3',
    '^4.7.0-beta.1': '^4.7.3',
    '^4.7.1': '^4.7.3',
    '^6.6.0-beta.0': '^6.6.3',
    '^6.6.0-beta.1': '^6.6.3',
    '^6.6.1': '^6.6.3',
    '^7.6.0-beta.0': '^7.6.3',
    '^7.6.0-beta.1': '^7.6.3',
    '^7.6.2': '^7.6.3',
}

module_federation_version_arrays = {
    '[,[-1,4,6,0],[0,4,5,6],2]': '[,[-1,4,7,0],[0,4,6,3],2]',
    '[,[-1,4,7,0],[0,4,6,6],2]': '[,[-1,4,8,0],[0,4,7,3],2]',
    '[0,4,5,6]': '[0,4,6,3]',
    '[0,4,6,6]': '[0,4,7,3]',
    '[4,4,5,7]': '[4,4,6,3]',
    '[4,4,6,7]': '[4,4,7,3]',
    '[1,4,6,0,,"beta",0]': '[1,4,6,3]',
    '[1,4,6,0,,"beta",1]': '[1,4,6,3]',
    '[1,4,6,1]': '[1,4,6,3]',
    '[1,4,7,0,,"beta",0]': '[1,4,7,3]',
    '[1,4,7,0,,"beta",1]': '[1,4,7,3]',
    '[1,4,7,1]': '[1,4,7,3]',
    '[1,6,6,0,,"beta",0]': '[1,6,6,3]',
    '[1,6,6,0,,"beta",1]': '[1,6,6,3]',
    '[1,6,6,1]': '[1,6,6,3]',
    '[1,7,6,0,,"beta",0]': '[1,7,6,3]',
    '[1,7,6,0,,"beta",1]': '[1,7,6,3]',
}

startup_log_replacements = {
    "console.debug('[xeus-startup]', payload);": '',
    "console.warn('[xeus-startup] failed to capture session-attached snapshot', error);": '',
}

def replace_text(path: Path, replacements: dict[str, str]) -> bool:
    if not path.exists():
        return False
    original = path.read_text(encoding='utf-8')
    updated = original
    for old, new in replacements.items():
        updated = updated.replace(old, new)
    if updated != original:
        path.write_text(updated, encoding='utf-8')
        return True
    return False

def transform(value):
    if isinstance(value, dict):
        return {k: transform(v) for k, v in value.items()}
    if isinstance(value, list):
        return [transform(v) for v in value]
    if isinstance(value, str):
        return normalized_required_versions.get(value, value)
    return value

def rewrite_build_log(path: Path) -> bool:
    if not path.exists():
        return False

    original = json.loads(path.read_text(encoding='utf-8'))
    updated = transform(original)
    if updated != original:
        path.write_text(json.dumps(updated, indent=2), encoding='utf-8')
        return True
    return False

patched_paths: list[str] = []

for package_json in sorted(labextensions_root.rglob('package.json')):
    labextension_dir = package_json.parent
    static_dir = labextension_dir / 'static'
    build_log_json = labextension_dir / 'build_log.json'

    package_data = json.loads(package_json.read_text(encoding='utf-8'))
    original_package_data = package_data
    package_data = transform(package_data)
    deps = package_data.get('dependencies', {})
    for name, version in stable_dependency_versions.items():
        if name in deps:
            deps[name] = version
    shared_packages = package_data.get('jupyterlab', {}).get('sharedPackages', {})
    for name, config in shared_packages.items():
        if name in stable_dependency_versions:
            config['requiredVersion'] = stable_dependency_versions[name]
        elif isinstance(config, dict) and isinstance(config.get('requiredVersion'), str):
            config['requiredVersion'] = normalized_required_versions.get(
                config['requiredVersion'], config['requiredVersion']
            )
    if package_data != original_package_data:
        package_json.write_text(json.dumps(package_data, indent=2) + '\n', encoding='utf-8')
        patched_paths.append(str(package_json))

    if rewrite_build_log(build_log_json):
        patched_paths.append(str(build_log_json))

    if static_dir.exists():
        for js_file in sorted(static_dir.glob('*.js')):
            touched = False
            if replace_text(js_file, module_federation_version_arrays):
                touched = True
            if replace_text(js_file, normalized_required_versions):
                touched = True
            if replace_text(js_file, startup_log_replacements):
                touched = True
            if touched:
                patched_paths.append(str(js_file))
    else:
        print(f'  ⚠ Labextension static dir not found: {static_dir}')

if patched_paths:
    print('  ✓ Patched labextension federation assets:')
    for path in patched_paths:
        print(f'    - {path}')
else:
    print('  ✓ Labextension federation assets already normalized')
EOFPATCH

  echo "Built-in wheels installation completed"

  if [ -f "$KERNEL_WHEEL_DIR/kernel-bundle-manifest.json" ]; then
    UPDATED_WHEEL_VERSION=$(python3 -c "
import json, pathlib
m = json.loads(pathlib.Path('$KERNEL_WHEEL_DIR/kernel-bundle-manifest.json').read_text())
print(m.get('producer', {}).get('commit', 'unknown')[:12])
" 2>/dev/null || echo 'unknown')
    echo "  ✓ Refreshed wheel payload now at commit ${UPDATED_WHEEL_VERSION}"
  fi

  WHEEL_KERNEL_JS_SHA256="$(extract_kernel_manifest_field "$WHEEL_MANIFEST_PATH" 'artifacts.kernelJS.sha256')"
  WHEEL_KERNEL_WASM_SHA256="$(extract_kernel_manifest_field "$WHEEL_MANIFEST_PATH" 'artifacts.kernelWASM.sha256')"
  WHEEL_AI_AGENTS_DIGEST="$(extract_kernel_manifest_field "$WHEEL_MANIFEST_PATH" 'artifacts.aiAgents.digestSha256')"

  if [ -n "$WHEEL_KERNEL_JS_SHA256" ] && [ -n "$WHEEL_KERNEL_WASM_SHA256" ]; then
    echo "  ✓ Wheel manifest kernelJS sha256   = $WHEEL_KERNEL_JS_SHA256"
    echo "  ✓ Wheel manifest kernelWASM sha256 = $WHEEL_KERNEL_WASM_SHA256"
  fi
  if [ -n "$WHEEL_AI_AGENTS_DIGEST" ]; then
    echo "  ✓ Wheel manifest aiAgents digest   = $WHEEL_AI_AGENTS_DIGEST"
  fi

  sync_kernel_runtime_from_wheel "$KERNEL_WHEEL_DIR"

  if [ -n "$WHEEL_KERNEL_JS_SHA256" ]; then
    INSTALLED_WHEEL_JS_SHA256="$(sha256sum "$KERNEL_WHEEL_DIR/bin/xpython.js" | awk '{print $1}')"
    if [ "$INSTALLED_WHEEL_JS_SHA256" != "$WHEEL_KERNEL_JS_SHA256" ]; then
      echo "WARNING: Installed wheel xpython.js does not match kernel-bundle-manifest.json" >&2
      echo "  actual:   $INSTALLED_WHEEL_JS_SHA256" >&2
      echo "  expected: $WHEEL_KERNEL_JS_SHA256" >&2
      echo "  continuing with installed payload hash as the source of truth" >&2
      WHEEL_KERNEL_JS_SHA256="$INSTALLED_WHEEL_JS_SHA256"
    fi
  fi
  if [ -n "$WHEEL_KERNEL_WASM_SHA256" ]; then
    INSTALLED_WHEEL_WASM_SHA256="$(sha256sum "$KERNEL_WHEEL_DIR/bin/xpython.wasm" | awk '{print $1}')"
    if [ "$INSTALLED_WHEEL_WASM_SHA256" != "$WHEEL_KERNEL_WASM_SHA256" ]; then
      echo "ERROR: Installed wheel xpython.wasm does not match kernel-bundle-manifest.json" >&2
      echo "  actual:   $INSTALLED_WHEEL_WASM_SHA256" >&2
      echo "  expected: $WHEEL_KERNEL_WASM_SHA256" >&2
      exit 1
    fi
  fi

  # Re-resolve AI agents now that the wheel is installed.
  # In auto mode, try the standalone package before the embedded payload.
  AI_AGENTS_SOURCE_BUILD=""
  AI_AGENTS_SOURCE_KIND="missing"
  AI_AGENTS_FALLBACK_TO_WHEEL="false"

  # Build the candidate list from the configured public source policy.
  CANDIDATES=()
  case "$AI_AGENTS_SOURCE_POLICY" in
    standalone)
      CANDIDATES+=("$AI_AGENTS_SOURCE_STANDALONE:standalone")
      ;;
    wheel)
      CANDIDATES+=("$AI_AGENTS_SOURCE_WHEEL:wheel")
      ;;
    auto)
      CANDIDATES+=("$AI_AGENTS_SOURCE_STANDALONE:standalone")
      CANDIDATES+=("$AI_AGENTS_SOURCE_WHEEL:wheel")
      ;;
  esac

  VALID_CANDIDATES=()
  for candidate in "${CANDIDATES[@]}"; do
    cand_dir="${candidate%%:*}"
    if [ -d "$cand_dir" ] && [ -f "$cand_dir/bundle.js" ]; then
      VALID_CANDIDATES+=("$candidate")
    fi
  done
  CANDIDATES=("${VALID_CANDIDATES[@]}")

  # Try each candidate until one passes verification
  for candidate in "${CANDIDATES[@]}"; do
    cand_dir="${candidate%%:*}"
    cand_kind="${candidate##*:}"

    if check_ai_agents_source_matches_wheel_manifest "$cand_dir" "$KERNEL_WHEEL_DIR"; then
      AI_AGENTS_SOURCE_BUILD="$cand_dir"
      AI_AGENTS_SOURCE_KIND="$cand_kind"
      break
    fi
  done

  # If no candidate passed (shouldn't happen with auto-pass patterns above),
  # fall back to the old resolve+verify logic
  if [ -z "$AI_AGENTS_SOURCE_BUILD" ]; then
    AI_AGENTS_SOURCE_BUILD="$(resolve_ai_agents_source_dir "$AI_AGENTS_SOURCE_STANDALONE" "$AI_AGENTS_SOURCE_WHEEL")"
    AI_AGENTS_SOURCE_KIND="$(ai_agents_source_kind "$AI_AGENTS_SOURCE_BUILD" "$AI_AGENTS_SOURCE_STANDALONE" "$AI_AGENTS_SOURCE_WHEEL")"
    if ! verify_ai_agents_source_matches_wheel_manifest "$AI_AGENTS_SOURCE_BUILD" "$KERNEL_WHEEL_DIR" "$AI_AGENTS_SOURCE_KIND"; then
      if [ "$AI_AGENTS_SOURCE_POLICY" = "auto" ] \
        && [ "$AI_AGENTS_SOURCE_BUILD" != "$AI_AGENTS_SOURCE_WHEEL" ] \
        && ai_agents_bundle_dir_exists "$AI_AGENTS_SOURCE_WHEEL"; then
        echo "  ⚠ Preferred AI agents source does not match installed kernel wheel; falling back to wheel payload"
        AI_AGENTS_SOURCE_BUILD="$AI_AGENTS_SOURCE_WHEEL"
        AI_AGENTS_SOURCE_KIND="wheel"
        AI_AGENTS_FALLBACK_TO_WHEEL="true"
        verify_ai_agents_source_matches_wheel_manifest "$AI_AGENTS_SOURCE_BUILD" "$KERNEL_WHEEL_DIR" "$AI_AGENTS_SOURCE_KIND" || exit 1
      else
        exit 1
      fi
    fi
  fi
  if ai_agents_bundle_dir_exists "$AI_AGENTS_SOURCE_BUILD"; then
    verify_ai_agents_output_toggle_support "$AI_AGENTS_SOURCE_BUILD/bundle.js"
    echo "  ✓ Using AI agents bundle from: $AI_AGENTS_SOURCE_BUILD"
    echo "    Policy: $AI_AGENTS_SOURCE_POLICY"
    echo "    Kind: $AI_AGENTS_SOURCE_KIND"
    echo "    Digest matches wheel: $AI_AGENTS_DIGEST_MATCHES_WHEEL"
    echo "    Fallback to wheel: $AI_AGENTS_FALLBACK_TO_WHEEL"
    echo "    Marker: $(extract_ai_agents_bundle_marker "$AI_AGENTS_SOURCE_BUILD/bundle.js")"
  else
    AI_AGENTS_SOURCE_KIND="missing"
    echo "  ⚠ AI agents bundle not found in the installed wheels"
  fi
else
  echo "No built-in-wheels directory found, skipping built-in wheels installation"
fi

# Install after the selected wheels are refreshed so incremental builds package
# the Hera source shipped by the current kernel wheel.
install_hera_from_wheel

# ==============================================================================
# Clean stray JupyterLab extension artifacts
# ==============================================================================
echo "Removing the unused Pyodide kernel from reused build environments..."
mamba_run_deploy python -m pip uninstall --root-user-action=ignore -y jupyterlite-pyodide-kernel

echo "Cleaning stray JupyterLab extension artifacts (if any)..."
LABEXT_DIR="$DEPLOY_PREFIX/share/jupyter/labextensions"
if [ -d "$LABEXT_DIR/@jupyterlite" ]; then
  for d in "$LABEXT_DIR/@jupyterlite/"~*; do
    if [ -e "$d" ]; then
      echo "  Removing stray labextension: $d"
      rm -rf "$d"
    fi
  done
fi

SITE_PACKAGES_DIR=$(mamba_run_deploy python3 -c "import sys, os; print(os.path.join(sys.prefix, 'lib', f'python{sys.version_info.major}.{sys.version_info.minor}', 'site-packages'))" 2>/dev/null || echo "$DEPLOY_PREFIX/lib/python3.13/site-packages")
if [ -d "$SITE_PACKAGES_DIR" ]; then
  for d in "$SITE_PACKAGES_DIR/"~*jupyterlite_xeus*; do
    if [ -e "$d" ]; then
      echo "  Removing stray site-packages entry: $d"
      rm -rf "$d"
    fi
  done
fi

# ==============================================================================
# Build JupyterLite
# ==============================================================================
echo "Cleaning up old build output..."
rm -rf _output dist

LITE_BUILD_DIR="$PWD/temp/jupyterlite-lite-dir"
rm -rf "$LITE_BUILD_DIR"
mkdir -p "$LITE_BUILD_DIR"

# Keep the lite dir minimal so JupyterLite doesn't recursively scan the full
# repo tree (micromamba envs, vendored bundles, nested dist dirs) for
# jupyter-lite config files before its ignore filters can apply.
for lite_file in jupyter-lite.json overrides.json jupyter_lite_config.json; do
  if [ -f "$lite_file" ]; then
    cp -f "$lite_file" "$LITE_BUILD_DIR/$lite_file"
  fi
done

# Validate notebook fallback settings against the published JupyterLite
# contents layout before building. build.sh serves notebooks/ at the root,
# so values like "00_agent_features.ipynb" are valid while
# "notebooks/00_agent_features.ipynb" are not.
python3 "$PWD/scripts/verify-startup-notebook.py"

JUPYTER_LITE_BUILD_ARGS=(
  --lite-dir "$LITE_BUILD_DIR"
  --XeusAddon.prefix="$PREFIX"
  --contents "$PWD/notebooks/"
  --extra-ignore-contents '/\.agents/'
  --extra-ignore-contents '/test/'
  --extra-ignore-contents '/data/'
  --ContentsManager.allow_hidden=True
  --output-dir "$PWD/dist"
)

# Build JupyterLite directly from the installed wheel payload.
unset JUPYTERLITE_SKIP_XEUS_PACK || true

if [ -f "$PWD/jupyter_lite_config.json" ]; then
  JUPYTER_LITE_BUILD_ARGS+=(--config "$PWD/jupyter_lite_config.json")
fi

echo "Building JupyterLite..."
(
  # JupyterLite's timestamp traversal includes the repository's package caches.
  unset SOURCE_DATE_EPOCH
  mamba_run_deploy jupyter lite build "${JUPYTER_LITE_BUILD_ARGS[@]}"
)
rm -rf "$PWD/dist/extensions/@jupyterlite/pyodide-kernel-extension"

# JupyterLite 0.8.3 embeds the upstream JupyterLab security fixes.

# JupyterLite flattens jupyter-config-data into top-level keys in dist/*/jupyter-lite.json,
# but unknown custom keys such as xeus pooling options may be dropped during build.
# Reapply the explicit source config so PageConfig.getOption(...) sees the intended runtime values,
# and normalize per-app asset paths so federated labextensions load consistently.
echo "Restoring custom runtime config into built jupyter-lite.json files..."
python3 << 'EOFPATCH'
import json
from pathlib import Path

source_path = Path('temp/jupyterlite-lite-dir/jupyter-lite.json')
if not source_path.exists():
    print(f"  ⚠ {source_path} not found - skipping runtime config restore")
    raise SystemExit(0)

source_data = json.loads(source_path.read_text(encoding='utf-8'))
source_config = source_data.get('jupyter-config-data', {})
preserved_top_level = {
    key: value
    for key, value in source_config.items()
  if key.startswith('xeus')
  or key in {'appName', 'defaultKernelName', 'exposeAppInBrowser', 'enableServiceWorkerCache'}
}

root_target = Path('dist/jupyter-lite.json')
app_target_paths = sorted(Path('dist').glob('*/jupyter-lite.json'))
patched = 0


def patch_json(path, app_name=None):
    data = json.loads(path.read_text(encoding='utf-8'))
    changed = False

    for key, value in preserved_top_level.items():
        if data.get(key) != value:
            data[key] = value
            changed = True

    config = data.setdefault('jupyter-config-data', {})

    for container in (data, config):
        extensions = container.get('federated_extensions')
        if extensions is not None:
            retained = [
                extension for extension in extensions
                if extension.get('name') != '@jupyterlite/pyodide-kernel-extension'
            ]
            if retained != extensions:
                container['federated_extensions'] = retained
                changed = True

    for key in ('appName', 'defaultKernelName', 'enableServiceWorkerCache'):
      value = source_config.get(key)
      if value is not None and config.get(key) != value:
        config[key] = value
        changed = True

    if app_name is None:
        root_defaults = {
            'appUrl': source_config.get('appUrl', './lab'),
            'fullStaticUrl': './build',
            'fullLabextensionsUrl': './extensions',
        }
        for key, value in root_defaults.items():
            if value is not None and config.get(key) != value:
                config[key] = value
                changed = True
    else:
        desired = {
            'appUrl': f'/{app_name}',
            'baseUrl': '../',
            'fullStaticUrl': '../build',
            'fullLabextensionsUrl': '../extensions',
        }
        for key, value in desired.items():
            if config.get(key) != value:
                config[key] = value
                changed = True

        favicon_path = path.parent / 'favicon.ico'
        if favicon_path.exists() and config.get('faviconUrl') != './favicon.ico':
            config['faviconUrl'] = './favicon.ico'
            changed = True

        licenses_url = config.get('licensesUrl')
        desired_licenses = './api/licenses' if app_name == 'lab' else '../lab/api/licenses'
        if isinstance(licenses_url, str) and licenses_url.startswith('./') and licenses_url != desired_licenses:
            config['licensesUrl'] = desired_licenses
            changed = True

    if changed:
        path.write_text(
            json.dumps(data, indent=2) + '\n',
            encoding='utf-8'
        )
    return changed


if root_target.exists() and patch_json(root_target):
    patched += 1

for target_path in app_target_paths:
    if patch_json(target_path, app_name=target_path.parent.name):
        patched += 1

print(f"  ✓ Restored runtime config in {patched} jupyter-lite.json file(s)")
EOFPATCH

# Work around intermittent jupyter_server schema resolution issues when the
# data/ folder is indexed via the ContentsAddon. We copy it in after build.
if [ -d "$PWD/notebooks/data" ]; then
  mkdir -p "$PWD/dist/files/data"
  cp -a "$PWD/notebooks/data/." "$PWD/dist/files/data/"
  # Update the contents index so the file browser can see the data/ folder.
  # JupyterLite needs:
  #   - root all.json: contains only direct children (the data/ directory entry)
  #   - api/contents/data/all.json: the per-directory listing for data/
  mamba_run_deploy python3 - <<'PYEOF'
import json
from datetime import datetime, timezone
import os
from pathlib import Path

data_dir = Path("dist/files/data")
root_all_json = Path("dist/api/contents/all.json")
data_all_json = Path("dist/api/contents/data/all.json")
now = datetime.fromtimestamp(int(os.environ["SOURCE_DATE_EPOCH"]), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")

# Fix root all.json: keep only direct children (no '/' in path)
with open(root_all_json) as f:
    root = json.load(f)

root["content"] = [e for e in root["content"] if "/" not in e["path"]]

# Ensure the data directory entry exists at root
if not any(e["path"] == "data" for e in root["content"]):
    root["content"].append({
        "content": None,
        "created": now,
        "format": None,
        "hash": None,
        "hash_algorithm": None,
        "last_modified": now,
        "mimetype": None,
        "name": "data",
        "path": "data",
        "size": None,
        "type": "directory",
        "writable": True,
    })

with open(root_all_json, "w") as f:
    json.dump(root, f, indent=1)
print(f"  Root all.json: {len(root['content'])} entries")

# Create api/contents/data/all.json with the data files
data_files = []
for fp in sorted(data_dir.iterdir()):
    if fp.is_file():
        stat = fp.stat()
        mimetype = "text/plain" if fp.suffix in (".txt", ".csv", ".tsv", ".data") else None
        data_files.append({
            "content": None,
            "created": now,
            "format": None,
            "hash": None,
            "hash_algorithm": None,
            "last_modified": now,
            "mimetype": mimetype,
            "name": fp.name,
            "path": f"data/{fp.name}",
            "size": stat.st_size,
            "type": "file",
            "writable": True,
        })

data_listing = {
    "content": data_files,
    "created": now,
    "format": "json",
    "hash": None,
    "hash_algorithm": None,
    "last_modified": now,
    "mimetype": None,
    "name": "data",
    "path": "data",
    "size": None,
    "type": "directory",
    "writable": True,
}

data_all_json.parent.mkdir(parents=True, exist_ok=True)
with open(data_all_json, "w") as f:
    json.dump(data_listing, f, indent=1)
print(f"  data/all.json: {len(data_files)} file entries")
PYEOF
fi

# Ensure kernels.json exists (fallback if XeusAddon produced it in a temp dir
# but the copy task didn't land it in the expected location)
if [ ! -f "dist/xeus/kernels.json" ]; then
  echo "  ⚠ dist/xeus/kernels.json missing after build, generating fallback..."
  mkdir -p dist/xeus
  ENV_NAME=$(basename "$PREFIX")
  mamba_run_deploy python3 -c "
import json, sys
from pathlib import Path
prefix = Path('$PREFIX')
kernels_dir = prefix / 'share' / 'jupyter' / 'kernels'
all_kernels = []
env_name = '$ENV_NAME'
if kernels_dir.is_dir():
    for kernel_dir in sorted(kernels_dir.iterdir()):
        kernel_json_path = kernel_dir / 'kernel.json'
        if kernel_json_path.exists():
            with open(kernel_json_path) as f:
                spec = json.load(f)
            all_kernels.append({'kernel': kernel_dir.name, 'env_name': env_name})
print(json.dumps(all_kernels))
" > dist/xeus/kernels.json
  echo "  ✓ Generated fallback dist/xeus/kernels.json: $(cat dist/xeus/kernels.json)"
fi

PACKED_ENV_DIR="dist/xeus/xeus-python-wasm-host"
PACKED_ENV_PACKAGES_DIR="$PACKED_ENV_DIR/kernel_packages"
PACKED_ENV_META="$PACKED_ENV_DIR/empack_env_meta.json"
mkdir -p "$PACKED_ENV_PACKAGES_DIR"
PACKED_NON_HERA_COUNT=$(find "$PACKED_ENV_PACKAGES_DIR" -maxdepth 1 -type f -name '*.tar.gz' ! -name 'r-hera-*.tar.gz' 2>/dev/null | wc -l)

if [ ! -f "$PACKED_ENV_META" ] || [ "$PACKED_NON_HERA_COUNT" -eq 0 ]; then
  echo "  ⚠ Packed xeus environment missing after build, generating fallback..."
  mkdir -p "$PACKED_ENV_PACKAGES_DIR"
  mamba_run_deploy python3 - <<EOF
import json
import os
import shutil
import tempfile
from pathlib import Path

import yaml

from empack.file_patterns import PkgFileFilter, pkg_file_filter_from_yaml
from empack.pack import DEFAULT_CONFIG_PATH, pack_env

prefix = Path("$PREFIX")
out_dir = Path("$PWD") / "$PACKED_ENV_DIR"
packages_dir = out_dir / "kernel_packages"
env_meta_path = out_dir / "empack_env_meta.json"
env_file = Path("$PWD") / "environment-wasm-host.yml"
tmp_dir = Path(tempfile.mkdtemp(prefix="empack-fallback-"))

pack_kwargs = {}
config_path = DEFAULT_CONFIG_PATH
if config_path is None:
    xdg_data_home = Path(
        os.environ.get("XDG_DATA_HOME", os.path.join(Path.home(), ".local", "share"))
    )
    xdg_config_path = xdg_data_home / "empack" / "empack_config.yaml"
    if xdg_config_path.exists():
        config_path = xdg_config_path

if config_path is not None:
    pack_kwargs["file_filters"] = pkg_file_filter_from_yaml(config_path)
else:
    pack_kwargs["file_filters"] = PkgFileFilter()

pack_env(
    env_prefix=prefix,
    relocate_prefix='/',
    outdir=tmp_dir,
    use_cache=False,
    **pack_kwargs,
)

for tarball in tmp_dir.glob('*.tar.gz'):
    shutil.copy2(tarball, packages_dir / tarball.name)

if (tmp_dir / 'empack_env_meta.json').exists():
    meta = json.loads((tmp_dir / 'empack_env_meta.json').read_text())
else:
    meta = {}

specs = []
channels = []
if env_file.exists():
    env_data = yaml.safe_load(env_file.read_text()) or {}
    channels = env_data.get('channels', []) or []
    for item in env_data.get('dependencies', []) or []:
        if isinstance(item, str):
            specs.append(item)

meta.update({"specs": specs, "channels": channels})
env_meta_path.write_text(json.dumps(meta, indent=2) + "\n")

shutil.rmtree(tmp_dir)
EOF
  echo "  ✓ Generated packed xeus environment fallback"
fi

if [ -f "$QUAK_PATCHER" ]; then
  QUAK_TARBALLS=()
  packed_quak_tarballs="$(find "$PACKED_ENV_PACKAGES_DIR" -maxdepth 1 -type f -name 'quak-*.tar.gz' 2>/dev/null | sort)"
  while IFS= read -r quak_tarball; do
    [[ -z "$quak_tarball" ]] && continue
    QUAK_TARBALLS+=("$quak_tarball")
  done <<< "$packed_quak_tarballs"

  if [ "${#QUAK_TARBALLS[@]}" -gt 0 ]; then
    echo "🔧 Patching packed quak kernel packages..."
    python3 "$QUAK_PATCHER" "${QUAK_TARBALLS[@]}"
  else
    echo "  Info: No packed Quak kernel package; on-demand Quak archives will be patched when publishing"
  fi
fi

# ==============================================================================
# Copy xpython WASM files to kernel directory
# ==============================================================================
echo "Copying xpython WASM files to kernel directory..."
mkdir -p dist/xeus/xeus-python-wasm-host
cp -v $KERNEL_WHEEL_DIR/bin/xpython.js dist/xeus/xeus-python-wasm-host/xpython.js
cp -v $KERNEL_WHEEL_DIR/bin/xpython.wasm dist/xeus/xeus-python-wasm-host/xpython.wasm

mkdir -p dist/xeus/xeus-python-wasm-host/bin
cp -v $KERNEL_WHEEL_DIR/bin/xpython.js dist/xeus/xeus-python-wasm-host/bin/xpython.js
cp -v $KERNEL_WHEEL_DIR/bin/xpython.wasm dist/xeus/xeus-python-wasm-host/bin/xpython.wasm

echo "Copying deployed kernel spec..."
DIST_KERNEL_SPEC_DIR="dist/xeus/xeus-python-wasm-host/xpython"
mkdir -p "$DIST_KERNEL_SPEC_DIR"
cp -v "$KERNEL_SPEC_DIR/kernel.json" "$DIST_KERNEL_SPEC_DIR/kernel.json"
for logo in logo-32x32.png logo-64x64.png logo-svg.svg; do
  if [ -f "$KERNEL_SPEC_DIR/$logo" ]; then
    cp -v "$KERNEL_SPEC_DIR/$logo" "$DIST_KERNEL_SPEC_DIR/$logo"
  fi
done

echo "Rewriting deployed kernel spec for xeus runtime..."
mamba_run_deploy python3 - <<EOF
import json
from pathlib import Path

kernel_spec_dir = Path('${REPO_ROOT}/dist/xeus/xeus-python-wasm-host/xpython')
kernel_json_path = kernel_spec_dir / 'kernel.json'

with kernel_json_path.open() as f:
    kernel_spec = json.load(f)

kernel_spec['argv'][0] = 'xeus/xeus-python-wasm-host/bin/xpython.js'
kernel_spec['resources'] = {}

for logo_name in ('logo-32x32.png', 'logo-64x64.png', 'logo-svg.svg'):
    logo_path = kernel_spec_dir / logo_name
    if logo_path.exists():
        kernel_spec['resources'][logo_path.stem] = (
            f'xeus/xeus-python-wasm-host/xpython/{logo_name}'
        )

with kernel_json_path.open('w') as f:
    json.dump(kernel_spec, f)
EOF

# ==============================================================================
# Copy all WASM side modules to host directory
# ==============================================================================
echo "Copying WASM side modules to WASM host directory..."
HOST_WASM_DIR="dist/xeus/xeus-python-wasm-host"
HOST_WASM_BIN_DIR="$HOST_WASM_DIR/bin"

copy_wasm_side_module() {
  local source_path="$1"
  if [ -f "$source_path" ]; then
    local basename_so
    basename_so=$(basename "$source_path")
    cp -v "$source_path" "$HOST_WASM_DIR/$basename_so"
    cp -v "$source_path" "$HOST_WASM_BIN_DIR/$basename_so"
    return 0
  fi
  return 1
}

host_top_level_shared_libs=0
while IFS= read -r shared_lib_path; do
  [[ -z "$shared_lib_path" ]] && continue
  if copy_wasm_side_module "$shared_lib_path"; then
    host_top_level_shared_libs=$((host_top_level_shared_libs + 1))
  fi
done <<< "$(find "$PREFIX/lib" -maxdepth 1 -name '*.so*' | sort)"

host_r_core_shared_libs=0
for so_file in "$PREFIX/lib/R/lib/libR.so" "$PREFIX/lib/R/lib/libRblas.so" "$PREFIX/lib/R/lib/libRlapack.so"; do
  if copy_wasm_side_module "$so_file"; then
    host_r_core_shared_libs=$((host_r_core_shared_libs + 1))
  fi
done

host_r_module_shared_libs=0
R_MODULE_LIB_DIR="$PREFIX/lib/R/modules"
if [ -d "$R_MODULE_LIB_DIR" ]; then
  while IFS= read -r module_so_path; do
    [[ -z "$module_so_path" ]] && continue
    if copy_wasm_side_module "$module_so_path"; then
      host_r_module_shared_libs=$((host_r_module_shared_libs + 1))
    fi
  done <<< "$(find "$R_MODULE_LIB_DIR" -maxdepth 1 -name '*.so*' | sort)"
fi

host_r_package_shared_libs=0
R_PACKAGE_LIB_DIR="$PREFIX/lib/R/library"
if [ -d "$R_PACKAGE_LIB_DIR" ]; then
  while IFS= read -r package_so_path; do
    [[ -z "$package_so_path" ]] && continue
    if copy_wasm_side_module "$package_so_path"; then
      host_r_package_shared_libs=$((host_r_package_shared_libs + 1))
    fi
  done <<< "$(find "$R_PACKAGE_LIB_DIR" -path '*/libs/*.so' -type f | sort)"
fi

# Copy Python site-packages shared libraries (non-cpython-ABI .so files).
# These are WASM side modules loaded via dlopen at runtime (e.g. _duckdb.so,
# speedups.abi3.so). They are NOT Python extension modules (those have the
# .cpython-NNN-wasm32-emscripten.so suffix and are loaded from the FS).
# The xeus worker's locateFile maps their basenames to kernelRootUrl/<name>.so,
# so they must be present in the WASM host directory for HTTP serving.
WASM_PYTHON_VER=$(ls "$PREFIX/lib/" 2>/dev/null | grep "^python3\." | head -1)
host_python_shared_libs=0
if [ -n "$WASM_PYTHON_VER" ]; then
  PYTHON_SITE_PACKAGES_DIR="$PREFIX/lib/$WASM_PYTHON_VER/site-packages"
  if [ -d "$PYTHON_SITE_PACKAGES_DIR" ]; then
    while IFS= read -r python_so_path; do
      [[ -z "$python_so_path" ]] && continue
      if copy_wasm_side_module "$python_so_path"; then
        host_python_shared_libs=$((host_python_shared_libs + 1))
      fi
    done <<< "$(find "$PYTHON_SITE_PACKAGES_DIR" -name "*.so" ! -name "*.cpython-*" -type f | sort)"
  fi
fi

echo "  ✓ Copied $host_top_level_shared_libs top-level shared libraries to WASM host directory"
echo "  ✓ Copied $host_r_core_shared_libs core R shared libraries to WASM host directory"
echo "  ✓ Copied $host_r_module_shared_libs R module shared libraries to WASM host directory"
echo "  ✓ Copied $host_r_package_shared_libs R package shared libraries to WASM host directory"
echo "  ✓ Copied $host_python_shared_libs Python site-packages shared libraries to WASM host directory"

# Copy auto-fix UI assets
echo "Copying auto-fix UI assets..."
mkdir -p dist/third_party
if [ -f "third_party/fixing.gif" ]; then
  cp -v third_party/fixing.gif dist/third_party/fixing.gif
  echo "  ✓ Copied fixing.gif"
else
  echo "  ⚠ third_party/fixing.gif not found"
fi

# ==============================================================================
# Patch embind to ignore duplicate type registrations
# ==============================================================================
echo "🔧 Patching embind to ignore duplicate type registrations..."
PATCH_PATTERN="throwBindingError(\`Cannot register type '\${name}' twice\`)"
PATCH_REPLACEMENT='s/else\{throwBindingError\(\`Cannot register type '"'"'\$\{name\}'"'"' twice\`\)\}/else{return}/g'

XPYTHON_JS_FILES=(
  "$PREFIX/bin/xpython.js"
  "$KERNEL_SPEC_DIR/xpython.js"
  "dist/xeus/xeus-python-wasm-host/xpython.js"
  "dist/xeus/xeus-python-wasm-host/bin/xpython.js"
)

for XPYTHON_JS in "${XPYTHON_JS_FILES[@]}"; do
  if [ -f "$XPYTHON_JS" ]; then
    if grep -qF "$PATCH_PATTERN" "$XPYTHON_JS"; then
      LC_ALL=C perl -i -pe "$PATCH_REPLACEMENT" "$XPYTHON_JS"
      if ! grep -qF "$PATCH_PATTERN" "$XPYTHON_JS"; then
        echo "  ✓ Patched sharedRegisterType() in $XPYTHON_JS"
      else
        echo "  ⚠ Patch may have failed for $XPYTHON_JS"
      fi
    else
      echo "  ✓ Already patched or pattern not found in $XPYTHON_JS"
    fi
  else
    echo "  ⚠ xpython.js not found at $XPYTHON_JS"
  fi
done

# ===============================================================================
# Preserve the deployment root when loading AI agents metadata
# ===============================================================================
echo "Patching xpython AI agents metadata root resolution..."
for XPYTHON_JS in "${XPYTHON_JS_FILES[@]}"; do
  if [ -f "$XPYTHON_JS" ]; then
    if node - "$XPYTHON_JS" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
let source = fs.readFileSync(path, "utf8");
const marker = "/* datax-now-ai-agents-root-v1 */";
const original =
  'if(markerIndex>=0){parsed.pathname=parsed.pathname.slice(0,markerIndex+1);parsed.search="";parsed.hash="";addRoot(parsed.toString())}}catch(_){}}';
const replacement =
  'if(markerIndex>=0){parsed.pathname=parsed.pathname.slice(0,markerIndex+1);parsed.search="";parsed.hash="";addRoot(parsed.toString())}else{parsed.search="";parsed.hash="";addRoot(parsed.toString())}}catch(_){}}';

if (!source.includes(marker)) {
  if (!source.includes(original)) {
    throw new Error(`Could not find AI agents metadata root resolver in ${path}`);
  }
  source = source.replace(original, `${marker}${replacement}`);
  fs.writeFileSync(path, source);
  console.log(`  ✓ Preserved AI agents metadata root in ${path}`);
} else {
  console.log(`  ✓ AI agents metadata root patch already present in ${path}`);
}
NODE
    then
      :
    else
      echo "ERROR: AI agents metadata root patch failed for $XPYTHON_JS" >&2
      exit 1
    fi
  else
    echo "ERROR: xpython.js not found at $XPYTHON_JS" >&2
    exit 1
  fi
done

# ==============================================================================
echo "Patching variable inspector cold-start refresh..."
python3 <<'EOFVI'
from pathlib import Path
import re

bootstrap = (
  'if(globalThis.__datax_vi_refresh_pending&&'
  'typeof globalThis._call_get_variables!=="function"&&'
  'typeof globalThis.Module?._refresh_variable_inspector_cache==="function")'
  '{globalThis.Module._refresh_variable_inspector_cache();}'
)
workers = list(Path('dist/extensions/@jupyterlite/xeus-extension/static').glob('*.worker.*.js'))
patched = 0
for worker in workers:
  source = worker.read_text()
  if '.getVariables=' not in source:
    continue
  if bootstrap not in source:
    source, count = re.subn(
      r'(\.getVariables=async\s*(?:[\w$]+|\([^)]*\))\s*=>\s*\{try\{)',
      lambda match: match.group(1) + bootstrap,
      source,
    )
    if count != 1:
      raise SystemExit(f'Error: Could not patch variable inspector startup in {worker}')
    worker.write_text(source)
  patched += 1
if not patched:
  raise SystemExit('Error: No variable inspector worker found')
print(f'  Patched variable inspector startup in {patched} worker(s)')
EOFVI

# Patch xpython variable sync helpers to avoid re-entrant cross-language sync
# ==============================================================================
echo "🔧 Patching xpython variable sync re-entrancy guards..."
for XPYTHON_JS in "${XPYTHON_JS_FILES[@]}"; do
  if [ -f "$XPYTHON_JS" ]; then
    if node - "$XPYTHON_JS" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
let source = fs.readFileSync(path, "utf8");

function replaceOnce(from, to, description) {
  if (!source.includes(from)) {
    return false;
  }
  source = source.replace(from, to);
  return true;
}

function replaceAll(from, to) {
  if (!source.includes(from)) {
    return 0;
  }
  const parts = source.split(from);
  const count = parts.length - 1;
  source = parts.join(to);
  return count;
}

if (!source.includes("Module._withSyncGuard=function(")) {
  replaceOnce(
    'Module._get_all_variables=function(){try{const merged={};',
    'Module._xeusSyncGuardState=Module._xeusSyncGuardState||{depth:0,stack:[]};Module._withSyncGuard=function(label,fallback,fn){const state=Module._xeusSyncGuardState||(Module._xeusSyncGuardState={depth:0,stack:[]});const safeConsole=Module.originalConsole||console;if(state.depth>0){if(safeConsole&&typeof safeConsole.warn==="function"){safeConsole.warn(`[xeus-x][sync] skip reentrant ${label}; active=${state.stack[state.stack.length-1]||"unknown"} depth=${state.depth}`)}return typeof fallback==="function"?fallback():fallback}state.depth+=1;state.stack.push(label);if(safeConsole&&typeof safeConsole.log==="function"){safeConsole.log(`[xeus-x][sync] begin ${label}; depth=${state.depth}`)}try{return fn()}finally{const finished=state.stack.pop()||label;state.depth=Math.max(0,state.depth-1);if(safeConsole&&typeof safeConsole.log==="function"){safeConsole.log(`[xeus-x][sync] end ${finished}; depth=${state.depth}`)}}};Module._get_all_variables=function(){return Module._withSyncGuard("_get_all_variables",function(){return Object.create(null)},function(){try{const merged={};'
  );
  replaceOnce(
    'return Object.create(null)}};Module._jsSyncReservedWords=',
    'return Object.create(null)}})};Module._jsSyncReservedWords='
  );
  replaceOnce(
    'Module._set_all_variables=function(variables){try{',
    'Module._set_all_variables=function(variables){return Module._withSyncGuard("_set_all_variables",false,function(){try{'
  );
  replaceOnce(
    'return false}};Module._get_variable=',
    'return false}})};Module._get_variable='
  );
  replaceOnce(
    'Module._get_python_variable=function(name){if(!name||typeof name!=="string"){console.error("[_get_python_variable] Invalid variable name");return null}try{',
    'Module._get_python_variable=function(name){if(!name||typeof name!=="string"){console.error("[_get_python_variable] Invalid variable name");return null}return Module._withSyncGuard(`_get_python_variable:${name}`,null,function(){try{'
  );
  replaceOnce(
    'return null}};Module._get_r_variable=',
    'return null}})};Module._get_r_variable='
  );
  replaceOnce(
    'Module._get_r_variable=function(name){if(!name||typeof name!=="string"){console.error("[_get_r_variable] Invalid variable name");return null}try{',
    'Module._get_r_variable=function(name){if(!name||typeof name!=="string"){console.error("[_get_r_variable] Invalid variable name");return null}return Module._withSyncGuard(`_get_r_variable:${name}`,null,function(){try{'
  );
  replaceOnce(
    'return null}};function executionResultToReply',
    'return null}})};function executionResultToReply'
  );
  replaceOnce(
    'Module._getPythonFunctions=function(){const python_funcs={};if(typeof Module.runPython!=="function"){return python_funcs}try{',
    'Module._getPythonFunctions=function(){const python_funcs={};if(typeof Module.runPython!=="function"){return python_funcs}return Module._withSyncGuard("_getPythonFunctions",python_funcs,function(){try{'
  );
  replaceOnce(
    'return python_funcs};Module._getRFunctions=',
    'return python_funcs})};Module._getRFunctions='
  );
  replaceOnce(
    'Module._getRFunctions=function(){const r_funcs={};if(typeof Module.runR!=="function"){return r_funcs}try{',
    'Module._getRFunctions=function(){const r_funcs={};if(typeof Module.runR!=="function"){return r_funcs}return Module._withSyncGuard("_getRFunctions",r_funcs,function(){try{'
  );
  replaceOnce(
    'return r_funcs};Module._getFunctionInfo=',
    'return r_funcs})};Module._getFunctionInfo='
  );
}

if (!source.includes("Module._withSyncGuard=function(")) {
  console.log(`  ⚠ Variable sync guard patch could not be applied to ${path}`);
  process.exit(1);
}

replaceAll('Module.runPython(code,0)', 'Module.runPython(code,0,false,0,"")');
replaceAll('Module.runR(code,0)', 'Module.runR(code,0,false,0,"")');
replaceAll('Module.runPython(pyCode,0)', 'Module.runPython(pyCode,0,false,0,"")');
replaceAll('Module.runR(rCode,0)', 'Module.runR(rCode,0,false,0,"")');

fs.writeFileSync(path, source);
console.log(`  ✓ Patched variable sync guard in ${path}`);
NODE
    then
      :
    else
      echo "  ⚠ Variable sync guard patch failed for $XPYTHON_JS"
    fi
  else
    echo "  ⚠ xpython.js not found at $XPYTHON_JS"
  fi
done

# ==============================================================================
# Preserve injected AI credentials when provider settings expose a sentinel
# ==============================================================================
echo "🔧 Preserving injected AI provider credentials..."
for XPYTHON_JS in "${XPYTHON_JS_FILES[@]}"; do
  if [ -f "$XPYTHON_JS" ]; then
    node - "$XPYTHON_JS" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
let source = fs.readFileSync(path, "utf8");
const marker = "/* datax-now-provider-sync-v2 */";
const alreadyPatched =
  source.includes(marker) || source.includes("providerApiKeyPlaceholders");

if (!alreadyPatched) {
  const syncStart = "(()=>{const syncProviderGlobals=()=>{";
  const oldAssignment = "if(provider?.apiKey)globalThis.OPENAI_API_KEY=String(provider.apiKey);";
  const syncReplacement =
    `${marker}(()=>{const providerApiKeyPlaceholders=new Set(["nokey","no-key","sk-no-key-required"]);` +
    `const isUsableProviderApiKey=value=>typeof value==="string"&&value.trim()!==""&&` +
    `!providerApiKeyPlaceholders.has(value.trim().toLowerCase());const syncProviderGlobals=()=>{`;
  const assignmentReplacement =
    `const providerApiKey=typeof provider?.apiKey==="string"?provider.apiKey.trim():"";` +
    `if(providerApiKey&&(isUsableProviderApiKey(providerApiKey)||` +
    `!isUsableProviderApiKey(globalThis.OPENAI_API_KEY)))` +
    `globalThis.OPENAI_API_KEY=providerApiKey;`;

  if (!source.includes(syncStart) || !source.includes(oldAssignment)) {
    throw new Error(`Could not find the provider synchronization block in ${path}`);
  }
  source = source.replace(syncStart, syncReplacement);
  source = source.replace(oldAssignment, assignmentReplacement);
  fs.writeFileSync(path, source);
  console.log(`  ✓ Preserved injected AI credentials in ${path}`);
} else {
  console.log(`  ✓ AI provider credential guard already present in ${path}`);
}
NODE
  else
    echo "  ⚠ xpython.js not found at $XPYTHON_JS"
  fi
done

# ==============================================================================
# Normalize the synchronous AI provider selection in the WASM worker
# ==============================================================================
echo "🔧 Normalizing the WASM worker AI provider selection..."
for XPYTHON_JS in "${XPYTHON_JS_FILES[@]}"; do
  if [ -f "$XPYTHON_JS" ]; then
    node - "$XPYTHON_JS" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
let source = fs.readFileSync(path, "utf8");
const marker = "/* datax-now-provider-selection-v1 */";
const settings = JSON.parse(fs.readFileSync("overrides.json", "utf8"))["@jupyterlab/ai:settings-model"]
  || JSON.parse(fs.readFileSync("overrides.json", "utf8"))["@jupyterlite/ai:settings-model"];
const providers = Array.isArray(settings?.providers) ? settings.providers : [];
const provider = providers.find((entry) => entry?.id === settings?.defaultProvider) || providers[0];
if (!provider?.baseURL || !provider?.apiKey) {
  throw new Error("The configured default AI provider must include baseURL and apiKey");
}
const needle = "var Module=moduleArg;";
const patch = `${marker}(()=>{const w=globalThis;w.OPENAI_API_BASE=${JSON.stringify(String(provider.baseURL))};w.OPENAI_API_KEY=${JSON.stringify(String(provider.apiKey))};w.OPENAI_API_MODEL=${JSON.stringify(String(provider.model || ""))};const sync=()=>{try{const j=w.jupyter_ai||w._window?.jupyter_ai;const p=j?.settings?.providers;const d=j?.settings?.defaultProvider;if(j&&Array.isArray(p)&&typeof d==="string"){const a=p.find(e=>e?.id===d);if(a){j.active_providers=a;j.active_provider=a}}}catch(e){(w._console||console)?.warn?.("[DataX] provider selection sync failed:",e)}};sync();let i=0;const timer=setInterval(()=>{sync();if(++i>=40)clearInterval(timer)},500)})();`;
if (source.includes(marker)) {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerPattern = new RegExp(`${escapedMarker}\\(\\(\\)=>\\{[\\s\\S]*?\\}\\)\\(\\);`);
  if (!markerPattern.test(source)) {
    throw new Error(`Could not find the existing provider selection block in ${path}`);
  }
  source = source.replace(markerPattern, patch);
  fs.writeFileSync(path, source);
  console.log(`  ✓ Refreshed WASM AI provider selection in ${path}`);
} else {
  if (!source.includes(needle)) {
    throw new Error(`Could not find xpython Module initialization in ${path}`);
  }
  source = source.replace(needle, needle + patch);
  fs.writeFileSync(path, source);
  console.log(`  ✓ Normalized WASM AI provider selection in ${path}`);
}
NODE
  fi
done

# ==============================================================================
# Patch getErrorMessage for Emscripten 4.x exception safety
# ==============================================================================
echo "🔧 Patching getErrorMessage for Emscripten 4.x exception safety..."
XEUS_EXT_STATIC_DIR="dist/extensions/@jupyterlite/xeus-extension/static"
if [ -d "$XEUS_EXT_STATIC_DIR" ]; then
  python3 <<'EOFXEUSPATCH'
from pathlib import Path
import re

static_dir = Path("dist/extensions/@jupyterlite/xeus-extension/static")
js_files = sorted(
    path for path in static_dir.glob("*.js")
    if not path.name.endswith(".LICENSE.txt")
)

geterr_old = re.compile(r'A instanceof WebAssembly\.Exception\?g\.getExceptionMessage\(A\):A')
geterr_new = 'A instanceof WebAssembly.Exception?(()=>{try{const r=g.getExceptionMessage(A);return Array.isArray(r)?r[0]+": "+r[1]:r}catch(_){return"WebAssembly.Exception: "+A}})():A'
start_old = re.compile(r'this\.xkernel\.start\(\)\}catch\(A\)\{const g=YQ\(A,this\.Module\);throw this\.logger\.error\(g\),new Error\(g\)\}')
start_new = 'try{this.xkernel.start()}catch(sE){const sM=YQ(sE,this.Module);this.logger.warn("Kernel start() encountered a non-fatal error: "+sM)}}catch(A){const g=YQ(A,this.Module);throw this.logger.error(g),new Error(g)}'

candidate_files = []
geterr_patched = []
start_patched = []

for js_file in js_files:
    content = js_file.read_text()
    if "getExceptionMessage" not in content and "xkernel.start" not in content:
        continue
    candidate_files.append(js_file)

    updated_content, geterr_count = geterr_old.subn(geterr_new, content)
    if geterr_count:
        content = updated_content
        geterr_patched.append(js_file.name)

    updated_content, start_count = start_old.subn(start_new, content)
    if start_count:
        content = updated_content
        start_patched.append(js_file.name)

    if geterr_count or start_count:
        js_file.write_text(content)

if candidate_files:
    if geterr_patched:
        for name in geterr_patched:
            print(f"  ✓ Patched getErrorMessage in {name}")
    else:
        print("  ✓ getErrorMessage already patched or pattern not found in matching xeus bundles")
    if start_patched:
        for name in start_patched:
            print(f"  ✓ Patched xkernel.start() in {name}")
    else:
        print("  ✓ xkernel.start() already patched or pattern not found in matching xeus bundles")
else:
    print("  ⚠ No xeus extension JS bundle with getExceptionMessage/xkernel.start found")
EOFXEUSPATCH
else
  echo "  ⚠ xeus extension static directory not found at $XEUS_EXT_STATIC_DIR"
fi

# ==============================================================================
# Patch xkernel.start() for non-fatal sub-kernel init
# ==============================================================================
echo "🔧 Patching xkernel.start() for non-fatal sub-kernel init..."
echo "  ✓ xkernel.start() patch handled during xeus bundle scan above"

# ==============================================================================
# Bundle meriyah parser locally
# ==============================================================================
echo "📦 Bundling meriyah parser locally..."
MERIYAH_URL="https://cdn.jsdelivr.net/npm/meriyah@${MERIYAH_VERSION}/dist/meriyah.umd.min.js"
MERIYAH_TARGET="dist/xeus/xeus-python-wasm-host/meriyah.umd.min.js"
if [ "$CLEAN_BUILD" = true ] || [ ! -f "$MERIYAH_TARGET" ]; then
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$MERIYAH_URL" -o "$MERIYAH_TARGET"
  else
    wget -qO "$MERIYAH_TARGET" "$MERIYAH_URL"
  fi
  if [ -s "$MERIYAH_TARGET" ]; then
    if verify_integrity "$MERIYAH_TARGET" "$MERIYAH_SHA256"; then
      echo "  ✓ meriyah v${MERIYAH_VERSION} bundled and verified at $MERIYAH_TARGET"
    else
      echo "  ✗ meriyah integrity check failed — removing"
      rm -f "$MERIYAH_TARGET"
    fi
  else
    echo "  ⚠ Failed to download meriyah from CDN"
  fi
else
  echo "  ✓ meriyah already present"
fi

# ==============================================================================
# Patch federated_extensions in dist/jupyter-lite.json
# ==============================================================================
echo "Patching federated_extensions to add missing extensions..."
python3 << 'EOFPATCH'
import json
import glob
import os
import sys
from pathlib import Path

jupyter_lite_json = Path('dist/jupyter-lite.json')


def find_remote_entry(ext_dir):
    """Find the remoteEntry.*.js file in an extension's static/ dir."""
    pattern = os.path.join('dist', 'extensions', ext_dir, 'static', 'remoteEntry.*.js')
    matches = glob.glob(pattern)
    if matches:
        return 'static/' + os.path.basename(matches[0])
    return None


REQUIRED_EXTENSIONS = [
    ('@jupyterlite/ai', '@jupyterlite/ai'),
    ('@jupyterlite/xeus-extension', '@jupyterlite/xeus-extension'),
    ('@jupyterlab/plugin-playground', '@jupyterlab/plugin-playground'),
    ('datax-now-front', 'datax-now-front'),
]

try:
    if not jupyter_lite_json.exists():
        print(f"  ⚠ {jupyter_lite_json} not found - skipping patch")
        raise SystemExit(0)

    config = json.loads(jupyter_lite_json.read_text(encoding='utf-8'))
    config_data = config.setdefault('jupyter-config-data', {})
    federated_extensions = config_data.setdefault('federated_extensions', [])

    for ext_name, ext_dir in REQUIRED_EXTENSIONS:
        exists = any(ext.get('name') == ext_name for ext in federated_extensions)
        if exists:
            print(f"  ✓ {ext_name} already in federated_extensions")
            continue

        remote_entry = find_remote_entry(ext_dir)
        if remote_entry:
            federated_extensions.append({
                'extension': './extension',
                'load': remote_entry,
                'name': ext_name,
                'style': './style',
            })
            print(f"  ✓ Added {ext_name} ({remote_entry})")
        else:
            print(f"  ⚠ Could not find remoteEntry for {ext_name}")

    jupyter_lite_json.write_text(json.dumps(config, indent=2) + '\n', encoding='utf-8')
    print(f"  Total extensions now: {len(federated_extensions)}")

    ai_remote_entry = find_remote_entry('@jupyterlite/ai')
    if not ai_remote_entry:
        print('ERROR: Missing @jupyterlite/ai remoteEntry asset in dist/extensions/@jupyterlite/ai/static', file=sys.stderr)
        raise SystemExit(1)

    final_names = {ext.get('name') for ext in federated_extensions}
    if '@jupyterlite/ai' not in final_names:
        print('ERROR: @jupyterlite/ai missing from dist/jupyter-lite.json federated_extensions', file=sys.stderr)
        raise SystemExit(1)

    app_configs = sorted(Path('dist').glob('*/jupyter-lite.json'))
    missing_labextensions_url = []
    for app_config in app_configs:
        data = json.loads(app_config.read_text(encoding='utf-8'))
        config_data = data.get('jupyter-config-data', {})
        if config_data.get('fullLabextensionsUrl') != '../extensions':
            missing_labextensions_url.append(str(app_config))

    if missing_labextensions_url:
        print('ERROR: Missing fullLabextensionsUrl=../extensions in:', file=sys.stderr)
        for path in missing_labextensions_url:
            print(f'  - {path}', file=sys.stderr)
        raise SystemExit(1)

    print('  ✓ Verified @jupyterlite/ai asset reachability and per-app labextension paths')

except FileNotFoundError:
    print(f"  ⚠ {jupyter_lite_json} not found - skipping patch")
except Exception as e:
    print(f"  ⚠ Error patching federated_extensions: {e}")
    raise
EOFPATCH

# ==============================================================================
# Patch service worker for /drive/* URL mapping
# ==============================================================================
echo "Patching service worker for /drive/* URL mapping..."
python3 << 'EOFPATCH'
from pathlib import Path
import re

sw_file = Path('dist/service-worker.js')
if not sw_file.exists():
  raise SystemExit(f"Error: {sw_file} not found - cannot apply /drive/* patch")

content = sw_file.read_text()
updated = content

# 1) Ensure /drive/* requests are broadcast to the kernel worker
if 'e.pathname.startsWith("/drive/")' not in updated:
  updated = updated.replace(
    'e.pathname.includes("/api/stdin/"))',
    'e.pathname.includes("/api/stdin/")||e.pathname.startsWith("/drive/"))'
  )

# 2) Replace broadcastOne with /drive-aware handling, timeout, HEAD+ETag support
new_broadcast = (
  'async function broadcastOne(e,t){let a;'
  'if(t.pathname.startsWith("/drive/")){'
  'const r=e.clientId||"sw";'
  'a={browsingContextId:r,requestId:`${Date.now()}-${Math.random().toString(16).slice(2)}`,method:e.method,pathname:t.pathname}'
  '}else{a=await e.json(),a.pathname=t.pathname}'
  'const n=new Promise((r=>{let o=!1;'
  'const i=setTimeout((()=>{o||(o=!0,broadcast.removeEventListener("message",s),'
  'r(new Response("Service Unavailable",{status:503,headers:{"Content-Type":"text/plain"}})))}),5e3),'
  's=e=>{const c=e.data;'
  'if(c.browsingContextId!==a.browsingContextId||c.requestId!==a.requestId)return;'
  'const d=c.response;'
  'o||(o=!0,clearTimeout(i),'
  't.pathname.startsWith("/drive/")?'
  '(d&&d.success?'
  '(function(){'
  'const h={"Content-Type":d.mimeType||"application/octet-stream","Cache-Control":"no-cache"};'
  'const mt=d.mtime||0;'
  'if(mt){h["ETag"]=`W/"${d.size||0}-${mt}"`;h["Last-Modified"]=new Date(mt).toUTCString()}'
  'if(a.method==="HEAD"){'
  'h["Content-Length"]=String(d.size||0);'
  'r(new Response(null,{status:200,headers:h}))}'
  'else{'
  'const e=atob(d.data||""),b=new Uint8Array(e.length);'
  'for(let a=0;a<e.length;a++)b[a]=e.charCodeAt(a);'
  'h["Content-Length"]=String(d.size||b.length);'
  'r(new Response(b,{status:200,headers:h}))}'
  '})():'
  'r(new Response(d&&d.code==="EFBIG"?"File too large":"File not found",'
  '{status:d&&d.code==="EFBIG"?413:404,headers:{"Content-Type":"text/plain"}}))):'
  'r(new Response(JSON.stringify(d)))),broadcast.removeEventListener("message",s)};'
  'broadcast.addEventListener("message",s)}));'
  'return broadcast.postMessage(a),await n}'
)

match = re.search(r'async function broadcastOne\(\s*[\w$]+\s*,\s*[\w$]+\s*\)\s*\{', updated)
if match:
  start = match.start()
  i = match.end()
  depth = 1
  while i < len(updated) and depth > 0:
    ch = updated[i]
    if ch == '{':
      depth += 1
    elif ch == '}':
      depth -= 1
    i += 1
  if depth == 0:
    updated = updated[:start] + new_broadcast + updated[i:]
  else:
    raise SystemExit("Error: Could not match broadcastOne() braces")
else:
  raise SystemExit("Error: Could not find broadcastOne() to patch")

if 'e.pathname.startsWith("/drive/")' not in updated:
  raise SystemExit("Error: Could not enable /drive/* service worker routing")

if updated != content:
  sw_file.write_text(updated)
  print("  ✓ Service worker patched for /drive/* URL mapping")
else:
  print("  ✓ Service worker already patched for /drive/* URL mapping")
EOFPATCH

# ==============================================================================
# Patch service worker for localhost /lab/index.html fallback
# ==============================================================================
echo "Patching service worker for localhost /lab/index.html fallback..."
python3 << 'EOFPATCH'
from pathlib import Path

sw_file = Path('dist/service-worker.js')
if not sw_file.exists():
  print(f"  ⚠ {sw_file} not found - skipping localhost fallback patch")
  raise SystemExit(0)

content = sw_file.read_text()
if '_localhostLabIndexFallback' in content:
  print("  ✓ Service worker already has localhost /lab/index.html fallback patch")
  raise SystemExit(0)

patch = (
  ';(function(){'
  'function _normalizeLocalhostLabIndex(url){'
    'try{'
      'var u=new URL(url,self.location.href);'
      'if((u.hostname==="localhost"||u.hostname==="127.0.0.1"||u.hostname==="[::1]")&&/\\/lab\\/index\\.html$/.test(u.pathname)){'
        'return new URL("/lab/index.html",self.location.href).href;'
      '}'
      'return null;'
    '}catch(e){return null}'
  '}'
  'var _origFetchLocalhost=self.fetch.bind(self);'
  'self.fetch=function(input,init){'
    'var url;'
    'if(typeof input==="string")url=input;'
    'else if(input instanceof URL)url=input.href;'
    'else if(input&&input.url)url=input.url;'
    'var fallback=url?_normalizeLocalhostLabIndex(url):null;'
    'if(fallback){return _origFetchLocalhost(fallback,init).catch(function(){return _origFetchLocalhost(input,init);})}'
    'return _origFetchLocalhost(input,init);'
  '};'
  'self._localhostLabIndexFallback=true;'
  '})();\n'
)

sw_file.write_text(patch + content)
print("  ✓ Service worker patched: localhost /lab/index.html requests now fall back to same-origin /lab/index.html")
EOFPATCH

# ==============================================================================
# Patch service worker for safe file extension conversion
# ==============================================================================
echo "Patching service worker for safe file extension conversion..."
SAFE_EXT_SUFFIXES="$SAFE_EXT_SUFFIXES" SAFE_ASM_EXT="$SAFE_ASM_EXT" SAFE_ALIAS_EXTS="$SAFE_ALIAS_EXTS" python3 << 'EOFPATCH'
from pathlib import Path
import os

sw_file = Path('dist/service-worker.js')
if not sw_file.exists():
  print(f"  ⚠ {sw_file} not found - skipping safe extension conversion patch")
  raise SystemExit(0)

content = sw_file.read_text()

if '_safeExtFallback' in content or '_safeExtConvert' in content:
  print("  ✓ Service worker already has safe extension conversion patch")
  raise SystemExit(0)

safe_ext_suffixes = os.environ.get('SAFE_EXT_SUFFIXES', 'whl so').split()
safe_asm_ext = os.environ.get('SAFE_ASM_EXT', '.asm')
safe_alias_exts = os.environ.get('SAFE_ALIAS_EXTS', '').split()

if not safe_ext_suffixes:
  print("  ✓ SAFE_EXT_SUFFIXES is empty - skipping safe extension conversion patch")
  raise SystemExit(0)

import json
ext_list_js = json.dumps(['.' + e for e in safe_ext_suffixes])
# Full ordered list: canonical first, then aliases
try_exts = [safe_asm_ext] + ['.' + e for e in safe_alias_exts]
try_list_js = json.dumps(try_exts)

# Build a compact self-contained IIFE to prepend to the service worker.
#
# Behaviour:
#   1. SW intercepts any fetch() for a blocked extension (e.g. a.so).
#   2. It tries the canonical suffix first (a.so.asm).
#   3. Only ordinary 403/404 responses try the next alias. Rate limits,
#      challenges, server errors, and network/integrity failures do not retry.
#   4. If every converted variant fails, it falls back to the original
#      request so unconverted assets still work.
#   5. The index of the first working suffix is cached in memory so all
#      subsequent fetches skip the retry loop for the lifetime of the SW.
#
# _resolveBase(pathname):
#   Returns the base pathname up-to-and-including the blocked extension, or
#   null if the URL is not for a blocked file.
#   e.g.  "/a.so"      → "/a.so"   (plain request from page metadata)
#         "/a.so.asm"  → "/a.so"   (already converted — normalise back)
#         "/a.so.zip"  → "/a.so"   (alias variant)
#         "/a.js"      → null      (not a blocked extension)
patch_parts = [
  ';(function(){',
  'var _safeExts=' + ext_list_js + ';',
  # Full ordered list: canonical + aliases
  'var _safeTryExts=' + try_list_js + ';',
  # Index of the last known-working suffix (-1 = not yet known, try from 0)
  'var _workingIdx=-1;',
  # Pages sends precompressed runtime assets as encoded bytes; decode them before
  # returning a safe-extension fallback to the kernel worker.
  'function _decodeGzipResponse(resp,input,init){',
    'var method=input instanceof Request?input.method:(init&&init.method)||"GET";',
    'if(method==="HEAD"||resp.status!==200||resp.headers.get("content-encoding")!=="gzip"||typeof DecompressionStream==="undefined"){return Promise.resolve(resp);}',
    'return resp.clone().arrayBuffer().then(function(encoded){',
      'var bytes=new Uint8Array(encoded);',
      'var body=bytes[0]===31&&bytes[1]===139?new Response(encoded).body.pipeThrough(new DecompressionStream("gzip")):encoded;',
      'var headers=new Headers(resp.headers);',
      'headers.delete("content-encoding");',
      'headers.delete("content-length");',
      'return new Response(body,{status:resp.status,statusText:resp.statusText,headers:headers});',
    '}).catch(function(){return resp;});',
  '}',
  'function _resolveBase(p){',
    'var i,j,combo;',
    # Check blocked+suffix combos first (longer patterns) to avoid false
    # positives when the plain blocked extension check runs afterwards.
    'for(j=0;j<_safeTryExts.length;j++){',
      'for(i=0;i<_safeExts.length;i++){',
        'combo=_safeExts[i]+_safeTryExts[j];',
        'if(p.endsWith(combo)){return p.slice(0,p.length-_safeTryExts[j].length);}',
      '}',
    '}',
    # Plain blocked extension: a.so (not yet converted)
    'for(i=0;i<_safeExts.length;i++){',
      'if(p.endsWith(_safeExts[i])){return p;}',
    '}',
    'return null;',
  '}',
  'var _origFetch=self.fetch.bind(self);',
  # Recursive async retry: tries _safeTryExts[idx] and falls back on failure.
  'function _tryFetch(baseUrl,idx,input,init){',
    'if(idx>=_safeTryExts.length){',
      'return _origFetch(input,init);',
    '}',
    'var candidate=new URL(baseUrl.href);',
    'candidate.pathname=baseUrl.pathname+_safeTryExts[idx];',
    'var redirected=input instanceof Request?new Request(candidate.href,input):candidate.href;',
    'return _origFetch(redirected,init).then(',
      'function(resp){',
        'if(resp.ok||resp.status===304){_workingIdx=idx;return _decodeGzipResponse(resp,input,init);}',
        'if(resp.headers.get("cf-mitigated")==="challenge"||(resp.status!==403&&resp.status!==404)){return resp;}',
        'return _tryFetch(baseUrl,idx+1,input,init);',
      '}',
    ');',
  '}',
  'self.fetch=function(input,init){',
    'var url;',
    'if(typeof input==="string")url=input;',
    'else if(input instanceof URL)url=input.href;',
    'else if(input&&input.url)url=input.url;',
    'if(url){',
      'try{',
        'var resolved=new URL(url,self.location.href);',
        'var base=_resolveBase(resolved.pathname);',
        'if(base!==null){',
          'resolved.pathname=base;',
          # Start from cached working index (or 0 if not yet discovered)
          'var startIdx=_workingIdx>=0?_workingIdx:0;',
          'return _tryFetch(resolved,startIdx,input,init);',
        '}',
      '}catch(e){}',
    '}',
    'return _origFetch(input,init);',
  '};',
  '})();',
]

patch_code = ''.join(patch_parts) + '\n'
sw_file.write_text(patch_code + content)
exts_str = ', '.join('.' + e for e in safe_ext_suffixes)
fallback_str = ' → '.join(try_exts)
print(f"  ✓ Service worker patched: {exts_str} → cascading fallback: {fallback_str}")
EOFPATCH

# ==============================================================================
# Patch service worker for conda package URL extension fallback (.tar.gz -> .tar.bz2)
# ==============================================================================
echo "Patching service worker for conda package URL extension fallback..."
python3 << 'EOFPATCH'
from pathlib import Path

sw_file = Path('dist/service-worker.js')
if not sw_file.exists():
  print(f"  ⚠ {sw_file} not found - skipping conda URL fallback patch")
  raise SystemExit(0)

content = sw_file.read_text()
if '_condaTarballFallback' in content:
  print("  ✓ Service worker already has conda tarball fallback patch")
  raise SystemExit(0)

patch = (
  ';(function(){'
  'function _condaTarballFallback(url){'
    'try{'
      'var u=new URL(url,self.location.href);'
      'if(!/\\.tar\\.gz([?#]|$)/i.test(u.pathname+u.search+u.hash))return null;'
      'var p=u.pathname;'
      'if(!(/\\/(emscripten-wasm32|noarch|linux-64|linux-aarch64|linux-ppc64le|linux-s390x|osx-64|osx-arm64|win-64)\\//.test(p)))return null;'
      'u.pathname=p.replace(/\\.tar\\.gz$/i,".tar.bz2");'
      'return u.href;'
    '}catch(e){return null}'
  '}'
  'var _origFetchConda=self.fetch.bind(self);'
  'self.fetch=function(input,init){'
    'var url;'
    'if(typeof input==="string")url=input;'
    'else if(input instanceof URL)url=input.href;'
    'else if(input&&input.url)url=input.url;'
    'var fallback=url?_condaTarballFallback(url):null;'
    'if(fallback){return _origFetchConda(input instanceof Request?new Request(fallback,input):fallback,init)}'
    'return _origFetchConda(input,init);'
  '};'
  'self._condaTarballFallback=true;'
  '})();\n'
)

sw_file.write_text(patch + content)
print("  ✓ Service worker patched: conda .tar.gz URLs now fallback to .tar.bz2")
EOFPATCH

# ==============================================================================
# Version service-worker cache by deployed runtime bundle hashes
# ==============================================================================
echo "Patching service worker cache version..."
python3 << 'EOFPATCH'
from pathlib import Path
import hashlib
import re

sw_file = Path('dist/service-worker.js')
xpython_js = Path('dist/xeus/xeus-python-wasm-host/xpython.js')
extensions_root = Path('dist/extensions')

if not sw_file.exists():
  print(f"  ⚠ {sw_file} not found - skipping cache version patch")
  raise SystemExit(0)
if not xpython_js.exists():
  print(f"  ⚠ {xpython_js} not found - skipping cache version patch")
  raise SystemExit(0)

content = sw_file.read_text()
digest_input_paths = [xpython_js]
if extensions_root.exists():
  digest_input_paths.extend(sorted(extensions_root.glob('*/static/remoteEntry*.js')))

hasher = hashlib.md5()
for path in digest_input_paths:
  hasher.update(str(path.relative_to(Path('dist'))).encode('utf-8'))
  hasher.update(b'\0')
  hasher.update(path.read_bytes())
  hasher.update(b'\0')

digest = hasher.hexdigest()[:12]
cache_name = f"precache-{digest}"

updated = re.sub(r'const CACHE="precache(?:-[0-9a-f]+)?"', f'const CACHE="{cache_name}"', content, count=1)
if 'origin!==location.origin)return;' not in updated:
  updated, fetch_count = re.subn(
    r'((?:async )?function onFetch\((\w+)\)\s*\{)',
    lambda match: f'{match.group(1)}if(new URL({match.group(2)}.request.url).origin!==location.origin)return;',
    updated,
    count=1,
  )
  if fetch_count != 1:
    raise SystemExit("Service worker fetch handler no longer matches the generated worker")
updated = re.sub(
  r'function onActivate\(e\)\{(?:const t=new URL\(location\.href\)\.searchParams;enableCache="true"===t\.get\("enableCache"\)|enableCache="true"===new URL\(location\.href\)\.searchParams\.get\("enableCache"\)),e\.waitUntil\(self\.clients\.claim\(\)\)\}',
  'function onActivate(e){e.waitUntil((async()=>{const names=await caches.keys();await Promise.all(names.filter(name=>name.startsWith("precache")&&name!==CACHE).map(name=>caches.delete(name)));await self.clients.claim()})())}',
  updated,
  count=1,
)
updated = updated.replace('let enableCache=!1', 'let enableCache="true"===new URL(location.href).searchParams.get("enableCache")')
updated = updated.replace('caches.open("precache")', 'caches.open(CACHE)')
# Subpath deployments ping <base>/api/service-worker-heartbeat.
updated = re.sub(
  r'"/api/service-worker-heartbeat"===(\w+)\.pathname',
  r'\1.pathname.endsWith("/api/service-worker-heartbeat")',
  updated,
)
updated = updated.replace('t&&404!==t.status?t:null', 't&&t.ok?t:null', 1)
updated = updated.replace(
  'e.waitUntil(updateCache(a,t.clone()))',
  't.ok&&e.waitUntil(updateCache(a,t.clone()))',
  1,
)
updated = updated.replace(
  'async function refetch(e){let a=await fetch(e);return await updateCache(e,a),a}',
  'async function refetch(request){'
  'const cached=await fromCache(request);'
  'const headers=new Headers(request.headers);'
  'const etag=cached&&cached.headers.get("ETag");'
  'if(etag&&new URL(request.url).origin===location.origin)headers.set("If-None-Match",etag);'
  'const response=await fetch(new Request(request,{headers})).catch(()=>null);'
  'if(!response)return cached;'
  'if(response.status===304&&cached)return cached;'
  'if(response.ok)await updateCache(request,response.clone());'
  'return response;}'
)
required = [
  'origin!==location.origin)return;',
  'let enableCache="true"===new URL(location.href).searchParams.get("enableCache")',
  'caches.open(CACHE)',
  'caches.keys()',
  't&&t.ok?t:null',
  't.ok&&e.waitUntil(updateCache(a,t.clone()))',
  'headers.set("If-None-Match",etag)',
]
if not all(marker in updated for marker in required):
  raise SystemExit("Service worker cache patch no longer matches the generated worker")

if updated != content:
  sw_file.write_text(updated)
  print(f"  ✓ Service worker cache name set to {cache_name}")
  print("  ✓ Older precache entries will be evicted on activation")
else:
  if cache_name in content and 'caches.keys()' in content:
    print(f"  ✓ Service worker cache version already current: {cache_name}")
  else:
    print("  ⚠ Service worker cache version patch pattern not found")
EOFPATCH

# ============================================================================
# Add COOP and COEP to controlled app navigations for static hosts.
# ============================================================================
echo "Patching service worker navigation responses for isolation headers..."
python3 << 'EOFPATCH'
from pathlib import Path
import re

sw_file = Path('dist/service-worker.js')
if not sw_file.exists():
  raise SystemExit(f"Error: {sw_file} not found - cannot apply RTD COEP patch")

content = sw_file.read_text()
coep_header = 'headers.set("Cross-Origin-Embedder-Policy","require-corp");'
coop_header = 'headers.set("Cross-Origin-Opener-Policy","same-origin");'
corp_header = 'headers.set("Cross-Origin-Resource-Policy","same-origin");'
# Dedicated worker scripts must carry COEP themselves when the page uses require-corp.
isolated_request = '({0}.request.mode==="navigate"||["worker","sharedworker"].includes({0}.request.destination))'
# A CORS mirror response is not a local subresource under COEP, even after SRI verification.
local_mirror_response = (
  'if(response&&response.type==="cors"){const headers=new Headers(response.headers);'
  'headers.delete("Content-Encoding");headers.delete("Content-Length");'
  'response=new Response(response.body,{status:response.status,statusText:response.statusText,headers});}'
)
if coep_header in content:
  updated = content
  if local_mirror_response not in updated:
    wrapper = '.then(async response=>{'
    if wrapper not in updated:
      raise SystemExit("Error: Could not upgrade the service worker mirror response wrapper")
    updated = updated.replace(wrapper, wrapper + local_mirror_response, 1)
  if coop_header not in updated:
    updated = updated.replace(coep_header, coep_header + coop_header, 1)
  if corp_header not in updated:
    updated = updated.replace(coop_header, coop_header + corp_header, 1)
  updated = re.sub(
    r'(\w+)\.request\.mode!=="navigate"\|\|!response',
    lambda m: '!' + isolated_request.format(m.group(1)) + '||!response',
    updated,
    count=1,
  )
  if updated == content:
    print("  ✓ Service worker already adds isolation headers to app navigations and workers")
  else:
    if coop_header not in updated or corp_header not in updated or 'sharedworker' not in updated:
      raise SystemExit("Error: Could not upgrade the existing service worker isolation patch")
    sw_file.write_text(updated)
    print("  ✓ Upgraded service worker isolation patch (COOP, CORP, worker scripts)")
  raise SystemExit(0)

pattern = re.compile(
  r'(async function onFetch\((\w+)\)\{.*?)(\w+&&\w+\.respondWith\(\w+\))'
  r'(\}async function maybeFromCache)',
  re.DOTALL,
)
match = pattern.search(content)
if not match:
  raise SystemExit("Error: Could not find the generated service worker fetch handler")

response_name = re.match(r'(\w+)&&', match.group(3)).group(1)
event_name = match.group(2)
wrapped_response = (
  f'{response_name}&&{event_name}.respondWith({response_name}.then(async response=>{{' +
  local_mirror_response +
  f'if(!{isolated_request.format(event_name)}||!response)return response;'
  f'if(response.status===304){{const retryHeaders=new Headers({event_name}.request.headers);'
  'retryHeaders.delete("If-None-Match");retryHeaders.delete("If-Modified-Since");'
  f'response=await fetch({event_name}.request.url,{{cache:"no-store",'
  f'credentials:{event_name}.request.credentials,headers:retryHeaders,mode:"same-origin"}});}}'
  'const headers=new Headers(response.headers);'
  'headers.set("Cross-Origin-Embedder-Policy","require-corp");'
  'headers.set("Cross-Origin-Opener-Policy","same-origin");'
  'headers.set("Cross-Origin-Resource-Policy","same-origin");'
  'return new Response(response.body,{status:response.status,'
  'statusText:response.statusText,headers});}))'
)
updated = content[:match.start(3)] + wrapped_response + content[match.end(3):]
sw_file.write_text(updated)
print("  ✓ Service worker adds COOP and COEP to controlled app navigations")
EOFPATCH

# ============================================================================
# Delay the JupyterLite loader until static-host isolation is available.
# ============================================================================
echo "Patching static-host app bootstrap for cross-origin isolation..."
python3 << 'EOFPATCH'
from pathlib import Path
import re

app_file = Path('dist/lab/index.html')
if not app_file.exists():
  raise SystemExit(f"Error: {app_file} not found - cannot add RTD isolation bootstrap")

content = app_file.read_text()
marker = 'datax-rtd-coep-bootstrap'
bootstrap = '''<script id="datax-rtd-coep-bootstrap">
window.__dataxStaticHostReady = (() => {
  const hostname = location.hostname;
  const staticHost = hostname.endsWith(".readthedocs.io") || hostname.endsWith(".github.io");
  if (!staticHost) return Promise.resolve(true);
  const key = "datax-static-host-isolation-attempts-v2";
  function showFailure(message) {
    const error = document.createElement("div");
    error.id = "datax-isolation-error";
    error.setAttribute("role", "alert");
    error.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:2rem;box-sizing:border-box;background:#fff;color:#111;font:16px/1.5 sans-serif;text-align:center";
    error.textContent = message;
    document.documentElement.append(error);
    console.error("[DataX.now] " + message);
  }
  if (window.crossOriginIsolated) {
    try {
      sessionStorage.removeItem(key);
      sessionStorage.removeItem("datax-rtd-coep-reload");
    } catch (error) {
      console.warn("[DataX.now] Could not clear static-host isolation retry state.", error);
    }
    return Promise.resolve(true);
  }
  if (!("serviceWorker" in navigator)) {
    showFailure("This browser cannot use the service worker required to isolate the Python runtime on this host.");
    return Promise.resolve(false);
  }
  let attempts;
  try {
    attempts = Number(sessionStorage.getItem(key) || 0);
  } catch (error) {
    showFailure("Could not read the static-host isolation retry state: " + error.message);
    return Promise.resolve(false);
  }
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    showFailure("The static-host isolation retry state is invalid. Clear this site's session storage and reload.");
    return Promise.resolve(false);
  }
  if (attempts >= 3) {
    try {
      sessionStorage.removeItem(key);
    } catch (error) {
      console.warn("[DataX.now] Could not reset static-host isolation retry state.", error);
    }
    showFailure("This host did not enable cross-origin isolation after three reloads. Reload to retry or try another deployment.");
    return Promise.resolve(false);
  }
  const serviceWorker = navigator.serviceWorker;
  const timeoutMs = 120000;
  function withTimeout(promise, message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      Promise.resolve(promise).then(
        value => { clearTimeout(timeout); resolve(value); },
        error => { clearTimeout(timeout); reject(error); },
      );
    });
  }
  function waitForController() {
    if (serviceWorker.controller) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        serviceWorker.removeEventListener("controllerchange", onControllerChange);
      };
      const onControllerChange = () => {
        if (!serviceWorker.controller) return;
        cleanup();
        resolve();
      };
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error("The service worker did not take control within 120 seconds."));
      }, timeoutMs);
      serviceWorker.addEventListener("controllerchange", onControllerChange);
      onControllerChange();
    });
  }
  return (async () => {
    try {
      const scope = new URL("../", location.href);
      const workerUrl = new URL("service-worker.js?enableCache=true", scope);
      await withTimeout(
        serviceWorker.register(workerUrl.href, { scope: scope.pathname }),
        "The service worker did not register within 120 seconds.",
      );
      await withTimeout(serviceWorker.ready, "The service worker did not become ready within 120 seconds.");
      await waitForController();
      sessionStorage.setItem(key, String(attempts + 1));
      console.info("[DataX.now] Reloading the controlled page before starting JupyterLite.");
      location.reload();
      return false;
    } catch (error) {
      showFailure("Could not prepare the isolated Python runtime on this static host: " + error.message);
      return false;
    }
  })();
})();
</script>'''

existing_bootstrap = '<script id="' + marker + '">'
if existing_bootstrap in content:
  start = content.index(existing_bootstrap)
  end = content.index('</script>', start) + len('</script>')
  content = content[:start] + content[end:]

import_pattern = re.compile(r'''await import\(\s*(['"])\.\./config-utils\.js[^'"]*\1\s*\);?''')
import_match = import_pattern.search(content)
if not import_match:
  raise SystemExit(f"Error: Could not find the JupyterLite config-utils loader in {app_file}")

gate_marker = 'datax-rtd-coep-loader-gate'
if gate_marker not in content:
  gate = 'if (!(await window.__dataxStaticHostReady)) return; /* ' + gate_marker + ' */\n        '
  content = content[:import_match.start()] + gate + content[import_match.start():]
  import_match = import_pattern.search(content)
elif 'if (!(await window.__dataxStaticHostReady)) return;' not in content:
  raise SystemExit("Error: Static-host loader gate marker is present but the loader is not gated")

script_start = content.rfind('<script', 0, import_match.start())
script_end = content.find('</script>', import_match.end())
if script_start < 0 or script_end < 0:
  raise SystemExit(f"Error: Could not locate the JupyterLite loader script in {app_file}")

if existing_bootstrap not in content:
  content = content[:script_start] + bootstrap + '\n' + content[script_start:]
app_file.write_text(content)
print("  ✓ JupyterLite startup now waits for static-host isolation")
EOFPATCH

echo "JupyterLite build complete, applying post-build patches..."

# ==============================================================================
# Apply DataX.now branding to every generated application route.
# ==============================================================================
echo "🎨 Applying DataX.now branding..."
cp "${REPO_ROOT}/brand.svg" "dist/brand.svg"
for icon in icon-120x120.png icon-512x512.png favicon.ico; do
  if [ ! -f "${REPO_ROOT}/assets/${icon}" ]; then
    echo "  ✗ Missing DataX.now branding asset: assets/${icon}" >&2
    exit 1
  fi
  cp "${REPO_ROOT}/assets/${icon}" "dist/${icon}"
done
cp "${REPO_ROOT}/assets/datax-lab-logo.css" "dist/datax-lab-logo.css"
python3 <<'PY'
from pathlib import Path
import json
import re
import shutil

dist = Path("dist")
title = "DataX.now"
description = "DataX.now — browser-based, multi-language data applications."

favicon_src = dist / "favicon.ico"

for page in sorted(dist.glob("*/index.html")):
    html = page.read_text(encoding="utf-8")
    html, title_count = re.subn(r"<title>.*?</title>", f"<title>{title}</title>", html, count=1, flags=re.DOTALL)
    html, description_count = re.subn(
        r'<meta name="Description" content=".*?"\s*/?>',
        f'<meta name="Description" content="{description}" />',
        html,
        count=1,
        flags=re.IGNORECASE,
    )
    # Lets the manifest request carry Vercel Deployment Protection cookies on staged builds.
    html = html.replace(
        '<link rel="manifest" href="',
        '<link rel="manifest" crossorigin="use-credentials" href="',
    )
    if 'rel="icon"' not in html:
        html = html.replace(
            '<meta name="viewport" content="width=device-width, initial-scale=1" />',
            '<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
            '    <link rel="icon" type="image/svg+xml" href="../brand.svg" />',
            1,
        )
        if 'datax-lab-logo.css' not in html:
          html = html.replace(
            '</head>',
            '    <link rel="stylesheet" href="../datax-lab-logo.css" />\n</head>',
            1,
          )
    html = html.replace("Loading JupyterLite...", "Loading DataX.now...")
    html = html.replace("JupyterLite requires JavaScript", "DataX.now requires JavaScript")
    page.write_text(html, encoding="utf-8")
    if title_count == 0:
        print(f"  ⚠ No title found in {page}")
    if description_count == 0:
        print(f"  ⚠ No description meta tag found in {page}")

    if favicon_src.is_file():
        shutil.copy2(favicon_src, page.parent / "favicon.ico")

if favicon_src.is_file():
    static_fav = dist / "static" / "favicons"
    if static_fav.is_dir():
        shutil.copy2(favicon_src, static_fav / "favicon.ico")

manifest = dist / "manifest.webmanifest"
if manifest.is_file():
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["short_name"] = data["name"] = title
    data["description"] = description
    data["id"] = "./"
    data["theme_color"] = "#f7dc1e"
    data["icons"] = [icon for icon in data.get("icons", []) if icon.get("sizes") != "120x120"]
    for icon in data["icons"]:
        if icon.get("sizes") == "512x512":
            icon["purpose"] = "any maskable"
    for shortcut in data.get("shortcuts", []):
        if shortcut["url"].startswith("/"):
            shortcut["url"] = "." + shortcut["url"]
        if shortcut.get("name") == "JupyterLite":
            shortcut["name"] = title
        elif shortcut.get("name") == "Replite":
            shortcut["name"] = f"{title} REPL"
            shortcut["description"] = "A single-cell DataX.now interface"
    manifest.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY

# ==============================================================================
# Bundle esbuild-wasm for TypeScript support
# ==============================================================================
echo "📦 Bundling esbuild-wasm for TypeScript support..."
ESBUILD_VENDOR_SRC="vendor/esbuild-wasm"
ESBUILD_DEST="dist/packages/esbuild-wasm"

mkdir -p "$ESBUILD_DEST"

if [ -f "$ESBUILD_VENDOR_SRC/esbuild.wasm" ] && [ -f "$ESBUILD_VENDOR_SRC/browser.min.js" ]; then
  echo "  Using vendored esbuild-wasm files with integrity verification..."
  
  if verify_integrity "$ESBUILD_VENDOR_SRC/esbuild.wasm" "$ESBUILD_WASM_SHA256" && \
     verify_integrity "$ESBUILD_VENDOR_SRC/browser.min.js" "$ESBUILD_JS_SHA256"; then
    echo "  ✓ Vendored files integrity verified"
    cp "$ESBUILD_VENDOR_SRC/esbuild.wasm" "$ESBUILD_DEST/esbuild.wasm"
    cp "$ESBUILD_VENDOR_SRC/browser.min.js" "$ESBUILD_DEST/browser.min.js"
  else
    echo "  ✗ Vendored files failed integrity check - this is a security issue!"
    exit 1
  fi
else
  echo "  Vendored files not found, attempting download from npm CDN..."
  
  ESBUILD_WASM_URL="https://unpkg.com/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm"
  ESBUILD_JS_URL="https://unpkg.com/esbuild-wasm@${ESBUILD_VERSION}/lib/browser.min.js"
  
  ESBUILD_DOWNLOAD_FAILED=false

  if curl -L -o "$ESBUILD_DEST/esbuild.wasm" "$ESBUILD_WASM_URL" 2>/dev/null; then
    if verify_integrity "$ESBUILD_DEST/esbuild.wasm" "$ESBUILD_WASM_SHA256"; then
      echo "  ✓ esbuild.wasm downloaded and verified"
    else
      echo "  ✗ Downloaded esbuild.wasm failed integrity check"
      rm -f "$ESBUILD_DEST/esbuild.wasm"
      ESBUILD_DOWNLOAD_FAILED=true
    fi
  else
    echo "  ✗ Failed to download esbuild.wasm"
    ESBUILD_DOWNLOAD_FAILED=true
  fi
  
  if curl -L -o "$ESBUILD_DEST/browser.min.js" "$ESBUILD_JS_URL" 2>/dev/null; then
    if verify_integrity "$ESBUILD_DEST/browser.min.js" "$ESBUILD_JS_SHA256"; then
      echo "  ✓ browser.min.js downloaded and verified"
    else
      echo "  ✗ Downloaded browser.min.js failed integrity check"
      rm -f "$ESBUILD_DEST/browser.min.js"
      ESBUILD_DOWNLOAD_FAILED=true
    fi
  else
    echo "  ✗ Failed to download browser.min.js"
    ESBUILD_DOWNLOAD_FAILED=true
  fi

  if [ "$ESBUILD_DOWNLOAD_FAILED" = true ]; then
    echo "  ⚠ esbuild-wasm bundle incomplete; TypeScript support will be unavailable"
  fi
fi

if [ -f "$ESBUILD_DEST/esbuild.wasm" ] && [ -f "$ESBUILD_DEST/browser.min.js" ]; then
  echo "  ✓ esbuild-wasm v${ESBUILD_VERSION} bundled successfully with verified integrity"
  ls -lh "$ESBUILD_DEST/"
else
  echo "  ⚠ esbuild-wasm not bundled (missing files)"
fi

# ==============================================================================
# Bundle AI agents for built-in AI helpers
# ==============================================================================
echo "📦 Bundling AI agents for AI helpers..."
AI_AGENTS_DEST_PUBLIC="dist/vendor/ai_agents"
AI_AGENTS_DEST_KERNEL="dist/xeus/xeus-python-wasm-host/vendor/ai_agents"
AI_AGENTS_DEST_EXTENSION="dist/extensions/@jupyterlite/xeus-extension/static/vendor/ai_agents"
AI_AGENTS_DEST_PACKAGES="dist/packages/ai_agents"

if [ -d "$AI_AGENTS_SOURCE_BUILD" ] && [ -f "$AI_AGENTS_SOURCE_BUILD/bundle.js" ]; then
  AI_AGENTS_SOURCE_MARKER="$(extract_ai_agents_bundle_marker "$AI_AGENTS_SOURCE_BUILD/bundle.js")"
  AI_AGENTS_SOURCE_DIGEST="$(ai_agents_dir_digest "$AI_AGENTS_SOURCE_BUILD")"
  echo "  Copying AI agents bundle from: $AI_AGENTS_SOURCE_BUILD"
  echo "  Marker: $AI_AGENTS_SOURCE_MARKER"
  echo "  Digest: $AI_AGENTS_SOURCE_DIGEST"

  rm -rf "$AI_AGENTS_DEST_PUBLIC" "$AI_AGENTS_DEST_PACKAGES" "$AI_AGENTS_DEST_KERNEL" "$AI_AGENTS_DEST_EXTENSION"
  mkdir -p "$AI_AGENTS_DEST_PUBLIC" "$AI_AGENTS_DEST_PACKAGES"
  cp -a "$AI_AGENTS_SOURCE_BUILD/." "$AI_AGENTS_DEST_PUBLIC/"
  echo "  ✓ Copied AI agents bundle to $AI_AGENTS_DEST_PUBLIC"
  cp -a "$AI_AGENTS_SOURCE_BUILD/." "$AI_AGENTS_DEST_PACKAGES/"
  echo "  ✓ Copied AI agents bundle to $AI_AGENTS_DEST_PACKAGES"
  
  mkdir -p "$AI_AGENTS_DEST_KERNEL" "$AI_AGENTS_DEST_EXTENSION"
  cp -a "$AI_AGENTS_DEST_PUBLIC/." "$AI_AGENTS_DEST_KERNEL/"
  cp -a "$AI_AGENTS_DEST_PUBLIC/." "$AI_AGENTS_DEST_EXTENSION/"
  echo "  ✓ Copied AI agents bundle to $AI_AGENTS_DEST_KERNEL"
  echo "  ✓ Copied AI agents bundle to $AI_AGENTS_DEST_EXTENSION"

  verify_ai_agents_copy "$AI_AGENTS_SOURCE_BUILD" "$AI_AGENTS_DEST_PUBLIC" "$AI_AGENTS_SOURCE_MARKER" "$AI_AGENTS_SOURCE_DIGEST"
  verify_ai_agents_copy "$AI_AGENTS_SOURCE_BUILD" "$AI_AGENTS_DEST_PACKAGES" "$AI_AGENTS_SOURCE_MARKER" "$AI_AGENTS_SOURCE_DIGEST"
  verify_ai_agents_copy "$AI_AGENTS_SOURCE_BUILD" "$AI_AGENTS_DEST_KERNEL" "$AI_AGENTS_SOURCE_MARKER" "$AI_AGENTS_SOURCE_DIGEST"
  verify_ai_agents_copy "$AI_AGENTS_SOURCE_BUILD" "$AI_AGENTS_DEST_EXTENSION" "$AI_AGENTS_SOURCE_MARKER" "$AI_AGENTS_SOURCE_DIGEST"
  echo "  ✓ Verified AI agents bundle marker and digest in all deployed destinations"

  AI_AGENTS_VERSION_JSON="dist/ai_agents-version.json"
  python3 - "$AI_AGENTS_VERSION_JSON" "$AI_AGENTS_SOURCE_MARKER" "$AI_AGENTS_SOURCE_DIGEST" "$AI_AGENTS_SOURCE_BUILD" \
    "$AI_AGENTS_DEST_PUBLIC" "$AI_AGENTS_DEST_PACKAGES" "$AI_AGENTS_DEST_KERNEL" "$AI_AGENTS_DEST_EXTENSION" \
    "$AI_AGENTS_SOURCE_POLICY" "$AI_AGENTS_SOURCE_KIND" "$AI_AGENTS_FALLBACK_TO_WHEEL" "$AI_AGENTS_DIGEST_MATCHES_WHEEL" "$WHEEL_AI_AGENTS_DIGEST" <<'PY'
import json
import pathlib
import sys

(
    out,
    marker,
    digest,
    source,
    *rest,
) = sys.argv[1:]

dests = rest[:4]
source_policy, source_kind, fallback_to_wheel, digest_matches_wheel, wheel_digest = rest[4:9]
payload = {
    'marker': marker,
    'digestSha256': digest,
    'source': source,
    'sourcePolicy': source_policy,
    'sourceKind': source_kind,
    'fallbackToWheel': fallback_to_wheel == 'true',
    'digestMatchesWheel': digest_matches_wheel,
    'wheelManifestDigestSha256': wheel_digest,
    'deployedTo': dests,
}
pathlib.Path(out).write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
PY
  echo "  ✓ Wrote $AI_AGENTS_VERSION_JSON"
else
  echo "  ⚠ AI agents bundle not found - AI helpers will be unavailable"
fi

# ==============================================================================
# Copy R shared libraries to extension static directory
# ==============================================================================
echo "Copying R shared libraries to extension static directory..."
EXT_STATIC_DIR="dist/extensions/@jupyterlite/xeus-extension/static"
if [ -d "$EXT_STATIC_DIR" ]; then
  for so_file in "$PREFIX/lib/R/lib/libR.so" "$PREFIX/lib/R/lib/libRblas.so" "$PREFIX/lib/R/lib/libRlapack.so"; do
    if [ -f "$so_file" ]; then
      cp "$so_file" "$EXT_STATIC_DIR/"
      echo "  ✓ Copied $(basename "$so_file") to extension static directory"
    fi
  done

  top_level_shared_libs=0
  while IFS= read -r shared_lib_path; do
    [[ -z "$shared_lib_path" ]] && continue
    cp "$shared_lib_path" "$EXT_STATIC_DIR/"
    top_level_shared_libs=$((top_level_shared_libs + 1))
  done <<< "$(find "$PREFIX/lib" -maxdepth 1 -name '*.so*' | sort)"
  echo "  ✓ Copied $top_level_shared_libs top-level shared libraries"

  R_MODULE_LIB_DIR="$PREFIX/lib/R/modules"
  if [ -d "$R_MODULE_LIB_DIR" ]; then
    copied_r_module_libs=0
    while IFS= read -r module_so_path; do
      [[ -z "$module_so_path" ]] && continue
      cp "$module_so_path" "$EXT_STATIC_DIR/"
      copied_r_module_libs=$((copied_r_module_libs + 1))
    done <<< "$(find "$R_MODULE_LIB_DIR" -maxdepth 1 -name '*.so*' | sort)"
    echo "  ✓ Copied $copied_r_module_libs R module shared libraries"
  fi

  R_PACKAGE_LIB_DIR="$PREFIX/lib/R/library"
  if [ -d "$R_PACKAGE_LIB_DIR" ]; then
    copied_r_package_libs=0
    while IFS= read -r package_so_path; do
      [[ -z "$package_so_path" ]] && continue
      cp "$package_so_path" "$EXT_STATIC_DIR/"
      copied_r_package_libs=$((copied_r_package_libs + 1))
    done <<< "$(find "$R_PACKAGE_LIB_DIR" -path '*/libs/*.so' -type f | sort)"
    echo "  ✓ Copied $copied_r_package_libs R package shared libraries"
  fi
else
  echo "  ⚠ Extension static directory not found: $EXT_STATIC_DIR"
fi

# ==============================================================================
# Pack hera R package for WASM runtime
# ==============================================================================
KERNEL_PACKAGES_DIR="dist/xeus/xeus-python-wasm-host/kernel_packages"
HERA_HOST_DIR="$PREFIX/lib/R/library/hera"

if [ -d "$HERA_HOST_DIR" ]; then
    echo "Packing hera R package for WASM runtime..."
    mkdir -p "$KERNEL_PACKAGES_DIR"
    (cd "$PREFIX" && find lib/R/library/hera -type f | sort | tar czf - -T -) \
        > "$KERNEL_PACKAGES_DIR/$HERA_TARBALL_NAME"
    echo "  ✓ Created $HERA_TARBALL_NAME in kernel_packages"

    EMPACK_META="dist/xeus/xeus-python-wasm-host/empack_env_meta.json"
    if [ -f "$EMPACK_META" ]; then
        python3 << EOFHERA
import json
meta_path = "$EMPACK_META"
with open(meta_path) as f:
    meta = json.load(f)

meta['packages'] = [p for p in meta.get('packages', []) if p.get('name') != 'r-hera']
meta['packages'].append({
    "name": "r-hera",
    "version": "0.6.0",
    "build": "local_0",
    "filename_stem": "r-hera-0.6.0-local_0",
    "filename": "$HERA_TARBALL_NAME",
    "url": "kernel_packages/$HERA_TARBALL_NAME",
  "channel": "https://repo.prefix.dev/emscripten-forge-4x",
    "depends": [],
    "subdir": "emscripten-wasm32"
})
with open(meta_path, 'w') as f:
    json.dump(meta, f, indent=2)
    f.write('\\n')
print("  ✓ Added r-hera to empack_env_meta.json (with url)")
EOFHERA
    fi
else
    echo "  ⚠ hera not installed at $HERA_HOST_DIR - R execution may not work"
fi

# ==============================================================================
# Patch xeus extension for unconditional shared library loading
# ==============================================================================
echo "Patching xeus extension bundles for unconditional shared library loading..."
python3 << 'EOFPATCH'
from pathlib import Path

static_dir = Path('dist/extensions/@jupyterlite/xeus-extension/static')
if not static_dir.exists():
  print(f"  ⚠ {static_dir} not found - skipping shared library patch")
  raise SystemExit(0)

import re

GUARD_PATTERN = re.compile(r'this\.emscriptenMajorVersion<4&&(await\b)')

patched_files = []
for js_file in sorted(static_dir.glob('*.js')):
  content = js_file.read_text()
  updated, count = GUARD_PATTERN.subn(r'\1', content)
  if count:
    js_file.write_text(updated)
    patched_files.append((js_file.name, count))

if patched_files:
  for name, count in patched_files:
    print(f"  ✓ Patched {count} shared-library guard(s) in {name}")
else:
  print("  ✓ No stale shared-library guards found in xeus extension bundles")
EOFPATCH

# ==============================================================================
# Publish built-in local package store
# ==============================================================================
echo "Publishing built-in local package store..."
rm -rf "$BUILTIN_LOCAL_DIST_DIR"
mkdir -p "$BUILTIN_LOCAL_DIST_DIR/conda" "$BUILTIN_LOCAL_DIST_DIR/pip"

if [ -d "$BUILTIN_CONDA_DIR" ]; then
  for conda_subdir in "$BUILTIN_CONDA_DIR"/*/; do
    [[ -d "$conda_subdir" ]] || continue
    cp -r "${conda_subdir%/}" "$BUILTIN_LOCAL_DIST_DIR/conda/"
  done
  for quak_package in "$BUILTIN_LOCAL_DIST_DIR"/conda/*/quak-*.conda; do
    [[ -f "$quak_package" ]] || continue
    mamba_run_deploy python "$QUAK_PATCHER" "$quak_package"
  done
  mamba_run_deploy python built-in-conda/generate_repodata.py "$BUILTIN_LOCAL_DIST_DIR/conda"
  mamba_run_deploy python built-in-conda/generate_repodata.py --validate-only "$BUILTIN_LOCAL_DIST_DIR/conda"
  echo "  ✓ Copied built-in conda channel to $BUILTIN_LOCAL_DIST_DIR/conda"
else
  echo "  ✓ No built-in-conda directory found - skipping"
fi

for _subdir in emscripten-wasm32 noarch; do
  _subdir_dir="$BUILTIN_LOCAL_DIST_DIR/conda/$_subdir"
  mkdir -p "$_subdir_dir"
  if [ ! -f "$_subdir_dir/repodata.json" ]; then
    printf '{"info":{"subdir":"%s"},"packages":{},"packages.conda":{},"repodata_version":1}\n' "$_subdir" \
      > "$_subdir_dir/repodata.json"
    echo "  ✓ Created stub $BUILTIN_LOCAL_DIST_DIR/conda/$_subdir/repodata.json"
  fi
done

if [ -d "$BUILTIN_RUNTIME_WHEELS_DIR" ]; then
  for runtime_wheel in "$BUILTIN_RUNTIME_WHEELS_DIR"/*.whl; do
    [[ -f "$runtime_wheel" ]] || continue
    cp "$runtime_wheel" "$BUILTIN_LOCAL_DIST_DIR/pip/"
  done
  if [ -f "$BUILTIN_RUNTIME_WHEELS_DIR/index.json" ]; then
    cp "$BUILTIN_RUNTIME_WHEELS_DIR/index.json" "$BUILTIN_LOCAL_DIST_DIR/pip/"
  fi
  echo "  ✓ Copied runtime wheels to $BUILTIN_LOCAL_DIST_DIR/pip"
else
  echo "  ✓ No built-in-runtime-wheels directory found - skipping"
fi

# ==============================================================================
# Normalize empack metadata and write manifest
# ==============================================================================
echo "Normalizing empack metadata and writing built-in local manifest..."
mamba_run_deploy python3 << 'EOFPATCH'
import json
from pathlib import Path

root = Path('dist/xeus/xeus-python-wasm-host')
meta_path = root / 'empack_env_meta.json'
conda_root = root / 'built-in-local' / 'conda'
pip_index_path = root / 'built-in-local' / 'pip' / 'index.json'
manifest_path = root / 'built-in-local' / 'manifest.json'


def append_package(packages: dict, name: str, record: dict) -> None:
  existing = packages.get(name)
  if existing is None:
    packages[name] = record
  elif isinstance(existing, list):
    existing.append(record)
  else:
    packages[name] = [existing, record]

conda_packages = {}
if conda_root.exists():
  for repodata_path in sorted(conda_root.glob('*/repodata.json')):
    repodata = json.loads(repodata_path.read_text())
    subdir = repodata.get('info', {}).get('subdir', repodata_path.parent.name)
    for section in ('packages', 'packages.conda'):
      for filename, record in repodata.get(section, {}).items():
        append_package(conda_packages, record['name'], {
          'version': record.get('version'),
          'build': record.get('build'),
          'subdir': record.get('subdir', subdir),
          'filename': filename,
          'sha256': record.get('sha256'),
          'size': record.get('size'),
        })

pip_packages = {}
if pip_index_path.exists():
  pip_packages = json.loads(pip_index_path.read_text()).get('packages', {})

manifest = {
  'version': 1,
  'conda': {
    'bundledChannel': './conda',
    'packages': conda_packages,
  },
  'pip': {
    'packages': pip_packages,
  },
}
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')

# Validate manifest against the vendored runtime package schema
schema_path = Path('vendor/schemas/runtime-package-manifest.v1.json')
if not schema_path.exists():
  raise SystemExit(f'Required manifest schema not found at {schema_path}')

import jsonschema
schema = json.loads(schema_path.read_text())
jsonschema.validate(instance=manifest, schema=schema)
print(f'  ✓ Manifest validated against {schema_path}')

LOCAL_MARKER = '/built-in-conda'

def _is_local(value: str) -> bool:
  return LOCAL_MARKER in value.replace('\\', '/')

if meta_path.exists():
  meta = json.loads(meta_path.read_text())
  meta['channels'] = [ch for ch in meta.get('channels', []) if not _is_local(ch)]
  for pkg in meta.get('packages', []):
    if 'channel' in pkg and _is_local(pkg['channel']):
      pkg['channel'] = './built-in-local/conda'
    if 'url' in pkg and _is_local(pkg['url']):
      subdir = pkg.get('subdir') or 'noarch'
      filename = pkg.get('filename', '')
      pkg['url'] = f'./built-in-local/conda/{subdir}/{filename}' if filename else './built-in-local/conda'
  meta_path.write_text(json.dumps(meta, indent=2) + '\n')
EOFPATCH

# ==============================================================================
# Safe file extension conversion: rename blocked extensions in dist/
# ==============================================================================
echo "Applying safe file extension conversion to dist/..."
SAFE_EXT_SUFFIXES="$SAFE_EXT_SUFFIXES" SAFE_ASM_EXT="$SAFE_ASM_EXT" SAFE_ALIAS_EXTS="$SAFE_ALIAS_EXTS" python3 << 'EOFPATCH'
from pathlib import Path
import os, shutil

safe_ext_suffixes = os.environ.get('SAFE_EXT_SUFFIXES', 'whl so').split()
safe_asm_ext = os.environ.get('SAFE_ASM_EXT', '.asm')
safe_alias_exts = ['.' + e for e in os.environ.get('SAFE_ALIAS_EXTS', '').split()]

dist_dir = Path('dist')
if not dist_dir.exists():
  print("  ⚠ dist/ not found - skipping safe extension conversion")
  raise SystemExit(0)

if not safe_ext_suffixes:
  print("  ✓ SAFE_EXT_SUFFIXES is empty - skipping safe extension conversion")
  raise SystemExit(0)

total_renamed = 0
total_copies = 0
# Build the set of already-safe suffixes once (avoid repeated list concatenation in the loop)
all_safe_suffixes = [safe_asm_ext] + safe_alias_exts
for suffix in safe_ext_suffixes:
  count = 0
  for f in sorted(dist_dir.rglob('*.' + suffix)):
    # Skip files that already carry any of the safe suffixes (already converted)
    if any(f.name.endswith(s) for s in all_safe_suffixes):
      continue
    # Rename original to canonical extension
    canonical = f.parent / (f.name + safe_asm_ext)
    f.rename(canonical)
    count += 1
    # Create a physical copy for each alias extension so the cascading fallback
    # in the service worker can fetch them if the canonical extension is blocked.
    for alias_ext in safe_alias_exts:
      alias_path = f.parent / (f.name + alias_ext)
      if not alias_path.exists():
        shutil.copy2(canonical, alias_path)
        total_copies += 1
  if count:
    print(f"  ✓ Renamed {count} .{suffix} → .{suffix}{safe_asm_ext}")
  total_renamed += count

if total_renamed == 0:
  print("  ✓ No files needed safe extension conversion")
else:
  print(f"  ✓ Total: {total_renamed} file(s) renamed to canonical extension")
  if total_copies:
    alias_list = ', '.join(safe_alias_exts)
    print(f"  ✓ Total: {total_copies} alias copies created ({alias_list})")
EOFPATCH

# ==============================================================================
echo "Patching WASM startup failure propagation..."
SAFE_EXT_SUFFIXES="$SAFE_EXT_SUFFIXES" SAFE_ASM_EXT="$SAFE_ASM_EXT" node "${REPO_ROOT}/scripts/patch-wasm-startup.cjs" dist

# Post-deploy xpython.js consistency verification
# ------------------------------------------------------------------------------
# Guards against the failure mode where deployed xpython.js/xpython.wasm targets
# silently diverge from the installed wheel payload.
# A summary manifest (dist/xpython-deploy-manifest.json) is written so callers
# can quickly check vendor + canonical patched hashes when debugging.
# ==============================================================================
echo ""
echo "=========================================="
echo "Verifying xpython.js deployment consistency..."
echo "=========================================="

VERIFY_FAIL=0

XPYTHON_JS_TARGETS=(
  "$PREFIX/bin/xpython.js"
  "$KERNEL_SPEC_DIR/xpython.js"
  "dist/xeus/xeus-python-wasm-host/xpython.js"
  "dist/xeus/xeus-python-wasm-host/bin/xpython.js"
)
XPYTHON_WASM_TARGETS=(
  "$PREFIX/bin/xpython.wasm"
  "$KERNEL_SPEC_DIR/xpython.wasm"
  "dist/xeus/xeus-python-wasm-host/xpython.wasm"
  "dist/xeus/xeus-python-wasm-host/bin/xpython.wasm"
)

WHEEL_JS_MD5="$(md5sum "$KERNEL_WHEEL_DIR/bin/xpython.js" 2>/dev/null | awk '{print $1}')"
WHEEL_WASM_MD5="$(md5sum "$KERNEL_WHEEL_DIR/bin/xpython.wasm" 2>/dev/null | awk '{print $1}')"
echo "  wheel xpython.js md5   = $WHEEL_JS_MD5  ($KERNEL_WHEEL_DIR/bin/xpython.js)"
echo "  wheel xpython.wasm md5 = $WHEEL_WASM_MD5"

# The deploy environment's PREFIX/bin and kernelspec copies are staging/runtime
# helpers. The user-facing deployment consumes dist/xeus/*, which is copied from
# the installed wheel and then patched in-place. Verify the deployed dist copies
# as one group, and keep the deploy-environment copies as a separate group.
DEPLOY_CANONICAL_JS="dist/xeus/xeus-python-wasm-host/xpython.js"
DEPLOY_CANONICAL_WASM="dist/xeus/xeus-python-wasm-host/xpython.wasm"
DEPLOY_JS_TARGETS=(
  "dist/xeus/xeus-python-wasm-host/xpython.js"
  "dist/xeus/xeus-python-wasm-host/bin/xpython.js"
)
DEPLOY_WASM_TARGETS=(
  "dist/xeus/xeus-python-wasm-host/xpython.wasm"
  "dist/xeus/xeus-python-wasm-host/bin/xpython.wasm"
)
ENV_JS_TARGETS=(
  "$PREFIX/bin/xpython.js"
  "$KERNEL_SPEC_DIR/xpython.js"
)
ENV_WASM_TARGETS=(
  "$PREFIX/bin/xpython.wasm"
  "$KERNEL_SPEC_DIR/xpython.wasm"
)

if [ ! -f "$DEPLOY_CANONICAL_JS" ]; then
  echo "  ✗ Canonical deployed xpython.js missing at $DEPLOY_CANONICAL_JS"
  VERIFY_FAIL=1
else
  CANONICAL_JS_MD5="$(md5sum "$DEPLOY_CANONICAL_JS" | awk '{print $1}')"
  CANONICAL_WASM_MD5="$(md5sum "$DEPLOY_CANONICAL_WASM" 2>/dev/null | awk '{print $1}')"
  echo "  deployed canonical xpython.js md5   = $CANONICAL_JS_MD5"
  echo "  deployed canonical xpython.wasm md5 = $CANONICAL_WASM_MD5"

  for target in "${DEPLOY_JS_TARGETS[@]}"; do
    if [ ! -f "$target" ]; then
      echo "  ✗ Missing target: $target"
      VERIFY_FAIL=1
      continue
    fi
    target_md5="$(md5sum "$target" | awk '{print $1}')"
    if [ "$target_md5" != "$CANONICAL_JS_MD5" ]; then
      echo "  ✗ MISMATCH: $target md5 = $target_md5 (expected $CANONICAL_JS_MD5)"
      VERIFY_FAIL=1
    fi
  done

  for target in "${DEPLOY_WASM_TARGETS[@]}"; do
    if [ ! -f "$target" ]; then
      echo "  ✗ Missing target: $target"
      VERIFY_FAIL=1
      continue
    fi
    target_md5="$(md5sum "$target" | awk '{print $1}')"
    if [ "$target_md5" != "$CANONICAL_WASM_MD5" ]; then
      echo "  ✗ MISMATCH: $target md5 = $target_md5 (expected $CANONICAL_WASM_MD5)"
      VERIFY_FAIL=1
    fi
  done

  for target in "${ENV_JS_TARGETS[@]}"; do
    if [ ! -f "$target" ]; then
      echo "  ✗ Missing deploy-environment target: $target"
      VERIFY_FAIL=1
      continue
    fi
  done

  for target in "${ENV_WASM_TARGETS[@]}"; do
    if [ ! -f "$target" ]; then
      echo "  ✗ Missing deploy-environment target: $target"
      VERIFY_FAIL=1
      continue
    fi
  done

  if [ "$VERIFY_FAIL" -eq 0 ]; then
    echo "  ✓ All ${#DEPLOY_JS_TARGETS[@]} deployed xpython.js targets are byte-identical"
    echo "  ✓ All ${#DEPLOY_WASM_TARGETS[@]} deployed xpython.wasm targets are byte-identical"
  fi

  # Verify the deploy-time patches actually landed in the canonical copy.
  # _withSyncGuard is injected by the variable-sync guard patch (line ~1300).
  # The "Cannot register type ... twice" string is removed by the embind dedup
  # patch (line ~1267); its presence means the patch did not run.
  if ! grep -qF "_withSyncGuard" "$DEPLOY_CANONICAL_JS"; then
    echo "  ✗ Variable-sync guard patch marker (_withSyncGuard) NOT found in deployed canonical xpython.js"
    VERIFY_FAIL=1
  else
    echo "  ✓ Variable-sync guard patch present"
  fi
  if grep -qF "Cannot register type \`\${name}\` twice" "$DEPLOY_CANONICAL_JS" \
     || grep -qF "Cannot register type '\${name}' twice" "$DEPLOY_CANONICAL_JS"; then
    echo "  ✗ Embind dedup patch did NOT remove duplicate-type-error pattern"
    VERIFY_FAIL=1
  else
    echo "  ✓ Embind dedup patch applied"
  fi
  if ! grep -qF "providerApiKeyPlaceholders" "$DEPLOY_CANONICAL_JS"; then
    echo "  ✗ AI provider credential guard NOT found in deployed canonical xpython.js"
    VERIFY_FAIL=1
  else
    echo "  ✓ AI provider credential guard present"
  fi

  # Write a small manifest so future debugging can compare expected vs deployed.
  MANIFEST_JSON="dist/xpython-deploy-manifest.json"
  mkdir -p dist
  cat > "$MANIFEST_JSON" <<EOFXMANIFEST
{
  "vendor": {
    "xpython.js":   "$WHEEL_JS_MD5",
    "xpython.wasm": "$WHEEL_WASM_MD5"
  },
  "canonical_post_patch": {
    "xpython.js":   "$CANONICAL_JS_MD5",
    "xpython.wasm": "$CANONICAL_WASM_MD5"
  },
  "targets": [
    "dist/xeus/xeus-python-wasm-host/xpython.js",
    "dist/xeus/xeus-python-wasm-host/bin/xpython.js"
  ],
  "deploy_timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "verified": $([ "$VERIFY_FAIL" -eq 0 ] && echo true || echo false)
}
EOFXMANIFEST
  echo "  ✓ Wrote $MANIFEST_JSON"
fi

# Post-build federation rewrites change remoteEntry contents after webpack has
# assigned their filenames. Give those rewritten assets fresh URLs so static
# hosts and service workers cannot serve pre-rewrite bytes from cache.
python3 <<'EOFPATCH'
import hashlib
from pathlib import Path

root = Path('dist')
renamed = {}
for path in sorted(root.glob('extensions/**/static/remoteEntry*.js')):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    target = path.with_name(f'remoteEntry.{digest}.js')
    if target != path:
        path.replace(target)
        renamed[path.name] = target.name

if renamed:
    for json_path in root.rglob('*.json'):
        content = json_path.read_text(encoding='utf-8')
        updated = content
        for old, new in renamed.items():
            updated = updated.replace(old, new)
        if updated != content:
            json_path.write_text(updated, encoding='utf-8')
    print(f'  ✓ Cache-busted {len(renamed)} federation remote entries')
EOFPATCH

if [ "$VERIFY_FAIL" -ne 0 ]; then
  echo ""
  echo "✗ Deployment verification FAILED — deployed xpython artifacts are inconsistent."
  echo "  This usually means a manual 'cp' overwrote a deploy-patched dist copy,"
  echo "  or a previous build.sh run was interrupted mid-patching."
  echo "  Re-run ./build.sh to restore the canonical patched state."
  exit 1
fi

DATAX_BUILD_COMMIT="$(node "$REPO_ROOT/scripts/deployment-manifest.mjs" commit "$REPO_ROOT")"
export DATAX_BUILD_COMMIT
node "$REPO_ROOT/scripts/verify-kernel-config.mjs" dist
SAFE_ASM_EXT="$SAFE_ASM_EXT" node "$REPO_ROOT/scripts/patch-wasm-startup.cjs" dist --compact
node "$REPO_ROOT/scripts/fingerprint-runtime.cjs" dist

  # Include the local CORS server for users serving the generated directory.
  cp "$REPO_ROOT/cors_server.py" "dist/cors_server.py"
node "$REPO_ROOT/scripts/deployment-manifest.mjs" write "$REPO_ROOT/dist"

echo ""
echo "=========================================="
echo "✓ DEPLOYMENT PROCESS COMPLETED"
echo "=========================================="
if [ "$CLEAN_BUILD" = true ]; then
    echo "Clean build completed successfully!"
else
    echo "Incremental build completed successfully!"
fi
echo "Output available in: dist/"
echo ""
echo "Note: Review above output for any ⚠ warnings"
echo "that may affect runtime functionality."
echo ""
echo "Tip: Use './build.sh -c' for a full clean build"
echo "=========================================="
