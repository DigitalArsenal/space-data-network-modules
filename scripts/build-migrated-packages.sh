#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGES=(
    atmosphere
    cislunar
    conjunction-assessment
    fred
    hpop
    maneuver
    od
    sgp4-propagator
)

if [ "$#" -gt 0 ]; then
    PACKAGES=("$@")
fi

for package in "${PACKAGES[@]}"; do
    if [ ! -d "$ROOT_DIR/packages/$package" ]; then
        echo "Unknown migrated package: $package" >&2
        exit 1
    fi
done

for package in "${PACKAGES[@]}"; do
    echo "==> Building $package"
    (
        cd "$ROOT_DIR/packages/$package"
        bash build.sh
    )
done
