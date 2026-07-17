#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="${SDN_LOCAL_EMSDK_DIR:-$SCRIPT_DIR/deps/emsdk}"
SRC_DIR="$SCRIPT_DIR/src/cpp"
BUILD_DIR="$SRC_DIR/build-isomorphic"
DIST_DIR="$SCRIPT_DIR/dist"
BROWSER_DIST_DIR="$DIST_DIR/browser"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"
GUESTLINK_DIST_DIR="$DIST_DIR/guest-link"
BROWSER_TARGET="od_wasm"
REACTOR_TARGET="od_wasm_reactor"

# Guest-link (flow-bake) build inputs. Same header roots the CMake WASM build
# resolves; overridable via env, defaults mirror CMakeLists.txt.
VALLADO_DIR="$SRC_DIR/deps/vallado-sgp4"
FLATBUFFERS_INCLUDE_DIR="${SDN_FLATBUFFERS_INCLUDE_DIR:-${FLATBUFFERS_INCLUDE_DIR:-$SCRIPT_DIR/../../../flatbuffers/include}}"
SDS_GENERATED_DIR="${SDN_CORE_SDS_GENERATED_DIR:-$SCRIPT_DIR/../../licensing/core/src/cpp/generated/sds}"

# Eigen3 (header-only) — mirror CMakeLists' search order; override with
# SDN_OD_EIGEN_DIR or EIGEN3_INCLUDE_DIR (dir that contains Eigen/Dense).
resolve_eigen_dir() {
    if [ -n "${SDN_OD_EIGEN_DIR:-}" ] && [ -f "$SDN_OD_EIGEN_DIR/Eigen/Dense" ]; then
        echo "$SDN_OD_EIGEN_DIR"; return
    fi
    if [ -n "${EIGEN3_INCLUDE_DIR:-}" ] && [ -f "$EIGEN3_INCLUDE_DIR/Eigen/Dense" ]; then
        echo "$EIGEN3_INCLUDE_DIR"; return
    fi
    for d in /opt/homebrew/include/eigen3 /opt/homebrew/opt/eigen/include/eigen3 \
             /usr/local/include/eigen3 /usr/local/opt/eigen/include/eigen3 \
             /usr/include/eigen3; do
        [ -f "$d/Eigen/Dense" ] && { echo "$d"; return; }
    done
    echo ""
}

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

# ── Isomorphic reactor + browser command builds (the CMake targets) ──────────
build_isomorphic() {
    node "$SCRIPT_DIR/../../scripts/generate-plugin-manifest-header.mjs" \
        --package-dir "$SCRIPT_DIR" \
        --var od_plugin_manifest_bytes \
        --guard OD_PLUGIN_MANIFEST_BYTES_H

    rm -rf "$BUILD_DIR"
    rm -rf "$DIST_DIR"
    mkdir -p "$BROWSER_DIST_DIR" "$ISOMORPHIC_DIST_DIR"

    echo "Configuring Emscripten build..."
    emcmake cmake -S "$SRC_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release

    echo ""
    echo "Building browser-compatible standalone (command) artifact..."
    cmake --build "$BUILD_DIR" --target "$BROWSER_TARGET" -j"$(cpu_count)"

    echo ""
    echo "Building isomorphic resident-reactor artifact..."
    cmake --build "$BUILD_DIR" --target "$REACTOR_TARGET" -j"$(cpu_count)"

    # Browser bundle stays the command build (MODULARIZE ES module + wasm).
    cp "$BUILD_DIR/${BROWSER_TARGET}.js" "$BROWSER_DIST_DIR/module.js"
    cp "$BUILD_DIR/${BROWSER_TARGET}.wasm" "$BROWSER_DIST_DIR/module.wasm"

    # Server/isomorphic host loads the RESIDENT REACTOR as module.wasm (driven
    # via plugin_invoke_stream; no per-fit _start). The command build is retained
    # beside it as module.command.wasm for the reactor==command RMS parity gate.
    cp "$BUILD_DIR/${REACTOR_TARGET}.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"
    cp "$BUILD_DIR/${BROWSER_TARGET}.wasm" "$ISOMORPHIC_DIST_DIR/module.command.wasm"
    node "$SCRIPT_DIR/../../scripts/sign-module-artifact.mjs" \
        "$ISOMORPHIC_DIST_DIR/module.wasm"
    node "$SCRIPT_DIR/../../scripts/sign-module-artifact.mjs" \
        "$ISOMORPHIC_DIST_DIR/module.command.wasm"

    echo ""
    echo "=== Isomorphic/Browser Build Complete ==="
    ls -lh "$BROWSER_DIST_DIR/module.js" "$BROWSER_DIST_DIR/module.wasm" \
        "$ISOMORPHIC_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.command.wasm"
}

