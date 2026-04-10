#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="$SCRIPT_DIR/deps/emsdk"
SRC_DIR="$SCRIPT_DIR/src/cpp"
DIST_DIR="$SCRIPT_DIR/dist"
ISOMORPHIC_BUILD_DIR="$SRC_DIR/build-isomorphic"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"

cpu_count() {
    if command -v nproc >/dev/null 2>&1; then
        nproc
        return
    fi
    if command -v sysctl >/dev/null 2>&1; then
        sysctl -n hw.ncpu
        return
    fi
    echo 4
}

if [ -f "$EMSDK_DIR/emsdk_env.sh" ]; then
    if [ ! -f "$EMSDK_DIR/upstream/emscripten/emcc" ]; then
        echo "Installing emsdk..."
        cd "$EMSDK_DIR"
        ./emsdk install latest
        ./emsdk activate latest
    fi
    # shellcheck disable=SC1090
    source "$EMSDK_DIR/emsdk_env.sh" 2>/dev/null
elif command -v emcmake >/dev/null 2>&1 && command -v emcc >/dev/null 2>&1; then
    echo "Using Emscripten from PATH"
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

rm -rf "$DIST_DIR"
mkdir -p "$ISOMORPHIC_DIST_DIR"

echo "Configuring standalone isomorphic build..."
emcmake cmake -S "$SRC_DIR" -B "$ISOMORPHIC_BUILD_DIR" \
    -DCMAKE_BUILD_TYPE=Release \
    -DSDN_ISOMORPHIC_STANDALONE=ON

echo ""
echo "Building standalone isomorphic artifact..."
cmake --build "$ISOMORPHIC_BUILD_DIR" -j"$(cpu_count)"

cp "$ISOMORPHIC_BUILD_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"

echo ""
echo "=== Isomorphic Build Complete ==="
ls -lh "$ISOMORPHIC_DIST_DIR/module.wasm"
