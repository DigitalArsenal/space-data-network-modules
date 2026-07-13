# OneWeb-E SupGP capture — provenance (A2.4, record-only)

## `celestrak_supgp_oneweb-e_2026-07-13.csv`

- **Exact URL:** `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=OneWeb-E&FORMAT=CSV`
- **Captured:** 2026-07-13 (UTC), HTTP 200, 103223 bytes, 651 OMM rows (OneWeb
  LEO constellation, ~i 87.9°, ~n 13.16 rev/day), each with a real NORAD_CAT_ID.
- **How:** read-only host proxy `ssh space-data-network-02 'curl ...'` (celestrak
  unreachable from build host); serial, ≥3 s spacing; host temp dir cleaned up.
  Byte-exact as served.

## No running gate — BLOCKED on the LTEF decode

OneWeb's operator feed is LTEF, a proprietary 17-column fixed-point encoding with
no public column spec (A2.2c-1 finding); SMA/eccentricity/frame are not
decodable, so no raw state vectors can be fit for a hard RMS gate. Any
element-space check vs this SupGP would be non-independent anyway (CelesTrak's
OneWeb-E SupGP derives from the same LTEF). **OWNER-ASSIST:** obtain OneWeb's LTEF
spec. This capture is checked in as a reference pair for when the decode lands.
