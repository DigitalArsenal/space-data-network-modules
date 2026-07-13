#!/bin/bash
# Build + run the common/ native unit tests.
#
#   provider_source_cid_test — proves provider_source::cid_v1_raw_sha256 (the
#   in-guest CIDv1 the storage.ingest_with_source PNM path publishes) byte-matches
#   the CID the SDN host assigns (go-cid), and that sha256_hex is unchanged.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"        # common/tests
COMMON="$(cd "$DIR/.." && pwd)"             # common
ROOT="$(cd "$COMMON/.." && pwd)"            # space-data-network-modules

# keyslotClient.hpp (transitively included by provider_source.hpp) lives in the
# module SDK's host/cpp dir, reachable through the workspace node_modules symlink.
SDK_HOST_CPP="$ROOT/node_modules/space-data-module-sdk/src/host/cpp"
if [ ! -f "$SDK_HOST_CPP/keyslotClient.hpp" ]; then
  echo "keyslotClient.hpp not found under $SDK_HOST_CPP (module SDK symlink missing?)" >&2
  exit 1
fi

CXX="${CXX:-$(command -v clang++ 2>/dev/null || echo /opt/homebrew/opt/llvm/bin/clang++)}"

for test in provider_source_cid_test; do
  "$CXX" -std=c++17 -O2 -Wno-unknown-attributes -Wno-ignored-attributes \
    -I"$COMMON" -I"$SDK_HOST_CPP" \
    "$DIR/${test}.cpp" -o "$DIR/${test}"
  "$DIR/${test}"
  rm -f "$DIR/${test}"
done
