#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EMSDK_DIR="${SDN_LOCAL_EMSDK_DIR:-$SCRIPT_DIR/deps/emsdk}"
DIST_DIR="$SCRIPT_DIR/dist"
BROWSER_DIST_DIR="$DIST_DIR/browser"
ISOMORPHIC_DIST_DIR="$DIST_DIR/isomorphic"
ARTIFACTS_SOURCE="$SCRIPT_DIR/../../../orbpro-runtime/taggedPluginArtifacts.generated.js"

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

node "$SCRIPT_DIR/generate-manifest-header.mjs"
ensure_emscripten

mkdir -p "$BROWSER_DIST_DIR" "$ISOMORPHIC_DIST_DIR"

PACKAGE_DIR="$SCRIPT_DIR" ARTIFACTS_SOURCE="$ARTIFACTS_SOURCE" node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const packageDir = process.env.PACKAGE_DIR;
const sourcePath = process.env.ARTIFACTS_SOURCE;
if (!packageDir || !sourcePath) {
  throw new Error("PACKAGE_DIR and ARTIFACTS_SOURCE must be set.");
}
const source = fs.readFileSync(sourcePath, "utf8");

function extractBase64(key, commentPath) {
  const marker = `"${key}": "`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Missing artifact key: ${key}`);
  }
  const begin = start + marker.length;
  const endMarker = `", // ${commentPath}`;
  const end = source.indexOf(endMarker, begin);
  if (end < 0) {
    throw new Error(`Missing artifact terminator for ${key}`);
  }
  return source.slice(begin, end);
}

const browserJsLiteral = extractBase64(
  "fastest-path-browser-module",
  "packages/space-data-network-plugins/packages/fastest-path/dist/browser/module.js",
);
const browserJs = JSON.parse(`"${browserJsLiteral}"`);
const browserWasm = Buffer.from(
  extractBase64(
    "fastest-path-wasm",
    "packages/space-data-network-plugins/packages/fastest-path/dist/isomorphic/module.wasm",
  ),
  "base64",
);

const browserOut = path.join(packageDir, "dist", "browser", "module.js");
const browserWasmOut = path.join(packageDir, "dist", "browser", "module.wasm");
const isomorphicOut = path.join(packageDir, "dist", "isomorphic", "module.wasm");

fs.mkdirSync(path.dirname(browserOut), { recursive: true });
fs.mkdirSync(path.dirname(browserWasmOut), { recursive: true });
fs.mkdirSync(path.dirname(isomorphicOut), { recursive: true });

fs.writeFileSync(browserOut, browserJs);
fs.writeFileSync(browserWasmOut, browserWasm);
fs.writeFileSync(isomorphicOut, browserWasm);

console.log("Wrote canonical browser and isomorphic artifacts.");
NODE

echo ""
echo "=== Build Complete ==="
ls -lh "$BROWSER_DIST_DIR/module.js" "$BROWSER_DIST_DIR/module.wasm" "$ISOMORPHIC_DIST_DIR/module.wasm"
