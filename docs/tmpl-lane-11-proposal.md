# TMPL lane 11 — SDS contract proposal for HPOP and conjunction assessment

**Status: PROPOSED, NOT RATIFIED OR IMPLEMENTED.** This lane changes only this
file. The coordinator owns SDS ratification, publication, dependency refresh,
and landing. No standard code, binding, manifest, physics source, or WASM artifact
is changed here. The proposed `$CQR` code is provisional until the coordinator
repeats the registry collision check.

## 1. Decision and evidence baseline

**Extend existing `$PRW` for HPOP; introduce one `$CQR` conjunction request/result
family. Reuse `$FRM`, `$TIM`, `$OMM`, `$OEM`, `$OCM`, `$PPE`, `$CDM`, `$CSM`, and
`$PCE`. Keep `$PIV`/`$TAB` as the invoke envelope.** Neither module needs a new
invoke ABI. Native SPK and CDM text bytes travel inside a typed FlatBuffer table,
not behind an incorrectly labelled payload or as a raw-text port.

The alternatives “register orbpro aliases”, “put JSON in `$AST`”, and “rename a
file identifier without changing its bytes” do not resolve the contract. Existing
`$PRW` already owns runtime init/batch semantics; a new HPOP-specific root would
duplicate that responsibility. `$PPE` already owns polynomial coefficients;
no new trajectory polynomial standard is needed.

### Revisions and scope

| Evidence | Exact revision / version |
| --- | --- |
| Modules branch base (`origin/main`, fetched for this lane) | `1682a8d832148343b70270d2bb8d7e58faee8966` |
| SDK canonical source consulted | `1362cccb044fcc945b7e8356b5392359e6f543e3` |
| SDS canonical source consulted | `f95c2cf8b1b1357e7e4a1fc4617682bcecc992af` |
| Lane-10 reproducible checker/package baseline | SDK `0.8.18`, SDS `1.217.0`, flatc-wasm `26.1.32` |
| HPOP declared dependencies at base | SDK `file:../../../../ancillary-packages/space-data-module-sdk`; SDS `^1.195.0` |
| Conjunction declared/locked dependencies at base | SDK `0.8.18`; SDS `1.217.0` |

The canonical HPOP installation actually contained SDK `0.8.15` and SDS
`1.140.0`; conjunction's canonical installation had SDK `0.8.15` and no local SDS
package. Those installations are not the lane-10 evidence pin. This lane uses an
isolated installation of conjunction's lockfile for checks. Do not mistake a
checkout's schema availability for availability in a consumer's installed pin.

The stack bootstrap names a nested `packages/spacedatastandards.org/schema/`
path, but at the inspected SDS revision the tracked IDL is **`schema/*/main.fbs`
at the SDS repository root**. These are the source paths cited below; the
coordinator must resolve the destination against the actual SDS checkout.

Source links below are relative to the modules repository. SDK/SDS citations
use repository-relative paths plus the revisions above. The graphify query
located an older contract task, but current source and measured checker output,
not the graph's historical conclusions, determine this proposal.

### Contract boundaries

- Public contract inventory covers all five HPOP manifest methods and all twelve
  conjunction manifest methods, plus callable unadvertised conjunction methods.
- Module C exports for setting forces, loading fields, and direct catalog drawing
  are implementation/legacy host APIs, not additional declared PIV methods.
  They must not remain an alternative production physics path in JavaScript.
- A field appearing in a generated header is not proof that the runtime honors
  it. The inventory explicitly identifies ignored fields and metadata defects.
- Preserve successful numerical behavior in C++; deliberately fix ambiguous
  units, invalid input acceptance, unknown frames, and dishonest metadata with
  documented compatibility errors rather than silent reinterpretation.

## 2. Exact current HPOP contract

Sources: [manifest](../propagator/hpop/plugin-manifest.json),
[JSON dispatch and implementation](../propagator/hpop/src/cpp/src/plugin_runtime.cpp),
[entrypoints](../propagator/hpop/src/cpp/src/plugin_entrypoints.cpp),
[resident implementation](../propagator/hpop/src/hpop_plugin.cpp),
[bridge](../propagator/hpop/src/cpp/src/plugin_invoke_bridge.cpp).
The compiled resident implementation is `src/hpop_plugin.cpp`, not the retained
`src/cpp/wasm_api_reference.cpp`.

### 2.1 PIV methods and payload identity

| Method | Input | Output | Cardinality and behavior |
| --- | --- | --- | --- |
| `invoke` | `request`: UTF-8 JSON falsely declared `orbpro.hpop.InvokeRequest`; optional `kernel`: `$NCD` descriptor plus SPK trailer | `response`: UTF-8 JSON falsely declared `orbpro.hpop.InvokeResponse` | request 1; kernel 0..1; response 0..1; single-shot |
| `ingest_state` | `state`: `orbpro.plugins.PropagatorState`, `PRST` | none | 1..1024 input streams; replaces resident catalog; sequential indices assigned in input order |
| `propagate_state` | `request`: `orbpro.propagator.PropagatorBatchRequest`, no identifier | `state`: `PRST` | 1 request; 0..1024 states; empty handle list selects all; positive output cap smaller than requested count fails |
| `prepare_trajectory_segments` | `PropagatorPrepareTrajectorySegmentsRequest`, no identifier | `PropagatorPrepareTrajectorySegmentsResult`, `PTSS` | one request/result; ensures resident coverage and allocates segment-set handle |
| `describe_trajectory_segments` | `PropagatorDescribeTrajectorySegmentsRequest`, no identifier | `PropagatorDescribeTrajectorySegmentsResult`, `PTDS` | one request/result; returns overlapping cached segments |

All methods declare `maxBatch:1`. Resident methods advertise both FlatBuffer and
aligned-binary peers, alignment 8. Their payloads are actually variable-sized
FlatBuffer tables; pointer alignment is not a distinct fixed aligned layout.
The bridge adapts SDS PIV into a private StreamInvokeRequest carrying module
memory pointers; those pointers are not portable wire addresses.

`kernel` currently means `[u32le descriptorLength][$NCD bytes][SPK bytes]`,
`FORMAT=SPK_DAF`. Its bytes are invocation-scoped. Omitted kernel selects
`Analytical`; a supplied kernel selects `JPL_SPK`, fails explicitly on invalid
coverage, and must never silently fall back. `params.ephemerisSource` can request
`Analytical` or must match the actual selected source. A numeric ephemeris query
requires a kernel. See `src/cpp/include/hpop/kernel_scope.h`.

### 2.2 JSON request, types, aliases, defaults

Top level: `{operation:string, params?:object}`; operation is required; params
falls back to `{}`. Operations are exactly `version`, `propagate`, `ephemeris`,
`atmosphere`. Unknown operations fail. Numeric scalar types below are C++
`double` unless stated; arrays have the specified double layout.

| Operation / field | Type, default, semantics |
| --- | --- |
| `version` | No parameters; result `{version:"0.1.0", plugin:"hpop-propagator"}` (manifest version is `1.0.0`) |
| `propagate.epochJD`, `targetJD` | required double Julian dates, TDB; `(targetJD-epochJD)*86400` seconds |
| `position`, `velocity` | required double arrays, first 3 entries used; geocentric GCRF km and km/s |
| `epochTimeScale` | string default `TDB`; any other value rejected |
| `spacecraft.massKg` / `mass`, `spacecraft.areaM2` / `area` | doubles default 1000 kg, 10 m²; first alias wins |
| `integrator.method` | case-insensitive string: RK4, RKF45, RKF78, RK78, RKDP87, ABM, BS, COWELL, ENCKE, EQUINOCTIALVOP; default RK78 |
| `integrator.initialStep`, `minStep`, `maxStep` | seconds; defaults 60, 1, 3600 |
| `integrator.absTolerance`, `relTolerance` | defaults 1e-12 each; current scalar absolute tolerance applied to mixed km/km/s components; relative dimensionless |
| `integrator.tolerance` | when present overrides **both** preceding tolerance fields |
| `integrator.maxSteps` | uint32 input; integer range 1..429496729; default 100000 |
| `forces.centralBody` / `pointMass`, `mu` | bool default true; gravitational parameter km³/s² (Earth default) |
| `forces.j2`, `j3`, `j4`, `higherZonals` | bool defaults true, false, false, false; spherical-harmonic enable inferred from flags |
| `forces.gravityMode` | exact string POINT_MASS, J2, J2_J4, SPHERICAL_HARMONICS, EGM2008; absent uses Infer; explicit mode takes precedence over gravity enable flags |
| `forces.maxDegree`, `maxOrder` | uint16; assigned to spherical-harmonic and EGM2008 truncation configs |
| `forces.thirdBody` | bool default false |
| `forces.thirdBodySun` / `sun`, `thirdBodyMoon` / `moon` | bool default true inside third-body config; inactive if thirdBody false |
| `forces.thirdBodyMercury` / `mercury`, `thirdBodyVenus` / `venus`, `thirdBodyMars` / `mars`, `thirdBodyJupiter` / `jupiter`, `thirdBodySaturn` / `saturn`, `thirdBodyUranus` / `uranus`, `thirdBodyNeptune` / `neptune` | bool default false; primary key wins |
| `forces.srp`, `drag` | bool default false |
| `forces.massKg` / `mass`, `areaM2` / `area` | override spacecraft values for both drag and SRP |
| `forces.cr` / `Cr`, `cd` / `Cd` | dimensionless defaults 1.5 and 2.2 |
| `forces.dragModel` | NRLMSISE00 (default), EXPONENTIAL, USSA1976, HARRIS_PRIESTER; no JB2008/DTM2020 invoke option |
| `weather.F107` / `f107`, `F107a` / `f107a` | doubles default 150 SFU each; F107a is 81-day average |
| `weather.Ap` / `ap`, `Kp` / `kp` | defaults 15 and 3; geomagnetic indices |
| `includeSTM` | bool false; variational path also selected by presence of STM_METHOD, covariance, sampleEpochsJD, maneuvers, or finiteBurns |
| `STM_METHOD` | ANALYTIC default or FINITE_DIFFERENCE |
| `DENSITY_GRADIENT` | NEGLECTED default or FINITE_DIFFERENCE |
| `covariance` | optional 36 row-major doubles for [x,y,z,vx,vy,vz], km² / km²/s / km²/s²; finite required |
| `sampleEpochsJD` | optional at most 10000 double TDB JDs; each sample recomputed from initial epoch; STM cumulative from initial state |
| `maneuvers` | array of `{epochJD:double,deltaV:[double×3],frame?:string}`; deltaV km/s; frame INERTIAL(default) or RTN |
| `finiteBurns` | optional array ≤16; its **presence**, even empty, enables 7-state dynamics; requires ANALYTIC and forward propagation |
| `massKg` | top-level finite-burn initial mass; defaults to effective force-model mass; positive finite kg |
| `covariance7` | optional 49 row-major doubles for [x,y,z,vx,vy,vz,massKg]; requires finiteBurns; entry units are product of row/column state units |
| `ephemeris.epochTDBJD`, `target`, `center` | required JD TDB and signed int NAIF target; center signed int default 399; geometric ICRF/J2000 km, km/s |

Gravity truncation defaults come from the selected C++ config (spherical
harmonics 20/20; EGM2008 70/70); they are not specified by JSON. Weather's internal
header calls its epoch UT, while dispatch assigns the propagation TDB JD. The
migration must resolve this scale boundary explicitly in C++, not perpetuate
that assignment as a new normative convention.

Finite-burn item fields:

| Field | Current type / semantics |
| --- | --- |
| `startSeconds`, `startJD`, `startEpochJD`; analogous `stop*` | at most one time spelling per edge; seconds relative to original epoch; JD aliases converted by ×86400; event-only edges default to 0 / requested target duration; require 0 ≤ start < stop |
| `startEvent`, `stopEvent` | optional `{kind:string,goal:double,direction?:int}`; kind RADIUS(km), SPEED(km/s), RADIAL_VELOCITY(km/s), NODE(z in km), MASS(kg); direction -1/0/+1 default 0 |
| `thrustNewtons`, `accelerationKmS2` | exactly one, positive finite; constant nominal thrust N or acceleration km/s² |
| `ispSeconds` | required positive finite seconds |
| `frame` | INERTIAL default; RTN or LVLH (same legacy interpretation), VNC, VELOCITY, ANTI_VELOCITY |
| `direction`, `steeringRate` | 3 finite doubles; initial nonzero direction (default [1,0,0]); linear direction-component rate per second (default zero), not angular velocity; velocity/anti-velocity modes forbid both |
| `throttle` | array ≤10000 `{seconds:double,throttle:double}`; increasing nonnegative seconds relative to original epoch; throttle [0,1] |

### 2.3 JSON response

`propagate` always returns epochJD, position[3], velocity[3],
propagatedDeltaSeconds, integrationSteps, ephemerisSource and epochTimeScale.
The zero-duration state-only path returns 0 steps. Variational results additionally
return stm[36], integrationRejections, STM_METHOD, DENSITY_GRADIENT,
frame="GCRF", positionUnits="km", velocityUnits="km/s" and optional covariance[36]
and samples. Finite-burn results add massKg, massUnits="kg", stm7[49], optional
covariance7[49], and burnSummary entries:
`index`, `deltaVKmS`, `propellantKg`, `started`, `stopped`, `startByEvent`,
`stopByEvent`, `startSeconds`, `stopSeconds`, `startEpochJD`, `stopEpochJD`.
The four time values are JSON null when the corresponding edge did not occur.
Each sample has its own state, matrices, counters, and burn summary; outer
metadata supplies frame/units/scale. A burn's scalar deltaV is accumulated
thrust acceleration magnitude, not a three-component inertial impulse.

`ephemeris` returns epochTDBJD, target, center, frame="ICRF/J2000",
positionUnits="km", velocityUnits="km/s", ephemerisSource, position[3], velocity[3].

`atmosphere` parameters: model:string default NRLMSISE00; altitudeKm:double
required; year:int default 0 (ignored by the reference model), dayOfYear:int=172,
secondOfDay:double=29000 (UTC seconds), latitudeDeg/longitudeDeg:double=0,
localSolarTimeHours optional (otherwise sec/3600+longitude/15 modulo 24),
f107a/f107:double=150 SFU, ap:double=4, includeAnomalousOxygen:bool=false.
USSA1976 returns model, altitudeKm, densityKgM3, temperatureK, scaleHeightKm;
EXPONENTIAL returns model, altitudeKm, densityKgM3. NRLMSISE00 returns model,
variant (`gtd7` or `gtd7d`), altitudeKm, densityKgM3, densityGCm3, temperatureK,
exosphericTemperatureK, and numberDensitiesCm3 with keys
He/O/N2/O2/Ar/H/N/anomalousO. Geodetic altitude/latitude and east longitude are
model inputs; these are not orbital Cartesian frame quantities.

Failures use PIV error code/message; internal/direct JSON error text is
`{error:string,errorCode:string}`. Named errors include ephemeris-source,
epoch-time-scale, missing-kernel, ephemeris-failed and invoke-failed; failed PIV
calls do not emit successful JSON response records.

### 2.4 Resident records (exact fields)

`PropagatorState` (`PRST`): position:[double], velocity:[double], epoch:int64,
referenceFrame:int8 enum, covariance:[double], ballisticCoefficient:double,
srpCoefficient:double, catalogNumber:uint32, entityIndex:uint32, valid:bool=true.
Frame enum is ECI=0, ECEF=1, TEME=2(default), ICRF=3. Position/velocity use m/m/s;
epoch is rounded milliseconds from JD 2451545.0, used as **UTC** by the resident
catalog path. Ingest reads only first 3 components, epoch, frame and catalogNumber;
it ignores covariance (authored as 21 lower-triangular entries for 6×6),
coefficients, supplied entityIndex and valid. The header gives ballisticCoefficient
m²/kg but leaves srpCoefficient units ambiguous; do not infer a physical mapping
for either ignored coefficient without the caller contract. ECEF/TEME
are transformed into internal GCRF km/km/s; unknown frame values fall back to
GCRF. Output has ECEF m/m/s, rounded epoch, assigned index, true valid, no
covariance and zero coefficients. ICRF is mapped to geocentric GCRF here, unlike
the arbitrary-center NAIF ephemeris query.

`PropagatorBatchRequest`: epoch:double (UTC JD), entity_handles:[uint32],
output_offset:uint32 (ignored by this path), max_count:uint32 (0 unbounded).
Empty handles select all, max_count truncates in requested order. Output frames
inherit trace/stream identity with incremented sequence.

Trajectory records (all scalars default 0, vectors/string absent unless stated):

| Table | Exact fields |
| --- | --- |
| PropagatorPrepareTrajectorySegmentsRequest | catalogHandle:uint32; sourceHandles:[uint32]; startJd:double; durationDays:double; profile:string |
| PropagatorPrepareTrajectorySegmentsResult | segmentSetHandle:uint32; coverageComplete:bool; certifiedMaxPositionErrorKm:double; certifiedMaxVelocityErrorKmS:double |
| PropagatorDescribeTrajectorySegmentsRequest | segmentSetHandle:uint32; sourceHandles:[uint32] |
| PropagatorDescribeTrajectorySegmentsResult | segmentSetHandle:uint32; segments:[PropagatorTrajectorySegment] |
| PropagatorTrajectorySegment | sourceHandle:uint32; startJd/endJd:double; degree:uint32; referenceFrame:ubyte; x/y/zCoefficients:[double]; vx/vy/vzCoefficients:[double]; maxPositionErrorKm:double; maxVelocityErrorKmS:double |

