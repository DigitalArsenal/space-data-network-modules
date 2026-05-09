# rf-ber-modulation

Bit-error-rate from Eb/N0 for the standard digital-modulation families
plus an erfc primitive. Phase 4 Wave E of the RF audit; consumed by
`rf-link-budget` to compute BER alongside the link margin.

## Exported kernels

| C entry | Form |
| --- | --- |
| `rf_erfc(x)` | Numerical Recipes §6.2 Chebyshev approximation (~7-digit accuracy) |
| `rf_ber_from_ebno(ebno_db, mod)` | dispatched by `mod`: |

| `mod` | Modulation | BER |
| --- | --- | --- |
| 0 | BPSK | `0.5 · erfc(√(Eb/N0))` |
| 1 | QPSK | `0.5 · erfc(√(Eb/N0))` |
| 2 | 8-PSK | `(2/3) · erfc(√(Eb/N0 · sin(π/8)))` |
| 3 | 16-QAM | `0.75 · erfc(√(0.4 · Eb/N0))` |
| 4 | 64-QAM | `(7/12) · erfc(√(Eb/N0 / 7))` |
| 5 | FSK (coherent) | `0.5 · exp(−0.5 · Eb/N0)` |

Returns `0.5` (worst case) for unrecognized `mod` codes — same fallback
as the JS port at `RfCommsCore.js:4286-4312`.

## Authority

Sklar, *Digital Communications: Fundamentals and Applications*, 2nd
ed., Prentice-Hall — Chapter 4 (closed-form BER expressions).
Numerical Recipes 3rd ed., §6.2.2 (`erfcc`).

## Status

Skeleton complete; build verification, fixture vectors, and
orbpro-integration registration pending.
