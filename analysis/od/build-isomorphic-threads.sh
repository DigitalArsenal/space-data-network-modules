#!/usr/bin/env bash
# Build the ONE isomorphic wasi-threads OD module -> dist/isomorphic/module.wasm.
#
# Toolchain: the hermetic wasi-sdk-24 Docker image (the local homebrew wasi
# toolchain is unreliable; this image is reproducible and is what the deploy node
# uses too). The exact flags are the SDK's enforced wasi-threads contract:
#   clang --target=wasm32-wasip1-threads  -matomics -mbulk-memory -pthread
#   link: -Wl,--import-memory -Wl,--export-memory -Wl,--shared-memory
#         -Wl,--max-memory=2147483648
# Objects are -fignore-exceptions (the OD sources use try/catch; the wasi-threads
# libc++ is exception-free — -fno-exceptions won't compile them and -fwasm-
# exceptions emits exnref WasmEdge's AOT can't parse). noexcept_stubs.cpp supplies
# the __cxa_* symbols an explicit `throw` (error paths only) would otherwise need.
# Memory is BOTH imported (browser SharedArrayBuffer) AND exported (WASI/WasmEdge/
# kubo FindMemory("memory")). The emitted wasm is validated by the SDK
# assertPthreadArtifact guard; a non-isomorphic artifact FAILS this build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OD="$SCRIPT_DIR/src/cpp"
MODS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"                     # space-data-network-modules
MP_ROOT="$(cd "$MODS_ROOT/.." && pwd)"                           # main-packages
SDS_DIR="$MODS_ROOT/licensing/core/src/cpp/generated/sds"
FB_DIR="$MP_ROOT/flatbuffers/include"
SDK_DIR="${SDN_MODULE_SDK_DIR:-$(cd "$MP_ROOT/../ancillary-packages/space-data-module-sdk" && pwd)}"
WASI_SDK_IMAGE="${WASI_SDK_IMAGE:-ghcr.io/webassembly/wasi-sdk:wasi-sdk-24}"

DIST_ISO="$SCRIPT_DIR/dist/isomorphic"
BUILD_DIR="$SCRIPT_DIR/.build-threads"
mkdir -p "$DIST_ISO" "$BUILD_DIR"

# Eigen: Docker cannot mount /opt/homebrew; copy the resolved headers into a
# mountable build dir (once).
EIGEN_SRC="$(cd "${SDN_OD_EIGEN_DIR:-/opt/homebrew/include/eigen3}" && pwd -P)"
if [ ! -f "$BUILD_DIR/eigen3/Eigen/Dense" ]; then
  echo "Copying Eigen headers into build dir..."
  rm -rf "$BUILD_DIR/eigen3"
  cp -RL "$EIGEN_SRC/" "$BUILD_DIR/eigen3/"
fi
[ -f "$BUILD_DIR/eigen3/Eigen/Dense" ] || { echo "ERROR: Eigen not found (set SDN_OD_EIGEN_DIR)"; exit 1; }
[ -f "$SDS_DIR/OCM_generated.h" ] || { echo "ERROR: SDS generated headers missing at $SDS_DIR"; exit 1; }
[ -f "$FB_DIR/flatbuffers/flatbuffers.h" ] || { echo "ERROR: flatbuffers headers missing at $FB_DIR"; exit 1; }

# Translation units: SACRED OD fit library + the new threaded orchestrator/entry
# + covariance/OCM + exception stubs. (orbit_determination.cpp/wasm_api.cpp/the
# old emscripten plugin_invoke_bridge are NOT included — the wasi-threads entry
# is od_isomorphic_main.cpp.)
TUS=(
  src/sgp4_fitter.cpp
  src/meme_parser.cpp
  src/frame_transform.cpp
  src/oem_parser.cpp
  src/oem_fb_reader.cpp
  src/omm_fb_builder.cpp
  src/obd_fb_builder.cpp
  src/ocm_fb_builder.cpp
  src/plugin_runtime.cpp
  deps/vallado-sgp4/SGP4.cpp
  src/od_batch_fit.cpp
  src/od_isomorphic_main.cpp
  src/noexcept_stubs.cpp
)
SRCS=()
for t in "${TUS[@]}"; do SRCS+=("/mp/space-data-network-modules/analysis/od/src/cpp/$t"); done

echo "Building dist/isomorphic/module.wasm via $WASI_SDK_IMAGE ..."
docker run --rm -v "$MP_ROOT":/mp -v "$BUILD_DIR":/work "$WASI_SDK_IMAGE" bash -lc "
set -e
/opt/wasi-sdk/bin/clang++ --target=wasm32-wasip1-threads \
  -std=c++17 -O3 -matomics -fignore-exceptions -pthread -mbulk-memory -DNDEBUG -DEIGEN_DONT_PARALLELIZE -ffast-math \
  -I/mp/space-data-network-modules/analysis/od/src/cpp/include \
  -I/mp/space-data-network-modules/analysis/od/src/cpp/deps/vallado-sgp4 \
  -I/work/eigen3 -I/mp/flatbuffers/include \
  -I/mp/space-data-network-modules/licensing/core/src/cpp/generated/sds \
  ${SRCS[*]} \
  -pthread -matomics -mbulk-memory -Wl,--import-memory -Wl,--export-memory -Wl,--shared-memory -Wl,--max-memory=2147483648 \
  -Wl,--export=plugin_invoke_stream -Wl,--export=plugin_alloc -Wl,--export=plugin_free \
  -o /work/module.wasm 2>&1 | grep -viE 'warning:|note:|\\^|~~|In file included|generated\\.|\\| ' || true
test -f /work/module.wasm
"
cp "$BUILD_DIR/module.wasm" "$DIST_ISO/module.wasm"
echo "Built: $DIST_ISO/module.wasm ($(wc -c < "$DIST_ISO/module.wasm") bytes)"

echo "Validating with SDK pthreadArtifactGuard..."
node --input-type=module -e "
import { analyzeWasmThreadFeatures, assertPthreadArtifact } from '$SDK_DIR/src/compiler/index.js';
import { readFileSync } from 'node:fs';
const b = readFileSync('$DIST_ISO/module.wasm');
const a = analyzeWasmThreadFeatures(b);
console.log('threadFeatures:', JSON.stringify({sharedMemory:a.hasSharedMemory, atomics:a.usesAtomics, atomicCount:a.atomicInstructionCount, wasiThreadSpawnImport:a.hasWasiThreadSpawnImport, wasiThreadStartExport:a.hasWasiThreadStartExport, emscriptenHooks:a.emscriptenThreadHooks, isIsomorphicPthreads:a.isIsomorphicPthreads}));
assertPthreadArtifact(b, { source: '$DIST_ISO/module.wasm' });
console.log('pthreadArtifactGuard: PASS');
"
echo "OK."
