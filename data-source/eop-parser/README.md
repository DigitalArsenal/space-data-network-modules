# Earth orientation source parser

Pure C++/WASM parser for three fixed-column EOP products. No fetch, clock,
storage or publication runs inside this module. No JavaScript computes
production physics. The published SDS `EOP.fbs` / `$EOP` binding is generated
from `spacedatastandards.org@1.202.0`; no schema is added or modified.

## Invoke

Methods: `parse_finals2000a`, `parse_c04`, `parse_paris`.

Supply exactly one of:

- `body`: unmodified UTF-8/ASCII source bytes, at most 16 MiB.
- `response`: the established hostcap/http-request JSON
  `{status:200,bodyB64:"..."}`. HTTP 304 emits only `unchanged`; any other
  status fails. Base64 exists only at this existing HTTP control boundary.

An optional `job` from [eop-request](../eop-request/README.md) carries
`source_url`, `series_name`, `format`. A supplied format must match the method.
The caller may also supply `data_set_epoch` (the publication issue epoch,
ISO 8601 UTC); it is never inferred from retrieval time or the final data row.

Outputs:

- `records`: one stream of `[uint32 little-endian length][standalone $EOP]`
  records, matching the established celestrak-parser transport. Each record
  has the canonical FlatBuffer alignment relative to its own start.
- `meta`: source URL, fixed product/series name, format, row count, SHA-256 of
  the **entire fetched body**, CIDv1 raw/sha2-256 in multibase base16, and count
  of empty future finals rows. Retain this metadata with the records,
  especially the name of an `OTHER` series.
- `unchanged`: HTTP 304 notice, with no records or metadata replacement.

Each row stores the dataset CID and optional issue epoch. Core values use
both authoritative `_HP` doubles and rounded float convenience copies.
Explicit HP zeroes are preserved. Formal uncertainties use SDS float fields.
TAI−UTC is absent: these files do not publish it, and the frames consumer uses
ERFA's leap-second table.

Malformed rows, invalid dates/MJDs, fractional daily MJDs, duplicates,
non-increasing dates, invalid flags, non-finite fields and negative
uncertainties fail the whole invocation before any output is emitted.
No silently truncated or partially successful dataset is emitted.

## Source formats and units

Column numbers below are **one-based inclusive**. EOP dates and MJD use UTC;
polar motion refers to ITRS, celestial pole corrections to GCRS.

### finals2000A

Authority: [USNO/IERS readme.finals2000A](https://maia.usno.navy.mil/ser7/readme.finals2000A).
Source: [IERS finals2000A.all](https://datacenter.iers.org/data/9/finals2000A.all).
The [USNO mirror](https://maia.usno.navy.mil/ser7/finals2000A.all) has the same layout.

| Quantity | Value columns | Uncertainty columns | Source unit |
| --- | --- | --- | --- |
| year/month/day | 1–2 / 3–4 / 5–6 | — | Gregorian, two-digit year resolved using MJD |
| MJD | 8–15 | — | UTC day |
| xp | 19–27 | 28–36 | arcsec |
| yp | 38–46 | 47–55 | arcsec |
| UT1−UTC | 59–68 | 69–78 | seconds |
| LOD | 80–86 | 87–93 | milliseconds |
| dX | 98–106 | 107–115 | milliarcseconds |
| dY | 117–125 | 126–134 | milliarcseconds |

This parser consistently selects Bulletin A columns, including historical
rows; Bulletin B columns 135–185 are not substituted. Series is `FINALS2000A`.
Polar/UT1/CIP flags at 17/58/96 must be `I` or `P` for populated groups.
The row is `PREDICTED` if **any supplied group** is `P`, otherwise `OBSERVED`.
SDS has one row-level quality flag, so mixed-group status is conservatively
collapsed. LOD and CIP predictions may be blank; their fields remain absent.
Rows containing a date/MJD and entirely blank predictions are counted and
skipped. Missing optional corrections read as SDS defaults, not observations
of zero. Hosts requiring observed LOD/CIP must inspect field presence.

### Modern C04 and Paris legacy product

Authority: [Paris C04 readme](https://hpiers.obspm.fr/iers/eop/eopc04/readme),
the FORMAT and units headers in the two checked-in excerpts, and
[IERS C04 IAU2000A metadata](https://datacenter.iers.org/versionMetadata.php?filename=latestVersionMeta%2F254_EOP_C04_20u24.62-NOW254.txt).

Modern `eopc04.1962-now`: `4(I4),F10.2,16(F12.x)`; date/hour columns
1–16, MJD 17–26, followed by xp, yp, UT1−UTC, dX, dY, x-rate, y-rate,
LOD and their eight uncertainties. LOD is at 111–122; its uncertainty is
207–218. Rates are parsed around by fixed offsets; SDS has no rate fields.
`SERIES=IERS_C04_20`.

Paris `eopc04_IAU2000.62-now` uses the published legacy FORMAT:
`3(I4),I7,2(F11.6),2(F12.7),2(F11.6),2(F11.6),2(F11.7),2(F12.6)`.
The order is date, MJD, xp, yp, UT1−UTC, LOD, dX, dY, then the six
uncertainties in that order. `SERIES=OTHER`; metadata names it
“Paris Observatory EOP 20 C04 legacy IAU2000 format”. This is another format
of the C04 solution, not a statistically independent product.

Both C04 files give angles in arcseconds and UT1−UTC/LOD in **seconds**.
The readme's overview mentions milliseconds, but the actual file headers
and IERS product metadata explicitly specify seconds; the parser follows
those data-format units. Only the 00:00 UTC dX/dY products are supported.
12-hour files and dPsi/dEps variants are not accepted by these methods.

All three products identify offsets against IAU 2000/2000A in their file
headers/product metadata; rows carry `IAU_CONVENTION=IAU_2000A`. The C04
readme uses broader “2006/2000A” wording; the record follows the actual
product's declared offset convention.

Conversion: arcsec × π/648000 → radians; milliarcsec × 0.001 × π/648000 →
radians; milliseconds × 0.001 → seconds. No tide or smoothing model is applied
by the parser.

## Frames interpolation

See [foundation/frames](../../foundation/frames/README.md#eop-tables-and-interpolation).
The host selects a small ordered window of this stream (up to 366 rows),
retaining its dataset provenance, and supplies it on `earth_orientation`.
The entire 1962–now archive is not an invoke-sized frame table.

## Verification

```sh
npm ci
node build.mjs
node --test tests/sdk_compat.test.mjs
SDN_RUN_EOP_PARITY=1 node --test tests/*.test.mjs
```

The build uses the SDK's explicit `single-thread` emception profile. Its
primary artifact is `dist/isomorphic/module.wasm`, with guest-link artifacts
for composition. The browser parity runner requires pinned `esbuild`, Chrome,
native WasmEdge 0.16.4, and Docker's pinned WasmEdge 0.16.4 image.

Fixtures are verbatim excerpts of the published files, not generated values.
[provenance.json](tests/fixtures/provenance.json) records source URLs, original
line numbers, retrieval time and SHA-256 for both full files and excerpts.
`authoritative.test.mjs` independently transcribes all six core values at
MJD 60000, states frames/units/time scale, and measures serialization/conversion
error. Its tolerance is 2e-21 radians and 1e-18 seconds, covering binary64
rounding only, not the scientific uncertainty of the input EOP.
