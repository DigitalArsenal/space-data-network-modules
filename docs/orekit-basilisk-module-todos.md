# Orekit And Basilisk SDN Module Todo Plan

This plan is scoped to `space-data-network-modules`. It intentionally keeps the
goal active: the current repository does not yet contain a complete Orekit and
Basilisk parity suite.

## Global Acceptance Gates

- [ ] Every created or updated parity module is implemented in C++.
- [ ] Every created or updated parity module has an SDK-compliant
  `plugin-manifest.json`.
- [ ] Every created or updated parity module builds
  `dist/isomorphic/module.wasm`.
- [ ] Every created or updated parity module loads the same
  `dist/isomorphic/module.wasm` in browser and WasmEdge harnesses.
- [ ] Every created or updated parity module uses binary SDS FlatBuffers through
  `PIV` invoke envelopes and `TAB` payload frames.
- [ ] Shared functionality is imported from another SDN module instead of
  copied locally when an owning module already exists.
- [ ] Every numeric module test states upstream source, units, frame, epoch or
  time scale, tolerance, and tolerance rationale.
- [ ] Every authoritative numeric test comes from Orekit tests, Basilisk
  upstream tests, a public standard example, a published reference, or a
  closed-form physics case independent of the new SDN implementation.
- [ ] Any required durable schema is added in SDS before module implementation
  consumes it.
- [ ] `npm run generate:basilisk-plan` and `npm run check:basilisk-plan` pass
  after Basilisk plan changes.
- [ ] `SPACE_DATA_MODULE_SDK_ROOT=../space-data-module-sdk ./scripts/test-sdk-compat.sh`
  passes for all completed parity modules, or each unavailable external tool is
  recorded with the exact blocker.
- [ ] Stack-level `git submodule status` and
  `git submodule foreach 'git status --short --branch'` are run before any
  completion claim.

## Phase 0: Evidence, Schema, And Dependency Groundwork

- [x] Capture the Orekit source commit used for test-vector extraction in a
  checked-in evidence note.
  Done 2026-05-24 in `docs/orekit-basilisk-gap-analysis.md` and
  `docs/orekit-source-test-index.json`; verified with
  `npm run check:source-indices`.
- [x] Add a reproducible Orekit source-test inventory index covering top-level
  packages, source files, and test classes.
  Done 2026-05-24 in `docs/orekit-source-test-index.json`; verified with
  `npm run check:source-indices`.
- [x] Add a reproducible Basilisk source-test inventory index covering source
  families, C/C++ files, upstream unit-test files, and planned module counts.
  Done 2026-05-24 in `docs/basilisk-source-test-index.json`; verified with
  `npm run check:source-indices`.
- [x] Add a reproducible current-module parity/readiness index covering
  manifest-bearing modules, C/C++ presence, isomorphic artifacts, runtime
  targets, methods, and update gaps.
  Done 2026-05-24 in `docs/current-module-parity-index.json`; verified with
  `npm run check:module-index`.
- [x] Add an Orekit test-vector extraction index that maps every selected
  Orekit `*Test.java` method to the SDN module and test file that will port it.
  Done 2026-05-25 in `docs/test-vector-extraction-index.json`; the checked
  index maps 33 selected Orekit test methods from `time` and `orbits` to
  existing `foundation/time` and `foundation/orbits` SDN tests and verifies the
  mappings with `npm run check:test-vectors`.
- [ ] Add a Basilisk test-vector extraction index that maps every selected
  Basilisk `_UnitTest/*.py` method to the SDN module and test file that will
  port it.
  Initial source-library numeric vector mappings for existing Basilisk C++
  architecture utility ports were added 2026-05-25 in
  `docs/test-vector-extraction-index.json`; the checked index maps 18 selected
  `src/architecture/utilities/tests/test_orbitalMotion.cpp` cases to
  `propagator/atmosphere` and `foundation/orbits` tests, maps Basilisk
  `_UnitTest/test_BSpline.py` to `foundation/math-bspline`, maps the AVS
  `testRigidBodyKinematics` vector set to `foundation/attitude-math`, and maps
  Basilisk `test_avsEigenSupport.cpp` `TildeMatrix`, `RotationMatrices`, and
  `DCMtoMRP` to `foundation/attitude-math`, maps `NewtonRaphson`,
  `test_saturate.cpp` `Saturate.testSaturate`, and `test_discretize.cpp`
  `Discretize` to `foundation/numerics`, maps
  `test_linearInterpolation.cpp` `LinearInterpolationTest` and
  `test_bilinearInterpolation.cpp` `BilinearInterpolationTest` to
  `foundation/numerics`, maps `test_gaussMarkov.cpp` `GaussMarkov` to
  `foundation/numerics`, maps `test_geodeticConversion.cpp`
  `GeodeticConversion` plus `geodeticConversion.cpp` spherical-planet
  branches to `foundation/frames`, and maps AVS `testOrbitalHill` plus
  `test_orbitalMotion.cpp` `classicElementsToMeanElements`,
  `jPerturb_order_6`, and `orbitalMotion.c` `clMeanOscMap` `sgn=-1`
  semantics to `foundation/orbits`, plus maps
  `test_orb_elem_convert.py` `test_orb_elem_convert` parameter-sweep coverage
  to `foundation/orbits`.
  Comprehensive
  `_UnitTest/test_*.py` source ownership is tracked in
  `docs/basilisk-unit-test-port-index.json`; the remaining open work is to add
  selected `_UnitTest/*.py` method-to-SDN-test mappings as the planned Basilisk
  simulation and FSW family modules are selected and ported.
- [x] Add a reproducible Basilisk Python unit-test port index that maps every
  `_UnitTest/test_*.py` source file to a planned SDN owner, a required
  module-plan addition, a deferred family, or an explicit exclusion.
  Done 2026-05-25 in `docs/basilisk-unit-test-port-index.json`; the checked
  index covers 229 upstream Python unit-test files and is verified with
  `npm run check:basilisk-unit-test-ports`.
- [x] Audit SDS schemas for time, frames, orbit state, attitude state, Earth
  environment, observations, GNSS products, image products, actuator commands,
  power, thermal, and runtime telemetry records.
  Done 2026-05-25 in `docs/sds-schema-audit.json`; the checked audit covers
  all 12 required domains, validates referenced SDS schema directories and file
  identifiers, and records partial/missing coverage plus SDS-first follow-up
  actions. Verified with `npm run check:sds-schema-audit`.
- [x] Promote the shared SDS time-conversion records needed by
  `foundation/time`.
  Done 2026-05-24 in `spacedatastandards.org` `schema/TIM/main.fbs` with
  `TIMInstant`, `TIMConversionRequest`, and `TIMConversionResult`; verified by
  `npm test -- test/tim.schema.test.js`.
- [ ] Add missing SDS schemas first for any externally visible record that
  cannot be represented by existing SDS FlatBuffers.
  The 2026-05-25 audit identifies required SDS-first follow-ups before module
  ports consume durable records: frame-transform request/results, gravity
  numeric parameters and J2 coefficients, attitude MRP/guidance command
  records, force/acceleration-vector and environment-model outputs, GNSS
  product records, image/camera/optical-navigation payload records, typed
  actuator command/status records, power/EPS records, thermal records, and
  generic runtime health/snapshot telemetry.
  The initial Basilisk B-spline utility record was added 2026-05-25 as SDS
  `schema/BSP/main.fbs` before `foundation/math-bspline` consumed it.
  The initial Basilisk rigid-body kinematics utility record was added
  2026-05-25 as SDS `schema/RBK/main.fbs` before
  `foundation/attitude-math` consumed it, and it now includes the first Gibbs
  vector, principal rotation vector, elementary rotation-matrix, and
  tilde-matrix operation sets plus `ANGLE_RAD` used by Basilisk AVS tests.
  The initial shared numerical utility record was added 2026-05-25 as SDS
  `schema/NUM/main.fbs` before `foundation/numerics` consumed it, and it now
  includes Newton-Raphson scalar root-solving, component-wise vector
  saturation, component-wise vector discretization, and scalar interpolation
  request/result records for the Basilisk AVS `NewtonRaphson`,
  `Saturate.testSaturate`, `Discretize`, `linearInterpolation`, and
  `bilinearInterpolation` source vectors; SDS `NUM` was extended 2026-05-26
  with bounded Gauss-Markov sequence request/result records for Basilisk
  `test_gaussMarkov.cpp` sequence-statistics parity.
  The initial shared frame/geodetic transform record was added 2026-05-26 as
  SDS `schema/FRM/main.fbs` before `foundation/frames` consumed it, and it now
  includes explicit DCM PCI/PCPF transforms plus ellipsoid and spherical
  LLA/PCPF request/result records for Basilisk `geodeticConversion` source
  vectors.
  SDS `schema/GRV/main.fbs` was extended 2026-05-26 with
  `EQUATORIAL_RADIUS` and `J2` before `foundation/orbits` consumed those
  values for Basilisk `clMeanOscMap` mean/osculating conversion, then extended
  again with `MU` and `J3` through `J6` before `foundation/orbits` consumed
  them for Basilisk `jPerturb` zonal perturbation acceleration.
  SDS `schema/TIM/main.fbs` was extended 2026-05-26 with an initial
  `TIMCcsdsTimeCode` payload before `foundation/time` consumed Orekit
  `AbsoluteDateTest.testCCSDSUnsegmentedNoExtension` CCSDS CUC vectors and
  `AbsoluteDateTest.testCCSDSDaySegmented` CCSDS CDS vectors, and the same
  payload also covers Orekit `AbsoluteDateTest.testCCSDSCalendarSegmented`
  CCS vectors plus canonical TAI CUC target formatting for the same Orekit CUC
  field bytes and extended-preamble CUC target-byte preservation for Orekit
  `AbsoluteDateTest.testCCSDSUnsegmentedWithExtendedPreamble` plus
  picosecond CDS target-byte preservation for Orekit
  `AbsoluteDateTest.testCCSDSDaySegmented` and month/day CCS target-byte
  preservation for Orekit `AbsoluteDateTest.testCCSDSCalendarSegmented`.
  The initial access-window analysis record was added 2026-05-26 as SDS
  `schema/ACW/main.fbs` before `analysis/access` advertised stream payloads;
  it defines `ACWRequest`, `ACWGroundStation`, `ACWStateSample`,
  `ACWAccessWindow`, and `ACWResult` for TT Julian-date access-window request
  and result exchange.
- [x] Define the module import descriptor used by parity modules to call another
  module with aligned FlatBuffer frames.
  Done 2026-05-25 in `docs/module-import-descriptors.json` with a verified
  `propagator/sgp4` `propagate_state` to `propagator/hpop` `ingest_state`
  descriptor for aligned-binary `orbpro.plugins.PropagatorState` (`PRST`)
  frames; verified by `npm run check:module-imports`.
- [x] Add host-side integration fixtures that compose two modules through
  binary `PIV`/`TAB` frames without JSON.
  Done 2026-05-25 in
  `propagator/hpop/tests/intermodule_sgp4_import.test.mjs`; the fixture
  invokes SGP4 through `PIV`, hands the aligned-binary `TAB` state payload into
  HPOP through the SDK invoke harness, and propagates the resident state back
  out without JSON payload exchange.
- [x] Add fail-closed tests for missing imported module, wrong schema ID, wrong
  file identifier, and incompatible dependency version.
  Done 2026-05-25 in `tests/module_import_descriptors.test.mjs`; the root
  checker rejects a missing provider module, incompatible schema name,
  incompatible FlatBuffer file identifier, and unsatisfied provider version
  range before a host or module can execute the import.

