#!/bin/bash
# Sourced by run-native.sh and run-fb.sh: a native Crypto++ for the EPM tests.
#
# The source is the repo's pinned Crypto++ (scripts/emsdk-pin.json
# vendoredSources.cryptopp, 8.9.0): CRYPTOPP_SOURCE_DIR, or deps/cryptopp as
# `node scripts/provision-emsdk.mjs --cryptopp` provisions it. Nothing is fetched
# here. The tree is copied into tests/.build/cryptopp (so other builds' objects
# never mix with these) and built there once as a native libcryptopp.a.
# Sets CRYPTOPP_INCLUDE (the dir holding cryptopp/) and CRYPTOPP_LIB.
set -euo pipefail
: "${ROOT:?ROOT must be the space-data-network-modules root}"
EPM_TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EPM_BUILD="$EPM_TESTS/.build"

CRYPTOPP_SRC=""
for cand in "${CRYPTOPP_SOURCE_DIR:-}" "$ROOT/deps/cryptopp"; do
  [ -n "$cand" ] || continue
  if [ -f "$cand/aes.h" ]; then CRYPTOPP_SRC="$cand"; break; fi
  if [ -f "$cand/cryptopp/aes.h" ]; then CRYPTOPP_SRC="$cand/cryptopp"; break; fi
done
if [ -z "$CRYPTOPP_SRC" ]; then
  echo "No local Crypto++ 8.9.0. Provision it with: node scripts/provision-emsdk.mjs --cryptopp" >&2
  echo "or set CRYPTOPP_SOURCE_DIR to a CRYPTOPP_8_9_0 source tree." >&2
  exit 1
fi
if ! grep -Eq '^#define CRYPTOPP_VERSION 890[[:space:]]*$' "$CRYPTOPP_SRC/config_ver.h"; then
  echo "Crypto++ at $CRYPTOPP_SRC is not 8.9.0 (the pin in scripts/emsdk-pin.json)." >&2
  exit 1
fi

CRYPTOPP_INCLUDE="$EPM_BUILD"
CRYPTOPP_LIB="$EPM_BUILD/cryptopp/libcryptopp.a"
if [ ! -f "$CRYPTOPP_LIB" ]; then
  echo "Building native Crypto++ 8.9.0 from $CRYPTOPP_SRC ..."
  rm -rf "$EPM_BUILD/cryptopp"
  mkdir -p "$EPM_BUILD/cryptopp"
  (cd "$CRYPTOPP_SRC" && find . -maxdepth 1 -type f \
    ! -name '*.o' ! -name '*.a' ! -name '*.so' ! -name '*.dylib' \
    -exec cp {} "$EPM_BUILD/cryptopp/" \;)
  ncpu="$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  # Built with the system make/c++ toolchain only; CXX from the caller is used for the tests.
  env -u CXX -u CXXFLAGS make -C "$EPM_BUILD/cryptopp" -j"$ncpu" libcryptopp.a >"$EPM_BUILD/cryptopp-build.log" 2>&1 || {
    tail -30 "$EPM_BUILD/cryptopp-build.log" >&2; exit 1; }
fi
