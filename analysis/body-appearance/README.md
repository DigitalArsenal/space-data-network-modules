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

## Environment observations

At initialization on 2026-10-22, the shared reference collection
`/Users/tj/software/terrain-work/moon-look/references.md` was absent. Creating
the required source-download and gauntlet-log directory
`/Users/tj/software/terrain-work/body-look/codex-appearance` was denied by the
sandbox (`Operation not permitted`). The requested writable scratch location
must be available before downloads are persisted there.

The Sato DOI resolver was reachable but redirected to a Wiley Cloudflare
challenge (HTTP 403). This is a publisher access failure, not proof that shell
network access is blocked; an author-hosted primary copy may resolve it.

The required initial checkpoint was attempted, but `git add` and `git commit`
both failed because the sandbox denied creation of the worktree's `index.lock`
under the stack's `.git/modules/repos/space-data-network-modules/` directory.
The push created remote branch `task/body-appearance-module-20261022` at the
unchanged base `9d4535d7c7cedad33f88c8f744b46d4c24c4f0a0`; Git could not update
local tracking configuration or refs. This README remains untracked, and the
remote branch contains no implementation from this lane. Further code changes
are paused until the mandatory commit checkpoints can be made.

No acceptance test, build, or gauntlet has run. There is no gauntlet receipt.
The test-only oracle papers/code and all other listed primary sources still
need to be read; no numerical table values have been claimed or implemented.
