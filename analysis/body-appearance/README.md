# Body appearance

Work in progress for `body-appearance-module-20261022`. This package is not a
validated appearance model and does not yet publish a WASM artifact.

## Contract and boundaries

The planned authoritative implementation is C++, compiled with the module SDK
and repo-local Emscripten to `dist/isomorphic/module.wasm`. The same bytes must
run in Node, a headless browser, and WasmEdge. Runtime photometry, surface
statistics, deterministic placement, and solar rotation belong in that module.
JavaScript may encode typed SDS requests and perform independent tests.

The SDK supplies `plugin_invoke_stream` and the embedded manifest accessors.
Module methods will use canonical SDS types; an unratified schema alias or JSON
payload will not be substituted for a typed port. The candidate unique module
identifier is `com.digitalarsenal.body-appearance`.

Mallama & Hilton (2018), DOI `10.1016/j.ascom.2018.08.002`, is an independent
oracle. Its equations and published code belong only under `tests/`, never in
the compiled source or a shipped JavaScript entry point. Runtime magnitudes
must be obtained from independently sourced photometric parameters. No value
will be populated solely from memory or a secondary summary.

## Required evidence

| Acceptance | Required measurement | Current status |
| --- | --- | --- |
| Every table value cited | DOI and table/figure or equation locator, with units and model convention | Pending primary-source verification |
| Placement size-frequency law | KS p > 0.05 with 100,000 samples | Not measured |
| Cumulative fractional area | Relative error <= 5% | Not measured |
| Three-runtime parity | Same artifact and identical placement outputs | Not measured |
| Moon photometry | Maximum residual <= 0.1 mag against ROLO over its documented domain | Not measured |
| Mercury through Neptune, excluding Earth | Maximum residual <= 0.1 mag against Mallama & Hilton across each observed phase range | Not measured |

The end-to-end entry point required by the task is
`node analysis/body-appearance/tests/body-appearance.e2e.mjs`. It will fail if
mandatory source evidence, runtime checks, or acceptance measurements are
missing. A scaffold or skipped test is not acceptance.

## Primary-source checklist

- Sato et al. (2014), `10.1002/2013JE004580`: lunar Hapke maps.
- Mallama & Hilton (2018), `10.1016/j.ascom.2018.08.002`: test-only planet oracle
  and its published code.
- Kieffer & Stone (2005), AJ 129:2887: ROLO spectral irradiance model,
  coefficients, and geometry conventions.
- Bandfield et al. (2011), `10.1029/2011JE003866`: Diviner rock abundance.
- Golombek & Rapp (1997), JGR: cumulative fractional rock area law.
- Rosenburg et al. (2011), `10.1029/2010JE003716`: LOLA roughness.
- Neukum et al. (2001): crater production function and validity limits.
- Li et al. (2015), Asteroids IV, "Asteroid photometry": taxonomic priors.
- Muinonen et al. (2010), Icarus: H,G1,G2 basis functions and conventions.
- Snodgrass & Ulrich (1990), ApJ 351:309: surface differential rotation.

## Resume checkpoint (2026-10-22 17:26 UTC)

The worktree is clean at the start of the resumed lane, and origin contains
both prior checkpoints (`701ece4c`, `968ee9dc`). Filesystem access is restored.
The existing paper downloads and parameter table are preserved. Li et al.
Table 6 and Snodgrass–Ulrich Table 1 have been rechecked against the primary
paper text. The saved ROLO `paper.pdf` is HTML, not a usable paper.

The SDK contract was read from the shared stack's
`repos/ancillary-packages/space-data-module-sdk/AGENTS.md` and its isomorphic
artifact documentation. The canonical SDS PCE schema provides typed,
provider-defined scalar/vector parameters; the existing milky-way module
is the local pattern. No local schema alias or JSON wire format is needed.

Docker and Docker Desktop must never be started. The owner waived Docker
WasmEdge parity on 2026-10-22; the browser and native WasmEdge checks remain
required. No build, acceptance measurement, or gauntlet PASS is claimed yet.
