# Orekit And Basilisk SDN Module Gap Analysis

This document cross-references Orekit and Basilisk functionality against the
current `space-data-network-modules` package set. It is a planning artifact for
building a comprehensive C++ SDN module suite, not a completion claim.

## Evidence Snapshot

- Orekit overview inspected: <https://www.orekit.org/overview.html>, last
  modified 2025-09-14 on the published page. The overview identifies Orekit as
  a low-level flight dynamics library and lists feature groups for time,
  geometry, spacecraft state, covariance, maneuvers, propagation, attitude,
  orbit determination, GNSS, orbit file handling, Earth models, indirect optimal
  control, collisions, and data loading.
- Orekit source inspected from `https://gitlab.orekit.org/orekit/orekit.git`,
  branch `main`, commit `7b39f84999bca5b51b11f216befd6555116f8f52`.
- Orekit source surface at that commit: 19 top-level Java packages, 2,134 Java
  source files under `src/main/java/org/orekit`, and 1,042 `*Test.java` files
  under `src/test/java/org/orekit`. The checked generated inventory is
  `docs/orekit-source-test-index.json`.
- Basilisk source inspected from the local stack checkout at
  `repos/ancillary-packages/basilisk`. Local evidence includes the existing
  Basilisk WASM plan, `docs/basilisk-module-plan.json`, and source families
  under `src/architecture`, `src/simulation`, and `src/fswAlgorithms`.
- Basilisk source surface in the local checkout: architecture has 194 C/C++
  files and 13 upstream unit-test Python files, simulation has 260 C/C++ files
  and 118 upstream unit-test Python files, FSW algorithms have 204 C/C++ files
  and 114 upstream unit-test Python files, and templates have 4 C/C++ files and
  3 upstream unit-test Python files. The checked generated inventory is
  `docs/basilisk-source-test-index.json`.
- The Basilisk Python unit-test port index is
  `docs/basilisk-unit-test-port-index.json`. It covers 229 upstream
  `_UnitTest/test_*.py` files and classifies each as mapped to an SDN target,
  requiring a module-plan addition, deferred, or excluded. The current checked
  counts are 216 mapped, 0 requiring a module-plan addition, 7 excluded, and 6
  deferred. It is enforced by `npm run check:basilisk-unit-test-ports`.
- Current SDN module surface inspected from plugin manifests: the generated
  current-worktree index records 39 manifest-bearing module packages. All 39
  have `dist/isomorphic/module.wasm`. No parity-scope module currently appears
  in the missing-C++ or browser/WasmEdge target-gap lists; the checked generated
  inventory is `docs/current-module-parity-index.json`.
- The initial inter-module import descriptor inventory is
  `docs/module-import-descriptors.json`. It records the verified SGP4-to-HPOP
  aligned-binary `PropagatorState` (`PRST`) handoff and is enforced by
  `npm run check:module-imports`, including fail-closed checks for missing
  provider modules, schema mismatches, file-identifier mismatches, and
  incompatible provider versions.
- The selected source-library numeric test-vector extraction index is
  `docs/test-vector-extraction-index.json`. It currently maps 63 selected
  Orekit source test/vector cases and 38 selected Basilisk source test/vector
  cases across C/C++ and Python utility checks to existing SDN module test
  files, and is enforced by
  `npm run check:test-vectors`.
- The SDS schema audit is `docs/sds-schema-audit.json`. It covers the required
  time, frames, orbit state, attitude state, Earth environment, observations,
  GNSS products, image products, actuator commands, power, thermal, and runtime
  telemetry domains, validates referenced SDS schemas, and is enforced by
  `npm run check:sds-schema-audit`.

## Non-Negotiable Module Rules

- New and updated modules must be C++ modules that satisfy the
  `space-data-module-sdk` contract.
- Every package must publish the primary artifact at
  `dist/isomorphic/module.wasm` and load unchanged in browser and WasmEdge
  harnesses unless an explicitly documented SDK exception exists.
- Runtime exchange between modules must use `PIV` invoke envelopes, `TAB`
  payload frames, and SDS FlatBuffers. Do not add JSON or base64 as the module
  data plane.
- Inter-module calls must be represented in
  `docs/module-import-descriptors.json` so provider/consumer methods, ports,
  FlatBuffer type metadata, fixture coverage, and provider version ranges are
  checked before runtime composition.
- Inter-module dependencies must be represented as imports of existing SDN
  modules, not as duplicated local implementations. Examples: OD and
  conjunction modules import `propagator/sgp4`; HPOP and DSST import shared
  time, frames, Earth environment, and force-model modules.
- Canonical FlatBuffer schemas must be added in SDS first. Repo-local `.fbs`
  files are migration debt unless they are a temporary fixture for a checked
  task and have an SDS promotion step. The first foundation dependency now has
  a canonical time-conversion surface in SDS `TIM`: `TIMInstant`,
  `TIMConversionRequest`, and `TIMConversionResult`.
- A module is not complete until it has authoritative numeric tests copied or
  independently derived from Orekit test vectors, Basilisk upstream unit tests,
  published standards examples, or closed-form physics cases with units,
  frames, epochs or time scales, tolerances, and tolerance rationale.
- Basilisk Python `_UnitTest/test_*.py` sources must stay covered by
  `docs/basilisk-unit-test-port-index.json`; mapped entries become required
  numeric or message-contract test ports before the owning SDN module can be
  marked complete.
- Selected source-library numeric vectors must also be listed in
  `docs/test-vector-extraction-index.json`, with upstream test file/method,
  SDN module/test file, quantities, units, and tolerance recorded.
