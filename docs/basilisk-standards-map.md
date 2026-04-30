# Basilisk Standards Map

This document tracks the Basilisk-to-SDS mapping required before Basilisk SDN
modules can be marked complete.

## Mapping Rules

- Use SDS schemas from `../spacedatastandards.org/schema/*/main.fbs`.
- Use `XTC` for telemetry and command dictionary definitions.
- Use orbital and attitude standards where they are more specific than `XTC`.
- Add SDS schemas upstream before representing durable exchange data locally.
- Keep transient solver internals module-local only when they are not
  externally visible and have a FlatBuffer fallback for invoke ports.

## Initial Family Mapping

| Basilisk family | Primary SDS standards | XTCE required | Notes |
| --- | --- | --- | --- |
| Runtime and messaging | `XTC`, `PIV`, `TAB`, `PLG`, `REC`, `MBL`, `PNM` | Yes | Message dictionaries, scenario inputs, invoke payloads, module identity |
| Dynamics and propagation | `OPM`, `OEM`, `OCM`, `OSM`, `MNV`, `MET`, `MPE`, `AEM`, `APM` | Sometimes | Use orbit/attitude schemas for external state; `XTC` for actuator buses |
| Environment | `OEM`, `EOP`, `ATM`, `ENV`, `GNO`, `LND`, `RFM`, `XTC` | Sometimes | SPICE/kernel metadata may need bundle metadata and host capabilities |
| Sensors and navigation | `AEM`, `APM`, `OEM`, `TDM`, `TRK`, `RFM`, `XTC` | Yes | Sensor packets and command/config buses should carry XTCE dictionaries |
| Power, thermal, devices, data handling | `XTC`, `ENV`, `PHY`, `TIM` | Yes | Mostly telemetry/command and engineering parameters |
| FSW guidance/control | `AEM`, `APM`, `ACM`, `ATD`, `MET`, `MPE`, `MNV`, `XTC` | Yes | Control commands and actuator interfaces need XTCE dictionaries |
| Orbit/formation/navigation | `OMM`, `OPM`, `OEM`, `OCM`, `OSM`, `TDM`, `AEM`, `APM`, `MNV` | Sometimes | Prefer CCSDS-derived orbit/attitude schemas |
| Optical navigation/image processing | `XTC`, `AEM`, `APM`, `OEM`, `SEN` | Yes | Image metadata and algorithm outputs may expose SDS gaps |

## Payload Inventory

Populate this table during the inventory phase.

| Basilisk payload | Basilisk owner | SDS schema | File ID | Wire format | Units/frame/time | Fixture |
| --- | --- | --- | --- | --- | --- | --- |

## Family Mapping Detail

| Basilisk payload family | Primary SDS schemas | XTCE required | Gap notes |
| --- | --- | --- | --- |
| Runtime/module invocation, scheduler, message graph, recorder/replay, scenario step/reset | `PLG`, `PIV`, `TAB`, `REC`, `MBL`, `PNM`, `EPM` | Yes | `XTC` should describe exposed Basilisk message dictionaries |
| Time and frames: `Epoch`, `SpiceTime`, `TDBVehicleClockCorrelation`, `SynchClock`, frame-tagged vectors | `TIM`, `RFM`, `EOP` | Sometimes | Need consistent Basilisk frame graph/body frame metadata |
| Orbit/translation/navigation: `SCStates`, `NavTrans`, `TransRef`, `Ephemeris`, `SpicePlanetState`, `ClassicElements`, `HillRelState`, `SmallBodyNav*` | `OPM`, `OEM`, `OMM`, `OCM`, `VCM` | Sometimes | Need lossless handling of Basilisk SI vectors and frame/time metadata |
| Attitude/guidance/navigation attitude: `NavAtt`, `AttRef`, `AttGuid`, `AttState`, `RateCmd`, `STAtt`, `STSensor`, `BodyHeading`, `InertialHeading`, filters | `APM`, `AEM`, `ACM`, `ATD`, `RFM`, `TIM` | Sometimes | Likely SDS gap for first-class MRP attitude/error representation |
| Maneuver/orbit control/Lambert: `DvBurnCmd`, `DvExecutionData`, `ReconfigBurn*`, `DesiredVelocity`, `Lambert*` | `MNV`, `MNF`, `MPE`, `MET`, `OCM` | Sometimes | Likely gap for Lambert request/result/diagnostic records |
| Tracking/access/ground/observations: `Access`, `GroundState`, `Landmark`, optical-navigation line-of-sight | `TDM`, `TRK`, `EOO`, `SIT`, `GNO` | Sometimes | Ground access and landmark semantics need exact mapping |
| Environment and force-model I/O: `AtmoProps`, `Albedo`, `Eclipse`, `SolarFlux`, `PlasmaFlux`, `MagneticField`, `GravityGradient` | `ATM`, `ENV`, `GRV`, `SPW`, `EOP`, `OEM`, `RFM`, `TIM` | Sometimes | Likely gap for instantaneous local environment vectors |
| Sensors and raw measurements: `Acc*`, `IMUSensor*`, `CSS*`, `ST*`, `TAM*`, `Camera*`, `OpNav*`, `PixelLineFilter` | `SEN`, `IDM`, `SDR`, `EOO` | Yes | Likely gaps for camera image blobs, circle/limb/pixel-line products, IMU/CSS/TAM/ST measurement records |
| Actuators/effectors/device I/O: `CmdForce*`, `CmdTorqueBody`, `RW*`, `THR*`, `MTB*`, `VSCMG*`, motor and stepper commands | `XTC`, `BUS`, `PHY`, `MNV`, `OCM` | Yes | Significant gap for actuator config/status schemas |
| Power, thermal, data, fuel: `Power*`, `Volt`, `Temperature`, `FuelTank`, `Data*`, `SwData`, `Device*` | `BUS`, `COM`, `CMS`, `IDM`, `XTC` | Yes | Likely gap for runtime electrical, thermal, storage, and propellant status records |
| Physical properties, flexible bodies, MuJoCo: `VehicleConfig`, `SCMassProps`, `SCEnergyMomentum`, `HingedRigidBody`, `JointArrayState`, `MJ*`, `ChargeMsm` | `ACM`, `OCM`, `BUS`, `PHY` | Sometimes | Likely gap for multibody generalized coordinates, mass matrices, joint reactions, and Basilisk-specific dynamics internals |
| Visualization/adapters/tests: `Color`, `VizUserInput`, `RealTimeFactor`, `TypesTest`, templates | `CZM` only for OrbPro/Cesium adapters | No | Keep non-durable template/test payloads out of SDS |
