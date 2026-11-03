# Acceptance: 2026-11-03

SDS dependency: 1.273.0. Module and production flow built with explicit
`--unsigned`. No host-02 installation, main push, or gauntlet was performed.

`node data-source/swpc-realtime/tests/swpc-realtime.e2e.mjs --check-pending-flares`
exited 0. The test used captured NOAA bytes, an isolated native node, fresh
node signing, the scheduled WASM replay flow, the production parser/storage
connector, signed lane manifests and CID readback of every record/shard.

```text
PASS SWS native-node CID readback {"records":360,"sourceRows":109,"values":848,"flags":5368}
PASS SWA native-node CID readback {"records":50,"sourceRows":50,"fields":150}
PREPARATION ONLY: current SFE fields checked; not published or counted in PASS
PASS scheduled native flow -> signed SWS/SWA lanes -> CID readback
PASS swpc-realtime: published SWS 360 records / 109 source rows / 848 values / 5368 flags; published SWA 50 records / 50 source rows / 150 fields; flares pending SDS 1.274.0
```

Manifests from that isolated run:
- SWS: `bafkreigjol6wrs224ahkcvoz27rien6bzlrc2kv6lthjgo2be5zxt3wgou`
- SWA: `bafkreidupc7xuqmazrjxnqof4hsdernyudx4mweaeqekbqw4ofa2v7pmly`

Other checks passed:
- SDK compliance, canonical exports/WASI-only imports, same-artifact harness load: 3 tests.
- Eight malformed/incomplete batches refused without outputs; valid invocation succeeds afterward.
- Composed replay: all 10 nodes invoked successfully, all 9 SWS responses and 1 SWA response consumed, two storage ingests.
- Full live-source parsing: 2,028 SWS records and 91 SWA records (live data changes).

The live-source check uncovered repeated epochs in RTSW, including conflicting
ephemeris values. All occurrences are retained in stable source order within
ascending epochs. The captured fixtures include repeated-epoch examples; no
sample is selected as a winner or dropped. Numeric nulls are NaN, source flags
remain verbatim, and comparison uses exact binary64 equality.

Flares remain excluded from publication and acceptance counts. The prepared
SFE parser's existing fields passed an optional check. The four new fields and
node refresh are the coordinator's pending SDS 1.274.0 follow-up.

Artifact SHA-256 (formatting rebuild reproduced module and production flow bytes):
- Module: `cc43653c71608e3f378bc5e60fd4fcf07302231522e796e03b6c254cc3bd28a4`
- Production flow: `91d6d2ff74ae21071800796605820da8b17f24ef1b3214549ee02e8bb93e5aef`
- Replay flow: `0614ce082836ebcd7ed6036c18d67e57195c625a6f5a3fd2b8c7e3aa4325ba24`
- Native node: `0cd1378b1820730b4a03244c45ec67e5eb812b7e356a222843704e060cb0d07e`
