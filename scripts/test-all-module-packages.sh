#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# These packages publish SDK-loadable module artifacts that are exercised only
# through package-local npm test entrypoints. Packages without plugin manifests
# or canonical dist/isomorphic/module.wasm artifacts are intentionally excluded.
PACKAGES=(
    atmosphere
    cislunar
    conjunction-assessment
    fred
    hpop
    maneuver
    od
    protection-key-server
    protection-license-client
    propagator.sgp4
    plugin-delivery
    client-decrypt
)

if [ "$#" -gt 0 ]; then
    PACKAGES=("$@")
fi

for package in "${PACKAGES[@]}"; do
    if [ ! -d "$ROOT_DIR/packages/$package" ]; then
        echo "Unknown module package: $package" >&2
        exit 1
    fi
done

for package in "${PACKAGES[@]}"; do
    echo "==> Running npm test for $package"
    (
        cd "$ROOT_DIR/packages/$package"
        npm test
    )
done
