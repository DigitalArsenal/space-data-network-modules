# Basilisk 2.12.0 on the neutral HPOP export

This evidence uses the installed AVS Lab **Basilisk 2.12.0** wheel (ISC)
as an independent test oracle. It reads the immutable 72-case neutral export
in `../cases/hpop-reference-cases.json`. HPOP is the unchanged shipped
`dist/isomorphic/module.wasm`, at `suite`, `steps30`, and `finest`.
Orekit-minus-Basilisk is reported beside each comparison. All default
protocol tolerances remain unchanged; the GMAT drag allowance does not apply.

## Reproduce offline

From the repository root, run these commands **serially**:

```sh
/Users/tj/software/tools/xval/bsk-venv/bin/python -I propagator/hpop/tests/evidence/basilisk/run-basilisk.py --step 8
/Users/tj/software/tools/xval/bsk-venv/bin/python -I propagator/hpop/tests/evidence/basilisk/run-basilisk.py --step 8 --only srp-drag --variant wgs84 --out propagator/hpop/tests/evidence/basilisk/basilisk-wgs84-diagnostic.json
/Users/tj/software/tools/xval/bsk-venv/bin/python -I propagator/hpop/tests/evidence/basilisk/run-basilisk.py --step 8 --only srp-drag --variant wgs84-gtd7d --out propagator/hpop/tests/evidence/basilisk/basilisk-wgs84-gtd7d-diagnostic.json
/Users/tj/software/tools/xval/bsk-venv/bin/python -I propagator/hpop/tests/evidence/basilisk/investigate-basilisk.py propagator/hpop/tests/evidence/basilisk/model-probes.json
/Users/tj/software/tools/xval/bsk-venv/bin/python -I propagator/hpop/tests/evidence/basilisk/diagnose-lst.py --trajectories propagator/hpop/tests/evidence/basilisk/basilisk-wgs84-gtd7d-diagnostic.json
UV_THREADPOOL_SIZE=1 node --single-threaded --wasm-num-compilation-tasks=1 propagator/hpop/tests/evidence/basilisk/score-basilisk.mjs --cached-only --cache propagator/hpop/tests/evidence/tudat/hpop-tudatpy-1.0.0.json --diagnostics propagator/hpop/tests/evidence/basilisk/basilisk-wgs84-diagnostic.json --diagnostics propagator/hpop/tests/evidence/basilisk/basilisk-wgs84-gtd7d-diagnostic.json --causes propagator/hpop/tests/evidence/basilisk/diagnoses.json
UV_THREADPOOL_SIZE=1 node --single-threaded --wasm-num-compilation-tasks=1 propagator/hpop/tests/evidence/basilisk/check-basilisk.mjs
```

The Python runner permits `--xval` to locate the installed user-space tools.
`--only`, `--step`, `--out`, and `--variant` are diagnostic options. It lowers
priority, limits numerical libraries to one thread, and starts one simulation
at a time. Generated gravity CSV files and resumable trajectories live in
ignored `.work/`. Cache identity includes the export, runner/backend, installed
shared libraries, package metadata, kernels, and gravity coefficient sources.
Changed input bytes invalidate cached runs.

`score-basilisk.mjs` reuses the existing Tudat lane's shipped-HPOP state cache
only after authenticating every propagation input. The retained subset is
`hpop-basilisk-2.12.0.json`. Without `--cached-only`, missing HPOP states are
computed serially through the browser module harness. The summary records
the reuse provenance. No stored Tudat trajectories supply Basilisk states.

## Dynamics and frame contract

* Each case starts from the exported GCRF Cartesian state and UTC epoch.
  Dynamics use elapsed TT seconds. Basilisk `SpiceInterface` reads geometric
  Earth-centred Sun/Moon states from the export's SHA-256-authenticated
  **DE440** kernel in J2000/ICRF axes. DE430 is never loaded. The native
  interface epoch is updated using ERFA's geocentric TT-to-TDB correction.
