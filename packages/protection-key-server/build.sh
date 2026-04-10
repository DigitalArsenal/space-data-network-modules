#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="${SDN_LOCAL_EMSDK_DIR:-$SCRIPT_DIR/deps/emsdk}"
SRC_DIR="$SCRIPT_DIR/src/cpp"
EMSCRIPTEN_BUILD_DIR="$SRC_DIR/build-wasm"
BUILD_ROOT="$SCRIPT_DIR/.build"
CRYPTOPP_DIR="${CRYPTOPP_SOURCE_DIR:-$BUILD_ROOT/cryptopp-src}"
DIST_DIR="$SCRIPT_DIR/dist"
BROWSER_DIST_DIR="$DIST_DIR/browser"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"
BROWSER_TARGET="protection_key_server_wasm"

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
            ./emsdk install latest
            ./emsdk activate latest
        )
    fi

    # shellcheck disable=SC1090
    source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
}

ensure_cryptopp() {
    mkdir -p "$BUILD_ROOT"
    if [ ! -f "$CRYPTOPP_DIR/aes.h" ]; then
        echo "Cloning Crypto++ into $CRYPTOPP_DIR..."
        rm -rf "$CRYPTOPP_DIR"
        git clone --depth=1 --branch CRYPTOPP_8_9_0 https://github.com/weidai11/cryptopp.git "$CRYPTOPP_DIR"
    fi
}

ensure_emscripten
ensure_cryptopp

node "$SCRIPT_DIR/generate-manifest-header.mjs"

rm -rf "$EMSCRIPTEN_BUILD_DIR"
rm -rf "$DIST_DIR"
mkdir -p "$BROWSER_DIST_DIR" "$ISOMORPHIC_DIST_DIR"

CRYPTOPP_PARENT_DIR="$(cd "$(dirname "$CRYPTOPP_DIR")" && pwd)"

echo "Configuring Emscripten build..."
emcmake cmake \
    -S "$SRC_DIR" \
    -B "$EMSCRIPTEN_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCRYPTOPP_SRC_DIR="$CRYPTOPP_DIR" \
    -DCRYPTOPP_PARENT_DIR="$CRYPTOPP_PARENT_DIR"

echo ""
echo "Building browser adapter..."
cmake --build "$EMSCRIPTEN_BUILD_DIR" --target "$BROWSER_TARGET" -j"$(cpu_count)"

cp "$EMSCRIPTEN_BUILD_DIR/${BROWSER_TARGET}.js" "$BROWSER_DIST_DIR/module.js"
cp "$EMSCRIPTEN_BUILD_DIR/${BROWSER_TARGET}.wasm" "$BROWSER_DIST_DIR/module.wasm"
cp "$EMSCRIPTEN_BUILD_DIR/${BROWSER_TARGET}.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"

echo ""
echo "=== Build Complete ==="
ls -lh "$BROWSER_DIST_DIR/module.js" "$BROWSER_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"
