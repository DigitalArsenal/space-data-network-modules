#!/usr/bin/env bash
# Build a data-source provider's OD-flow guest-link object for the wasi-threads
# bake: data-source/<provider>/dist/guest-link/{module-link.o, metadata.json,
# plugin-manifest.json}.
#
# Usage: build-provider-guest-link.sh <provider-dir-name>
#   e.g. build-provider-guest-link.sh iss-source
#
# The provider's fetch+parse is REUSED verbatim: guest-link/emit_entry.cpp
# #includes the provider's src/*.cpp (run_pull) and pushes each $OEM on the "oem"
# port. Compiled as a wasm32-wasip1-threads relocatable object (matching the
# threaded analysis/od guest-link so they compose in ONE wasi-threads bake), with
# the SDK guest-link rename applied to the `emit` entry (and plugin_invoke_stream
# neutralised to a per-provider-unique symbol to avoid a duplicate at bake). The
# emit ABI (plugin_push_output_ex/…) and the fetch hostcall (sdm_host_call via
# ps::http_get) stay UNDEFINED — bake-resolved.
set -euo pipefail

PROV="${1:?usage: build-provider-guest-link.sh <provider-dir-name>}"
DS_DIR="$(cd "$(dirname "$0")" && pwd)"                    # data-source/
MODS_ROOT="$(cd "$DS_DIR/.." && pwd)"                       # space-data-network-modules
MP_ROOT="$(cd "$MODS_ROOT/.." && pwd)"                      # main-packages
PROV_DIR="$DS_DIR/$PROV"
[ -d "$PROV_DIR" ] || { echo "no such provider: $PROV_DIR"; exit 1; }

SRC_CPP="$(ls "$PROV_DIR/src/"*.cpp 2>/dev/null | grep -viE 'manifest|exports' | head -1)"
[ -n "$SRC_CPP" ] || { echo "no provider source .cpp under $PROV_DIR/src"; exit 1; }
SRC_BASE="$(basename "$SRC_CPP")"
WASI_SDK_IMAGE="${WASI_SDK_IMAGE:-ghcr.io/webassembly/wasi-sdk:wasi-sdk-24}"
GL_DIST="$PROV_DIR/dist/guest-link"
BUILD_DIR="$PROV_DIR/.build-threads"
mkdir -p "$GL_DIST" "$BUILD_DIR"

PLUGIN_ID="$(node -e 'process.stdout.write(String(require(process.argv[1]).pluginId))' "$PROV_DIR/plugin-manifest.json")"
# UNIQUE per-pluginId prefix = "sdm_guest_" + FULL hex(pluginId) + "_".
# NOTE: this deliberately extends the SDK's hex[:24] convention. That 12-byte
# truncation COLLIDES for pluginIds sharing a 12-byte head — e.g.
# com.orbpro.iss-source and com.orbpro.intelsat-source both hash to
# sdm_guest_636f6d2e6f726270726f2e69_ — which would duplicate `<prefix>emit` when
# both are composed into ONE flow runtime.wasm. The bake reads symbolPrefix from
# metadata.json (kubo sdn/flowcc/nodedata.go:180), so a full-hex prefix composes
# correctly and uniquely. (Flag for the SDK: guestLinkSymbolPrefix should not
# truncate to 12 bytes.)
PREFIX="$(node -e 'const id=process.argv[1];const h=Buffer.from(id,"utf8").toString("hex");process.stdout.write("sdm_guest_"+h+"_")' "$PLUGIN_ID")"
echo "provider=$PROV pluginId=$PLUGIN_ID symbolPrefix=$PREFIX src=$SRC_BASE"

# The SDK host-cpp headers (keyslotClient.hpp, pulled in by provider_source.hpp)
# live behind a node_modules symlink that points OUTSIDE the mounted tree; copy
# them into the mounted build dir so the hermetic wasi-sdk container can -I them.
mkdir -p "$BUILD_DIR/sdkhost"
cp -L "$MODS_ROOT/node_modules/space-data-module-sdk/src/host/cpp/"*.hpp "$BUILD_DIR/sdkhost/" 2>/dev/null || true

# noexcept stubs (weak) — reused from analysis/od so the bake composes without
# duplicate __cxa_* (wasi-threads libc++ is exception-free).
STUBS="/mp/space-data-network-modules/analysis/od/src/cpp/src/noexcept_stubs.cpp"

echo "Building $PROV guest-link via $WASI_SDK_IMAGE ..."
docker run --rm -v "$MP_ROOT":/mp -v "$BUILD_DIR":/work "$WASI_SDK_IMAGE" bash -lc "
set -e
MODS=/mp/space-data-network-modules
PROV=\$MODS/data-source/$PROV
INC=\"-I\$PROV/guest-link -I\$PROV/src -I\$MODS/common -I\$MODS/licensing/core/src/cpp/generated/sds -I/work/sdkhost -I/mp/flatbuffers/include -I\$MODS/analysis/od/src/cpp/include\"
CF=\"--target=wasm32-wasip1-threads -std=c++17 -O3 -matomics -mbulk-memory -fignore-exceptions -pthread -DNDEBUG -DEIGEN_DONT_PARALLELIZE -ffast-math\"
mkdir -p /work/gl
# emit_entry.cpp (includes the provider src): rename the emit method (SDK
# convention) and neutralise plugin_invoke_stream to a per-provider-unique symbol.
/opt/wasi-sdk/bin/clang++ \$CF \$INC -Demit=${PREFIX}emit -Dplugin_invoke_stream=${PREFIX}pis -Dplugin_alloc=${PREFIX}palloc -Dplugin_free=${PREFIX}pfree -c \$PROV/guest-link/emit_entry.cpp -o /work/gl/emit_entry.o
/opt/wasi-sdk/bin/clang++ \$CF -c $STUBS -o /work/gl/noexcept_stubs.o
/opt/wasi-sdk/bin/wasm-ld -r /work/gl/emit_entry.o /work/gl/noexcept_stubs.o -o /work/module-link.o
echo '--- llvm-nm evidence (T=defined, U=undefined bake-resolved) ---'
/opt/wasi-sdk/bin/llvm-nm /work/module-link.o | grep -E '${PREFIX}emit|plugin_push_output|plugin_find_input_index|sdm_host_call|run_pull' | head
echo '--- target_features ---'
/opt/wasi-sdk/bin/llvm-objdump --section=target_features -s /work/module-link.o 2>/dev/null | strings | grep -iE 'atomics|bulk' | head -1
"
cp "$BUILD_DIR/module-link.o" "$GL_DIST/module-link.o"

node -e '
  const fs=require("fs");
  const out=process.argv[1], prefix=process.argv[2];
  fs.writeFileSync(out, JSON.stringify({
    version:1, format:"wasm-object", language:"c++",
    threadModel:"wasi-threads", symbolPrefix:prefix,
    methodSymbols:{ emit: prefix+"emit" },
  }, null, 2)+"\n");
' "$GL_DIST/metadata.json" "$PREFIX"
cp "$PROV_DIR/plugin-manifest.json" "$GL_DIST/plugin-manifest.json"

echo "=== $PROV guest-link complete ==="
ls -lh "$GL_DIST/module-link.o" "$GL_DIST/metadata.json"
