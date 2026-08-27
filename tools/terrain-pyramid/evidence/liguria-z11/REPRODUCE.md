# liguria-z11 — how these numbers were produced

Committed so a reviewer can check the lane's published figures without
re-downloading the region. The store itself is not here (it is tens of MB of
records plus hundreds of MB of cached granules, and `tools/terrain-pyramid/out`
is gitignored); these are the reports read off it.

- modules commit: `91b3c9a95bf5f5c032262dc79999c7ba30aaf681`
- WasmEdge: `wasmedge version 0.16.4`
- run config: `tools/terrain-pyramid/regions/liguria-z11.json`

## The commands

```
node tools/terrain-pyramid/run.mjs --config tools/terrain-pyramid/regions/liguria-z11.json
node tools/terrain-pyramid/verify.mjs --out <the config's "out" dir>
node tools/terrain-pyramid/measure-accuracy.mjs --out <the config's "out" dir>
node tools/terrain-pyramid/cross-check-accuracy.mjs --out <same>
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
| `data-source/terrain-source/dist/isomorphic/module.wasm` | `448ba28a1a68d482a02358b2037fd467e733d20aade01d759bd0d08b5c165e4b` |
| `data-source/terrain-source/dist/parity/module.wasm` | `d659f301a882222aa82161f0b8aaa610c0083fd6b5a9e0286ab298b5df2d24a1` |
| `data-source/terrain-ingest/dist/isomorphic/module.wasm` | `bbcf4c1f914a4634ec4f531ade6127e707553c008b75fdda79beee0beeb12165` |
| `flows/terrain-ingest/dist/runtime.wasm` | `7bcd5a8d2c5f4e5847e672f75dc7b9dc52ed089e1f594e5d08e31e8174f39269` |
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
- `cross-check-report.json` — the record's OWN stated VERTICAL_ACCURACY_M
  joined per address against that re-sample's max error. The encoder writes the
  field and selects the mesh density by it, so this is the one number in the
  store with a second opinion attached: a ratio near 1.0 on the flat controls
  AND on the high-relief tiles is the result to want, and a high-relief ratio
  far above 1 while the controls sit at 1 is the signature of a probe that only
  looks where the terrain is smooth.
- `layer-json-config.json` — the serving config keys this run implies
  (`terrain_available`, `terrain_maxzoom`, `terrain_ocean_synth_min_level`,
  `terrain_mount_path`), which is what the deploy actually installs.
