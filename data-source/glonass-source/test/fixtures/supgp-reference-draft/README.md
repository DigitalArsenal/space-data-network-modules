# GLONASS — A2.4 CelesTrak SupGP reference-pair (DRAFT / seed)

This directory seeds **A2.4** (OD parity gate vs CelesTrak) for GLONASS. It is a
DRAFT: the CelesTrak SupGP capture is **missing** (CelesTrak unreachable), and —
unlike GPS — the hard-RMS gate IS achievable here (the IAC SP3 is a real
state-vector ephemeris product) but has concrete **OD-side prerequisites** documented
below.

## Status: CelesTrak NOT captured (unreachable)

A single polite GET to `sup-gp.php?SOURCE=GLONASS-RE&FORMAT=JSON` **timed out**
(`curl (28) Connection timed out`, HTTP 000) from this environment — the same
unreachability A2.1 recorded (ECONNREFUSED; A2.1 succeeded only via a reader
proxy). Attempted **once**, not retried (M2M policy).

## Exact CelesTrak query for A2.4

```
https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=GLONASS-RE&FORMAT=JSON
```

- Also grab `FORMAT=KVN` (OMM KVN) for element-space keys.
- Capture within the same 2-hour SupGP window as the IAC SP3 epoch.

## Operator ephemeris reference (in-repo)

`../synthetic_glonass.sp3.glo` — a synthetic GLONASS-style SP3-d (SGP4 truth,
IGS20 label / GPS time, position-only, 900 s). The real IAC product it stands in
for (`ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/26192/rapid/Sta24266.sp3.glo`) states
no reuse terms and is not in this tree. See `../PROVENANCE.md`.

## ⚠️ Mission-assumption correction (IGS20/GPS, not PZ-90.11)

The packet expected PZ-90.11 ECEF. The **real** IAC precise SP3 header declares
`IGS20` (an ITRF2020 realization) and `GPS` time. PZ-90.11/GLONASS-time is the
GLONASS **broadcast-nav** frame — a different product. The adapter preserves
`REFERENCE_FRAME = IGS20` / `TIME_SYSTEM = GPS` **as declared**.

## Parity plan (A2.4) + prerequisites

The hard RMS gate (OrbPro fits SGP4 mean elements from the IAC SP3 → fitted RMS
MUST be ≤ CelesTrak GLONASS-RE SupGP RMS) is achievable **once these OD-side
prerequisites land** (they are NOT in A2.2a yet):

1. **Frame: IGS20/ITRF2020 (ECEF) → TEME.** A2.2a implemented EME2000/J2000/GCRF
   → TEME (inertial precession + nutation) only. IAC SP3 is an **Earth-fixed**
   (ITRF) frame; its transform to TEME needs Earth-rotation angle + polar motion
   + UT1 (an ECEF↔inertial rotation), which the OD module does **not** yet do —
   it currently fail-closes on non-inertial frames. **Add ITRF→TEME to the OD
   module for GLONASS.**
2. **Time: GPS → UTC.** A2.2a is UTC-only (fail-closed otherwise). IAC SP3
   declares `TIME_SYSTEM = GPS`; a GPS→UTC (leap-second) step is required before
   the fit.
3. **Position-only fit.** The SP3 is position-only (`STATE_VECTOR_SIZE = 3`);
   confirm the OD SGP4 fit accepts a position-only state series.
4. **Slot → NORAD cross-reference.** SP3 carries only the `Rnn` slot id;
   CelesTrak keys by `NORAD_CAT_ID` / `OBJECT_ID`. A2.4 must supply an
   authoritative GLONASS slot→NORAD mapping (the adapter does not fabricate it).

Then: (a) hard RMS gate as above; (b) element-space OMM parity within documented
tolerances vs CelesTrak's `GLONASS-RE` OMM (epoch-aligned).

## provider.json (DRAFT)

`provider.json` records `gate: beatsCelestrak` plus the `gatePrerequisites`
(frame/time/position-only) and TODOs (SupGP capture, slot→NORAD) for A2.4.
