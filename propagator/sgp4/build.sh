#!/usr/bin/env bash
# Keep a shell entry point because the module build inventory reads it. The
# implementation is Node so it can use the same artifact guards as the SDK.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
exec node "$script_dir/build.mjs" "$@"
