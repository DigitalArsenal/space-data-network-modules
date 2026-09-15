# Python numerical verification — 2026-09-15

All nine selected numerical tests execute the **distributed C++ WASM artifacts**
through Python ctypes and WasmEdge 0.16.4. They reuse existing module expected
values. `scripts/extract_vectors.mjs` extracts those values from the original
JS/C++ tests and JSON fixtures into `tests/fixtures/module-vectors.json`, recording
each source file's SHA-256. It never imports or runs a module to make goldens.

Numerical fixture generation may calculate analytic curves and norms in test
code; production Python only marshals data and invokes WASM.

| Python test / authority | Frame, epoch/time scale, units | Maximum measured error | Tolerance and rationale |
| --- | --- | --- | --- |
| SGP4: Vallado satellite 5, Tudat `testSpice.cpp` reference | Published TEME position norm vs returned ECEF norm; OMM UTC `2000-06-27T18:50:19.733568`, target UTC-like JD2451726.28495062; m | `3.63960862159729e-6 m` | `0.01 m`; original module's 1cm radius envelope. Rotation preserves norm. This does not test a full TEME/ECEF state transform. |
| HPOP: six Tudat two-body samples | Earth-centred inertial state; JD2451545.0 **TDB**, offsets0..5850s; km/km/s | `1.676726684077683e-4 km`, `1.810651650404945e-7 km/s` | `5e-4 km`, `5e-7 km/s`; existing RK4(30s) state-history envelope accounts for integration and double-JD target rounding. Same point-mass parameters and no perturbations. |
| Estimation: Vallado4e examples7-2..7-4, Gibbs expected velocity | Inertial Cartesian SI; Gibbs is time-independent, supplied middle epoch2451545 is a label; m/s | `9.094947017729282e-13 m/s` | `1e-9 m/s`; existing double-precision component envelope with three-decimal-m input positions. |
| Conjunction: CelesTrak SOCRATES Plus top3, captured2026-03-10 | TCA UTC/JD; scalar miss and speed from SGP4/TEME geometry; s,m,m/s | `0.0007644295692443848 s`, `4.255402527124869 m`, `0.4787075052021805 m/s` | `.010s`, `5m`, `5m/s`; original AMOS-based TCA gate; miss gate accommodates CSV quantization. All3 pairs recovered,0 extras; Pc not gated. |
| Access: Orekit TopocentricFrame inverse6 vectors | Constant ECEF positions, equatorial station at0lat/0lon/0height; JD2460400.5 **TT**,1s span; elevation radians | `4.731326441742567e-12 rad` | `1e-10 rad`; original geometry tolerance allows float subtraction of metre offsets from Earth-radius coordinates. Python checks ACW maximum elevation, not the JS direct-ABI azimuth/range outputs. |
| Events: existing closed-form ellipse/node test | Synthetic Earth-equatorial Cartesian curve, node plane z=0; UTC2026-08-29,0..10800s; OEM km/km/s, event seconds | `0 s` at serialized report precision | `1e-3s`; original threshold sits above10s sampled cubic interpolation/refinement error. All4 nodes at2362.5,5062.5,7762.5,10462.5s. |
| Lambert: existing analytic circular quarter orbit | GCRF, UTC epoch label2026-05-05T00:00:00Z, TOF in SI seconds; km/km/s | `2.322023968427338e-15 km/s` | `1e-6 km/s`; original component tolerance above double-precision solver/analytic rounding. |
| Time: Orekit `TAIScaleTest.testAAS06134` | UTC2004-04-06T07:51:28.386009Z → TAI; no spatial frame; SI seconds | `0 s` | `1e-12s`, exact target string07:52:00.386009; original constant-offset tolerance. |
| Frames: Basilisk `GeodeticConversion.testPCI2PCPF` | Fixed J2000→planet-fixed DCM; unitless integer vector; no epoch dependence | `0` | Exact equality: integer sign/permutation rotation [1,2,3]→[1,3,-2]. |

These tolerances preserve the module tests' expected values and acceptance
bounds. They are conformance examples, not global error guarantees for each
engine. HPOP's TDB convention comes from the current module's explicit input
check; older fixture metadata used an unqualified JD. The analytic events and
Lambert cases are closed-form authorities, not external numerical ephemerides.

## Exact existing fixture sources

- `propagator/sgp4/tests/tudat_wasm_derived.test.mjs`,
  [pinned Tudat testSpice.cpp](https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/src/testSpice.cpp).
- `propagator/hpop/tests/fixtures/tudat.reference.json`,
  [pinned Tudat propagation source](https://github.com/DigitalArsenal/tudat-wasm/blob/c998d24001af69e60f07cc6a29ddf64c422dd9de/tests/wasm/test_propagation_node.cjs#L49-L191).
- `analysis/estimation/tests/native_conformance.cpp`: official Vallado Python
  reference commit `2f3d1600c0f8fd0ebc2f149d8195f06f79d3f579` named upstream.
- `analysis/conjunction-assessment/tests/fixtures/socrates/reference.top3.json`
  and its3 GP JSON files; [SOCRATES source](https://celestrak.org/SOCRATES/).
  Original tolerances: `tests/lib/caParityTolerances.mjs`.
- `analysis/access/test/accessAnalyzer.test.mjs`: named Orekit upstream
  inverse topocentric vectors; original test does not pin an Orekit revision.
- `propagator/events/tests/events.test.mjs`: analytic curve and root formula.
- `analysis/lambert-izzo/tests/sdk-compat.test.mjs`: circular quarter-orbit formula.
- `foundation/time/tests/time_conversion.test.mjs`: named Orekit upstream case;
  original test does not pin an Orekit revision.
- `foundation/frames/tests/frame_transform.test.mjs`: named Basilisk upstream
  `src/architecture/utilities/tests/test_geodeticConversion.cpp` case.

See [verification.md](verification.md) for commands, artifact hashes, packaging,
three-runtime results and remaining build failures.