- Required durable records that the SDS audit marks missing or partial must be
  added in SDS before a parity module advertises them in an SDK manifest.

## Orekit Source Taxonomy

| Orekit package | Java files | Test classes | SDN meaning |
| --- | ---: | ---: | --- |
| `time` | 76 | 50 | Shared time-scale, date, epoch, leap-second, and CCSDS time support. |
| `frames` | 82 | 54 | Shared reference frames, EOP, transforms, topocentric/local orbital frames, and encounter frames. |
| `orbits` | 36 | 25 | Orbit representations, conversions, Jacobians, and state parameterization. |
| `propagation` | 461 | 271 | Analytical, numerical, DSST, events, sampling, ephemerides, and CR3BP propagation. |
| `forces` | 126 | 76 | Drag, gravity, tides, relativity, SRP, maneuvers, empirical, and inertial force models. |
| `attitudes` | 40 | 29 | Attitude states, laws, switching, interpolation, yaw steering, nadir/target pointing, and torque-free motion. |
| `estimation` | 234 | 142 | IOD, least squares, Kalman/UKF/ESKF, measurements, modifiers, and generation. |
| `gnss` | 173 | 59 | GNSS navigation, antenna models, SSR/RTCM, RF link, Ntrip, and metrics. |
| `files` | 482 | 98 | CCSDS ADM/ODM/TDM/CDM, RINEX, SP3, SINEX, ILRS CPF/CRD, IIRV, STK, and ephemeris parsers/writers. |
| `models` | 159 | 75 | Earth atmosphere, ionosphere, troposphere, weather, displacement, geomagnetic, geoid, tessellation, and water-vapor models. |
| `bodies` | 26 | 17 | Celestial bodies, CR3BP systems, ellipsoids, geodetic points, loxodromes, and ephemerides. |
| `geometry` | 8 | 5 | Field-of-view geometry and footprints. |
| `ssa` | 18 | 11 | Collision probability and SSA metrics. |
| `control` | 64 | 42 | Lambert heuristics and indirect optimal control. |
| `data` | 40 | 17 | Data loaders, crawlers, compressed inputs, filters, and data contexts. |
| `utils` | 93 | 62 | Constants, interpolation, units, parameter drivers, PV/Angular coordinates, and shared math utilities. |

## Basilisk Source Taxonomy

The existing Basilisk plan already decomposes the local Basilisk source into
these SDN families:

| Basilisk family | Target path | Status now | Planned modules |
| --- | --- | --- | ---: |
| Core runtime and messaging | `basilisk/runtime` | Implemented seed | 1 |
| Simulation dynamics | `basilisk/dynamics/*` | Planned | 29 |
| Simulation environment | `basilisk/environment/*` | Planned | 15 |
| Simulation sensors/navigation | `basilisk/sensors/*` | Planned | 12 |
| Simulation power/thermal/data | `basilisk/power/*` | Planned | 18 |
| Simulation MuJoCo | `basilisk/mujoco/*` | Deferred pending bridge/runtime decision | 5 |
| FSW attitude control | `basilisk/fsw/attitude-control/*` | Planned | 10 |
| FSW attitude determination | `basilisk/fsw/attitude-determination/*` | Planned | 9 |
| FSW attitude guidance | `basilisk/fsw/attitude-guidance/*` | Planned | 17 |
| FSW effector interfaces | `basilisk/fsw/effector-interfaces/*` | Planned | 22 |
| FSW configuration data | `basilisk/fsw/configuration-data/*` | Planned | 2 |
| FSW delta-V guidance | `basilisk/fsw/dv-guidance/*` | Planned | 2 |
| FSW orbit, formation, navigation | `basilisk/fsw/orbit-formation-navigation/*` | Planned | 21 |
| FSW state estimation | `basilisk/fsw/state-estimation/*` | Planned | 1 |
| FSW sensor, optical, image | `basilisk/optical/*` | Planned | 15 |

The Basilisk plan is valid for Basilisk parity but does not cover Orekit
packages. This document adds the missing Orekit coverage and records where
Orekit and Basilisk should share modules instead of duplicating functionality.
Generated source-test indices are enforced by `npm run check:source-indices`.
Generated current-module readiness is enforced by `npm run check:module-index`.

## Deduplicated Capability Map

