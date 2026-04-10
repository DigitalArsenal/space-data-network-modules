#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="$SCRIPT_DIR/deps/emsdk"
SRC_DIR="$SCRIPT_DIR/src/cpp"
BUILD_DIR="$SRC_DIR/build-wasm"
DIST_DIR="$SCRIPT_DIR/dist"

if command -v emcmake >/dev/null 2>&1 && command -v emcc >/dev/null 2>&1; then
    echo "Using Emscripten from PATH"
elif [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    if [ ! -f "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
        echo "Installing emsdk..."
        cd "$EMSDK_DIR"
        ./emsdk install latest
        ./emsdk activate latest
    fi
    # shellcheck disable=SC1090
    source "$EMSDK_DIR/emsdk_env.sh" 2>/dev/null
else
    if [ -L "$EMSDK_DIR" ] && [ ! -e "$EMSDK_DIR" ]; then
        rm "$EMSDK_DIR"
    fi
    if [ ! -d "$EMSDK_DIR" ]; then
        echo "Cloning emsdk into deps/emsdk..."
        git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    fi
    echo "Installing emsdk..."
    cd "$EMSDK_DIR"
    ./emsdk install latest
    ./emsdk activate latest
    # shellcheck disable=SC1090
    source "$EMSDK_DIR/emsdk_env.sh" 2>/dev/null
fi

echo "Configuring WASM build..."
cd "$SRC_DIR"
emcmake cmake -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release

echo "Building WASM..."
cmake --build "$BUILD_DIR" -j$(nproc 2>/dev/null || echo 4)

mkdir -p "$DIST_DIR"
cp "$BUILD_DIR/conjunction_assessment_wasm.js" "$DIST_DIR/"
cp "$BUILD_DIR/conjunction_assessment_wasm.wasm" "$DIST_DIR/"

echo ""
echo "=== Emscripten Build Complete ==="
ls -lh "$DIST_DIR/conjunction_assessment_wasm.js" "$DIST_DIR/conjunction_assessment_wasm.wasm"

# --- Standalone WASI build (isomorphic artifact) ---
WASI_SDK="${WASI_SDK:-/opt/wasi-sdk}"
WASI_BUILD_DIR="$SRC_DIR/build-wasi"

if [ -d "$WASI_SDK" ]; then
    echo ""
    echo "Building standalone WASI artifact..."
    cmake -B "$WASI_BUILD_DIR" -S "$SRC_DIR" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk.cmake" \
        -DWASI_SDK=ON \
        -DCMAKE_SYSROOT="$WASI_SDK/share/wasi-sysroot"

    cmake --build "$WASI_BUILD_DIR" -j$(nproc 2>/dev/null || echo 4)

    cp "$WASI_BUILD_DIR/conjunction_assessment_standalone.wasm" "$DIST_DIR/"

    echo ""
    echo "=== Standalone WASI Build Complete ==="
    ls -lh "$DIST_DIR/conjunction_assessment_standalone.wasm"
else
    echo ""
    echo "WASI SDK not found at $WASI_SDK — skipping standalone build."
    echo "Install wasi-sdk or set WASI_SDK env var to enable."
fi
