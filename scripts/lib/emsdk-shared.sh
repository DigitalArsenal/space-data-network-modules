# shellcheck shell=bash
#
# Which emsdk a build.sh compiles with, and proof that it is the one in charge.
# Sourced by the raw em++ build.sh scripts (propagator/sgp4, propagator/atmosphere,
# analysis/od, licensing/core); scripts/lib/emsdk-toolchain.mjs is the same rule
# for the build.mjs lane.
#
# Order:
#   1. SDN_LOCAL_EMSDK_DIR, when set (used as given, as before);
#   2. the module's own deps/emsdk, when it holds an installed Emscripten;
#   3. the machine's shared install, ${SDN_TOOL_CACHE:-$HOME/.cache/sdn-tools}/emsdk-<version>
#      (the layout OrbPro's scripts/shared-emsdk.sh and the stack's deps-bundle use:
#      one install per machine instead of one 1.7 GB install per module per tree,
#      and one Emscripten system-library cache, which Emscripten locks, so
#      concurrent builds in different trees share it safely);
#   4. otherwise the module's deps/emsdk, which the caller's existing bootstrap fills.
#
# The shared install is used by path only: nothing here runs `emsdk activate`
# or writes into it.

sdn_emsdk_dir() {
    local module_dir="$1" version="$2"
    if [ -n "${SDN_LOCAL_EMSDK_DIR:-}" ]; then
        printf '%s\n' "$SDN_LOCAL_EMSDK_DIR"
        return
    fi
    local own="$module_dir/deps/emsdk"
    local shared="${SDN_TOOL_CACHE:-$HOME/.cache/sdn-tools}/emsdk-$version"
    if [ -f "$own/upstream/emscripten/emcc" ]; then
        printf '%s\n' "$own"
    elif [ -f "$shared/emsdk_env.sh" ] && [ -f "$shared/upstream/emscripten/emcc" ]; then
        printf '%s\n' "$shared"
    else
        printf '%s\n' "$own"
    fi
}

# After `source "$emsdk_dir/emsdk_env.sh"`: refuse unless PATH's emcc is that
# emsdk's and it is the wanted version. An emsdk that was installed but never
# activated leaves PATH's emcc (Homebrew's, a different version) in charge, and
# the build used to go on with it silently.
sdn_emsdk_assert_active() {
    local emsdk_dir="$1" version="$2"
    local expected found got
    expected="$(cd "$emsdk_dir/upstream/emscripten" && pwd -P)/emcc"
    found="$(command -v emcc || true)"
    [ -n "$found" ] && found="$(cd "$(dirname "$found")" && pwd -P)/emcc"
    if [ "$found" != "$expected" ]; then
        echo "emsdk at $emsdk_dir is not active (emcc resolves to ${found:-nothing}); run ./emsdk activate $version there" >&2
        exit 1
    fi
    got="$(tr -d '"[:space:]' < "$emsdk_dir/upstream/emscripten/emscripten-version.txt" 2>/dev/null || true)"
    if [ "$got" != "$version" ]; then
        # A warning, not a refusal: trees that hold an older deps/emsdk on purpose
        # (an era rebuild, OrbPro's licensing/core) keep building as before.
        echo "WARNING: emsdk at $emsdk_dir is Emscripten ${got:-unknown}, not $version (this build's pin)" >&2
    fi
    echo "Emscripten ${got:-unknown}: $emsdk_dir"
}
