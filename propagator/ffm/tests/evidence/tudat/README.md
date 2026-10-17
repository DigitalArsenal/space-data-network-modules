# Tudat evidence on the neutral FFM export

FFM (Full Force Model) is defined in [the FFM profile](../../../FFM.md).

`summary-tudatpy-1.0.0.json` scores the native trajectories against the shipped
FFM isomorphic WASM at `suite`, `steps30`, and `finest`. Each row also reports
Orekit minus Tudat, the step-halving measurement, and the available native
variational equations. The source is the immutable 72-case export in
`../cases/ffm-reference-cases.json`; its default tolerances apply unchanged.
The 1.5 m GMAT drag allowance does not apply here.

The native model configuration supports **59 trajectories**, with **13 cases
skipped** for unavailable matching force models. It supplies **57 orbit STMs**
and the applicable parameter columns. The two R2 trajectories are retained,
but Tudat does not implement their complete relativistic state partials.

`summary-tudat-wasm.json` scores the committed historical fixture. That fixture
actually has **27 cases**, as does its original xval selection, despite the
28-case count in the task context. Its 45 other export cases are explicitly
skipped. Pins are Tudat 1.0.0.dev4, package commit `1d4718f`, Emscripten 3.1.51,
and the fixture's actual SHA-256. The package Embind API cannot run propagation
(duplicate registrations, station-file initialization, missing STL/Eigen
bindings). The original `tudat_wasm_driver.cpp` ran against the package's WASM
build of the C++ library. This evidence task neither rebuilds nor reruns it.

## Native reproduction

From the repository root, run these commands **serially**. The installed
Python is deliberately invoked with `-I`; no network access is needed.

```sh
/Users/tj/software/tools/xval/mamba/root/envs/tudat/bin/python -I propagator/ffm/tests/evidence/tudat/run-tudat.py
node propagator/ffm/tests/evidence/tudat/score-tudat.mjs --stm propagator/ffm/tests/evidence/tudat/tudatpy-1.0.0-stm.json
node propagator/ffm/tests/evidence/tudat/score-tudat.mjs --wasm --cache propagator/ffm/tests/evidence/tudat/ffm-tudatpy-1.0.0.json
node propagator/ffm/tests/evidence/tudat/check-tudat.mjs
```

The runner pins tudatpy 1.0.0, conda build `py311h2196d89_3`, tudat-resources
2.4, the relocated installed `kernel.so`, package metadata, source files,
DE440, gravity coefficients, and resources. Resume caches reject changed
recipes. Generated resources and native adapters stay in ignored `.work/`.
No installed files or `HOME` are modified. Thread limits are one; there are
no parallel propagation workers.

Python and JavaScript handle transport, configuration, and presentation.
Tudat computes all forces, ephemerides, frame/time conversions, integration,
and variational equations in native C++. `tudat-support.cpp` supplies numeric
adapters for frame bias, parameter units, and the ballistic coefficient law.
The unchanged Nyx `score-metrics.cpp` reduces positions and matrix columns;
FFM propagation uses the unchanged shipped WASM.

## Matching the export

- Integration is fixed RKDP 8(7), 10 s, or 1 s with SRP. Every reported native
  case has a second run at 5 s or 0.5 s. Both sets retain 25 hourly states in
  meters and meters per second; the maximum 3D change must be below 0.3 mm.
- Integration and native Earth rotation use TT. Native SPICE reads the
  exported DE440 kernel at corresponding TDB epochs; 60 s ephemeris tables
  are labeled GCRS, preserving the kernel's ICRF axes.
- `tudat-settings.cpp` exposes the native EOP-file and input-time-scale
  settings omitted from the Python factory. It uses the pinned kernel's
  typed pybind conduit, not a replacement rotation implementation. Native
  Lagrange-8 CIO, short-period EOP, and TDB/TT tables use 60 s spacing, halved
  to 30 s in the finer run; the convergence measurement includes both
  integration and orientation-table refinement.
- Native subdaily EOP corrections remain enabled. FFM uses the exported
  daily EOP rows; Orekit also applies subdaily corrections. This documented
  model difference remains visible in the table.
