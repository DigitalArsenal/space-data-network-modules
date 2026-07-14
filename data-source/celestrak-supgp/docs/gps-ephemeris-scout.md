# GPS-E (GPS Ephemeris) scout — DESIGN NOTE for a follow-up gps-ephemeris OD lane

**Status:** scouted 2026-07-13 (A2.9). Implementation is a **follow-up task, not
A2.9's.** This note records exactly what was found so the follow-up starts from
evidence, not a rumor.

## Why GPS-E matters

The existing `gps-source` adapter (A2.2c-2) ingests the USCG NAVCEN **almanac** —
reduced-precision mean Keplerian *elements*, NOT a state-vector ephemeris. So the
A2.4 hard-RMS parity gate for GPS is **blocked at source**: there is nothing to
fit. CelesTrak's queries page newly documents `GPS-E (GPS Ephemeris)` as a
**state-vector** product — if real, that is the missing input for a genuine GPS OD
lane (fit SGP4 to a GPS state ephemeris, gate RMS vs CelesTrak, like Starlink/ISS).

## What the scout found (2 proxy requests, within budget)

| # | URL | HTTP | Body |
|---|-----|------|------|
| 9 | `sup-gp.php?SOURCE=GPS-E&FORMAT=JSON` | **404** | `No SupGP data found` (19 bytes) |
| 10 | `sup-gp.php?SOURCE=GPS-E&FORMAT=CSV` | **404** | `No SupGP data found` (19 bytes) |

Both formats were probed specifically because the A2.4 `GPS-A&FORMAT=JSON` 404 was
a *format-only* quirk (CSV worked). Here **both** return the same **data-presence**
404 body (`No SupGP data found`, not a format error), so this is not a format
quirk: `GPS-E` is simply **not populated as a `sup-gp.php` SOURCE.**

## Design conclusion

`sup-gp.php` emits **OMM mean elements only** (TLE/3LE/2LE/XML/KVN/JSON/CSV — all
GP shapes). A genuine **state-vector** GPS ephemeris is not an OMM, so it would
**never** be served by `sup-gp.php`. Two possibilities, both consistent with the
evidence:

1. GPS-E is documented but not yet published (no data behind the token), OR
2. GPS-E is/will be served as an **OEM-class** (state-vector) product at a
   **different CelesTrak path** — not the supplemental-OMM endpoint.

Either way, **this adapter (a SupGP/OMM ingester) is the wrong home for GPS-E.**
No fixture or state-vector format could be captured because none exists at the
OMM endpoint.

## Follow-up task (gps-ephemeris OD lane)

1. **Scout the real endpoint.** GPS-E, if it is state vectors, will be an OEM/SP3
   product. Candidate CelesTrak locations to probe (read-only, budgeted): the
   `NORAD/elements/supplemental/` directory listing for a `.oem`/`.sp3`/state
   artifact; the ephemeris/`gp`-style routes; or a direct link from
   `sup-gp-queries.php` next to the `GPS-E` label. Confirm the actual media type
   and CCSDS frame/time declaration.
2. **If it is CCSDS OEM state vectors:** it feeds the **existing** OD lane
   unchanged — `data-source/*` OEM adapter (A2.2a OEM parser handles ECI frames;
   A2.4-prereq added ECEF↔TEME + GPS→UTC time handling that GPS state vectors
   need) → `analysis/od/fit-pipeline` → A2.4 hard-RMS gate vs CelesTrak `GPS-A`
   SupGP. This is the path to flipping GPS from `blocked` to a real gate.
3. **PRN→NORAD registry** is still required (owner-assist, per A2.2c-2 / A2.4-prereq
   `idRegistry` seam) to attach NORAD ids — GPS state vectors won't carry them any
   more than the almanac does.
4. **Do NOT synthesize state vectors** from the almanac to fake this (the A2.2a
   ethos) — wait for the real GPS-E product.

Until the endpoint is found and confirmed, GPS stays `blocked` at the hard-gate
level (element-only interim checks must stay labeled non-independent). Nothing in
A2.9 changes that; A2.9 only proved GPS-E is absent from the SupGP/OMM surface.
