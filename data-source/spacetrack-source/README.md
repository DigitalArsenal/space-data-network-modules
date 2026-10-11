# Space-Track Source

An SDK module that turns Space-Track's REST output into canonical SDS records: GP and GP-history element sets as `$OMM`, the
SATCAT as `$CAT`. It is the Space-Track entry of the per-source products (`flows/source-products`, catalog pipeline C2): the flow
takes its `$OMM` on `element_sets` and gives the source's `$OMM`, `$OCM` (covariance and its label) and `$MNV`.

The same artifact runs in the browser and WasmEdge, byte for byte. Retrieval belongs to the SDN host flow: the login and its
credentials, the polite request rate (the ephemeris-source registry's), the schedule and the archive. The module sees bytes only.

## Methods

| Method | In (`source`) | Out |
| --- | --- | --- |
| `parse_gp` | `gp` or `gp_history` JSON (omm-gp-json): a JSON array of flat objects, or JSON lines | `omm`: size-prefixed `$OMM`, input order, no padding between records; `report` |
| `parse_satcat` | `satcat` JSON | `catalog`: size-prefixed `$CAT`, input order; `report` |

Input is bounded to 256 MiB (the archive's largest day of the GP history is 162 MB as served), output likewise. The JSON is read
one object at a time (nlohmann/json's SAX parser), so memory follows the output, not ten times the input: a 162 MB day of
142,687 sets takes 2.8 s on one thread under the interpreted host.

## What is read

Space-Track writes every value as text. A number is parsed from its whole text.

| `$OMM` field | From | Notes |
| --- | --- | --- |
| `NORAD_CAT_ID` | `NORAD_CAT_ID`, else `TLE_LINE1` | Decimal text or Alpha-5 (below). When both are present they must agree, or the set is dropped. |
| `EPOCH`, `CREATION_DATE` | same | As served (UTC, no zone suffix); a time that is not ISO 8601 drops the set. |
| `MEAN_MOTION` (rev/day), `ECCENTRICITY`, `INCLINATION`, `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, `MEAN_ANOMALY` (degrees) | same | Required, range checked. |
| `BSTAR` (1/Earth radii), `MEAN_MOTION_DOT` (rev/day²), `MEAN_MOTION_DDOT` (rev/day³) | same | Required: a set without the terms SGP4 propagates with is not one SGP4 can use, and none is invented. |
| `MEAN_ELEMENT_THEORY` | same | `SGP4`, or `SGP4-XP` as `SGP4XP`; any other theory drops the set. |
| `EPHEMERIS_TYPE` | same | Mapped as `data-source/celestrak-parser` maps it, so one set from either source carries one value. |
| `REFERENCE_FRAME` | `REF_FRAME` | TEME of date, the SGP4 contract; another frame drops the set. `TIME_SYSTEM` must be UTC. |
| `OBJECT_NAME`, `OBJECT_ID`, `ORIGINATOR`, `COMMENT`, `CLASSIFICATION_TYPE`, `ELEMENT_SET_NO`, `REV_AT_EPOCH`, `CCSDS_OMM_VERS` | same | `ORIGINATOR` stays Space-Track's (`18 SPCS`); the flow names the source. |
| `USER_DEFINED_PARAMETERS` `GP_ID` | `GP_ID` | The set's own id. A `GP_ID` seen twice in one input (the archive's windows overlap by a boundary second) is dropped and counted. |

Not carried: `SEMIMAJOR_AXIS`, `PERIOD`, `APOAPSIS`, `PERIAPSIS` (computed from the elements, not measured), the object attributes
(`OBJECT_TYPE`, `RCS_SIZE`, `COUNTRY_CODE`, `LAUNCH_DATE`, `SITE`, `DECAY_DATE`: they belong to the SATCAT), and the two-line text
beyond the catalog number check.

**Alpha-5.** Five columns hold 0 to 99999 as digits. Alpha-5 extends them to 339999: a letter (A = 10 … Z = 33, I and O omitted)
and four digits, so `A0000` is 100000, `J0000` is 180000 (`H9999` is 179999) and `Z9999` is 339999. Space-Track's JSON gives
catalog numbers as decimal text and its two-line sets as Alpha-5; the module reads both (`common/alpha5.hpp`). In the archive
read for this module (2026-09-26 to 2026-10-11), 1,181 of 100,149 sets of one day and 1,246 of 32,597 current sets are above 99999.

**SATCAT.** `OBJECT_NAME`, a valid international designator (`OBJECT_ID`; "TBA - TO BE ASSIGNED" and the like are left unset and
counted, no join key is made of them), `NORAD_CAT_ID`, `OBJECT_TYPE`, `COUNTRY` as `OWNER`, `LAUNCH` and `DECAY` dates, `SITE`,
`PERIOD`, `INCLINATION`, `APOGEE`, `PERIGEE`. A decay date makes the object `DECAYED`; nothing says an object operates, so the
status stays `UNKNOWN`. `RCSVALUE` is 0 unless the account may read it, so only a positive value is stated as `RCS`
(`RCS_SIZE` has no field in `$CAT`). An entry with `CURRENT = N` was superseded and is not an object. A country code the standard's
`legacyCountryCode` does not list is left unset and counted by code in the report: in the 2026-10-11 SATCAT, 84 entries carry 15
codes the enum lacks (CZE, TWN, PER, SVK, BGR, AGO, JOR, KWT, PRI, UGA, HRV, BWA, BHR, SLB, CAN).

## Reports

`report` is module control metadata (JSON), kept by the host beside the input it describes: records read and emitted, duplicates,
the dropped records by reason with the first 20 examples, Alpha-5 count, theories, and the epoch and creation-date ranges. A record
that cannot be read is dropped and counted; an input that is not a JSON array of objects (or JSON lines of them), or that gives
nothing readable, is refused whole with no partial output. Errors are flags (an invoke error code and message), never exceptions.

## Build and test

```sh
npm ci
npm run build          # dist/isomorphic/module.wasm and dist/guest-link (single thread, SDK 0.8.27, SDS 1.245.0)
npm test               # the module through the SDK's browser harness
npm run test:parity    # headless Chrome, native WasmEdge, Docker WasmEdge: byte-identical
```

`flows/source-products/tests/source-chain.test.mjs` runs the module's records through the compiled flow.

## Licence and data

Space-Track data is under the Space-Track User Agreement (2019), with USSPACECOM's blanket approval to redistribute basic SSA
data (element sets, SATCAT, decay) with citation. This repository's rule (the data licence audit, `orbit-accuracy-experiments`
`data/licenses.json`, id `space-track`, reproduce: no) keeps Space-Track element sets and anything derived per sample out of the
tree: **no Space-Track record is in this module, its tests or its fixtures.** The fixtures are synthetic, in Space-Track's exact
format (`tests/fixtures/spacetrack-format.mjs`), and every expected value comes from the numbers they are made of and the published
Alpha-5 rule. Real files stay under `/opt/data/sdn-archive/spacetrack` for local runs. Records are computed on and cited, never
republished; the report of the flow carries the licence of each.

`NOTICE.md` records the terms. Credit line for any publication of analysis: Source: USSPACECOM / 18th Space Defense Squadron, via Space-Track.org
(https://www.space-track.org). Obtain the data with a Space-Track.org account.
