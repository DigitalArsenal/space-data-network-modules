# Acceptance: 2026-11-03, module/flow 0.2.0

SDS dependency: **1.274.0**, pinned only in this module's package and lockfile.
The native test binary was built from SDN `50eea40d5` using its WasmEdge wrapper,
with output in this lane's ignored `tests/bin/`. No shared package, schema or
source file outside the two lane folders was edited.

The module and production flow were built with explicit `--unsigned`.
`node data-source/swpc-realtime/tests/swpc-realtime.e2e.mjs` exited **0**.
Flares are mandatory in both standalone-record and signed-lane CID readback.
The capture contains four flares and all twelve source fields (48 checks),
including two null ratios that remain NaN and two non-null ratios/times.

```text
PASS SWS native-node CID readback {"records":360,"sourceRows":109,"values":848,"flags":5368}
PASS SWA native-node CID readback {"records":50,"sourceRows":50,"fields":150}
PASS SFE native-node CID readback {"records":4,"sourceRows":4,"fields":48,"nullRatios":2}
PASS scheduled native flow -> signed SWS/SWA/SFE lanes -> CID readback {"SWS":"bafkreiepgvvxpzpklfrb2jp75tr36t57cw4tiyonyu6twci7kqy7gost7e","SWA":"bafkreiatdaqqobjxvxv5anir4xh5nmbqz4nocccnk7w25hddvf6bts4ii4","SFE":"bafkreieddlzjn5fkkrdlxi5362hax2zkqbndf3fpi3rz6t2tmeed6cfzii"}
PASS swpc-realtime {"SWS":{"records":360,"sourceRows":109,"values":848,"flags":5368},"SWA":{"records":50,"sourceRows":50,"fields":150},"SFE":{"records":4,"sourceRows":4,"fields":48,"nullRatios":2},"publishedSWS":{"records":360,"sourceRows":109,"values":848,"flags":5368},"publishedSWA":{"records":50,"sourceRows":50,"fields":150},"publishedSFE":{"records":4,"sourceRows":4,"fields":48,"nullRatios":2}}
```

The test used captured NOAA bytes, an isolated native node, fresh node signing,
the scheduled WASM replay flow, the production parser/storage connector,
signed lane manifests and CID readback. Only the HTTP boundary is replaced
by captured responses. Every record includes source hashes, raw CID identity,
retrieval time and public-domain attribution.

Additional checks:
- SDK artifact compliance, canonical exports/WASI-only imports and harness load: 3 tests passed.
- Eight malformed/incomplete SWS batches refused, then a valid batch succeeds.
- The E2E also refuses malformed JSON separately for SWS, SWA and SFE.
- Composed replay: 15 nodes, nine SWS responses, one SWA response and one SFE response, three storage ingests.
- Full live parsing: 2,028 SWS records, 91 SWA records, 36 SFE records (live data changes).
- `git diff --check` passed.

Repeated RTSW epochs retain every source occurrence in stable source order.
No measurement winner is inferred or dropped. Numerical comparisons use
exact binary64 equality, with source null doubles compared as NaN.

Artifact SHA-256:
- Module: `44bf0d65e32fd14ca8c068abc467019ab6699313fdc8768bf7426567a08ffc2e`
- Production flow: `f37c6c8bbbe573a8c42e94ee4bb43506026b7ddc19fba72f7295c762e3da3d06`
- Replay flow: `b4ac83d4494f7bc2bc4c512148aff95f4b1dcfaac763bec956875c1192a9b765`
- Native node: `02516e740cd7f14002848b6b28dfb9b82c2f2bf6e813154a586d69c44dd9b5cc`

No host-02 installation, main push or gauntlet was performed. Owner signing and deployment remain owner-run.
