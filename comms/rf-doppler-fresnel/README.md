# rf-doppler-fresnel

Two scalar RF primitives compiled to a single WASM module:

- **Classical first-order Doppler shift** — Sklar 2e §1.3.2,
  `Δf = (v_r/c) · f_0`. Relativistic correction at LEO velocities is
  O((v/c)²) ≈ 6×10⁻¹⁰ — negligible.
- **n-th Fresnel-zone radius** — ITU-R P.526-15 §3 + Pratt 4e §4.3.5,
  `r_n = √(n·λ·d1·d2/(d1+d2))`.

Phase 4 Wave A of the RF audit migration plan, after rf-fspl. Same SDK
template as rf-fspl: package shape, build pipeline, JS host wrapper
shape, and (importantly) the direct-export fast path that bypasses the
FlatBuffer stream-invoke envelope for `(double, double) -> double`
signatures.

## Layout

```text
rf-doppler-fresnel/
  package.json
  build.js
  manifest.js
  plugin-manifest.json
  index.js
  src/rf_doppler_fresnel_plugin.cpp
  test/
    rf-doppler-fresnel.test.mjs
    fixtures/
      doppler.json          — Sklar §1.3.2 vectors at IEEE-754 precision
      fresnel_p526.json     — ITU-R P.526-15 §3 vectors
```

## Status

**Skeleton complete; build verification + orbpro-integration registration pending** — same gating as rf-fspl.

What's done:

- C++ kernel implementing both primitives with finite-input validation.
- FlatBuffer manifest declaring two methods (`compute_doppler`,
  `compute_fresnel`) with aligned-binary request/response port schemas
  (`orbpro.comms.rf.{Doppler,Fresnel}{Request,Result}`).
- Build script using the Emception sandbox + `protectModuleArtifact`,
  same pattern as analysis/access and comms/rf-fspl.
- JS wrapper using direct `module._rf_doppler_shift_hz` /
  `module._rf_fresnel_zone_radius_m` calls.
- 5 fixture vectors per primitive, plus property-based tests
  (Doppler antisymmetry / linearity, Fresnel √n scaling / d1↔d2 symmetry).

Pending:

1. **Build verification.** `npm run build` → produces
   `dist/rf-doppler-fresnel.wasm` once Emception is set up.
2. **`packages/orbpro-integration` registration.** Mirror the access /
   rf-fspl patterns: shim under `packages/orbpro-integration/rf-doppler-fresnel/`,
   `exports./rf-doppler-fresnel`, `build:rf-doppler-fresnel[:no-encrypt]`
   scripts, `files` entry.
3. **External fixture upgrade.** Phase 2 of the audit replaces the
   closed-form fixture values with externally-sourced (Python `itur`,
   ITU-R P.525/P.526 worked examples, textbook tables) values.
4. **`RfCommsCore.js` delegation.** Once the module ships, the JS
   `dopplerShift` and `fresnelZoneRadius` (lines around 4078) become
   thin proxies via `CommsPlugin`.