## Phase 1: Shared Foundation Modules

- [x] Create the initial `foundation/time` C++ SDK package with SDS `TIM`
  request/result ports, browser/WasmEdge-compatible
  `dist/isomorphic/module.wasm`, and Orekit-backed UTC/TAI/TT/GPS/UT1/TCG/TDB/TCB/GMST
  conversion tests.
  Done 2026-05-24 in `foundation/time`; verified with `npm run build`,
  `npm test`, and `npm run test:sdk-compat` from that package.
- [x] Create the initial `foundation/math-bspline` C++ SDK package with SDS
  `BSP` request/result ports, browser/WasmEdge-compatible
  `dist/isomorphic/module.wasm`, and Basilisk-backed interpolation tests.
  Done 2026-05-25 in `foundation/math-bspline`; tests reference Basilisk
  `src/architecture/utilitiesSelfCheck/_UnitTest/test_BSpline.py` for
  polynomial orders 5 and 6, waypoint recovery, and endpoint first/second
  derivative constraints.
- [x] Create the initial `foundation/numerics` C++ SDK package with SDS `NUM`
  request/result ports, browser/WasmEdge-compatible
  `dist/isomorphic/module.wasm`, and Basilisk-backed scalar root-solving plus
  vector-saturation, vector-discretization, and scalar-interpolation tests.
  Done 2026-05-25 in `foundation/numerics`; tests reference Basilisk
  `src/architecture/utilities/tests/test_avsEigenSupport.cpp`
  `NewtonRaphson` for `f(x)=x*x-4`, initial estimate `3.0`, and `1e-10`
  accuracy, and Basilisk `src/architecture/utilities/tests/test_saturate.cpp`
  `Saturate.testSaturate` for the component-wise clamp vector
  `[-555, 1.27, 5000000]`; the same package now covers Basilisk
  `src/architecture/utilities/tests/test_discretize.cpp` `Discretize`
  no-carry and carry-error vector quantization with LSB `[10, 10, 10]`, plus
  Basilisk `src/architecture/utilities/tests/test_linearInterpolation.cpp` and
  `src/architecture/utilities/tests/test_bilinearInterpolation.cpp` source
  formulas for deterministic scalar interpolation vectors, and Basilisk
  `src/architecture/utilities/tests/test_gaussMarkov.cpp` `GaussMarkov`
  steady-state standard deviation, gaussian-only statistics, tiny-bounds mean,
  and symmetric-bound clamp semantics.
- [x] Create the initial `foundation/attitude-math` C++ SDK package with SDS
  `RBK` request/result ports, browser/WasmEdge-compatible
  `dist/isomorphic/module.wasm`, and Basilisk-backed rigid-body kinematics
  tests.
  Done 2026-05-25 in `foundation/attitude-math`; tests reference Basilisk AVS
  `testRigidBodyKinematics` vectors for `addMRP`, `subMRP`, `MRPswitch`,
  `MRP2EP`, `EP2MRP`, `C2EP`, `EP2C`, `C2MRP`, `MRP2C`, `BmatMRP`,
  `BinvMRP`, `dMRP`, `dMRP2Omega`, `BdotmatMRP`, `ddMRP`, and
  `ddMRP2dOmega`; the same package now also covers `addGibbs`, `subGibbs`,
  `EP2Gibbs`, `Gibbs2EP`, `C2Gibbs`, `Gibbs2C`, `MRP2Gibbs`, `Gibbs2MRP`,
  `BmatGibbs`, `BinvGibbs`, `dGibbs`, `addPRV`, `subPRV`, `EP2PRV`,
  `PRV2EP`, `C2PRV`, `PRV2C`, `MRP2PRV`, `PRV2MRP`, `Gibbs2PRV`,
  `PRV2Gibbs`, `BmatPRV`, `BinvPRV`, `dPRV`, all twelve sequence-aware
  `addEuler`, `subEuler`, `C2Euler`, `Euler2C`, `Euler2EP`, `Euler2MRP`,
  `Euler2Gibbs`, `Euler2PRV`, `EP2Euler`, `MRP2Euler`, `Gibbs2Euler`,
  `PRV2Euler`, `BmatEuler`, `BinvEuler`, and `dEuler` variants, plus Basilisk
  `test_avsEigenSupport.cpp` `TildeMatrix`, `RotationMatrices`, and
  `DCMtoMRP`.
- [x] Expand `foundation/time` TIM epoch representation support to Orekit-backed
  JD, MJD, Unix seconds, and GPS seconds.
  Done 2026-05-24 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testMJDDate`, `AbsoluteDateTest.testGetJulianDates`,
  `GPSScaleTest.testT0`, and `GPSScaleTest.testArbitrary`; verified with
  `npm run build` and `npm test -- tests/time_conversion.test.mjs`.
- [x] Add UTC leap-second parse/format coverage to `foundation/time`.
  Done 2026-05-24 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testOffsets` boundary equivalence between UTC and TAI;
  verified with `npm run build` and
  `npm test -- tests/time_conversion.test.mjs`.
- [x] Add Orekit GNSS-specific time scales to `foundation/time` and SDS `TIM`.
  Done 2026-05-26 in `foundation/time` and SDS `TIM`; tests reference Orekit
  `GLONASSScaleTest.testArbitrary`, `GalileoScaleTest.test2006`,
  `BDSScaleTest.test2010`, `QZSSScaleTest.testArbitrary`, and
  `NavicScaleTest.testArbitrary`. SDS `timingStandard` now exposes
  `GLONASS`, `GST`, `QZSS`, `BDT`, `NAVIC`, and `SBAS`;
  `foundation/time` supports GLONASS UTC+3h, GST/QZSS/NavIC/SBAS TAI-19s,
  and BDT TAI-33s.
- [x] Add Orekit GNSSDate constellation epoch seconds to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `GNSSDateTest.testFromWeekAndSecondsGPS`,
  `GNSSDateTest.testFromAbsoluteDateGPS`,
  `GNSSDateTest.testFromWeekAndSecondsQZSS`,
  `GNSSDateTest.testFromAbsoluteDateQZSS`,
  `GNSSDateTest.testFromWeekAndSecondsSBAS`,
  `GNSSDateTest.testFromAbsoluteDateSBAS`,
  `GNSSDateTest.testFromWeekAndSecondsGalileo`,
  `GNSSDateTest.testFromAbsoluteDateGalileo`,
  `GNSSDateTest.testFromWeekAndSecondsBeidou`,
  `GNSSDateTest.testFromAbsoluteDateBeidou`,
  `GNSSDateTest.testFromWeekAndSecondsNavIC`, and
  `GNSSDateTest.testFromAbsoluteDateNavIC`, covering GPS/QZSS/SBAS
  1980-01-06, Galileo/GST and NavIC 1999-08-22, and BeiDou/BDT 2006-01-01
  epoch seconds in both directions.
- [x] Add SDS TIM GNSS week/seconds and explicit Orekit rollover-reference
  support to `foundation/time`.
  Done 2026-05-26 in SDS `TIM` and `foundation/time`; tests reference Orekit
  `GNSSDateTest.testZeroZeroGPS` and verify GPS week 0 seconds 0 stays at
  `GPS_EPOCH` for the `1989-10-29` rollover reference, rolls to week 1024 for
  the `1989-10-30` rollover reference, and emits week 1024 plus zero
  seconds-in-week for the rolled absolute instant.
- [x] Reject Orekit GNSSDate invalid satellite systems in `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `GNSSDateTest.testBadSatelliteSystem` and verify `GPS_SECONDS` requests
  tagged as GLONASS fail closed while ordinary GLONASS time-scale conversions
  remain supported.
- [x] Add GLONASS leap-second label parse/format parity to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `GLONASSScaleTest.testDuringLeap` and verify UTC leap instants emit
  GLONASS `02:59:60` labels, and GLONASS leap labels parse back to UTC leap
  instants.
- [x] Add Orekit ISO/RFC3339 date-time parser parity to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateTimeComponentsTest.testParse`, `DateTimeComponentsTest.testLocalTime`,
  and `TimeComponentsTest.testParse`, covering explicit UTC offset suffixes
  comma fractional seconds, and basic `HHMMSS` UTC time forms in TIM ISO-8601
  inputs.
- [x] Add Orekit compact and hour-only UTC offset parser parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testLocalTimeParsing`, covering compact `+0430`/`-0700`
  and hour-only `+04` UTC offset suffixes in TIM ISO-8601 inputs.
- [x] Add remaining source-backed Orekit `TimeComponentsTest` parser coverage
  to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `TimeComponentsTest.testParse`, `testLocalTime`, and `testBadFormat`,
  covering minute-only `23:59`, basic time with hour-only offset
  `235959.900+10`, local offset `23:59:59+01:00`, and fail-closed rejection
  of `23h59m59s`.
- [x] Add Orekit `AbsoluteDateTest.testParse` date-form parser parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testParse`, covering signed Julian epoch
  `-4712-01-01T12:00:00.000`, date-only `1950-01-01`, ordinal `1958-001`,
  and ISO week-date `1858-W46-3` TIM ISO-8601 inputs.
- [x] Add Orekit `DateComponentsTest.testParse` basic and signed date parser
  parity to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testParse`, covering signed basic calendar
  `-47120101`, signed extended calendar `-4712-01-01`, basic ordinal
  `2000001`, and basic ISO week-date `1999W526` TIM ISO-8601 inputs.
- [x] Add Orekit `DateComponentsTest.testParse` chronology J2000-day parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testParse`, covering the full source chronology table
  as MJD outputs for BC/year-zero dates, Julian leap-year `1500-02-29`,
  Gregorian-reform week dates, century non-leap dates, MJD epoch boundaries,
  and J2000 ordinal/week forms.
- [x] Add Orekit `DateComponentsTest.testMJD` modified-Julian-day parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testMJD`, covering exact MJD day outputs for
  `1858-11-17`, `1962-01-01`, and `2008-05-14`.
- [x] Add Orekit `DateComponentsTest.testISO8601Examples` date-form parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testISO8601Examples`, covering extended/basic calendar,
  extended/basic ordinal, and extended/basic ISO week forms that all resolve
  to `1985-04-12`.
- [x] Add Orekit `DateComponentsTest.testDayOfYear` ordinal mapping parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testDayOfYear`, covering common-year and leap-year
  ordinal dates such as `2003-365`, `2004-060`, and `2003-269`.
- [x] Add Orekit `DateComponentsTest.testWeekComponents` ISO week-date sweep
  coverage to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testWeekComponents`, covering year-boundary week dates
  from 1994 through 1999 plus 1582 Gregorian-reform week dates that skip from
  `1582-W40-4` to `1582-W40-5` as `1582-10-04` to `1582-10-15`.
- [x] Add Orekit invalid ISO week-date parser parity to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testConstructorBadWeek`, rejecting `2008-W53-1`
  because week 53 does not exist in a 52-week ISO week year.
- [x] Add Orekit invalid ISO weekday and malformed date parser parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testConstructorBadDayOfWeek1`,
  `testConstructorBadDayOfWeek2`, and `testConstructorBadString`, rejecting
  `2008-W43-0`, `2008-W43-8`, and malformed calendar year `197-05-01`.
