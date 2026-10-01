# Conjunction Assessment Plugin

Conjunction assessment and collision probability implemented in C++/WASM,
using the canonical SDK invoke contract and published SDS **1.220.0** records.

## Public methods and records

`plugin-manifest.json` advertises all 22 methods. Requests and results use
ordinary, verified FlatBuffers with explicit UTC times, Earth reference frames,
source provenance, probability algorithms and units.

| Methods | Input | Output |
| --- | --- | --- |
| `assess_conjunction`, `find_tca` | CQR pair request | CQR event / TCA result |
| `emit_cdm`, `emit_csm` | CQR pair request | SDS CDM / CSM |
| `alfano_max_probability`, `compute_pc` | CQR probability request arm for the method | CQR probability result arm |
| `compute_pc_from_cdm` | SDS CDM | CQR probability result |
| `parse_cdm_kvn`, `parse_cdm_xml` | CQR native document | SDS CDM |
| `write_cdm_kvn`, `write_cdm_xml` | SDS CDM | CQR native document |
| `screen_catalog` | CQR catalog request plus verified OMM frames | Chunked CQR catalog results, plus one OMM per excluded object |
| Three `prepare_*_screening_index` methods | CQR index request | CQR index result |
| `screen_window`, `screen_segment_window` | CQR window request | Chunked CQR catalog results, plus one OMM per excluded object |
| `coarse_grid` | CQR window request on a resident index, and a block of coarse steps | Sampled states and motion bounds for the GPU pair search, plus a JSON report of exclusions |
| `search_candidates` | CQR window request on a resident index, and a block of coarse steps | Candidate pair-steps found on the CPU (the frame `refine_candidates` takes), plus a JSON report of exclusions |
| `refine_candidates` | CQR window request on a resident index, optional candidate pairs and exclusions | Chunked CQR catalog results, plus one OMM per excluded object |
| `destroy_screening_index` | CQR destroy request | Empty successful response |
| `version` | CQR version query | CQR version result |

Use the exact method names, port names and CQR arms in the manifest. The former
JSON `invoke` operation envelope and Emscripten JSON exports are retired.

OMM/TLE sources select the built-in SGP4 provider explicitly. OEM compact arrays,
OEM explicit samples and Cartesian Chebyshev PPE use native track evaluation.
They do not require an external SGP4 module. JavaScript adapters preserve the
native standard records; the guest performs interpolation and physics.
Published OCM 1.220.0 lacks trajectory frame/unit metadata, so that source fails
explicitly. Unsupported providers, frame conversions and controls also fail
explicitly. See the [lane handoff](../../docs/tmpl-lane-14-conjunction-cqr-handoff.md)
for the exact supported profile and remaining work.

### Uncertainty and probability

No uncertainty is invented. A TLE or SGP4 element set carries no covariance,
and no source here supplies one yet, so:

- events report the Alfano maximum probability (`ALFANO_MAXIMUM`,
  `MAXIMUM_PROBABILITY_ONLY`) and its dilution threshold, and no RTN sigmas;
- a covariance method (Foster, Patera, Chan, Alfriend, Alfano 2005, Laas) runs
  only on covariance the caller supplies (`compute_pc`, `compute_pc_from_cdm`,
  reported as `SUPPLIED_COVARIANCE`). Requested for sources without it, the
  event reports the Alfano maximum and says so;
- `emit_cdm` writes no covariance it cannot back, and `write_cdm_kvn` /
  `write_cdm_xml` refuse a CDM without covariance (`covariance-unavailable`),
  since CCSDS requires it, as does `compute_pc_from_cdm`.

