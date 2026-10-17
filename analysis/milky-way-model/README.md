# Milky Way model

A public C++ WASM module using the sibling analysis modules' SDK build, manifest,
SDS PCE parameter contracts, and `dist/isomorphic/module.wasm` layout. One binary
uses real WASI pthreads and shared linear memory. JavaScript only handles SDS
messages, byte views, and E2E IO. The run-four literature model has an explicit
limited production claim in [tests/ORACLES.md](tests/ORACLES.md), with central
and anticenter width gaps tracked separately from renderer integration.
The host must provide at least three worker slots; the E2E provisions four.

Build and run the **one E2E** from this directory:

```sh
export SDM_CHROME_BINARY=/Users/tj/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell
node build.mjs
node tests/band-vs-gaia.e2e.mjs
```

The build requires an already provisioned `deps/emsdk` and WASI threads sysroot
and compiler-rt support understood by the SDK. It never installs dependencies
or accesses the network. The repo-local LLVM driver is passed explicitly to
the SDK's `wasm32-wasip1-threads` lane; browser-only `emcc -pthread` is not used.
Compiler scratch and browser profiles stay in `.build/`. The E2E uses only the
Playwright cached headless shell, an isolated profile, and a loopback server
with COOP/COEP. Sandbox-blocked browser startup remains a failing check while
the same E2E collects numerical evidence using the SDK's Node WASM host.

`--legacy-only` selects the refactor stage within that E2E; `--node-diagnostic`
explicitly repeats the diagnostic lane after a browser failure. Neither bypasses
the browser acceptance failure. SDK manifest/artifact validation is part of the
build and E2E; there is no separate unit-test suite.

## Refactor before new behavior

The original OrbPro `GalaxyFS.glsl` equations, 40-step jittered march, and tone
curve are retained in `src/legacy_model.hpp`, with the source checksum. Its
analytic reference and baked paths are compared at 720 × 360 Galactic pixel
centers. Commit `330b2901377b86ed4fb9a31c9062c17bcbfd42ea` records the isolated
legacy refactor. Its headless-browser E2E passed all 13 checks before the
literature model was linked. Build outputs and oracle caches stay ignored.

The initial uniform global z grid undersampled the shader's 100 pc dust layer:
maximum RGB error 0.3078853. The fixed 32 samples now follow an explicitly
rectilinear signed-square z axis. With the original tolerances unchanged
(maximum 0.08, RMS 0.015, dimensionless tone-mapped RGB), the measured maximum
is 0.0292841 and RMS 0.000739919 over 777,600 channel samples. This tests bake
approximation against the original analytic equations in WASM; it does not
claim bitwise equivalence with GPU floating-point jitter.

## Contract and storage

Use `encodeRequest(methodId, values)` and `decodeResult(payload)` from `codec.js`
with the SDK direct invoke host. Every input and output port is SDS `$PCE`;
the standard's provider-defined parameter descriptors carry units and types.
The SDK transports size-prefixed frames. No local schema is introduced.

All positions use kpc in a static Galactocentric frame: center at the origin,
+x toward Galactic longitude 0, +y toward longitude 90, +z toward the NGP.
The Sun is (-8.178, 0, 0.0208) kpc. All center, solar, and NGP constants live
in `foundation/frames/src/galactic.hpp`; the local header only adapts units.

| Method | Input values | Output values |
| --- | --- | --- |
| `bake_legacy` | none | Original-model global/local volumes |
| `verify_legacy` | none, after legacy bake | Maximum/RMS RGB error and sample count |
| `bake` | none | Literature-model volumes and deterministic detail tile |
| `extinction` | `points`: packed xyz | `a_g`, `e_bp_rp`, magnitudes |
| `sample_stars` | `bounds`: min xyz/max xyz; `seed`, `candidates`, `completeness`, `tier_limit_g`, optional `display_limit_g` | `stars`, `count`, `stride=7`, `label=model`, `pickable=0` |
| `oracle_metrics` | `flux_image`, `density_image`: [arena offset, width, height, 4] | Correlations, widths, Rift ratios, global log-affine display fit and residuals |
| `calibrate` | retired method ID | Explicit error; Gaia dust fitting cannot mutate the literature bake |
| `ridge_metrics` | `masers`: [longitude deg, latitude deg, parallax mas, family]; `maser_segments`, `maser_excluded`, `parallax_errors` (mas); independent `published_arms` Table 2 rows | Curve agreement, per-segment raw RMS and chi-square, propagated perpendicular errors, diagnostic baked-ridge distances |

