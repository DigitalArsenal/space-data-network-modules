# OneWeb (Eutelsat) LTEF Data Source (A2.2c)

The second Tier-1 `data_source` adapter on the shared provider template
(`common/provider_source.hpp`, promoted from `spacex-starlink-source` in A2.2c).
On a TIMERS-driven `pull` it fetches OneWeb's public LTEF (Long-Term Ephemeris
File) — a single whole-fleet CSV — and for each satellite emits a schema-exact
SDS **OEM** record, stores it, signs its content id, and publishes a schema-exact
**PNM** pointer.

## Pull flow (`src/oneweb_source.cpp`)

1. **Fetch** — GET `https://ephemeris.oneweb.net/ltef/ltef.csv` (one small
   ~45 KB CSV, the whole fleet; no manifest, no per-object fan-out). The raw file
   is SHA-256'd once and bound into every record's provenance.
2. **Plan (capped)** — one record per LTEF row, up to `objectCap` (default 40).
3. **Per satellite** — parse the row's honestly-decodable fields, build the OEM
   metadata shell, `storage.write` it (schema `OEM`), `keyslot.sign` its CID, and
   `pubsub.publish` a PNM on `sdn/data-source/oneweb`.

## ⚠️ Honest format finding: the LTEF is an UNDOCUMENTED compact encoding

The LTEF `ltef.csv` is **not** a Cartesian state-vector ephemeris. It is a
proprietary, compact, fixed-point integer encoding (17 columns, one row per fleet
satellite, ~578 objects) with **no public column specification** — confirmed by
web search; CelesTrak ingests `OneWeb-E` but does not publish the decode. Observed
structure (live 2026-07-13 sample; details + table in `test/fixtures/PROVENANCE.md`):

- `c0` = slot id; `c1`/`c2` = element/reference epochs in **GPS-epoch seconds**
  (1980-01-06, no leap-second offset).
- `c3,c5,c7` are **per-plane** (exactly 12 distinct values = OneWeb's 12 orbital
  planes); `c7` behaves like RAAN (2^18 = 360° scale, ~15°/plane over 180° — a
  Walker-star layout). `c8` is a **per-satellite** phase angle in `[0, 2^18)`.
  `c6` = 4096 (2^12) is a fixed-point scale constant.

**What is decoded (honestly, validated):** the epoch (GPS→UTC — `c2` reproduces
the feed's own `timestamp.txt` to the second) and the slot id.
**What is NOT decoded:** semi-major axis, eccentricity, and the physical frame —
there is no public mapping from these columns to a state vector.

Per the A2.2a ethos (**fail-closed, never fabricate**), this adapter does **not**
invent state vectors. Each record is a schema-exact OEM **metadata shell**:

- `OBJECT_NAME` = `ONEWEB-<slot>`, `OBJECT_ID` = `""`, `NORAD_CAT_ID` = `0`
  (the LTEF carries no intl designator / NORAD id).
- `CENTER_NAME` = `EARTH`, `TIME_SYSTEM` = `UTC`, `START_TIME`/`STOP_TIME` =
  the GPS→UTC epoch, `STEP_SIZE` = 0.
- `REFERENCE_FRAME` = `"UNKNOWN"` (the LTEF declares no frame; the decode is
  unresolved — so nothing downstream mistakes it for a real frame).
- `EPHEMERIS_DATA_LINES` = `[]` (empty), plus a `COMMENT` documenting the
  unresolved decode.

The raw encoded row, the GPS/UTC epochs, and `DECODE_STATUS =
"unresolved-ltef-encoding"` are preserved in signed provenance so a future
spec-based decoder can reprocess **without re-fetching**.

**Residual (OWNER-ASSIST):** obtain OneWeb's LTEF column specification (operator
outreach / Eutelsat), then add the physical element decode → real state vectors →
the A2.4 hard-RMS parity gate. Until then OneWeb's parity gate is **blocked on
the decode**, the same class of blocker as the Tier-2 data-access items in
A2.1/A2.4 (labeled here, not silently skipped).

## Frame / time decisions

| field           | value        | rationale                                         |
|-----------------|--------------|---------------------------------------------------|
| REFERENCE_FRAME | `UNKNOWN`    | LTEF declares no frame; physical decode unresolved |
| TIME_SYSTEM     | `UTC`        | epoch converted GPS→UTC (no leap offset; validated) |
| CENTER_NAME     | `EARTH`      | LEO constellation                                  |

## Fetch politeness / cadence math

- The whole fleet is **one** ~45 KB CSV → a pull is a single GET; fetch load is
  trivially bounded regardless of fleet size.
- **Cadence** — the module `timers` block runs `pull` every **6h** (4×/day). The
  LTEF regenerates ~daily (its root `timestamp.txt` tracks that), so 6h
  guarantees same-day freshness within 6h of any regeneration. `45 KB × 4/day ≈
  180 KB/day`. A 12h cadence would also meet the same-day target.
- **`objectCap`** (default **40**) bounds per-pull *record* churn (storage.write
  + pubsub), not fetch load. Fleet ~520–578; 40/pull cycles the whole fleet in
  ~15 pulls (~3.75 days at 6h). Configurable via `{"objectCap":…, "ltefUrl":…}`.

## PNM / provenance

- `FILE_ID` = `oneweb:OEM:<slot>:<epoch>` (CelesTrak `<source>:<schema>:<key>:<epoch>`
  partition convention; key = slot id since the LTEF has no NORAD).
- Published message = `{"PNM":{…}, "provenance":{…}}`; provenance mirrors the
  CelesTrak ingest object (`SOURCE_NAME`, `SOURCE_URL`, `SOURCE_SHA256`,
  `DATA_SOURCE` = `OneWeb-E`, `RECORD_SCHEMA` = `OEM`, …) plus the LTEF-specific
  honest fields (`LTEF_SLOT`, `LTEF_EPOCH_GPS`/`_UTC`, `LTEF_REF_EPOCH_*`,
  `LTEF_RAW`, `LTEF_COLUMNS`, `DECODE_STATUS`).

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
node --test test/*.test.mjs
```

`test/module.test.mjs` instantiates the rebuilt WASM with a mock
`space_data_module_host` bridge serving the trimmed real LTEF fixture, and
asserts: LTEF parse → capped OEM shells with schema-exact keys and the
GPS→UTC-validated epoch, `REFERENCE_FRAME=UNKNOWN` + empty
`EPHEMERIS_DATA_LINES` (no fabricated state), signed PNM structure, provenance
`SOURCE_SHA256` binding + raw-row preservation, default-cap, non-200 fail-closed,
and malformed-input fail-closed. No live network is touched.
