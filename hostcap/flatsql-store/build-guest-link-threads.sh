#!/usr/bin/env bash
# Build hostcap/flatsql-store as a wasi-threads guest-link — the in-wasm FlatSQL
# store terminal for the OD flow. Same wasi-threads-target shell as the provider /
# provider guest-links (composes with the threaded od/provider nodes; the bake's
# dual-path gate rejects a single-thread emscripten object in a wasi-threads flow).
# The store terminal is the flatsql engine via a SINGLE opaque host trampoline —
# import_module("flatsql")/import_name("exec_envelope"): the node builds a typed
# statement envelope in ITS OWN memory (all record semantics in C++) and the host
# marshals it into the separate flatsqlrt engine and returns rows affected. NOT a
# Go sink, no engine-memory-crossing, no fs calls.
#
# Produces dist/guest-link/{module-link.o, metadata.json, plugin-manifest.json}
# with threadModel "wasi-threads" and a UNIQUE full-pluginId-hex symbol prefix.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"                 # hostcap/flatsql-store
MODS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"                # space-data-network-modules
MP_ROOT="$(cd "$MODS_ROOT/.." && pwd)"                       # main-packages
WASI_SDK_IMAGE="${WASI_SDK_IMAGE:-ghcr.io/webassembly/wasi-sdk:wasi-sdk-24}"
GL_DIST="$SCRIPT_DIR/dist/guest-link"
BUILD_DIR="$SCRIPT_DIR/.build-threads"
mkdir -p "$GL_DIST" "$BUILD_DIR"

PLUGIN_ID="$(node -e 'process.stdout.write(String(require(process.argv[1]).pluginId))' "$SCRIPT_DIR/plugin-manifest.json")"
PREFIX="$(node -e 'const id=process.argv[1];const h=Buffer.from(id,"utf8").toString("hex");process.stdout.write("sdm_guest_"+h+"_")' "$PLUGIN_ID")"
echo "pluginId=$PLUGIN_ID symbolPrefix=$PREFIX"

STUBS="/mp/space-data-network-modules/analysis/od/src/cpp/src/noexcept_stubs.cpp"

echo "Building flatsql-store guest-link via $WASI_SDK_IMAGE ..."
docker run --rm -v "$MP_ROOT":/mp -v "$BUILD_DIR":/work "$WASI_SDK_IMAGE" bash -lc "
set -e
MODS=/mp/space-data-network-modules
NODE=\$MODS/hostcap/flatsql-store
INC=\"-I\$MODS/analysis/od/src/cpp/include\"
CF=\"--target=wasm32-wasip1-threads -std=c++17 -O3 -matomics -mbulk-memory -fignore-exceptions -pthread -DNDEBUG\"
mkdir -p /work/gl
/opt/wasi-sdk/bin/clang++ \$CF \$INC -Dstore=${PREFIX}store -c \$NODE/src/flatsql_store_module.cpp -o /work/gl/flatsql_store.o
/opt/wasi-sdk/bin/clang++ \$CF -c $STUBS -o /work/gl/noexcept_stubs.o
/opt/wasi-sdk/bin/wasm-ld -r /work/gl/flatsql_store.o /work/gl/noexcept_stubs.o -o /work/module-link.o
echo '--- llvm-nm evidence (T=defined, U=undefined bake-resolved) ---'
/opt/wasi-sdk/bin/llvm-nm /work/module-link.o | grep -E '${PREFIX}store|flatsql_exec_envelope|plugin_push_output|plugin_find_input_index|sdm_host_call' | head
echo '--- NO sdm_host_call (no Go sink) expected above ---'
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