- [x] Add Orekit `DateComponentsTest` Gregorian-reform calendar parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testReferenceDates` and `testParse`, covering the
  astronomical calendar transition where `1582-10-04` and `1582-10-15`
  are consecutive J2000/MJD days, including ISO week-date forms
  `1582-W40-4` and `1582-W40-5`.
- [x] Add Orekit `DateComponentsTest.testWellFormed` range endpoint parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `DateComponentsTest.testWellFormed`, covering the exact start/end J2000
  days for the source well-formed calendar ranges from `-4800` through
  `2005` as MJD outputs.
- [x] Add Orekit pre-1972 linear UTC-TAI offset parity to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `UTCScaleTest.testOffsets`, covering the `UTC-TAI.history` linear MJD
  offset formulas for 1961-01-02 and 1968-02-02 UTC to TAI conversion.
- [x] Add Orekit pre-1972 large leap-second label parity to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testLargeLeapSecond`, covering the
  `1960-12-31T23:59:61.4` UTC label as the same instant as
  1961-01-01 UTC shifted back by 22.818 ms.
- [x] Add Orekit UTC stress-offset leap-label parity to `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `UTCScaleTest.testCreatingInLeapDateLocalTime50HoursWest`, covering
  the `2008-12-29T21:59:60-50:00` stress-offset label normalized to the
  2008-12-31 UTC leap second.
- [x] Add initial Orekit CCSDS unsegmented CUC parse support to
  `foundation/time` and SDS `TIM`.
  Done 2026-05-26 in SDS `TIM` and `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSUnsegmentedNoExtension` and verify preamble
  `0x1F` with four coarse bytes and three fine bytes from the CCSDS epoch
  decodes to `2002-05-23T12:34:56.789000Z` UTC. The same test family now also
  covers Orekit's J2000 agency-epoch preamble `0x2F` CUC vector.
- [x] Add initial Orekit CCSDS unsegmented CUC target formatting to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSUnsegmentedNoExtension` and verify a UTC source
  instant converted to TAI `CCSDS_TIME_CODE` emits canonical CUC preamble
  `0x1F` with raw time field bytes
  `[0x53, 0x7F, 0x40, 0x90, 0xC9, 0xFB, 0xE7]`. Caller-selected target
  preamble metadata remains open.
- [x] Add Orekit CCSDS unsegmented CUC agency-epoch target preservation to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSUnsegmentedNoExtension` and verify an
  agency-epoch CUC source using J2000 TAI epoch metadata and preamble `0x2F`
  emits the same coarse bytes, fine bytes, preamble, and agency epoch when
  converted back to TAI `CCSDS_TIME_CODE`.
- [x] Add Orekit CCSDS unsegmented CUC extended-preamble target preservation to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSUnsegmentedWithExtendedPreamble` and verify
  preambles `0x9F`/`0x30` with five coarse octets and seven fine octets
  preserve the raw submicrosecond time-field bytes when converted back to TAI
  `CCSDS_TIME_CODE`.
- [x] Add initial Orekit CCSDS day-segmented CDS parse support to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSDaySegmented` and verify preamble `0x42` with
  two day bytes, four millisecond bytes, and four picosecond bytes from the
  CCSDS epoch decodes to `2002-05-23T12:34:56.789012Z` UTC at the module's
  ISO microsecond precision. The same test family now also covers Orekit's
  J2000 agency-epoch preamble `0x49` microsecond CDS vector. Caller-selected
  CDS target preamble metadata remains open.
- [x] Add initial Orekit CCSDS day-segmented CDS target formatting to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSDaySegmented` and verify a UTC source instant
  converted to UTC `CCSDS_TIME_CODE` emits canonical CDS preamble `0x42`
  with two day bytes, four millisecond bytes, and four picosecond bytes from
  the CCSDS epoch at the module's ISO microsecond precision.
- [x] Add Orekit CCSDS day-segmented CDS picosecond target preservation to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSDaySegmented` and verify a CCSDS-epoch CDS source
  with preamble `0x42` preserves its raw four-octet picosecond field when
  converted back to UTC `CCSDS_TIME_CODE`.
- [x] Add Orekit CCSDS day-segmented CDS agency-epoch target preservation to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSDaySegmented` and verify an agency-epoch CDS
  source using J2000 date epoch metadata and preamble `0x49` emits the same
  day bytes, millisecond bytes, microsecond field, preamble, and agency epoch
  when converted back to UTC `CCSDS_TIME_CODE`. Caller-selected target preamble
  metadata remains open.
- [x] Add initial Orekit CCSDS calendar-segmented CCS parse support to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSCalendarSegmented` and verify preamble `0x56`
  month/day and preamble `0x5E` day-of-year variants both decode to
  `2002-05-23T12:34:56.789012Z` UTC at the module's ISO microsecond
  precision. Broader CCSDS edge-case coverage remains open.
- [x] Add initial Orekit CCSDS calendar-segmented CCS target formatting to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSCalendarSegmented` and verify a calendar-segmented
  CCS source converted to UTC `CCSDS_TIME_CODE` emits source-kind-preserving
  CCS preamble `0x5B` with year, day-of-year, time-of-day, and three
  base-100 fractional-second bytes at the module's ISO microsecond precision.
  Caller-selected CCS target variant metadata remains open.
- [x] Add Orekit CCSDS calendar-segmented CCS month/day target preservation to
  `foundation/time`.
  Done 2026-05-26 in `foundation/time`; tests reference Orekit
  `AbsoluteDateTest.testCCSDSCalendarSegmented` and verify a month/day CCS
  source with preamble `0x56` preserves its raw calendar fields and six
  base-100 fractional-second bytes when converted back to UTC
  `CCSDS_TIME_CODE`.
- [ ] Expand `foundation/time` to full Orekit `time` and data-context behavior.
  Tests: `AbsoluteDate`, time-scale, leap-second, CCSDS time-code, and parser
  tests from Orekit `time/*Test.java`. FlatBuffer ports consume SDS
  `TIMConversionRequest` records and emit SDS `TIMConversionResult` records,
  using `TIMInstant` for source and target epochs.
- [ ] Create `foundation/frames` from Orekit `frames`.
  Tests: `FramesFactoryTest`, `TransformTest`, `TopocentricFrameTest`,
  `TEMEProviderTest`, `VersionedITRFFrameTest`, EOP loader tests, and encounter
  frame tests.
  - [x] Add initial Basilisk geodetic/frame conversion surface.
    Done 2026-05-26 in `foundation/frames`; tests reference Basilisk
    `src/architecture/utilities/tests/test_geodeticConversion.cpp`
    `testPCI2PCPF`, `testPCPF2PCI`, `testLLA2PCPF`, and `testPCPF2LLA`,
    plus `src/architecture/utilities/geodeticConversion.cpp` spherical
    `planetPoRad < 0` LLA/PCPF branches.
    The module consumes SDS `FRMFrameTransformRequest` and emits
    `FRMFrameTransformResult` through binary `FRM` payload frames. Full Orekit
    dynamic frames, EOP interpolation/provenance, topocentric frame instances,
    and encounter-frame parity remain open.
