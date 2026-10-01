# All-vs-all benchmark on another machine

Screens a whole catalog all-vs-all over three days and checks the result
against the reference run below. Results go back as the summary JSON files.

## 1. Set up

Requires Node.js 20 or newer (tested on 25) and git. The GPU run also needs
Chrome or Chromium with WebGPU; set `SDM_CHROME_BINARY` to its path if it is
not installed in the usual place.

```
git clone https://github.com/DigitalArsenal/space-data-network-modules.git
cd space-data-network-modules/analysis/conjunction-assessment
npm ci
```

The module (`dist/isomorphic/module.wasm`) is committed; do not rebuild it.

## 2. Make the catalog

Use the full GP catalog. From Space-Track (an account is required; do not
commit or share the file, as Space-Track's terms forbid redistribution):

```
https://www.space-track.org/basicspacedata/query/class/gp/decay_date/null-val/epoch/%3Enow-30/orderby/norad_cat_id/format/json
```

Save it as `gp.json`, then:

```
node scripts/make-omm-catalog.mjs gp.json catalog.OMM.uint32be.bin
```

Without an account, CelesTrak's JSON works the same way for a smaller run,
for example `https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json`.

## 3. Run

Start each screen at 2026-10-01T00:00Z (`--start 2461314.5`). On a different
date, pass the Julian date of a midnight within a few days of the catalog's
epochs.

```
# CPU, no GPU (Node): the main result
node scripts/run-all-vs-all-cpu.mjs --runtime node --catalog catalog.OMM.uint32be.bin \
  --start 2461314.5 --days 3 --out cpu-sgp4.json

# GPU, headless Chrome with WebGPU (skip if there is no GPU)
node scripts/run-all-vs-all-gpu.mjs --catalog catalog.OMM.uint32be.bin \
  --start 2461314.5 --days 3 --out gpu-sgp4.json

# HPOP, CPU (slow: propagation dominates, about 7 minutes on 28 cores)
node scripts/run-all-vs-all-cpu.mjs --runtime node --propagator hpop \
  --catalog catalog.OMM.uint32be.bin --start 2461314.5 --days 3 --out cpu-hpop.json
```

Each prints one summary line: candidates, conjunctions, excluded objects, end
to end time, and the time per stage. `--workers N` sets module threads (default:
cores − 1). Close other heavy work first, and report the 1-minute load average.

WasmEdge (`--runtime wasmedge --aot`) needs SDN's patched WasmEdge 0.16.4.
Stock 0.16.4 ahead-of-time compilation deadlocks on this module (see
[gpu-all-vs-all.md](gpu-all-vs-all.md#without-a-gpu)). Use Node unless that
build is available.

## 4. Check

- All runs on one catalog and propagator must report the same conjunctions;
  `cpu-sgp4.json` and `gpu-sgp4.json` hold them as `events`.
- Agreement with the single-call screen on a stride sample:
  `node scripts/compare-single-call.mjs <sample.OMM.uint32be.bin> 1` (keep the
  sample to a few thousand objects).
- `npm test` runs the parity suites.

## 5. Report

Return, for each run: the summary line, the summary JSON, the CPU model and
core count, the GPU (if any), the Node version, the load average, and the
catalog's source and date.

## Reference

Mac Studio, 28 cores, Space-Track GP catalog of 2026-09-30 (32,514 objects),
5 km threshold, 60 s steps, host shared with other work:

| Run | End to end | Conjunctions |
| --- | ---: | ---: |
| SGP4, CPU, Node | 19.1 s | 292,516 (25 objects excluded) |
| SGP4, GPU (Metal) | 26.1 s | 292,516 |
| HPOP, CPU, Node | 437.8 s | 301,396 |

The numbers of conjunctions match only for the same catalog snapshot.