Each event reports both objects' hard-body radii and where each came from
(`PRIMARY/SECONDARY_HARD_BODY_RADIUS_M`, `*_RADIUS_BASIS`), and
`COMBINED_RADIUS_M` is their sum. A pair request gives the radii itself
(`SUPPLIED`). In a screen, each source's radius is its `HARD_BODY_RADIUS_M`
(`SUPPLIED`), else half its catalog entry's `SIZE` (`CATALOG_SIZE`), else
`sqrt(RCS / pi)` (`RADAR_CROSS_SECTION`, a radar measure rather than a size),
else half the request's `COMBINED_RADIUS_M` (`REQUEST_DEFAULT`). Events also
state each object's covariance basis; `NONE` until a source supplies one.

See the Evidence-Supported ASO Catalog whitepaper, sections 5, 9 and 16.2.

`signCdmOutput(...)` remains a Node.js host utility for signing emitted CDM bytes and
provenance. It does not perform conjunction calculations.

## Build and runtime contract

```bash
npm ci
export PATH="$HOME/.wasmedge/bin:$PATH"
node build.mjs
```

The public SDK compiler generates the bridge and embedded PLG manifest. Its
`emscripten-pthreads` vocabulary value selects `wasm32-wasip1-threads -pthread`.
The artifact imports `wasi.thread-spawn`, exports `wasi_thread_start`, and uses
shared memory without Emscripten worker hooks. Runtime targets are `browser`
and `wasmedge`; direct and command invoke surfaces are advertised.

The single primary artifact is `dist/isomorphic/module.wasm`. Its canonical
exports include `plugin_alloc`, `plugin_free`, `plugin_invoke_stream`,
`plugin_get_manifest_flatbuffer` and `plugin_get_manifest_flatbuffer_size`.
Bindings regenerate from the installed published SDS package during every build;
`dist/build-provenance.json` records source/schema hashes and thread features.

In browsers, run the module inside an owner Worker on a cross-origin isolated
page so synchronous WASM atomic waits are available. Bundled hosts should serve
the installed SDK worker dependency chain and pass its directory through
`wasiThreadWorkerBaseUrl`. The public loader enables browser WASI threads by
default and accepts `maxThreads` for the SDK worker pool. The executable
`scripts/verify-cqr-browser-wrapper.mjs` demonstrates that public loading path
against the checked-in SOCRATES snapshot.

## Verification

```bash
node --test tests/sdk_compat.test.mjs
npm test
npm run check:compliance
npm run test:runtime-parity
```

The last command checks the same primary bytes in real Chrome, native WasmEdge
and Docker WasmEdge with worker counts 1/2/4/8. The browser serves the installed
SDK worker chain under COOP/COEP. The installed stock WasmEdge CLIs lack the
`wasi.thread-spawn` import, so verification builds a small WasmEdge C API host
and supplies it through SDK launch plans. This host only provides threading
and transport; calculations remain in the primary WASM artifact. Host build
outputs are ignored under `.sdk-build/`.

Test hosts and scripts encode and decode CQR with flatc-wasm through
`tests/lib/cqr.mjs` (`initCqrFlatc`, `createFlatcRunner`). A plain flatc-wasm
26.1.32 `FlatcRunner` leaves each conversion's argv on its 2 MiB stack and
traps at the 1,783rd CQR encode in a process; the helper runs flatc with argv
on the heap, and `tests/pairCallsOneInstance.test.mjs` makes 10,000 pair calls
on one instance, each request encoded as it is sent.

Measured results, source references, and limitations are in the
[handoff](../../docs/tmpl-lane-14-conjunction-cqr-handoff.md). The eight large
dataset checks require the ignored files documented below; checked-in snapshots
run without those files.

Catalog results emit at most 128 events per frame (`refine_candidates`: 1024). Continue an identical request
until `FINAL_CHUNK` is true, preserving its input `FRAME_ID`. Concurrent drains
must use distinct input frame IDs because SDK 0.8.18 does not expose the PIV
trace ID to guest continuation state. Failed pairs are counted, and the final
response reports `incomplete-screening` when any evaluation failed.