- [ ] Create `foundation/orbits` from Orekit `orbits` and
  `propagation/conversion`.
  Tests: Cartesian, Keplerian, circular, equinoctial conversion tests,
  Jacobian tests, mean/osculating conversion tests, and Basilisk
  `orbElemConvert` tests.
  - [x] Add initial SDS OMM Keplerian mean-elements to SDS OEM Cartesian
    state-vector conversion.
    Done 2026-05-24 in `foundation/orbits`; tests reference Orekit
    `KeplerianOrbitTest.testJacobianReferenceEllipse` with SI-to-SDS unit
    conversion, browser/WasmEdge SDK harnesses, and dual OMM/OEM FlatBuffer plus
    aligned-binary manifest contracts. Full orbit representation, Jacobian,
    mean/osculating, frame-aware, and Basilisk `orbElemConvert` parity remains
    open.
  - [x] Add initial SDS OEM Cartesian state-vector to SDS OMM Keplerian
    mean-elements conversion.
    Done 2026-05-24 in `foundation/orbits`; tests use the same Orekit
    `KeplerianOrbitTest.testJacobianReferenceEllipse` position/velocity vector
    and recover the source OMM elements with `GM` supplied by an SDS OMM
    `gravity_context` input, keeping gravity metadata explicit instead of a
    hard-coded Earth constant. Updated 2026-05-26 with Basilisk
    `TwoDimensionParabolic` OEM Cartesian inverse coverage that emits Barker
    OMM mean anomaly and zero mean motion for parabolic states. Full
    equinoctial/circular, Jacobian, mean/osculating, frame-aware, and Basilisk
    `orbElemConvert` parity remains open.
  - [x] Add initial SDS OPM Cartesian state-vector conversion surfaces.
    Done 2026-05-24 in `foundation/orbits`; tests reference the same Orekit
    `KeplerianOrbitTest.testJacobianReferenceEllipse` position/velocity vector
    encoded as SDS OPM. `opm_to_oem` emits a one-line SDS OEM ephemeris block,
    while `opm_to_omm` derives SDS OMM mean elements from the OPM Cartesian
    state using OPM `GM`. Updated 2026-05-26 with Basilisk
    `TwoDimensionParabolic` OPM Cartesian inverse coverage that emits Barker
    OMM mean anomaly and zero mean motion for parabolic states. Full OPM/OCM
    file-message parity, covariance, maneuver parameter handling, Jacobian,
    frame-aware, and parser/writer coverage remains open for
    `files/ccsds-messages` and downstream consumers.
  - [x] Add initial SDS OPM Keplerian true-anomaly to SDS OEM conversion.
    Done 2026-05-24 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `TwoDimensionElliptical` values encoded as SDS OPM Keplerian fields.
    `opm_keplerian_to_oem` derives the OEM state from OPM `TRUE_ANOMALY` and
    ignores deliberately wrong OPM Cartesian fields; `opm_keplerian_to_omm`
    normalizes the same OPM element record into SDS OMM by converting true
    anomaly to mean anomaly. Full OPM/OCM file-message parity, covariance,
    maneuver parameter handling, Jacobian, frame-aware, and parser/writer
    coverage remains open for `files/ccsds-messages` and downstream consumers.
  - [x] Add initial Basilisk circular singular-case recovery for SDS OEM
    Cartesian state-vector to SDS OMM mean-elements conversion.
    Done 2026-05-24 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `CircularInclined` and `CircularEquitorial` vectors. The converter now
    emits normalized OMM conventions for undefined angles: argument of latitude
    in `MEAN_ANOMALY` for circular inclined states, and true longitude in
    `MEAN_ANOMALY` for circular equatorial states. Parabolic,
    equinoctial/circular representation types, mean/osculating, Jacobian,
    frame-aware, and full Basilisk `orbElemConvert` parity remains open.
  - [x] Add Basilisk equatorial edge-case coverage for non-circular and
    retrograde circular SDS OMM/OEM conversions.
    Done 2026-05-24 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `NonCircularEquitorial`, `NonCircularNearEquitorial`, and
    `CircularEquitorialRetrograde` vectors. The non-circular equatorial inverse
    zeroes undefined RAAN and stores longitude of pericenter in
    `ARG_OF_PERICENTER` while preserving elliptic mean anomaly in
    `MEAN_ANOMALY`; the near-equatorial inverse preserves Basilisk's
    longitude-of-pericenter sum; the circular retrograde equatorial inverse
    zeroes RAAN and argument of pericenter and stores retrograde true longitude
    in `MEAN_ANOMALY`. Parabolic, equinoctial/circular representation types,
    mean/osculating, Jacobian, frame-aware, and full Basilisk `orbElemConvert`
    parity remains open.
  - [x] Add initial Basilisk hyperbolic OMM/OEM bidirectional conversion.
    Done 2026-05-24 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `TwoDimensionHyperbolic` `elem2rv` and `rv2elem` vectors. OMM
    `MEAN_ANOMALY` stores hyperbolic mean anomaly derived from the source true
    anomaly with `M=e*sinh(H)-H`. Parabolic, equinoctial/circular
    representation types, mean/osculating, Jacobian, frame-aware, and full
    Basilisk `orbElemConvert` parity remains open.
  - [x] Add initial Basilisk VCM Keplerian-to-Cartesian conversion.
    Done 2026-05-24 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `TwoDimensionElliptical` values encoded as SDS VCM `KEPLERIAN_ELEMENTS`.
    `vcm_keplerian_to_oem` derives the OEM state from VCM Keplerian fields and
    uses `STATE_VECTOR.EPOCH` for required OEM time metadata while ignoring a
    deliberately wrong VCM state vector. `vcm_keplerian_to_state` emits the
    same derived Cartesian values back into SDS VCM `STATE_VECTOR` while
    preserving VCM element metadata. Parabolic, frame-aware state
    transforms, covariance, and full VCM file-message parity remain open.
  - [x] Add initial Basilisk VCM Keplerian-to-OMM normalization.
    Done 2026-05-25 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `classicElementsToEquinoctialElements` classical values encoded as SDS VCM
    `KEPLERIAN_ELEMENTS`. `vcm_keplerian_to_omm` preserves VCM object
    metadata, uses VCM `GM`, uses `STATE_VECTOR.EPOCH` for OMM epoch metadata,
    and converts `TRUE_ANOMALY` to SDS OMM `MEAN_ANOMALY`. Parabolic,
    frame-aware state transforms, covariance, and full VCM file-message parity
    remain open.
  - [x] Add Basilisk KeplerianOrbit mean-motion output to OMM emitters.
    Done 2026-05-26 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilitiesSelfCheck/_UnitTest/test_keplerianOrbit.py`
    `test_unitKeplerianOrbit`, which asserts
    `n = sqrt(MU_EARTH / a**3)`. All OMM output paths now populate
    `MEAN_MOTION` in rev/day for finite positive `SEMI_MAJOR_AXIS` and `GM`.
    Period/energy scalar outputs remain open until SDS has an orbit-summary
    record or an appropriate target field.
  - [x] Add Basilisk orbital anomaly normalization for SDS VCM Keplerian
    elements.
    Done 2026-05-26 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilitiesSelfCheck/avsLibrarySelfCheck/avsLibrarySelfCheck.c`
    `testOrbitalAnomalies`, including `E2f`, `E2M`, `f2E`, `H2f`, `H2N`,
    `M2E`, and `N2H` constants. `vcm_keplerian_to_true_anomaly` and
    `vcm_keplerian_to_mean_anomaly` consume SDS VCM `KEPLERIAN_ELEMENTS` and
    emit SDS VCM Keplerian elements with the requested `ANOMALY_TYPE`,
    preserving object metadata and using SDS degree fields for elliptic and
    hyperbolic anomaly conventions. Barker parabolic anomaly support is tracked
    in the dedicated parabolic subtask below; frame-aware state transforms,
    covariance, and full VCM file-message parity remain open.
  - [x] Add Basilisk VCM hyperbolic Keplerian-to-OMM normalization.
    Done 2026-05-25 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `TwoDimensionHyperbolic` values encoded as SDS VCM `KEPLERIAN_ELEMENTS`.
    `vcm_keplerian_to_omm` now accepts finite hyperbolic VCM Keplerian states
    with negative `SEMI_MAJOR_AXIS`, `ECCENTRICITY > 1`, and `GM > 0`, then
    stores non-periodic hyperbolic mean anomaly in SDS OMM `MEAN_ANOMALY`.
    Parabolic, frame-aware state transforms, covariance, and full VCM
    file-message parity remain open.
  - [x] Add Basilisk rectilinear VCM Keplerian-to-Cartesian
    conversion.
    Done 2026-05-25 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `OrbitalMotion.elem2rv1DEccentric` and `OrbitalMotion.elem2rv1DHyperbolic`.
    The VCM path accepts
    `ECCENTRICITY=1`, non-zero `SEMI_MAJOR_AXIS`, `TRUE_ANOMALY`, and `GM > 0`,
    treats VCM `ANOMALY` as Basilisk's rectilinear anomaly for this singular
    source convention, and emits matching SDS OEM and VCM `STATE_VECTOR` Cartesian
    outputs. OMM mean-anomaly normalization remains unsupported for this
    rectilinear source convention; frame-aware state transforms, covariance,
    and full VCM file-message parity remain open.
  - [x] Add initial Basilisk VCM Cartesian state-vector conversion surfaces.
    Done 2026-05-25 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `CircularInclined` and `TwoDimensionElliptical` state vectors encoded as
    SDS VCM `STATE_VECTOR`.
    `vcm_state_to_oem` promotes the VCM state vector into OEM, while
    `vcm_state_to_omm` derives normalized SDS OMM elements from VCM
    `STATE_VECTOR` and `GM` while ignoring deliberately wrong VCM Keplerian
    fields. `vcm_state_to_keplerian` derives SDS VCM `KEPLERIAN_ELEMENTS`
    from the same state vector and emits `ANOMALY_TYPE=MEAN_ANOMALY` for
    elliptic and hyperbolic states.
    `vcm_state_to_equinoctial` derives SDS VCM `EQUINOCTIAL_ELEMENTS` from
    the same recovered elements.
    Frame-aware state transforms, covariance, and full VCM
    file-message parity remain open.
  - [x] Add Basilisk parabolic VCM Cartesian-to-Keplerian inverse recovery.
    Done 2026-05-25 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `TwoDimensionParabolic.rv2elem`. `vcm_state_to_keplerian` accepts a
    finite parabolic VCM `STATE_VECTOR` with `GM > 0`, emits
    `SEMI_MAJOR_AXIS=0`, `ECCENTRICITY=1`, and preserves the recovered
    parabolic true anomaly with `ANOMALY_TYPE=TRUE_ANOMALY` plus
    `PERIAPSIS_RADIUS`. Updated 2026-05-26 to preserve Basilisk
    `orbElemConvert` `rv2elem` signed conic-anomaly range for parabolic
    states, so a recovered true anomaly past `pi` remains negative instead of
    wrapping to `[0, 360)`. Updated again 2026-05-26 so
    `vcm_state_to_omm` normalizes recovered parabolic VCM state vectors into
    SDS OMM mean elements with Barker mean anomaly and zero mean motion.
    Updated 2026-05-26 so the same Barker OMM normalization is used for
    `cartesian_to_keplerian` OEM inverse inputs with OMM `gravity_context` and
    `opm_to_omm` OPM Cartesian inverse inputs.
    Equinoctial conversion remains fail-closed for parabolic states.
  - [x] Add Basilisk `orbElemConvert` parameter-sweep coverage.
    Done 2026-05-26 in `foundation/orbits`; tests port Basilisk
    `src/simulation/dynamics/DynOutput/orbElemConvert/_UnitTest/test_orb_elem_convert.py`
    `test_orb_elem_convert` over inclined/equatorial elliptic, circular,
    parabolic, and hyperbolic cases. The source SI values are converted to SDS
    VCM km, km/s, km^3/s^2, and degree fields, then verified through both
    `vcm_keplerian_to_state` and `vcm_state_to_keplerian` with true-anomaly
    normalization. Remaining `orbElemConvert` work is limited to any
    message-wrapper parity that is not part of the reusable FlatBuffer
    orbit-conversion surfaces.
  - [x] Add Basilisk parabolic VCM Keplerian-to-Cartesian forward conversion.
    Done 2026-05-25 in `foundation/orbits` and SDS `VCM`; tests reference
    Basilisk `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `TwoDimensionParabolic.elem2rv`. SDS VCM `KEPLERIAN_ELEMENTS` now carries
    `PERIAPSIS_RADIUS` so `vcm_keplerian_to_oem` and
    `vcm_keplerian_to_state` can convert `SEMI_MAJOR_AXIS=0`,
    `ECCENTRICITY=1`, `ANOMALY_TYPE=TRUE_ANOMALY` parabolic inputs to the
    Basilisk reference Cartesian state. Equinoctial conversion remains
    fail-closed for parabolic states.
  - [x] Add Barker-equation parabolic anomaly normalization for SDS VCM
    Keplerian elements.
    Done 2026-05-26 in `foundation/orbits`; tests use Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `TwoDimensionParabolic` for the source orbit and Barker's closed-form
    `M = tan(f/2) + tan(f/2)^3 / 3` relation for parabolic mean anomaly.
    `vcm_keplerian_to_true_anomaly` and `vcm_keplerian_to_mean_anomaly` now
    round-trip parabolic VCM `KEPLERIAN_ELEMENTS` when `PERIAPSIS_RADIUS` is
    present, and `vcm_keplerian_to_state` accepts parabolic
    `ANOMALY_TYPE=MEAN_ANOMALY` to recover the Basilisk Cartesian state.
    Updated 2026-05-26 so `vcm_keplerian_to_omm` accepts the same parabolic
    VCM elements and emits SDS OMM mean elements with Barker mean anomaly and
    zero mean motion. Equinoctial conversion remains fail-closed for parabolic
    states.
  - [x] Add initial Basilisk VCM Keplerian-to-equinoctial conversion.
    Done 2026-05-24 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `classicElementsToEquinoctialElements` values. The converter consumes SDS
    VCM `KEPLERIAN_ELEMENTS` with `TRUE_ANOMALY` or `MEAN_ANOMALY` and emits
    SDS VCM `EQUINOCTIAL_ELEMENTS` with `AF`, `AG`, `CHI`, `PSI`, `N`, and true
    longitude `L`. Parabolic, circular representation types,
    mean/osculating, Jacobian, frame-aware, and full Basilisk `orbElemConvert`
    parity remains open.
  - [x] Add initial Basilisk VCM equinoctial-to-Keplerian conversion.
    Done 2026-05-24 in `foundation/orbits`; tests reuse Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `classicElementsToEquinoctialElements` expected values as the input
    equinoctial state and recover the original classical elements as SDS VCM
    `KEPLERIAN_ELEMENTS` with `ANOMALY_TYPE=TRUE_ANOMALY`. Parabolic,
    mean/osculating, Jacobian, frame-aware, and full Basilisk
    `orbElemConvert` parity remains open.
  - [x] Add initial Basilisk VCM equinoctial-to-OMM normalization.
    Done 2026-05-25 in `foundation/orbits`; tests reuse Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `classicElementsToEquinoctialElements` expected values as the input SDS VCM
    equinoctial state. `vcm_equinoctial_to_omm` recovers the original
    non-circular elliptical classical elements, converts recovered
    `TRUE_ANOMALY` to SDS OMM `MEAN_ANOMALY`, uses VCM `GM`, and uses
    `STATE_VECTOR.EPOCH` for OMM epoch metadata. Parabolic, mean/osculating,
    Jacobian, frame-aware, and full Basilisk `orbElemConvert` parity remain
    open.
  - [x] Add initial Basilisk VCM equinoctial-to-Cartesian conversion.
    Done 2026-05-25 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `TwoDimensionElliptical` `elem2rv` position and velocity vectors, encoded
    through SDS VCM `EQUINOCTIAL_ELEMENTS` derived from the same source
    classical elements. `vcm_equinoctial_to_oem` recovers true-anomaly
    Keplerian elements, uses VCM `GM`, and uses `STATE_VECTOR.EPOCH` for OEM
    state metadata. `vcm_equinoctial_to_state` emits the same Cartesian result
    as an SDS VCM `STATE_VECTOR`. Parabolic, mean/osculating, Jacobian,
    frame-aware, and full Basilisk `orbElemConvert` parity remain open.
  - [x] Add Basilisk circular VCM equinoctial inverse conversion.
    Done 2026-05-25 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `CircularInclined` and `CircularEquitorial` cases encoded as SDS VCM
    `EQUINOCTIAL_ELEMENTS` with `AF=0` and `AG=0`. The converter accepts
    finite circular prograde equinoctial states, treats `L` as true longitude,
    derives RAAN from `CHI`/`PSI` when inclination is defined, normalizes
    undefined argument of pericenter to zero, emits `ANOMALY_TYPE=TRUE_ANOMALY`,
    and supports `equinoctial_to_keplerian`, `vcm_equinoctial_to_omm`, and
    `vcm_equinoctial_to_state`. Parabolic, mean/osculating, Jacobian,
    frame-aware, retrograde equinoctial singular handling, and full Basilisk
    `orbElemConvert` parity remain open.
  - [x] Add Basilisk Hill relative-state conversion.
    Done 2026-05-25 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilitiesSelfCheck/avsLibrarySelfCheck/avsLibrarySelfCheck.c`
    `testOrbitalHill` and the `orbitalMotion.c` `rv2hill`/`hill2rv`
    conventions.
    `vcm_pair_to_cdm_relative_hill` consumes chief and deputy SDS VCM
    Cartesian `STATE_VECTOR` records and emits an SDS CDM with
    `RELATIVE_POSITION_R/T/N` and `RELATIVE_VELOCITY_R/T/N` populated in the
    Basilisk radial/transverse/normal Hill frame.
    `cdm_relative_hill_to_vcm_deputy_state` consumes chief SDS VCM
    `STATE_VECTOR` plus SDS CDM relative Hill fields and emits the deputy SDS
    VCM Cartesian `STATE_VECTOR`. Frame-aware transforms, covariance, and full
    Basilisk `orbElemConvert` parity remain open.
  - [x] Add Basilisk J2 mean/osculating conversion.
    Done 2026-05-26 in `foundation/orbits` and SDS `GRV`; tests reference
    Basilisk `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `classicElementsToMeanElements`, which calls `clMeanOscMap` with
    `req=300.0`, `J2=1e-3`, and `sgn=1` for mean-to-osculating mapping; tests
    also cover the documented `sgn=-1` osculating-to-mean branch using the
    same vector set.
    `vcm_keplerian_mean_to_osculating` and
    `vcm_keplerian_osculating_to_mean` consume SDS VCM
    `KEPLERIAN_ELEMENTS` plus SDS GRV `EQUATORIAL_RADIUS`/`J2` and emit SDS
    VCM `KEPLERIAN_ELEMENTS`. Jacobian, frame-aware transforms, covariance,
    and full Basilisk `orbElemConvert` parity remain open.
  - [x] Add Basilisk J2-J6 zonal perturbation acceleration.
    Done 2026-05-26 in `foundation/orbits` and SDS `GRV`; tests reference
    Basilisk `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `jPerturb_order_6` and assert the current compiled `orbitalMotion.c`
    `jPerturb` output for `r=[6200,100,2000]` km, order 6, and Basilisk Earth
    `MU`, `REQ`, and `J2` through `J6` constants. The upstream fixture's
    literal check vector is recorded in `docs/test-vector-extraction-index.json`
    but is stale; upstream still passes it because `v3IsEqual(..., 11)` is an
    absolute tolerance of 11.
    `vcm_state_to_j_zonal_acceleration_oem` consumes SDS VCM `STATE_VECTOR`
    plus SDS GRV `MU`/`EQUATORIAL_RADIUS`/`J2`-`J6` and emits SDS OEM
    acceleration fields with `STATE_VECTOR_SIZE=9`. Shared force-model
    extraction into a dedicated environment/forces module and HPOP imports
    remain open.
  - [x] Add Basilisk solar radiation pressure acceleration.
    Done 2026-05-26 in `foundation/orbits`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `solarRadiationPressure` and assert the current compiled `orbitalMotion.c`
    `solarRad` output for `A=2 m^2`, `m=50 kg`, `sunvec=[1,0.3,-0.2]` AU,
    `Cr=1.3`, `flux=1372.5398 W/m^2`, and `c=299792458 m/s`. The upstream
    fixture's literal check vector appears to use an older solar flux value;
    upstream still passes it because `v3IsEqual(..., 11)` is an absolute
    tolerance of 11.
    `vcm_state_to_srp_acceleration_oem` consumes SDS VCM `STATE_VECTOR`,
    VCM `MASS`/`SOLAR_RAD_AREA`/`SOLAR_RAD_COEFF`, plus SDS CRD `sun_vector`
    `X/Y/Z` in AU and emits SDS OEM acceleration fields with
    `STATE_VECTOR_SIZE=9`. Shared force-model extraction into a dedicated
    environment/forces module and HPOP imports remain open.
