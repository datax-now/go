#!/usr/bin/env bash
set -euo pipefail

# Rebuild the R code in the plotting/evaluation stack with the exact R
# interpreter used by the deployment.  The emscripten package archives contain
# precompiled lazy-load databases from several R patch releases; mixing those
# databases can make R reject bytecode on a later execution.  Compiled
# libraries are built only in the native staging library below and are never
# copied into the WASM host environment.

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 R_BIN TARGET_LIBRARY SOURCE_CACHE_DIR" >&2
  exit 2
fi

R_BIN="$1"
TARGET_LIBRARY="$2"
SOURCE_CACHE_DIR="$3"

if [ ! -x "$R_BIN" ]; then
  echo "R executable not found or not executable: $R_BIN" >&2
  exit 1
fi
if [ ! -d "$TARGET_LIBRARY" ]; then
  echo "Target R library not found: $TARGET_LIBRARY" >&2
  exit 1
fi

DEPLOY_PREFIX="$(cd "$(dirname "$R_BIN")/.." && pwd)"
DEPLOY_LIBRARY="$DEPLOY_PREFIX/lib/R/library"
if [ ! -d "$DEPLOY_LIBRARY" ]; then
  echo "Native R dependency library not found: $DEPLOY_LIBRARY" >&2
  exit 1
fi

CRAN_BASE_URL="https://cran.r-project.org/src/contrib"
BUILD_FORMAT_VERSION="2"
MARKER_FILE="$TARGET_LIBRARY/.datax-r-no-bytecode-build"

# name|version|sha256|source location.  rlang and vctrs are pinned to the
# versions in environment-wasm-host.yml and therefore come from CRAN's archive.
SOURCE_PACKAGES=(
  "rlang|1.1.7|123c91e7eaacd3514a368a31c30617d36a874def37f6cafdacc0c7d1409be373|archive"
  "cpp11|0.5.5|72486beb0605c1229bf3d422cd536224af8dc09bd389a3116f62f4c7705c62f4|current"
  "vctrs|0.7.1|2f93519dfcffabc08bc508c2f47b5c23151cc667250b08a8b90be367ef1317c0|archive"
  "colorspace|2.1-3|47858800f9eed08cbcdbadba104b6502219c6f25f339c611161b374704cd03cc|archive"
  "farver|2.1.2|528823b95daab4566137711f1c842027a952bea1b2ae6ff098e2ca512b17fe25|archive"
  "isoband|0.3.0|fe8d3d58ca75bbee32f389152ac0058818f3f76f09c9867949531de7abc424ac|archive"
  "S7|0.2.2|6f33245dde05b74265b1c4d379e034bc3a8923d41e7b52e6e75a75ce97d42af7|current"
  "utf8|1.2.6|4589f8b72291329e70b7f3a8c20f2feb4e7764eebad2e6976bc9a3eee7686ce9|archive"
  "R6|2.6.1|59c6eba8b1b912eb7e104f65053235604be853425ee67c152ac4e86a1f2073b4|archive"
  "RColorBrewer|1.1-3|4f42f5423c45688b39f492c7892d93f37b4541831c8ffb140364d2bd89031ac0|archive"
  "labeling|0.4.3|c62f4fc2cc74377d7055903c5f1913b7295f7587456fe468592738a483e264f2|current"
  "munsell|0.5.1|03a2fd9ac40766cded96dfe33b143d872d0aaa262a25482ce19161ca959429a6|archive"
  "viridisLite|0.4.3|433be9bde66234dc76301fb4ffbbc9fc74bab5c14f4548d8ef2fc0065e121ef5|archive"
  "withr|3.0.3|d86c6454164fc85678bfc85e2a6cce42f7461d45fa9a87de71f376e7956c991e|archive"
  "lifecycle|1.0.5|61841e3e6edba056a88355a3f1d6698ab8d5d9cb3c05f2af0ec5a44ab516f8ee|archive"
  "gtable|0.3.6|d305a5fa11278b649d2d8edc5288bf28009be888a42be58ff8714018e49de0ef|archive"
  "scales|1.4.0|d55ef5f08c92652d7a95cfa27584024723ab17873f1b2577dd488cb7c883ceee|current"
  "ggplot2|4.0.1|77151025e8a17eaa043b2685421772e4e30a8a592493780f0a4583ca7b5e0ec4|archive"
  "evaluate|1.0.5|47aac79f889a828a5f8b4756cb972d7c2966bb984cbae17a4bd2389a73270794|archive"
  "generics|0.1.4|bbe95a097792d38fc3b7e677738af1b95b66ea5e5017e33b8beac6a6088d0801|archive"
  "crayon|1.5.3|3e74a0685541efb5ea763b92cfd5c859df71c46b0605967a0b5dbb7326e9da69|archive"
  "pkgconfig|2.0.3|330fef440ffeb842a7dcfffc8303743f1feae83e8d6131078b5a44ff11bc3850|archive"
  "pillar|1.11.1|056ce154238c9b5b8d5dcbcb52e1bc51d33870ce08c8a9ca9496478bd59f4653|archive"
  "tidyselect|1.2.1|169e97ba0bbfbcdf4a80534322751f87a04370310c40e27f04aac6525d45903c|archive"
  "repr|1.1.7|73bd696b4d4211096e0d1e382d5ce6591527d2ff400cc7ae8230f0235eed021b|archive"
  "IRdisplay|1.1|83eb030ff91f546cb647899f8aa3f5dc9fe163a89a981696447ea49cc98e8d2b|archive"
)

