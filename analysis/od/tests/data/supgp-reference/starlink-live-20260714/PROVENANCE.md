# LIVE capture 2026-07-14 (A2 live parity demonstration)

- MEME ephemerides: `https://api.starlink.com/public-files/ephemerides/` (public
  SpaceX service), MANIFEST.txt + 10 files (NORAD 67850-67859, launch group
  2026-034, same birds as the checked-in `starlink/` pair), fetched
  2026-07-14T14:02Z, ephemeris created 2026-07-14 ~10:05 UTC.
- CelesTrak SupGP: `sup-gp.php?SOURCE=SpaceX-E&FORMAT=CSV`, single query
  2026-07-14T14:04Z via read-only curl relay on space-data-network-02
  (celestrak.org unreachable from the capture workstation — firewall recovery
  path, NOT rate-limit evasion), recorded in the fetch-policy ledger
  (CELESTRAK_FETCH_POLICY: >=2.5s serial, 3h same-URL rule respected — prior
  fetch of this URL was 2026-07-13). Filtered to the 10 NORADs
  (`celestrak_supgp_live.csv`); row epochs 2026-07-14T10:31-11:52Z, i.e. the
  SupGP fits CelesTrak published for the SAME same-day ephemerides.
- Result at capture (scripts/live-parity-report.mjs): our fit beat CelesTrak's
  published SupGP RMS 10/10 (ours 0.072-0.116 km vs theirs 0.175-0.223 km).