- [ ] Create `foundation/bodies-geometry` from Orekit `bodies` and
  `geometry/fov`.
  Tests: `OneAxisEllipsoidTest`, geodetic point tests, CR3BP factory/system
  tests, JPL ephemerides loader tests, loxodrome tests, field-of-view tests,
  and Basilisk ground-location tests.
- [ ] Create `data/space-data-loaders` from Orekit `data`.
  Tests: directory/list/classpath/network crawler tests, zip/gzip/Unix
  compression filter tests, data-source tests, and data-context separation
  tests.
- [ ] Update every existing module that performs private time conversion to
  import `foundation/time`.
- [ ] Update every existing module that performs private frame transforms to
  import `foundation/frames`.
- [ ] Update every existing module that performs private orbit element
  conversion to import `foundation/orbits`.

## Phase 2: Orekit Propagation, Force, Environment, And File Modules

- [ ] Create `files/ccsds-messages` for CCSDS ADM, ODM, TDM, and CDM parsing
  and writing.
  Tests: Orekit APM/AEM/ACM, OPM/OEM/OMM/OCM, TDM, CDM KVN/XML parser and
  writer tests.
- [ ] Create `files/orbit-products` for SP3, SINEX, ILRS CPF/CRD, IIRV, STK,
  and general ephemeris files.
  Tests: Orekit SP3 parser/writer/interpolation tests, SINEX parser tests, CPF
  and CRD parser/writer tests, IIRV tests, and STK ephemeris tests.
- [ ] Create `files/gnss-products` for RINEX observation/navigation/clock,
  ANTEX, SSR, RTCM, Hatanaka, GPS RF link, and Ntrip input handling.
  Tests: Orekit RINEX, Hatanaka, ANTEX, SSR, RTCM, clock, and GPS RF link
  tests.
- [ ] Create `models/earth-environment` for atmospheric, ionospheric,
  tropospheric, weather, geomagnetic, geoid, displacement, and tessellation
  models.
  Tests: Orekit atmosphere, CSSI space weather, JB2008 data, Klobuchar, GIM,
  NeQuick, Saastamoinen, Vienna, Niell, WMM, IGRF, displacement, and
  tessellation tests plus Basilisk MSIS, WMM, albedo, eclipse, Denton, and
  solar-flux tests.
- [ ] Create `propagator/analytical` for Kepler, Eckstein-Hechler,
  Brouwer-Lyddane, GNSS, Intelsat 11 elements, and analytical ephemeris
  variants.
  Tests: Orekit analytical propagation test classes and GNSS analytical tests.
- [ ] Update `propagator/sgp4` for Orekit SDP4/SGP4 parity and TLE generation.
  Tests: Orekit TLE propagator and TLE generation tests plus existing Vallado
  SGP4 vectors.
- [ ] Create `propagator/dsst` for Orekit DSST propagation and DSST force
  models.
  Tests: Orekit DSST force, propagation, and orbit determination test classes.
- [ ] Update `propagator/hpop` to import shared `foundation/*`,
  `models/earth-environment`, and shared force-model modules instead of owning
  duplicate atmosphere/time/force logic.
  Tests: Orekit numerical propagation, force model, event, and Jacobian tests.
  - [x] Declare existing HPOP resident-state binary stream methods in the SDK
    manifest.
    Done 2026-05-25 in `propagator/hpop`; `ingest_state`,
    `propagate_state`, `prepare_trajectory_segments`, and
    `describe_trajectory_segments` are now manifest-visible with SDS
    FlatBuffer ports and 8-byte aligned-binary `PropagatorState` handoff where
    applicable. The SDK invoke bridge now routes those manifest methods to
    HPOP's native resident-state stream implementation, and
    `tests/intermodule_sgp4_import.test.mjs` proves an aligned-binary
    `PropagatorState` emitted by `propagator/sgp4` can be handed directly into
    HPOP `ingest_state`, then propagated back out as an aligned-binary HPOP
    `PropagatorState`. `docs/module-import-descriptors.json` now records that
    handoff as a checked import descriptor, and
    `tests/module_import_descriptors.test.mjs` verifies the descriptor fails
    closed for missing modules, schema/name mismatches, FlatBuffer file
    identifier mismatches, and incompatible provider versions.
    `tests/sdk_compat.test.mjs` verifies the method and port
    contracts, `npm test` verifies the public entrypoint through the SDK
    package export, and `bash build.sh` regenerated the embedded manifest bytes
    in both browser and isomorphic artifacts. HPOP still needs to replace its
    duplicated atmosphere/time/force internals with imports of the shared
    foundation and environment modules.
- [ ] Update `propagator/atmosphere` to become the reusable atmosphere query
  owner for launch, reentry, HPOP, DSST, and Basilisk environment modules.
  Tests: Orekit atmosphere tests, US76/NRLMSISE independent cases, and Basilisk
  atmosphere tests.
  - [x] Add initial SDS HFC binary direct-method contract for atmosphere
    altitude-batch queries.
    Done 2026-05-25 in `propagator/atmosphere`; `query_atmosphere_state_batch`
    now accepts SDS `HFC.fbs` `$HFC` records with `ATMOSPHERE`, `ALTITUDE_M`,
    optional `SPEED_M_PER_S`, and optional per-sample `SAMPLE_EPOCHS`,
    `LATITUDE_DEG`, and `LONGITUDE_DEG`, emits typed SDS HFC `states` with
    preserved sample metadata plus density, temperature, pressure,
    speed-of-sound, speed, dynamic-pressure, and Mach arrays, and declares both
    regular FlatBuffer and aligned-binary HFC port types. The NRLMSIS00E HFC
    path now applies per-sample epochs and coordinates to NRLMSISE-00
    position/time inputs, with browser and WasmEdge tests proving
    local-solar-time density and temperature variation. It also accepts an
    optional typed SDS `SPW.fbs` `space_weather` input, maps F10.7/F10.7A/Ap
    into NRLMSISE-00 solar activity, and verifies browser/WasmEdge
    space-weather density and temperature variation. Browser and WasmEdge
    behavior tests cover the HFC direct method while the legacy JSON `invoke`
    bridge remains for compatibility. The HFC USSA density path now also ports Basilisk
    `orbitalMotion.c` `atmosphericDensity` references for 200 km and 2000 km
    into native C++ tests and checks the 200 km value through browser and
    WasmEdge HFC invoke. The C++ model layer also ports Basilisk
    `debyeLength` references for 400 km, 1000 km, 10000 km, and 34000 km with
    SI input/output native tests, plus the Basilisk `atmosphericDrag` source
    vector as SI acceleration. Direct HFC Debye output remains blocked until
    SDS exposes a Debye-length field or a force-model/environment record. Full
    Orekit atmosphere-model parity and shared `models/earth-environment`
    imports remain open.
  - [x] Add Basilisk atmospheric drag direct VCM/OEM surface.
    Done 2026-05-26 in `propagator/atmosphere`; tests reference Basilisk
    `src/architecture/utilities/tests/test_orbitalMotion.cpp`
    `OrbitalMotion.atmosphericDrag` for `r=[6200,100,2000]` km,
    `v=[1,9,1]` km/s, `A=2 m^2`, `Cd=0.2`, and `m=50 kg`.
    `vcm_state_to_drag_acceleration_oem` consumes SDS VCM `STATE_VECTOR` plus
    VCM `MASS`/`DRAG_AREA`/`DRAG_COEFF`, calls the shared Basilisk-compatible
    atmosphere model layer, and emits SDS OEM acceleration fields with
    `STATE_VECTOR_SIZE=9`. HPOP, DSST, and future force-model modules still
    need to import this atmosphere owner instead of keeping private drag
    implementations.
