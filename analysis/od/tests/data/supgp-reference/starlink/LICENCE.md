# Licence of the MEME files in this directory

SpaceX public ephemerides, open (owner determination 2026-10-10).

Source: SpaceX Starlink public ephemerides, https://api.starlink.com/public-files/ephemerides/ .
Attribution: SpaceX. The files in `meme/` are SpaceX's, captured 2026-05-14 (launch group 2026-034).

The CelesTrak SupGP rows that were paired with these files (`celestrak_supgp_2026-034.csv`) are
not in this tree: CelesTrak publishes no licence for SupGP. The reference gate that uses them
runs from `$SDN_MODULES_PRIVATE_FIXTURES` (see `tests/lib/privateFixtures.mjs`). The synthetic
suite `../starlink-synthetic` carries the same checks with invented data.
