#!/bin/bash
# Rebuilds od-fit-core.o (NOTICE.md): analysis/od's own fitter sources at the base revision (its deps/ trees are never
# extracted), od-fit-core-source.patch applied, the clean-room SGP4/SDP4 base foundation/sgp4-str3, compiled with
# wasi-sdk 30.0 and partial-linked into <directory>/od-fit-core.o (default: here; the file name is in the object).
# Prints the object's SHA-256; build.mjs refuses any other object.
# The toolchains are the pins of scripts/toolchain.mjs (docs/BUILDING.md) unless named:
#   [WASI_SDK_PATH=<wasi-sdk-30.0>] [SDN_OD_EIGEN_DIR=<eigen3>] [SDN_FLATBUFFERS_INCLUDE=<flatbuffers/include>] \
#     ./build-fit-core.sh [directory]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
base=551f6e178c3332cad46171fd1a0002345271144c
out="${1:-$here}/od-fit-core.o"
toolchain="$repo/scripts/toolchain.mjs"
sdk="${WASI_SDK_PATH:-$(node "$toolchain" path wasi-sdk)}"
eigen="${SDN_OD_EIGEN_DIR:-$(node "$toolchain" path eigen)}"
flatbuffers="${SDN_FLATBUFFERS_INCLUDE:-$(node "$toolchain" path flatbuffers)}"
for need in "$sdk/bin/clang++" "$sdk/bin/wasm-ld" "$eigen/Eigen/Dense" "$flatbuffers/flatbuffers/flatbuffers.h"; do
  [ -e "$need" ] || { echo "missing $need" >&2; exit 1; }
done

work="$(mktemp -d "${TMPDIR:-/tmp}/od-fit-core.XXXXXX")"
trap 'rm -rf "$work"' EXIT
src="$work/src"
git init -q "$src"
git -C "$repo" ls-tree -r --name-only "$base" -- analysis/od/src/cpp common licensing/core/src/cpp/generated/sds |
  grep -v '^analysis/od/src/cpp/deps/' |
  while read -r file; do
    mkdir -p "$src/$(dirname "$file")"
    git -C "$repo" show "$base:$file" > "$src/$file"
  done
git -C "$src" apply "$here/od-fit-core-source.patch"

od="$src/analysis/od/src/cpp"
flags=(--target=wasm32-wasip1-threads -std=c++17 -O3 -matomics -mbulk-memory -fignore-exceptions -pthread -DNDEBUG
  -DEIGEN_DONT_PARALLELIZE -ffast-math
  -I"$od/include" -I"$od/src" -I"$src/common" -I"$repo/foundation/sgp4-str3/include" -I"$eigen" -I"$flatbuffers"
  -I"$src/licensing/core/src/cpp/generated/sds")
objects=()
pids=()
for unit in sgp4_fitter meme_parser frame_transform oem_parser oem_fb_reader omm_fb_builder obd_fb_builder \
  ocm_fb_builder plugin_runtime od_batch_fit noexcept_stubs; do
  "$sdk/bin/clang++" "${flags[@]}" -c "$od/src/$unit.cpp" -o "$work/$unit.o" 2> "$work/$unit.log" &
  pids+=("$!")
  objects+=("$work/$unit.o")
done
for index in "${!pids[@]}"; do
  wait "${pids[$index]}" || { cat "${objects[$index]%.o}.log" >&2; exit 1; }
done
"$sdk/bin/wasm-ld" -r "${objects[@]}" -o "$out"
shasum -a 256 "$out"
