#!/bin/bash
# Build + run the EPM FlatBuffer end-to-end test (needs EPM_generated.h + flatbuffers
# headers + Crypto++ from the protection-key-server native build).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"     # common/epm
COMMON="$(cd "$DIR/.." && pwd)"             # common
ROOT="$(cd "$COMMON/.." && pwd)"            # space-data-network-modules
CPPBUILD="$ROOT/licensing/protection-key-server/.build"
CRYPTOPP="$CPPBUILD/cryptopp-src"
EPMINC="$ROOT/licensing/core/src/cpp/generated/sds"

if [ ! -f "$CRYPTOPP/libcryptopp.a" ]; then
  echo "Native Crypto++ not built. Run licensing/protection-key-server/tests/run-native.sh once." >&2
  exit 1
fi
[ -e "$CPPBUILD/cryptopp" ] || ln -s cryptopp-src "$CPPBUILD/cryptopp"

FBINC="${SDN_FLATBUFFERS_INCLUDE_DIR:-}"
for cand in "$FBINC" "$ROOT/../../../flatbuffers/include" /opt/homebrew/include /usr/local/include; do
  [ -n "$cand" ] && [ -f "$cand/flatbuffers/flatbuffers.h" ] && FBINC="$cand" && break
done
if [ -z "$FBINC" ] || [ ! -f "$FBINC/flatbuffers/flatbuffers.h" ]; then
  echo "flatbuffers headers not found; set SDN_FLATBUFFERS_INCLUDE_DIR." >&2
  exit 1
fi

CXX="${CXX:-$(command -v clang++ 2>/dev/null || echo /opt/homebrew/opt/llvm/bin/clang++)}"
SRC=("$COMMON/jcs/jcs.cpp" "$DIR/epm_content.cpp" "$DIR/epm_verify.cpp" "$DIR/epm_fb.cpp" "$DIR/epm_authorize.cpp")

for test in epm_fb_test epm_authorize_test; do
  "$CXX" -std=c++17 -O2 -I"$DIR" -I"$EPMINC" -I"$FBINC" -I"$CPPBUILD" \
    "${SRC[@]}" "$DIR/tests/${test}.cpp" "$CRYPTOPP/libcryptopp.a" \
    -o "$DIR/tests/${test}"
  "$DIR/tests/${test}"
  rm -f "$DIR/tests/${test}"
done
