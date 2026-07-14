# LIVE capture 2026-07-14 (A2 live parity demonstration)

- NASA public ISS OEM: `https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt`
  fetched 2026-07-14T14:05Z; CREATION_DATE 2026-07-13T16:28:15 (NASA's current
  product; identical source CelesTrak's ISS-E segments fit). Trimmed to the
  first 12h of states (same window shape as the checked-in `iss/` pair).
- CelesTrak SupGP: `sup-gp.php?SOURCE=ISS-E&FORMAT=CSV`, single query
  2026-07-14T14:04Z via the same policy-compliant host-02 relay, ledger-recorded.
- Result at capture: same-ephemeris beat ours 0.071 km <= CelesTrak's own
  Segment-01 elements 0.111 km scored on the identical OEM states (Δepoch 0s);
  CelesTrak's in-sample 0.067 remains non-comparable (A2.4c root cause).