startJd/endJd use the resident UTC JD clock. Each segment currently has degree
12, 13 coefficients per axis, nominal 600 s span; position km and velocity km/s
in internal GCRF labelled legacy ICRF (enum ECI=0/ECEF=1/TEME=2/ICRF=3).
Clenshaw uses normalized time in [-1,1] and ordinary c0 (not half-weighted on
read). Empty handles select all; describe filters to prepared handles and fails
invalid handles. catalogHandle/profile are stored metadata, not independent
catalog routing or numerical profiles. Handles are instance-local; reinit/destroy clears the segment-set map and
resets the counter to 1. Config/cache changes do not carry a wire generation,
so stale-handle reuse is a migration risk. They must not be persisted as object
identities. Coverage completion tests the interval; **error fields are
hardcoded 0**, not certified numerical bounds (`hpop_plugin.cpp:704-736,2503`).

Generated but not dispatched by HPOP: PropagatorSampleTrajectoryStatesRequest
has catalogHandle/sourceHandles/startJd/durationDays/profile; result has
catalogHandle/startJd/durationDays/sampleJds:[double]/sourceHandles:[uint]/
referenceFrame/states:[StateVector struct]. Do not infer a supported method from
these generated declarations.

## 3. Exact current conjunction contract

Sources: [local IDL](../analysis/conjunction-assessment/schemas/ConjunctionCommon.fbs),
[manifest](../analysis/conjunction-assessment/plugin-manifest.json),
[actual handlers](../analysis/conjunction-assessment/src/cpp/src/plugin_invoke_bridge.cpp),
[legacy JSON dispatch](../analysis/conjunction-assessment/src/cpp/src/plugin_runtime.cpp).

### 3.1 Declared methods and actual identities

| Method | Input → output | Important actual behavior |
| --- | --- | --- |
| assess_conjunction | CAPQ → CAEV | both tracks take precedence over TLE; only result emitted despite optional cdm port |
| emit_cdm | CAPQ → $CDM | rejects only-one-track; otherwise TLE pair |
| emit_csm | CAPQ → $CSM | same pair handling |
| find_tca | CAPQ → CATR | TLE path uses coarseStepSec and fineTolSec; track path passes coarseStepSec only |
| alfano_max_probability | CAAR → CAAL | local result IDL says **CAAS**, runtime/manifest say CAAL |
| compute_pc | CAPR → CAPC | local result IDL says **CAPS**, runtime/manifest say CAPC |
| compute_pc_from_cdm | $CDM → CAPC | default algorithm selected in C++ |
| parse_cdm_kvn | raw UTF-8 text/plain → $CDM | falsely declared FlatBuffer input |
| write_cdm_kvn | $CDM → raw UTF-8 text/plain | output root label CdmKvnText, no registered identity |
| parse_cdm_xml | raw UTF-8 text/xml → $CDM | falsely declared FlatBuffer input |
| write_cdm_xml | $CDM → raw UTF-8 text/xml | output root label CdmXmlText, no registered identity |
| screen_catalog | CASQ + optional $OMM catalog → CASS | optional cdm output is declared but handler emits only result |

Inputs are required 1..1 except catalog 0..65535. Outputs 0..1 except screening
cdm 0..65535. Every method has maxBatch=1; screen_catalog declares drain-to-empty,
but implementation builds one complete result instead of chunking. All typed
ports advertise FlatBuffer + aligned-binary (8-byte alignment); canonical peers
omit rootTypeName. Text ports have neither identifier nor root. Serialization
actually emits ordinary FlatBuffers as aligned-binary, then leaves
FlatBufferTypeRef.WIRE_FORMAT at FLATBUFFER while TAB.WIRE_FORMAT is
ALIGNED_BINARY (`plugin_invoke_bridge.cpp:630-646`). Both the metadata mismatch
and false aligned layout need correction.

### 3.2 Complete local IDL field inventory

The following declarations are transcribed from the tracked module-local IDL,
not proposed new standards. Scalar omission defaults are FlatBuffers defaults
(0/false) unless written. Strings/vectors/tables are absent when omitted.

| Current table / enum | Fields / members exactly as authored |
| --- | --- |
| TleRecord (table) | `name:string; line1:string; line2:string;` |
| GpRecord (table) | `objectName:string; objectId:string; epoch:string; meanMotion:double; eccentricity:double; inclination:double; raOfAscNode:double; argOfPericenter:double; meanAnomaly:double; ephemerisType:int = 0; classificationType:string; noradCatId:int = 0; elementSetNo:int = 0; revAtEpoch:int = 0; bstar:double = 0.0; meanMotionDot:double = 0.0; meanMotionDdot:double = 0.0;` |
| BPlaneGeometry (table) | `xi:double = 0.0; zeta:double = 0.0; sigmaXx:double = 0.0; sigmaXz:double = 0.0; sigmaZz:double = 0.0; combinedRadius:double = 0.01;` |
| ScreeningStats (table) | `totalObjects:uint = 0; pairsScreened:uint = 0; pairsPrefiltered:uint = 0; kdtreeCandidates:uint = 0; tcaRefined:uint = 0; conjunctionsFound:uint = 0; propagations:uint = 0; elapsedMs:double = 0.0;` |
| ConjunctionReferenceFrame (enum) | `UNKNOWN = 0, ECI = 1, ECEF = 2, TEME = 3, ICRF = 4` |
| ConjunctionSourceKind (enum) | `UNKNOWN = 0, OMM = 1, OCM = 2, OEM = 3, CDM = 4, FLATSQL_QUERY = 5, PNM = 6, PUBSUB = 7` |
| ConjunctionSelectedSource (table) | `sourceKind:ConjunctionSourceKind = UNKNOWN; sourceId:string; providerId:string; schemaName:string; fileIdentifier:string; query:string; queryHash:string; pnmCid:string; manifestCid:string; topic:string;` |
| PropagatedSample (table) | `jd:double = 0.0; xKm:double = 0.0; yKm:double = 0.0; zKm:double = 0.0; vxKmS:double = 0.0; vyKmS:double = 0.0; vzKmS:double = 0.0;` |
| PropagatedTrack (table) | `sourcePluginId:string; sourceHandle:uint = 0; objectName:string; objectId:string; noradCatId:int = 0; referenceFrame:ConjunctionReferenceFrame = UNKNOWN; samples:[PropagatedSample];` |
| ConjunctionEvent (table) | `obj1Name:string; obj1Id:string; obj1Norad:int = 0; obj2Name:string; obj2Id:string; obj2Norad:int = 0; tcaJd:double = 0.0; tcaIso:string; minRangeKm:double = 0.0; relSpeedKms:double = 0.0; maxProbability:double = 0.0; dilutionThresholdKm:double = 0.0; probabilityMethod:string; relPosR:double = 0.0; relPosT:double = 0.0; relPosN:double = 0.0; relVelR:double = 0.0; relVelT:double = 0.0; relVelN:double = 0.0; covR1:double = 0.0; covT1:double = 0.0; covN1:double = 0.0; covR2:double = 0.0; covT2:double = 0.0; covN2:double = 0.0; dse1:double = 0.0; dse2:double = 0.0;` |
| ConjunctionPairRequest (table) | `tle1:TleRecord; tle2:TleRecord; primaryTrack:PropagatedTrack; secondaryTrack:PropagatedTrack; startJd:double = 0.0; durationDays:double = 7.0; radius1M:double = 5.0; radius2M:double = 5.0; coarseStepSec:double = 60.0; fineTolSec:double = 0.001;` |
| ConjunctionFindTcaResult (table) | `tcaJd:double = 0.0; tcaIso:string;` |
| ConjunctionPcRequest (table) | `bplane:BPlaneGeometry; method:string;` |
| ConjunctionPcResult (table) | `probability:double = 0.0; method:string; converged:bool = true; iterations:int = 0; maxProbability:double = 0.0; mahalanobis2d:double = 0.0;` |
| ConjunctionAlfanoRequest (table) | `missDistanceKm:double = 0.0; combinedRadiusKm:double = 0.01;` |
| ConjunctionAlfanoResult (table) | `maxProbability:double = 0.0; dilutionThresholdKm:double = 0.0; sigmaStarKm:double = 0.0;` |
| ConjunctionScreenCatalogRequest (table) | `primaryTles:[TleRecord]; secondaryTles:[TleRecord]; primaryGps:[GpRecord]; secondaryGps:[GpRecord]; primaryTracks:[PropagatedTrack]; secondaryTracks:[PropagatedTrack]; startJd:double = 0.0; durationDays:double = 7.0; thresholdKm:double = 5.0; numThreads:int = 1; coarseStepSec:double = 60.0; fineTolSec:double = 0.001; combinedRadiusM:double = 10.0; useKdTree:bool = true; useDynamicWindow:bool = true; usePerigeeFilter:bool = true; orderedCatalogIndices:[uint]; startOrderIndex:uint = 0; endOrderIndex:uint = 0; secondaryStartOrderIndex:uint = 0; secondaryEndOrderIndex:uint = 0; selectedSources:[ConjunctionSelectedSource];` |
| ConjunctionScreenCatalogResult (table) | `objectsParsed:uint = 0; conjunctionsFound:uint = 0; conjunctions:[ConjunctionEvent]; stats:ScreeningStats;` |
| ConjunctionVersionResult (table) | `version:string;` |

Units and behavior not encoded by that IDL:

- GpRecord is OMM-like: epoch ISO UTC, meanMotion rev/day, angles degrees,
  meanMotionDot rev/day², meanMotionDdot rev/day³, bstar inverse Earth radii;
  classification defaults to U in decoding. TLE lines retain their native units
  and UTC epoch convention; propagation is SGP4 TEME.
- PropagatedSample is UTC JD, km, km/s. `DecodePropagatedTrack` copies samples
  into OEMEphemerisSource but **ignores referenceFrame, sourcePluginId and
  sourceHandle**. It requires at least two points. Do not assume an ECEF-labelled
  track was transformed. Migration must require a common declared inertial frame
  or apply a verified C++ frame transform before evaluating relative geometry.
- BPlaneGeometry xi/zeta and combinedRadius are km; sigmaXx/sigmaXz/sigmaZz are
  covariance entries in km², not standard deviations. The basis is the encounter
  plane; positive-definite covariance and positive radius are required in the
  proposed API. Current method default is foster; the C++ factory supports
  foster/FOSTER-2D, patera/PATERA-2001, alfano/ALFANO-MAXPROB,
  chan/CHAN-1997/CHAN-2008, alfriend1999, alfriend1999max, alfano2005,
  laas2015 and alfriend/ALFRIEND-2D; the four year-labelled algorithms also
  accept their hyphenated lower-case and upper-case hyphen/underscore aliases
  (`pc_method.cpp:771-798`). Unknown names silently select Foster today;
  the new enum rejects unsupported values.
- Event relPosR/T/N are km; relVelR/T/N km/s, primary-object RTN; covR1/T1/N1 and
  covR2/T2/N2 are **1-sigma metres**, despite the `cov` prefix; dse1/dse2 days
  since source epoch. maxProbability is dimensionless. dilutionThresholdKm and
  sigmaStarKm are km. Track-derived events currently set dilutionThresholdKm=0.
  mahalanobis2d is sqrt(dᵀC⁻¹d), not squared (`pc_method.h:62-71`);
  legacy track mahalanobis_3d is also a square root. The new squared fields
  require explicit C++ conversion, with singular covariance rejected.
- Direct catalog input takes precedence over inline TLE/GP/track vectors. Only
  the **first** catalog frame is read, despite maxStreams=65535. The decoder
  accepts an unprefixed OMM, size-prefixed OMM, u32le OMM stream, or u32be API
  stream. Proposed canonical transport accepts one verified record per frame;
  API-specific framing conversion remains host orchestration.
- orderedCatalogIndices maps order indices to catalog rows. Primary range is
  [clamp(start),clamp(end)] with exclusive end; end≤start means order_count.
  Explicit secondary range requires secondaryEnd>secondaryStart; otherwise it
  defaults to [primary_start+1,order_count). Invalid row indices are skipped.
  With no ordered list, the full catalog becomes primaries. Inline records append
  GP then TLE; tracks are separate sources. Secondary-only inline input is
  promoted to primaries. Empty secondaries means unordered all-vs-all pairs;
  otherwise cross pairs skip identical nonzero NORAD IDs.
- numThreads is clamped to ≥1; the singlethread build forces 1. Track mode uses
  the ConjunctionEngine and does not honor all optimized GP screening flags,
  fine tolerance or combined-radius controls. selectedSources is provenance
  carried by authored IDL, absent from the checked-in generated request table,
  and not read by the C++ handler. ConjunctionSelectedSource has no generated
  table in that header at all. SQL, provider access, topics,
  and PNM retrieval must stay host operations.
- Stats counts are narrowed to uint32 by the current serializer; elapsedMs is
  nondeterministic wall-clock time. A new result uses uint64 counts, stable
  sorting and host-only elapsed diagnostics so scientific payloads can be
  byte-identical across runtimes and worker counts.

### 3.3 Callable but unadvertised methods

`kMethodTable` has `invoke` plus six resident methods missing from the manifest:
prepare_screening_index, prepare_segment_screening_index,
prepare_sample_screening_index, destroy_screening_index, screen_window,
screen_segment_window. These explain why tests can invoke operations absent
from the public manifest; a canonical SDK adapter must explicitly decide and
advertise its supported methods.

Generated declarations exceed `schemas/ConjunctionCommon.fbs`. Their exact
additional current fields are:

| Table | Fields |
| --- | --- |
| ConjunctionPrepareScreeningIndexRequest | catalogHandle:uint32; sourceHandles:[uint32] |
| ConjunctionPrepareSegmentScreeningIndexRequest | catalogHandle:uint32; sourceHandles:[uint32]; segmentSetHandle:uint32; primarySourceHandles:[uint32]; screeningMode:ubyte |
| ConjunctionPrepareSampleScreeningIndexRequest | catalogHandle:uint32; primarySourceHandles:[uint32]; screeningMode:ubyte |
| ConjunctionPrepareScreeningIndexResult | screeningIndexHandle:uint32; sourceCount:uint32; candidatePairCount:uint64 |
| ConjunctionScreenWindowRequest | screeningIndexHandle:uint32; startJd:double; durationDays:double; thresholdKm:double; numThreads:int32; coarseStepSec:double; fineTolSec:double; combinedRadiusM:double; progressIntervalSec:double |
| ConjunctionScreenWindowResult | objectsParsed:uint32; conjunctionsFound:uint32; conjunctions:[ConjunctionEvent]; stats:ScreeningStats |
| ConjunctionDestroyScreeningIndexRequest | screeningIndexHandle:uint32 |
| PropagatorDescribeSourcesBatchResult (`sources` port) | catalogHandle:uint32; sources:[PropagatorSourceDescription] |
| PropagatorSourceDescription | sourceHandle:uint32; sourceKind:ubyte; objectName/objectId:string; noradCatId:uint32; epochJd:double; meanMotionRevPerDay/eccentricity/inclinationDeg/raOfAscNodeDeg/argOfPericenterDeg/meanAnomalyDeg:double; ephemerisType:int32; classificationType:string; elementSetNo/revAtEpoch:uint32; bstar/meanMotionDotRevPerDay2/meanMotionDdotRevPerDay3/perigeeKm/apogeeKm:double |

Segment preparation also consumes PropagatorDescribeTrajectorySegmentsResult
(§2.4); sample preparation consumes PropagatorSampleTrajectoryStatesResult.
Index requests associate source descriptions with module-local handles; window
requests reuse the index and search using UTC JD, days, km, seconds and metres
as in screen_catalog. Destruction invalidates the handle. Profiles/defaults and
wire identifiers for these unadvertised methods are inventoried in Appendix A.
This proposal supplies CQR index records and typed OMM/OEM/PPE sources for them;
there is no need to standardize the private generated headers separately.

Legacy `invoke` accepts UTF-8 JSON `{operation?:string,type?:string,params?:object}`
(operation first), with operations version, assess, screen, assessTracks or
assess_tracks. Its fields are:

- version → `{version:"0.2.0"}`.
- assess: object1/object2 `{name?,line1,line2}`, start_jd default first TLE epoch,
  duration_days=7, radius1_m=radius2_m=5.
- screen: primaries/secondaries arrays of TLE objects, start_jd default first
  primary epoch or 0, duration_days=7, threshold_km=5 → count and conjunctions.
- assessTracks: primary_track/secondary_track each with ≥2 finite increasing
  samples. Epoch aliases epochJD/epoch_jd/jd; component aliases x_km/x, y_km/y,
  z_km/z, vx_km_s/vx, vy_km_s/vy, vz_km_s/vz. Object aliases object_name/objectName,
  object_id/objectId, norad_cat_id/norad_id/noradId. Optional tca_hint_jd clips
  overlap by ±window_hours/24 (window_hours default 2, at least 1 second);
  radius1_m/radius2_m default 5. Frame remains implicit in this legacy path.
- assess result keys: tca_jd/tca_iso, min_range_km, rel_speed_kms,
  max_probability, probability_method, dilution_threshold_km, state1/state2
  (`x,y,z,vx,vy,vz`), rel_pos_rtn[3], rel_vel_rtn[3], dse1/dse2, obj1_name/obj2_name,
  obj1_norad/obj2_norad. Track result adds probability, obj1_id/obj2_id,
  mahalanobis_2d/mahalanobis_3d, combined_radius_km; omits dilution_threshold_km.
- Errors: `{error,errorCode}`, also surfaced as PIV failure. Invalid JSON,
  invalid-request/params, missing-operation, unknown-operation, missing tracks,
  invalid-track/window and invoke-failed are explicit failures.

