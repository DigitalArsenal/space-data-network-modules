#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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
    licensing/core
)

if [ "$#" -gt 0 ]; then
    PACKAGES=("$@")
fi

for package in "${PACKAGES[@]}"; do
    if [ ! -d "$ROOT_DIR/$package" ]; then
        echo "Unknown migrated package: $package" >&2
        exit 1
    fi
done

for package in "${PACKAGES[@]}"; do
    echo "==> Building $package"
    (
        cd "$ROOT_DIR/$package"
        bash build.sh
    )
done
