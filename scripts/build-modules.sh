#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

PACKAGES=()

if [ "$#" -gt 0 ]; then
    PACKAGES=("$@")
fi

if [ "${#PACKAGES[@]}" -eq 0 ]; then
    while IFS= read -r build_script; do
        package_dir="$(dirname "$build_script")"
        PACKAGES+=("${package_dir#$ROOT_DIR/}")
    done < <(find "$ROOT_DIR" -mindepth 3 -maxdepth 4 -name build.sh -type f | sort)
fi

if [ "${#PACKAGES[@]}" -eq 0 ]; then
    echo "No module packages with build.sh were found."
    exit 0
fi

for package in "${PACKAGES[@]}"; do
    if [ ! -f "$ROOT_DIR/$package/build.sh" ]; then
        echo "Unknown module package or missing build.sh: $package" >&2
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