- [ ] Update `propagator/cislunar` with Orekit CR3BP/Lagrange trajectory tests
  and imports from `foundation/time`, `foundation/frames`, and
  `foundation/orbits`.
- [ ] Create `propagator/events` for eclipse, node, apside, alignment,
  elevation, ground mask, date, latitude/longitude/altitude, FOV, zone,
  inter-satellite view, night, maneuver, geomagnetic, TCA, beta-angle, and
  relative-distance events.
  Tests: Orekit propagation event detector and event-filtering tests.
- [ ] Create `propagator/ephemeris` for tabulated, file-based, memory-based,
  and integration-generated ephemerides.
  Tests: Orekit ephemeris segment, bounded propagator, interpolation, and
  sampling tests.

## Phase 3: Orekit Analysis Modules

- [ ] Create `attitude/laws` for Orekit attitude state, interpolation,
  switching, nadir/center/target/yaw/LOF/inertial/body-pointed/spin-stabilized,
  aligned-and-constrained, GNSS attitude, torque-free, and ADM export behavior.
  Tests: Orekit `attitudes/*Test.java` and CCSDS ADM parser/writer tests.
- [ ] Update `analysis/maneuver` for Orekit small analytical maneuvers,
  impulse maneuvers, continuous maneuvers, low-thrust triggers, propulsion
  models, and force-model parameter hooks.
  Tests: Orekit maneuver, propulsion, trigger, and Jacobian tests.
- [ ] Update `analysis/lambert-izzo` to be the shared Lambert primitive for
  Orekit IOD Lambert and Basilisk Lambert modules.
  Tests: Orekit `IodLambertTest`, Basilisk `lambertSolver`,
  `lambertPlanner`, `lambertSecondDV`, `lambertValidator`, and
  `lambertSurfaceRelativeVelocity` tests.
- [ ] Create `analysis/optimal-control` for Orekit indirect optimal control,
  adjoint equations, energy cost functions, Hamiltonian evaluation, and
  single-shooting solvers.
  Tests: Orekit `control/*Test.java` classes.
- [ ] Update `analysis/od` for Orekit batch least squares, sequential least
  squares, EKF, ESKF, UKF, semi-analytical filters, RTS smoothing, parameter
  estimation, multi-satellite OD, ephemeris-based OD, and propagator-specific
  OD.
  Tests: Orekit `estimation/leastsquares`, `estimation/sequential`, and
  existing SDN OD tests.
- [ ] Create `analysis/iod-measurements` for Gibbs, Gooding, Lambert, Gauss,
  Laplace, Herrick-Gibbs, range, range-rate, turn-around range,
  azimuth/elevation, RA/Dec, PV, position, inter-satellite, GNSS code/phase,
  TDOA, FDOA, bi-static, modifiers, and measurement generation.
  Tests: Orekit `estimation/iod` and `estimation/measurements` tests.
- [ ] Update `analysis/covariance` for Orekit STM propagation, Keplerian
  extrapolation, inertial/Earth-fixed/LOF frame transforms, Cartesian/
  Keplerian/circular/equinoctial type transforms, and blending interpolation.
  Tests: Orekit covariance-related propagation and estimation tests plus
  independent closed-form covariance transform cases.
- [ ] Update `analysis/conjunction-assessment` for Orekit CDM import/export
  and all Orekit short-term 2D probability methods: Chan 1997, Alfriend 1999,
  Alfriend 1999 maximum, Alfano 2005, Patera 2005, and Laas 2015.
  Tests: Orekit `ssa/collision` tests, CCSDS CDM parser/writer tests, SOCRATES
  replay, and Aerospace IVV tests already used by the module.
- [x] Wire native CDM FlatBuffers output coverage into
  `analysis/conjunction-assessment` CMake/ctest.
  Done 2026-05-26 in `analysis/conjunction-assessment`; ctest target
  `cdm_output` now runs the existing C++ coverage for single and
  size-prefixed batch `$CDM` output buffers, generated FlatBuffers verifier
  acceptance, SDS CDM header/relative-state/object/probability fields, and
  buffer-capacity errors. Orekit CDM parser/writer import/export fixture parity
  is tracked by the following child items under the parent item.
- [x] Add SDS CSM summary output coverage and command-surface support to
  `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; ctest target
  `csm_output` verifies SDS `$CSM` FlatBuffers output, object IDs,
  Unix-seconds TCA conversion, range/speed/probability/dilution fields, and
  buffer-capacity errors. The command manifest exposes `emit_csm` with
  `sds.csm` aligned-binary output, and the WasmEdge command harness verifies
  SGP4-sampled track requests emit non-empty `$CSM` bytes.
- [x] Add SDS CDM aligned-binary import for probability computation in
  `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native
  `compute_pc_from_cdm` verifies `$CDM` FlatBuffers, maps CDM relative state and
  object covariance into the local Pc engine, rejects truncated CDM input, and
  the command manifest exposes `compute_pc_from_cdm` with `sds.cdm` input and
  aligned-binary `ConjunctionPcResult` output. Object-state, frame-preserving
  real-CDM coverage is tracked by the later file-backed Patera/Laas child item.
- [x] Add Orekit CDM KVN parser/writer fixture parity to
  `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native C++
  `cdm_kvn_to_sds` parses Orekit 13.1 `CDMExample1.txt`-derived KVN header,
  TCA, miss distance, object metadata, state vectors, and RTN covariance into
  SDS `$CDM` aligned-binary bytes with module km/km² unit normalization, and
  `cdm_sds_to_kvn` writes those bytes back to CCSDS meter-unit KVN. The command
  manifest exposes `parse_cdm_kvn` and `write_cdm_kvn`, and the WasmEdge
  command harness round-trips the Orekit fixture through both methods.
- [x] Add Orekit CDM XML parser/writer fixture parity to
  `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native C++
  `cdm_xml_to_sds` parses Orekit 13.1 `CDMExample1.xml`-derived XML header,
  relative metadata/data, relative state, collision probability, object
  metadata, state vectors, and RTN covariance into SDS `$CDM` aligned-binary
  bytes with module km/km² unit normalization, and `cdm_sds_to_xml` writes those
  bytes back to CCSDS-style XML. The command manifest exposes `parse_cdm_xml`
  and `write_cdm_xml`, the SDK compatibility test validates the manifest
  surface, and the WasmEdge command harness round-trips the Orekit fixture
  through both methods.
- [x] Add Orekit SSA Patera2005 scalar probability vectors to
  `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native C++ tests
  reference Orekit `Patera2005Test` scalar cases 01-08, CSM 1-3, and CDM 1-2,
  asserting unitless collision probabilities at the source tolerances.
- [x] Replace the local `chan` probability path with Orekit `Chan1997` parity
  and add authoritative scalar probability vectors.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native C++ tests
  reference Orekit `Chan1997Test` scalar cases 01-12, CSM 1-3, CDM 1-2, and
  Alfano cases 3 and 5, asserting unitless collision probabilities at the
  source tolerances while preserving `CHAN-2008` as a factory alias.
- [x] Add Orekit SSA `Alfriend1999` and `Alfriend1999Max` scalar probability
  vectors to `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native C++ tests
  reference Orekit `Alfriend1999Test` and `Alfriend1999MaxTest` Armellin
  appendix scalar vectors, asserting the unitless nominal and maximum
  collision probabilities at the source `1e-6` tolerance.
- [x] Add Orekit SSA `Alfano2005` scalar probability vectors to
  `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native C++ tests
  reference Orekit `Alfano2005Test` scalar cases 01-12, CSM 1-3, CDM 1-2,
  and Alfano cases 3 and 5, asserting unitless collision probabilities at the
  source tolerances while preserving the existing `alfano` maximum-probability
  factory alias.
- [x] Add Orekit SSA `Laas2015` scalar probability and bound vectors to
  `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native C++ tests
  reference Orekit `Laas2015Test` scalar cases 01-12, CSM 1-3, CDM 1-2,
  and Alfano cases 3 and 5, asserting unitless collision probabilities plus
  lower and upper probability bounds where the source test provides them.
- [x] Add Orekit file-backed Patera/Laas real-CDM probability cases to
  `analysis/conjunction-assessment`.
  Done 2026-05-26 in `analysis/conjunction-assessment`; native C++ tests parse
  Orekit 13.1 `ION_SCV8_vs_STARLINK_1233.txt` through `cdm_kvn_to_sds`, then
  verify `compute_pc_from_cdm` matches Orekit's real-CDM Patera and Laas
  probabilities. The CDM parser now preserves object `REF_FRAME` in SDS, and
  `compute_pc_from_cdm` uses object Cartesian states when available, converts
  object RTN covariances through the state frame, and applies Earth-fixed
  velocity correction for ITRF-like frames.
- [ ] Create `analysis/dop` for Orekit GNSS dilution-of-precision support.
  Tests: Orekit DOP and GNSS constellation visibility tests.
  Initial 2026-05-26 slice: `analysis/dop` now has a browser/WasmEdge C++ SDK
  artifact at `dist/isomorphic/module.wasm`, an aligned-binary `compute_dop`
  request/result contract, closed-form tetrahedral GDOP/PDOP/HDOP/VDOP/TDOP
  coverage, and insufficient-visible-satellite elevation-mask coverage. The
  checkbox remains open until Orekit GNSS DOP and constellation visibility
  vectors are ported.
- [ ] Update `analysis/access` to browser/WasmEdge C++ artifact parity and
  shared event/frames/body imports.
  Tests: Orekit rise/set/elevation/FOV event tests and existing access-window
  tests.
- [x] Add SDK artifact compliance and browser/WasmEdge target metadata to
  `analysis/access`.
  Done 2026-05-26 in `analysis/access`; the manifest now advertises
  `runtimeTargets: ["browser", "wasmedge"]`, build metadata points at
  `dist/isomorphic/module.wasm`, the generated embedded manifest matches those
  targets, and the package test verifies `validatePluginArtifact` accepts the
  raw isomorphic WASM artifact. Existing native ground-station,
  access-window, AOS/LOS, and scheduling tests still pass. The parent access
  parity item remains open for shared module imports and Orekit event-vector
  coverage.
- [x] Add fail-closed SDK response-envelope behavior to `analysis/access`
  `plugin_invoke_stream`.
  Done 2026-05-26 in `analysis/access`; `plugin_invoke_stream` now parses the
  SDK invoke envelope, returns a decodable `PluginInvokeResponse` FlatBuffer
  instead of a null pointer, reports unknown methods as SDK errors, and
  rejects missing or invalid ACW request frames with explicit SDK errors.
