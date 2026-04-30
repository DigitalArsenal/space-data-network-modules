#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_SDK_ROOT="$(cd "$ROOT_DIR/.." && pwd)/space-data-module-sdk"
SDK_ROOT="${SPACE_DATA_MODULE_SDK_ROOT:-$DEFAULT_SDK_ROOT}"

# These packages publish SDK-loadable module artifacts that are exercised only
# through package-local npm test entrypoints. Packages without plugin manifests
# or canonical dist/isomorphic/module.wasm artifacts are intentionally excluded.
# Paths are family-prefixed to match the submodule's subfolder layout.
PACKAGES=(
    propagator/atmosphere
    propagator/cislunar
    propagator/hpop
    propagator/sgp4
    analysis/conjunction-assessment
    analysis/maneuver
    analysis/od
    basilisk/runtime
    licensing/core
    licensing/client-decrypt
    licensing/protection-key-server
    licensing/protection-license-client
    delivery/plugin-delivery
    shaders/sensor-shaders
)

if [ "$#" -gt 0 ]; then
    PACKAGES=("$@")
fi

for package in "${PACKAGES[@]}"; do
    if [ ! -d "$ROOT_DIR/$package" ]; then
        echo "Unknown module package: $package" >&2
        exit 1
    fi
done

if [ -f "$SDK_ROOT/package.json" ]; then
    SDK_ROOT="$(cd "$SDK_ROOT" && pwd)"
else
    SDK_ROOT=""
fi

for package in "${PACKAGES[@]}"; do
    echo "==> Running npm test for $package"
    (
        cd "$ROOT_DIR/$package"
        if [ -n "$SDK_ROOT" ]; then
            npm install --no-package-lock --no-save "$SDK_ROOT"
        fi
        npm test
    )
done
