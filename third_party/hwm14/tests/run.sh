#!/bin/bash
# Native: bit-exact against the FORTRAN oracle and byte-identical to the NRL
# check output. WASM (when EMSDK is active): the NRL check output byte for byte
# and the oracle within 1e-4 m/s (musl libm differs from the oracle's libm in
# the last bit; NRL quotes ~1e-4 m/s between compilers).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CXX="${CXX:-c++}"
SRC=("$ROOT/hwm14.cpp" "$ROOT/hwm14_data.cpp")
FLAGS=(-std=c++17 -O2 -ffp-contract=off -Wall -Wextra -Werror)
"$CXX" "${FLAGS[@]}" -o "$WORK/checkhwm14" "${SRC[@]}" "$HERE/checkhwm14.cpp"
"$CXX" "${FLAGS[@]}" -o "$WORK/parity" "${SRC[@]}" "$HERE/oracle_parity.cpp"
"$WORK/checkhwm14" "$WORK/check.txt"
cmp "$WORK/check.txt" "$ROOT/nrl/Check/gfortran.txt" && echo "native: NRL check output byte-identical"
"$WORK/parity" "$ROOT/oracle/fixtures/inputs.bin" "$ROOT/oracle/fixtures/expected-gfortran16-O0.bin"
if command -v em++ >/dev/null 2>&1; then
    EMFLAGS=(-std=c++17 -O2 -ffp-contract=off -sNODERAWFS=1 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1)
    em++ "${EMFLAGS[@]}" -o "$WORK/check.js" "${SRC[@]}" "$HERE/checkhwm14.cpp"
    em++ "${EMFLAGS[@]}" -o "$WORK/parity.js" "${SRC[@]}" "$HERE/oracle_parity.cpp"
    node "$WORK/check.js" "$WORK/check-wasm.txt"
    cmp "$WORK/check-wasm.txt" "$ROOT/nrl/Check/gfortran.txt" && echo "wasm: NRL check output byte-identical"
    node "$WORK/parity.js" "$ROOT/oracle/fixtures/inputs.bin" "$ROOT/oracle/fixtures/expected-gfortran16-O0.bin" 1e-4
else
    echo "wasm: skipped (no em++ on PATH)"
fi