- [x] Promote access request/result records to SDS `ACW` and retarget the
  `analysis/access` manifest.
  Done 2026-05-26 in SDS `schema/ACW/main.fbs` and `analysis/access`; the
  manifest now advertises one canonical `ACW.fbs` schema with file identifier
  `$ACW` and root `ACW`, and both request and result ports accept regular
  FlatBuffer plus aligned-binary `ACW` type refs. Verified with
  `npm test -- test/acw.schema.test.js`, `npm run build -- --force`, and
  `npm test` in `analysis/access`.
- [x] Add SDS ACW stream compute behavior to `analysis/access`
  `plugin_invoke_stream`.
  Done 2026-05-26 in `analysis/access`; the direct invoke bridge now reads the
  SDK request arena, validates an ACW request frame on the request port,
  verifies `$ACW`, converts `ACWGroundStation` and `ACWStateSample` records
  into the existing native C++ access-window algorithm, and emits an SDS ACW
  result frame on the results port. Verified with
  `node --test test/manifestContract.test.mjs` and `npm test` in
  `analysis/access`.
- [x] Add an Orekit topocentric tracking-coordinate vector to
  `analysis/access`.
  Done 2026-05-26 in `analysis/access`; the JS access geometry test now maps
  Orekit `TopocentricFrameTest.testInverseGetTopocentricCoordinates` vectors
  into WGS84 Earth-fixed ECEF states and verifies azimuth, elevation, and range
  recovery. The access analyzer normalizes azimuth to Orekit's `[0, 2*pi)`
  convention, and `docs/test-vector-extraction-index.json` records the source
  mapping as `orekit-access-topocentric-inverse-tracking-coordinates`.
- [x] Add Orekit elevation-mask interpolation to `analysis/access`.
  Done 2026-05-26 in `analysis/access`; `computeAccessWindows` accepts
  `elevationMaskDeg` or `elevationMaskRad`, normalizes circular azimuths using
  Orekit `ElevationMask` semantics, and routes masked AOS/LOS switching through
  a native C++ runtime export. The regression maps Orekit
  `ElevationDetectorTest.testEventForMask` mask points into a WGS84
  Earth-fixed sample sequence and records the source mapping as
  `orekit-access-elevation-mask-interpolation` in
  `docs/test-vector-extraction-index.json`.
- [x] Add Orekit standard-atmosphere refraction switching to
  `analysis/access`.
  Done 2026-05-26 in `analysis/access`; `computeAccessWindows` accepts
  `refractionModel: "earth-standard-atmosphere"` and routes apparent-elevation
  AOS/LOS switching through the native C++ effects export, while
  `computeAccessGeometry` reports both geometric and apparent elevation. The
  regression maps Orekit `ElevationDetectorTest.testHorizon` and
  `EarthStandardAtmosphereRefraction` default pressure/temperature behavior as
  `orekit-access-earth-standard-atmosphere-refraction` in
  `docs/test-vector-extraction-index.json`.
- [x] Add Orekit pressure/temperature refraction correction aliases to
  `analysis/access`.
  Done 2026-05-26 in `analysis/access`; `refractionModel` now accepts Orekit
  setter-style `pressure` and `temperature` names as well as
  `pressurePa`/`temperatureK`, then forwards the corrected model into
  apparent-elevation geometry and native AOS/LOS switching. The regression maps
  Orekit `ElevationDetectorTest.testPresTemp` and
  `EarthStandardAtmosphereRefraction.setPressure`/`setTemperature` behavior as
  `orekit-access-earth-standard-atmosphere-refraction-pressure-temperature` in
  `docs/test-vector-extraction-index.json`.
- [x] Add Orekit ITU-R P.834 atmospheric-refraction vectors to
  `analysis/access`.
  Done 2026-05-26 in `analysis/access`; `refractionModel` now accepts
  `ITURP834AtmosphericRefraction`/`itu-r-p834`, derives station altitude from
  the selected ground station unless explicitly supplied, and uses Orekit's
  ITU-R P.834 tau-zero formula with the low-elevation clamp for direct
  apparent-elevation geometry and native AOS/LOS switching. The regression maps
  Orekit `EarthITURP834AtmosphericRefractionTest` Everest, Dead Sea, Kiruna,
  and Hartebeesthoek source vectors as
  `orekit-access-iturp834-atmospheric-refraction` in
  `docs/test-vector-extraction-index.json`.
- [x] Add SDS ACW elevation-mask and refraction request fields to
  `analysis/access` stream invoke.
  Done 2026-05-26 in SDS `schema/ACW/main.fbs` and `analysis/access`;
  `ACWRequest` now carries `ELEVATION_MASK` and `REFRACTION_MODEL`, generated
  SDS bindings expose those fields for TypeScript, JavaScript, C++, JSON
  schema, and FB JSON schema consumers, and `plugin_invoke_stream` validates
  and applies the fields before native access-window computation. The stream
  regression is recorded against the existing Orekit `ElevationMask` and
  `EarthStandardAtmosphereRefraction` mappings in
  `docs/test-vector-extraction-index.json`.
- [ ] Finish `analysis/coverage` native parity by replacing remaining JS-only
  coverage paths with C++ SDK methods and importing access/FOV/swath
  primitives. Tests: current coverage tests plus Orekit FOV footprint tests.
  Done 2026-05-26: initial C++ SDK artifact now builds at
  `dist/isomorphic/module.wasm`, advertises browser/WasmEdge targets, passes SDK
  compliance checks, and exposes native grid creation, footprint accumulation,
  interval, FOM, heatmap, statistics, and sensor-union aligned-binary methods.
- [ ] Finish `analysis/swath` native parity by replacing the remaining JS-only
  methods with C++ SDK methods and importing shared geometry and frames.
  Tests: Orekit FOV footprint and ground-projection tests.
  Done 2026-05-26: initial C++ SDK artifact now builds at
  `dist/isomorphic/module.wasm`, advertises browser/WasmEdge targets, passes SDK
  compliance checks, exposes native `project_footprint` conical footprint
  projection against the Orekit FOV footprint-on-ellipsoid contract, emits
  native geodetic `ground_track` state-batch output, classifies targets with
  `point_in_footprint`, computes target access geometry with `access_geometry`,
  generates native swath segments with `generate_swath`, and handles conical,
  rectangular, and caller-provided custom sensor footprint rays in the native
  footprint path.
- [ ] Update `analysis/sensor-coverage` after active sensor-coverage lock
  clears, preserving sensor-owned time-dynamic swath behavior and importing
  shared access/swath/FOV modules. The module is now closed-tier and lives at
  `packages/sensor-coverage` in `space-data-network-closed-modules`; this item
  is tracked there.

## Phase 4: GNSS Modules

- [ ] Create `gnss/navigation-products` for GPS, QZSS, Galileo, GLONASS,
  BeiDou, NavIC, SBAS navigation messages, clocks, ephemerides, and
  constellation-specific propagation helpers.
- [ ] Add `gnss/navigation-products` tests from Orekit GNSS navigation file,
  RINEX, SSR, RTCM, antenna, clock, and navigation-message decoding tests.
- [ ] Import existing RF modules only for RF link calculations; do not merge RF
  path-loss code into GNSS navigation modules.
- [ ] Add FlatBuffer ports for GNSS observation streams, navigation products,
  DOP results, and antenna/clock correction products.

## Phase 5: Basilisk Runtime And Simulation Modules

- [ ] Update `basilisk/runtime` with full message dictionary exposure, typed
  payload mapping, deterministic snapshot/restore, scenario replay, and
  fail-closed import checks.
- [ ] Create `basilisk/dynamics/DynOutput`.
- [ ] Create `basilisk/dynamics/ExtPulsedTorque`.
- [ ] Create `basilisk/dynamics/FuelTank`.
- [ ] Create `basilisk/dynamics/GravityGradientEffector`.
- [ ] Create `basilisk/dynamics/HingedRigidBodies`.
- [ ] Create `basilisk/dynamics/Integrators`.
- [ ] Create `basilisk/dynamics/LinearSpringMassDamper`.
- [ ] Create `basilisk/dynamics/MtbEffector`.
- [ ] Create `basilisk/dynamics/NHingedRigidBodies`.
- [ ] Create `basilisk/dynamics/RadiationPressure`.
- [ ] Create `basilisk/dynamics/Thrusters`.
- [ ] Create `basilisk/dynamics/VSCMGs`.
- [ ] Create `basilisk/dynamics/constraintEffector`.
- [ ] Create `basilisk/dynamics/dragEffector`.
- [ ] Create `basilisk/dynamics/dualHingedRigidBodies`.
- [ ] Create `basilisk/dynamics/extForceTorque`.
- [ ] Create `basilisk/dynamics/facetDragEffector`.
- [ ] Create `basilisk/dynamics/facetSRPDynamicEffector`.
- [ ] Create `basilisk/dynamics/gravityEffector`.
- [ ] Create `basilisk/dynamics/hingedRigidBodyMotor`.
- [ ] Create `basilisk/dynamics/linearTranslationalBodies`.
- [ ] Create `basilisk/dynamics/msmForceTorque`.
- [ ] Create `basilisk/dynamics/prescribedMotion`.
- [ ] Create `basilisk/dynamics/reactionWheels`.
- [ ] Create `basilisk/dynamics/spacecraft`.
- [ ] Create `basilisk/dynamics/spacecraftSystem`.
- [ ] Create `basilisk/dynamics/sphericalPendulum`.
- [ ] Create `basilisk/dynamics/spinningBodies`.
- [ ] Create `basilisk/dynamics/stateArchitecture`.
- [ ] Add authoritative tests for every `basilisk/dynamics/*` module from the
  matching upstream Basilisk `_UnitTest` file and at least one independent
  closed-form dynamics case when the upstream test is smoke-only.
- [ ] Create `basilisk/environment/ExponentialAtmosphere`.
- [ ] Create `basilisk/environment/MsisAtmosphere`.
- [ ] Create `basilisk/environment/TabularAtmosphere`.
- [ ] Create `basilisk/environment/albedo`.
- [ ] Create `basilisk/environment/dentonFluxModel`.
- [ ] Create `basilisk/environment/eclipse`.
- [ ] Create `basilisk/environment/ephemerisConverter`.
- [ ] Create `basilisk/environment/groundLocation`.
- [ ] Create `basilisk/environment/groundMapping`.
- [ ] Create `basilisk/environment/magneticFieldCenteredDipole`.
- [ ] Create `basilisk/environment/magneticFieldWMM`.
- [ ] Create `basilisk/environment/planetEphemeris`.
- [ ] Create `basilisk/environment/solarFlux`.
- [ ] Create `basilisk/environment/spacecraftLocation`.
- [ ] Create `basilisk/environment/spiceInterface` with a documented CSPICE
  and kernel-data packaging strategy.
- [ ] Add authoritative tests for every `basilisk/environment/*` module from
  upstream Basilisk tests and shared Orekit environment tests where behavior
  overlaps.
- [ ] Create `basilisk/sensors/camera`.
- [ ] Create `basilisk/sensors/coarseSunSensor`.
- [ ] Create `basilisk/sensors/hingedRigidBodyMotorSensor`.
- [ ] Create `basilisk/sensors/imuSensor`.
- [ ] Create `basilisk/sensors/magnetometer`.
- [ ] Create `basilisk/sensors/pinholeCamera`.
- [ ] Create `basilisk/sensors/planetHeading`.
- [ ] Create `basilisk/sensors/planetNav`.
- [ ] Create `basilisk/sensors/simpleMassProps`.
- [ ] Create `basilisk/sensors/simpleNav`.
- [ ] Create `basilisk/sensors/simpleVoltEstimator`.
- [ ] Create `basilisk/sensors/starTracker`.
- [ ] Add authoritative tests for every `basilisk/sensors/*` module from the
  matching upstream Basilisk unit tests.
