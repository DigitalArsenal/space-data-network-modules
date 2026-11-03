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
- Module: `75a54b76a04dd290abd07041592d48e226339f99ab125fce6ce199a53e030fa0`
- Production flow: `ec50e70d6276f7b393c2a0bacaa690b216313d4fe50967d3005ca43f5f5dc8c6`
- Replay flow: `79d165a088154aa54a89f11e1ac3b485edfb14993c519eb2b13ea493f527494a`
- Native node: `02516e740cd7f14002848b6b28dfb9b82c2f2bf6e813154a586d69c44dd9b5cc`

Owner signing and host-02 deployment remain owner-run.

## Static-gate follow-up

The flow now pins SDK 0.9.12 locally. Build helpers no longer emit intermediate
JSON, and integer source tokens use decimal integer conversion. All six module
methods declare and validate optional MCFG inputs. Configuration tests passed:
12 configured calls have identical output, and 30 invalid configs are refused.
The three required static gates pass without baseline changes. Both unsigned
artifacts were rebuilt; hashes below reflect this follow-up. The CID acceptance
lines above document the preceding run; the full gauntlet will repeat them.
