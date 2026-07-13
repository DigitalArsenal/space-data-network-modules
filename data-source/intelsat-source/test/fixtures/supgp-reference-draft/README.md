# Intelsat — A2.4 CelesTrak SupGP reference-pair (DRAFT / seed)

This directory seeds **A2.4** (OD parity gate vs CelesTrak) for the Intelsat
source. It is a DRAFT: the CelesTrak SupGP capture is **missing** because
CelesTrak was unreachable from the build environment.

## Status: CelesTrak NOT captured (unreachable)

Direct HTTPS to `celestrak.org` **timed out** from this environment (attempted
ONCE per the M2M politeness policy; same result A2.1 recorded). NOTE: Intelsat
itself IS reachable from this env (`my.intelsat.com` → HTTP 200) — only CelesTrak
is blocked. **A2.4 must capture the same-epoch SupGP pair** (via the reader proxy
A2.1 used, or a CelesTrak-reachable host) and complete `provider.json`.

## Exact CelesTrak query for A2.4

```
https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=Intelsat-11P&FORMAT=JSON
```

- Also grab `FORMAT=KVN` (OMM KVN) if element-space keys are easier to diff.
- Capture within the same window as the operator ECF epoch (epoch-aligned).

## Name → NORAD prerequisite (blocking the keyed comparison)

The Intelsat public **ECF ephemeris carries NO NORAD Catalog Number and NO
international designator** — only the operator short name (`IS-21`). The adapter
honestly emits `NORAD_CAT_ID: 0` / `OBJECT_ID: ""` (never fabricated). To key the
CelesTrak comparison, A2.4 must supply the external mapping from a name → NORAD
registry (IS-21's public catalog entry is NORAD 38098 / COSPAR 2012-043A) —
this belongs in the adapter registry / A2.4, NOT inlined into the parser.

## GEO caveat

IS-21 is geostationary (near-zero inclination and eccentricity), so classical
element-space tolerances (especially RAAN and argument-of-perigee) are
ill-conditioned. A2.4 should compare in equinoctial elements or position space.
Also: CelesTrak's `Intelsat-11P` SupGP is fit from the SAME public Intelsat feed,
so element-space agreement is not a fully independent check.

## Operator ephemeris reference (already in-repo)

The operator-side reference is the trimmed real IS-21 ECF at
`../i_aor_e_302.00_is-21_20260710_235300.sample.txt` (full upstream: MyIntelsat
public, ECEF/UTC, position-only metres, 30-min step, ~9-day span).

## Parity plan (A2.4) — with an OD prerequisite

1. **Frame prerequisite (OD-side, blocking).** ECF is **ECEF**; A2.2a's OEM input
   parser fail-closes on ECEF/ITRF (it handles TEME native + EME2000/J2000/GCRF →
   TEME, but NOT the Earth-rotation ECEF→TEME transform). A2.4/OD must add it.
2. **Position-only note.** ECF (and thus our OEM) carries NO velocity — the OD fit
   must accept position-only ephemeris.
3. **Hard RMS gate:** OrbPro fitted RMS vs the ECF positions MUST be ≤ CelesTrak
   Intelsat-11P SupGP RMS (extends the Starlink `beatsCelestrak` gate).
4. **Element-space parity:** epoch-aligned, GEO-aware (equinoctial), vs
   CelesTrak's `Intelsat-11P` OMM.

## provider.json (DRAFT)

`provider.json` here mirrors the A2.2a manifest shape but adds the `celestrakKvn`
slot A2.4 fills, plus `referenceFrame`/`frameNote` and the external NORAD-mapping
note.