# ── Guest-link (flow-bake) build ─────────────────────────────────────────────
# Produces dist/guest-link/{module-link.o, metadata.json} — the multi-TU
# relocatable object a baked $PLG flow links analysis/od's `fit` entry from.
#
# SPEED recipe (SDN OD-Flow Phase 1a/1b): compile EACH TU with the module's
# NATIVE emsdk (the same emsdk the reactor target uses — fast `clang -c -O3
# -target wasm32-emscripten` via em++), NOT the interpreted flow-bake llvm-box
# (Eigen TUs take minutes interpreted). A native-emsdk relocatable wasm32 object
# links fine with the node's llvm-box `wasm-ld` at bake time.
#
# Apply the SDK guest-link rename (-Dfit=<prefix>fit) to the ENTRY glue ONLY,
# so `fit` is DEFINED+prefixed while every ABI import (plugin_push_output*/
# plugin_get_input_frame/…) stays UNDEFINED. Then `wasm-ld -r` partial-links all
# TUs into one module-link.o. Prefix = sdm_guest_<hex(pluginId)[:24]>_ (mirrors
# the SDK's guestLinkSymbolPrefix / kubo flowrt.guestLinkSymbolPrefix EXACTLY).
build_guest_link() {
    echo ""
    echo "=== Building guest-link (flow-bake) object ==="

    if [ ! -f "$FLATBUFFERS_INCLUDE_DIR/flatbuffers/flatbuffers.h" ]; then
        echo "flatbuffers headers not found at $FLATBUFFERS_INCLUDE_DIR (set SDN_FLATBUFFERS_INCLUDE_DIR)" >&2
        exit 1
    fi
    if [ ! -f "$SDS_GENERATED_DIR/OEM_generated.h" ] || [ ! -f "$SDS_GENERATED_DIR/OMM_generated.h" ]; then
        echo "SDS generated headers not found at $SDS_GENERATED_DIR (need OEM_generated.h/OMM_generated.h; set SDN_CORE_SDS_GENERATED_DIR)" >&2
        exit 1
    fi
    local EIGEN_DIR
    EIGEN_DIR="$(resolve_eigen_dir)"
    if [ -z "$EIGEN_DIR" ]; then
        echo "Eigen3 headers not found (need Eigen/Dense). Set SDN_OD_EIGEN_DIR or EIGEN3_INCLUDE_DIR." >&2
        exit 1
    fi
    echo "eigen=$EIGEN_DIR"

    # Guest-link symbol prefix — mirror guestLinkSymbolPrefix EXACTLY:
    # "sdm_guest_" + hex(pluginId bytes)[:24] + "_".
    local PLUGIN_ID PREFIX
    PLUGIN_ID="$(node -e 'process.stdout.write(String(require(process.argv[1]).pluginId))' "$SCRIPT_DIR/plugin-manifest.json")"
    PREFIX="$(node -e 'const id=process.argv[1];const h=Buffer.from(id,"utf8").toString("hex");process.stdout.write("sdm_guest_"+h.slice(0,24)+"_")' "$PLUGIN_ID")"
    echo "pluginId=$PLUGIN_ID  symbolPrefix=$PREFIX"

    local GL_BUILD="$SRC_DIR/build-guestlink"
    rm -rf "$GL_BUILD"
    mkdir -p "$GL_BUILD" "$GUESTLINK_DIST_DIR"

    # em++ compile flags: emscripten target (implicit) + emscripten sysroot,
    # -O3 (SPEED recipe), -fignore-exceptions (EH-free object; load-bearing for
    # WasmEdge 0.14.x). Matches the proven Phase-0b/1a flags, at -O3.
    local CFLAGS=(
        -std=c++17 -O3 -mbulk-memory -DNDEBUG -DEMSCRIPTEN
        -DEIGEN_DONT_PARALLELIZE -fignore-exceptions
        -I"$SRC_DIR/include" -I"$VALLADO_DIR"
        -I"$FLATBUFFERS_INCLUDE_DIR" -I"$SDS_GENERATED_DIR" -I"$EIGEN_DIR"
    )

    # od_lib TUs (every .cpp CMake compiles into od_lib) + sgp4_lib (Vallado).
    local LIB_TUS=(
        "src/orbit_determination.cpp" "src/meme_parser.cpp" "src/frame_transform.cpp"
        "src/oem_parser.cpp" "src/oem_fb_reader.cpp" "src/omm_fb_builder.cpp" "src/obd_fb_builder.cpp"
        "src/sgp4_fitter.cpp" "src/plugin_runtime.cpp"
        "deps/vallado-sgp4/SGP4.cpp"
    )
    local OBJS=()
    for tu in "${LIB_TUS[@]}"; do
        local obj="$GL_BUILD/$(basename "${tu%.cpp}").o"
        echo "  em++ -O3 -c $tu"
        em++ -c "$SRC_DIR/$tu" -o "$obj" "${CFLAGS[@]}"
        OBJS+=("$obj")
    done

    # ENTRY glue: rename ONLY the method entry symbol so metadata.json[fit]
    # resolves uniquely; the ABI imports stay UNDEFINED.
    echo "  em++ -O3 -c guest-link/od_fit_entry.cpp  (-Dfit=${PREFIX}fit)"
    em++ -c "$SRC_DIR/guest-link/od_fit_entry.cpp" -o "$GL_BUILD/od_fit_entry.o" \
        "${CFLAGS[@]}" "-Dfit=${PREFIX}fit"
    OBJS+=("$GL_BUILD/od_fit_entry.o")

    # Partial-link ALL TUs into one relocatable guest-link object.
    local WASM_LD="$EMSDK_DIR/upstream/bin/wasm-ld"
    echo "  wasm-ld -r ${#OBJS[@]} objects -> module-link.o"
    "$WASM_LD" -r "${OBJS[@]}" -o "$GUESTLINK_DIST_DIR/module-link.o"

    # metadata.json — methodSymbols[fit] names the prefixed entry the baker links.
    # (node -e sets argv[1]=first script arg, so out=argv[1], prefix=argv[2].)
    node -e '
      const fs=require("fs");
      const out=process.argv[1], prefix=process.argv[2];
      fs.writeFileSync(out, JSON.stringify({
        version:1, format:"wasm-object", language:"c++",
        threadModel:"single-thread", symbolPrefix:prefix,
        methodSymbols:{ fit: prefix+"fit" },
      }, null, 2)+"\n");
    ' "$GUESTLINK_DIST_DIR/metadata.json" "$PREFIX"

    # Stage the real module manifest beside the object (typed $OEM/$OMM ports).
    cp "$SCRIPT_DIR/plugin-manifest.json" "$GUESTLINK_DIST_DIR/plugin-manifest.json"

    echo ""
    echo "=== Guest-link Build Complete ==="
    ls -lh "$GUESTLINK_DIST_DIR/module-link.o" "$GUESTLINK_DIST_DIR/metadata.json"

    # Symbol evidence: fit DEFINED+prefixed; ABI imports UNDEFINED.
    if command -v llvm-nm >/dev/null 2>&1; then
        echo "--- llvm-nm (T=defined text, U=undefined import) ---"
        llvm-nm "$GUESTLINK_DIST_DIR/module-link.o" 2>/dev/null \
          | grep -Ei "${PREFIX}fit|plugin_push_output|plugin_get_input_frame|plugin_find_input_index" \
          || echo "(grep found nothing; run 'llvm-nm module-link.o' manually)"
    fi
    if command -v wasm-objdump >/dev/null 2>&1; then
        echo "--- wasm-objdump: prefixed entry present ---"
        wasm-objdump -x "$GUESTLINK_DIST_DIR/module-link.o" 2>/dev/null | grep -Ei "${PREFIX}fit" | head -3
    fi
}

MODE="${1:-all}"

ensure_emscripten

case "$MODE" in
    guest-link)
        build_guest_link
        ;;
    isomorphic)
        build_isomorphic
        ;;
    all|"")
        build_isomorphic
        build_guest_link
        ;;
    *)
        echo "usage: build.sh [all|isomorphic|guest-link]" >&2
        exit 1
        ;;
esac
