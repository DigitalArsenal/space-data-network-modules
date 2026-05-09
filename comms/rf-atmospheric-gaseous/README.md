# rf-atmospheric-gaseous

Gaseous atmospheric absorption — oxygen + water vapor — exposed as
scalar primitives.

> **AUDIT NOTE.** This module ports the existing simplified single-line
> approximations from `RfCommsCore.js` verbatim. The forms are NOT
> ITU-R P.676-13 Annex 2 conformant — they are ad-hoc Lorentzian fits
> centered on the dominant 60 GHz O₂ line and 22 GHz H₂O line. The port
> is deliberately faithful so behavior is preserved during the WASM
> migration; **Phase 2 of the RF audit characterizes their deviation
> from proper P.676-13 reference values across the
> (frequency, temperature, humidity) operating envelope** and decides
> whether to (a) annotate `valid_range` and ship as-is or (b) replace
> with full P.676 Annex 2.

Phase 4 Wave B of the RF audit, after rf-empirical. Four C entry points
in one WASM module; the saturation-vapor primitive is also used by
`rf-rain` and `rf-cloud-fog` at the host orchestration layer.

## Authority and exact forms

| Primitive | Authority | Form |
| --- | --- | --- |
| Oxygen specific attenuation | RfCommsCore.js port — origin unknown | `γ_O = (7.2·f²/(f² + 0.34))·(300/T_K)³·1e-3` dB/km, valid `f < 57 GHz` |
| Water-vapor specific attenuation | RfCommsCore.js port — origin unknown | `γ_H = 0.05·e_v·(300/T_K)^2.5·(3 / ((f − 22.235)² + 9))` dB/km, valid `f > 1 GHz` |
| Saturation vapor pressure | WMO No. 8 (CIMO Guide) 8th ed., Annex 4.A.1 (Alduchov & Eskridge 1996) | `e_s = 6.1121·exp((17.502·T_C)/(240.97 + T_C))` hPa |
| Total atmospheric absorption | sum of the above × path | `(γ_O + γ_H) · path_km` dB |

## Layout

```text
rf-atmospheric-gaseous/
  package.json
  build.js
  manifest.js
  plugin-manifest.json
  index.js
  src/rf_atmospheric_gaseous_plugin.cpp
```

## Status

**Skeleton complete; build, fixtures + harness, integration registration pending.**

What's pending:

1. **Build verification** under Emception.
2. **Test harness + fixture vectors.** The Phase 2 deliverable produces
   ITU-R P.676-13 Annex 1 reference values at canonical
   (frequency, temperature, humidity) cells. Those values become the
   external fixture against which this simplified model is graded;
   the deviation map drives the `valid_range` decision above.
3. **`packages/orbpro-integration` registration.** Same shape as the
   other comms modules: shim, `exports./rf-atmospheric-gaseous`, build
   scripts, `files` entry.
4. **`RfCommsCore.js` delegation.** Lines 4872–4909
   (`_atmosphericAbsorption`) become a thin proxy via `CommsPlugin`
   once the module ships.

## Reuse

Saturation vapor pressure (`rf_saturation_vapor_pressure_hpa`) is
exposed as a top-level primitive specifically because both the rain
and cloud modules need it. The link-budget orchestrator at the JS
host level can also call it directly without instantiating the rain
or cloud modules first.
