# Notable deep-space spacecraft (Horizons)

Retrieves 13 spacecraft, including Tesla Roadster and the Voyager and Pioneer
probes, from NASA/JPL Horizons VECTORS. C++/WASM parses, plans and evaluates
Sun-centred ICRF trajectories in TDB, emitting one size-prefixed SDS `$OEM` per
craft. The host HTTP connector performs requests; the module has no flow or
network imports. Lane: `OEM.fbs`, provider `deep-space-spacecraft`, source `horizons`.

Licence: NASA/JPL Horizons On-Line Ephemeris System (Solar System Dynamics Group):
U.S. Government work, public domain. Credit: Ephemeris: NASA/JPL-Caltech Horizons.
Every block carries the aliases, licence, credit and segment labels in COMMENT;
the ingest metadata also carries the licence and credit.

The plan contract:

1. Configuration defaults to all 13 craft in catalogue order and anonymous access.
2. `objects` selects catalogue NAIF ids; unknown ids are refused.
3. `limits[id].start/stop` optionally clamps coverage using whole-second TDB ISO text.
4. `page_rows` defaults to 80,000 and must be between 1 and 89,000.
5. `plan_horizons` probes 1900 and 2300 for each craft's coverage bounds.
6. The daily grid starts at `floor(lo) + 2` and ends no later than `floor(hi) - 1`.
7. Limits clamp that span before selecting its last daily grid point.
8. The first intersecting terminal event truncates the span at the next daily grid point.
9. Departure covers the first two days, clipped to the selected span.
10. Event windows snap outward to the daily grid; touching windows merge.
11. Each craft requests daily pages first, then 10-minute window pages in time order.
12. Three `advance` calls each absorb responses and emit at most 60 requests.
13. Absorption drops interior daily window rows; `build_oem` combines retained daily edges and dense windows.
14. Blocks share edges, declare Hermite degree 7, and drop daily segments shorter than two rows.
15. Output is deterministic; only an optional `receipt.retrieved_at_ms` supplies CREATION_DATE.

Probe status counts departure plus listed events; later status reports the merged windows.

`evaluate_oem` evaluates declared block interpolation through the shared C++
ephemeris evaluator, preferring the smaller step at a shared edge and refusing
out-of-span epochs. `reconcile_id` maps Artemis II's kernel id `-24` to Horizons
`-1024`; an unqualified `-24` remains Pioneer 11.

Run the single offline E2E from the repository root (dependencies are preinstalled):

```sh
cd data-source/deep-space-spacecraft
node build.mjs && node --test tests/notable-trajectories.e2e.test.mjs
```

It replays 29 recorded Horizons requests and compares WASM interpolation with
independent TLIST reference states in km and km/s, ICRF, Sun-centred, JD TDB.
The position tolerance is 1 km, allowing source rounding and interpolation
error; the recorded reference comparison is expected to be at metre scale.
It also verifies the SDK artifact contract, OEM metadata, byte determinism and
named failures. `HORIZONS_RECORD=1 node --test tests/notable-trajectories.e2e.test.mjs`
refreshes the cassette and independent TLIST reference using serialized live
requests with a 700 ms pause and up to three retries; it requires network access.
