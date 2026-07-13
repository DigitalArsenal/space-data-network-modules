# CPF — A2.4 CelesTrak SupGP reference-pair (DRAFT / seed)

This directory seeds **A2.4** (OD parity gate vs CelesTrak) for the ILRS CPF
source. It is a DRAFT: the CelesTrak SupGP capture is **missing** because
CelesTrak was unreachable from the build environment.

## Status: CelesTrak NOT captured (unreachable)

Direct HTTPS to `celestrak.org` **timed out** from this environment (attempted
ONCE per the M2M politeness policy — "halt on any non-200; do NOT hammer"; same
result A2.1 recorded and the ISS/OneWeb adapters hit). **A2.4 must capture the
same-epoch SupGP pair** (via the reader proxy A2.1 used, or a CelesTrak-reachable
host) and complete `provider.json`.

## Exact CelesTrak query for A2.4

```
https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=CPF&FORMAT=JSON
```

- Also grab `FORMAT=KVN` (OMM KVN) if element-space keys are easier to diff.
- Capture within the same 2-hour SupGP update window as the CPF prediction epoch
  so the comparison is epoch-aligned. Respect the >2h update cadence and the
  ≤50-error / IP-block rules.

## CAVEAT (A2.1) — two prediction products, not raw-vs-fit

Unlike Starlink/ISS (operator ephemeris vs SupGP fit), BOTH sides here are
**predictions**: our OEM derives from an ILRS CPF *prediction*, and CelesTrak's
`CPF` SupGP is itself derived from ILRS CPF predictions. So this parity is
**prediction-vs-prediction**, not an independent raw-vs-fit gate. Label it as
such in A2.4 and do not report it as independent parity.

## Operator/prediction reference (already in-repo)

The prediction-side reference is the trimmed real LAGEOS-1 CPF at
`../lageos1_cpf_260713_19402.sample.dgf` (full upstream: EDC/DGFI-TUM anonymous
HTTPS, ITRF/UTC, position-only metres, 60 s step, 7-day span). NORAD 8820,
COSPAR 1976-039A.

## Parity plan (A2.4) — with an OD prerequisite

1. **Frame prerequisite (OD-side, blocking).** CPF is **ITRF/ECEF**; A2.2a's OEM
   input parser fail-closes on ITRF (it handles TEME native + EME2000/J2000/GCRF
   → TEME, but NOT the Earth-rotation ITRF→TEME transform). A2.4/OD must add the
   ITRF→TEME transform (GMST/GAST + polar motion) before the CPF OEM can be fit.
   Until then the hard RMS gate is blocked on the OD frame support, not on data.
2. **Position-only note.** CPF (and thus our OEM) carries NO velocity. The OD fit
   must accept position-only ephemeris (fit SGP4 mean elements from positions).
3. **Hard RMS gate:** OrbPro fitted RMS vs the CPF positions MUST be ≤ CelesTrak
   CPF SupGP RMS (extends the Starlink `beatsCelestrak` gate) — but see the
   prediction-vs-prediction caveat above.
4. **Element-space parity:** epoch-aligned OMM vs CelesTrak's `CPF` OMM within
   documented tolerances.

## provider.json (DRAFT)

`provider.json` here mirrors the A2.2a manifest shape but adds the `celestrakKvn`
slot that A2.4 fills once the SupGP pair lands, plus `referenceFrame`/`frameNote`
recording the ITRF→TEME OD prerequisite.
