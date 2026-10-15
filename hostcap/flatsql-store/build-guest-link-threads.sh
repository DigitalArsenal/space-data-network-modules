#!/usr/bin/env bash
# Build hostcap/flatsql-store as a wasi-threads guest-link — the in-wasm FlatSQL
# store terminal for the OD flow. Same wasi-threads-target shell as the provider /
# provider guest-links (composes with the threaded od/provider nodes; the bake's
# dual-path gate rejects a single-thread emscripten object in a wasi-threads flow).
# Typed contracts (SDK 0.9.3): FlatBuffers-only ports, node config via the $PIV
# hostcall plugin.getConfig (sdm_piv::get_config). The arena itself is reached
# through the "flatsql" host trampolines (ingest_record / exec_envelope /
# query_rows / mark_deleted_bulk / compact): byte-movers over this module's
# memory into the separate flatsqlrt engine. NOT a Go sink, no fs calls.
#
# Produces dist/guest-link/{module-link.o, metadata.json, plugin-manifest.json}
# with threadModel "wasi-threads" and a UNIQUE full-pluginId-hex symbol prefix.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"                 # hostcap/flatsql-store
MODS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"                # space-data-network-modules
WASI_SDK_IMAGE="${WASI_SDK_IMAGE:-ghcr.io/webassembly/wasi-sdk:wasi-sdk-24}"
GL_DIST="$SCRIPT_DIR/dist/guest-link"
BUILD_DIR="$SCRIPT_DIR/.build-threads"
mkdir -p "$GL_DIST" "$BUILD_DIR"

# The typed-contracts headers (SDK 0.9.3: typedHostcall.hpp, the runtime IngestRequest/IngestResult/TimerTick/
# ModuleConfig headers, sds/PIV + sds/TAB, the FlatBuffers runtime, space_data_module_invoke.h) + common/sds_cid.hpp.
(cd "$SCRIPT_DIR" && node scripts/stage-headers.mjs "$BUILD_DIR/include")

PLUGIN_ID="$(node -e 'process.stdout.write(String(require(process.argv[1]).pluginId))' "$SCRIPT_DIR/plugin-manifest.json")"
PREFIX="$(node -e 'const id=process.argv[1];const h=Buffer.from(id,"utf8").toString("hex");process.stdout.write("sdm_guest_"+h+"_")' "$PLUGIN_ID")"
echo "pluginId=$PLUGIN_ID symbolPrefix=$PREFIX"

echo "Building flatsql-store guest-link via $WASI_SDK_IMAGE ..."
docker run --rm -v "$MODS_ROOT":/mods:ro -v "$BUILD_DIR":/work "$WASI_SDK_IMAGE" bash -lc "
set -e
NODE=/mods/hostcap/flatsql-store
CF=\"--target=wasm32-wasip1-threads -std=c++17 -O3 -matomics -mbulk-memory -fignore-exceptions -pthread -DNDEBUG\"
mkdir -p /work/gl
/opt/wasi-sdk/bin/clang++ \$CF -I/work/include -DFLATSQL_STORE_ENTRY=${PREFIX}store -c \$NODE/src/flatsql_store_module.cpp -o /work/gl/flatsql_store.o
/opt/wasi-sdk/bin/clang++ \$CF -c /mods/analysis/od/src/cpp/src/noexcept_stubs.cpp -o /work/gl/noexcept_stubs.o
/opt/wasi-sdk/bin/wasm-ld -r /work/gl/flatsql_store.o /work/gl/noexcept_stubs.o -o /work/module-link.o
echo '--- llvm-nm evidence (T=defined, U=undefined bake-resolved) ---'
/opt/wasi-sdk/bin/llvm-nm /work/module-link.o | grep -E '${PREFIX}store|ingest_record|exec_envelope|query_rows|mark_deleted_bulk|compact|plugin_push_output|plugin_get_input|sdm_piv_host' | head -20
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
    methodSymbols:{ store: prefix+"store" },
  }, null, 2)+"\n");
' "$GL_DIST/metadata.json" "$PREFIX"
cp "$SCRIPT_DIR/plugin-manifest.json" "$GL_DIST/plugin-manifest.json"

echo "=== flatsql-store guest-link complete ==="
ls -lh "$GL_DIST/module-link.o" "$GL_DIST/metadata.json"
cat "$GL_DIST/metadata.json"
