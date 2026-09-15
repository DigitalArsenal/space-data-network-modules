# Conjunction Assessment Plugin

Conjunction assessment and collision probability implemented in C++/WASM,
using the canonical SDK invoke contract and published SDS **1.220.0** records.

## Public methods and records

`plugin-manifest.json` advertises all 19 methods. Requests and results use
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
| `screen_catalog` | CQR catalog request plus verified OMM frames | Chunked CQR catalog results |
| Three `prepare_*_screening_index` methods | CQR index request | CQR index result |
| `screen_window`, `screen_segment_window` | CQR window request | Chunked CQR catalog results |
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

`signCdmOutput(...)` remains a host utility for signing emitted CDM bytes and
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

## Verification

```bash
node --test tests/sdk_compat.test.mjs
npm test
npm run check:compliance
npm run test:runtime-parity
```

The last command attempts the same primary bytes in browser, native WasmEdge and
Docker WasmEdge with worker counts 1/2/4/8. SDK 0.8.18 currently has command-host
failures for wasi-threads; these gates remain failing rather than being replaced
with another runtime. Browser direct-invoke numerical evidence and the actual
failing gate results are in the [handoff](../../docs/tmpl-lane-14-conjunction-cqr-handoff.md).

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
pair evaluation is incomplete.

## License

MIT.
