# Milky Way model

A public C++ WASM module using the sibling analysis modules' SDK build, manifest,
SDS PCE parameter contracts, and `dist/isomorphic/module.wasm` layout. One binary
uses real WASI pthreads and shared linear memory. JavaScript only handles SDS
messages, byte views, and E2E IO. The run-five literature model has an explicit
production claim in [tests/ORACLES.md](tests/ORACLES.md); the l=0, l=90 and
l=180 widths are reported gaps assigned to milky-way-vertical-structure-20261018.
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
| `load_dust_map` | port `rows`: 1-64 `$PCE` rows of data-source/dust-map-3d (one z plane each) | planes loaded, ready |
| `bake` | none (uses a fully loaded dust map) | Literature-model volumes, detail tile, `extinction_ratios`, `radiance_scale*`, `display_asinh`, `display_counts_per_unit`, `display_band_weights`, `display_nanomaggies_per_count`, `dust_map` |
| `face_on_columns` | `points` (x, y kpc pairs) | The model's own face-on r, g, i light (no baked volume), the reference the renderer's frames are measured against |
| `arm_curves` | none | Each Reid 2019 Table 2 segment as a polyline (kpc): `arm_<i>_measured_xy` over its measured coverage, `arm_<i>_extended_xy` over the arm the light follows |
| `face_on_metrics` | none, after bake | Face-on 48 kpc r/g/i image layout, arm/interarm contrast, bar A2, lane g-i |
| `extinction` | `points`: packed xyz | `a_g`, `e_bp_rp`, magnitudes |
| `sample_stars` | `bounds`: min xyz/max xyz; `seed`, `candidates`, `completeness`, `tier_limit_g`, optional `display_limit_g` | `stars`, `count`, `stride=7`, `label=model`, `pickable=0` |
| `oracle_metrics` | `flux_image`, `density_image`: [arena offset, width, height, 4] | Correlations, widths, Rift ratios, global log-affine display fit and residuals |
| `calibrate` | retired method ID | Explicit error; Gaia dust fitting cannot mutate the literature bake |
| `ridge_metrics` | `masers`: [longitude deg, latitude deg, parallax mas, family]; `maser_segments`, `maser_excluded`, `parallax_errors` (mas); independent `published_arms` Table 2 rows | Curve agreement, per-segment raw RMS and chi-square, propagated perpendicular errors, diagnostic baked-ridge distances |

Global volume: 384 × 384 × 48 over [-24,24] × [-24,24] × [-6,6] kpc (125 pc
in x and y), its large-scale dust only; the light tapers to zero inside it,
by 23.5 kpc in R and 5.6 kpc in z. Slab (0.4.1): 512 × 512 × 12 over the thin
disc, [-16,16] × [-16,16] × [-0.48,0.48] kpc (62.5 pc, signed-square z),
replacing the global volume inside it with a blend at its edges. Local
volume: uniform 128³ over the Sun ±1.25 kpc (20 pc), with the delivered 3D
dust map. All are RGBA16F, x fastest, then y, then z. Literature channels are relative SDSS r/g/i
emissivity per kpc and G extinction optical depth per kpc. Each band's optical
depth is `extinction_ratios` [A_r/A_G, A_g/A_G, A_i/A_G] times G (Wang & Chen
2019). A band unit is the light of one G unit at zero color term, so all three
share `radiance_scale_mag_arcsec2` (AB).
One G unit (emissivity per kpc times kpc) is `radiance_scale` zero-magnitude
(Vega G) fluxes per arcsec², also given as `radiance_scale_mag_arcsec2` (22.12)
and `radiance_scale_lsun_v_pc2` (42.7): the model's local mid-plane emissivity
carries Flynn et al. 2006's 0.056 Lsun,V pc⁻³. The 32³ RGBA16F noise tile is dimensionless and
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

