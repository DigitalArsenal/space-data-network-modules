# Basilisk Inventory For SDN Modules

This inventory was created from the stack checkout at
`/Users/tj/software/orbpro-stack` for the Basilisk SDN module effort.

## Existing WASM Baseline

The upstream Basilisk WASM test runner passes:

```text
node run_tests.js --quick
Tests run: 1810
Passed: 1810
Failed: 0
```

This is the current binding parity anchor, not a substitute for per-module
authoritative numerical tests.

## Proposed Module Granularity

Use a hybrid model:

- `basilisk/runtime` owns scheduler, messaging, scenario execution,
  deterministic stepping, snapshot/restore, and replay.
- Family modules own reusable capability groups: dynamics, environment,
  sensors/navigation, power/thermal/data handling, FSW guidance/control,
  orbit/formation/navigation, and optical/image processing.

This avoids one opaque monolith while still keeping cross-cutting Basilisk
runtime state in one place.

## Bound WASM Surfaces

### Core Runtime And Messaging

Bound or present: `SysModel`, `SimModel`, `SysProcess`, `SysModelTask`, task and
process control, time utilities, Eigen/STL wrappers, and logging/utilities.
CMake generates C interfaces for 122 C payload headers. The checked-in WASM
artifact directly exposes a smaller payload/message subset.

Blockers: `expose_messaging_wasm.cpp` exists but appears not wired into the
main CMake WASM builds inspected here. Full SDN runtime work needs message
dictionary exposure, typed payload mapping, deterministic snapshot/restore, and
scenario replay.

### Simulation Dynamics

Bound or present: spacecraft, gravity, integrators, reaction wheels, thrusters,
fuel, drag/SRP, facet drag/SRP, external force/torque, pulsed torque, VSCMG,
MTB, hinged/dual/N-hinged bodies, linear translation, spinning bodies,
spring-mass-damper, spherical pendulum, prescribed motion, constraints, MSM,
bore angle, and orbital element conversion.

Notes: `spacecraftSystem` source is compiled, but no public WASM class/factory
was identified. `stateArchitecture` is likely internal rather than a standalone
SDN surface.

### Environment

Bound or present: eclipse, ground location/mapping, spacecraft location,
exponential/tabular/MSIS atmosphere, albedo, solar flux, Denton flux, centered
dipole, WMM, planet ephemeris, and ephemeris converter.

Blockers: `spiceInterface` binding source exists, but the actual WASM artifact
does not expose `SpiceInterface` or `createSpiceInterface`; current tests
document this as expected due CSPICE/kernel dependencies.

### Sensors And Navigation

Bound or present: simpleNav, planetNav, planetHeading, pinholeCamera, IMU, star
tracker, coarse sun sensor, magnetometer, simple mass props, simple volt
estimator, and hinged rigid body motor sensor.

Blockers: visual `camera` module is not directly bound. OpenCV.js bridge docs
cover camera effects, hough circles, and limb finding.

### Power, Thermal, Device, And Data Handling

Bound or present: simple battery, solar panel, power sink/monitor, reaction
wheel power, motor/sensor thermal, encoder, motor voltage interface, temperature
measurement, prescribed rotation/translation, stepper motor, hinged body
profiler, instruments, transmitters, space-to-ground transmitter, and storage
units.

Notes: Vizard `dataFileToViz` and `vizInterface` should stay adapter/deferred
unless mapped to OrbPro/Cesium-facing SDS outputs.

### FSW

Bound or present: inertial/hill/velocity/sun/celestial pointing, MRP rotation,
attitude reference correction, tracking error, waypoint reference, MRP
feedback/PD/steering, PRV steering, rate servo, low-pass torque, MTB
feedforward, thruster momentum management, CSS WLS, sunline EKF/UKF/ephem,
InertialUKF, headingSuKF, RW/voltage/dipole/thruster/VSCMG/joint interfaces,
Lambert suite, formation barycenter, small-body EKF/UKF, relativeODuKF,
pixelLineBiasUKF, faultDetection, thrust CM estimation, DV accumulation,
navAggregate, sensor interface converters, RW config, and vehicle config.

Deferred or incomplete: constrained attitude maneuver, eulerRotation,
oneAxisSolarArrayPoint, opNavPoint, rasterManager, simpleDeadband,
mtbMomentumManagement variants, okeefeEKF, sunlineSEKF/SuKF, dvGuidance, many
effector-interface helpers, most formation-flying helpers, image-processing
modules, and cheby/ephem translation-determination modules.

### MuJoCo

Source packages and tests exist. Direct WASM bindings were not identified. The
documented path is a JavaScript bridge to MuJoCo WASM.

## Authoritative Test Sources

Use upstream `_UnitTest` pytest files as the primary Basilisk parity source.
The inventory found 214 test files across simulation and FSW. Strong anchors:

- spacecraft, integrators, gravity, reaction wheels, thrusters, fuel, drag, and
  SRP tests;
- eclipse, MSIS, WMM, albedo, and ground tests;
- simpleNav, IMU, star tracker, CSS, and magnetometer tests;
- power, data handling, thermal, and device tests;
- unit tests for each bound FSW family.

Use examples as integration and Sandcastle sources:

- `scenarioBasicOrbit`
- `scenarioIntegrators`
- `scenarioAttitudeFeedback*`
- `scenarioAttitudeSteering`
- `scenarioLambertSolver`
- `scenarioFormation*`
- `scenarioDrag*`
- `scenarioAlbedo`
- `scenarioMagneticField*`
- `scenarioTAM*`
- `scenarioPowerDemo`
- `scenarioDataDemo`
- `scenarioGround*`
- `scenarioSmallBody*`
- `OpNavScenarios/*`
- `BskSim/*`
- `examples/mujoco/*`

The existing WASM JS tests are binding and browser smoke tests. Many are
existence or round-trip checks, so they must be paired with numerical
authoritative tests before module completion.

## Cross-Cutting Blockers

- SDS mapping for all Basilisk message payload headers.
- Full direct JS exposure for all payload classes needed by module ports.
- SPICE/CSPICE and kernel packaging strategy.
- OpenCV/DNN packaging strategy for image modules.
- MuJoCo bridge, license, and runtime assets.
- Deterministic snapshot/replay API.
- SDK-compliant `PLG`/`PIV`/`TAB` manifests and `dist/isomorphic/module.wasm`
  packaging for each module.
- Browser and WasmEdge compatibility for the same artifact.
- Pinned runtime data for WMM, atmosphere, Denton, albedo, camera fixtures, ML
  weights, and MJCF assets.
