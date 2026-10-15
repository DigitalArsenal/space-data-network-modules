# Legacy records

What the legacy Supplemental OMM flow (release 1.0.1: its own provider nodes, FSB transport, its OD node 1.0.1
parsing the providers' formats itself, FlatSQL and pubsub publication nodes) made of the same input, captured
2026-10-14 before the flow was converted, to show the converted flow fits the same thing.

- `omm-records.bin`, `ocm-records.bin`, `obd-records.bin`: every record the release-signed bundle
  (`dist/isomorphic/module.wasm` sha256 e688e98afee543a9a896aa1ef73e691b7ff12b97caa28bbd1e773495b297e09c at
  ac9d67f3) published, in publication order, size-prefixed and back to back, for the provider fixtures of
  `tests/lib/flow.mjs` (`fixtureResponses`: the source modules' fixtures at the providers' URLs), run as its own
  known-answer test ran it (isomorphic flow host, two ticks; the second published nothing new).
- `iss-12h-*-records.bin`, `iss-3day-*-records.bin`: the legacy OD node 1.0.1 (the release's child) on
  `files/ccsds-messages/fixtures/real/nasa-iss.oem` and `../iss-sgp4xp-3day.oem` as complete ISS OEM responses. That
  release predates the node's SGP4-XP sets, so these hold the OD core's records only.
