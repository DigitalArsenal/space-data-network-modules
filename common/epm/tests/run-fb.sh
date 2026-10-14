#!/bin/bash
# Build + run the EPM FlatBuffer end-to-end tests natively (EPM_generated.h from
# licensing/core, flatbuffers headers, the repo's pinned Crypto++; see cryptopp.sh).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"     # common/epm
COMMON="$(cd "$DIR/.." && pwd)"             # common
ROOT="$(cd "$COMMON/.." && pwd)"            # space-data-network-modules
EPMINC="$ROOT/licensing/core/src/cpp/generated/sds"
source "$DIR/tests/cryptopp.sh"

FBINC="${SDN_FLATBUFFERS_INCLUDE_DIR:-}"
for cand in "$FBINC" "$ROOT/../flatbuffers/include" "$ROOT/../../../flatbuffers/include" /opt/homebrew/include /usr/local/include; do
  [ -n "$cand" ] && [ -f "$cand/flatbuffers/flatbuffers.h" ] && FBINC="$cand" && break
done
if [ -z "$FBINC" ] || [ ! -f "$FBINC/flatbuffers/flatbuffers.h" ]; then
  echo "flatbuffers headers not found; set SDN_FLATBUFFERS_INCLUDE_DIR." >&2
  exit 1
fi

CXX="${CXX:-$(command -v clang++ 2>/dev/null || echo /opt/homebrew/opt/llvm/bin/clang++)}"
SRC=("$COMMON/jcs/jcs.cpp" "$DIR/epm_content.cpp" "$DIR/epm_verify.cpp" "$DIR/epm_fb.cpp" "$DIR/epm_authorize.cpp" "$DIR/epm_key_proof.cpp")

for test in epm_fb_test epm_authorize_test; do
  "$CXX" -std=c++17 -O2 -I"$DIR" -I"$EPMINC" -I"$FBINC" -I"$CRYPTOPP_INCLUDE" \
    "${SRC[@]}" "$DIR/tests/${test}.cpp" "$CRYPTOPP_LIB" \
    -o "$EPM_BUILD/${test}"
  "$EPM_BUILD/${test}"
done
