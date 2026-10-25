#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="${SDN_LOCAL_EMSDK_DIR:-$SCRIPT_DIR/deps/emsdk}"
SRC_DIR="$SCRIPT_DIR/src/cpp"
BUILD_DIR="$SRC_DIR/build-isomorphic"
DIST_DIR="$SCRIPT_DIR/dist"
BROWSER_DIST_DIR="$DIST_DIR/browser"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"
BROWSER_TARGET="od_wasm"

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
            ./emsdk install 6.0.1
            ./emsdk activate 6.0.1
        )
    fi

    # shellcheck disable=SC1090
    source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
}

# ── Generated bindings shared by every Emscripten target ────────────────────
generate_bindings() {
    node "$SCRIPT_DIR/../../scripts/generate-plugin-manifest-header.mjs" \
        --package-dir "$SCRIPT_DIR" \
        --var od_plugin_manifest_bytes \
        --guard OD_PLUGIN_MANIFEST_BYTES_H

    # Reproduce the PIV/TAB bindings from the installed SDK's SDS dependency.
    # An old TAB header silently drops aligned-output type metadata.
    node --input-type=module - "$SCRIPT_DIR" <<'JS'
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root = process.argv[2];
const require = createRequire(path.join(root, 'package.json'));
const {getInvokeCppSchemaHeaders} = await import(pathToFileURL(require.resolve('space-data-module-sdk/compiler')));
for (const [name, content] of Object.entries(await getInvokeCppSchemaHeaders())) {
    await fs.writeFile(path.join(root, 'src/cpp/generated', name), content);
}
// The typed module runtime (typedHostcall.hpp: sdm_piv::get_config) and the runtime headers it reads
// (ModuleConfig, HostOps), staged as the SDK compiler stages them for every C++ compile.
const sdkRoot = path.join(root, 'node_modules/space-data-module-sdk');
await fs.copyFile(path.join(sdkRoot, 'src/host/cpp/typedHostcall.hpp'), path.join(root, 'src/cpp/generated/typedHostcall.hpp'));
const runtimeDir = path.join(sdkRoot, 'src/generated/runtime/cpp');
for (const name of await fs.readdir(runtimeDir)) {
    if (name.endsWith('.h')) await fs.copyFile(path.join(runtimeDir, name), path.join(root, 'src/cpp/generated', name));
}
// SDS $FIL (the text ephemeris file in, the two-line set out), generated from the standard's schema with the object
// API (scripts/lib/sds-cpp-headers.mjs) and inlined as FIL_generated.h: the include guard is renamed (the SDK's sds/PIV
// and sds/TAB headers are also "main_generated.h") and the flatc version static_assert dropped, as hostcap/clock does.
if (!process.env.SPACE_DATA_STANDARDS_ROOT) throw new Error('SPACE_DATA_STANDARDS_ROOT must name the spacedatastandards package');
const {generateSdsHeader} = await import(pathToFileURL(path.join(root, '../../scripts/lib/sds-cpp-headers.mjs')));
const fil = (await generateSdsHeader('FIL', path.join(root, 'package.json')))
    .replaceAll('FLATBUFFERS_GENERATED_MAIN_H_', 'FLATBUFFERS_GENERATED_SDS_FIL_MAIN_H_')
    .replace(/static_assert\(FLATBUFFERS_VERSION_MAJOR[\s\S]*?\);\n/, '');
await fs.writeFile(path.join(root, 'src/cpp/generated/FIL_generated.h'), fil);
JS
}

# ── Browser bundle and command module ────────────────────────────────────────
# dist/browser/module.{js,wasm}, the Emscripten command bundle, and its wasm as
# dist/isomorphic/module.command.wasm, signed with the module owner key unless
# SDN_OD_UNSIGNED_BUILD=1. dist/isomorphic/module.wasm comes from build-wasi.mjs
# (the SDK's WASI toolchain) and is never touched here. The bundle exports
# _initialize (src/direct_initialize.cpp) so a direct-surface host can construct
# it without entering _start.
build_browser() {
    generate_bindings
    rm -rf "$BUILD_DIR" "$BROWSER_DIST_DIR"
    mkdir -p "$BROWSER_DIST_DIR"
    echo "Configuring Emscripten build..."
    emcmake cmake -S "$SRC_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
    echo ""
    echo "Building browser-compatible standalone (command) artifact..."
    cmake --build "$BUILD_DIR" --target "$BROWSER_TARGET" -j"$(cpu_count)"
    # The link allows undefined symbols (the module host's imports), so a unit left out of the build would become an
    # `env` import no host provides: refuse any import but WASI's and the module host's.
    node --input-type=module -e '
import fs from "node:fs";
const allowed = new Set(["wasi_snapshot_preview1", "space_data_module_host"]);
const stray = WebAssembly.Module.imports(new WebAssembly.Module(fs.readFileSync(process.argv[1]))).filter((i) => !allowed.has(i.module));
if (stray.length) { console.error(`unresolved imports: ${stray.map((i) => `${i.module}.${i.name}`).join(", ")}`); process.exit(1); }
' "$BUILD_DIR/${BROWSER_TARGET}.wasm"
    cp "$BUILD_DIR/${BROWSER_TARGET}.js" "$BROWSER_DIST_DIR/module.js"
    cp "$BUILD_DIR/${BROWSER_TARGET}.wasm" "$BROWSER_DIST_DIR/module.wasm"
    mkdir -p "$ISOMORPHIC_DIST_DIR"
    cp "$BUILD_DIR/${BROWSER_TARGET}.wasm" "$ISOMORPHIC_DIST_DIR/module.command.wasm"
    if [ "${SDN_OD_UNSIGNED_BUILD:-0}" != "1" ]; then
        node "$SCRIPT_DIR/../../scripts/sign-module-artifact.mjs" \
            "$ISOMORPHIC_DIST_DIR/module.command.wasm"
    fi
    echo ""
    echo "=== Browser Build Complete ==="
    ls -lh "$BROWSER_DIST_DIR/module.js" "$BROWSER_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.command.wasm"
}

MODE="${1:-browser}"

ensure_emscripten

case "$MODE" in
    browser)
        build_browser
        ;;
    *)
        echo "usage: build.sh [browser]" >&2
        exit 1
        ;;
esac