TARGET_PACKAGES=()
for record in "${SOURCE_PACKAGES[@]}"; do
  IFS='|' read -r package_name _ _ _ <<< "$record"
  TARGET_PACKAGES+=("$package_name")
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required" >&2
    exit 1
  fi
}

expected_marker() {
  local r_version
  r_version="$("$R_BIN" --vanilla --slave -e 'cat(as.character(getRversion()))')"
  {
    printf 'datax-r-no-bytecode-build-v%s\n' "$BUILD_FORMAT_VERSION"
    printf 'R=%s\n' "$r_version"
    for record in "${SOURCE_PACKAGES[@]}"; do
      IFS='|' read -r package_name _ package_sha _ <<< "$record"
      printf '%s=%s\n' "$package_name" "$package_sha"
    done
  }
}

MARKER_TMP="$(mktemp "${TMPDIR:-/tmp}/datax-r-marker.XXXXXX")"
BUILD_DIR=""
cleanup() {
  rm -f "$MARKER_TMP"
  if [ -n "$BUILD_DIR" ] && [ -d "$BUILD_DIR" ]; then
    rm -rf "$BUILD_DIR"
  fi
}
trap cleanup EXIT
expected_marker > "$MARKER_TMP"

packages_are_present=true
for package_name in "${TARGET_PACKAGES[@]}"; do
  if [ ! -d "$TARGET_LIBRARY/$package_name" ]; then
    packages_are_present=false
    break
  fi
done

if [ "$packages_are_present" = true ] && [ -f "$MARKER_FILE" ] && cmp -s "$MARKER_FILE" "$MARKER_TMP"; then
  echo "R no-bytecode package stack is already current; skipping rebuild."
  exit 0
fi

mkdir -p "$SOURCE_CACHE_DIR"

download_source() {
  local package_name="$1"
  local package_version="$2"
  local package_sha="$3"
  local source_location="$4"
  local filename="${package_name}_${package_version}.tar.gz"
  local destination="$SOURCE_CACHE_DIR/$filename"
  local current_url="$CRAN_BASE_URL/$filename"
  local archive_url="$CRAN_BASE_URL/Archive/$package_name/$filename"
  local temporary

  if [ -f "$destination" ] && [ "$(sha256_file "$destination")" = "$package_sha" ]; then
    return
  fi

  local urls=("$current_url" "$archive_url")
  if [ "$source_location" = "archive" ]; then
    urls=("$archive_url" "$current_url")
  fi

  # Try the configured source first, with the other CRAN location as fallback.
  for url in "${urls[@]}"; do
    temporary="$(mktemp "$SOURCE_CACHE_DIR/.${filename}.XXXXXX")"
    if command -v curl >/dev/null 2>&1; then
      if ! curl -fsSL --retry 3 --retry-delay 2 "$url" -o "$temporary"; then
        rm -f "$temporary"
        continue
      fi
    elif command -v wget >/dev/null 2>&1; then
      if ! wget -qO "$temporary" "$url"; then
        rm -f "$temporary"
        continue
      fi
    else
      rm -f "$temporary"
      echo "curl or wget is required to download R sources" >&2
      exit 1
    fi

    if [ "$(sha256_file "$temporary")" = "$package_sha" ]; then
      mv "$temporary" "$destination"
      return
    fi
    rm -f "$temporary"
  done

  echo "Unable to download a checksum-matching archive for $filename" >&2
  exit 1
}