| Capability | Orekit authority | Basilisk authority | Current SDN coverage | Decision |
| --- | --- | --- | --- | --- |
| Time scales, epochs, leap seconds, CCSDS time | `time`, `data` | runtime message timestamps | SDS `TIMInstant`, `TIMConversionRequest`, and `TIMConversionResult`; partial private logic in individual modules; `foundation/time` covers Orekit agency-epoch, extended-preamble CCSDS CUC, picosecond CDS, and month/day CCS source-kind-preserving target bytes | Create `foundation/time`; all modules import it for time-scale conversions and CCSDS time codes. |
| Frames, EOP, transforms, body-fixed and local orbital frames | `frames`, `bodies` | frame-tagged message payloads, spacecraft/body frames | Initial `foundation/frames` SDS FRM module covers Basilisk PCI/PCPF DCM transforms plus ellipsoid and spherical LLA/PCPF conversion; partial local math remains in HPOP, maneuver, coverage | Expand `foundation/frames`; Basilisk runtime maps frame IDs through this module. |
| Orbit representations and conversions | `orbits`, `propagation/conversion` | `ClassicElements`, `orbElemConvert`, FSW orbit utilities | Initial `foundation/orbits` OMM Keplerian-to-OEM Cartesian, OEM Cartesian-to-OMM Keplerian, OPM Cartesian-to-OEM/OMM, OPM Keplerian true-anomaly-to-OEM/OMM, VCM Cartesian-to-OEM/OMM/Keplerian/equinoctial, VCM Keplerian-to-OEM/OMM/STATE_VECTOR, VCM Keplerian/equinoctial conversions, VCM equinoctial-to-OEM/OMM/STATE_VECTOR normalization, VCM Keplerian mean/true anomaly normalization from Basilisk `testOrbitalAnomalies` plus Barker parabolic mean anomaly, OMM `MEAN_MOTION` output from Basilisk `KeplerianOrbit.n()`, VCM-pair to CDM relative Hill-state output, CDM relative Hill plus chief VCM to deputy VCM output, Basilisk J2 mean/osculating conversion through SDS GRV, Basilisk J2-J6 zonal perturbation acceleration emitted as OEM acceleration fields, and Basilisk solar radiation pressure acceleration emitted as OEM acceleration fields, including Basilisk circular inclined/equatorial singular-case recovery, circular prograde VCM equinoctial inverse recovery, non-circular equatorial longitude-of-pericenter recovery, circular retrograde equatorial true-longitude recovery, OMM/OPM/VCM hyperbolic mean-anomaly conversion, Basilisk rectilinear elliptical/hyperbolic VCM anomaly-to-Cartesian conversion, Basilisk parabolic VCM Cartesian-to-Keplerian signed true-anomaly recovery, Basilisk parabolic VCM periapsis-to-Cartesian conversion, parabolic VCM Barker mean-anomaly-to-Cartesian conversion, parabolic OEM/OPM/VCM OMM normalization, and Basilisk Hill `rv2hill`/`hill2rv` relative-state conversion; partial in maneuver, HPOP, cislunar | Expand `foundation/orbits`; update maneuver, OD, covariance, HPOP, and Basilisk orbit utilities to import it. |
| Shared interpolation and math utilities | Orekit `utils`, interpolation helpers | `BSpline`, AVS utilities | Initial `foundation/math-bspline` SDS `BSP` interpolation module with browser/WasmEdge C++ artifact and Basilisk `test_BSpline.py` order 5/6 endpoint-constraint sweep; initial `foundation/attitude-math` SDS `RBK` rigid-body kinematics module with Basilisk AVS MRP, Gibbs, PRV, and sequence-aware Euler add/subtract, scalar-first Euler-parameter, direction-cosine-matrix, MRP switch, first/second-order MRP differential, first-order Gibbs/PRV/Euler differential vectors, and `avsEigenSupport` elementary rotation-matrix, DCM-to-MRP, and tilde-matrix coverage; initial `foundation/numerics` SDS `NUM` root-solving, vector-saturation, and vector-discretization module with Basilisk `avsEigenSupport` Newton-Raphson, `Saturate.testSaturate`, and `Discretize` coverage | Keep reusable math in `foundation/*`; Basilisk constrained attitude and FSW modules import `foundation/math-bspline`, `foundation/attitude-math`, and `foundation/numerics` instead of copying B-spline, attitude utility, scalar root-solving, vector-saturation, or vector-discretization logic. |
| Celestial bodies, CR3BP, ellipsoids, geodesy, loxodromes | `bodies`, `geometry` | `planetEphemeris`, `groundLocation`, `groundMapping` | Cislunar CR3BP and some coverage geometry | Create `foundation/bodies-geometry`; share ellipsoid/FOV/footprint functions with coverage and Basilisk environment. |
| Analytical propagation | `propagation/analytical`, TLE, GNSS, Intelsat, Brouwer-Lyddane, Eckstein-Hechler, Kepler | Basilisk has simulation propagators and Lambert utilities, not Orekit analytical model parity | `propagator/sgp4`, partial `propagator/cislunar` | Create `propagator/analytical`; update `propagator/sgp4` for Orekit TLE generation and tests. |
| Numerical propagation and force composition | `propagation/numerical`, `forces/*` | spacecraft dynamics, gravity, drag, SRP, thrusters, reaction wheels, integrators | `propagator/hpop`, `propagator/atmosphere`, Basilisk runtime seed | Split shared force/environment models into reusable modules; update HPOP and Basilisk dynamics to import them. |
| DSST semi-analytical propagation | `propagation/semianalytical/dsst` | No direct equivalent | Missing | Create `propagator/dsst`; import time, frames, orbits, gravity, atmosphere, SRP, and third-body modules. |
| Events, detectors, sampling, ephemeris generation | `propagation/events`, `propagation/sampling`, `files/general` | scenario stepping, recorders, message replay | Partial in access/coverage and Basilisk runtime seed | Create `propagator/events` and `propagator/ephemeris`; Basilisk runtime imports ephemeris sampling for scenario replay exports. |
| Earth and space environment | `models/earth/*`, atmosphere data, CSSI space weather, WMM/IGRF, troposphere, ionosphere, geoid, displacement | MSIS, exponential/tabular atmosphere, albedo, eclipse, WMM, Denton, solar flux | `propagator/atmosphere`, partial HPOP copies, planned Basilisk environment | Create `models/earth-environment`; update atmosphere/HPOP and Basilisk environment modules to import shared models. |
| Attitude states and laws | `attitudes`, CCSDS ADM file support | FSW attitude guidance/control/determination modules | Partial Basilisk runtime scenario only | Create `attitude/laws`; Basilisk FSW modules import shared attitude state/ADM records where appropriate. |
| Maneuvers, Lambert, optimal control | `forces/maneuvers`, `control/*`, `estimation/iod/IodLambert` | `lambertPlanner`, `lambertSolver`, `dvGuidance`, thruster interfaces | `analysis/maneuver`, `analysis/lambert-izzo` | Update existing maneuver and Lambert modules; create `analysis/optimal-control`; Basilisk Lambert wrappers import `analysis/lambert-izzo`. |
| Orbit determination and measurements | `estimation/*`, `files/ilrs`, `files/ccsds/ndm/tdm` | navigation filters, relative OD UKF, small-body EKF/UKF | `analysis/od` partial SGP4 fit | Update `analysis/od` and create `analysis/iod-measurements`; Basilisk filters import shared measurement/estimation records. |
| Covariance | Orekit covariance propagation, frame/type transformations, interpolation | filters and state covariance in Basilisk | `analysis/covariance` partial | Update `analysis/covariance` to import time, frames, orbits, HPOP/DSST/SGP4, and OD state transition products. |
| GNSS | `gnss/*`, `files/rinex`, SSR/RTCM, Ntrip, antenna/clock/nav files | Limited sensor/nav analogues | Missing except RF modules and SGP4 | Create `gnss/navigation-products` and `files/gnss-products`; keep RF link-budget modules separate. |
| Orbit, attitude, tracking, and collision file handling | `files/ccsds`, `files/sp3`, `files/sinex`, `files/ilrs`, `files/iirv`, `files/stk` | Basilisk scenario logs, message payloads | Partial SDS schemas and CA CDM output | Create `files/ccsds-messages`, `files/orbit-products`, and update CA/OD/covariance modules to import them. |
| Collision and conjunction | `ssa/collision`, `files/ccsds/ndm/cdm` | No full equivalent | `analysis/conjunction-assessment` strong but not full Orekit probability method parity | Update existing CA module with Orekit probability methods and file parser/writer imports. |
| Access, coverage, FOV, swath, DOP | `geometry/fov`, propagation events, GNSS DOP | `groundLocation`, `spacecraftLocation`, sensors | `analysis/access`, `analysis/coverage`, `analysis/swath`, `analysis/sensor-coverage`, initial `analysis/dop` | Finish coverage/access/swath shared geometry imports and broaden DOP with Orekit GNSS visibility vectors. |
| Spacecraft simulation dynamics | Force hooks only; no Basilisk-style spacecraft component simulation | spacecraft, effectors, thrusters, reaction wheels, fuel, multibody, integrators | Basilisk runtime seed only | Create Basilisk dynamics family modules and import shared time/frames/orbits/forces instead of duplicating Orekit primitives. |
| Sensors, navigation, power, thermal, data handling | Measurement models and files | sensors, nav, power, thermal, onboard data handling | Basilisk runtime seed only | Create Basilisk sensors and power families with SDS/XTCE ports. |
| FSW guidance, control, formation, optical navigation | Attitude laws, OD, control, measurements | FSW algorithms and image/optical navigation | Basilisk runtime seed only | Create Basilisk FSW families; import Orekit-derived attitude, orbit, Lambert, OD, and measurement modules where shared. |