- [ ] Create `basilisk/power/ReactionWheelPower`.
- [ ] Create `basilisk/power/encoder`.
- [ ] Create `basilisk/power/hingedBodyLinearProfiler`.
- [ ] Create `basilisk/power/instrument`.
- [ ] Create `basilisk/power/motorThermal`.
- [ ] Create `basilisk/power/motorVoltageInterface`.
- [ ] Create `basilisk/power/prescribedLinearTranslation`.
- [ ] Create `basilisk/power/prescribedRotation1DOF`.
- [ ] Create `basilisk/power/sensorThermal`.
- [ ] Create `basilisk/power/simpleBattery`.
- [ ] Create `basilisk/power/simplePowerMonitor`.
- [ ] Create `basilisk/power/simplePowerSink`.
- [ ] Create `basilisk/power/simpleSolarPanel`.
- [ ] Create `basilisk/power/spaceToGroundTransmitter`.
- [ ] Create `basilisk/power/stepperMotor`.
- [ ] Create `basilisk/power/storageUnit`.
- [ ] Create `basilisk/power/tempMeasurement`.
- [ ] Create `basilisk/power/transmitter`.
- [ ] Add authoritative tests for every `basilisk/power/*` module from
  upstream Basilisk power, thermal, data-handling, and device-interface tests.

## Phase 6: Basilisk FSW And Optical Modules

- [ ] Create `basilisk/fsw/attitude-control/lowPassFilterTorqueCommand`.
- [ ] Create `basilisk/fsw/attitude-control/mrpFeedback`.
- [ ] Create `basilisk/fsw/attitude-control/mrpPD`.
- [ ] Create `basilisk/fsw/attitude-control/mrpSteering`.
- [ ] Create `basilisk/fsw/attitude-control/mtbFeedforward`.
- [ ] Create `basilisk/fsw/attitude-control/mtbMomentumManagement`.
- [ ] Create `basilisk/fsw/attitude-control/mtbMomentumManagementSimple`.
- [ ] Create `basilisk/fsw/attitude-control/prvSteering`.
- [ ] Create `basilisk/fsw/attitude-control/rateServoFullNonlinear`.
- [ ] Create `basilisk/fsw/attitude-control/thrMomentumManagement`.
- [ ] Create `basilisk/fsw/attitude-determination/CSSEst`.
- [ ] Create `basilisk/fsw/attitude-determination/InertialUKF`.
- [ ] Create `basilisk/fsw/attitude-determination/headingSuKF`.
- [ ] Create `basilisk/fsw/attitude-determination/okeefeEKF`.
- [ ] Create `basilisk/fsw/attitude-determination/sunlineEKF`.
- [ ] Create `basilisk/fsw/attitude-determination/sunlineEphem`.
- [ ] Create `basilisk/fsw/attitude-determination/sunlineSEKF`.
- [ ] Create `basilisk/fsw/attitude-determination/sunlineSuKF`.
- [ ] Create `basilisk/fsw/attitude-determination/sunlineUKF`.
- [ ] Create `basilisk/fsw/attitude-guidance/attRefCorrection`.
- [ ] Create `basilisk/fsw/attitude-guidance/attTrackingError`.
- [ ] Create `basilisk/fsw/attitude-guidance/celestialTwoBodyPoint`.
- [ ] Create `basilisk/fsw/attitude-guidance/constrainedAttitudeManeuver`.
- [ ] Create `basilisk/fsw/attitude-guidance/eulerRotation`.
- [ ] Create `basilisk/fsw/attitude-guidance/hillPoint`.
- [ ] Create `basilisk/fsw/attitude-guidance/inertial3D`.
- [ ] Create `basilisk/fsw/attitude-guidance/inertial3DSpin`.
- [ ] Create `basilisk/fsw/attitude-guidance/locationPointing`.
- [ ] Create `basilisk/fsw/attitude-guidance/mrpRotation`.
- [ ] Create `basilisk/fsw/attitude-guidance/oneAxisSolarArrayPoint`.
- [ ] Create `basilisk/fsw/attitude-guidance/opNavPoint`.
- [ ] Create `basilisk/fsw/attitude-guidance/rasterManager`.
- [ ] Create `basilisk/fsw/attitude-guidance/simpleDeadband`.
- [ ] Create `basilisk/fsw/attitude-guidance/sunSafePoint`.
- [ ] Create `basilisk/fsw/attitude-guidance/velocityPoint`.
- [ ] Create `basilisk/fsw/attitude-guidance/waypointReference`.
- [ ] Create `basilisk/fsw/effector-interfaces/dipoleMapping`.
- [ ] Create `basilisk/fsw/effector-interfaces/errorConversion`.
- [ ] Create `basilisk/fsw/effector-interfaces/forceTorqueThrForceMapping`.
- [ ] Create `basilisk/fsw/effector-interfaces/hingedJointArrayMotor`.
- [ ] Create `basilisk/fsw/effector-interfaces/hingedRigidBodyPIDMotor`.
- [ ] Create `basilisk/fsw/effector-interfaces/jointMotionCompensator`.
- [ ] Create `basilisk/fsw/effector-interfaces/prescribedRot2DOF`.
- [ ] Create `basilisk/fsw/effector-interfaces/rwMotorTorque`.
- [ ] Create `basilisk/fsw/effector-interfaces/rwMotorVoltage`.
- [ ] Create `basilisk/fsw/effector-interfaces/rwNullSpace`.
- [ ] Create `basilisk/fsw/effector-interfaces/solarArrayReference`.
- [ ] Create `basilisk/fsw/effector-interfaces/thrFiringRemainder`.
- [ ] Create `basilisk/fsw/effector-interfaces/thrFiringSchmitt`.
- [ ] Create `basilisk/fsw/effector-interfaces/thrForceMapping`.
- [ ] Create `basilisk/fsw/effector-interfaces/thrMomentumDumping`.
- [ ] Create `basilisk/fsw/effector-interfaces/thrustRWDesat`.
- [ ] Create `basilisk/fsw/effector-interfaces/thrusterPlatformReference`.
- [ ] Create `basilisk/fsw/effector-interfaces/thrusterPlatformState`.
- [ ] Create `basilisk/fsw/effector-interfaces/torque2Dipole`.
- [ ] Create `basilisk/fsw/effector-interfaces/torqueScheduler`.
- [ ] Create `basilisk/fsw/effector-interfaces/vscmgGimbalRateServo`.
- [ ] Create `basilisk/fsw/effector-interfaces/vscmgVelocitySteering`.
- [ ] Create `basilisk/fsw/configuration-data/rwConfigData`.
- [ ] Create `basilisk/fsw/configuration-data/vehicleConfigData`.
- [ ] Create `basilisk/fsw/dv-guidance/dvAttGuidance`.
- [ ] Create `basilisk/fsw/dv-guidance/dvExecuteGuidance`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/chebyPosEphem`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/dvAccumulation`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/ephemDifference`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/ephemNavConverter`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/etSphericalControl`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/formationBarycenter`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/hillStateConverter`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/hillToAttRef`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/lambertPlanner`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/lambertSecondDV`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/lambertSolver`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/lambertSurfaceRelativeVelocity`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/lambertValidator`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/meanOEFeedback`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/navAggregate`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/oeStateEphem`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/smallBodyNavEKF`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/smallBodyNavUKF`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/smallBodyWaypointFeedback`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/spacecraftPointing`.
- [ ] Create `basilisk/fsw/orbit-formation-navigation/spacecraftReconfig`.
- [ ] Create `basilisk/fsw/state-estimation/thrustCMEstimation`.
- [ ] Create `basilisk/optical/CSSSensorData`.
- [ ] Create `basilisk/optical/IMUSensorData`.
- [ ] Create `basilisk/optical/STSensorData`.
- [ ] Create `basilisk/optical/TAMSensorData`.
- [ ] Create `basilisk/optical/centerRadiusCNN`.
- [ ] Create `basilisk/optical/faultDetection`.
- [ ] Create `basilisk/optical/horizonOpNav`.
- [ ] Create `basilisk/optical/houghCircles`.
- [ ] Create `basilisk/optical/limbFinding`.
- [ ] Create `basilisk/optical/pixelLineBiasUKF`.
- [ ] Create `basilisk/optical/pixelLineConverter`.
- [ ] Create `basilisk/optical/rateMsgConverter`.
- [ ] Create `basilisk/optical/relativeODuKF`.
- [ ] Create `basilisk/optical/scanningInstrumentController`.
- [ ] Create `basilisk/optical/simpleInstrumentController`.
- [ ] Add authoritative tests for every Basilisk FSW and optical module from
  the matching upstream Basilisk `_UnitTest` file.
- [ ] Keep `basilisk/mujoco/*` deferred until the MuJoCo WASM bridge, license,
  runtime assets, and MJCF FlatBuffer asset contract are documented.

## Phase 7: Current Module Retrofit

- [ ] Remove vendored SGP4 duplication from `analysis/od` after it imports
  `propagator/sgp4`.
- [ ] Remove vendored SGP4 duplication from `analysis/conjunction-assessment`
  after it imports `propagator/sgp4`.
- [ ] Remove private `nrlmsise00` and `us76` copies from `propagator/hpop`
  after it imports `propagator/atmosphere` or `models/earth-environment`.
- [ ] Convert any remaining `runtimeTargets: ["browser", "node"]` parity
  modules to browser/WasmEdge shared artifact targets or document why the
  module is outside Orekit/Basilisk parity scope.
- [x] Update `analysis/access` manifest and tests to match SDK command or
  stream invoke surfaces used by the rest of the parity suite.
  Done 2026-05-26 in `analysis/access`; manifest-contract tests now verify
  direct SDK invoke metadata, the browser/WasmEdge isomorphic artifact, and
  canonical SDS `ACW.fbs`/`$ACW` request/result type refs for both FlatBuffer
  and aligned-binary stream payloads.
- [ ] Delete or supersede legacy JS-only coverage/swath module paths once their
  C++ replacements pass SDK compatibility.
- [ ] Ensure all module package READMEs describe import dependencies and
  authoritative test sources.
- [ ] Ensure every imported dependency is versioned in the manifest or package
  metadata and is checked at runtime.

## Phase 8: Verification And Completion Audit

- [ ] Run native C++ tests for each created or updated module.
- [ ] Run each module's Node SDK invoke tests.
- [ ] Run each module through SDK browser harness loading.
- [ ] Run each module through WasmEdge invocation using the same
  `dist/isomorphic/module.wasm`.
- [ ] Run `node --test tests/sdk_compat.test.mjs` or the repo-level
  `./scripts/test-sdk-compat.sh` path for completed modules.
- [ ] Run `npm run generate:basilisk-plan` after any Basilisk plan generator
  or Basilisk source mapping change.
- [ ] Run `npm run check:basilisk-plan` after any Basilisk plan or standards map
  change.
- [ ] Run `npm run generate:basilisk-unit-test-ports` after any Basilisk
  source-test inventory or unit-test ownership rule change.
- [ ] Run `npm run check:basilisk-unit-test-ports` after any Basilisk
  unit-test port index change.
- [ ] Run `npm test` from `space-data-network-modules`.
- [ ] Run `git submodule status` from the stack root.
- [ ] Run `git submodule foreach 'git status --short --branch'` from the stack
  root.
- [ ] For every explicit requirement in the active goal, record the file,
  command output, test result, or artifact proving completion before marking
  the goal complete.