* The runner writes normalized coefficients in the same JPL CSV layout as
  `GGM03S.txt`, with the exact exported GM and radius. Coefficients come from
  the authenticated EGM2008/EGM96 source files identified by the export.
  Excluded orders are zeroed; G2 separately zeroes nonzonal degrees above 24.
  Basilisk's native spherical-harmonic model loads the resulting triangular
  file. The installed GGM03S coefficients are never substituted.
* The unchanged chain in `../erfa-spice/reference.py` supplies GCRF-to-ITRF:
  split UTC/TAI/TT dates, daily EOP interpolation in TAI, ERFA `xy06`, `s06`,
  `c2ixys` with exported dX/dY, `era00`, `pom00`, and `c2tcio`.
  No SPICE PCK Earth rotation or subdaily EOP correction is substituted.
  A bounded in-process cache reuses exact ERFA matrices at identical epochs
  and EOP rows across cases; it does not interpolate the rotations.
* A public `SpicePlanetStateMsg` carries that rotation at the midpoint of
  each integration interval, with zero rotation derivative. It remains an
  orthogonal matrix throughout the interval. This avoids Basilisk's native
  linear matrix extrapolation, which is not orthogonal and can alter even
  monopole acceleration. It is a second-order environment coupling; its
  error is included in every step-halving result.
* Native `Spacecraft` and `svIntegratorRKF78` own integration and force
  evaluation. The committed run's maximum interval starts at 8 s and is halved until a
  second run changes all hourly positions by less than **0.3 mm**. Relative
  tolerance is `1e-14`; absolute tolerance is `1e-12`. Both trajectories and
  all attempted refinement measurements are retained. No new HPOP build,
  JavaScript physics, or replacement Basilisk force model is used.
* Native cannonball `RadiationPressure` uses the exported Cr, area/mass and
  pressure convention. A fixed analytic conversion accounts for the native
  AU/irradiance constants; it is derived from the constants, not fitted to
  trajectories. Native `Eclipse` uses its conical shadow model and the
  exported Earth shadow radius through `rEqCustom`. Its solar radius remains
  the native constant and is reported in the trajectory diagnostics.
* Native `MsisAtmosphere` receives the exported UTC epoch, all 23 weather
  messages, daily Ap, F10.7 and averaged F10.7. CSSI uses observed previous-day
  F10.7 and current-day centred-81-day F10.7/daily Ap. `DragDynamicEffector`
  receives atmosphere co-rotation through the 2.12.0 `WindMsg.v_air_N` input.
  Its spherical altitude/latitude convention is retained in the nominal
  run and measured against WGS84. The diagnostic `wgs84` variant changes only
  atmosphere position messages so native MSIS receives WGS84 height and
  geodetic latitude. Only the atmosphere-coordinate message is transformed;
  gravity continues to use each run's physical integrated spacecraft state.
  The separate `wgs84-gtd7d` diagnostic also includes anomalous oxygen below
  500 km, using the installed wheel's native `gtd7d` entry point to supply the
  density message to native drag. This isolates the wrapper's altitude-based
  `gtd7`/`gtd7d` selection; it introduces no HPOP atmosphere implementation.
  Both diagnostics retain Basilisk's unwrapped local solar time convention.
  HPOP wraps it into 0–24 hours. The native NRLMSISE implementation's rounded
  hour-to-radian constant makes those inputs slightly nonequivalent;
  `diagnose-lst.py` measures the instantaneous density effect separately.
  B1's exported ballistic rate is supplied by updating the native drag
  coefficient as `Cd(t) = Cd0 + mass/area * bdot * t`, where `b = Cd*A/m`.
  The update cadence is included in the convergence measurement.
* Eclipse and atmosphere messages use a central-force Taylor prediction of
  the midpoint spacecraft state; native force evaluation uses the integrated
  state. The prediction and sample/hold error are included in step-halving.
  This adapter is confined to the oracle. Python handles its configuration
  and native-library transport; all HPOP propagation and score arithmetic
  remain in WASM and the unchanged Nyx `score-metrics.cpp`.

The retained `hourlyNativeDensityKgM3` and `hourlyShadowFactor` diagnostics
are the last environment-message values before each hourly spacecraft sample:
the preceding interval's midpoint, except at the initial epoch. The actual
trajectory positions and velocities are sampled at the exact hourly epochs.

