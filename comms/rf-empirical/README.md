# rf-empirical

Empirical terrestrial path-loss models, three families in one WASM
module:

- **Two-ray ground reflection** (Rappaport 2e §4.6.2 Eq. 4.52). Breakpoint
  at `d_b = 4·h_t·h_r/λ`; FSPL below, `40·log10(d) − 20·log10(h_t·h_r)`
  above.
- **Hata 1980** urban / suburban / rural (IEEE T-VT-29(3) §III, Eqs.
  1–3). Medium/small-city formulation of the mobile-antenna correction
  `a(h_m)`.
- **COST-231 Hata** (COST 231 Final Report 1999 §4.4.3). Hata-style
  extension to 1500–2000 MHz with a +3 dB metropolitan correction.

Phase 4 Wave B of the RF audit, after the rf-fspl and rf-doppler-fresnel
primitives. Five C entry points; one WASM module since they share the
same input plumbing and the link-budget orchestrator picks among them at
runtime.

## Layout

```text
rf-empirical/
  package.json
  build.js                       — Emception → em++ -O3 -std=c++17
  manifest.js                    — FlatBuffer manifest builder
  plugin-manifest.json           — JSON manifest (5 methods)
  index.js                       — JS host wrapper, direct exports
  src/rf_empirical_plugin.cpp    — ~180 lines
  test/
    rf-empirical.test.mjs        — Node native-test-runner harness
    fixtures/
      two_ray_rappaport.json     — 4 vectors at IEEE-754 precision
      hata.json                  — 5 vectors (urban + suburban + rural)
      cost231.json               — 3 vectors (metro + suburban)
```

## Authority

| Model | Reference | Section |
| --- | --- | --- |
| Two-ray ground | Rappaport 2e | §4.6.2 (Eq. 4.52) |
| Hata urban | Hata IEEE T-VT-29 1980 | §III, Eq. 1 |
| Hata suburban | Hata 1980 | Eq. 2 (correction over urban) |
| Hata rural | Hata 1980 | Eq. 3 (correction over urban) |
| COST-231 | COST 231 Final Report 1999 | §4.4.3 (Eq. 4.4.3) |

## Status

**Skeleton complete; build verification + orbpro-integration registration pending** — same gating as other Wave A and B modules.

What's pending:

1. **Build verification** under Emception.
2. **`packages/orbpro-integration` registration** — shim under
   `packages/orbpro-integration/rf-empirical/`, `exports./rf-empirical`,
   build scripts, `files` entry.
3. **External fixture upgrade.** Phase 2 of the audit replaces the
   closed-form fixture values with the values published in Hata 1980,
   Rappaport §4.10 worked Example 4.10 (which gives ≈ 152.56 dB for the
   `900 MHz / 50 m / 2 m / 8 km` urban case — matches our vector to full
   precision), and the COST 231 §4.4.3 worked examples.
4. **`RfCommsCore.js` delegation.** Lines 4314 (`_twoRayGroundLoss`),
   4809 (`_hataUrbanLoss`), 4828 (`_hataSuburbanLoss`), 4839
   (`_hataRuralLoss`), 4850 (`_cost231Loss`) become thin proxies via
   `CommsPlugin` once the module ships.

## Tests

The harness exercises both the fixture vectors (1e-3 dB tolerance) and
property-based relations:

- `Hata suburban = Hata urban − [2·(log10(f/28))² + 5.4]` to 1 nano-dB.
- `COST-231 metropolitan = COST-231 suburban + 3 dB` exactly.
