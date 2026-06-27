#!/bin/bash
# Native unit test for the secp256k1/BIP32 xpub identity crypto (Crypto++).
# Builds Crypto++ statically once, then compiles + runs tests/xpub_auth_test.cpp.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"   # tests/
ROOT="$(cd "$DIR/.." && pwd)"          # module root
SRCCPP="$ROOT/src/cpp"
BUILD="$ROOT/.build"
CRYPTOPP="$BUILD/cryptopp-src"

if [ ! -d "$CRYPTOPP" ]; then
  echo "Crypto++ source missing ($CRYPTOPP). Run build.sh once to fetch it." >&2
  exit 1
fi

# Provide a <cryptopp/...> include root.
[ -e "$BUILD/cryptopp" ] || ln -s cryptopp-src "$BUILD/cryptopp"

ncpu="$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
if [ ! -f "$CRYPTOPP/libcryptopp.a" ]; then
  echo "Building Crypto++ static lib (native)..."
  make -C "$CRYPTOPP" -j"$ncpu" libcryptopp.a
fi

echo "Compiling xpub_auth test..."
clang++ -std=c++17 -O2 \
  -I"$BUILD" -I"$SRCCPP/include" \
  "$SRCCPP/src/xpub_auth.cpp" "$DIR/xpub_auth_test.cpp" \
  "$CRYPTOPP/libcryptopp.a" \
  -o "$BUILD/xpub_auth_test"

echo "Running xpub_auth test..."
"$BUILD/xpub_auth_test"