No legacy JSON method will be advertised in the migrated manifest. Public JS
adapters may translate legacy argument names to typed records and decode results;
physics, frame conversions, time conversions and derived orbit quantities stay
inside C++ WASM.

## 4. Existing SDS coverage and SDK acceptance rules

### 4.1 What is already ratified

All candidates below exist at the inspected SDS source revision. The isolated
SDS 1.217.0 catalogue availability is verified in §9; the older canonical
HPOP installation lacks PCE/EVL/MEM/TRH/ODR and has older TIM/FRM.

| Standard and source locations | Reuse / limitation |
| --- | --- |
| PIV:39-89; TAB:37-86 | Request/response envelope, method ID, trace, status, cap, typed arena payloads; unchanged. TAB offsets are relative to PIV.PAYLOAD_ARENA, never persisted WASM pointers. |
| PRW:62-173 | Existing init/TLE/Keplerian/OMM/OCM/OEM/PPE sources and batch request/result; extend append-only with portable records and explicit time/frame, rather than inventing a second propagation root. |
| FRM:102-126; RFM:455-584 | Cartesian state in SI units with named coordinate system and epoch; complete origin/axes/EOP definitions. GCRF, ITRF/ECEF, TEME and arbitrary-center ICRF are not interchangeable. |
| TIM:109-182 | TIMInstant carries scale and representation; use TDB for HPOP integration and explicit UTC for TLE/resident screening clock. No new time enum. |
| OEM:85-329 | km/km/s state samples, covariance lower triangle, frame/time metadata, compact time grid and PPE records. Reuse for sampled tracks and exported ephemerides. |
| OMM:32-131 | GP/TLE mean-element content and identification; replace GpRecord. Native TLE line pairs already have PRWTleLines. |
| OCM:165-186,274-303,378-436 | State/covariance, physical properties, perturbations and maneuver history; useful input/archive, but no complete executable integrator/finite-burn/STM request. Do not pack configuration into user-defined text. |
| PPE:101-149,228-277 | Six Chebyshev coefficient vectors, segment midpoint/half-span, frame/time and position residual. Reuse directly; PRW supplies resident handles and explicit velocity/quality metadata. |
| CDM:19-166 | Pair identities, TCA, relative state, per-object covariance and probability/method; keep standalone CDM output and input. Does not carry a catalog request, B-plane calculation request or solver diagnostics. |
| CSM:7-30 | Pair summary, DSE, TCA (Unix timestamp), range/speed/max Pc/dilution; keep legacy output but its range/speed/dilution units are underspecified in IDL. Proposed CQR uses explicit units and does not claim this ambiguity is fixed by a new identifier. |
| PCE:525-560,767-884 | Parameter references, condition goal/direction/tolerance, stop requests/reports; use conditions for finite-burn event predicates. Units are SI: RADIUS→POSITION_MAGNITUDE; SPEED→VELOCITY_MAGNITUDE; NODE→POSITION_Z; MASS→TOTAL_MASS. |
| EVL:250-260,318-413 | Event scanning/reporting; suitable for separately reported burn edges/node/apsis events, not catalog screening or HPOP force setup. No EVL extension required. |
| MEM:66-118 | Measurement error/editing; **not a maneuver message**. No use here. |
| TRH:19-89 | Tracking RF hardware; **not trajectory history**. No use here. |
| ODR:39-121 | Estimator configuration, residuals, covariance and filter history; references a pluggable propagator; **not an orbit propagation request**. No use here. |
| NCD:10-66,208-268 | Native-container provenance for SPK and other formats; carries source length/hash/CID but no content bytes. Nest it alongside native bytes in PRW; do not append undeclared bytes to an NCD payload. |
| ATM:97-103 | Model family/year only; insufficient for density query or force weather input. Typed PRW atmosphere tables below preserve the existing diagnostic operation. |
| CAQ:4-61 | Catalog query request/results, not conjunction screening. `$CAQ` is occupied; do not allocate it. |
| AST:81-101 | Strings for propagation/conjunction/OD commands; would preserve opaque JSON semantics and therefore is not the selected migration. |

### 4.2 What the checker actually accepts

SDK references: `src/standards/index.js`, `src/standards/catalogCore.js`
(parseStandardsEntry, collectTypeRefs, resolveStandardsTypeRef,
validateManifestAgainstCatalog), `src/standards/sharedCatalog.js`,
`src/compliance/pluginCompliance.js`, `src/invoke/codec.js`.

1. `index.js` loads the pinned package's `dist/manifest.json`; an explicit
   standardsRoot/SPACE_DATA_STANDARDS_ROOT resolves that directory's
   `dist/manifest.json`. It caches by manifest path. Restart a check process
   after changing the catalogue. Production must use the released package, not
   a test-injected catalogue.
2. Each STANDARDS entry yields `<CODE>.fbs`, exact four-byte file_identifier,
   root_type, and generated Hash/Version comments. `<CODE>/main.fbs` normalizes
   to `<CODE>.fbs`. An orbpro namespace is not a valid alias. Known name with
   another identifier is an identity mismatch. Root must be the **envelope
   root** PRW or CQR, not PRWExecutionRequest or CQRPairRequest.
3. Every input/output allowed type and schemasUsed entry resolves through the
   catalogue; optional root/version/hash must match if declared. Do not invent
   a hash from the proposal; SDS generation owns it. The shared PRST catalogue
   does not legalize `orbpro.plugins.PropagatorState`.
4. Canonical type references require identity/root metadata; paired wire
   variants must match name, identifier, root, version and hash. The checker
   permits canonical-only variable-length records with a **warning**, not an
   error (`no-aligned-peer`). SDS AGENTS has a broader “accept both” rule; this
   proposal interprets the SDK's explicit fixed-layout restriction as applying
   to aligned peers: do not advertise a variable-length table as fixed aligned
   bytes. Coordinator should clarify that wording in SDS separately; no SDK
   exception or compliance weakening is requested here.
5. For these variable-sized roots publish only `wireFormat:"flatbuffer"`,
   `schemaName:"PRW.fbs"/"CQR.fbs"`, `fileIdentifier:"$PRW"/"$CQR"`,
   `rootTypeName:"PRW"/"CQR"`. Canonical CDM/CSM/OMM ports similarly name their
   exact root. If a genuine fixed layout is later ratified, both peers must
   include its exact byteLength and requiredAlignment and the C++ codec must
   implement that layout. Alignment 8 alone does not make one.
6. PIV/TAB TYPE_REF.WIRE_FORMAT and TAB.WIRE_FORMAT must agree with the actual
   payload. Use SDK-generated adapters, size-prefixed streaming, canonical
   allocation/free/invoke/manifest exports, and SDK manifest embedding. Never
   bypass this with acceptsAnyFlatbuffer or arbitrary schema aliases.
7. Catalogue acceptance validates metadata, not numerical correctness or runtime
   imports. Real artifact validation and browser/native/container execution are
   mandatory implementation gates even when manifest checks pass.

## 5. Proposed normative record semantics

### 5.1 Minimal change set

| Item | Coordinator-owned SDS work | Resolution key |
| --- | --- | --- |
| PRW append-only extension | Retain all existing fields/enums/ordinals; add execution/configuration, resident state/batch, trajectory control/results, native input, atmosphere and diagnostic records below | H1 |
| New CQR root (Conjunction Query and Result) | One family for pair/catalog/index/B-plane/Alfano requests and results; include existing OMM/OEM/PPE/PRW/CDM/CSM; typed CDM text table | C1 |
| Exact manifest identities and truthful binary codecs | Consumer work after published SDS; canonical-only variable-length records; complete root names on retained standards | W1 |
| Canonical SDK compilation and runtime fixes | C++ method adapters, sanctioned toolchain, no Emscripten worker hooks, no JSON dispatch in the public ABI | B1 |

No new PIV/TAB/OMM/OEM/OCM/FRM/TIM/REC wire primitive is proposed. REC only gains
one **appended** CQR member through canonical generation and ordinal checks.
PRW is already a REC member. The code/name sweep found no CQR at the inspected
SDS revision or SDS 1.217.0; final reservation remains the coordinator's action.

### 5.2 Semantic requirements shared by the draft IDL

- Exactly one payload arm is populated in each PRW or CQR envelope; METHOD_ID
  and arm must agree. Errors use PIV status/error fields. A success response
  must not contain an empty/invalid scientific result. Existing PRW legacy arms
  remain wire-compatible; new migrated methods use the appended portable arms.
- Defaults are data, not guesses: draft UNSPECIFIED enum values cause an error
  when that choice affects an evaluation. C++ legacy adapters materialize old
  defaults before encoding. Context/profile limitations return a named
  unsupported-configuration error; no ignored controls. The initial HPOP
  adapter accepts ABSOLUTE_TOLERANCES only when they map to its existing scalar
  tolerance (km-based entries multiplied by 1000, mass entry unchanged); other
  vectors require a separate integrator enhancement, not silently ignored values.
- All state interchange in PRW uses FRMStateVector (metres, metres/second) and
  explicit RFMCoordinateSystem definitions. TDB HPOP initial epoch is named in
  FRM state; target/sample epochs use TIMInstant. Earth resident UTC inputs are
  converted inside C++; they must not be fed to a TDB propagator unchanged.
  OEM/OMM/PPE keep their existing units. Covariance conversion is D·P·Dᵀ,
  STM conversion D_out·Phi·D_in⁻¹; D=diag(1000,…,1000,1) for km→m and mass in kg.
- Matrix rows/columns use [x,y,z,vx,vy,vz] or [x,y,z,vx,vy,vz,mass]. An N×N
  matrix has exactly N² row-major entries. Covariance units are products of
  the row and column units; STM units are their ratio. Finite, symmetric
  positive-semidefinite covariance required; unsupported derivatives fail.
- INITIAL.COVARIANCE and INITIAL_COVARIANCE must not both be populated; reject
  duplicate sources. Initial mass is separate from optional 6/7 covariance; both may be supplied
  and must be propagated independently as today. Requested STM is cumulative
  from initial epoch, not from the previous output sample.
- Burn event conditions reuse PCEParameterCondition with explicit SI goal and
  tolerance. Legacy direction -1/0/+1 maps to DECREASING/ANY_CROSSING/INCREASING.
  Legacy INERTIAL means the specified integration frame. RTN/LVLH aliases
  resolve explicitly to radial, transverse, normal; VNC and velocity steering
  retain distinct definitions. Scheduled edges are seconds from original epoch
  and may coexist with event gates. Throttle/steering clocks never restart at
  a sample. Absence of an event time differs from a zero-valued time.
- Finite burn limits (16 burns/10000 throttle points and samples), forward-only
  support, maneuver splitting, non-overlap restrictions and unsupported
  integrator combinations are validated in C++ and retained in acceptance tests.
- Each source ID is an object identity plus provider/module identity. A handle
  is only an instance-scoped execution reference. New instance ID/generation
  fields prevent accidental reuse after restart/reingest/config invalidation.
  No process memory address is allowed as a persisted state or segment handle.
- Use PPE midpoint/half-span/13 coefficients with explicit velocity arrays to
  represent existing HPOP segments losslessly. Report coverage separately from
  quality. quality=UNMEASURED leaves bounds absent; zero is legal only when
  measured. Position/velocity residual estimates are not accuracy guarantees
  against reality. No “certified” bound without method and reference provenance.
- Conjunction inputs must resolve to a common explicit frame and time scale.
  ECI is not a sufficient frame name. OMM mean-element semantics require a
  selected compatible propagator port; OEM/PPE accepts propagated tracks from
  any provider. Host composition chooses the propagator; no fixed SGP4 dependency
  for non-OMM tracks. Data-source queries are provenance, never instructions for
  a guest to fetch SQL/network data.
- CQR Pc input fixes the encounter-plane convention: orthonormal xi/zeta axes
  in the plane normal to relative velocity; caller supplies the two components
  and matching covariance in that same basis. Rotate both together if changing
  basis. Distances SI metres, covariance m², probability unitless. Output
  MAHALANOBIS_SQUARED is explicitly dᵀC⁻¹d. Legacy “mahalanobis2d” is converted
  by squaring the legacy square-root value in C++; never relabel blindly.
- Maximum-probability calculations and covariance-based Pc are distinct. A
  result states actual algorithm and whether covariance was measured, supplied,
  or synthesized. Do not place heuristic maximum probability into a field
  purporting to be a probability derived from supplied covariance.
- CDM/CSM outputs use existing schemas. For legacy CSM, retain current module
  conversion and add unit/time assertions against the writer; do not change
  ambiguous old field meaning in-place. The current csm_output.cpp writes UTC Unix seconds, range/dilution km
  and relative speed km/s. CQR event summaries supply explicit SI/TIM fields; CDM carries detailed object states/covariance when available.
- CQR.NATIVE_DOCUMENT contains UTF-8 bytes of **only CDM KVN or CDM XML** under
  an enum discriminator. This is an explicitly typed external-document record,
  not JSON/base64 or a raw-text TAB port. Parsing/serialization remains C++.
  PRW.NATIVE_INPUT similarly contains NCD plus exactly SOURCE_BYTE_LENGTH SPK
  bytes and a checked SHA256. No NCD enum extension is necessary for CDM text.
- Results stream with deterministic object/TCA ordering, bounded chunks,
  PIV BACKLOG_REMAINING/YIELDED and output cap. Each chunk declares offset and
  final marker, avoiding one giant CASS payload. Elapsed timing stays host
  diagnostics; guest numerical payloads remain comparable byte for byte.

### 5.3 Full draft IDL: append-only PRW extension

The following is a complete candidate `PRW/main.fbs` (existing prefix retained).
The header hash/version are deliberately absent: SDS regenerates them after
ratification. All new field ordinals follow existing PRW fields; no existing
default, enum value, table field order, root or file identifier is changed.

