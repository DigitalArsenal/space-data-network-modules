#!/bin/bash
# Build the SGP4/SDP4 propagator plugin as a standalone SDS PIV wasm module.
#
# Produces:
#   dist/browser/module.js      - Emscripten ES module loader
#   dist/browser/module.wasm    - Wasm artifact (browser host)
#   dist/isomorphic/module.wasm - Same wasm artifact (WASI/server)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="${SDN_LOCAL_EMSDK_DIR:-$SCRIPT_DIR/deps/emsdk}"
SRC_DIR="$SCRIPT_DIR/src/cpp"
BUILD_DIR="$SRC_DIR/build-wasm"
DIST_DIR="$SCRIPT_DIR/dist"
BROWSER_DIST_DIR="$DIST_DIR/browser"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"
BROWSER_TARGET="sgp4_wasm"

SQLITE_VENDOR_DIR="$SRC_DIR/deps/sqlite3"
SQLITE_VERSION="${SDN_SGP4_SQLITE_VERSION:-3450200}"
SQLITE_ARCHIVE_URL="${SDN_SGP4_SQLITE_URL:-https://www.sqlite.org/2024/sqlite-amalgamation-${SQLITE_VERSION}.zip}"

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
        echo "Cloning emsdk into $EMSDK_DIR..."
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

ensure_sqlite_amalgamation() {
    if [ -f "$SQLITE_VENDOR_DIR/sqlite3.c" ] && [ -f "$SQLITE_VENDOR_DIR/sqlite3.h" ]; then
        return
    fi

    local emsdk_cache_amalgamation=""
    if [ -d "$EMSDK_DIR/upstream/emscripten/cache/ports/sqlite3" ]; then
        emsdk_cache_amalgamation="$(
            find "$EMSDK_DIR/upstream/emscripten/cache/ports/sqlite3" \
                -maxdepth 2 -type d -name 'sqlite-amalgamation-*' \
                -print -quit 2>/dev/null || true
        )"
    fi

    if [ -n "$emsdk_cache_amalgamation" ] && [ -f "$emsdk_cache_amalgamation/sqlite3.c" ]; then
        echo "Staging SQLite amalgamation from $emsdk_cache_amalgamation..."
        mkdir -p "$SQLITE_VENDOR_DIR"
        cp "$emsdk_cache_amalgamation/sqlite3.c" "$SQLITE_VENDOR_DIR/"
        cp "$emsdk_cache_amalgamation/sqlite3.h" "$SQLITE_VENDOR_DIR/"
        [ -f "$emsdk_cache_amalgamation/sqlite3ext.h" ] && \
            cp "$emsdk_cache_amalgamation/sqlite3ext.h" "$SQLITE_VENDOR_DIR/"
        return
    fi

    echo "Downloading SQLite amalgamation ($SQLITE_VERSION)..."
    mkdir -p "$SQLITE_VENDOR_DIR"
    local tmpdir
    tmpdir="$(mktemp -d)"
    (
        cd "$tmpdir"
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL -o sqlite-amalgamation.zip "$SQLITE_ARCHIVE_URL"
        elif command -v wget >/dev/null 2>&1; then
            wget -qO sqlite-amalgamation.zip "$SQLITE_ARCHIVE_URL"
        else
            echo "curl or wget is required to fetch the SQLite amalgamation" >&2
            exit 1
        fi
        unzip -q sqlite-amalgamation.zip
        local extracted
        extracted="$(find . -maxdepth 1 -type d -name 'sqlite-amalgamation-*' -print -quit)"
        cp "$extracted/sqlite3.c" "$SQLITE_VENDOR_DIR/"
        cp "$extracted/sqlite3.h" "$SQLITE_VENDOR_DIR/"
        [ -f "$extracted/sqlite3ext.h" ] && cp "$extracted/sqlite3ext.h" "$SQLITE_VENDOR_DIR/"
    )
    rm -rf "$tmpdir"
}

ensure_emscripten
ensure_sqlite_amalgamation

node "$SCRIPT_DIR/generate-sds-headers.mjs"
node "$SCRIPT_DIR/generate-manifest-header.mjs"
node "$SCRIPT_DIR/generate-test-bindings.mjs"

rm -rf "$BUILD_DIR"
rm -rf "$DIST_DIR"
mkdir -p "$BROWSER_DIST_DIR" "$ISOMORPHIC_DIST_DIR"

echo "Configuring Emscripten build..."
emcmake cmake \
    -S "$SRC_DIR" \
    -B "$BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release

echo ""
echo "Building propagator.sgp4 wasm module..."
cmake --build "$BUILD_DIR" --target "$BROWSER_TARGET" -j"$(cpu_count)"

cp "$BUILD_DIR/${BROWSER_TARGET}.js" "$BROWSER_DIST_DIR/module.js"
cp "$BUILD_DIR/${BROWSER_TARGET}.wasm" "$BROWSER_DIST_DIR/module.wasm"
cp "$BUILD_DIR/${BROWSER_TARGET}.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"

echo ""
echo "=== Build Complete ==="
ls -lh "$BROWSER_DIST_DIR/module.js" "$BROWSER_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"
