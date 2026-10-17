# Milky Way volume refactor

The first stage moves the existing GalaxyFS equations into C++ WASM, retaining
its analytic reference, 40-step march and tone curve in `src/legacy_model.hpp`.
Galactic constants come from `foundation/frames/src/galactic.hpp`.

The module uses the SDK build and SDS PCE parameters with WASI pthreads and
shared memory. Global storage is 256 x 256 x 32 RGBA16F over +/-16 x +/-16 x
+/-3 kpc; local storage is 128 cubed over the Sun +/-1.25 kpc. Global z centers
are explicitly rectilinear, exported as `global_z_coordinates`; x/y and the
local volume use uniform cell centers. Each volume is 16 MiB, x fastest.

`bake_legacy` returns `global_layout`, `local_layout`, bounds and z coordinates.
Each layout is [byte offset, byte length, nx, ny, nz, components, bytes/component]
in plugin-owned shared memory, valid until the next bake. `verify_legacy`
compares the baked and analytic sky on a 0.5-degree grid. Its unchanged limits
are maximum RGB error 0.08 and RMS 0.015 over 777,600 channel samples.

Build with `node build.mjs`. Set `SDM_CHROME_BINARY` to a Playwright cached
Chromium headless shell, then run `node tests/band-vs-gaia.e2e.mjs --legacy-only`.
Compiler products, test oracles, profiles and evidence stay ignored. The full
literature model and Gaia acceptance are the next stage of this task.
