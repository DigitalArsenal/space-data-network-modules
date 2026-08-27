# liguria-z11 — how these numbers were produced

Committed so a reviewer can check the lane's published figures without
re-downloading the region. The store itself is not here (it is tens of MB of
records plus hundreds of MB of cached granules, and `tools/terrain-pyramid/out`
is gitignored); these are the reports read off it.

- modules commit: `9a7f4033aeb436649db9a22dc8086fc7ca3f197a`
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
| `data-source/terrain-source/dist/isomorphic/module.wasm` | `46e38201362f98dd2b5820011611904d8d6c4144ccaffd100bc8915f03b29d3b` |
| `data-source/terrain-source/dist/parity/module.wasm` | `dc5d9059b3277488947fd81b8375b9bf0fce4b704d329ecbdbe841d5de89bf3e` |
| `data-source/terrain-ingest/dist/isomorphic/module.wasm` | `bbcf4c1f914a4634ec4f531ade6127e707553c008b75fdda79beee0beeb12165` |
| `flows/terrain-ingest/dist/runtime.wasm` | `7898bef4460226d0eef8cfc6a1de544581f82f47957e40ce668c1668a7ad6f84` |
| `flows/terrain-serving/dist/runtime.wasm` | `5c15862b98cf0b96196301695d054216da430a47a684ab15a8c5a2e204280b46` |

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
- `layer-json-config.json` — the MODULE config keys this run implies
  (`terrain_available`, `terrain_maxzoom`, `terrain_ocean_synth_min_level`,
  `terrain_mount_path`). These go INSIDE the mount's `config:` block and are
  delivered to the guest through `plugin.getConfig`.
- `mount-entry.json` — the MOUNT-level keys, one YAML level up:
  `memory_pages` is `config.FlowMount.MemoryPages`, a sibling of `config:`,
  read only by `internal/flowrt/httpmount.go`. Pasting it inside `config:`
  leaves `MaxMemoryPages` at the 1024-page default, which the ship-scale index
  is measurably over — hence two files rather than one.
