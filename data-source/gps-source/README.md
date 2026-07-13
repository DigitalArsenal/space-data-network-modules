# GPS Almanac (USCG NAVCEN SEM/YUMA) Data Source (A2.2c-2)

A Tier-1 `data_source` adapter on the shared provider template
(`common/provider_source.hpp`) plus the promoted GPS-time helper
(`common/gps_time.hpp`, promoted here in A2.2c-2). On a TIMERS-driven `pull` it
fetches a public GPS almanac from USCG NAVCEN — either the **YUMA**
(`current_yuma.alm`) or **SEM** (`current_sem.al3`) product, auto-detected — and
for each PRN emits a schema-exact SDS **OMM** record, stores it, signs its
content id, and publishes a schema-exact **PNM** pointer.

## Pull flow (`src/gps_source.cpp`)

1. **Fetch** — GET `https://www.navcen.uscg.gov/sites/default/files/gps/almanac/current_yuma.alm`
   (one small file, ~7–19 KB; no manifest, no per-object fan-out). The raw file
   is SHA-256'd once and bound into every record's provenance. `sourceUrl` may
   override to the SEM product; the parser auto-detects SEM vs YUMA from content.
2. **Parse** — YUMA (labelled `Key: value`, angles in radians) or SEM (flat
   14-token records, angles in **semicircles**, inclination offset from 0.30
   semicircles, plus SVN / URA / config). Both decode to the same physical
   elements.
3. **Per PRN** — map the mean Keplerian elements to a schema-exact OMM (see
   below), `storage.write` it (schema `OMM`), `keyslot.sign` its CID, and
   `pubsub.publish` a PNM on `sdn/data-source/gps`. `objectCap` (default 40 ≥ the
   32 almanac slots) bounds per-pull record churn.

## Canonical-mapping decision: almanac elements → OMM (honest, no fabricated state)

A GPS almanac is a set of **reduced-precision MEAN quasi-Keplerian ELEMENTS**
(one per PRN), NOT a state-vector ephemeris. Per the A2.2a ethos we **do not
fabricate state vectors by propagating the almanac**. The faithful container for
mean elements is the SDS **OMM** (not OEM). Each PRN → one OMM record:

| OMM field           | value                                   | note |
|---------------------|-----------------------------------------|------|
| `SEMI_MAJOR_AXIS`   | `sqrt(A)^2` (km)                        | direct, no model |
| `MEAN_MOTION`       | `sqrt(GM/a^3)` (rev/day)               | two-body; `GM` = GPS ICD WGS-84 `398600.5 km^3/s^2` (recorded in `GM`) |
| `ECCENTRICITY`      | `e`                                     | direct |
| `INCLINATION`       | deg                                     | YUMA rad / SEM `(0.30 + delta)` semicircles |
| `RA_OF_ASC_NODE`    | deg — **see caveat 2**                 | Omega_0 |
| `ARG_OF_PERICENTER` | deg                                     | omega |
| `MEAN_ANOMALY`      | deg, normalized `[0,360)`              | M_0 |

### Honesty caveats (in the record `COMMENT`, provenance, and here)

1. **`MEAN_ELEMENT_THEORY = "GPS-LNAV-ALMANAC"` — NOT SGP4.** These are GPS
   broadcast-almanac Keplerian elements for the GPS almanac (two-body +
   nodal-regression) propagation model. **Do not propagate them with SGP4.**