echo "Fetching pinned R source packages..."
for record in "${SOURCE_PACKAGES[@]}"; do
  IFS='|' read -r package_name package_version package_sha source_location <<< "$record"
  download_source "$package_name" "$package_version" "$package_sha" "$source_location"
done

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/datax-r-source-build.XXXXXX")"
NATIVE_LIBRARY="$BUILD_DIR/library"
COMPILER_BIN="$BUILD_DIR/compiler-bin"
mkdir -p "$NATIVE_LIBRARY" "$COMPILER_BIN"

# repr writes every recorded plot to a temporary file before returning its
# MIME representation.  The CRAN implementation leaves that file behind,
# which is a permanent allocation in the WebAssembly filesystem.  Patch the
# pinned source so the file is removed on both success and error.
REPR_SOURCE_DIR="$BUILD_DIR/repr"
tar -xzf "$SOURCE_CACHE_DIR/repr_1.1.7.tar.gz" -C "$BUILD_DIR"
REPR_PLOT_SOURCE="$REPR_SOURCE_DIR/R/repr_recordedplot.r"
REPR_PLOT_SOURCE="$REPR_PLOT_SOURCE" python3 - <<'PY'
import os
from pathlib import Path

path = Path(os.environ["REPR_PLOT_SOURCE"])
source = path.read_text(encoding="utf-8")
old = "tf <- tempfile(fileext = ext)\n"
new = (
    "tf <- tempfile(fileext = ext)\n"
    "\ton.exit(unlink(tf), add = TRUE)\n"
)
if source.count(old) != 1:
    raise SystemExit("Unexpected repr_recordedplot.r tempfile layout")
path.write_text(source.replace(old, new, 1), encoding="utf-8")
PY

# R's conda Makeconf names a target compiler even though the deploy environment
# intentionally does not contain a compiler.  Native aliases let source
# packages compile into the disposable staging library without changing the
# deployment environment.
if command -v gcc >/dev/null 2>&1; then
  SYSTEM_CC="$(command -v gcc)"
else
  echo "gcc is required to rebuild R package sources" >&2
  exit 1
fi

supports_c_standard() {
  local standard="$1"
  printf '' | "$SYSTEM_CC" -x c "$standard" -E - >/dev/null 2>&1
}

supports_enum_base_type() {
  printf 'typedef enum :int { DATAX_FALSE = 0, DATAX_TRUE } datax_rboolean;\n' |
    "$SYSTEM_CC" -x c "$C_STANDARD_FALLBACK" -fsyntax-only - >/dev/null 2>&1
}

C_STANDARD_FALLBACK="-std=gnu23"
if ! supports_c_standard "$C_STANDARD_FALLBACK"; then
  if supports_c_standard "-std=gnu2x"; then
    C_STANDARD_FALLBACK="-std=gnu2x"
  elif supports_c_standard "-std=gnu17"; then
    C_STANDARD_FALLBACK="-std=gnu17"
  else
    echo "The available C compiler does not support gnu23, gnu2x, or gnu17" >&2
    exit 1
  fi
fi

R_CONFIG_COMPAT_INCLUDE=""
if ! supports_enum_base_type; then
  R_CONFIG_COMPAT_INCLUDE="$BUILD_DIR/r-include-compat"
  mkdir -p "$R_CONFIG_COMPAT_INCLUDE"
  cat > "$R_CONFIG_COMPAT_INCLUDE/Rconfig.h" <<'EOF'
#ifndef DATAX_RCONFIG_COMPAT_H
#define DATAX_RCONFIG_COMPAT_H
#include_next <Rconfig.h>
#undef HAVE_ENUM_BASE_TYPE
#endif
EOF
  echo "Using legacy R enum declarations for compiler compatibility."
fi

cat > "$COMPILER_BIN/normalize-c-standard" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

args=()
if [ -n "${DATAX_R_CONFIG_COMPAT_INCLUDE:-}" ]; then
  args+=("-I${DATAX_R_CONFIG_COMPAT_INCLUDE}")
fi
for arg in "$@"; do
  if [ "$arg" = "-std=gnu23" ]; then
    args+=("${DATAX_C_STANDARD_FALLBACK}")
  else
    args+=("$arg")
  fi
