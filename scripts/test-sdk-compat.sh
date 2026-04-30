#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_SDK_ROOT="$(cd "$ROOT_DIR/.." && pwd)/space-data-module-sdk"
SDK_ROOT="${SPACE_DATA_MODULE_SDK_ROOT:-$DEFAULT_SDK_ROOT}"
SDK_ROOT="$(cd "$SDK_ROOT" && pwd)"

PACKAGES=()

if [ "$#" -gt 0 ]; then
    PACKAGES=("$@")
fi

if [ "${#PACKAGES[@]}" -eq 0 ]; then
    while IFS= read -r test_file; do
        package_dir="$(dirname "$(dirname "$test_file")")"
        PACKAGES+=("${package_dir#$ROOT_DIR/}")
    done < <(find "$ROOT_DIR" -mindepth 4 -maxdepth 5 -path '*/tests/sdk_compat.test.mjs' -type f | sort)
fi

if [ ! -f "$SDK_ROOT/package.json" ]; then
    echo "SPACE_DATA_MODULE_SDK_ROOT must point to a space-data-module-sdk checkout." >&2
    echo "Resolved SDK root: $SDK_ROOT" >&2
    exit 1
fi

if [ "${#PACKAGES[@]}" -eq 0 ]; then
    echo "No module packages with tests/sdk_compat.test.mjs were found."
    exit 0
fi

if ! command -v wasmedge >/dev/null 2>&1; then
    echo "Install the wasmedge CLI before running SDK compatibility tests." >&2
    exit 1
fi

for package in "${PACKAGES[@]}"; do
    if [ ! -f "$ROOT_DIR/$package/tests/sdk_compat.test.mjs" ]; then
        echo "Unknown module package or missing sdk_compat.test.mjs: $package" >&2
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
