# space-data-loaders

Readers that turn PUBLISHED reference data sets into SDS records. Today it
carries one: the IERS Earth-orientation and leap-second reader that
`gmat-08-frames-and-state-representations` needs.

## What is here, and what it measures

`src/finals2000a.hpp` is a dependency-free header that reads the published IERS
`finals2000A` fixed-column file, interpolates between its nodes, refuses outside
its span, resolves TAI-UTC from the IERS Bulletin C step table, and computes the
CIDv1 that `$EOP.DATA_SET_CID` carries.

`tests/finals2000a_precision.cpp` measures it against the **published file
itself** — `fixtures/finals2000A.daily`, vendored with its source URL, retrieval
date and SHA-256 in `fixtures/PROVENANCE.md`. No expectation is typed by hand:
every expected value is re-read out of the file's own columns, so refreshing the
fixture needs no edit. Measured on 2026-08-30, 18 checks, 0 failures:

| Measurement | Result | Bar | Authority |
| --- | --- | --- | --- |
| UT1-UTC at all 181 table nodes | **0.0 s** | 1e-9 s | IERS finals2000A |
| Polar motion x at all 181 nodes | **0.0 arcsec** | 1e-9 | IERS finals2000A |
| Polar motion y at all 181 nodes | **0.0 arcsec** | 1e-9 | IERS finals2000A |
| The same UT1-UTC carried as float32 | **3.7e-9 s** | must MISS 1e-9 | IEEE-754 binary32 |
| TAI-UTC at five published Bulletin C dates | exact | 0 | IERS Bulletin C |
| Epoch outside the table | refused | — | no extrapolation |

The float32 row is the point of the whole exercise: it is why SDS `$EOP` grew
the double-precision `_HP` fields in 1.199.0. The pre-existing float fields
cannot carry the published digits, and a consumer that reads them cannot
demonstrate the agreement this task requires.

## What is NOT here yet

The WASM module that wraps this reader and emits the `$EOP` records.

Themis ruled on 2026-08-30 that **no SDS record can carry a published external
document** — `$FSB` is FlatSQL-scoped and `$DTT` is terrain-scoped — and that
the loader must therefore FETCH `finals2000A` itself over the `http` capability,
in the shape every module under `data-source/` already uses, rather than receive
the bytes on an input port. That ruling also settled two field questions:
`DATA_SET_CID` is a CIDv1 `raw`/`sha2-256` in base32 (implemented here, and
independently re-derived in the suite), and `DATA_SET_EPOCH` is the **issue's
publication instant recorded with the data set**, not a date derived from the
rows.

The reader, the precision and the CID are therefore landed and measured. What
remains is transport: the `http` guest-link fetch, the publication instant, the
record emission, the signature, and a headless measurement of the shipped
artifact with the `http` hook stubbed against this fixture. Until that lands,
`foundation/frames` takes its Earth orientation as an `$EOP` row on its
`earth_orientation` port — which is the same contract, with the caller supplying
the row — and REFUSES with `MISSING_EOP_DATA` when it is absent.

## Running it

```sh
node --test tests/*.test.mjs
```
