# GPS — A2.4 CelesTrak SupGP reference-pair (DRAFT / seed)

This directory seeds **A2.4** (OD parity gate vs CelesTrak) for GPS. It is a
DRAFT: the CelesTrak SupGP capture is **missing** because CelesTrak was
unreachable from the build environment, AND — unlike Starlink/ISS — the GPS
hard-RMS gate is **blocked at the source level** (documented below).

## Status: CelesTrak NOT captured (unreachable)

A single polite GET to
`sup-gp.php?SOURCE=GPS-A&FORMAT=JSON` **timed out** (`curl (28) Connection timed
out`, HTTP 000) from this environment — the same unreachability A2.1 recorded
(ECONNREFUSED; A2.1 succeeded only via a reader proxy). Per the M2M policy
("halt on any non-200; do NOT hammer") the query was attempted **once** and not
retried.

## Exact CelesTrak query for A2.4

```
https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=GPS-A&FORMAT=JSON
```

- Also grab `FORMAT=KVN` (OMM KVN) for element-space keys.
- Respect the >2h SupGP update cadence and the ≤50-error / IP-block rules.

## ⚠️ Why the GPS hard-RMS gate is BLOCKED (not just "uncaptured")

The A2.4 hard gate fits SGP4 mean elements to a **source state-vector
ephemeris** and requires our fitted RMS ≤ CelesTrak's SupGP RMS. **A GPS almanac
is not a state-vector ephemeris** — it is a set of GPS-LNAV **mean Keplerian
elements**. A2.2c-2 forbids fabricating a state-vector ephemeris by propagating
the almanac (that would invent data). So there is nothing to fit, and the hard
RMS gate cannot run from the almanac.

An **element-space** comparison vs CelesTrak's `GPS-A` OMM is possible but is
**NOT independent parity**, because it requires:

1. **Frame reconciliation.** Our OMM honestly carries `REFERENCE_FRAME =
   "GPS-BROADCAST"`: `RA_OF_ASC_NODE` is the ascending-node longitude referenced
   to Greenwich at the start of the GPS week (ECEF-referenced), and `MEAN_MOTION`
   comes from the GPS two-body Kepler model. CelesTrak's `GPS-A` OMM is an
   **SGP4** fit with an inertial (TEME) RAAN. These are different theories +
   frames; a naive element diff would be apples-to-oranges.
2. **PRN → NORAD cross-reference.** The almanac carries only PRN (and, in SEM,
   SVN). CelesTrak's OMM is keyed by `NORAD_CAT_ID` / `OBJECT_ID`. The PRN→NORAD
   assignment is time-varying and NOT in the almanac; the adapter does **not**
   fabricate it. A2.4 must supply an authoritative cross-reference (e.g. from
   CelesTrak's `gp.php` GPS group or a maintained SVN/PRN/NORAD table).

## Unblock path (A2.4 / OWNER-ASSIST)

To get a real **independent** GPS parity gate, obtain a GPS **state-vector
ephemeris** source (IGS / precise SP3 products, or broadcast-nav → ECEF via a
proper GNSS propagator — an owner decision), feed it to the OD module (which owns
the frame transform), and compare the fitted SGP4 RMS to CelesTrak's GPS-A SupGP
RMS. This mirrors A2.4's "blocked on data access, NOT descoped to soft gates"
language: the interim element check may run but MUST be labeled non-independent
and never reported as parity.

## provider.json (DRAFT)

`provider.json` here records the `blocked-hard-rms` gate + the exact reasons and
TODOs (SupGP capture, PRN→NORAD cross-reference) for A2.4 to complete.
