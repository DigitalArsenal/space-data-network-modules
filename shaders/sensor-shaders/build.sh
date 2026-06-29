#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="${SDN_LOCAL_EMSDK_DIR:-$SCRIPT_DIR/deps/emsdk}"
SRC_DIR="$SCRIPT_DIR/src/cpp"
DIST_DIR="$SCRIPT_DIR/dist"
BROWSER_DIST_DIR="$DIST_DIR/browser"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"

ensure_emscripten() {
    local toolchain="${SDN_WASM_TOOLCHAIN:-local-emsdk}"

    export EM_CACHE="${EM_CACHE:-$SCRIPT_DIR/.emcache}"
    mkdir -p "$EM_CACHE"

    if [ "$toolchain" != "local-emsdk" ]; then
        echo "This repo requires repo-local deps/emsdk. Unsupported SDN_WASM_TOOLCHAIN=$toolchain" >&2
        exit 1
    fi

    if [ -L "$EMSDK_DIR" ] && [ ! -e "$EMSDK_DIR" ]; then
        rm "$EMSDK_DIR"
    fi
    if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
        echo "Cloning emsdk into deps/emsdk..."
        git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    fi
    if [ ! -f "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
        echo "Installing emsdk..."
        (
            cd "$EMSDK_DIR"
            ./emsdk install 6.0.1
            ./emsdk activate 6.0.1
        )
    fi

    # shellcheck disable=SC1090
    source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
}

find_flatbuffers_include_dir() {
    local candidates=(
        "${SDN_FLATBUFFERS_INCLUDE_DIR:-}"
        "${FLATBUFFERS_INCLUDE_DIR:-}"
        "$SCRIPT_DIR/../../../../flatbuffers/include"
        /opt/homebrew/include
        /opt/homebrew/opt/flatbuffers/include
        /usr/local/include
        /usr/local/opt/flatbuffers/include
    )
    local candidate
    for candidate in "${candidates[@]}"; do
        if [ -f "$candidate/flatbuffers/flatbuffers.h" ]; then
            echo "$candidate"
            return 0
        fi
    done

    echo "flatbuffers headers not found. Install flatbuffers and retry." >&2
    exit 1
}

node "$SCRIPT_DIR/generate-manifest-header.mjs"
ensure_emscripten

FLATBUFFERS_INCLUDE_DIR="$(find_flatbuffers_include_dir)"

rm -rf "$DIST_DIR"
mkdir -p "$BROWSER_DIST_DIR" "$ISOMORPHIC_DIST_DIR"

echo "Building browser-compatible standalone artifact..."
em++ \
    "$SRC_DIR/src/plugin_entrypoints.cpp" \
    "$SRC_DIR/src/plugin_invoke_bridge.cpp" \
    -std=c++17 \
    -O3 \
    -flto \
    -I"$SRC_DIR/include" \
    -I"$SRC_DIR/generated" \
    -I"$FLATBUFFERS_INCLUDE_DIR" \
    -s EXPORTED_FUNCTIONS='["_plugin_alloc","_plugin_free","_plugin_invoke_stream","_plugin_get_manifest_flatbuffer","_plugin_get_manifest_flatbuffer_size","_sensor_shaders_set_bundle_json","_sensor_shaders_stream_cleanup","_get_name","_get_version","_get_type"]' \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME='SensorShadersModule' \
    -s STANDALONE_WASM=1 \
    -s INITIAL_MEMORY=16777216 \
    -s FILESYSTEM=0 \
    -s MALLOC=emmalloc \
    -s ENVIRONMENT=web,worker,node \
    --no-entry \
    -o "$BROWSER_DIST_DIR/module.js"

cp "$BROWSER_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"

BROWSER_MODULE_OUT="$BROWSER_DIST_DIR/module.js" node --input-type=module <<'NODE'
import fs from "node:fs";

const outputPath = process.env.BROWSER_MODULE_OUT;
if (!outputPath) {
  throw new Error("BROWSER_MODULE_OUT must be set.");
}

let source = fs.readFileSync(outputPath, "utf8");
source = source
  .replaceAll('import("node:module")', 'import(["node","module"].join(":"))')
  .replaceAll('require("node:fs")', 'require(["node","fs"].join(":"))')
  .replaceAll('require("node:path")', 'require(["node","path"].join(":"))')
  .replaceAll('require("node:url")', 'require(["node","url"].join(":"))');

fs.writeFileSync(outputPath, source);
NODE

echo ""
echo "=== Build Complete ==="
ls -lh "$BROWSER_DIST_DIR/module.js" "$BROWSER_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"