The installed wheel's ABI and behavior differ from the available older
Basilisk source checkout. This evidence uses the wheel's public bindings and
does not compile against that checkout's incompatible C++ headers. Package
build metadata, Python version, installed shared libraries, ERFA library,
support-data hashes and exported kernel hashes are pinned in the records.

## Coverage and interpretation

The runner selects **50 state trajectories** and explicitly skips **22 cases**:
relativity, matching IERS solid/FES2004 ocean tides, Knocke radiation, JB2008,
continuous in-track thrust, EME2000 cases, and
cases requiring variational equations. Each omitted case carries its reasons.
All scored rows separately record that Basilisk has no native STM/parameter
sensitivity integration. A supported force is not silently omitted.

The numerical source is the independently propagated Basilisk trajectory;
units are metres and metres/second, frame GCRF, and epochs are the export's
UTC epochs over 24 hours. Scores exclude the common initial state and compare
the 24 propagated hourly samples. The unchanged thresholds are 1 mm for point
mass, 5 cm for gravity, and 0.1 m for SRP/drag. A failed threshold must carry a
measured model-setting mismatch, Basilisk defect, or HPOP defect diagnosis.
Convergence establishes numerical stability of this oracle configuration; it
does not establish force-model equivalence.

The nominal result is **43 passing state cases and 7 diagnosed drag misses**
at each of the three HPOP settings. All 50 native trajectories meet the
step-halving requirement; the largest change is 0.284212 mm. The seven drag
cases retain Basilisk's native spherical atmosphere coordinates and native
MSIS species selection. Their diagnostic comparisons are reported separately,
so correcting an oracle input does not silently replace the nominal result.

The measured drag comparison below uses the **finest HPOP** setting. Each
entry is maximum hourly 3D position separation over 24 hours, in metres; the
unchanged drag limit is **0.1 m**. All seven WGS84-plus-gtd7d diagnostics also
pass `suite` and `steps30`.

| Case | Nominal native | WGS84 only | WGS84 + native gtd7d |
|---|---:|---:|---:|
| LEO400 Z3 | 5250.645899 | 2.297685 | 0.043398 |
| LEO400 F6 | 5248.315424 | 2.299328 | 0.043530 |
| LEO400 B1 | 5418.767018 | 2.373368 | 0.044082 |
| LEO400 W1 | 4094.031312 | 1.541377 | 0.034730 |
| SSO700 Z3 | 58.143609 | 0.000283 | 0.000283 |
| SSO700 F6 | 58.128197 | 0.000311 | 0.000311 |
| SSO700 W1 | 34.811360 | 0.000042 | 0.000042 |

Direct native trajectory comparisons isolate the coordinate effect at
34.811–5421.140 m and the below-500-km anomalous-oxygen effect at
1.576–2.417 m. The three SSO trajectories are bit-identical between the two
diagnostic variants. `diagnoses.json` records each measured cause, direct
comparison, epoch, frame, tolerance and convergence result. The E2E rechecks
these direct trajectory comparisons with the shared C++ reducer.

The separate 350-state native LST probe measures a maximum relative density
difference of 0.000013015226 when wrapping local solar time. This is
instantaneous density evidence; it does not isolate a propagated position
contribution and is not used to explain away any failed limit. The remaining
LEO diagnostic residuals are 3.47–4.41 cm, below the original 0.1 m limit.

## The one E2E

`check-basilisk.mjs` is the sole E2E for this change. It authenticates existing
pinned files, requires repository sources and stored trajectories, verifies
exactly one disposition for every exported case, and checks unchanged limits,
all step-halving histories, and recorded causes for every failed setting.
It recomputes all stored HPOP/Orekit/convergence reductions using the shared
Nyx C++ helper, then runs **one** cheap LEO400 point-mass trajectory through the
shipped HPOP WASM and demands an exact re-score. Missing external/package or
generated scratch files are reported as provenance gaps; an existing file
with a wrong hash fails. No unit tests or broad test gauntlet are added.
