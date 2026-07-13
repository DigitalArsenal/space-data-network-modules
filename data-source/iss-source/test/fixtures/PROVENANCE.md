# ISS adapter test fixtures — provenance

These fixtures drive the offline, mock-host integration test
(`test/module.test.mjs`). No live network is touched by the test.

## `ISS.OEM_J2K_EPH.sample.txt`

A **trimmed** copy of the NASA public ISS ephemeris (CCSDS OEM KVN).

- **Upstream source:** `https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt`
  (NASA/JSC/FOD/TOPO, public S3, authentication none, `binary/octet-stream`).
- **Retrieved:** 2026-07-13 (full file: 5447 lines, 5403 state vectors, single
  META block, no covariance blocks; span 2026-07-13T12:00Z → 2026-07-28T12:00Z,
  15 days). Live smoke: `HTTP/1.1 200`, `Content-Length: 718548`.
- **Trim:** header (`CCSDS_OEM_VERS`/`CREATION_DATE`/`ORIGINATOR`) + the META
  block **verbatim**, then the first **15 state vectors** (4-min / 240 s steps).
  The upstream event/trajectory-summary COMMENT block is dropped; a short
  provenance COMMENT block is added.
- **Frame / time (as declared, preserved honestly):** `REF_FRAME = EME2000`,
  `TIME_SYSTEM = UTC`, `CENTER_NAME = Earth`, units km / km·s⁻¹. The adapter
  emits `REFERENCE_FRAME: "EME2000"` and does **not** transform to TEME — the OD
  side owns the EME2000→TEME transform (validated in A2.2a). `CENTER_NAME` is
  normalized to the SDS uppercase convention `"EARTH"`.
- **Representation:** the upstream OEM carries an explicit epoch on every state
  line and is **non-uniform** in the full file (mostly 240 s, but 58/79/180/223 s
  steps occur near ascending-node boundaries / reboosts). The adapter therefore
  emits the **verbose** SDS OEM format (`STEP_SIZE = 0` + `EPHEMERIS_DATA_LINES`
  with an explicit `EPOCH` per state), not Starlink's compact row-major array.

Because `SOURCE_SHA256` provenance is bound to the raw bytes the adapter fetched,
the test independently SHA-256s **this trimmed fixture** and asserts equality
with the adapter's `SOURCE_SHA256` (the mock host serves these exact bytes).

## `supgp-reference-draft/`

A2.4 seed: the CelesTrak SupGP (`sup-gp.php?SOURCE=ISS-E`) same-epoch reference
pair could NOT be captured from this environment (CelesTrak is unreachable —
`ECONNREFUSED`, matching A2.1). A `provider.json` DRAFT + a README documenting
the exact query and the OEM element-space parity plan are checked in there for
A2.4 to complete once CelesTrak is reachable (via the reader proxy A2.1 used).