- Gravity uses exported coefficients, GM, radius, degree/order, and G2's
  separate tesseral-degree cutoff. EME2000 initial states and results use
  the IERS frame bias in the C++ adapter.
- An Earth-centered spherical `EarthOccultor` matches the exported SRP shadow
  radius while the physical Earth retains WGS84 for NRLMSISE altitude. This
  removes the old fixture's ellipsoid-mean-radius occultation discrepancy.
  NRLMSISE uses daily Ap, anomalous oxygen, geodetic latitude, UTC, and the
  exported constant or CSSI observed weather.
- Native Schwarzschild and complete IERS relativistic acceleration are used.
  For R2 the native spin-vector provider uses the current Earth-fixed pole,
  matching FFM; all R2 cases also update Earth rotation for the gravity field.
- Native empirical RSW acceleration supplies in-track thrust. Time-varying
  drag uses `Cd(t) = (b0 + bdot*(t-t0))*mass/area` in C++, where `b=Cd*A/m`.
  C1's rate and in-track columns are included, as well as Cd/Cr and the 6x6
  STM. Native parameter indices are queried rather than inferred from order.
- B1 and C1 retain Tudat's original aerodynamic acceleration inside its
  custom-acceleration interface because the aerodynamic partial factory does
  not accept the custom ballistic parameters. The C++ callback refreshes
  atmospheric flight conditions and acceleration at every perturbed state,
  including repeated evaluations at the same epoch. The C++ settings adapter
  computes the state matrix from that native force using central finite
  differences with 10 m position and 0.01 m/s velocity perturbations,
  matching Tudat's ordinary aerodynamic partial defaults. It passes this
  numerical matrix through Tudat's `custom_analytical_partial` callback
  interface; that API name does not make the matrix analytical. The adapter
  restores the nominal spacecraft, flight conditions, and force caches with
  an RAII guard before any parameter partial is evaluated. This avoids the
  pinned `estimatableParameter.h` implementation of
  `NumericalAccelerationPartialWrtStateCalculator`, which leaves the final
  `vz - 0.01 m/s` perturbation installed. The custom wrapper's acceleration
  remains nominal. The explicit parameter partials are evaluated in C++ as
  `a_drag/b(t)` for `b0` and `(t-t0)*a_drag/b(t)` for `bdot`; the native
  variational solver integrates them. The step-halving result bounds state
  trajectory convergence, not finite-difference derivative error.
- Full IERS frequency-dependent solid gravity tides, the exported FES2004
  model, the precise Knocke 15-degree quadrature, and JB2008 lack matching
  native configurations. Each affected case has a specific skipped reason.
  Tudat does expose basic solid tides and Knocke radiation laws; substituting
  them would not reproduce the specified cases.

## Verification and interpretation

The sole E2E is `check-tudat.mjs`. It verifies existing pinned files, exact
72-case coverage by scored and skipped rows, the exact 59 native trajectories
and 57 supported matrices, unmodified limits, recorded causes for every failed
setting, source/summary parameter coverage, and every stored score via C++.
It then propagates only LEO400 point mass once in the shipped FFM WASM and
checks both native and historical WASM suite scores.
The persisted FFM cache allows all other scores to be recomputed without
rerunning the complete suite. Repository source files and stored evidence are
required. An unavailable historical external or private-resource file is a
reported provenance gap; an existing pinned file with a different hash is a
failure.

R2 trajectories are supported, but native Tudat explicitly rejects their
variational equations because only Schwarzschild partials are implemented.
Those two STM omissions are recorded. The shared protocol specifies no STM
pass threshold, so matrix comparisons are reported as relative column errors
without inventing a tolerance. All differences are computed separately for
position and velocity rows, over the 24 propagated hourly samples.

The installed native cannonball SRP position partial omits the position
gradient of eclipse attenuation. Its acceleration model still includes the
attenuation. Each native SRP matrix comparison records this limitation with
the pinned partial/factory headers and its measured column differences. The
omission matters when a trajectory encounters an eclipse transition; the
whole-arc matrix score alone neither establishes that an individual case
crosses such a transition nor isolates this contribution. State trajectory
convergence therefore does not establish complete SRP variational agreement.