done

exec "${DATAX_REAL_C_COMPILER:?DATAX_REAL_C_COMPILER is required}" "${args[@]}"
EOF
chmod +x "$COMPILER_BIN/normalize-c-standard"
ln -s "$COMPILER_BIN/normalize-c-standard" "$COMPILER_BIN/x86_64-conda-linux-gnu-cc"
ln -s "$COMPILER_BIN/normalize-c-standard" "$COMPILER_BIN/x86_64-conda-linux-gnu-gcc"

if command -v g++ >/dev/null 2>&1; then
  SYSTEM_CXX="$(command -v g++)"
  for compiler_name in \
    x86_64-conda-linux-gnu-c++ \
    x86_64-conda-linux-gnu-g++ \
    x86_64-conda-linux-gnu-cxx; do
    ln -s "$SYSTEM_CXX" "$COMPILER_BIN/$compiler_name"
  done
else
  echo "g++ is required to rebuild R package sources" >&2
  exit 1
fi
for tool_name in ar ranlib; do
  if command -v "$tool_name" >/dev/null 2>&1; then
    ln -s "$(command -v "$tool_name")" "$COMPILER_BIN/x86_64-conda-linux-gnu-$tool_name"
  fi
done

# Seed the staging library with native dependencies from the deploy
# environment.  Source packages that are part of the pinned stack replace
# these symlinks as they are installed.
for package_dir in "$DEPLOY_LIBRARY"/*; do
  if [ -d "$package_dir" ]; then
    ln -s "$package_dir" "$NATIVE_LIBRARY/$(basename "$package_dir")"
  fi
done

SOURCE_ARGS=()
for record in "${SOURCE_PACKAGES[@]}"; do
  IFS='|' read -r package_name package_version _ _ <<< "$record"
  if [ "$package_name" = "repr" ]; then
    SOURCE_ARGS+=("$REPR_SOURCE_DIR")
  else
    SOURCE_ARGS+=("$SOURCE_CACHE_DIR/${package_name}_${package_version}.tar.gz")
  fi
done

echo "Building R source packages with --no-byte-compile..."
(
  export PATH="$COMPILER_BIN:$PATH"
  export DATAX_REAL_C_COMPILER="$SYSTEM_CC"
  export DATAX_C_STANDARD_FALLBACK="$C_STANDARD_FALLBACK"
  export DATAX_R_CONFIG_COMPAT_INCLUDE="$R_CONFIG_COMPAT_INCLUDE"
  export R_LIBS="$NATIVE_LIBRARY:$DEPLOY_LIBRARY"
  "$R_BIN" CMD INSTALL "${SOURCE_ARGS[@]}" \
    --no-byte-compile \
    --no-test-load \
    --library="$NATIVE_LIBRARY"
)

for record in "${SOURCE_PACKAGES[@]}"; do
  IFS='|' read -r package_name _ _ _ <<< "$record"
  if [ ! -d "$NATIVE_LIBRARY/$package_name" ]; then
    echo "Source build did not produce package: $package_name" >&2
    exit 1
  fi
done

echo "Copying R package code while preserving WASM shared libraries..."
NATIVE_LIBRARY="$NATIVE_LIBRARY" TARGET_LIBRARY="$TARGET_LIBRARY" python3 - <<'PY'
import os
import shutil
from pathlib import Path

native_library = Path(os.environ["NATIVE_LIBRARY"])
target_library = Path(os.environ["TARGET_LIBRARY"])

for source_package in sorted(native_library.iterdir()):
    if not source_package.is_dir() or source_package.is_symlink():
        continue

    target_package = target_library / source_package.name
    target_package.mkdir(parents=True, exist_ok=True)

    for source_entry in source_package.iterdir():
        if source_entry.name == "libs":
            continue

        target_entry = target_package / source_entry.name
        if target_entry.is_symlink() or target_entry.is_file():
            target_entry.unlink()
        elif target_entry.exists():
            shutil.rmtree(target_entry)

        if source_entry.is_dir():
            shutil.copytree(source_entry, target_entry)
        else:
            shutil.copy2(source_entry, target_entry)
PY

mv "$MARKER_TMP" "$MARKER_FILE"
MARKER_TMP=""
echo "R no-bytecode package stack rebuilt for $("$R_BIN" --vanilla --slave -e 'cat(as.character(getRversion()))')."
