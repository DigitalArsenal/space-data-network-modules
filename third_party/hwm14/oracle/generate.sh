#!/bin/bash
# Regenerates oracle/fixtures from the unmodified NRL FORTRAN (needs gfortran).
# The committed fixtures were produced with GNU Fortran (Homebrew GCC 16.2.0),
# -O0 -ffp-contract=off, on arm64 macOS (Apple libm). That configuration
# reproduces nrl/Check/gfortran.txt byte for byte.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
OUT="$HERE/fixtures"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [ "$(uname)" = "Darwin" ]; then export SDKROOT="${SDKROOT:-$(xcrun --show-sdk-path)}"; fi
node "$HERE/make-inputs.mjs" "$OUT/inputs.bin"
gfortran -O0 -ffp-contract=off -J "$WORK" -o "$WORK/oracle" "$ROOT/nrl/hwm14.f90" "$HERE/oracle.f90"
gfortran -O0 -ffp-contract=off -J "$WORK" -o "$WORK/checkhwm14" "$ROOT/nrl/hwm14.f90" "$ROOT/nrl/checkhwm14.f90"
cd "$ROOT/nrl"   # the FORTRAN opens its data files from the working directory
"$WORK/checkhwm14" > "$WORK/check.txt"
cmp "$WORK/check.txt" "$ROOT/nrl/Check/gfortran.txt"
"$WORK/oracle" "$OUT/inputs.bin" "$OUT/expected-gfortran16-O0.bin" 1
"$WORK/oracle" "$OUT/inputs.bin" "$WORK/reverse.bin" -1
cmp "$OUT/expected-gfortran16-O0.bin" "$WORK/reverse.bin"   # FORTRAN caches are result-transparent
(cd "$OUT" && shasum -a 256 inputs.bin expected-gfortran16-O0.bin > SHA256SUMS)
echo "fixtures regenerated; FORTRAN reproduces Check/gfortran.txt and is order-independent"
