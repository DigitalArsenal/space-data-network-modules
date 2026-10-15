#!/bin/bash
# The module is built by the SDK compiler (build.mjs); kept for scripts/build-migrated-packages.sh.
set -euo pipefail
cd "$(dirname "$0")"
exec node build.mjs
