#!/bin/bash
# Build + run the EPM signing-content and verify tests natively (ed25519 and
# secp256k1 from the repo's pinned Crypto++; see cryptopp.sh).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"    # common/epm
COMMON="$(cd "$DIR/.." && pwd)"            # common
ROOT="$(cd "$COMMON/.." && pwd)"           # space-data-network-modules
source "$DIR/tests/cryptopp.sh"

CXX="${CXX:-$(command -v clang++ 2>/dev/null || echo /opt/homebrew/opt/llvm/bin/clang++)}"
SRC=("$COMMON/jcs/jcs.cpp" "$DIR/epm_content.cpp" "$DIR/epm_verify.cpp")

for test in epm_content_test epm_verify_test; do
  "$CXX" -std=c++17 -O2 -I"$DIR" -I"$CRYPTOPP_INCLUDE" \
    "${SRC[@]}" "$DIR/tests/${test}.cpp" "$CRYPTOPP_LIB" \
    -o "$EPM_BUILD/${test}"
  "$EPM_BUILD/${test}"
done
