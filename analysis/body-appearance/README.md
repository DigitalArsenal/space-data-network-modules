# Body appearance

Partial implementation for `body-appearance-module-20261022`. This is **not a
completed or validated all-body appearance model**. The required E2E gate fails
until absolute Moon and planetary disk photometry is implemented and validated.

The C++ module contains cited parameter lookup, deterministic rock/crater
placement, solar differential rotation, and relative H,G1,G2 photometry.
`dist/isomorphic/module.wasm` is the single artifact for Node, browser and native
WasmEdge. `codec.js` only encodes/decodes canonical SDS PCE FlatBuffers. There is
no runtime physics or statistics in JavaScript.

## Build and verification

```sh
cd analysis/body-appearance
npm ci
# Install the repository-approved Emscripten release under deps/emsdk first.
# The SDK's native WASI route also needs its sanctioned WASI sysroot/runtime.
# SDN_WASI_SYSROOT and SDN_WASI_RESOURCE_DIR may identify those libraries.
uptime
npm run build
node --test tests/sdk_compat.test.mjs
npm test
# Optional: FIREFOX_BINARY=/absolute/path/to/an/installed/headless/Firefox
# Optional: WASMEDGE_BINARY=/absolute/path/to/wasmedge
npm run test:e2e
```

`build.mjs` uses SDK 0.8.27 `compileModuleFromSource` with `wasi-sequential` and
the native clang++ driver inside **repo-local** `deps/emsdk`. This bounded pure
transform has a manifest `sequentialJustification`. No system Emscripten is
invoked. The SDK resolves the WASI sysroot and runtime libraries separately;
the build does not claim those libraries are shipped with Emscripten.
The build limits compiler cores to two and refuses load averages of 30 or more.
Build scratch stays in ignored `.build/`.

The E2E runs sequential Node, one headless Firefox, and native WasmEdge legs.
It compares SHA-256 digests of the complete typed outputs, including both
100,005-object populations, repeated/different seeds, a polar tile, rotation,
phase and table lookup. Browser and native WasmEdge use unchanged artifact bytes.
The owner waived Docker parity on 2026-10-22: **never start Docker or Docker
Desktop**. The test has no Docker or Chrome launcher.

The committed checkpoint evidence is `conformance/acceptance-report.json`.
The default fresh evidence path is `.build/e2e-report.json`; set
`BODY_APPEARANCE_REPORT` to preserve a report elsewhere. Missing science gates
are failures, not skips. `npm test` validates the implemented subset and the
independent oracle; it does not replace the full E2E acceptance gate.

## Typed contract

Module ID: `com.digitalarsenal.analysis.body-appearance`. Every method accepts
one `request` PCE and emits one `result` PCE. Provider-defined names identify
scalars, vectors and strings. Result descriptors carry data types and units;
parameter descriptors also carry DOI, locator and scope. The SDK supplies the
invoke ABI and embeds the authoring manifest in the WASM artifact.

| Method | Required input | Result and convention |
| --- | --- | --- |
| `parameters` | `model` | Cited table entries for that exact named model; unavailable classes fail explicitly. |
| `rotate` | `profile`, `latitude_rad`, `longitude_rad`, `epoch_tai_s`, `scene_tai_s` | Snodgrass–Ulrich sidereal rate and advanced longitude, wrapped to [0,2π). Optional `frame_rate_rad_s` defaults to zero. |
| `phase_curve` | `model`, `phase_rad` vector; `G1`, `G2` for `hg1g2` | Relative flux and magnitude dimming. `moon:muinonen2010` selects the published lunar weights. No absolute magnitude or geometric/normal albedo is implied. |
| `place` | `body_id`, `level`, `x`, `y`, `seed`, `radius_m` | Body-fixed XYZ meters, diameter meters, azimuth radians and uint32 shape seeds for each requested population. |

Rotation profiles are `magnetic`, `doppler` and `spectroscopic`; selection is
explicit because their physical tracers differ. Times are TAI seconds from the
same caller-chosen epoch. Longitude increases in the rotation direction relative
to the caller's uniformly rotating frame. This is feature advection, not an
ephemeris or a live space-weather model.

Tiles are equirectangular: `2^level` cells on each axis, longitude from −π to π
west to east and latitude from +π/2 to −π/2 north to south. Positions are uniform
in spherical area. Levels 0–24, valid tile indices, uint32 seeds, and a caller
radius in meters are required. +Z is north, +X the prime meridian, +Y east.
Azimuth is clockwise from local north about the surface normal. Uniform azimuth
is an explicit modeling assumption, not a measured orientation distribution.

Rock placement takes `rock_abundance`, `rock_min_m`, `rock_max_m`. The abundance
is the extrapolated coefficient k in F(D)=k exp(−qD), **not** the fractional area
above an arbitrary raster detection threshold. For Mars (`body_id=499`), the
published calibration q=1.79+0.152/k is used. Other bodies require explicit
`rock_q_per_m` and `rock_law_source`. A Diviner pixel cannot be passed unchanged
without converting its documented diameter-threshold convention. That mapping
and a validated lunar size law remain unfinished.

The rock *number* distribution is proportional to exp(−qD)/D², obtained by
dividing the differential area distribution by each circular footprint. It is
not an exponential number distribution. Expected CFA over [a,b] is
k[exp(−qa)−exp(−qb)]. Reported CFA is the sum of projected footprints divided by
tile area; overlaps are not unioned. Placement does not perform collision
resolution or claim geologic clustering.

Lunar craters (`body_id=301`) take `crater_n1_km2`, `crater_min_m`,
`crater_max_m`. N(1 km) is an explicit retained density, not an assumed age.
The Neukum 2001 shape is restricted to its published 10 m–300 km diameter
domain; sub-10-meter craters are refused. Maximum output is 250,000 instances
per population and rejection sampling is bounded. Request a finer tile when
the budget is exceeded. Omitting both populations returns empty vectors.

## Sources and remaining scope

`data/parameters.json` holds 112 cited values: S/C/V class-average Hapke
parameters, three solar profiles, lunar median roughness/Hurst scales, lunar
crater coefficients, the Mars rock law, H,G1,G2 basis/weights and two identified
566 nm LROC Hapke map pixels. Median slopes are labeled as medians, not RMS.
The two map pixels are not asserted to represent whole terrain classes.
`data/sources.json` records primary download URLs, hashes, byte sizes and limits.
All physical numbers have DOI and table/equation/dataset-pixel locators.

Mallama & Hilton 2018 equations exist **only in tests/**. The published Fortran
was read as data and not executed. Ten published numerical examples validate
the test oracle; its Saturn cubic follows the paper's printed coefficient,
which differs from the published Fortran by 1e-9. It is never a runtime or build
input. ROLO 553.8 nm is also a test-only oracle here.

The current lunar comparison is a **relative phase-shape diagnostic**, normalized
at 5°, over 2°–96° for both signs of solar longitude at zero observer libration.
It does not compare absolute irradiance, matched bandpasses or a rendered Moon.
Its residual cannot be reported as passing the required absolute 0.1 mag gate.

Still required: independent disk photometry for Moon and all seven requested
planets, all-body albedo/color/roughness tables, D and X/M taxonomic priors and
taxonomy/albedo selection, Diviner input mapping, and named-spacecraft
matched-geometry render/image-similarity and shadow-fraction evidence. Original
Bandfield 2011 and Golombek–Rapp 1997 downloads remain unavailable after publisher
403/timeouts; the rock law is verified in Golombek et al. 2021 Section 1.
