# OneWeb adapter test fixtures — provenance

These fixtures drive the offline, mock-host integration test
(`test/module.test.mjs`). No live network is touched by the test.

## `ltef.sample.csv`

The first **5 rows** of OneWeb's public LTEF (Long-Term Ephemeris File).

- **Upstream source:** `https://ephemeris.oneweb.net/ltef/ltef.csv`
  (open directory index at `ephemeris.oneweb.net`, authentication none; the site
  root also serves `timestamp.txt` = last-update epoch and `ltef_checksum/`).
- **Retrieved:** 2026-07-13. Full file: **578 rows** (one per fleet satellite),
  17 integer columns, 45315 bytes; `timestamp.txt` = `2026-07-13T12:00:00.000`.
  Live smoke: `HTTP/1.1 200`.
- **Trim:** first 5 rows, bytes verbatim (so the test can SHA-256 this fixture
  and match the adapter's `SOURCE_SHA256` provenance).

### LTEF column structure (observed — NO public spec exists)

The LTEF is a proprietary compact fixed-point encoding, **not** a Cartesian
state-vector ephemeris. From the live sample (and confirmed by web search, no
official column spec is published):

| col | meaning (observed)                                                        |
|-----|---------------------------------------------------------------------------|
| c0  | OneWeb slot/index id (unique per satellite)                               |
| c1  | element epoch — **GPS-epoch seconds** (1980-01-06, no leap offset)        |
| c2  | file reference epoch — GPS-epoch seconds (constant; == `timestamp.txt`)   |
| c3,c5,c7 | **per-plane** params (exactly 12 distinct values = 12 orbital planes) |
| c7  | behaves like RAAN (2^18 = 360°, ~15°/plane over 180° — a Walker star)     |
| c6  | `4096` (2^12) fixed-point scale constant                                   |
| c8  | **per-satellite** phase angle in `[0, 2^18)` (arg-of-lat / mean anomaly)  |
| c4,c9,c10,c11,c16 | small per-plane/per-sat integers (rates / flags)            |
| c12..c15 | reserved (all zero in the sample)                                    |

**Decoded honestly:** the epoch (c1/c2, GPS→UTC — validated: c2 → `11:59:59Z`
reproduces `timestamp.txt` `12:00:00.000`) and the slot id. **NOT decoded:**
semi-major axis, eccentricity, and the physical frame — there is no public
mapping from these columns to a Cartesian state vector. The adapter therefore
emits an honest OEM **metadata shell** (`REFERENCE_FRAME: "UNKNOWN"`, empty
`EPHEMERIS_DATA_LINES`) and preserves the raw encoded row + full-file SHA-256 in
signed provenance (`DECODE_STATUS: "unresolved-ltef-encoding"`). Obtaining
OneWeb's LTEF column spec is an OWNER-ASSIST residual (see `../../README.md`).

## `supgp-reference-draft/`

A2.4 seed: the CelesTrak SupGP (`sup-gp.php?SOURCE=OneWeb-E`) same-epoch reference
pair could NOT be captured (CelesTrak `ECONNREFUSED` from this env, matching
A2.1). A `provider.json` DRAFT + a README with the exact query are checked in
there for A2.4 to complete. NOTE: the OneWeb hard-RMS parity gate is **blocked**
on the LTEF decode (no raw state vectors to fit) until OneWeb's spec lands.
