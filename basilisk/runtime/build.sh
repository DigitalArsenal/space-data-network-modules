#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_ROOT="${SPACE_DATA_MODULE_SDK_ROOT:-$(cd "$SCRIPT_DIR/../../.." && pwd)/space-data-module-sdk}"
EMSDK_DIR="${SDN_LOCAL_EMSDK_DIR:-$SCRIPT_DIR/deps/emsdk}"
DIST_DIR="$SCRIPT_DIR/dist/isomorphic"

ensure_emscripten() {
    export EM_CACHE="${EM_CACHE:-$SCRIPT_DIR/.emcache}"
    mkdir -p "$EM_CACHE"

    if [ -L "$EMSDK_DIR" ] && [ ! -e "$EMSDK_DIR" ]; then
        rm "$EMSDK_DIR"
    fi
    if [ ! -f "$EMSDK_DIR/emsdk_env.sh" ]; then
        echo "Cloning emsdk into $EMSDK_DIR..."
        git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    fi
    if [ ! -f "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
        echo "Installing emsdk..."
        (
            cd "$EMSDK_DIR"
            ./emsdk install 5.0.7
            ./emsdk activate 5.0.7
        )
    fi

    # shellcheck disable=SC1090
    source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
}

if [ ! -f "$SDK_ROOT/bin/space-data-module.js" ]; then
    echo "SPACE_DATA_MODULE_SDK_ROOT must point to a space-data-module-sdk checkout." >&2
    echo "Resolved SDK root: $SDK_ROOT" >&2
    exit 1
fi

ensure_emscripten

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

node "$SDK_ROOT/bin/space-data-module.js" compile \
    --manifest "$SCRIPT_DIR/plugin-manifest.json" \
    --source "$SCRIPT_DIR/src/module.c" \
    --out "$DIST_DIR/module.wasm"