Every parameter is cited in code; none is fitted to the Gaia oracle maps.
Discs: Jurić 2008 shapes for radial lengths, Flynn et al. 2006 luminosity
densities and columns for the light's vertical structure (thin 206 pc, bright
young stars 103 pc, thick 1.1 kpc), with the Robin et al. 2003 thin-disc hole.
Arms: the Drimmel & Spergel 2001 stellar wave (B_K = 1.28, the disc light's
vertical profile, per Elmegreen et al. 2011's color-independent contrasts) and
Flynn's bright young stars on Reid 2019 Table 2 arms with the PHANGS
(Querejeta et al. 2024) interarm floor, both drifted by DS2001's shear. Beyond
each segment's measured coverage the major arms continue at the mean 12° pitch
(Vallée 2017), fading over their last 70°; Scutum keeps its own pitch out past
the far side (Reid 2019 §3.2.2). HII regions: a seeded statistical population
on the arms (count, sizes and brightness are model choices at the scale of the
WISE catalog's giant complexes, Anderson et al. 2014). Disc edge: Minniti et
al. 2011's 13.9 kpc, beyond it a steeper exponential (type II break, Pohlen &
Trujillo 2006). Colors: the old disc redder than the Sun, red-clump bulge and
bar (Ruiz-Dern et al. 2018), B-star arm light, emission-line HII, each
converted from its BP-RP to SDSS g, r, i by Riello et al. 2021 Table C.2.
Display (0.4.0): the SDSS ImgCutout JPEG transfer, Lupton et al. 2004's asinh
stretch on band-weighted SDSS counts and a gamma, its parameters fitted to the
SkyServer JPEGs of six Licquia et al. 2015 Milky Way analogs from their DR17
frames (`display_asinh`, `display_band_weights`). Bar and bulge: Wegg &
Gerhard 2013 orientation, Wegg et al. 2015 length, the b/p bulge's axis ratio
and scale height from Bland-Hawthorn & Gerhard 2016, their sum set by Portail
et al. 2017's bar/bulge to inner-disc mass ratio (1.88/1.29); the nuclear
stellar disc (BHG16; Launhardt et al. 2002) at 1.4/18.8 of that light. The old
light's spiral wave has DS2001's own stellar arm width (143 pc/kpc). Half the
young light is drawn as star complexes on the young arms (Gies 1987: ~70 % of
O stars in clusters and associations; Efremov 1995: complexes ~600 pc), their
luminosities dN/dL ~ L^-2 (Kennicutt, Edgar & Hodge 1989); a seeded
statistical population, its total the smooth model's. Appearance (stellar_populations.hpp,
`appearance`): the young light's scale length, the central light and the
bulge's extent and height stay at their published values; a fit of them to
SDSS MW analogs (Licquia 2015; four trained, two held out) was evaluated and
rejected (it did not generalize; tests/appearance-fit-20261022.json). `bake`
takes `appearance_*` overrides (the fit's trials).
Dust: Drimmel & Spergel 2001 (its arm dust on the same arms), replaced within
1.248 kpc by the Edenhofer et al. 2024 map when loaded (local volume only). Reid's fitted radii keep their R0=8.15 kpc fit while the
observer uses 8.178 kpc. Bulge/bar shapes, the arm extensions, the HII
population, population colors and the luminosity function remain illustrative
and are labeled so.

The E2E (`tests/band-vs-gaia.e2e.mjs`) runs data-source/dust-map-3d's retrieval
stages against an offline copy of the published byte ranges
(`../../data-source/dust-map-3d/.source-cache/`, gitignored; a missing cache is
a blocked result with the fetch URL), loads the rows, bakes, and gates the
run-five claim in [tests/ORACLES.md](tests/ORACLES.md): face-on arm/interarm
>= 1.5, bar A2 >= 0.25, reddened lanes, flux r >= 0.85, density r >= 0.75,
l=270 width, the Rift, dust resampling within 2%, exact Reid Table 2 curves and
per-arm chi-square <= 2 (3-kpc arm reported). l=0, l=90 (a run-four pass, now
38%) and l=180 widths are reported. Evidence images: `.build/model-vs-flux.png`
and `.build/face-on-48kpc.png`; residuals in `dist/calibration-fit.json`.

The ESA maps are stretched 8-bit display maps: the fitted log slope/intercept
cannot establish absolute Gaia fluxes or source counts. The `calibrate` method
explicitly fails. Run histories are in [tests/HYPOTHESES.md](tests/HYPOTHESES.md)
and [tests/PHYSICS.md](tests/PHYSICS.md). Renderer/shader consumption of the new
fields and the dust rows, console settings and credits belong to the OrbPro lane.
No CID literals, bundled catalogs, or host orchestration are introduced here.
