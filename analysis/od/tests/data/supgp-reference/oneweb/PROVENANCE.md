# OneWeb-E SupGP capture — provenance (A2.4, record-only)

## `celestrak_supgp_oneweb-e_2026-07-13.csv`

- **Exact URL:** `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=OneWeb-E&FORMAT=CSV`
- **Captured:** 2026-07-13 (UTC), HTTP 200, 103223 bytes, 651 OMM rows (OneWeb
  LEO constellation, ~i 87.9°, ~n 13.16 rev/day), each with a real NORAD_CAT_ID.
- **How:** read-only host proxy `ssh space-data-network-02 'curl ...'` (celestrak
  unreachable from build host); serial, ≥3 s spacing; host temp dir cleaned up.
  Byte-exact as served.

## LTEF decode — REVERSE-ENGINEERED + VALIDATED 2026-07-14 (no official spec)

Owner escalation authorized reverse-engineering the LTEF encoding with mandatory
empirical validation. **No official LTEF column spec is published anywhere**
(confirmed: `ephemeris.oneweb.net` serves only `ltef/`, `ltef_checksum/`,
`timestamp.txt`; the GPS-time fact for the epoch columns is corroborated by a
public blog comment thread, nickvsnetworking.com / clarkzjw). The decode below is
**reverse-engineered, cited as such — never claimed as an official spec.**

Fresh full file used: `https://ephemeris.oneweb.net/ltef/ltef.csv`, 2026-07-14
17:05Z, 44146 bytes, **563 rows = one mean-element row per satellite** (an
almanac for antenna pointing, NOT a state-vector ephemeris).

Validated columns (0-indexed):

- **c0** = OneWeb slot id; **c0 == CelesTrak `ONEWEB-{c0:04d}`** (563/563 rows).
- **c1** = element epoch, **c2** = file reference epoch — GPS-epoch seconds
  (1980-01-06, no leap offset; c2 → `timestamp.txt` confirms).
- **c7** = **ascending-node longitude in an Earth-fixed frame at the file
  reference epoch**, scale `2^18 == 360°`. Inertial RAAN =
  `c7·(360/2^18) + GMST(c2)`.
- **c8** = along-track phase (arg-of-latitude), scale `2^18 == 360°` — structural
  fit only; NOT independently validated (multi-rev epoch propagation too
  sensitive with SGP4 mean elements as the only oracle).

**Validation oracle = CelesTrak OneWeb-E SupGP (fitted from the same LTEF).**
Decoded RAAN vs OneWeb-E across all **563/563** rows: median |Δ| = 0.022°, p99 =
0.078°, **max = 0.087°** (100% within 0.1°). The globally-fit offset (112.46°)
equals GMST at the file reference epoch (112.37°) — i.e. the offset is *derived
physics*, not a fudge factor. The millidegree hypothesis was tested and
**rejected** (per-plane offsets inconsistent: 150° / 142° / 183°).

### Still no independent OD — LTEF is an ALMANAC (A2.2c-2)

There is exactly ONE element set per satellite; `a`/`e`/`i` are OneWeb
constellation nominals (not encoded), and there is **no state-vector series**. So
per A2.2c-2 an independent SDN OD is impossible (same class as the GPS almanac) —
fabricating a fittable ephemeris from assumed `a/e/i` is forbidden. The
publishable OneWeb data lane is therefore the **NON-INDEPENDENT OneWeb-E
republish** (constellation-pipeline `celestrak-supgp` token `OneWeb-E`, key
`oneweb-supgp`, 651 objects). This decode's contribution: it independently
**validates** that republish's LTEF→OneWeb-E provenance chain and **resolves
per-object identity** (slot → NORAD via the 563/563 name match). **OWNER-GATED
RESIDUAL:** an official LTEF spec would still be needed to decode `a/e/i`
independently and lift the almanac ceiling.
