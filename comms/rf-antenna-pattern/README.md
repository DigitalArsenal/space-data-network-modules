# rf-antenna-pattern

Antenna-pattern gain evaluation kernel. C++/WASM port of the evaluator
in `packages/engine/Source/Scene/AntennaPattern.js` — the JS is the
semantic spec, ported branch-for-branch and coefficient-for-coefficient
(including the Numerical Recipes `besselJ1` rational approximation).
Parity fixtures generated from the JS evaluator are asserted at 1e-12
relative in `test/`.

Repo law: all physics in WASM; JS = parsing/orchestration/rendering.
This module makes gain evaluation available to comms pipelines without
touching the engine (cutover of AntennaPattern.js itself is a separate
pass).

## Surfaces

1. **Analytic families** — `rf_ant_gain` / `rf_ant_gain_db` evaluate
   isotropic, hemispheric, parabolic, gaussian, pencil, dipole, helix,
   dish, ringed, toroidal, cardioid, and teardrop patterns from the
   pattern-type enum plus the seven shape parameters
   (`mainLobeExponent`, `sideLobeLevel`, `sideLobeCount`,
   `backLobeLevel`, `backLobeExponent`, `axialNullExponent`,
   `angularScale`). Unknown types evaluate as RINGED (the JS
   `default:`). `rf_ant_gain_db` returns
   `referenceGainDb + 10·log10(max(gain, 1e-12))`.
2. **Sampled grids** — `rf_ant_load_sampled_pattern(conePtr, coneCount,
   clockPtr, clockCount, gainsPtr, clockWrap, maximumGainDb) → handle`
   copies dense float64 cone×clock dB grids (row-major by cone) out of
   plugin memory; `rf_ant_evaluate_sampled_gain_db(handle, cone,
   clock)` performs the bilinear lookup (cone axis clamps, clock axis
   wraps at 360° when enabled); `rf_ant_evaluate_sampled_gain` returns
   the unit gain relative to `maximumGainDb`; `rf_ant_free_pattern`
   releases the handle. Angles into the evaluators are radians; grid
   axes are degrees. Note: the JS spec ignores `referenceGainDb` for
   sampled patterns — the grid dB is returned as-is.
3. **Geometry bridge** — `rf_ant_compute_cone_clock(ant, boresight, up,
   target, resultPtr, resultSize)` writes the antenna-local
   `(cone, clock)` radians pair: `z = normalize(boresight)`,
   `x = cross(up, z)` (UNIT_X/UNIT_Y helper fallback when `up` is
   parallel to the boresight), `y = cross(z, x)`,
   `cone = acos(clamp(dot(dir, z)))`,
   `clock = atan2(dot(dir, y), dot(dir, x))`.

## Host wrapper

```js
import createRfAntennaPatternPlugin from "space-data-network-plugin-rf-antenna-pattern";

const plugin = await createRfAntennaPatternPlugin();
const g = plugin.gain({ patternType: "dish", sideLobeLevel: 0.2 }, cone, clock);
const gDb = plugin.gainDb({ patternType: "dish", referenceGainDb: 35 }, cone, clock);

const handle = plugin.loadSampledPattern({
  coneAnglesDegrees, clockAnglesDegrees, gainDbValues, clockWrap: true,
});
const sampledDb = plugin.evaluateSampledGainDb(handle, cone, clock);
plugin.freePattern(handle);

const { cone: c, clock: k } = plugin.computeConeClock(antPos, boresight, up, target);
plugin.destroy();
```

## Build / test

```bash
node build.js          # emception build (local EMSDK), ~5 s
node --test test/*.test.mjs
```