An object that SGP4 cannot propagate at one of the coarse epochs of the window
(a reentering or already decayed element set: "Satellite has decayed",
"Error: (e <= -0.001)", ...) is excluded from the screening instead of failing
the request. Every other pair is screened exactly as if the object were absent.
The final chunk carries one `$OMM` per excluded object on the `excluded` port:
its mean elements, Earth/TEME, with `COMMENT` naming the earliest failing
coarse epoch and the propagator error there. `OBJECTS_PARSED` counts every
object; `STATISTICS.TOTAL_OBJECTS` leaves the excluded ones out, so the
difference is the number of excluded records. `PAIRS_SCREENED` and
`PAIRS_PREFILTERED` still describe the planned pair set. Objects the coarse
pass never propagates (for example, secondaries whose altitude band misses
every primary) are neither screened nor reported.

Each close approach within the threshold is its own event: a pair that meets
several times in a window is reported at each TCA, and an event belongs to the
window that holds its TCA. One window or consecutive windows over the same span
(on the same coarse-step grid) give the same events: the same pairs, TCAs
within the refinement tolerance, the same miss distances. `KD_TREE_CANDIDATES`
counts pairs with a coarse hit (per chunk past 10000 coarse steps) and
`TCA_REFINED` counts encounters, runs of consecutive coarse hits of one pair.
This holds for SGP4 mean-element sources screened with `ALFANO_MAXIMUM`
(`screen_catalog` and the resident source-description index). The generic
engine path (sampled or non-mean polynomial sources, other probability
algorithms) still reports each pair's closest approach in the window.

## Catalog size and partitioned runs

