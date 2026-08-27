# liguria-z11 — how these numbers were produced

Committed so a reviewer can check the lane's published figures without
re-downloading the region. The store itself is not here (it is tens of MB of
records plus hundreds of MB of cached granules, and `tools/terrain-pyramid/out`
is gitignored); these are the reports read off it.

- modules commit: `576272fadb40b7831f5cccf65f58983f005a7eed`
- WasmEdge: `wasmedge version 0.16.4`
- run config: `tools/terrain-pyramid/regions/liguria-z11.json`

## The commands

```
node tools/terrain-pyramid/run.mjs --config tools/terrain-pyramid/regions/liguria-z11.json
node tools/terrain-pyramid/verify.mjs --out <the config's "out" dir>
node tools/terrain-pyramid/measure-accuracy.mjs --out <the config's "out" dir>
node tools/terrain-pyramid/snapshot-evidence.mjs --out <same> --name liguria-z11
```

The granules come from the open Copernicus GLO-30 S3 bucket by URL, derived by
the ingest module from the region bbox — there is no separate granule manifest
to pin, because the enumeration is a pure function of the run config and the
durable mark. Re-running with the same config against the same dataset edition
(`dataset_epoch`) reproduces the same store, and `run.mjs` re-cuts every cell
under the pinned native WasmEdge and refuses the run if the two engines disagree
on a single byte.

## The artifacts this run executed

| artifact | sha256 |
| --- | --- |
| `data-source/terrain-source/dist/isomorphic/module.wasm` | `8e250234abeeae342112023b87d3212f9779a2437d65e79efd5cf7e3a20488ae` |
| `data-source/terrain-source/dist/parity/module.wasm` | `16fb4ba08078159be7f2e9a5fc8e7722ac1710e60aa4318f021470703dbac725` |
| `data-source/terrain-ingest/dist/isomorphic/module.wasm` | `bbcf4c1f914a4634ec4f531ade6127e707553c008b75fdda79beee0beeb12165` |
| `flows/terrain-ingest/dist/runtime.wasm` | `8477c239631c2b40e7011b3b5832bf48831f6039d2b32522570f7a487b6c4d49` |
| `flows/terrain-serving/dist/runtime.wasm` | `454c191ab66798059bbd0afb61de9e917edc90b2e9f4ecf158e3e89fd12b0fc0` |

## What is in each file

- `verify-report.json` — **the evidence.** Everything re-derived from the
  record bytes by `verify.mjs`: the FlatBuffers are walked by hand, payloads
  gunzipped and quantized-mesh headers read from the spec, so a bug in the
  encoder cannot also hide itself in the check. Bounds, seam continuity,
  availability closure, digests, mask geometry.
- `run-report.json` — the builder's own numbers: timings, fetches, cells,
  durable marks, the WasmEdge cross-check, and the encoder counters
  (`edgeClampedPosts`, `bandBridgedPosts`, `tilesAtCeiling`) that are not in
  the records and can only come from here.
- `accuracy-report.json` — triangulation density against a denser re-sample
  through the same module. Read its header comment for what it is NOT
  independent of.
- `layer-json-config.json` — the serving config keys this run implies
  (`terrain_available`, `terrain_maxzoom`, `terrain_ocean_synth_min_level`,
  `terrain_mount_path`), which is what the deploy actually installs.
