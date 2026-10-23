# Body appearance

Partial implementation for `body-appearance-module-20261022`. This is **not a
completed or validated all-body appearance model**. The required E2E gate fails
until the planetary Johnson V disk models meet the accuracy gate.

The C++ module contains cited parameter lookup, deterministic rock/crater
placement, solar differential rotation, and relative H,G1,G2 photometry.
It also integrates independent Jupiter and Saturn scattering models over a
sphere and converts their absolute albedo into flux and magnitude. The original
narrow or Pioneer bands are not a Johnson V calibration. A separate synthetic Jupiter
V model now integrates published spectral scattering parameters, the V energy
response and the solar spectrum; its measured 0.15325 mag residual fails the
required 0.1 mag limit.
The Moon has absolute ROLO 311g spectral irradiance at 553.8 nm, checked against
an independently transcribed ROLO oracle with both signs of solar longitude,
observer libration, and distance scaling.
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
/Users/tj/software/terrain-work/lanes/headless-run npm run test:e2e
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
phase, absolute photometry, and table lookup. Browser and native WasmEdge use
unchanged artifact bytes. The browser server supplies COOP/COEP headers and the
test verifies `crossOriginIsolated` and `SharedArrayBuffer` availability.
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
| `disk_photometry` | `model`, `phase_rad`, `radius_m`, `sun_distance_au`, `observer_distance_m`; `solar_magnitude` except for the calibrated V model | Absolute disk albedo, flux relative to the Sun at 1 au, and apparent magnitude. Solar magnitude must match the model band; `jupiter:heng2021:V` supplies its own cited solar magnitude and rejects an override. |
| `lunar_irradiance` | `model`, `phase_rad`, `solar_longitude_rad`, `observer_latitude_rad`, `observer_longitude_rad`, `sun_distance_au`, `observer_distance_m` | Absolute spectral irradiance in W/m²/nm, disk reflectance, solar flux ratio, and monochromatic-equivalent AB magnitude. |
| `place` | `body_id`, `level`, `x`, `y`, `seed`, `radius_m` | Body-fixed XYZ meters, diameter meters, azimuth radians and uint32 shape seeds for each requested population. |

Rotation profiles are `magnetic`, `doppler` and `spectroscopic`; selection is
explicit because their physical tracers differ. Times are TAI seconds from the
same caller-chosen epoch. Longitude increases in the rotation direction relative
to the caller's uniformly rotating frame. This is feature advection, not an
ephemeris or a live space-weather model.

Disk models are `jupiter:heng2021:550nm` (Heng & Li 2021 Table 1; phase
0–140°), `saturn:dyudina2016:640nm` and `saturn:dyudina2016:440nm`
(Dyudina et al. 2016 Table 3; phase 0–150°; globe only). A 64×64
Gauss-Legendre integral covers the illuminated visible sphere. Jupiter uses the
paper's double Henyey-Greenstein single scattering and isotropic multiple
scattering. Saturn uses the Barkstrom law, with explicit linear interpolation
between its 30° parameter knots. These models contain no Mallama–Hilton inputs. The synthetic
`jupiter:heng2021:V` variant also covers 0–140°; its spectral integration is
described below.
`sphere:lambert` additionally requires `surface_albedo` and supplies a
closed-form verification case. Geometry is far-field (observer at least 100
radii away), with a caller-specified spherical radius; there is no ellipsoid,
ring, seasonal, or longitudinal correction. At most 256 angles per call.

The lunar identifier is `moon:rolo311g:553.8nm`; angles on the wire are radians.
Phase and solar-longitude vectors must have equal lengths (1–4096). East solar
longitude and observer libration are selenographic. ROLO's fitted phase interval
is strictly 1.55°–97°. Operational bounds are ±8° observer latitude, ±10°
observer longitude, 0.9–1.1 au Sun distance, and 300,000–500,000 km observer
distance. The caller supplies physically consistent geometry. The output is
ROLO filter 23 (nominal 555 nm), not Johnson V. AB values use the corrected
conventional sign in the Oke–Gunn definition (−48.60), not the + sign misprinted
in the 1983 paper. Absolute flux uses ROLO Table 1's solar irradiance and Eq.(8)'s
standard lunar solid angle; it does not normalize to a selected phase.

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

`data/parameters.json` holds 727 cited values: S/C/V class-average Hapke
parameters, three solar profiles, lunar median roughness/Hurst scales, lunar
crater coefficients, the Mars rock law, H,G1,G2 basis/weights and two identified
566 nm LROC Hapke map pixels, and independent Jupiter/Saturn scattering
coefficients, ROLO 311g radiometric parameters, and seven-band geometric
albedos for each of the seven requested planets (Mallama et al. 2017 Table 7),
24 Jupiter spectral scattering fits, the V response, and 197 solar spectrum
samples with native FITS row provenance.
These are geometric albedos, not normal or Bond albedos. Albedo-only identifiers
are `planet:<lowercase-body>:albedo2017`; they do not imply a phase law.
Median slopes are labeled as medians, not RMS.
The two map pixels are not asserted to represent whole terrain classes.
`data/sources.json` records primary download URLs, hashes, byte sizes and limits.
All physical numbers have DOI and table/equation/dataset-pixel locators.

