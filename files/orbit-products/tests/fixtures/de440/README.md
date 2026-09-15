# Public DE440 test data

See [the validation report](../../../../../docs/de440-validation.md) for all
sources, measured results, frames, units, time scales and tolerance rationales.

The committed `de440-2026.bsp` is a 114,688-byte CSPICE copy of the original
DE440s records spanning 2026 TDB, including every original segment. It is
suitable for invocation and runtime-parity tests and is never baked into WASM.
The full public 32,726,016-byte DE440s source is intentionally Git-ignored.

From the repository root:

```sh
python3 files/orbit-products/tests/fixtures/de440/download.py
node --test files/orbit-products/tests/de440_reference.test.mjs
```

Python 3.11+ is required for fixture tooling. Expected vectors are committed,
independently evaluated by NAIF CSPICE N0067, with a separate recorded public
Horizons cross-check. The test run does not regenerate reference data.
