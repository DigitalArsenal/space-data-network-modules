#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_SDK_ROOT="$(cd "$ROOT_DIR/.." && pwd)/space-data-module-sdk"
SDK_ROOT="${SPACE_DATA_MODULE_SDK_ROOT:-$DEFAULT_SDK_ROOT}"
# Paths are family-prefixed to match the submodule's subfolder layout.
PACKAGES=(
    propagator/atmosphere
    propagator/cislunar
    propagator/hpop
    propagator/sgp4
    analysis/conjunction-assessment
    analysis/maneuver
    analysis/od
)

if [ "$#" -gt 0 ]; then
    PACKAGES=("$@")
fi

if [ ! -f "$SDK_ROOT/package.json" ]; then
    echo "SPACE_DATA_MODULE_SDK_ROOT must point to a space-data-module-sdk checkout." >&2
    echo "Resolved SDK root: $SDK_ROOT" >&2
    exit 1
fi

if ! command -v wasmedge >/dev/null 2>&1; then
    echo "Install the wasmedge CLI before running SDK compatibility tests." >&2
    exit 1
fi

for package in "${PACKAGES[@]}"; do
    if [ ! -d "$ROOT_DIR/$package" ]; then
        echo "Unknown migrated package: $package" >&2
        exit 1
    fi
done

for package in "${PACKAGES[@]}"; do
    echo "==> Installing local SDK into $package"
    (
        cd "$ROOT_DIR/$package"
        npm install --no-package-lock --no-save "$SDK_ROOT"
        echo "==> Running sdk_compat.test.mjs for $package"
        node --test tests/sdk_compat.test.mjs
    )
done