2. **`REFERENCE_FRAME = "GPS-BROADCAST"` — no CCSDS frame is declared.**
   `RA_OF_ASC_NODE` (Omega_0) is the ascending-node longitude referenced to the
   Greenwich meridian at the **start of the GPS week** (an ECEF-referenced
   quantity), NOT an inertial (TEME/J2000) RAAN. Inclination / argp / mean
   anomaly are frame-agnostic. (Same "preserve the truth, OD/consumer owns the
   transform" split A2.2a uses for frames.)
3. **`TIME_SYSTEM = "GPS"`.** `EPOCH` is the GPS-time calendar representation of
   `(week, toa)` with **no** GPS→UTC leap-second correction (via the shared
   `ps::gps_seconds_to_iso`). GPS week rollover is resolved with the post-2019
   anchor (`true week = 2048 + as-distributed 10-bit week`; e.g. `379 → 2427`),
   valid until ~2038; the raw week is kept in provenance for recomputation.
4. **`NORAD_CAT_ID = 0`, `OBJECT_ID = ""` — not fabricated.** The almanac carries
   only a PRN (and, in SEM, an SVN); neither is a NORAD id / international
   designator, and the PRN→NORAD assignment is time-varying and absent from the
   almanac. `OBJECT_NAME = "GPS PRN NN"`; PRN/SVN/health/config/URA kept in
   provenance.

### A2.4 implication (documented, not silently skipped)

The A2.4 **hard-RMS parity gate** (fit SGP4 to a source state-vector ephemeris,
RMS ≤ CelesTrak SupGP RMS) is **NOT achievable for GPS from the almanac alone**:
(a) the almanac is not a state-vector ephemeris and we must not synthesize one by
propagation; (b) even an element-space comparison vs CelesTrak's `GPS-A` OMM is
non-independent — it needs a frame+theory reconciliation (GPS-BROADCAST ECEF-week
node & GPS-Kepler mean motion vs SGP4 inertial elements) plus a PRN→NORAD
cross-reference the almanac lacks. So GPS's A2.4 gate is **blocked at the
hard-RMS level pending a GPS state-vector ephemeris source** (IGS/precise
products, an owner decision); any interim element check must be labeled
non-independent. This mirrors A2.4's "blocked on data access, NOT descoped to
soft gates" language. Details + the exact CelesTrak query are in
`test/fixtures/supgp-reference-draft/`.

## Fetch politeness / cadence

- One small file per pull (single GET, ~7–19 KB). The module `timers` block runs
  `pull` every **12h** (2×/day); NAVCEN regenerates the current almanac ~daily at
  most, so 12h captures every refresh promptly without over-polling.
- `objectCap` (default **40**) bounds per-pull *record* churn (storage.write +
  pubsub), not fetch load. The constellation is 32 almanac slots, so the default
  emits every PRN in one pull. Configurable via `{"objectCap":…, "sourceUrl":…}`.

## PNM / provenance

- `FILE_ID` = `gps:OMM:<prn>:<epoch>` (CelesTrak `<source>:<schema>:<key>:<epoch>`
  partition convention; key = PRN since the almanac has no NORAD id).
- `FILE_NAME` = the source file basename (e.g. `current_yuma.alm`).
- Published message = `{"PNM":{…}, "provenance":{…}}`; provenance carries
  `SOURCE_NAME`, `SOURCE_URL`, `SOURCE_SHA256`, `DATA_SOURCE = GPS-A`,
  `RECORD_SCHEMA = OMM`, the honest labels (`MEAN_ELEMENT_THEORY`,
  `REFERENCE_FRAME`, `TIME_SYSTEM`), and the raw per-PRN broadcast fields
  (`GPS_PRN`, `GPS_SVN`, `GPS_HEALTH`, `GPS_CONFIG`, `GPS_URA`, `GPS_WEEK_RAW`,
  `GPS_WEEK_RESOLVED`, `TOA_SECONDS`, `SQRT_A_M_HALF`, `OMEGA_DOT_RAD_S`,
  `AF0_S`, `AF1_S_S`, `GM_KM3_S2`) so a future frame/theory-reconciling pass can
  reprocess without re-fetching.

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
node --test test/*.test.mjs
```

`test/module.test.mjs` instantiates the rebuilt WASM with a mock
`space_data_module_host` bridge serving the **real** trimmed-not-needed
(verbatim) YUMA + SEM fixtures, and asserts: almanac parse → 32 OMM records with
schema-exact keys and the honest labels (`MEAN_ELEMENT_THEORY=GPS-LNAV-ALMANAC`,
`REFERENCE_FRAME=GPS-BROADCAST`, `TIME_SYSTEM=GPS`, `NORAD_CAT_ID=0`,
`OBJECT_ID=""`), the exact PRN-01 mean-element values, the week-rollover-resolved
GPS-time epoch, YUMA↔SEM element consistency (semicircle handling), signed PNM
structure, provenance `SOURCE_SHA256` binding, `objectCap`, non-200 fail-closed,
and malformed-input fail-closed. No live network is touched.