## Current Module Actions

| Current module | Action | Reason |
| --- | --- | --- |
| `foundation/time` | Update | SDS TIM conversion module exists for UTC, TAI, TT, GPS, GLONASS, GST, QZSS, BDT, NAVIC, SBAS, TCG, TDB, TCB, GMST, JD, MJD, Unix seconds, GPS/QZSS/SBAS/GST/BDT/NavIC elapsed seconds using their Orekit constellation epochs, GNSS week/seconds with explicit rollover-reference support, Orekit signed-extended-year/date-only/ordinal/ISO-week parser forms, Orekit signed/basic calendar, basic ordinal, basic ISO week parser forms, ISO-8601 example equivalence across calendar/ordinal/week forms, common-year/leap-year ordinal day mappings, exact DateComponents MJD day outputs, DateComponents well-formed range endpoint J2000-day outputs, invalid ISO week-day and malformed-date rejection, and ISO week-component boundary sweeps across ordinary and 1582 reform cases, Orekit astronomical calendar day mapping with the BC/year-zero through J2000 chronology table and 1582 Gregorian-reform discontinuity, Orekit reduced minute-only/basic time forms, Orekit colon/compact/hour-only/stress UTC offset parser forms, fail-closed HMS-designator rejection, initial CCSDS unsegmented CUC, day-segmented CDS, and calendar-segmented CCS source parsing including agency-epoch CUC/CDS vectors, canonical TAI CCSDS CUC, canonical UTC CCSDS CDS target formatting, source-kind-preserving TAI agency-epoch and extended-preamble CCSDS CUC target formatting, source-kind-preserving UTC agency-epoch and picosecond CCSDS CDS target formatting, and source-kind-preserving UTC month/day and day-of-year CCSDS CCS target formatting, GLONASS GNSS epoch rejection per Orekit `GNSSDate`, pre-1972 linear UTC-TAI history offsets, pre-1972 large UTC leap-second label parsing, explicit UTC leap-second parse/format boundaries, UT1/GMST conversion with caller-supplied DUT1, and fail-closed UT1/GMST when DUT1 is absent. It still needs full Orekit `time`, leap-second loader, remaining CCSDS time-code edge cases and caller-selected target metadata, default DataContext-backed GNSS rollover references, interpolation, and data-context parity. |
| `foundation/math-bspline` | Update | SDS BSP interpolation module exists with `BSPInterpolationRequest`/`BSPInterpolationResult` FlatBuffer ports, regular and aligned-binary manifest contracts, browser/WasmEdge-compatible C++ artifact, and Basilisk `test_BSpline.py` waypoint plus derivative checks for polynomial orders 5 and 6. It still needs broader Orekit interpolation utility coverage and any additional Basilisk AVS math utilities that should share this package. |
| `foundation/numerics` | Update | SDS NUM scalar root-solving, vector-saturation, and vector-discretization module exists with `NUMRootSolveRequest`/`NUMRootSolveResult`, `NUMVectorSaturateRequest`/`NUMVectorSaturateResult`, and `NUMVectorDiscretizeRequest`/`NUMVectorDiscretizeResult` FlatBuffer ports, regular and aligned-binary manifest contracts, browser/WasmEdge-compatible C++ artifact, Basilisk `test_avsEigenSupport.cpp` `newtonRaphsonSolve` coverage for `f(x)=x*x-4` from `x0=3`, Basilisk `test_saturate.cpp` `Saturate.testSaturate` vector-clamp coverage for `[-555, 1.27, 5000000]` with lower bounds `[-400, 5, -1]` and upper bounds `[0, 10, 5000001]`, and Basilisk `test_discretize.cpp` `Discretize` vector quantization coverage for to-zero, from-zero, nearest, and carry-error rounding. It still needs broader Orekit solver and interpolator utility parity plus additional reusable Basilisk numerical primitives. |
| `foundation/attitude-math` | Update | SDS RBK rigid-body kinematics module exists with `RBKRigidBodyKinematicsRequest`/`RBKRigidBodyKinematicsResult` FlatBuffer ports, regular and aligned-binary manifest contracts, browser/WasmEdge-compatible C++ artifact, and Basilisk AVS `testRigidBodyKinematics` vectors for `addMRP`, `subMRP`, `MRPswitch`, `MRP2EP`, `EP2MRP`, `C2EP`, `EP2C`, `C2MRP`, `MRP2C`, `BmatMRP`, `BinvMRP`, `dMRP`, `dMRP2Omega`, `BdotmatMRP`, `ddMRP`, `ddMRP2dOmega`, `addGibbs`, `subGibbs`, `EP2Gibbs`, `Gibbs2EP`, `C2Gibbs`, `Gibbs2C`, `MRP2Gibbs`, `Gibbs2MRP`, `BmatGibbs`, `BinvGibbs`, `dGibbs`, `addPRV`, `subPRV`, `EP2PRV`, `PRV2EP`, `C2PRV`, `PRV2C`, `MRP2PRV`, `PRV2MRP`, `Gibbs2PRV`, `PRV2Gibbs`, `BmatPRV`, `BinvPRV`, `dPRV`, all twelve sequence-aware `addEuler`, `subEuler`, `C2Euler`, `Euler2C`, `Euler2EP`, `Euler2MRP`, `Euler2Gibbs`, `Euler2PRV`, `EP2Euler`, `MRP2Euler`, `Gibbs2Euler`, `PRV2Euler`, `BmatEuler`, `BinvEuler`, and `dEuler` variants, plus Basilisk `test_avsEigenSupport.cpp` `eigenM1`/`eigenM2`/`eigenM3` elementary rotation-matrix, `eigenC2MRP` DCM-to-MRP, and `eigenTilde` tilde-matrix coverage. It still needs additional linear algebra and broader Orekit attitude math parity where reusable. |
| `foundation/orbits` | Update | SDS OMM-to-OEM, OEM-to-OMM, OPM Cartesian-to-OEM/OMM, OPM Keplerian true-anomaly-to-OEM/OMM, VCM Cartesian-to-OEM/OMM/Keplerian/equinoctial, VCM Keplerian-to-OEM/OMM/STATE_VECTOR, VCM Keplerian/equinoctial, VCM Keplerian mean/true anomaly normalization, VCM equinoctial-to-OEM/OMM/STATE_VECTOR, VCM pair-to-CDM relative Hill-state, CDM relative Hill plus chief VCM-to-deputy VCM, VCM state plus GRV J-zonal acceleration-to-OEM, and VCM state plus CRD Sun vector SRP acceleration-to-OEM C++ SDK methods exist for one Orekit-backed non-circular, non-equatorial elliptical Keplerian mean-anomaly vector plus Basilisk OPM/VCM element, Hill-frame, anomaly, J2 mean/osculating, J2-J6 acceleration, solar radiation pressure acceleration, and `KeplerianOrbit.n()` mean-motion coverage, with browser/WasmEdge artifact checks and OMM/OPM/OEM/VCM/CDM/GRV/CRD dual wire-type manifest coverage. The OEM inverse method requires `GM` from an SDS OMM `gravity_context` instead of a hard-coded central body constant; the OPM inverse uses OPM `GM`; the VCM inverse and VCM element normalization use VCM `GM`; all finite positive-semi-major-axis OMM emitters populate `MEAN_MOTION` in rev/day from `sqrt(GM/a^3)`, while parabolic OEM/OPM/VCM-to-OMM outputs use Barker mean anomaly with zero mean motion; the J-zonal acceleration method uses SDS GRV `MU`, `EQUATORIAL_RADIUS`, and `J2` through `J6`; the SRP acceleration method uses VCM `MASS`/`SOLAR_RAD_AREA`/`SOLAR_RAD_COEFF` plus CRD `X/Y/Z` in AU. Basilisk `testOrbitalAnomalies` now maps SDS VCM Keplerian `TRUE_ANOMALY` and `MEAN_ANOMALY` in both directions for elliptic and hyperbolic states, VCM parabolic anomaly normalization uses Barker's closed-form equation with Basilisk `TwoDimensionParabolic` periapsis vectors, Basilisk `CircularInclined`, `CircularEquitorial`, `NonCircularEquitorial`, `NonCircularNearEquitorial`, and `CircularEquitorialRetrograde` Cartesian vectors now recover normalized OMM singular-case conventions or Basilisk-compatible longitude-of-pericenter sums, Basilisk `CircularInclined` and `CircularEquitorial` VCM equinoctial records recover circular prograde Keplerian/OMM/state-vector outputs, Basilisk `TwoDimensionElliptical` VCM state vectors recover VCM `KEPLERIAN_ELEMENTS` with `ANOMALY_TYPE=MEAN_ANOMALY` and VCM `EQUINOCTIAL_ELEMENTS`, Basilisk `TwoDimensionParabolic` OEM/OPM/VCM Cartesian state vectors recover OMM Barker mean elements, while VCM parabolic state vectors also recover VCM `KEPLERIAN_ELEMENTS` with `ANOMALY_TYPE=TRUE_ANOMALY`, signed parabolic true anomaly, and `PERIAPSIS_RADIUS`, Basilisk `TwoDimensionParabolic` VCM Keplerian elements with `PERIAPSIS_RADIUS` now emit OEM, OMM, and VCM Cartesian state vectors from either true anomaly or Barker mean anomaly, Basilisk `TwoDimensionElliptical` Keplerian/equinoctial VCM element records now emit VCM `STATE_VECTOR`, Basilisk `TwoDimensionHyperbolic` vectors now round-trip through OMM and VCM Keplerian hyperbolic mean anomaly, Basilisk `elem2rv1DEccentric` and `elem2rv1DHyperbolic` rectilinear elements now emit OEM and VCM Cartesian state vectors from VCM `KEPLERIAN_ELEMENTS`, Basilisk `classicElementsToEquinoctialElements` now maps SDS VCM Keplerian elements to/from SDS VCM equinoctial elements, OMM mean elements, and OEM Cartesian state vectors, Basilisk `testOrbitalHill` now maps chief/deputy VCM Cartesian states to CDM RTN relative position/velocity fields and maps CDM Hill relative fields plus chief VCM back to the deputy VCM Cartesian state, Basilisk `clMeanOscMap` now maps SDS VCM Keplerian mean/osculating elements in both directions using SDS GRV `EQUATORIAL_RADIUS`/`J2`, Basilisk `jPerturb` now maps SDS VCM Cartesian states plus SDS GRV `MU`/`EQUATORIAL_RADIUS`/`J2`-`J6` to OEM acceleration fields, Basilisk `solarRad` now maps VCM spacecraft SRP parameters plus CRD Sun vector to OEM acceleration fields, and Basilisk `orbElemConvert` parameter sweep coverage now maps inclined/equatorial elliptic, circular, parabolic, and hyperbolic SI source cases through VCM Keplerian-to-state and state-to-Keplerian SDS FlatBuffer surfaces. It still needs Jacobian, frame-aware state transform, retrograde equinoctial singular handling, shared force-model module extraction/imports, and any remaining `orbElemConvert` message-wrapper parity outside reusable orbit-conversion surfaces. |
| `propagator/sgp4` | Update | Add Orekit TLE generation parity, Orekit SDP4/SGP4 2006 test vectors, and make OD/CA imports use this module instead of vendored SGP4 copies. |
| `propagator/hpop` | Update | It overlaps Orekit numerical propagation and force models. Existing resident-state binary stream methods are now manifest-declared and SDK-routed for `ingest_state`, `propagate_state`, `prepare_trajectory_segments`, and `describe_trajectory_segments`, including aligned-binary `PropagatorState` handoff where applicable. The SGP4-to-HPOP inter-module fixture proves an aligned-binary SGP4 `PropagatorState` can seed HPOP resident propagation, and `docs/module-import-descriptors.json` now validates that handoff against both manifests plus the fixture before composition. HPOP still owns duplicated atmosphere/time/force code that should move behind shared module imports. |
| `propagator/atmosphere` | Update | US76/NRLMSISE-style query code now has a binary SDS HFC direct method for altitude-batch atmosphere state queries: `query_atmosphere_state_batch` accepts `$HFC` `ATMOSPHERE` plus `ALTITUDE_M`, optional `SPEED_M_PER_S`, optional per-sample `SAMPLE_EPOCHS`, `LATITUDE_DEG`, and `LONGITUDE_DEG`, and optional `$SPW` space-weather input, then emits typed `$HFC` density, temperature, pressure, speed-of-sound, preserved sample metadata, speed, dynamic-pressure, and Mach arrays with regular FlatBuffer and aligned-binary manifest declarations. The NRLMSIS00E HFC path now converts per-sample epochs and coordinates into the NRLMSISE-00 position/time inputs and maps typed SDS SPW F10.7/F10.7A/Ap values into solar activity, with browser and WasmEdge coverage proving local-solar-time and space-weather density/temperature variation. The USSA HFC density path ports Basilisk `orbitalMotion.c` `atmosphericDensity` references at 200 km and 2000 km into native C++ tests and checks the 200 km value through browser and WasmEdge HFC invoke. The C++ model layer also ports Basilisk `debyeLength` references at 400 km, 1000 km, 10000 km, and 34000 km. `vcm_state_to_drag_acceleration_oem` now exposes the Basilisk `atmosphericDrag` source vector through a direct VCM-to-OEM browser/WasmEdge method using VCM `STATE_VECTOR`, `MASS`, `DRAG_AREA`, and `DRAG_COEFF`; direct HFC Debye output remains blocked until SDS exposes a Debye-length field or a force-model/environment record. It still needs full Orekit atmosphere-model parity and eventual integration behind the shared Earth environment import surface used by HPOP, DSST, Basilisk environment, launch, and reentry modules. |
| `propagator/cislunar` | Update | Align CR3BP and Lagrange-point trajectory tests with Orekit `bodies` and `propagation/numerical/cr3bp`; import shared time/frames/orbits. |
| `analysis/maneuver` | Update | Add Orekit analytical/impulse/continuous maneuver parity and delegate Lambert solves to `analysis/lambert-izzo`. |
| `analysis/lambert-izzo` | Update | Treat as the single Lambert primitive for Orekit IOD Lambert and Basilisk Lambert planner/solver wrappers. |
| `analysis/od` | Update | Expand from near-term SGP4 fitting to Orekit IOD, least-squares, Kalman/UKF/ESKF, measurements, modifiers, and Basilisk filter imports. |
| `analysis/covariance` | Update | Add Orekit frame/type transforms, STM propagation, Keplerian extrapolation, and blending interpolation. |
| `analysis/conjunction-assessment` | Update | Patera-style native 2D probability coverage now carries Orekit `Patera2005Test` scalar cases 01-08, CSM 1-3, and CDM 1-2; the local `chan` path now matches Orekit `Chan1997Test` scalar cases 01-12, CSM 1-3, CDM 1-2, and Alfano cases 3 and 5; named `ALFRIEND-1999` and `ALFRIEND-1999-MAX` paths now match Orekit `Alfriend1999Test` and `Alfriend1999MaxTest` Armellin appendix scalar vectors; named `ALFANO-2005` now matches Orekit `Alfano2005Test` scalar cases 01-12, CSM 1-3, CDM 1-2, and Alfano cases 3 and 5; named `LAAS-2015` now matches Orekit `Laas2015Test` scalar cases 01-12, CSM 1-3, CDM 1-2, and Alfano cases 3 and 5, including lower/upper probability bounds where the upstream test asserts them; CDM FlatBuffers output checks now run as native ctest `cdm_output`; CSM summary output checks now run as native ctest `csm_output` and the `emit_csm` command emits SDS `$CSM` aligned-binary bytes in the WasmEdge harness; `compute_pc_from_cdm` now imports SDS `$CDM` aligned-binary input for Pc computation and emits aligned-binary `ConjunctionPcResult`; `parse_cdm_kvn`/`write_cdm_kvn` and `parse_cdm_xml`/`write_cdm_xml` now round-trip Orekit `CDMExample1` KVN/XML-derived fixtures through SDS `$CDM` aligned-binary bytes in native and WasmEdge command tests; file-backed Patera/Laas tests now parse Orekit `ION_SCV8_vs_STARLINK_1233.txt` and match Orekit real-CDM probabilities while `compute_pc_from_cdm` preserves CDM `REF_FRAME`, uses object state vectors when available, and applies Earth-fixed velocity correction for ITRF-like frames. Remaining CA gaps include broader external CDM/CSM fixture coverage, full Orekit frame-transform rigor, and additional NASA CARA CDM file vectors as needed. |
| `analysis/access` | Update | Initial C++ WASM access runtime now advertises browser/WasmEdge runtime targets, publishes a raw `dist/isomorphic/module.wasm`, passes SDK artifact compliance, returns a decoded SDK `PluginInvokeResponse` envelope from `plugin_invoke_stream` for the declared `compute_access_windows` method, advertises canonical SDS `ACW.fbs`/`$ACW` request/result envelopes with both FlatBuffer and aligned-binary type refs, and now decodes ACW FlatBuffer request frames into native access-window computation before emitting ACW result frames through the SDK response arena. The canonical ACW request schema now carries `ELEVATION_MASK` and `REFRACTION_MODEL` request fields, and the stream invoke path applies those fields to the same native effects-aware window engine used by the direct analyzer API. The JS access geometry path now carries an Orekit `TopocentricFrameTest` inverse tracking-coordinate vector and normalizes azimuth to Orekit's `[0, 2*pi)` convention. The native C++ window engine now also supports Orekit-style azimuth-dependent `ElevationMask` interpolation, configurable `EarthStandardAtmosphereRefraction` apparent-elevation switching for AOS/LOS including Orekit pressure/temperature setter semantics, and direct `ITURP834AtmosphericRefraction` parity against Orekit altitude/elevation source vectors with native apparent-elevation switching. Existing native ground-station/access-window/scheduling tests remain intact. It still needs shared event/frames/body/environment imports and broader Orekit rise/set/FOV event vectors. |
| `analysis/coverage` | Update | Initial C++ SDK artifact exists at `dist/isomorphic/module.wasm` with browser/WasmEdge targets and native grid creation, footprint accumulation, interval, FOM, heatmap, statistics, and sensor-union aligned-binary methods. Remaining work: broaden coverage/FOV parity and share geometry/import contracts with access, swath, and sensor coverage. |
| `analysis/swath` | Update | Initial C++ SDK artifact exists at `dist/isomorphic/module.wasm` with browser/WasmEdge targets and native aligned-binary `project_footprint`, geodetic `ground_track`, `generate_swath`, `point_in_footprint`, and `access_geometry` methods, including conical, rectangular, and custom sensor footprint rays. Remaining work: broaden Orekit FOV parity, add stronger authoritative aggregate footprint vectors, and share FOV/body geometry/import contracts with coverage, access, and sensor coverage. |
| `analysis/sensor-coverage` | Update (moved) | Own STK/Orekit-style time-dynamic sensor coverage and import swath/access/FOV primitives. Now closed-tier: the module lives at `packages/sensor-coverage` in the private `space-data-network-closed-modules` repo, so this parity work happens there. Respect active coordination locks before editing. |
| `analysis/dop` | Update | Initial C++ SDK artifact exists at `dist/isomorphic/module.wasm` with browser/WasmEdge targets and aligned-binary `compute_dop` request/result frames for receiver/satellite ECEF geometry, elevation-mask filtering, and GDOP/PDOP/HDOP/VDOP/TDOP output. Initial tests use a closed-form tetrahedral geometry case and insufficient-visible-satellite mask case. Remaining work: add Orekit GNSS DOP and constellation visibility vectors, SDS-owned request/result records, and shared access/frames imports. |
| `basilisk/runtime` | Update | Seed exists; add message dictionary, typed payload mapping, deterministic snapshot/restore, scenario replay, and imports to shared time/frames/orbits. |
| RF, shaders, licensing modules | Leave out of parity scope | They are useful SDN modules but are not part of Orekit/Basilisk feature completion except where GNSS RF link tests need to consume existing RF primitives. |