One `screen_catalog` call screens its whole pair set inside the guest's linear
memory, which is at most 2 GiB. The coarse pass keeps a record per encounter,
so an all-vs-all call grows with the square of the object count and with the
window: about 0.63 encounters per pair per day over a full catalog. Measured
all-vs-all, one call, over a stride sample of a full CelesTrak GP catalog
(31,807 objects, OrbPro's gallery `omm-cache.fb`), 2026-07-06 + 1 day, 5 km
threshold, 60 s coarse step, 8 workers, Node V8 host:

| Objects | Pairs | Encounters | Peak guest memory | Result |
| ---: | ---: | ---: | ---: | --- |
| 2,000 | 2.0 M | 1.3 M | 211 MiB | 181 conjunctions |
| 4,000 | 8.0 M | 5.1 M | 596 MiB | 837 conjunctions |
| 6,000 | 18.0 M | 11.3 M | 1,905 MiB | 1,890 conjunctions |
| 7,000 | 24.5 M | 15.6 M | 1,503 MiB | 2,571 conjunctions |
| 8,000 | 32.0 M | | | traps out of memory (`RuntimeError: unreachable`), also with 4 workers |

So one call screens about 7,000 objects against each other per day of window,
fewer for longer windows; past that the guest traps and its instance is lost.
Peak memory is not monotone in the object count because the encounter tables
grow by doubling.

A whole catalog screens in one pass with the pair search on a GPU
([GPU all-vs-all](docs/gpu-all-vs-all.md)). It takes any propagator's
trajectories: mean elements (SGP4) or PPE, such as HPOP's
conjunction-screening export in TDB/GCRF. `coarse_grid` and
`refine_candidates` keep sampling and refinement in the module and report
`screen_catalog`'s result. `scripts/run-all-vs-all-gpu.mjs` runs
`examples/all-vs-all-gpu` in a WebGPU browser. Three days of the full catalog take 19 s with SGP4 without a GPU (`search_candidates`, in Node; 23 s in SDN's patched WasmEdge, AOT), 21 s with the GPU, and 382–438 s with HPOP, propagation included, in time windows with one propagator per run. [docs/benchmark.md](docs/benchmark.md) runs it on another machine.

Without a GPU, screen larger catalogs with the partitioned runner,
`scripts/run-sdn-omm-partitioned-screen-catalog.mjs`, and
`--catalog-block-size B` ([partition runs](docs/celestrak-full-catalog-partitions.md)):
each invocation carries one block pair, at most `2B` objects and `B * B` pairs,
and the run screens every pair of the catalog exactly once. Keep `2B` well
inside the single-call figure for the window (`B = 1000` for one day). The
runner's default ordered-primary mode (`--partition-size`) also screens every
pair once, but every invocation carries the whole catalog.

Authoritative numerical tests include the committed CelesTrak SOCRATES snapshot,
closed-form constant-velocity encounters, the Gaussian/Rayleigh probability
integral, and native published Orekit probability and CDM fixtures. Each
scientific fixture records its source, frame/time, units and tolerances. CMake
builds native numerical tests only; point `SDN_FLATBUFFERS_INCLUDE_DIR` at headers
matching the generated bindings before configuring.

## Local validation data map

Large validation datasets are deliberately kept outside git. Put them under
the package-local ignored test-data directory:

- `tests/data/`
- Detailed layout: `tests/data/README.md`

Place SOCRATES/CelesTrak catalog files directly under `tests/data/`:

- `socrates_current.csv`
- `socrates_full.csv`
- `socrates_maxprob.csv`
- `socrates_minrange_current.csv`
- `socrates_norad_ids.txt`
- `socrates_gp/gp_*.json`

Place Aerospace IVV archive files under `tests/data/aerospace-archives/`:

- `aerospace-archives/AerospaceIVVDataset_20251009a.tar.gz`
- `aerospace-archives/AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv.gz`
- `aerospace-archives/IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv.gz`
- `aerospace-archives/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz`
- `aerospace-archives/Conjunction_Screening_Testset_Users_Guide.pdf`

## Aerospace V&V dataset

The protected Aerospace dataset is intentionally not vendored here. The package
now expects the extracted dataset under this gitignored local directory by
default:

- `tests/data/aerospace-ivv/`

The tests run against that location automatically. The extracted directory placed there must contain this structure:

- `tests/data/aerospace-ivv/docs/Conjunction_Screening_Testset_Users_Guide.txt`
- `tests/data/aerospace-ivv/csv/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv`
- `tests/data/aerospace-ivv/csv/IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv`
- `tests/data/aerospace-ivv/csv/AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv`
- `tests/data/aerospace-ivv/ocm/AerospaceIVVDataset_20251009/...`

If you want to keep the extracted dataset somewhere else, override the root explicitly:

```bash
export AEROSPACE_IVV_EXTRACTED_ROOT=/absolute/path/to/extracted
npm run test:aerospace
```

`AEROSPACE_IVV_EXTRACTED_ROOT` and
`CONJUNCTION_AEROSPACE_IVV_EXTRACTED_ROOT` are both supported, but the
package-local `tests/data/aerospace-ivv/` location is the default.

## Conjunction parity fixtures

```bash
npm run test:ca-parity
```

The SOCRATES tests use the primary threaded artifact through the SDK browser
direct harness. The snapshot gates event-set recall, TCA, miss distance and
relative speed. Maximum-Pc comparisons remain advisory.

The Aerospace fixtures include synthetic linear encounters with analytic
answers; they are not real Aerospace validation data. Published OCM records with
no frame/unit declaration fail explicitly. Real-data tests retain their existing
data requirements and skip only when the documented datasets are unavailable.
Tolerance definitions live in `tests/lib/caParityTolerances.mjs`; historical
context is retained in `docs/a2.8a-ca-parity-ground-truth.md`.

## Hosted-runtime example

`tests/fixtures/hosted-runtime/conjunction.single-plugin.flow.json` binds a
manual trigger to `screen_catalog` on the typed `request` port. Hosts submit CQR
catalog requests and drain yielded responses without changing the request or
its trace/stream identity. The final chunk reports failure counts/status when
pair evaluation is incomplete, and lists excluded objects on `excluded`.

## License

MIT.
