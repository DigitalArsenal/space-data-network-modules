# ISS — A2.4 CelesTrak SupGP reference-pair (DRAFT / seed)

This directory seeds **A2.4** (OD parity gate vs CelesTrak) for the ISS. It is a
DRAFT: the CelesTrak SupGP capture is **missing** because CelesTrak was
unreachable from the build environment.

## Status: CelesTrak NOT captured (unreachable)

Direct HTTPS to `celestrak.org` fails with `ECONNREFUSED` from this environment
(same result A2.1 recorded; A2.1 succeeded only via a reader proxy). Per the
task's M2M policy ("halt on any non-200; do NOT hammer") no retries were made.
**A2.4 must capture the same-epoch SupGP pair** (via the reader proxy or a
CelesTrak-reachable host) and complete `provider.json`.

## Exact CelesTrak query for A2.4

```
https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=ISS-E&FORMAT=JSON
```

- Also grab `FORMAT=KVN` (OMM KVN) if element-space keys are easier to diff.
- Capture within the **same 2-hour SupGP update window** as the operator OEM
  epoch so the comparison is epoch-aligned. Respect the >2h update cadence
  ("no need to check more often") and the ≤50-error / IP-block rules.
- Single object (NORAD 25544) → one OMM record expected.

## Operator ephemeris reference (already in-repo)

The operator-side reference is the trimmed NASA ISS OEM at
`../ISS.OEM_J2K_EPH.sample.txt` (full upstream: NASA public S3, EME2000/UTC,
15-day span). The full 5403-vector file fits the OD gate at RMS ≈ 0.080 km
(A2.2a: `analysis/od/tests/data/supgp-reference/iss/`).

## Parity plan (A2.4)

1. **Hard RMS gate:** OrbPro fits SGP4 mean elements from the ISS OEM (EME2000→
   TEME transform owned by the OD module) → fitted RMS vs the source ephemeris
   MUST be ≤ CelesTrak SupGP RMS (extends the Starlink `beatsCelestrak` gate).
2. **Element-space parity:** epoch-aligned OMM (MEAN_MOTION, ECCENTRICITY,
   INCLINATION, RA_OF_ASC_NODE, ARG_OF_PERICENTER, MEAN_ANOMALY, BSTAR) within
   documented ISS tolerances vs CelesTrak's `ISS-E` OMM.

## provider.json (DRAFT)

`provider.json` here mirrors the A2.2a manifest shape
(`analysis/od/tests/data/supgp-reference/iss/provider.json`) but adds the
`celestrakKvn` / `celestrakCsv` slot that A2.4 fills once the SupGP pair lands.
