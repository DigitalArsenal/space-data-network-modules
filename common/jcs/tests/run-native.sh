#!/bin/bash
# Build + run the RFC 8785 JCS canonicalizer tests natively.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"   # common/jcs
CXX="${CXX:-$(command -v clang++ 2>/dev/null || echo /opt/homebrew/opt/llvm/bin/clang++)}"
"$CXX" -std=c++17 -O2 -I"$DIR" "$DIR/jcs.cpp" "$DIR/tests/jcs_test.cpp" -o "$DIR/tests/jcs_test"
"$DIR/tests/jcs_test"
