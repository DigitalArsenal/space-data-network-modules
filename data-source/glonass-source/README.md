# GLONASS Precise Ephemeris (IAC SP3) Data Source (A2.2c-2)

A Tier-1 `data_source` adapter on the shared provider template
(`common/provider_source.hpp`). On a TIMERS-driven `pull` it fetches a GLONASS
precise ephemeris from the Russian **Information-Analytical Center (IAC)** — an
**SP3-d** file — and for each GLONASS satellite (`Rnn`) emits a schema-exact SDS
**OEM** record with the state-vector series, stores it, signs its content id, and
publishes a schema-exact **PNM** pointer. The OEM/verbose skeleton mirrors the
ISS adapter; only the SP3 parse is GLONASS-specific.

## Pull flow (`src/glonass_source.cpp`)

1. **Fetch** — GET the IAC SP3 (default the rolling `LATEST/Final.sp3`). The raw
   file is SHA-256'd once and bound into every record's provenance.
2. **Parse SP3-d** — header (version, coordinate system, time system, orbit type,
   agency, GPS week), epoch lines, and position (`P`) records; filter to GLONASS
   (`R`) satellites.
3. **Per GLONASS satellite** — build a verbose OEM (see below), `storage.write`
   it (schema `OEM`), `keyslot.sign` its CID, and `pubsub.publish` a PNM on
   `sdn/data-source/glonass`. `objectCap` (default 40 ≥ the ~24 GLONASS slots)
   bounds per-pull record churn.

## ⚠️ Frame / time preserved AS DECLARED (a mission correction)

The A2.2c-2 packet expected IAC GLONASS ephemerides to be **"PZ-90.11 ECEF state
vectors"**. Live investigation of the actual IAC product (2026-07-13) corrects
that — the real SP3-d headers declare:

| SP3 header field                | value    | note |
|---------------------------------|----------|------|
| coordinate system (cols 47–51)  | `IGS20`  | the IGS realization of **ITRF2020** — **NOT PZ-90.11** |
| time system (`%c`, cols 10–12)  | `GPS`    | GPS system time — **NOT GLONASS time / UTC(SU)** |

PZ-90.11 / GLONASS-time is the frame of the GLONASS **broadcast navigation
message** — a *different* product. IAC, as a full multi-GNSS IGS Analysis Center
(AC code "IAC"), publishes its **precise** orbits in standard IGS conventions
(IGS20 / GPS time) for interoperability.

The adapter **preserves what the file declares** — `REFERENCE_FRAME` = the SP3
coordinate-system field (e.g. `IGS20`), `TIME_SYSTEM` = the SP3 time-system field
(e.g. `GPS`) — and does **not** relabel to PZ-90.11 and does **not** transform
frames. The OD module owns any frame transform (A2.2a). A `COMMENT` +
`FRAME_NOTE` provenance record the finding so nothing downstream mistakes the
frame.

## Representation: position-only (no fabricated velocity)

Every IAC SP3 sampled (and the CODE/GFZ MGEX products cross-checked) is
**position-only** — `P` records only, no `V`/velocity records. Per the A2.2a
ethos we do **not** fabricate velocities. The OEM is therefore **verbose**
(`STEP_SIZE = 0`, explicit `EPOCH` per line) with `STATE_VECTOR_SIZE = 3` and
`X`/`Y`/`Z` (km) only. SP3 satellite-clock values are not orbital state and are
dropped (a bad/absent clock `999999.999999` does **not** invalidate the
position; an absent position — SP3 sentinel `0.000000` on all of X/Y/Z — is
skipped). `OBJECT_ID` / `NORAD_CAT_ID` are absent (SP3 carries only the `Rnn`
GLONASS slot id; the slot→NORAD map is not fabricated).

## A2.4 implication (gate achievable, with OD-side prerequisites)

Unlike GPS (whose almanac is not a state-vector ephemeris), the IAC SP3 **is** a
real state-vector ephemeris, so the A2.4 **hard-RMS gate is achievable** — but
only after these OD-side prerequisites land (they are **not** in A2.2a yet):

1. **IGS20/ITRF2020 (ECEF) → TEME** transform. A2.2a implemented inertial
   EME2000/J2000/GCRF → TEME only; an Earth-fixed (ITRF) frame needs
   Earth-rotation + polar motion + UT1 (an ECEF↔inertial rotation) the OD module
   does not yet do (it fail-closes on non-inertial frames).
2. **GPS → UTC** (leap seconds). A2.2a is UTC-only; the SP3 declares `GPS` time.
3. **Position-only fit** — confirm the OD SGP4 fit accepts a position-only state
   series.
4. **Slot → NORAD** cross-reference for element-space parity vs CelesTrak.

Full detail + the exact `GLONASS-RE` CelesTrak query are in
`test/fixtures/supgp-reference-draft/`. CelesTrak was unreachable from this env
(connection timed out) so the reference pair is a DRAFT (mirrors A2.2c-1).

## Fetch politeness / cadence / transport

- One SP3 file per pull (single GET). The module `timers` block runs `pull` every
  **12h**; IAC regenerates its precise products ~daily (rapid) with a rolling
  ultra-rapid, so 12h captures the refresh promptly.
- `objectCap` (default **40**) bounds per-pull *record* churn (one record per
  GLONASS satellite), not fetch load. Configurable via `{"objectCap":…,
  "sourceUrl":…}`.
- **Transport residual (OWNER-ASSIST):** at capture time the IAC **HTTPS**
  frontend (`glonass-iac.ru`) returned `502 Bad Gateway`; the live products are on
  the IAC **anonymous FTP** (`ftp.glonass-iac.ru`, reachable). The default
  `sourceUrl` therefore points at `ftp://.../LATEST/Final.sp3`. Whether the host
  `http` capability can fetch `ftp://` is a host concern — if not, the fetch
  needs an FTP-capable host fetch or an HTTPS mirror (`sourceUrl` override).

## PNM / provenance

- `FILE_ID` = `glonass:OEM:<Rnn>:<start-epoch>` (CelesTrak
  `<source>:<schema>:<key>:<epoch>` convention; key = SP3 slot id).
- `FILE_NAME` = the SP3 file basename (e.g. `Final.sp3`).
- Provenance carries `SOURCE_NAME`, `SOURCE_URL`, `SOURCE_SHA256`, `DATA_SOURCE =
  GLONASS-RE`, `RECORD_SCHEMA = OEM`, plus the SP3 facts (`SP3_SAT_ID`,
  `SP3_VERSION`, `COORDINATE_SYSTEM`, `TIME_SYSTEM`, `FRAME_NOTE`,
  `STATE_REPRESENTATION`, `ORBIT_TYPE`, `AGENCY`, `GPS_WEEK`, `STATE_COUNT`,
  `START_TIME`/`STOP_TIME`).

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
node --test test/*.test.mjs
```

`test/module.test.mjs` instantiates the rebuilt WASM with a mock
`space_data_module_host` bridge serving a **synthetic** GLONASS-style SP3-d (SGP4 truth; no IAC data)
fixture, and asserts: SP3 parse → 25 GLONASS OEM records with schema-exact keys,
`REFERENCE_FRAME = IGS20` (NOT PZ-90.11) + `TIME_SYSTEM = GPS` preserved as
declared, verbose position-only (`STATE_VECTOR_SIZE = 3`, `X`/`Y`/`Z`, no
fabricated velocity), the R01 bad-clock edge case (position kept), signed PNM
structure, provenance `SOURCE_SHA256` binding + `FRAME_NOTE`, `objectCap`,
`sourceUrl` override, non-200 fail-closed, and malformed-input fail-closed. No
live network is touched.