Mallama & Hilton 2018 equations exist **only in tests/**. The published Fortran
was read as data and not executed. Ten published numerical examples validate
the test oracle; its Saturn cubic follows the paper's printed coefficient,
which differs from the published Fortran by 1e-9. It is never a runtime or build
input. The independent ROLO transcription remains in tests, while the shipped
lunar model evaluates the published parameters from `data/parameters.json`.

The H,G1,G2 lunar comparison is a **relative phase-shape diagnostic**, normalized
at 5°, over 2°–96° for both signs of solar longitude at zero observer libration.
It does not compare absolute irradiance, matched bandpasses or a rendered Moon.
Its residual cannot be reported as passing the required absolute 0.1 mag gate.
The separate absolute ROLO comparison is same-model implementation verification;
it does not establish that a separate surface-scattering model predicts ROLO.

Still required: Johnson V disk photometry meeting the 0.1 mag gate for all seven
requested planets, independent lunar surface-model validation, normal albedo/color and
roughness tables, D and X/M taxonomic priors and
taxonomy/albedo selection, Diviner input mapping, and named-spacecraft
matched-geometry render/image-similarity and shadow-fraction evidence. Original
Bandfield 2011 and Golombek–Rapp 1997 downloads remain unavailable after publisher
403/timeouts; the rock law is verified in Golombek et al. 2021 Section 1.

## Resumed acceptance evidence

The committed report records 727 cited values (zero uncited), 100,005 rocks
(KS p=0.7446435365, CFA error 1.1448613%) and 100,005 craters
(KS p=0.7206844027, CFA error 0.4132020%). Absolute lunar ROLO verification
covers 10,044 geometries with a maximum residual of 3.1341e-15 mag; this
measures implementation arithmetic, not lunar model uncertainty. All 13 unit
tests pass. Node, isolated headless Firefox, and native WasmEdge produce exactly
matching complete typed payloads for all 13 parity requests, including
absolute lunar irradiance and synthetic Jupiter V photometry.

The E2E remains **FAIL** on all seven planetary absolute Johnson V gates.
Jupiter is measured at 1,043 phase samples over 0–130°; the maximum absolute
residual is 0.15324716 mag. The other six V models remain unavailable.
Cross-band normalized phase-shape diagnostics reach 0.2885843 mag for Jupiter
(131 samples, 0–130°) and 0.1701227 mag for Saturn (151 samples, 0–150°).
Neither diagnostic supplies a matched-band absolute acceptance value. The other
five planets have cited geometric albedos but no implemented disk phase model.
The source access failures and exact missing calibration inputs are preserved
in the report. Resumed Mercury, Venus, and Mars paper requests each timed out
after 25 seconds with no bytes. Earlier Uranus/Neptune ADS requests returned 403, and their NASA
records offer no download. The newly read Irwin et al. 2025 Uranus study
(doi:10.1093/mnras/staf800) provides its underlying data by author request,
not as a tabulated Johnson V phase dataset in the paper. The available Venus
glory paper requires a spherical-atmosphere multiple-scattering treatment, which
is not implemented here.

The gauntlet has not run because its required E2E-pass precondition is unmet;
there is no gauntlet receipt. Docker remains waived by the owner.

## Resume checkpoint, 2026-10-23

The coordinator resumed this lane from clean commit `67d5337a`, confirmed equal
to the origin branch. Initial machine checks reported 87 GiB available and
1-minute load 9.48. The completed ROLO implementation and recorded placement
and parity evidence are retained. Remaining work starts with independent
planetary phase-response and Johnson V calibration, not a refit to the
Mallama–Hilton test oracle. The canonical SDK checkout on this machine is
`spacedatanetwork-stack/repos/ancillary-packages/space-data-module-sdk`; the
sibling path in the repository instructions is absent. Docker remains forbidden.

## Synthetic Jupiter V continuation

`jupiter:heng2021:V` now combines the 24 independent Heng & Li 2021 Table 1
spectral scattering fits at 470-700 nm with Bessell 1990 Table 2's V energy
response and the CALSPEC solar reference spectrum. All 197 solar samples
bracketing that interval retain their FITS row locators and exact unit
conversions. The flux integral uses linear spectral interpolation, split at
every native solar and filter knot. It applies no magnitude offset or phase
normalization fitted to Mallama-Hilton. This model supplies the cited solar
V magnitude -26.75 itself; a caller `solar_magnitude` override is rejected.

The surface quadrature and spectral integration are separate. An independent
analytic sphere solution followed by Simpson spectral integration checks the
combined result to 2e-7 relative albedo (implementation accuracy only).
The full E2E comparison at 1,043 phase samples over 0-130 degrees found a maximum
residual of 0.15324716 mag at 130 degrees, so the required 0.1 mag gate still
fails. The geometric albedo is 0.60557202; the opposition residual is
-0.13424954 mag. Test geometry uses the IAU nominal Jupiter radii to preserve
the equator-on projected area with an equivalent sphere. Detailed ellipsoidal
scattering and seasonal changes are not included. The committed
`conformance/acceptance-report.json` contains the fresh full E2E measurements,
source access results, and exact remaining requirements.

## Coordinator continuation, 2026-10-23

The planetary acceptance authority is Mallama & Hilton (2018), arXiv
1808.01973, Johnson V, including its Saturn and Neptune extensions. No substitute
oracle or additional model is required for acceptance. The earlier explicit
restriction that these equations remain test-only is retained: a self-comparison
against a runtime copy would not measure the independent prediction requested
in the task. The published paper and code are already downloaded and readable;
source access is not the current planetary blocker.

All commands that open a headless browser must run through the coordinator's
`/Users/tj/software/terrain-work/lanes/headless-run` wrapper. The gauntlet uses
`/Users/tj/software/terrain-work/lanes/gauntlet-run`, which holds its own browser
lock. No Chrome, windowed browser, Docker, or Docker Desktop is launched.