```fbs
include "../FRM/main.fbs";
include "../TIM/main.fbs";
include "../PCE/main.fbs";
include "../PPE/main.fbs";
include "../NCD/main.fbs";

/// Propagator Runtime Wire — arena-addressed init / batch request / batch
/// response envelopes for orbital propagators that produce state vectors
/// into a shared memory arena.
///
/// Data interchange for the underlying content (state vectors, covariance,
/// maneuvers, force models, Keplerian / TLE inputs, polynomial ephemeris)
/// lives in SDS `OCM` + `OMM` + `PPE` + `RFM` + `ATM`. PRW is the runtime
/// wire that moves those across a JS ↔ WASM boundary, not a substitute for
/// any of them.

/// Runtime state-flag bitfield (sized to match a single uint).
/// Data-interchange equivalents: MANEUVERING is subsumed by OCM.Maneuver;
/// HAS_COVARIANCE is implicit from OCM.COVARIANCE_DATA. The remaining
/// flags live here because they describe runtime propagation health, not
/// a persisted record.
enum propagatorStateFlags : uint (bit_flags) {
  /// State vector data is valid.
  VALID,
  /// Satellite is in Earth's shadow at this epoch.
  IN_ECLIPSE,
  /// Orbit has decayed (re-entry imminent or complete).
  DECAYED,
  /// Propagation extrapolated beyond the input epoch.
  EXTRAPOLATED,
  /// Reserved.
  RESERVED_4,
  /// Reserved.
  RESERVED_5,
  /// Reserved.
  RESERVED_6,
  /// Reserved.
  RESERVED_7
}

/// Error codes surfaced by runtime propagation calls.
enum propagatorErrorCode : int {
  /// No error.
  OK,
  /// Unknown / unspecified error.
  UNKNOWN,
  /// One or more entity handles not found.
  UNKNOWN_ENTITY,
  /// Invalid epoch (NaN, out of range, before earliest init epoch, etc.).
  INVALID_EPOCH,
  /// Output buffer too small for the requested count.
  OUTPUT_BUFFER_OVERFLOW,
  /// Propagator not initialized.
  NOT_INITIALIZED
}

/// Propagator initialization request — assigns TLE / OMM / Keplerian /
/// polynomial inputs to entity handles.
///
/// The actual per-entity source record is carried inline as raw bytes
/// tagged with SOURCE_KIND and, where useful, a SDS file_identifier.
/// Callers encode `OMM`, `OCM`, or a one-off Keplerian set and pass the
/// bytes verbatim; the propagator uses SOURCE_KIND to decide how to
/// consume them.
table PRWInit {
  /// Entity handles to assign results to (same order as SOURCES[]).
  ENTITY_HANDLES:[uint];
  /// Per-entity source records, encoded as SDS FlatBuffers.
  SOURCES:[PRWInitSource];
}

enum prwSourceKind : ubyte {
  /// Source is an OMM (CCSDS mean elements) FlatBuffer.
  OMM,
  /// Source is a raw TLE line pair (3LE supported via NAME).
  TLE,
  /// Source is an OCM FlatBuffer.
  OCM,
  /// Source is an OEM FlatBuffer.
  OEM,
  /// Source is a PPE (polynomial ephemeris) FlatBuffer.
  PPE,
  /// Source is a single classical Keplerian element set.
  KEPLERIAN
}

table PRWKeplerianElements {
  /// Gravitational parameter of the central body (km^3 / s^2).
  MU:double;
  /// Semi-major axis (km).
  SEMI_MAJOR_AXIS:double;
  /// Eccentricity (0 = circular, <1 = ellipse).
  ECCENTRICITY:double;
  /// Inclination (radians).
  INCLINATION:double;
  /// Right ascension of the ascending node (radians).
  RAAN:double;
  /// Argument of periapsis (radians).
  ARG_PERIAPSIS:double;
  /// True anomaly (radians).
  TRUE_ANOMALY:double;
  /// Epoch as Julian date.
  EPOCH:double;
}

table PRWTleLines {
  /// TLE line 1 (69 characters).
  LINE1:string;
  /// TLE line 2 (69 characters).
  LINE2:string;
  /// Satellite name (optional, line 0 of 3LE).
  NAME:string;
  /// NORAD catalog number parsed from the TLE.
  NORAD_ID:uint;
}

table PRWInitSource {
  /// Wire kind identifier for BYTES.
  KIND:prwSourceKind;
  /// Optional SDS file_identifier for BYTES (`$OMM`, `$OCM`, `$OEM`, `$PPE`).
  FILE_IDENTIFIER:string;
  /// Encoded source record as a FlatBuffer (consumed per KIND).
  BYTES:[uint8];
  /// Convenience inline form when KIND == KEPLERIAN.
  KEPLERIAN:PRWKeplerianElements;
  /// Convenience inline form when KIND == TLE.
  TLE:PRWTleLines;
}

/// Batch propagation request — propagate every entity in ENTITY_HANDLES[] to
/// EPOCH and write the result StateVector stream to OUTPUT_OFFSET in the
/// shared arena.
table PRWBatchRequest {
  /// Target epoch as a Julian date (TIME_SYSTEM is configured on the host).
  EPOCH:double;
  /// Entity handles to propagate (empty = all initialized entities).
  ENTITY_HANDLES:[uint];
  /// Output buffer offset in the arena where the StateVector stream begins.
  OUTPUT_OFFSET:uint;
  /// Maximum entities to process in this call (0 = unbounded).
  MAX_COUNT:uint;
  /// Target reference frame for the output state stream. Matches enum
  /// values in SDS `RFM`. If zero, the propagator chooses its native frame.
  TARGET_FRAME:string;
}

/// Batch propagation response header — describes the stream written to
/// OUTPUT_OFFSET and reports errors. The stream itself is
/// `STATE_VECTOR_SIZE`-tuple rows in the SDS `OCM` STATE_DATA layout.
table PRWBatchResponse {
  /// Number of state vectors written.
  COUNT:uint;
  /// Offset in the arena where the state-vector stream begins.
  OUTPUT_OFFSET:uint;
  /// Components per state vector (6 = PV, 9 = PVA). Mirrors OCM.STATE_VECTOR_SIZE.
  STATE_VECTOR_SIZE:uint8;
  /// Reference frame for the stream (SDS `RFM`-compatible string tag).
  REFERENCE_FRAME:string;
  /// Per-entity status flags (same cardinality as COUNT).
  FLAGS:[propagatorStateFlags];
  /// Error code (0 == OK).
  ERROR_CODE:propagatorErrorCode;
  /// Optional error message when ERROR_CODE != OK.
  ERROR_MESSAGE:string;
}

/// Propagator Runtime Wire — envelope that carries either an init request,
/// a batch request, or a batch response across a runtime boundary.
/// New numeric choices are append-only and are not legacy C++ enum ordinals.
enum prwSolverAlgorithm : ubyte {
  UNSPECIFIED = 0, RK4 = 1, RKF45 = 2, RKF78 = 3, RK78 = 4,
  RKDP87 = 5, ABM = 6, BS = 7, COWELL = 8, ENCKE = 9,
  EQUINOCTIAL_VOP = 10
}
enum prwGravitySelection : ubyte {
  INFER_FLAGS = 0, POINT_MASS = 1, J2_ONLY = 2, J2_TO_J4 = 3,
  SPHERICAL_HARMONICS = 4, EGM2008 = 5
}
enum prwAtmosphereFamily : ubyte {
  UNSPECIFIED = 0, NRLMSISE00 = 1, EXPONENTIAL = 2,
  USSA1976 = 3, HARRIS_PRIESTER = 4
}
enum prwDerivativeTechnique : ubyte {
  UNSPECIFIED = 0, ANALYTIC = 1, FINITE_DIFFERENCE = 2
}
enum prwDensityTreatment : ubyte {
  UNSPECIFIED = 0, NEGLECTED = 1, FINITE_DIFFERENCE = 2
}
enum prwSteeringBasis : ubyte {
  UNSPECIFIED = 0, INTEGRATION_FRAME = 1, RTN_AXES = 2, VNC_AXES = 3,
  ALONG_VELOCITY = 4, OPPOSITE_VELOCITY = 5
}
enum prwThrustPrescription : ubyte {
  UNSPECIFIED = 0, FORCE = 1, ACCELERATION = 2
}
enum prwQualityEvidence : ubyte {
  UNMEASURED = 0, SAMPLED_RESIDUAL = 1, PROVEN_BOUND = 2
}
enum prwDensitySpecies : ubyte {
  UNSPECIFIED = 0, HELIUM = 1, ATOMIC_OXYGEN = 2, MOLECULAR_NITROGEN = 3,
  MOLECULAR_OXYGEN = 4, ARGON = 5, HYDROGEN = 6, ATOMIC_NITROGEN = 7,
  ANOMALOUS_OXYGEN = 8
}

/// Instance identity is host-provided, opaque, and not a physical quantity.
table PRWInstance {
  MODULE_ID:string (required);
  INSTANCE_ID:string (required);
  /// Incremented on reinitialization or configuration invalidation.
  GENERATION:ulong;
}

/// Units are SI. A scalar legacy tolerance must be expanded by the adapter.
table PRWIntegratorSettings {
  ALGORITHM:prwSolverAlgorithm = UNSPECIFIED;
  INITIAL_STEP_SECONDS:double = 60;
  MINIMUM_STEP_SECONDS:double = 1;
  MAXIMUM_STEP_SECONDS:double = 3600;
  /// Six or seven positive tolerances, respectively m, m/s and optional kg.
  ABSOLUTE_TOLERANCES:[double] (required);
  RELATIVE_TOLERANCE:double = 1e-12;
  MAXIMUM_STEPS:uint = 100000;
}

/// Instantaneous space weather. TIM epoch is UTC; flux in SFU (1e-22 W/m2/Hz).
table PRWSpaceWeather {
  EPOCH:TIMInstant (required);
  F107:double = 150;
  F107_AVERAGE:double = 150;
  /// Conventional daily Ap and three-hour Kp index values; not accelerations.
  AP_INDEX:double = 15;
  KP_INDEX:double = 3;
}

/// Executable subset currently reachable through HPOP invoke. No implied
/// support for coefficients, drag models or bodies the provider cannot supply.
table PRWForceConfiguration {
  GRAVITY_CHOICE:prwGravitySelection = INFER_FLAGS;
  ENABLE_POINT_MASS:bool = true;
  /// m3/s2; required positive when a central gravity term is enabled.
  GRAVITATIONAL_PARAMETER:double;
  ENABLE_J2:bool = true;
  ENABLE_J3:bool = false;
  ENABLE_J4:bool = false;
  ENABLE_HIGHER_ZONALS:bool = false;
  /// Optional truncations; absent selects the explicitly reported model default.
  MAXIMUM_DEGREE:ushort = null;
  MAXIMUM_ORDER:ushort = null;
  ENABLE_THIRD_BODY:bool = false;
  /// NAIF IDs; explicit vector, e.g. [10,301]. Empty means no third bodies.
  THIRD_BODY_IDS:[int];
  ENABLE_SRP:bool = false;
  ENABLE_DRAG:bool = false;
  INITIAL_MASS_KG:double = 1000;
  AREA_M2:double = 10;
  REFLECTIVITY_COEFFICIENT:double = 1.5;
  DRAG_COEFFICIENT:double = 2.2;
  ATMOSPHERE_MODEL:prwAtmosphereFamily = NRLMSISE00;
  WEATHER:PRWSpaceWeather;
  /// Actual configured source name: Analytical or JPL_SPK for current HPOP.
  EPHEMERIS_SOURCE:string (required);
}

/// Row-major square matrix on [x,y,z,vx,vy,vz,(mass)], SI state units.
/// Covariance entries have row*column units; STM entries row/column units.
table PRWStateMatrix {
  DIMENSION:ubyte;
  VALUES:[double] (required);
}

/// Identity/state at one epoch. FRM state is m/m/s with named frame/time scale.
table PRWResidentState {
  INSTANCE:PRWInstance;
  ENTITY_HANDLE:uint;
  CATALOG_NUMBER:uint;
  OBJECT_ID:string;
  STATE:FRMStateVector (required);
  COORDINATE_SYSTEM:RFMCoordinateSystem (required);
  COVARIANCE:PRWStateMatrix;
  /// Optional initial dynamical mass in kg; distinct from a missing mass.
  MASS_KG:double = null;
  /// Explicit SI concepts Cd*A/m and Cr*A/m. Do not infer these from legacy
  /// ignored/underspecified coefficients; require a caller-provided mapping.
  DRAG_AREA_OVER_MASS_M2_KG:double = null;
  SRP_AREA_OVER_MASS_M2_KG:double = null;
  VALID:bool = true;
}

/// Impulsive change at TDB epoch; delta velocity is m/s in the named basis.
table PRWImpulse {
  EPOCH:TIMInstant (required);
  DELTA_V:FRMVector3 (required);
  VECTOR_BASIS:prwSteeringBasis = UNSPECIFIED;
}

/// Piecewise-linear throttle. Clock is seconds from initial propagation epoch.
table PRWThrottlePoint {
  ELAPSED_SECONDS:double;
  FRACTION:double;
}

/// Scheduled time gates an optional condition. At least one must be present.
table PRWBurnBoundary {
  ELAPSED_SECONDS:double = null;
  /// SI PCE predicate; direction and goal tolerance explicitly populated.
  CONDITION:PCEParameterCondition;
}

/// Finite thrust. RTN=(rhat, N cross rhat, N), N=unit(r cross v).
/// VNC=(vhat, unit(r cross v), vhat cross unit(r cross v)).
table PRWFiniteBurn {
  START:PRWBurnBoundary (required);
  STOP:PRWBurnBoundary (required);
  THRUST_LAW:prwThrustPrescription = UNSPECIFIED;
  FORCE_NEWTONS:double = null;
  ACCELERATION_M_S2:double = null;
  SPECIFIC_IMPULSE_SECONDS:double;
  VECTOR_BASIS:prwSteeringBasis = UNSPECIFIED;
  /// Dimensionless components; normalized after adding elapsed*time rate.
  DIRECTION:FRMVector3;
  /// Direction-component change per second, not radians/second.
  DIRECTION_RATE:FRMVector3;
  THROTTLE:[PRWThrottlePoint];
}

/// Fixed endpoint propagation. Provider selected by the host's connected port.
table PRWExecutionRequest {
  INITIAL:PRWResidentState (required);
  TARGET_EPOCH:TIMInstant (required);
  INTEGRATOR:PRWIntegratorSettings (required);
  FORCES:PRWForceConfiguration (required);
  INCLUDE_STM:bool = false;
  STM_TECHNIQUE:prwDerivativeTechnique = ANALYTIC;
  DENSITY_TREATMENT:prwDensityTreatment = NEGLECTED;
  INITIAL_COVARIANCE:PRWStateMatrix;
  INITIAL_MASS_COVARIANCE:PRWStateMatrix;
  SAMPLE_EPOCHS:[TIMInstant];
  IMPULSES:[PRWImpulse];
  /// Explicitly selects 7-state integration even if FINITE_BURNS is empty.
  INCLUDE_MASS_DYNAMICS:bool = false;
  FINITE_BURNS:[PRWFiniteBurn];
}

/// Burn times absent until reached; zero means an actual edge at initial epoch.
table PRWBurnReport {
  BURN_INDEX:uint;
  STARTED:bool;
  STOPPED:bool;
  START_BY_EVENT:bool;
  STOP_BY_EVENT:bool;
  START_SECONDS:double = null;
  STOP_SECONDS:double = null;
  START_EPOCH:TIMInstant;
  STOP_EPOCH:TIMInstant;
  /// Integral of thrust acceleration magnitude, m/s; not vector net delta-v.
  DELTA_V_M_S:double;
  PROPELLANT_KG:double;
}

table PRWPropagationSample {
  STATE:PRWResidentState (required);
  /// Both STMs cumulative from request initial epoch; SI state units.
  STM:PRWStateMatrix;
  MASS_STM:PRWStateMatrix;
  COVARIANCE:PRWStateMatrix;
  MASS_COVARIANCE:PRWStateMatrix;
  ACCEPTED_STEPS:ulong;
  REJECTED_STEPS:ulong;
  BURNS:[PRWBurnReport];
}

table PRWExecutionResult {
  FINAL_SAMPLE:PRWPropagationSample (required);
  SAMPLES:[PRWPropagationSample];
  ELAPSED_SECONDS:double;
  EPHEMERIS_SOURCE:string (required);
  STM_TECHNIQUE:prwDerivativeTechnique = UNSPECIFIED;
  DENSITY_TREATMENT:prwDensityTreatment = UNSPECIFIED;
}

/// Portable batch request: no output pointer; state records returned via TAB.
table PRWResidentRequest {
  INSTANCE:PRWInstance (required);
  TARGET_EPOCH:TIMInstant (required);
  ENTITY_HANDLES:[uint];
  MAXIMUM_COUNT:uint;
  TARGET_COORDINATE_SYSTEM:RFMCoordinateSystem (required);
}

/// All epochs explicit; duration seconds >=0; empty handles means all resident.
table PRWPrepareRequest {
  INSTANCE:PRWInstance (required);
  CATALOG_HANDLE:uint;
  SOURCE_HANDLES:[uint];
  START_EPOCH:TIMInstant (required);
  DURATION_SECONDS:double;
  /// Provider-advertised profile name; unrecognized nonempty values fail.
  PROFILE:string;
}

table PRWFitQuality {
  EVIDENCE_KIND:prwQualityEvidence = UNMEASURED;
  /// SI metres and metres/second; absent when UNMEASURED.
  MAXIMUM_POSITION_ERROR_M:double = null;
  MAXIMUM_VELOCITY_ERROR_M_S:double = null;
  METHOD:string;
  REFERENCE_CONTENT_ID:string;
}

table PRWPrepareResult {
  INSTANCE:PRWInstance (required);
  SEGMENT_SET_HANDLE:uint;
  COVERAGE_COMPLETE:bool;
  QUALITY:PRWFitQuality (required);
}

table PRWDescribeRequest {
  INSTANCE:PRWInstance (required);
  SEGMENT_SET_HANDLE:uint;
  SOURCE_HANDLES:[uint];
}

/// Existing PPE retains km/km/s, midpoint/time-system and coefficient meaning.
table PRWTrajectorySource {
  SOURCE_HANDLE:uint;
  OBJECT_ID:string;
  EPHEMERIS:PPE (required);
  /// One quality record per PPE.POSITION_RECORDS entry, same order.
  SEGMENT_QUALITY:[PRWFitQuality];
}

table PRWDescribeResult {
  INSTANCE:PRWInstance (required);
  SEGMENT_SET_HANDLE:uint;
  SOURCES:[PRWTrajectorySource];
  /// Chunking indexes SOURCES; no partial polynomial coefficient vector.
  SOURCE_OFFSET:ulong;
  FINAL_CHUNK:bool = true;
}

/// Native container bytes wholly inside the FlatBuffer; not an NCD trailer.
table PRWNativeInput {
  DESCRIPTOR:NCD (required);
  /// Exactly DESCRIPTOR.SOURCE_BYTE_LENGTH bytes; verify declared hash.
  CONTENT:[ubyte] (required);
}

/// Geometric SPK state query, TDB; NAIF IDs state origin and target explicitly.
table PRWEphemerisRequest {
  EPOCH:TIMInstant (required);
  TARGET_NAIF_ID:int;
  CENTER_NAIF_ID:int = 399;
}

table PRWEphemerisResult {
  TARGET_NAIF_ID:int;
  CENTER_NAIF_ID:int;
  /// Explicit ICRF axes and named NAIF origin; FRM state in SI m/m/s.
  STATE:PRWResidentState (required);
  EPHEMERIS_SOURCE:string (required);
}

/// Diagnostic atmosphere request; UTC instant replaces ambiguous DOY/year=0.
table PRWAtmosphereRequest {
  ATMOSPHERE_MODEL:prwAtmosphereFamily = NRLMSISE00;
  EPOCH:TIMInstant (required);
  ALTITUDE_M:double;
  LATITUDE_RAD:double;
  LONGITUDE_RAD:double;
  /// Optional local solar time; hours [0,24); absent derives from UTC/longitude.
  LOCAL_SOLAR_TIME_HOURS:double = null;
  F107:double = 150;
  F107_AVERAGE:double = 150;
  AP_INDEX:double = 4;
  INCLUDE_ANOMALOUS_OXYGEN:bool = false;
}

table PRWSpeciesDensity {
  CONSTITUENT:prwDensitySpecies = UNSPECIFIED;
  NUMBER_PER_M3:double;
}

table PRWAtmosphereResult {
  ATMOSPHERE_MODEL:prwAtmosphereFamily = UNSPECIFIED;
  VARIANT:string;
  ALTITUDE_M:double;
  DENSITY_KG_M3:double;
  TEMPERATURE_K:double = null;
  EXOSPHERIC_TEMPERATURE_K:double = null;
  SCALE_HEIGHT_M:double = null;
  NUMBER_DENSITIES:[PRWSpeciesDensity];
}

/// Runtime diagnostic version; PLG remains the authoritative manifest identity.
table PRWVersionResult {
  VERSION:string (required);
  MODULE_ID:string (required);
}

/// Exactly one arm per envelope. Existing three arms keep their ordinals.
table PRW {
  INIT:PRWInit;
  BATCH_REQUEST:PRWBatchRequest;
  BATCH_RESPONSE:PRWBatchResponse;
  /// Appended portable arms; each method names its permitted arm.
  EXECUTION_REQUEST:PRWExecutionRequest;
  EXECUTION_RESULT:PRWExecutionResult;
  RESIDENT_STATE:PRWResidentState;
  RESIDENT_REQUEST:PRWResidentRequest;
  PREPARE_REQUEST:PRWPrepareRequest;
  PREPARE_RESULT:PRWPrepareResult;
  DESCRIBE_REQUEST:PRWDescribeRequest;
  DESCRIBE_RESULT:PRWDescribeResult;
  NATIVE_INPUT:PRWNativeInput;
  EPHEMERIS_REQUEST:PRWEphemerisRequest;
  EPHEMERIS_RESULT:PRWEphemerisResult;
  ATMOSPHERE_REQUEST:PRWAtmosphereRequest;
  ATMOSPHERE_RESULT:PRWAtmosphereResult;
  VERSION_QUERY:bool = false;
  VERSION_RESULT:PRWVersionResult;
}

root_type PRW;
file_identifier "$PRW";
```

