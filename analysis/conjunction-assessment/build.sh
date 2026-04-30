#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="${SDN_LOCAL_EMSDK_DIR:-$SCRIPT_DIR/deps/emsdk}"
SRC_DIR="$SCRIPT_DIR/src/cpp"
BROWSER_BUILD_DIR="$SRC_DIR/build-browser"
ISOMORPHIC_BUILD_DIR="$SRC_DIR/build-isomorphic"
SINGLETHREAD_BUILD_DIR="$SRC_DIR/build-isomorphic-singlethread"
DIST_DIR="$SCRIPT_DIR/dist"
BROWSER_DIST_DIR="$DIST_DIR/browser"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"
SINGLETHREAD_DIST_DIR="$DIST_DIR/isomorphic-singlethread"
BROWSER_TARGET="conjunction_assessment_wasm"
FLATBUFFERS_INCLUDE_DIR="${SDN_FLATBUFFERS_INCLUDE_DIR:-${FLATBUFFERS_INCLUDE_DIR:-}}"

if [ -z "$FLATBUFFERS_INCLUDE_DIR" ]; then
    for candidate in \
        "$SCRIPT_DIR/../../../da-flatbuffers/include" \
        "$SCRIPT_DIR/../../../../da-flatbuffers/include"; do
        if [ -f "$candidate/flatbuffers/flatbuffers.h" ]; then
            FLATBUFFERS_INCLUDE_DIR="$candidate"
            break
        fi
    done
fi

FLATBUFFERS_CMAKE_ARGS=()
if [ -n "$FLATBUFFERS_INCLUDE_DIR" ]; then
    FLATBUFFERS_CMAKE_ARGS=(-DFLATBUFFERS_INCLUDE_DIR="$FLATBUFFERS_INCLUDE_DIR")
fi

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

ensure_emscripten

node "$SCRIPT_DIR/generate-manifest-header.mjs"

rm -rf "$BROWSER_BUILD_DIR" "$ISOMORPHIC_BUILD_DIR" "$SINGLETHREAD_BUILD_DIR"
rm -rf "$DIST_DIR"
mkdir -p "$BROWSER_DIST_DIR" "$ISOMORPHIC_DIST_DIR" "$SINGLETHREAD_DIST_DIR"

echo "Configuring Emscripten browser pthread build..."
emcmake cmake \
    -S "$SRC_DIR" \
    -B "$BROWSER_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCONJUNCTION_ENABLE_PTHREADS=ON \
    -DCONJUNCTION_EMSCRIPTEN_BROWSER_ADAPTER=ON \
    "${FLATBUFFERS_CMAKE_ARGS[@]}"

echo ""
echo "Building browser adapter..."
cmake --build "$BROWSER_BUILD_DIR" --target "$BROWSER_TARGET" -j"$(cpu_count)"

cp "$BROWSER_BUILD_DIR/${BROWSER_TARGET}.js" "$BROWSER_DIST_DIR/module.js"
cp "$BROWSER_BUILD_DIR/${BROWSER_TARGET}.wasm" "$BROWSER_DIST_DIR/module.wasm"
find "$BROWSER_BUILD_DIR" -maxdepth 1 -name "${BROWSER_TARGET}*.worker.js" \
    -exec cp {} "$BROWSER_DIST_DIR/" \;

echo ""
echo "Configuring Emscripten pthread WasmEdge SDK build..."
emcmake cmake \
    -S "$SRC_DIR" \
    -B "$ISOMORPHIC_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCONJUNCTION_ENABLE_PTHREADS=ON \
    -DCONJUNCTION_EMSCRIPTEN_BROWSER_ADAPTER=OFF \
    "${FLATBUFFERS_CMAKE_ARGS[@]}"

echo ""
echo "Building standalone SDK artifact..."
cmake --build "$ISOMORPHIC_BUILD_DIR" --target "$BROWSER_TARGET" -j"$(cpu_count)"

cp "$ISOMORPHIC_BUILD_DIR/${BROWSER_TARGET}.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"

echo ""
echo "Configuring Emscripten single-thread SDK build..."
emcmake cmake \
    -S "$SRC_DIR" \
    -B "$SINGLETHREAD_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCONJUNCTION_ENABLE_PTHREADS=OFF \
    -DCONJUNCTION_EMSCRIPTEN_BROWSER_ADAPTER=OFF \
    "${FLATBUFFERS_CMAKE_ARGS[@]}"

echo ""
echo "Building single-thread SDK artifact..."
cmake --build "$SINGLETHREAD_BUILD_DIR" --target "$BROWSER_TARGET" -j"$(cpu_count)"

cp "$SINGLETHREAD_BUILD_DIR/${BROWSER_TARGET}.wasm" "$SINGLETHREAD_DIST_DIR/module.wasm"

echo ""
echo "=== Build Complete ==="
ls -lh "$BROWSER_DIST_DIR/module.js" "$BROWSER_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm" "$SINGLETHREAD_DIST_DIR/module.wasm"
