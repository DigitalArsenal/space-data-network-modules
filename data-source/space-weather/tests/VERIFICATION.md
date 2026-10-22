# Acceptance status, 2026-10-22

Local scheduled publication acceptance PASS. SDN and sdn-js were built from a
private origin/main worktree at `8ed797ecd0cd400fc31beef07dea8b808e2e5403`,
which contains typed TimerTick commit `1fd9d3203`. The earlier cron failure
used a stale canonical binary; it is resolved by the current runtime.

The declared E2E ran the same module in Chromium headless shell and native
WasmEdge 0.16.4, comparing every output byte for planning, live-source parsing,
and malformed-source rejection. Docker was waived by the owner on 2026-10-22
and was never started. SDK 0.9.9 / SDS 1.258.0; portable artifact SHA-256:
`4cbb4e749457d865d67ca28f6ff3cfcc8c0f0cba9ae827eb4d9a5b427d1f8a19`.

A new isolated native node signed and loaded the flow with AOT, fired its
hourly trigger, ingested and published 43 SPW days including 2026-10-22.
A separate SDN client used binary FlatSQL sync 2.0 to discover the publication,
then fetched its DPM and shard by CID, checked the publisher, asset hash/length,
GFZ/NOAA licence and attribution, and independently compared the driver values
and 81-day observed-flux averages to the source files for those UTC days.
Malformed GFZ produced no records. No owner node data was used.

Evidence: ignored `tests/evidence-OsBPp7/receipt.json` and source files.
Manifest: `bafkreibjov2bt6eyslsqoud6dza2cdh67qyqhvj66rhv2ovu64un3n5h3q`.
Shard: `bafkreide5dpnwpokydcxyz5fy3fomilhwcq4eekeqhoo3grb64sdxmvpqi`.
These are scratch-node CIDs, not persistent production availability.

Landing remains blocked. Typed-port coverage passed, but JSON-BOUNDARY refused
build metadata emissions: `data-source/space-weather/build.mjs` G5 count 3 and
`flows/space-weather/build.mjs` G5 count 4, each versus baseline 0. No runtime
JSON or source-licence exception was added to bypass this guard. The gauntlet
dry-run also still requests the stale sibling SDK and `wasmedge-docker`, which
the owner explicitly forbids. No full gauntlet PASS, review or landing claimed.

Host-02's public build is `1.0.6-updatelane.24c0512bc` (October 9), before
the required TimerTick fix. A separate owner fleet update must precede rollout.
No production SSH, installation or restart occurred. SDS dependency
`upstream-spacedatastandards-2` is waiting for npm visibility; DCA was not started.