### 5.4 Full draft IDL: new CQR family

Candidate `CQR/main.fbs`; root CQR, identifier `$CQR`, no namespace (current SDS
style). Existing nested standards keep their definitions and original units.

```fbs
include "../PRW/main.fbs";
include "../OMM/main.fbs";
include "../OEM/main.fbs";
include "../OCM/main.fbs";
include "../CDM/main.fbs";
include "../CSM/main.fbs";

/// Append-only; no claim that every provider implements every choice.
enum cqrProbabilityAlgorithm : ubyte {
  UNSPECIFIED = 0, FOSTER = 1, PATERA = 2, ALFANO_MAXIMUM = 3, CHAN = 4,
  ALFRIEND_1999 = 5, ALFRIEND_1999_MAXIMUM = 6, ALFANO_2005 = 7,
  LAAS_2015 = 8, ALFRIEND_2D = 9
}
enum cqrUncertaintyOrigin : ubyte {
  UNSPECIFIED = 0, SUPPLIED_COVARIANCE = 1, SYNTHESIZED_COVARIANCE = 2,
  MAXIMUM_PROBABILITY_ONLY = 3
}
enum cqrDocumentSyntax : ubyte {
  UNSPECIFIED = 0, CCSDS_CDM_KVN = 1, CCSDS_CDM_XML = 2
}
enum cqrIndexRepresentation : ubyte {
  UNSPECIFIED = 0, SOURCE_DESCRIPTIONS = 1, POLYNOMIAL_SEGMENTS = 2,
  SAMPLED_STATES = 3
}
enum cqrRefinementStrategy : ubyte {
  UNSPECIFIED = 0, EXACT_ONLY = 1, POLYNOMIAL_ONLY = 2,
  POLYNOMIAL_WITH_EXACT_POLISH = 3
}
enum cqrDataOrigin : ubyte {
  UNSPECIFIED = 0, OMM_RECORD = 1, OCM_RECORD = 2, OEM_RECORD = 3,
  CDM_RECORD = 4, FLATSQL_SELECTION = 5, PUBLICATION = 6, PUBSUB_TOPIC = 7
}

/// Host-resolved provenance. Strings are evidence, not commands to execute.
table CQRSourceProvenance {
  ORIGIN_CLASS:cqrDataOrigin = UNSPECIFIED;
  SOURCE_ID:string;
  PROVIDER_ID:string;
  SCHEMA_NAME:string;
  FILE_IDENTIFIER:string;
  QUERY:string;
  QUERY_HASH:string;
  PNM_CID:string;
  MANIFEST_CID:string;
  TOPIC:string;
}

/// Exactly one scientific source arm, or a validated instance/source handle.
/// OMM/TLE use their native mean-element units; OEM/PPE km and km/s; OCM its
/// declared units. No implicit conversion of TEME, ECEF or ICRF-labelled data.
table CQRObjectSource {
  OBJECT_ID:string (required);
  OBJECT_NAME:string;
  NORAD_CATALOG_ID:uint;
  INSTANCE:PRWInstance;
  SOURCE_HANDLE:uint;
  /// Host-connected provider for mean elements; no embedded fixed SGP4 choice.
  PROPAGATOR_PORT_ID:string;
  MEAN_ELEMENTS:OMM;
  EPHEMERIS:OEM;
  COMPREHENSIVE_ORBIT:OCM;
  POLYNOMIAL_EPHEMERIS:PPE;
  TLE_LINES:PRWTleLines;
  PROVENANCE:CQRSourceProvenance;
  /// Optional source epoch and perigee/apogee altitude above the reference
  /// Earth radius used by the source model, in SI metres (not geocentric radii).
  SOURCE_EPOCH:TIMInstant;
  PERIGEE_ALTITUDE_M:double = null;
  APOGEE_ALTITUDE_M:double = null;
}

/// Explicit UTC search window and positive resolution, SI seconds/metres.
table CQRScreeningControls {
  START_EPOCH:TIMInstant (required);
  DURATION_SECONDS:double = 604800;
  THRESHOLD_M:double = 5000;
  REQUESTED_WORKERS:uint = 1;
  COARSE_STEP_SECONDS:double = 60;
  REFINEMENT_TOLERANCE_SECONDS:double = 0.001;
  COMBINED_RADIUS_M:double = 10;
  USE_KD_TREE:bool = true;
  USE_DYNAMIC_WINDOW:bool = true;
  USE_PERIGEE_FILTER:bool = true;
  /// Optional progress cadence; PIV carries backpressure, not scientific data.
  PROGRESS_INTERVAL_SECONDS:double = null;
  ALGORITHM:cqrProbabilityAlgorithm = ALFANO_MAXIMUM;
}

table CQRPairRequest {
  PRIMARY:CQRObjectSource (required);
  SECONDARY:CQRObjectSource (required);
  CONTROLS:CQRScreeningControls (required);
  PRIMARY_RADIUS_M:double = 5;
  SECONDARY_RADIUS_M:double = 5;
  /// Common inertial frame used for relative state and encounter-plane geometry.
  EVALUATION_FRAME:RFMCoordinateSystem (required);
}

/// All numerical fields in metres or square metres in one orthonormal plane.
table CQRPlaneGeometry {
  XI_M:double;
  ZETA_M:double;
  VARIANCE_XI_M2:double;
  COVARIANCE_XI_ZETA_M2:double;
  VARIANCE_ZETA_M2:double;
  COMBINED_RADIUS_M:double = 10;
}

table CQRProbabilityRequest {
  GEOMETRY:CQRPlaneGeometry (required);
  ALGORITHM:cqrProbabilityAlgorithm = FOSTER;
}

table CQRProbabilityResult {
  PROBABILITY:double;
  ALGORITHM:cqrProbabilityAlgorithm = UNSPECIFIED;
  CONVERGED:bool;
  ITERATIONS:ulong;
  MAXIMUM_PROBABILITY:double = null;
  /// Explicitly squared distance d^T C^-1 d, dimensionless.
  MAHALANOBIS_SQUARED:double = null;
  UNCERTAINTY_SOURCE:cqrUncertaintyOrigin = UNSPECIFIED;
}

table CQRAlfanoRequest {
  MISS_DISTANCE_M:double;
  COMBINED_RADIUS_M:double = 10;
}

table CQRAlfanoResult {
  MAXIMUM_PROBABILITY:double;
  DILUTION_THRESHOLD_M:double;
  SIGMA_STAR_M:double;
}

/// Typed replacement of a bare raw-text port. Content is UTF-8 with no BOM;
/// XML declaration, if present, must agree. Not an arbitrary JSON container.
table CQRNativeDocument {
  SERIALIZATION:cqrDocumentSyntax = UNSPECIFIED;
  CONTENT:[ubyte] (required);
}

/// Order arrays index the supplied catalog stream in exact reception order.
/// Ranges are half-open; absent endpoints select the full respective range.
table CQRCatalogRequest {
  PRIMARIES:[CQRObjectSource];
  SECONDARIES:[CQRObjectSource];
  CONTROLS:CQRScreeningControls (required);
  EVALUATION_FRAME:RFMCoordinateSystem (required);
  ORDERED_CATALOG_INDICES:[uint];
  START_ORDER_INDEX:uint = null;
  END_ORDER_INDEX:uint = null;
  SECONDARY_START_ORDER_INDEX:uint = null;
  SECONDARY_END_ORDER_INDEX:uint = null;
  SELECTED_SOURCES:[CQRSourceProvenance];
}

/// Explicit summary when legacy source lacks sufficient data for a full CDM.
table CQREvent {
  PRIMARY_ID:string (required);
  SECONDARY_ID:string (required);
  PRIMARY_NAME:string;
  SECONDARY_NAME:string;
  PRIMARY_NORAD_ID:uint;
  SECONDARY_NORAD_ID:uint;
  TCA:TIMInstant (required);
  MISS_DISTANCE_M:double;
  RELATIVE_SPEED_M_S:double;
  PROBABILITY:CQRProbabilityResult;
  DILUTION_THRESHOLD_M:double = null;
  /// Primary-object RTN components in m and m/s; omitted when unavailable.
  RELATIVE_POSITION_RTN:FRMVector3;
  RELATIVE_VELOCITY_RTN:FRMVector3;
  /// One-sigma RTN values in metres, not covariance matrices.
  PRIMARY_SIGMA_RTN_M:FRMVector3;
  SECONDARY_SIGMA_RTN_M:FRMVector3;
  PRIMARY_DAYS_SINCE_EPOCH:double = null;
  SECONDARY_DAYS_SINCE_EPOCH:double = null;
  /// Full standards-backed result when physically available.
  CONJUNCTION_MESSAGE:CDM;
  PRIMARY_STATE:PRWResidentState;
  SECONDARY_STATE:PRWResidentState;
  MAHALANOBIS_3D_SQUARED:double = null;
  COMBINED_RADIUS_M:double = null;
}

table CQRScreeningStatistics {
  TOTAL_OBJECTS:ulong;
  PAIRS_SCREENED:ulong;
  PAIRS_PREFILTERED:ulong;
  KD_TREE_CANDIDATES:ulong;
  TCA_REFINED:ulong;
  CONJUNCTIONS_FOUND:ulong;
  PROPAGATIONS:ulong;
  FAILED_PAIRS:ulong;
  /// No elapsed wall-clock field: host instrumentation records that separately.
}

/// Stable order by TCA then primary/secondary identity, with documented ties.
table CQRCatalogResult {
  OBJECTS_PARSED:ulong;
  CONJUNCTIONS_FOUND:ulong;
  EVENTS:[CQREvent];
  STATISTICS:CQRScreeningStatistics;
  EVENT_OFFSET:ulong;
  FINAL_CHUNK:bool = true;
}

/// Resident index construction reuses canonical sources, samples and PPE.
table CQRIndexRequest {
  INSTANCE:PRWInstance (required);
  CATALOG_HANDLE:uint;
  SOURCE_HANDLES:[uint];
  SEGMENT_SET_HANDLE:uint;
  PRIMARY_SOURCE_HANDLES:[uint];
  INDEX_CONTENT:cqrIndexRepresentation = UNSPECIFIED;
  REFINEMENT_MODE:cqrRefinementStrategy = UNSPECIFIED;
  SOURCES:[CQRObjectSource];
  SEGMENTS:PRWDescribeResult;
}

table CQRIndexResult {
  INSTANCE:PRWInstance (required);
  SCREENING_INDEX_HANDLE:uint;
  SOURCE_COUNT:ulong;
  CANDIDATE_PAIR_COUNT:ulong;
}

table CQRWindowRequest {
  INSTANCE:PRWInstance (required);
  SCREENING_INDEX_HANDLE:uint;
  CONTROLS:CQRScreeningControls (required);
  EVALUATION_FRAME:RFMCoordinateSystem (required);
}

table CQRDestroyRequest {
  INSTANCE:PRWInstance (required);
  SCREENING_INDEX_HANDLE:uint;
}

table CQRVersionResult {
  VERSION:string (required);
}

/// Exactly one arm per PIV payload, selected by the declared METHOD_ID.
table CQR {
  PAIR_REQUEST:CQRPairRequest;
  CATALOG_REQUEST:CQRCatalogRequest;
  PROBABILITY_REQUEST:CQRProbabilityRequest;
  PROBABILITY_RESULT:CQRProbabilityResult;
  ALFANO_REQUEST:CQRAlfanoRequest;
  ALFANO_RESULT:CQRAlfanoResult;
  EVENT_RESULT:CQREvent;
  TCA_RESULT:TIMInstant;
  CATALOG_RESULT:CQRCatalogResult;
  NATIVE_DOCUMENT:CQRNativeDocument;
  INDEX_REQUEST:CQRIndexRequest;
  INDEX_RESULT:CQRIndexResult;
  WINDOW_REQUEST:CQRWindowRequest;
  DESTROY_REQUEST:CQRDestroyRequest;
  VERSION_QUERY:bool = false;
  VERSION_RESULT:CQRVersionResult;
}
root_type CQR;
file_identifier "$CQR";
```

The draft includes no newly-required fields on existing tables. New table
required annotations do not break old PRW readers. New roots/enums have no
MIN/MAX members or enum/field naming collisions. Enum values and union member
positions must be append-only after ratification. The coordinator's actual
SDS generation also supplies schema JSON, all bindings, dist/manifest.json,
Hash/Version headers and REC ordinal append; this document is not a substitute
for those artifacts.

## 6. Module migration plan and effort

Estimates are engineering days after SDS publication, not calendar promises.
They include code review and fixture conversion; dataset provisioning and
release-visibility delays are additional. Only the coordinator executes these
changes; lane 11 implements none of them.

### 6.1 Ratify and publish first — 3–5 days plus release latency

1. Repeat code/table/enum collision sweep against fresh SDS main. Recheck the
   actual tracked schema directory. Reserve CQR; keep PRW's first three root
   slots and every existing table field and enum ordinal unchanged.
2. Review physical semantics with module owners: UTC↔TDB/EOP policy, burn
   predicates/steering basis, covariance units, numerical tolerance behavior,
   provider profiles, error-vs-coverage reporting and CSM legacy output units.
3. Apply the two candidate schemas in an SDS task worktree. Generate through
   SDS's canonical build, append CQR to REC with
   `node scripts/checkRecordTypeOrdinals.mjs --update`; run
   `npm run check:ordinals`, `npm run check:enum-names`, `npm run build`,
   `npm test`, and `npm test -- test/website-schema-fields.test.js`.
4. Publish through the coordinator's authorized SDS release process; verify all
   configured registries. Only then update SDK/SDS consumers in dependency order.
   Do not add a sharedCatalog alias or inject this draft catalogue in production.
5. Consumers pin the published SDK/SDS versions and regenerate bindings from
   that release. Preserve PLG manifest identity/round-trip and schemasUsed.

### 6.2 HPOP — 6–10 days

| Step | Concrete change | Estimate |
| --- | --- | --- |
| H1a typed dispatch | Replace JSON parser-facing invoke adapters with PRW arm verification; legacy JS argument translation is orchestration only; use named C++ value types | 1–2 d |
| H1b state/units | Port resident ingest/batch to PRWResidentState/Request; honor/reject covariance, frame, validity and coefficient inputs; explicit TIM conversions and generation-safe handles | 1–2 d |
| H1c trajectories | Map cached coefficients to PPE, attach PRW handle/quality records; eliminate unmeasured zero-error certification; chunk sources | 1 d |
| H1d rich dynamics | Encode finite burns, 6/7 STMs/covariances, samples, atmosphere and ephemeris queries; convert units exactly in C++; preserve capability limitations | 1–2 d |
| B1h build and evidence | SDK compiler adapter, artifact/import validation, same-byte runtime and authoritative tests | 2–3 d |

Required method/arm mapping (every payload root is PRW):

| Method / port | New arm |
| --- | --- |
| invoke.request / invoke.response | EXECUTION_REQUEST/RESULT, EPHEMERIS_REQUEST/RESULT, ATMOSPHERE_REQUEST/RESULT, or VERSION_QUERY/RESULT; exactly one matching pair |
| invoke.kernel | NATIVE_INPUT (NCD+SPK contained inside PRW) |
| ingest_state.state | RESIDENT_STATE |
| propagate_state.request / .state | RESIDENT_REQUEST / RESIDENT_STATE |
| prepare_trajectory_segments.request / .result | PREPARE_REQUEST / PREPARE_RESULT |
| describe_trajectory_segments.request / .result | DESCRIBE_REQUEST / DESCRIBE_RESULT (PPE nested) |

Implement `build.mjs` calling `compileModuleFromSource(...)` with these C++ units:
existing `lib/{astrodynamics,integrators,variational,finite_burn,force_partials,
coords,atmosphere_plugin,environment_models,ephemeris,force_models,nrlmsise00,
time_convert,us76}.cpp`, vendored NRLMSISE C sources, resident `src/hpop_plugin.cpp`
and new thin SDK method adapters. Refactor common state logic out of legacy
StreamInvoke pointer envelope functions. Do not compile the reference copy or
link duplicate manifest/invoke/_start implementations from the old bridge.
SDK-generated code owns allocation, PIV verification, command framing and PLG
embedding. Keep public adapters compatible where possible and regenerate any
retained diagnostic wrappers from the same module bytes.