## New Module Families To Create

| Target path | Primary upstream authority | Imports |
| --- | --- | --- |
| `foundation/time` | Orekit `time`, `data`, CCSDS time tests | SDS `TIM` conversion records; root module dependency. |
| `foundation/frames` | Orekit `frames`, `bodies`, IERS/EOP tests | `foundation/time`, data loaders. |
| `foundation/orbits` | Orekit `orbits`, `propagation/conversion`, Basilisk `orbElemConvert` | `foundation/time`, `foundation/frames`. |
| `foundation/attitude-math` | Orekit attitude math and Basilisk AVS rigid-body utilities | SDS `RBK`; `foundation/frames` once frame-aware attitude transforms are added. |
| `foundation/numerics` | Orekit numerical utility solvers and Basilisk AVS scalar/vector utilities | SDS `NUM`; imported by modules that need reusable scalar root solving, vector saturation, or vector discretization. |
| `foundation/bodies-geometry` | Orekit `bodies`, `geometry/fov`, Basilisk ground/location modules | `foundation/time`, `foundation/frames`. |
| `data/space-data-loaders` | Orekit `data` | SDS `REC`/`MBL`, host filesystem/network/IPFS capabilities. |
| `files/ccsds-messages` | Orekit CCSDS ADM/ODM/TDM/CDM files | SDS CCSDS schemas, `foundation/time`, `foundation/frames`, `foundation/orbits`. |
| `files/orbit-products` | Orekit SP3, SINEX, ILRS CPF/CRD, IIRV, STK | `files/ccsds-messages`, `foundation/*`. |
| `files/gnss-products` | Orekit RINEX, ANTEX, SSR, RTCM, Ntrip, GPS RF link | `foundation/time`, `foundation/frames`, `gnss/navigation-products`. |
| `models/earth-environment` | Orekit Earth models, Basilisk atmosphere/WMM/albedo/eclipses | `foundation/time`, `foundation/frames`, `foundation/bodies-geometry`, `data/space-data-loaders`. |
| `propagator/analytical` | Orekit analytical propagation | `foundation/*`, `propagator/sgp4`, `gnss/navigation-products`. |
| `propagator/dsst` | Orekit DSST | `foundation/*`, `models/earth-environment`, shared force modules. |
| `propagator/events` | Orekit events and intervals | `foundation/*`, `models/earth-environment`, `analysis/access`. |
| `propagator/ephemeris` | Orekit tabulated/file/memory/integration ephemerides | `foundation/*`, `files/ccsds-messages`. |
| `attitude/laws` | Orekit attitude laws and CCSDS ADM support | `foundation/*`, `files/ccsds-messages`. |
| `gnss/navigation-products` | Orekit GNSS propagation/nav messages/DOP support | `foundation/*`, `files/gnss-products`. |
| `analysis/iod-measurements` | Orekit IOD and measurement models | `foundation/*`, `files/ccsds-messages`, `models/earth-environment`. |
| `analysis/dop` | Orekit GNSS DOP | `foundation/*`, `gnss/navigation-products`, `analysis/access`. |
| `analysis/optimal-control` | Orekit indirect optimal control | `foundation/*`, `propagator/hpop`, `analysis/maneuver`. |
| `basilisk/dynamics/*` | Basilisk simulation dynamics | `foundation/*`, shared force/environment modules. |
| `basilisk/environment/*` | Basilisk environment | `models/earth-environment`, `foundation/*`. |
| `basilisk/sensors/*` | Basilisk sensors/navigation | `foundation/*`, `attitude/laws`, `models/earth-environment`. |
| `basilisk/power/*` | Basilisk power/thermal/data | `basilisk/runtime`, XTCE/SDS engineering telemetry schemas. |
| `basilisk/fsw/*` | Basilisk FSW algorithms | `foundation/*`, `attitude/laws`, `analysis/lambert-izzo`, `analysis/od`. |
| `basilisk/optical/*` | Basilisk optical/image modules | `foundation/*`, `basilisk/sensors/*`, image SDS schemas to be promoted first. |
| `basilisk/mujoco/*` | Basilisk MuJoCo modules | Deferred until MuJoCo WASM bridge, license, and MJCF asset contract are explicit. |

## Authoritative Test Plan

- Orekit parity tests must port expected numerical values from the Orekit
  `*Test.java` suite at commit `7b39f84999bca5b51b11f216befd6555116f8f52`.
  Each ported test must name the original class and method when possible.
- Basilisk parity tests must port expected numerical values from upstream
  `_UnitTest/*.py` files in the local Basilisk checkout and keep references to
  the original scenario or support data file.
- Shared modules must have native C++ tests, SDK invoke tests, browser harness
  tests, and WasmEdge tests against the same `dist/isomorphic/module.wasm`.
- Modules that only route to imported modules must test import failure,
  schema mismatch, and dependency-version mismatch as fail-closed behavior.
- Golden outputs generated by the new SDN modules alone are not sufficient.
  They may be regression fixtures only after at least one authoritative test
  proves the implementation.
