#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_SDK_ROOT="$(cd "$ROOT_DIR/.." && pwd)/space-data-module-sdk"
if [ -n "${SPACE_DATA_MODULE_SDK_ROOT:-}" ]; then
    SDK_ROOT_CANDIDATES=("$SPACE_DATA_MODULE_SDK_ROOT")
else
    SDK_ROOT_CANDIDATES=(
        "$DEFAULT_SDK_ROOT"
        "$ROOT_DIR/../../ancillary-packages/space-data-module-sdk"
    )
fi
# Paths are family-prefixed to match the submodule's subfolder layout.
PACKAGES=(
    propagator/atmosphere
    propagator/hypersonics
    propagator/cislunar
    propagator/hpop
    propagator/sgp4
    analysis/conjunction-assessment
    analysis/reentry
    analysis/launch-ascent
    analysis/maneuver
    analysis/od
    basilisk/runtime
)

if [ "$#" -gt 0 ]; then
    PACKAGES=("$@")
fi

SDK_ROOT=""
for candidate in "${SDK_ROOT_CANDIDATES[@]}"; do
    if [ -f "$candidate/package.json" ]; then
        SDK_ROOT="$(cd "$candidate" && pwd)"
        break
    fi
done

if [ -z "$SDK_ROOT" ]; then
    echo "SPACE_DATA_MODULE_SDK_ROOT must point to a space-data-module-sdk checkout." >&2
    echo "Checked SDK roots:" >&2
    printf '  %s\n' "${SDK_ROOT_CANDIDATES[@]}" >&2
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