Use the sanctioned SDK `wasm32-wasip1-threads` route with explicit
`threadModel:"wasi-sequential"` and justification: a resident instance owns
ordered state/cache mutations and executes one invocation at a time. This uses
the common triple and shared memory even without guest thread creation; browser
COOP/COEP isolation is still required. Configure source/include paths explicitly
through SDK options and the local toolchain; never call system emcc. Do not
claim this profile avoids shared memory. Guest numerical core remains C++.

Retest exception paths when replacing nlohmann JSON. The current CMake keeps
plugin_runtime.cpp at O0/no-LTO because of a measured WasmEdge cleanup-pointer
failure. Prefer status-returning validation in the new adapters; do not remove
workarounds without the invalid-input parity cases passing. The SDK runtime
profile checker alone did not catch invalid imports in lane 10.

### 6.3 Conjunction — 7–12 days

| Step | Concrete change | Estimate |
| --- | --- | --- |
| C1a records | Replace CAPQ/CASQ/etc. and generated-only index records with CQR; retain standalone CDM/CSM/OMM typed ports | 2–3 d |
| C1b sources | OMM/OEM/OCM/PPE/TLE source adapters, explicit provider/frame/time selection, all catalog frames consumed and capped streaming | 1–2 d |
| W1 serialization | Remove raw-text ports using CQRNativeDocument; ordinary FlatBuffer output metadata; SDK PIV bridge replaces custom serializers | 1–2 d |
| B1c threading/build | SDK build, wasi-threads worker API, exception/status handling, deterministic merge/sort/counts | 2–3 d |
| Verification | Source/frame/error controls, authoritative data and all three runtime lanes | 1–2 d |

Required port mapping:

| Methods | Request/input | Result/output |
| --- | --- | --- |
| assess_conjunction | CQR.PAIR_REQUEST | CQR.EVENT_RESULT; optional real CDM if populated |
| emit_cdm / emit_csm | CQR.PAIR_REQUEST | existing CDM / CSM root |
| find_tca | CQR.PAIR_REQUEST | CQR.TCA_RESULT |
| alfano_max_probability | CQR.ALFANO_REQUEST | CQR.ALFANO_RESULT |
| compute_pc | CQR.PROBABILITY_REQUEST | CQR.PROBABILITY_RESULT |
| compute_pc_from_cdm | existing CDM root | CQR.PROBABILITY_RESULT |
| parse_cdm_kvn/xml | CQR.NATIVE_DOCUMENT on existing port name | existing CDM root |
| write_cdm_kvn/xml | existing CDM root | CQR.NATIVE_DOCUMENT on existing port name |
| screen_catalog | CQR.CATALOG_REQUEST plus individually verified OMM catalog frames | chunked CQR.CATALOG_RESULT; optional emitted CDMs |
| prepare_*_screening_index | CQR.INDEX_REQUEST containing typed sources/segments | CQR.INDEX_RESULT |
| screen_window / screen_segment_window | CQR.WINDOW_REQUEST | CQR.CATALOG_RESULT |
| destroy_screening_index | CQR.DESTROY_REQUEST | successful empty PIV response |

Advertise the supported resident methods explicitly after converting them.
Fold legacy JSON `invoke` argument adapters into those typed methods; either
advertise a CQR-only version query or obtain the version from embedded PLG.
Do not leave an unadvertised JSON backdoor or silently drop its track use case.
Generated-only headers disappear once the public bindings reproduce from SDS.

Create `build.mjs` using `compileModuleFromSource(...)` for the existing
`CA_SOURCES`, bundled SGP4 implementation and new SDK adapters. Keep SGP4 as an
available provider for compatible OMM inputs; do not require it for OEM/PPE
track providers. Migrate away from the bespoke bridge, manifest embedding and
Emscripten browser glue imports. Preserve direct-entry C++ entrypoints only if
SDK build/export declarations explicitly support them.

**Pthread fix:** the current CMake `-pthread`+`STANDALONE_WASM` is Emscripten
Web-Worker pthread code (`env.__pthread_create_js`/mailbox hooks), not WASI
threads. Request the SDK's `threadModel:"emscripten-pthreads"` vocabulary value
(the historical label actually selects its wasi-threads toolchain),
`runtimeTargets:["browser","wasmedge"]`, and compile through
`clang --target=wasm32-wasip1-threads -pthread` as driven by SDK. The artifact must
import `wasi.thread-spawn`, export `wasi_thread_start`, use shared memory/atomics,
and contain no Emscripten worker hooks. Configure local WASI SDK/wasi-threads
sysroot via the SDK; do not hand-link an Emscripten pthread artifact and rename it.

The browser uses the SDK's worker/COOP/COEP path; native and container WasmEdge
use their wasi-threads hosts. Do not claim the Node singlethread recovery artifact
is proof of the primary artifact. If threaded canonical compilation is blocked,
a sequential canonical diagnostic is useful evidence but not acceptance for the
threaded lane. Keep one primary `dist/isomorphic/module.wasm` byte sequence in
all required runtimes; optional dist/browser copies must hash-identically.

**Serialization fix:** remove PushAlignedBinaryOutput for variable-sized
FlatBuffers and generate verified canonical bytes through SDK adapters; TYPE_REF
and TAB both say FLATBUFFER. Merely copying TAB's enum into TYPE_REF would fix
one decoder rejection while preserving the false wire format. Preserve
`OUTPUT_STREAM_CAP`, trace/sequence, bounded memory and errors during drain.
Do not swallow failed pair evaluations: return failure counts/status and avoid
silently reporting an incomplete catalog as a completed screening.

### 6.4 Completion gates for implementation

For each module, from its private worktree directory:

```sh
node build.mjs
node --test tests/sdk_compat.test.mjs
npm test
npm run check:compliance
```

HPOP must add the currently missing check:compliance script using public SDK
standards-aware manifest **and artifact** checks. Require zero errors, audited
variable-length no-aligned-peer warnings, PLG round-trip, expected canonical
exports, and runtime-profile import checks. Same bytes must pass Chrome/V8,
native WasmEdge and container WasmEdge with worker counts 1/2/4/8 where threaded.
Run both successful physical fixtures and malformed/unsupported requests;
invalid-input classifications must match across runtimes.

Scope of the remaining 16–27 engineering days (including SDS) is the contract
migration described here. Full TMPL capability parity is a separate program
claim; this proposal does not assert it.

## 7. Every compliance error mapped to a resolution

The following is the **ordered error list reproduced with SDK 0.8.18 / SDS
1.217.0** on the base manifests, not a hand-written count. H01–H11 are the 11
basic HPOP errors; H12–H27 are the extra standards-aware errors. C01–C54 are the
basic conjunction errors; C55–C84 are the additional standards errors. Repeated
locations are separate canonical/aligned references, never deduplicated.

Abbreviations in paths: `m[n]` = `manifest.methods[n]`, `in/out[n]` =
inputPorts/outputPorts[n], `set[n]` = acceptedTypeSets[n], `type[n]` =
allowedTypes[n]. These substitutions are reversible; method names are supplied
for convenience. Resolution keys H1/C1/W1/B1 are defined in §5.1; §6 maps each
method to its exact new payload arm. The “remove false aligned peer” resolution
includes changing actual output bytes/metadata; it is not an identifier-only fix.

### propagator/hpop — 27 standards-aware errors

| ID | Exact error code | Location and method | Resolving item |
| --- | --- | --- | --- |
| H01 | `missing-canonical-file-identifier` | `m[0].in[0].set[0].type[0].fileIdentifier` — invoke | H1 + W1: PRW.typed operation arm; canonical root PRW |
| H02 | `missing-canonical-file-identifier` | `m[0].out[0].set[0].type[0].fileIdentifier` — invoke | H1 + W1: PRW.typed operation arm; canonical root PRW |
| H03 | `missing-canonical-file-identifier` | `m[2].in[0].set[0].type[0].fileIdentifier` — propagate_state | H1 + W1: PRW.RESIDENT_REQUEST/STATE; canonical root PRW |
| H04 | `missing-aligned-file-identifier` | `m[2].in[0].set[0].type[1].fileIdentifier` — propagate_state | H1 + W1: PRW.RESIDENT_REQUEST/STATE; canonical root PRW |
| H05 | `paired-type-identity-mismatch` | `m[2].in[0].set[0]` — propagate_state | H1 + W1: PRW.RESIDENT_REQUEST/STATE; canonical root PRW |
| H06 | `missing-canonical-file-identifier` | `m[3].in[0].set[0].type[0].fileIdentifier` — prepare_trajectory_segments | H1 + W1: PRW.PREPARE_REQUEST/RESULT; canonical root PRW |
| H07 | `missing-aligned-file-identifier` | `m[3].in[0].set[0].type[1].fileIdentifier` — prepare_trajectory_segments | H1 + W1: PRW.PREPARE_REQUEST/RESULT; canonical root PRW |
| H08 | `paired-type-identity-mismatch` | `m[3].in[0].set[0]` — prepare_trajectory_segments | H1 + W1: PRW.PREPARE_REQUEST/RESULT; canonical root PRW |
| H09 | `missing-canonical-file-identifier` | `m[4].in[0].set[0].type[0].fileIdentifier` — describe_trajectory_segments | H1 + W1: PRW.DESCRIBE_REQUEST/RESULT; canonical root PRW |
| H10 | `missing-aligned-file-identifier` | `m[4].in[0].set[0].type[1].fileIdentifier` — describe_trajectory_segments | H1 + W1: PRW.DESCRIBE_REQUEST/RESULT; canonical root PRW |
| H11 | `paired-type-identity-mismatch` | `m[4].in[0].set[0]` — describe_trajectory_segments | H1 + W1: PRW.DESCRIBE_REQUEST/RESULT; canonical root PRW |
| H12 | `unresolved-standards-type` | `manifest.invoke.request (reference 1)` — invoke | H1 + W1: PRW.typed operation arm; canonical root PRW |
| H13 | `unresolved-standards-type` | `manifest.invoke.response (reference 1)` — invoke | H1 + W1: PRW.typed operation arm; canonical root PRW |
| H14 | `standards-type-identity-mismatch` | `manifest.ingest_state.state (reference 1)` — ingest_state | H1 + W1: PRW.RESIDENT_STATE; canonical root PRW |
| H15 | `standards-type-identity-mismatch` | `manifest.ingest_state.state (reference 2)` — ingest_state | H1 + W1: PRW.RESIDENT_STATE; canonical root PRW |
| H16 | `unresolved-standards-type` | `manifest.propagate_state.request (reference 1)` — propagate_state | H1 + W1: PRW.RESIDENT_REQUEST/STATE; canonical root PRW |
| H17 | `unresolved-standards-type` | `manifest.propagate_state.request (reference 2)` — propagate_state | H1 + W1: PRW.RESIDENT_REQUEST/STATE; canonical root PRW |
| H18 | `standards-type-identity-mismatch` | `manifest.propagate_state.state (reference 1)` — propagate_state | H1 + W1: PRW.RESIDENT_REQUEST/STATE; canonical root PRW |
| H19 | `standards-type-identity-mismatch` | `manifest.propagate_state.state (reference 2)` — propagate_state | H1 + W1: PRW.RESIDENT_REQUEST/STATE; canonical root PRW |
| H20 | `unresolved-standards-type` | `manifest.prepare_trajectory_segments.request (reference 1)` — prepare_trajectory_segments | H1 + W1: PRW.PREPARE_REQUEST/RESULT; canonical root PRW |
| H21 | `unresolved-standards-type` | `manifest.prepare_trajectory_segments.request (reference 2)` — prepare_trajectory_segments | H1 + W1: PRW.PREPARE_REQUEST/RESULT; canonical root PRW |
| H22 | `unresolved-standards-type` | `manifest.prepare_trajectory_segments.result (reference 1)` — prepare_trajectory_segments | H1 + W1: PRW.PREPARE_REQUEST/RESULT; canonical root PRW |
| H23 | `unresolved-standards-type` | `manifest.prepare_trajectory_segments.result (reference 2)` — prepare_trajectory_segments | H1 + W1: PRW.PREPARE_REQUEST/RESULT; canonical root PRW |
| H24 | `unresolved-standards-type` | `manifest.describe_trajectory_segments.request (reference 1)` — describe_trajectory_segments | H1 + W1: PRW.DESCRIBE_REQUEST/RESULT; canonical root PRW |
| H25 | `unresolved-standards-type` | `manifest.describe_trajectory_segments.request (reference 2)` — describe_trajectory_segments | H1 + W1: PRW.DESCRIBE_REQUEST/RESULT; canonical root PRW |
| H26 | `unresolved-standards-type` | `manifest.describe_trajectory_segments.result (reference 1)` — describe_trajectory_segments | H1 + W1: PRW.DESCRIBE_REQUEST/RESULT; canonical root PRW |
| H27 | `unresolved-standards-type` | `manifest.describe_trajectory_segments.result (reference 2)` — describe_trajectory_segments | H1 + W1: PRW.DESCRIBE_REQUEST/RESULT; canonical root PRW |

Count check: **5** `missing-canonical-file-identifier`, **3** `missing-aligned-file-identifier`, **3** `paired-type-identity-mismatch`, **12** `unresolved-standards-type`, **4** `standards-type-identity-mismatch`.

### analysis/conjunction-assessment — 84 standards-aware errors

