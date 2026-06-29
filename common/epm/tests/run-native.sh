#!/bin/bash
# Build + run the EPM signing-content tests natively (reuses Crypto++ from the
# protection-key-server native build for ed25519).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"    # common/epm
COMMON="$(cd "$DIR/.." && pwd)"            # common
ROOT="$(cd "$COMMON/.." && pwd)"           # space-data-network-modules
CPPBUILD="$ROOT/licensing/protection-key-server/.build"
CRYPTOPP="$CPPBUILD/cryptopp-src"

if [ ! -f "$CRYPTOPP/libcryptopp.a" ]; then
  echo "Native Crypto++ not built. Run licensing/protection-key-server/tests/run-native.sh once." >&2
  exit 1
fi
[ -e "$CPPBUILD/cryptopp" ] || ln -s cryptopp-src "$CPPBUILD/cryptopp"

CXX="${CXX:-$(command -v clang++ 2>/dev/null || echo /opt/homebrew/opt/llvm/bin/clang++)}"
"$CXX" -std=c++17 -O2 -I"$DIR" -I"$CPPBUILD" \
  "$COMMON/jcs/jcs.cpp" "$DIR/epm_content.cpp" "$DIR/tests/epm_content_test.cpp" \
  "$CRYPTOPP/libcryptopp.a" \
  -o "$DIR/tests/epm_content_test"
"$DIR/tests/epm_content_test"