Global volume: 256 × 256 × 32 over [-16,16] × [-16,16] × [-3,3] kpc.
Local volume: uniform 128³ over the Sun ±1.25 kpc. Each is exactly 16 MiB,
RGBA16F, x fastest, then y, then z. Literature channels are relative G/BP/RP
emissivity per kpc and G extinction optical depth per kpc. They are not absolute
calibrated radiometric units. The 32³ RGBA16F noise tile is dimensionless and
labeled `model`; it is never presented as measured dust.

`*_layout` is [byte offset, byte length, nx, ny, nz, components, bytes/component].
`*_bounds` carries the six physical bounds. `*_z_coordinates` supplies the actual
sample centers: **global z is nonuniform** (`*_z_mapping=1`), local/noise z is
uniform (`0`). Consumers must interpolate between these physical z coordinates,
for example with an uploaded coordinate lookup product, rather than assume
uniform z texture coordinates. x/y are uniform cell centers. The nested sampler
blends local/global values over 0.125 kpc at the local boundary. Samples outside
the global volume contribute zero.

Volume offsets address plugin-owned shared WASM memory, remain valid until the
next bake, and must not be freed by the host. Copy or upload before another
bake. Oracle input pixels are caller-owned `plugin_alloc` buffers retained
through the invoke and freed afterward. Optional `sky_layout` is a plugin-owned
720 × 360 float32 G image, valid until the next oracle evaluation. These arena
descriptors are process-local and are not durable publications.

Statistical-star rows are [x, y, z, absolute G, apparent G, A_G, weight]. Their
six-bin luminosity function is explicitly illustrative. A conservative analytic
density bound and fixed SplitMix64 draws produce deterministic rejection samples;
weights represent relative density × kpc³, not measured star counts. The host
supplies spatial completeness from the delivered catalog selection; WASM applies
the magnitude tier after extinction and multiplies by the missing fraction.
Completeness 1 suppresses only stars inside the delivered magnitude tier.

## Evidence and limits

Code cites Jurić 2008 thin/thick-disc shapes, the Wegg papers for bulge/bar
morphology and length, Reid 2019 Table 2 for seven fitted segments in six arm
families, and Drimmel & Spergel for the dust components. Major arms outside
measured beta ranges are explicitly extrapolated. The Scutum continuation
follows section 3.2.2 through negative unwrapped azimuth to the outer radial
edge, so the far-side OSC segment is not cut off at a principal-angle seam. Reid's fitted radii retain
their original R0=8.15 kpc fit while the observer uses the required 8.178 kpc.
Bulge proxy scales, emissivity ratios, luminosity function, and passband
extinction ratios are model assumptions, clearly separated from published facts.

The saved ESA maps are genuine complete images, so no download was required.
Exact filenames, URLs, hashes, licenses, projection, and test tolerances are in
`tests/oracle-sources.json` and `tests/ORACLES.md`. They are stretched 8-bit
display maps: the fitted log slope/intercept cannot establish absolute Gaia
fluxes or source counts. The final E2E records all residuals and failures in
`dist/calibration-fit.json`. No measured image or catalog data is bundled.

Run four selects the complete Drimmel & Spergel 2001 disk, separate arm dust
and local segment (hypothesis e), with the published COBE/DIRBE normalization
and Reid arm centers. The former Gaia-fitted dust coefficient is removed from
production and retained only in historical native diagnostics. The `calibrate`
method explicitly fails; log-affine display conversion in the oracle statistics
does not change the baked physical model.

The E2E gates flux r >=0.84, density r >=0.75, l=90/270 FWHM errors <=25%,
the Rift dip, exact Reid Table 2 curves, and uncertainty-aware per-arm
chi-square <=2 except the reported 3-kpc arm. It reports all four widths and
all arm statistics. l=0/180 widths remain known gaps assigned to
`milky-way-local-3d-dust-20261017`, whose targets are <=25% and flux r >=0.85.
Raw RMS, finite rendering-segment RMS and all nine named exclusions remain
visible; no extra clipping or uncertainty inflation is applied.

The seventeen fixed native configurations and the requested five-hypothesis
before/after table are historical evidence in [tests/HYPOTHESES.md](tests/HYPOTHESES.md).
The typed volume contract is unchanged and uses released SDS PCE; it does not
require the pending RFM amendment. Renderer/shader consumption, cutoff removal,
console settings and credits remain with the Claude lane.

Edenhofer's optional grid is not accepted because its offline license and SDN
publication are unverified. Retrieval/publication, catalog octree construction,
console settings/credits, and rendering belong to their host/provider modules.
No CID literals, bundled catalogs, or host orchestration are introduced here.
