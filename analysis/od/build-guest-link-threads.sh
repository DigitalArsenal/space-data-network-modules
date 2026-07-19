#!/usr/bin/env bash
# Build the THREADED analysis/od guest-link object for wasi-threads flow bake:
#   dist/guest-link/{module-link.o, metadata.json, plugin-manifest.json}
#
# Unlike the legacy single-thread guest-link (od/build.sh, em++ / emscripten
# target, threadModel single-thread, `fit` = one $OEM), this produces a
# wasm32-wasip1-threads relocatable object whose `fit` entry threads a 1..N $OEM
# batch across od::run_batch_fit's bounded std::thread pool. The bake links it
# into the composed wasi-threads runtime.wasm.
#
# Recipe (matches the enforced wasi-threads contract, minus the final --shared/
# --import-memory link which the BAKE applies): each TU compiled with the hermetic
# wasi-sdk-24 clang `--target=wasm32-wasip1-threads -matomics -mbulk-memory
# -fignore-exceptions -O3`; the ENTRY glue renamed via the SDK convention
# `-Dfit=<prefix>fit` (prefix = sdm_guest_<hex(pluginId)[:24]>_); `wasm-ld -r`
# partial-links all objects, PRESERVING the atomics/bulk-memory target features
# and leaving the emit/consume ABI (plugin_push_output*/plugin_get_input_frame/
# plugin_find_input_index/plugin_reset_output_state/plugin_set_error) UNDEFINED.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OD="$SCRIPT_DIR/src/cpp"
MODS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MP_ROOT="$(cd "$MODS_ROOT/.." && pwd)"
SDS_DIR="$MODS_ROOT/licensing/core/src/cpp/generated/sds"
FB_DIR="$MP_ROOT/flatbuffers/include"
WASI_SDK_IMAGE="${WASI_SDK_IMAGE:-ghcr.io/webassembly/wasi-sdk:wasi-sdk-24}"
GL_DIST="$SCRIPT_DIR/dist/guest-link"
BUILD_DIR="$SCRIPT_DIR/.build-threads"
mkdir -p "$GL_DIST" "$BUILD_DIR"

# Guest-link symbol prefix = "sdm_guest_" + hex(pluginId)[:24] + "_" (mirrors the
# SDK guestLinkSymbolPrefix EXACTLY).
PLUGIN_ID="$(node -e 'process.stdout.write(String(require(process.argv[1]).pluginId))' "$SCRIPT_DIR/plugin-manifest.json")"
PREFIX="$(node -e 'const id=process.argv[1];const h=Buffer.from(id,"utf8").toString("hex");process.stdout.write("sdm_guest_"+h.slice(0,24)+"_")' "$PLUGIN_ID")"
echo "pluginId=$PLUGIN_ID  symbolPrefix=$PREFIX"

EIGEN_SRC="$(cd "${SDN_OD_EIGEN_DIR:-/opt/homebrew/include/eigen3}" && pwd -P)"
if [ ! -f "$BUILD_DIR/eigen3/Eigen/Dense" ]; then
  rm -rf "$BUILD_DIR/eigen3"; cp -RL "$EIGEN_SRC/" "$BUILD_DIR/eigen3/"
fi

# od_lib TUs + Vallado + threaded batch core + weak exception stubs.
LIB_TUS=(
  src/sgp4_fitter.cpp src/meme_parser.cpp src/frame_transform.cpp
  src/oem_parser.cpp src/oem_fb_reader.cpp src/omm_fb_builder.cpp
  src/obd_fb_builder.cpp src/ocm_fb_builder.cpp src/plugin_runtime.cpp
  deps/vallado-sgp4/SGP4.cpp src/od_batch_fit.cpp src/noexcept_stubs.cpp
)

echo "Building threaded guest-link object via $WASI_SDK_IMAGE ..."
docker run --rm -v "$MP_ROOT":/mp -v "$BUILD_DIR":/work "$WASI_SDK_IMAGE" bash -lc "
set -e
OD=/mp/space-data-network-modules/analysis/od/src/cpp
INC=\"-I\$OD/include -I\$OD/src -I\$OD/deps/vallado-sgp4 -I/work/eigen3 -I/mp/flatbuffers/include -I/mp/space-data-network-modules/licensing/core/src/cpp/generated/sds\"
CF=\"--target=wasm32-wasip1-threads -std=c++17 -O3 -matomics -mbulk-memory -fignore-exceptions -pthread -DNDEBUG -DEIGEN_DONT_PARALLELIZE -ffast-math\"
mkdir -p /work/gl
OBJS=''
for tu in ${LIB_TUS[*]}; do
  o=/work/gl/\$(basename \${tu%.cpp}).o
  /opt/wasi-sdk/bin/clang++ \$CF \$INC -c \$OD/\$tu -o \$o
  OBJS=\"\$OBJS \$o\"
done
# ENTRY glue: rename ONLY the method symbol so metadata.json[fit] is unique.
/opt/wasi-sdk/bin/clang++ \$CF \$INC -D fit=${PREFIX}fit -c \$OD/guest-link/od_batch_fit_entry.cpp -o /work/gl/od_batch_fit_entry.o
OBJS=\"\$OBJS /work/gl/od_batch_fit_entry.o\"
# Partial-link (relocatable) — preserves atomics/bulk-memory features, keeps ABI undefined.
/opt/wasi-sdk/bin/wasm-ld -r \$OBJS -o /work/module-link.o
echo '--- llvm-nm evidence (T=defined text, U=undefined import) ---'
/opt/wasi-sdk/bin/llvm-nm /work/module-link.o | grep -E '${PREFIX}fit|plugin_push_output|plugin_get_input_frame|plugin_find_input_index|wasi.thread' || true
"
cp "$BUILD_DIR/module-link.o" "$GL_DIST/module-link.o"

# metadata.json — threadModel emscripten-pthreads (the wasi-threads model), the
# prefixed batch `fit` entry the baker links.
node -e '
  const fs=require("fs");
  const out=process.argv[1], prefix=process.argv[2];
  fs.writeFileSync(out, JSON.stringify({
    version:1, format:"wasm-object", language:"c++",
    threadModel:"emscripten-pthreads", symbolPrefix:prefix,
    methodSymbols:{ fit: prefix+"fit" },
  }, null, 2)+"\n");
' "$GL_DIST/metadata.json" "$PREFIX"
cp "$SCRIPT_DIR/plugin-manifest.json" "$GL_DIST/plugin-manifest.json"

echo ""; echo "=== Threaded guest-link build complete ==="
ls -lh "$GL_DIST/module-link.o" "$GL_DIST/metadata.json"
cat "$GL_DIST/metadata.json"