| ID | Exact error code | Location and method | Resolving item |
| --- | --- | --- | --- |
| C01 | `missing-canonical-root-type-name` | `m[0].in[0].set[0].type[0].rootTypeName` — assess_conjunction | C1 + W1: CQR.PAIR_REQUEST/EVENT_RESULT; canonical root CQR |
| C02 | `paired-type-identity-mismatch` | `m[0].in[0].set[0]` — assess_conjunction | C1 + W1: CQR.PAIR_REQUEST/EVENT_RESULT; canonical root CQR |
| C03 | `missing-canonical-root-type-name` | `m[0].out[0].set[0].type[0].rootTypeName` — assess_conjunction | C1 + W1: CQR.PAIR_REQUEST/EVENT_RESULT; canonical root CQR |
| C04 | `paired-type-identity-mismatch` | `m[0].out[0].set[0]` — assess_conjunction | C1 + W1: CQR.PAIR_REQUEST/EVENT_RESULT; canonical root CQR |
| C05 | `missing-canonical-root-type-name` | `m[0].out[1].set[0].type[0].rootTypeName` — assess_conjunction | W1: exact $CDM root CDM; remove false aligned peer |
| C06 | `paired-type-identity-mismatch` | `m[0].out[1].set[0]` — assess_conjunction | W1: exact $CDM root CDM; remove false aligned peer |
| C07 | `missing-canonical-root-type-name` | `m[1].in[0].set[0].type[0].rootTypeName` — emit_cdm | C1 + W1: CQR.PAIR_REQUEST; canonical root CQR |
| C08 | `paired-type-identity-mismatch` | `m[1].in[0].set[0]` — emit_cdm | C1 + W1: CQR.PAIR_REQUEST; canonical root CQR |
| C09 | `missing-canonical-root-type-name` | `m[1].out[0].set[0].type[0].rootTypeName` — emit_cdm | W1: exact $CDM root CDM; remove false aligned peer |
| C10 | `paired-type-identity-mismatch` | `m[1].out[0].set[0]` — emit_cdm | W1: exact $CDM root CDM; remove false aligned peer |
| C11 | `missing-canonical-root-type-name` | `m[2].in[0].set[0].type[0].rootTypeName` — emit_csm | C1 + W1: CQR.PAIR_REQUEST; canonical root CQR |
| C12 | `paired-type-identity-mismatch` | `m[2].in[0].set[0]` — emit_csm | C1 + W1: CQR.PAIR_REQUEST; canonical root CQR |
| C13 | `missing-canonical-root-type-name` | `m[2].out[0].set[0].type[0].rootTypeName` — emit_csm | W1: exact $CSM root CSM; remove false aligned peer |
| C14 | `paired-type-identity-mismatch` | `m[2].out[0].set[0]` — emit_csm | W1: exact $CSM root CSM; remove false aligned peer |
| C15 | `missing-canonical-root-type-name` | `m[3].in[0].set[0].type[0].rootTypeName` — find_tca | C1 + W1: CQR.PAIR_REQUEST/TCA_RESULT; canonical root CQR |
| C16 | `paired-type-identity-mismatch` | `m[3].in[0].set[0]` — find_tca | C1 + W1: CQR.PAIR_REQUEST/TCA_RESULT; canonical root CQR |
| C17 | `missing-canonical-root-type-name` | `m[3].out[0].set[0].type[0].rootTypeName` — find_tca | C1 + W1: CQR.PAIR_REQUEST/TCA_RESULT; canonical root CQR |
| C18 | `paired-type-identity-mismatch` | `m[3].out[0].set[0]` — find_tca | C1 + W1: CQR.PAIR_REQUEST/TCA_RESULT; canonical root CQR |
| C19 | `missing-canonical-root-type-name` | `m[4].in[0].set[0].type[0].rootTypeName` — alfano_max_probability | C1 + W1: CQR.ALFANO_REQUEST/RESULT; canonical root CQR |
| C20 | `paired-type-identity-mismatch` | `m[4].in[0].set[0]` — alfano_max_probability | C1 + W1: CQR.ALFANO_REQUEST/RESULT; canonical root CQR |
| C21 | `missing-canonical-root-type-name` | `m[4].out[0].set[0].type[0].rootTypeName` — alfano_max_probability | C1 + W1: CQR.ALFANO_REQUEST/RESULT; canonical root CQR |
| C22 | `paired-type-identity-mismatch` | `m[4].out[0].set[0]` — alfano_max_probability | C1 + W1: CQR.ALFANO_REQUEST/RESULT; canonical root CQR |
| C23 | `missing-canonical-root-type-name` | `m[5].in[0].set[0].type[0].rootTypeName` — compute_pc | C1 + W1: CQR.PROBABILITY_REQUEST/RESULT; canonical root CQR |
| C24 | `paired-type-identity-mismatch` | `m[5].in[0].set[0]` — compute_pc | C1 + W1: CQR.PROBABILITY_REQUEST/RESULT; canonical root CQR |
| C25 | `missing-canonical-root-type-name` | `m[5].out[0].set[0].type[0].rootTypeName` — compute_pc | C1 + W1: CQR.PROBABILITY_REQUEST/RESULT; canonical root CQR |
| C26 | `paired-type-identity-mismatch` | `m[5].out[0].set[0]` — compute_pc | C1 + W1: CQR.PROBABILITY_REQUEST/RESULT; canonical root CQR |
| C27 | `missing-canonical-root-type-name` | `m[6].in[0].set[0].type[0].rootTypeName` — compute_pc_from_cdm | W1: exact $CDM root CDM; remove false aligned peer |
| C28 | `paired-type-identity-mismatch` | `m[6].in[0].set[0]` — compute_pc_from_cdm | W1: exact $CDM root CDM; remove false aligned peer |
| C29 | `missing-canonical-root-type-name` | `m[6].out[0].set[0].type[0].rootTypeName` — compute_pc_from_cdm | C1 + W1: CQR.PROBABILITY_RESULT; canonical root CQR |
| C30 | `paired-type-identity-mismatch` | `m[6].out[0].set[0]` — compute_pc_from_cdm | C1 + W1: CQR.PROBABILITY_RESULT; canonical root CQR |
| C31 | `missing-canonical-file-identifier` | `m[7].in[0].set[0].type[0].fileIdentifier` — parse_cdm_kvn | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C32 | `missing-canonical-root-type-name` | `m[7].in[0].set[0].type[0].rootTypeName` — parse_cdm_kvn | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C33 | `missing-canonical-root-type-name` | `m[7].out[0].set[0].type[0].rootTypeName` — parse_cdm_kvn | W1: exact $CDM root CDM; remove false aligned peer |
| C34 | `paired-type-identity-mismatch` | `m[7].out[0].set[0]` — parse_cdm_kvn | W1: exact $CDM root CDM; remove false aligned peer |
| C35 | `missing-canonical-root-type-name` | `m[8].in[0].set[0].type[0].rootTypeName` — write_cdm_kvn | W1: exact $CDM root CDM; remove false aligned peer |
| C36 | `paired-type-identity-mismatch` | `m[8].in[0].set[0]` — write_cdm_kvn | W1: exact $CDM root CDM; remove false aligned peer |
| C37 | `missing-canonical-file-identifier` | `m[8].out[0].set[0].type[0].fileIdentifier` — write_cdm_kvn | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C38 | `missing-canonical-root-type-name` | `m[8].out[0].set[0].type[0].rootTypeName` — write_cdm_kvn | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C39 | `missing-canonical-file-identifier` | `m[9].in[0].set[0].type[0].fileIdentifier` — parse_cdm_xml | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C40 | `missing-canonical-root-type-name` | `m[9].in[0].set[0].type[0].rootTypeName` — parse_cdm_xml | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C41 | `missing-canonical-root-type-name` | `m[9].out[0].set[0].type[0].rootTypeName` — parse_cdm_xml | W1: exact $CDM root CDM; remove false aligned peer |
| C42 | `paired-type-identity-mismatch` | `m[9].out[0].set[0]` — parse_cdm_xml | W1: exact $CDM root CDM; remove false aligned peer |
| C43 | `missing-canonical-root-type-name` | `m[10].in[0].set[0].type[0].rootTypeName` — write_cdm_xml | W1: exact $CDM root CDM; remove false aligned peer |
| C44 | `paired-type-identity-mismatch` | `m[10].in[0].set[0]` — write_cdm_xml | W1: exact $CDM root CDM; remove false aligned peer |
| C45 | `missing-canonical-file-identifier` | `m[10].out[0].set[0].type[0].fileIdentifier` — write_cdm_xml | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C46 | `missing-canonical-root-type-name` | `m[10].out[0].set[0].type[0].rootTypeName` — write_cdm_xml | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C47 | `missing-canonical-root-type-name` | `m[11].in[0].set[0].type[0].rootTypeName` — screen_catalog | C1 + W1: CQR.CATALOG_REQUEST/RESULT; canonical root CQR |
| C48 | `paired-type-identity-mismatch` | `m[11].in[0].set[0]` — screen_catalog | C1 + W1: CQR.CATALOG_REQUEST/RESULT; canonical root CQR |
| C49 | `missing-canonical-root-type-name` | `m[11].in[1].set[0].type[0].rootTypeName` — screen_catalog | W1: exact $OMM root OMM; remove false aligned peer |
| C50 | `paired-type-identity-mismatch` | `m[11].in[1].set[0]` — screen_catalog | W1: exact $OMM root OMM; remove false aligned peer |
| C51 | `missing-canonical-root-type-name` | `m[11].out[0].set[0].type[0].rootTypeName` — screen_catalog | C1 + W1: CQR.CATALOG_REQUEST/RESULT; canonical root CQR |
| C52 | `paired-type-identity-mismatch` | `m[11].out[0].set[0]` — screen_catalog | C1 + W1: CQR.CATALOG_REQUEST/RESULT; canonical root CQR |
| C53 | `missing-canonical-root-type-name` | `m[11].out[1].set[0].type[0].rootTypeName` — screen_catalog | W1: exact $CDM root CDM; remove false aligned peer |
| C54 | `paired-type-identity-mismatch` | `m[11].out[1].set[0]` — screen_catalog | W1: exact $CDM root CDM; remove false aligned peer |
| C55 | `unresolved-standards-type` | `manifest.assess_conjunction.request (reference 1)` — assess_conjunction | C1 + W1: CQR.PAIR_REQUEST/EVENT_RESULT; canonical root CQR |
| C56 | `unresolved-standards-type` | `manifest.assess_conjunction.request (reference 2)` — assess_conjunction | C1 + W1: CQR.PAIR_REQUEST/EVENT_RESULT; canonical root CQR |
| C57 | `unresolved-standards-type` | `manifest.assess_conjunction.result (reference 1)` — assess_conjunction | C1 + W1: CQR.PAIR_REQUEST/EVENT_RESULT; canonical root CQR |
| C58 | `unresolved-standards-type` | `manifest.assess_conjunction.result (reference 2)` — assess_conjunction | C1 + W1: CQR.PAIR_REQUEST/EVENT_RESULT; canonical root CQR |
| C59 | `unresolved-standards-type` | `manifest.emit_cdm.request (reference 1)` — emit_cdm | C1 + W1: CQR.PAIR_REQUEST; canonical root CQR |
| C60 | `unresolved-standards-type` | `manifest.emit_cdm.request (reference 2)` — emit_cdm | C1 + W1: CQR.PAIR_REQUEST; canonical root CQR |
| C61 | `unresolved-standards-type` | `manifest.emit_csm.request (reference 1)` — emit_csm | C1 + W1: CQR.PAIR_REQUEST; canonical root CQR |
| C62 | `unresolved-standards-type` | `manifest.emit_csm.request (reference 2)` — emit_csm | C1 + W1: CQR.PAIR_REQUEST; canonical root CQR |
| C63 | `unresolved-standards-type` | `manifest.find_tca.request (reference 1)` — find_tca | C1 + W1: CQR.PAIR_REQUEST/TCA_RESULT; canonical root CQR |
| C64 | `unresolved-standards-type` | `manifest.find_tca.request (reference 2)` — find_tca | C1 + W1: CQR.PAIR_REQUEST/TCA_RESULT; canonical root CQR |
| C65 | `unresolved-standards-type` | `manifest.find_tca.result (reference 1)` — find_tca | C1 + W1: CQR.PAIR_REQUEST/TCA_RESULT; canonical root CQR |
| C66 | `unresolved-standards-type` | `manifest.find_tca.result (reference 2)` — find_tca | C1 + W1: CQR.PAIR_REQUEST/TCA_RESULT; canonical root CQR |
| C67 | `unresolved-standards-type` | `manifest.alfano_max_probability.request (reference 1)` — alfano_max_probability | C1 + W1: CQR.ALFANO_REQUEST/RESULT; canonical root CQR |
| C68 | `unresolved-standards-type` | `manifest.alfano_max_probability.request (reference 2)` — alfano_max_probability | C1 + W1: CQR.ALFANO_REQUEST/RESULT; canonical root CQR |
| C69 | `unresolved-standards-type` | `manifest.alfano_max_probability.result (reference 1)` — alfano_max_probability | C1 + W1: CQR.ALFANO_REQUEST/RESULT; canonical root CQR |
| C70 | `unresolved-standards-type` | `manifest.alfano_max_probability.result (reference 2)` — alfano_max_probability | C1 + W1: CQR.ALFANO_REQUEST/RESULT; canonical root CQR |
| C71 | `unresolved-standards-type` | `manifest.compute_pc.request (reference 1)` — compute_pc | C1 + W1: CQR.PROBABILITY_REQUEST/RESULT; canonical root CQR |
| C72 | `unresolved-standards-type` | `manifest.compute_pc.request (reference 2)` — compute_pc | C1 + W1: CQR.PROBABILITY_REQUEST/RESULT; canonical root CQR |
| C73 | `unresolved-standards-type` | `manifest.compute_pc.result (reference 1)` — compute_pc | C1 + W1: CQR.PROBABILITY_REQUEST/RESULT; canonical root CQR |
| C74 | `unresolved-standards-type` | `manifest.compute_pc.result (reference 2)` — compute_pc | C1 + W1: CQR.PROBABILITY_REQUEST/RESULT; canonical root CQR |
| C75 | `unresolved-standards-type` | `manifest.compute_pc_from_cdm.result (reference 1)` — compute_pc_from_cdm | C1 + W1: CQR.PROBABILITY_RESULT; canonical root CQR |
| C76 | `unresolved-standards-type` | `manifest.compute_pc_from_cdm.result (reference 2)` — compute_pc_from_cdm | C1 + W1: CQR.PROBABILITY_RESULT; canonical root CQR |
| C77 | `unresolved-standards-type` | `manifest.parse_cdm_kvn.kvn (reference 1)` — parse_cdm_kvn | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C78 | `unresolved-standards-type` | `manifest.write_cdm_kvn.kvn (reference 1)` — write_cdm_kvn | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C79 | `unresolved-standards-type` | `manifest.parse_cdm_xml.xml (reference 1)` — parse_cdm_xml | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C80 | `unresolved-standards-type` | `manifest.write_cdm_xml.xml (reference 1)` — write_cdm_xml | C1 + W1: CQR.NATIVE_DOCUMENT; canonical root CQR |
| C81 | `unresolved-standards-type` | `manifest.screen_catalog.request (reference 1)` — screen_catalog | C1 + W1: CQR.CATALOG_REQUEST/RESULT; canonical root CQR |
| C82 | `unresolved-standards-type` | `manifest.screen_catalog.request (reference 2)` — screen_catalog | C1 + W1: CQR.CATALOG_REQUEST/RESULT; canonical root CQR |
| C83 | `unresolved-standards-type` | `manifest.screen_catalog.result (reference 1)` — screen_catalog | C1 + W1: CQR.CATALOG_REQUEST/RESULT; canonical root CQR |
| C84 | `unresolved-standards-type` | `manifest.screen_catalog.result (reference 2)` — screen_catalog | C1 + W1: CQR.CATALOG_REQUEST/RESULT; canonical root CQR |

Count check: **27** `missing-canonical-root-type-name`, **23** `paired-type-identity-mismatch`, **4** `missing-canonical-file-identifier`, **30** `unresolved-standards-type`.

### Separate defects not represented by those 111 error rows

| Defect | Resolving item / acceptance |
| --- | --- |
| HPOP CMake/build.sh bypass SDK; no build.mjs | B1h: SDK compilation, canonical artifact and PLG |
| Conjunction Emscripten pthread worker imports | B1c: wasi-threads toolchain and actual three-runtime execution |
| PIV type-ref/TAB wire mismatch and FlatBuffers labelled aligned-binary | W1: SDK canonical output codec, payload verification, not a relaxed decoder |
| CAAL/CAAS and CAPC/CAPS source/codegen drift | C1: one released CQR root and generated bindings; retire local definitions |
| Unadvertised JSON/resident methods | C1/H1: typed adapters and accurate method declarations |
| Ignored frame/time/control metadata, first-catalog-frame-only handling | H1b/C1b: explicit conversions, reject unsupported choices, consume all declared frames |
| Unmeasured zero fit bounds; swallowed pair errors | H1c/C1b: quality availability and failure accounting |
| Nondeterministic elapsed stats / threaded ordering | B1c: host timing and canonical sorted scientific payloads |

A zero-error projected manifest is necessary but does not establish any of these
runtime fixes. The error counts remain unchanged until actual consumer migration.

## 8. Authoritative numerical evidence and migration acceptance

These are reruns against **unchanged existing artifacts/code**, not results from
an implemented PRW/CQR migration. No new-code golden data was generated.
The HPOP force test compiles native C++ as a supplemental force check; the
CSPICE invoke test and three-runtime fixture use the existing WASM. Conjunction
SOCRATES uses the existing singlethread recovery artifact, not a newly compliant
threaded artifact.

| Case / independently sourced oracle | Units, frame, time | Measured maximum error this lane | Bound and rationale |
| --- | --- | --- | --- |
| 12 NAIF CSPICE N0067/DE440 states from committed cspice-de440.csv | km, km/s; geometric ICRF/J2000, Earth center 399; JD 2461041.5 TDB | position **1.4901161193847656e-8 km**; velocity **1.7763568394002505e-15 km/s** | 1e-6 km / 1e-9 km/s; same-kernel interpolation and barycenter arithmetic, not ephemeris physical accuracy |
| Nine third-body differential-gravity cases using CSPICE DE440 states | km/s²; GCRF/J2000 aligned geometry, JD 2461041.5 TDB; explicit per-body GM inputs | **2.7745692215067836e-22 km/s²** | 1e-18 km/s²; independently evaluated long-double Newtonian differential acceleration |
| Kernel-Sun photon-momentum SRP | km/s²; same frame/epoch; irradiance 1361 W/m², c=299792458 m/s, AU=149597870.7 km, Cr=1.5, A=10 m², mass=1000 kg | **0 km/s²** | 1e-18 km/s²; floating-point evaluation of independent F/c model, no atmosphere/shadow uncertainty claim |
| CelesTrak SOCRATES 61721–67298 | UTC TCA 2026-03-14T11:08:50.281Z, TEME SGP4 geometry, seconds/metres/metres per second | **0.00072 s / 4.178 m / 0.100 m/s** | 0.010 s / 5 m / 5 m/s; NLRV TCA bound, CSV range quantization, retained speed regression bound |
| CelesTrak SOCRATES 47935–49179 | UTC TCA 2026-03-12T04:44:40.733Z, TEME | **0.00032 s / 0.303 m / 0.304 m/s** | same bounds/rationale |
| CelesTrak SOCRATES 48282–58288 | UTC TCA 2026-03-16T09:03:22.330Z, TEME | **0.00028 s / 0.131 m / 0.479 m/s** | same bounds/rationale |

Sources and reproducibility:

- CSPICE geometric-state convention and TDB ET: [NAIF spkez_c](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkez_c.html).
  The independent reference generator, kernel/source hashes and DE440 provenance
  are in [de440-validation.md](de440-validation.md) and
  `files/orbit-products/tests/fixtures/de440/cspice-metadata.json`.
