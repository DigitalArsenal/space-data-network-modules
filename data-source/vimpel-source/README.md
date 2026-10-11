# Vimpel Source

An SDK module that reads JSC Vimpel's public orbit data (spacedata.vimpel.ru) into canonical SDS records. Vimpel is three claims
in the catalog paper's inventory, and the module gives one output for each:

| Method | In | Out |
| --- | --- | --- |
| `normalize_orbits` | the osculating-element table (15 comma-separated columns, up to 20,000 rows, 8 MiB) on `source` | `states`: one `$OEM` per object, a single J2000 state at the reference epoch (UTC); `report` |
| `read_ephemeris` | one rectangular ephemeris: its file name on `name` (`<id>_<YYYYMMDD>_<HHMMSS>`), its rows (`index, x, y, z`) on `source` | `ephemeris`: one `$OEM`, position-only (`STATE_VECTOR_SIZE` 3), 600 s apart; `report` |
| `read_datefirst` | the datefirst file (`Nvym t_det_v Nnor t_det_n`) on `source` | `crosswalk`: candidate links from Vimpel numbers to NORAD numbers (JSON) |

Retrieval belongs to the SDN host flow: the login (Vimpel serves registered users), the RAR of ephemeris files, the schedule and the
archive. The module sees bytes. The same artifact runs in the browser and WasmEdge, byte for byte.

## Osculating elements to a state

The table prints osculating elements in J2000: semimajor axis (km), inclination and node (degrees), eccentricity, argument of
latitude u and argument of perigee ω (degrees). The state at the reference epoch is the instantaneous two-body conversion of the
catalog paper (section 4): true anomaly ν = u − ω, p = a(1 − e²),

```
r_pf = p / (1 + e cos ν) [cos ν, sin ν, 0]        v_pf = sqrt(μ / p) [−sin ν, e + cos ν, 0]
Q = Rz(Ω) Rx(i) Rz(ω)                              r = Q r_pf,  v = Q v_pf          μ = 398,600.4418 km³/s²
```

(`foundation/orbits` `cartesianFromKeplerian`; `files/orbit-products/src/vimpel.hpp` reads the table, shared with that module's
`normalize_vimpel`, which gives `$OPM`.) Velocity is analytic, never differenced from the ten-minute positions: differenced
velocity departs from it by up to 1.1 km/s. The elements are not SGP4 mean elements and are never offered to SGP4: the state is
the catalog integrator's epoch product (`analysis/catalog-composer`), not an input of the source-products flow.

Each state is named `vimpel:<id>` (leading zeros dropped), with `CATALOG_URI` `http://spacedata.vimpel.ru/` and the exact number as
`CATALOG_OBJECT_ID`. **No NORAD number and no international designator is invented.** The provider's other columns (first
observation, signed age, area/mass, magnitude, the two 50 %-confidence scalars) ride in `report`, as printed; the scalars give no
correlations or full uncertainty, so no covariance is made of them.

## Ephemeris

A Vimpel ephemeris is a file named for the native object and the UTC epoch of its first row, with a row per 600 s (`0, x, y, z`;
the index is the row number, not elapsed seconds). The `$OEM` keeps the positions as printed and is position-only, as
every Earth-fixed or position-only source of this repository writes it (`STATE_VECTOR_SIZE` 3): `analysis/od` reads that shape as
"fit the initial velocity from the positions". The OD fit of it is the source's `$OMM`, and the flow takes it on `fit_omm` with the
ephemeris on `ephemeris`: the `$OCM`, with the pooled model's covariance (rule 4, uncalibrated: E14 measured no Vimpel set) and the
`$MNV` over a history of fitted sets. A positions row inside the Earth, an index that is not the row number, a file name without
an epoch, or fewer than five rows refuses the file.

`analysis/od` gives an OEM that names no NORAD number the placeholder 99999 and designator `99999A` on its `$OMM`. The object is
the one named `vimpel:<id>`; a host must not read 99999 as a catalog number.

## The datefirst crosswalk

`datefirst` proposes a Vimpel-to-NORAD association; it does not prove it. `crosswalk` lists every pair as a **candidate**
(`status: candidate`), with `object: {norad}` and `evidence: {source: "datefirst", recordId: <SHA-256 of the edition>}` as the
integrator's identity recipe (`analysis/catalog-composer` `integrate_catalog`) takes them, the dates as printed (`YYYY-MM-DD`, or
null with `datesAsPrinted` when the digits are not a calendar date, as ten rows of the provider's file are: month 95, day 91), and the
declarations: a pair declared twice is one link with `declarations: 2`. The declarations are a graph: a Vimpel number declared
against two NORAD numbers (an alias), or one NORAD number against two Vimpel numbers, is a conflict, every link in it is
`ambiguous: true`, and `conflicts` names its members. Only a link the integrator tests compatible on normalized ephemerides binds an
identity (Baietto 2022, doi:10.25394/PGS.19658076, documents a historical datefirst pairing discrepancy). An object the file does
not map keeps `vimpel:<id>`.

Read for this module (local run, nothing committed): the 2026-09-21 table is 13,889 rows and the 2026-09-07 table 13,808, each
converted in 0.26 s; the datefirst file is 986 rows, 986 links (953 one-to-one, 33 ambiguous in 16 conflicts), 15 with an unreadable date.

## Build and test

```sh
npm ci
npm run build          # dist/isomorphic/module.wasm and dist/guest-link (single thread, SDK 0.8.27, SDS 1.245.0)
npm test               # the module through the SDK's browser harness
npm run test:parity    # headless Chrome, native WasmEdge, Docker WasmEdge: byte-identical
```

The tests check the states against the two-body relations (closed cases and the invariants of a general orbit: radius, vis-viva
speed, angular momentum and its direction, the eccentricity vector), never against the module's own output.
`flows/source-products/tests/source-chain.test.mjs` runs a synthetic ephemeris through the module, `analysis/od` and the flow.

## Licence and data

JSC Vimpel's data is behind a user agreement for registered users and has no public licence (data licence audit, id `vimpel`,
reproduce: no). **No Vimpel record is in this module, its tests or its fixtures**: they are synthetic, in the exact formats
(`tests/fixtures/vimpel-format.mjs`). Real files stay under `/opt/data/sdn-archive/vimpel-e3` for local runs. Records are computed
on and cited, never republished. `NOTICE.md` records the terms.

Credit line (the site's own condition: "Site reference is mandatory if using provided data in any publications"): JSC Vimpel,
http://spacedata.vimpel.ru/.
