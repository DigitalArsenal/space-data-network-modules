#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_VERSION="6.0.1"
# shellcheck source=../../scripts/lib/emsdk-shared.sh
. "$SCRIPT_DIR/../../scripts/lib/emsdk-shared.sh"
EMSDK_DIR="$(sdn_emsdk_dir "$SCRIPT_DIR" "$EMSDK_VERSION")"
SRC_DIR="$SCRIPT_DIR/src/cpp"
BUILD_DIR="$SRC_DIR/build-isomorphic"
DIST_DIR="$SCRIPT_DIR/dist"
BROWSER_DIST_DIR="$DIST_DIR/browser"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"
BROWSER_TARGET="atmosphere_wasm"

cpu_count() {
    if command -v nproc >/dev/null 2>&1; then
        nproc
        return
    fi
    if command -v getconf >/dev/null 2>&1; then
        getconf _NPROCESSORS_ONLN
        return
    fi
    if command -v sysctl >/dev/null 2>&1 && sysctl -n hw.ncpu >/dev/null 2>&1; then
        sysctl -n hw.ncpu
        return
    fi
    echo 4
}

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
            ./emsdk install "$EMSDK_VERSION"
            ./emsdk activate "$EMSDK_VERSION"
        )
    fi

    # shellcheck disable=SC1090
    source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
    sdn_emsdk_assert_active "$EMSDK_DIR" "$EMSDK_VERSION"
}

ensure_emscripten

# SDS bindings come from the published spacedatastandards.org package
# (npm ci first); they are regenerated so they never drift from the pin.
node "$SCRIPT_DIR/generate-sds-headers.mjs"

node "$SCRIPT_DIR/../../scripts/generate-plugin-manifest-header.mjs" \
    --package-dir "$SCRIPT_DIR" \
    --var atmosphere_plugin_manifest_bytes \
    --guard ATMOSPHERE_PLUGIN_MANIFEST_BYTES_H

rm -rf "$BUILD_DIR"
rm -rf "$DIST_DIR"
mkdir -p "$BROWSER_DIST_DIR" "$ISOMORPHIC_DIST_DIR"

echo "Configuring Emscripten build..."
emcmake cmake -S "$SRC_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release

echo ""
echo "Building browser-compatible standalone artifact..."
cmake --build "$BUILD_DIR" --target "$BROWSER_TARGET" -j"$(cpu_count)"

cp "$BUILD_DIR/${BROWSER_TARGET}.js" "$BROWSER_DIST_DIR/module.js"
cp "$BUILD_DIR/${BROWSER_TARGET}.wasm" "$BROWSER_DIST_DIR/module.wasm"
cp "$BUILD_DIR/${BROWSER_TARGET}.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"

echo ""
echo "=== Build Complete ==="
ls -lh "$BROWSER_DIST_DIR/module.js" "$BROWSER_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"