- SRP nominal irradiance: [IAU 2015 Resolution B3](https://iauarchive.eso.org/static/resolutions/IAU2015_English.pdf);
  exact astronomical unit: [IAU 2012 Resolution B2](https://iau-a3.gitlab.io/res.html).
  Equations, constants, coordinate conventions and long-double oracle are stated
  in `propagator/hpop/tests/de440_force_native.cpp:1-17`.
- [CelesTrak SOCRATES Plus](https://celestrak.org/SOCRATES/) is the source service;
  the actual oracle is its **2026-03-10 snapshot**, not today's changing page:
  `analysis/conjunction-assessment/tests/fixtures/socrates/reference.top3.json`
  and matching GP fixtures. Full event recall and zero extras passed. Pc ratios
  1.000, 1.859 and 1.731 are retained **advisory same-family comparisons**, not
  independent probability validation. Tolerance rationale is in
  `tests/lib/caParityTolerances.mjs`.

Implementation acceptance must re-encode these same authoritative inputs through
PRW/CQR and compare in original physical units without widening tolerances.
Byte parity between runtimes does not replace comparison to the numerical
oracle. Before/after byte equality is only meaningful for unchanged inner
scientific records, not old JSON versus new FlatBuffers envelopes.

Additional required migration checks (not run by this documentation lane):

1. Preserve the existing finite-burn NASA rocket-equation, MIT spiral and
   Orekit ConstantThrustManeuverTest cases in `finite_burn_native.cpp` and
   `finite_burn_invoke.test.mjs`, and variational Battin/MIT cases in
   `variational_native.cpp`. These already state units/frame/epoch/tolerances;
   retain their exact per-case bounds and independent equations when switching
   encoders. Orekit's autonomous point-mass test uses EME2000 and its published
   elapsed interval; do not invent an absolute TDB reference for its UTC case.
2. Test 6→6 and 7→7 covariance/STM unit conversions, optional zero vs absent
   values, burn starts/stops, invalid unsupported integrators, source/coverage
   errors, and requested vs actual frame/epoch. Use a simple independently
   calculated nonzero cross-covariance example to detect km/m² scaling mistakes.
3. For CQR B-plane probability, use the centered isotropic closed form
   `Pc=1-exp(-R²/(2σ²))`, e.g. R=10 m, σ=100 m, Pc≈0.00498752080731768.
   Plane axes arbitrary orthonormal; epoch irrelevant to this standalone
   integral; absolute bound 1e-12 for deterministic converged integration,
   justified by a smooth analytical Gaussian integral. Do **not** apply this
   bound to an algorithm that returns only maximum probability; use an actual
   covariance Pc implementation and verify its reported algorithm.
4. Verify explicit TLE TEME/UTC, OEM declared frames/time, and ECEF transport
   velocity against the existing standards-backed frame/time module fixtures;
   reject unknown frames and missing EOP data. No JS physics or hand-assigned
   `ICRF` labels as a substitute for transformation.
5. Supply the eight lane-10 missing-data checks (Aerospace extracted/archive and
   full local SOCRATES catalog) through the ignored canonical test-data layout.
   Do not hardcode machine paths or change skip criteria. Independent Pc and
   broad-catalog certification remain incomplete until authoritative datasets
   and the canonical threaded artifact pass.

## 9. Verification performed for this proposal

Environment: Node v25.4.0; isolated lockfile dependencies SDK 0.8.18, SDS 1.217.0,
flatc-wasm 26.1.32. Native/container WasmEdge 0.16.4. Only this Markdown file is
tracked as changed. Dependency symlinks under this worktree's ignored HPOP
node_modules point to its isolated conjunction installation; no canonical
checkout installation or other lane directory was modified.

### Design checks

The repeatable check in Appendix B extracts the two fenced IDLs, generates C++
and TypeScript in memory, verifies append-only PRW fields/enums, checks naming,
loads the real pinned SDS catalogue, reproduces current errors, and validates an
**in-memory projection of the existing manifest ports** against candidate PRW/CQR
catalogue entries. It does not certify compiled consumer behavior or newly added
resident method declarations.

```sh
node /tmp/tmpl-lane-11-validate.mjs
```

```text
PASS flatc PRW cpp: 1 generated files (memory only)
PASS flatc PRW ts: 48 generated files (memory only)
PASS flatc CQR cpp: 1 generated files (memory only)
PASS flatc CQR ts: 27 generated files (memory only)
PASS PRW append-only: all existing table fields, defaults and enum members retained
PASS field casing and enum-name collision checks
BASELINE propagator/hpop: 27 standards-aware errors
PASS projected propagator/hpop: 0 errors; 10 warnings; injected candidate catalogue only
BASELINE analysis/conjunction-assessment: 84 standards-aware errors
PASS projected analysis/conjunction-assessment: 0 errors; 27 warnings; injected candidate catalogue only
PASS all 18 reused/candidate standards present in SDS 1.217.0; CQR unused
```

Exit 0. All projection warnings are expected canonical-only variable-sized
record warnings. This is a proposal acceptance experiment, not a schema
registration, runtime bypass or successful module build.

### Existing build and sdk_compat gates

From **each** module directory:

```sh
node build.mjs
env PATH="$HOME/.wasmedge/bin:$PATH" node --test tests/sdk_compat.test.mjs
```

```text
HPOP node build.mjs: Error: Cannot find module '.../propagator/hpop/build.mjs'
  code: 'MODULE_NOT_FOUND' (exit 1)
Conjunction node build.mjs: Error: Cannot find module '.../analysis/conjunction-assessment/build.mjs'
  code: 'MODULE_NOT_FOUND' (exit 1)
HPOP sdk_compat: tests 10; pass 9; fail 1; skipped 0 (exit 1)
Conjunction sdk_compat: tests 10; pass 9; fail 1; skipped 0 (exit 1)
```

Both failures are `built artifact passes SDK compliance checks`. HPOP has 11
basic errors; conjunction 54. The standards-aware check above adds the catalog
errors for 27/84. No build source was modified or replacement binary created.
The existing HPOP compiler-admission probe was also run:

```sh
(cd propagator/hpop && node tests/sdk-build-preflight.mjs)
```

```text
SDK preflight sdk=0.8.18 standards=1.217.0
SDK BUILD BLOCKED: Manifest validation failed. errors=27
HPOP source preparation skipped: SDK rejected the manifest before compiler selection.
```

Exit 1 as expected. This is a manifest-admission probe with a sentinel source,
not an attempted full HPOP compilation.

### Current numerical and runtime gates

From the worktree root:

```sh
env PATH="$HOME/.wasmedge/bin:$PATH" node --test \
  propagator/hpop/tests/kernel_invoke.test.mjs propagator/hpop/tests/de440_force.test.mjs
(cd analysis/conjunction-assessment && env PATH="$HOME/.wasmedge/bin:$PATH" \
  node --test tests/socratesScreenCatalogParity.test.mjs tests/pivInvokeContract.test.mjs)
env PATH="$HOME/.wasmedge/bin:$PATH" node propagator/hpop/tests/kernel-parity.mjs
(cd analysis/conjunction-assessment && env PATH="$HOME/.wasmedge/bin:$PATH" \
  node node_modules/space-data-module-sdk/bin/space-data-module.js parity \
  --wasm dist/isomorphic/module.wasm \
  --fixture node_modules/space-data-module-sdk/parity/sdk-command.json \
  --lanes browser,wasmedge,docker-wasmedge \
  --wasmedge-binary "$HOME/.wasmedge/bin/wasmedge" --timeout-sec 15)
```

```text
PASS DE440 force cases=10 failures=0
PASS HPOP WASM CSPICE states=12 position_error_km=1.4901161193847656e-8 velocity_error_km_s=1.7763568394002505e-15
HPOP physics: tests 3; pass 3; fail 0; skipped 0 (exit 0)
Conjunction SOCRATES/PIV: tests 7; pass 7; fail 0; skipped 0 (exit 0)
parity PASS fixture=TMPL lane01 HPOP diagnostic CMake artifact module=627f0204b7f09aff lanes=[browser(6 runs, 1799ms), wasmedge(6 runs, 495ms), docker-wasmedge(6 runs, 3304ms)] comparisons=30
  6 case(s) byte-identical across 3 lane(s). (exit 0)
parity FAIL fixture=sdk-command-parity module=acfedd6de4baaaae lanes=[browser(12 runs, 1800ms), wasmedge(12 runs, 591ms), docker-wasmedge(12 runs, 5201ms)] comparisons=36
  PARITY FAIL case=empty-stdin kind=class-divergence: browser@t1 class "trap" vs wasmedge@t1 class "guest-error" (exit=1)
  Same divergence for malformed-stdin and truncated-piv-header, native/container worker counts 1/2/4/8. (CLI exit 2)
```

Current SHA256 (identical to base Git blobs):

```text
627f0204b7f09aff0e89e24bcc6ec4cff9780411c74706f4368434a8002ad79a  propagator/hpop/dist/isomorphic/module.wasm
acfedd6de4baaaae7d9265f7be992f2fe522afaa6f5dc739a20fbe2b6206fc72  analysis/conjunction-assessment/dist/isomorphic/module.wasm
```

HPOP's base bytes differ from lane 10's earlier receipt; the above hash is the
actual fresh main baseline for this lane. No new schema-aware after-artifact
exists. Existing conjunction command parity remains a **failure**, not a waiver.

Skipped: complete npm suites, SDK repository npm test/check:compliance, SDS
publication/multilanguage build, data-dependent Aerospace/full-catalog suites,
and scientific PRW/CQR invokes. Reasons: this lane changes only a proposal; no
SDK/SDS/module implementation or artifact exists for those new records. Focused
current numerical/compatibility and all three runtime checks are reported above;
missing implementation/dataset evidence is not counted as a pass.

Documentation checks also passed: 27 HPOP and 84 conjunction mapping rows,
balanced fenced blocks, all local links resolved, both WASM files byte-identical
to their base Git blobs, and staged whitespace validation.

## 10. Handoff, open decisions and workspace hygiene

- Deliverable: `docs/tmpl-lane-11-proposal.md` on `tmpl/lane-11`; focused commit
  SHA and verified remote branch SHA are in the worker's final report.
- Ratification is outstanding by design. Coordinator must confirm CQR code,
  PRW scope, fixed-layout/aligned policy wording, legacy frame/time/coefficient
  mappings and supported method profiles before implementing. The draft has
  passed syntax/metadata experiments; it is not a promise every proposed control
  is implemented by today's modules.
- No new SDS files or generated bindings were written to a repository. The
  validation compiler used virtual files only. No production deployment,
  publishing, credential access, schema registration or main merge occurred.
- The graph claim attempt used the owner-supplied protocol generation and
  returned `graphctl: no such task: tmpl-lane-11`. The lane's explicit commit
  override is used, rather than creating/editing the canonical stack task graph:

```sh
GRAPH_PROTOCOL_GENERATION="main:65bfe5c174aebde03cb6c0dab819ce4c4011ec9f"
GRAPH_GUARD_OVERRIDE="TMPL parity lane 11 (owner goal 2026-09-15)"
```

The first commit attempt was refused with ROOT_OPERATION_ACTIVE because another
workspace-guard pre-commit operation held admission. No guard state was changed;
the same authorized override was retained for the retry.

Only the proposal is staged and committed. Push to `origin tmpl/lane-11`; the
coordinator lands it. Preserve the clean unlanded worktree until that happens;
no stack pin is changed.

## Appendix A. Generated-only conjunction details

Sources: `src/cpp/include/conjunction/generated/ConjunctionCommon_generated.h`
and `src/cpp/include/orbpro/generated/StateVector_generated.h` under conjunction.
These details complement the exact tables in §3.3 and are **legacy inventory**,
not the new enum values in the proposed CQR schema.

| Method / legacy identifier | Default/interpretation |
| --- | --- |
| prepare_screening_index / CSPI | catalogHandle=0, sourceHandles absent; sources describe SGP4 GP records; result CSPR |
| prepare_segment_screening_index / CSSI | handles=0/vectors absent; screeningMode=2; required sources and segments ports; result CSPR |
| prepare_sample_screening_index / CSSM | catalogHandle=0, primarySourceHandles absent; screeningMode=2; sources and samples ports; result CSPR |
| destroy_screening_index / CSDI | screeningIndexHandle=0; no scientific output |
| screen_window / CSWN | handle=0; startJd=0; durationDays=0; thresholdKm=5; numThreads=1; coarseStepSec=60; fineTolSec=0.001; combinedRadiusM=10; progressIntervalSec=0 |
| screen_segment_window | dispatches the same window handler/CSWN request; CASS result |
| ConjunctionScreeningMode | exact_only=0; polynomial_only=1; polynomial_plus_exact_polish=2; generated MIN/MAX are compiler sentinels, not authored members |
| PropagatorSourceKind | UNKNOWN=0, SGP4=1; source describes GP epoch UTC JD, angles deg, rev/day rates; perigeeKm/apogeeKm are **altitudes** above RE_KM |
| ConjunctionPrepareScreeningIndexResult | handle/sourceCount/candidatePairCount all default 0; count is uint64 |

Generated source description scalars default 0 and strings/vectors absent.
Generated request source selections must not be treated as proof of a functioning
non-SGP4 resident provider. New typed sources and provider plumbing require
migration tests. This does not affect the separate sampled-track entry path.

## Appendix B. Reproduce the design-only IDL/catalogue check

From the private worktree root, install conjunction's existing lockfile with
`(cd analysis/conjunction-assessment && npm ci --ignore-scripts)`, then save the
following JavaScript as `/tmp/tmpl-lane-11-validate.mjs` and run it with Node.
It writes only a temporary JSON error inventory, generates code only in memory,
and does not modify schemas, module manifests or artifacts.

```js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.cwd();
const req=createRequire(root+'/analysis/conjunction-assessment/package.json');
const sdk=await import(pathToFileURL(req.resolve('space-data-module-sdk')));
const std=await import(pathToFileURL(req.resolve('space-data-module-sdk/standards')));
const {FlatcRunner}=await import(pathToFileURL(path.resolve(path.dirname(req.resolve('flatc-wasm')),'../src/index.mjs')));
const sr=path.dirname(req.resolve('spacedatastandards.org/package.json'));
const md=fs.readFileSync(root+'/docs/tmpl-lane-11-proposal.md','utf8');
const blocks=[...md.matchAll(/```fbs\n([\s\S]*?)\n```/g)].map(m=>m[1]);
assert.equal(blocks.length,2);
const draft=Object.fromEntries(blocks.map(idl=>[/root_type\s+(\w+)/.exec(idl)[1],idl]));
const files={};
function include(code) {
 const key=`/sds/${code}/main.fbs`;if(files[key])return;
 const idl=draft[code]??fs.readFileSync(sr+`/schema/${code}/main.fbs`,'utf8');files[key]=idl;
 for(const m of idl.matchAll(/include\s+"\.\.\/(\w+)\/main.fbs"/g))include(m[1]);
}
include('PRW');include('CQR');
const flatc=await FlatcRunner.init();
for(const code of ['PRW','CQR'])for(const lang of ['cpp','ts']){
 const generated=flatc.generateCode({entry:`/sds/${code}/main.fbs`,files},lang,{genObjectApi:true});
 assert(Object.keys(generated).length>0);console.log(`PASS flatc ${code} ${lang}: ${Object.keys(generated).length} generated files (memory only)`);
}
const withoutComments=x=>x.replace(/\/\/[^\n]*/g,'');
const declarations=(idl,kind)=>Object.fromEntries([...withoutComments(idl).matchAll(new RegExp('\\b'+kind+'\\s+(\\w+)[^{]*\\{([^}]+)\\}','g'))].map(m=>[m[1],m[2].split(kind==='table'?';':',').map(x=>x.replace(/\s+/g,'')).filter(Boolean)]));
const base=fs.readFileSync(sr+'/schema/PRW/main.fbs','utf8');
for(const kind of ['table','enum']){
 const a=declarations(base,kind),b=declarations(draft.PRW,kind);
 for(const [name,fields] of Object.entries(a))assert.deepEqual(b[name].slice(0,fields.length),fields,`append-only ${name}`);
}
console.log('PASS PRW append-only: all existing table fields, defaults and enum members retained');
const enums={...declarations(draft.PRW,'enum'),...declarations(draft.CQR,'enum')};
for(const [name,members] of Object.entries(enums))for(const m of members)assert(!/^(MIN|MAX)(=|$)/i.test(m),name);
const fields=Object.values({...declarations(draft.PRW,'table'),...declarations(draft.CQR,'table')}).flat().map(x=>x.split(':')[0]);
const norm=x=>x.replace(/_/g,'').toLowerCase();
for(const e of Object.keys(enums))assert(!fields.some(f=>norm(f)===norm(e)),`enum/field ${e}`);
for(const f of fields)assert(/^[A-Z][A-Z0-9_]*$/.test(f),f);
console.log('PASS field casing and enum-name collision checks');
const catalog=await std.loadKnownTypeCatalog();
const collision=catalog.filter(x=>x.schemaCode==='CQR'||x.fileIdentifier==='$CQR');assert.equal(collision.length,0);
const next=[...catalog.filter(x=>x.schemaCode!=='PRW'),...std.buildStandardsCatalog({STANDARDS:{PRW:{IDL:draft.PRW},CQR:{IDL:draft.CQR}}})];
const baseline={};
for(const name of ['propagator/hpop','analysis/conjunction-assessment']) {
 const manifest=JSON.parse(fs.readFileSync(root+'/'+name+'/plugin-manifest.json'));
 const report=await sdk.validateManifestWithStandards(manifest);
 const errors=report.issues.filter(x=>x.severity==='error');baseline[name]=errors;
 console.log(`BASELINE ${name}: ${errors.length} standards-aware errors`);
 const proposed=structuredClone(manifest);
 for(const method of proposed.methods)for(const dir of ['inputPorts','outputPorts'])for(const port of method[dir]??[]) {
  const original=port.acceptedTypeSets[0].allowedTypes[0];
  let code;
  if(name==='propagator/hpop')code='PRW';
  else if(['$CDM','$CSM','$OMM'].includes(original.fileIdentifier))code=original.fileIdentifier.slice(1);
  else code='CQR';
  port.acceptedTypeSets=[{setId:`sds-${code.toLowerCase()}`,allowedTypes:[{schemaName:`${code}.fbs`,fileIdentifier:`$${code}`,rootTypeName:code,wireFormat:'flatbuffer'}]}];
 }
 const check=await sdk.validateManifestWithStandards(proposed,{catalog:next});
 const errs=check.issues.filter(x=>x.severity==='error');assert.deepEqual(errs,[]);
 console.log(`PASS projected ${name}: 0 errors; ${check.issues.filter(x=>x.severity==='warning').length} warnings; injected candidate catalogue only`);
}
fs.writeFileSync('/tmp/tmpl-lane-11-baseline.json',JSON.stringify(baseline,null,2));
assert.equal(baseline['propagator/hpop'].length,27);assert.equal(baseline['analysis/conjunction-assessment'].length,84);
for(const code of ['PIV','TAB','PRW','PPE','OMM','OEM','OCM','CDM','CSM','PCE','EVL','MEM','TRH','ODR','FRM','RFM','TIM','NCD'])assert(catalog.some(x=>x.schemaCode===code),code);
console.log('PASS all 18 reused/candidate standards present in SDS 1.217.0; CQR unused');
```
