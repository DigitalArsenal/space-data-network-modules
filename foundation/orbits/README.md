# Foundation Orbits

`foundation/orbits` is an SDK-compliant C++ module that converts between SDS
OMM mean Keplerian element messages and SDS OEM Cartesian state-vector messages,
promotes SDS OPM and VCM Cartesian, Keplerian, and equinoctial records into
OEM or OMM forms, and converts SDS VCM Keplerian elements to equinoctial
forms. It also maps chief/deputy SDS VCM Cartesian state pairs into SDS CDM
relative RTN/Hill state fields and maps CDM Hill relative state plus a chief
VCM state back into a deputy VCM Cartesian state.

The initial parity slices cover Orekit-compatible non-circular,
non-equatorial elliptical mean-anomaly conversion plus Basilisk circular
singular-case recovery and hyperbolic mean-anomaly conversion using SDS units:

- `SEMI_MAJOR_AXIS` in km
- emitted OMM `MEAN_MOTION` in rev/day, derived from Basilisk
  `KeplerianOrbit.n() = sqrt(GM / a^3)` for finite positive semi-major axes
- `ECCENTRICITY` unitless
- `INCLINATION`, `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, and `MEAN_ANOMALY` in degrees
- `GM` in km^3/s^2
- OEM `ephemerisDataLine` position in km and velocity in km/s
- OPM Cartesian position in km, velocity in km/s, and `GM` in km^3/s^2
- OPM Keplerian `TRUE_ANOMALY` in degrees for the dedicated
  `opm_keplerian_to_oem` element-derived path
- VCM `KEPLERIAN_ELEMENTS` angles in degrees and `EQUINOCTIAL_ELEMENTS.L` as
  true longitude in degrees
- VCM `KEPLERIAN_ELEMENTS.PERIAPSIS_RADIUS` in km for parabolic states with
  `SEMI_MAJOR_AXIS=0` and `ECCENTRICITY=1`
- VCM `STATE_VECTOR.EPOCH` as the timestamp source for VCM-to-OEM/OMM output
- VCM `STATE_VECTOR` position in km and velocity in km/s for VCM state-vector
  promotion and inverse element recovery
- GRV `EQUATORIAL_RADIUS` in the same distance units as the input VCM
  `SEMI_MAJOR_AXIS`, GRV `MU` in km^3/s^2, and GRV `J2` through `J6` as
  unitless zonal coefficients for Basilisk J-perturbation acceleration and
  first-order mean-to-osculating maps
- VCM `MASS` in kg, `SOLAR_RAD_AREA` in m^2, and `SOLAR_RAD_COEFF` unitless,
  plus CRD `X/Y/Z` in AU for Basilisk solar radiation pressure acceleration
- CDM `RELATIVE_POSITION_R/T/N` in km and `RELATIVE_VELOCITY_R/T/N` in km/s
  for Basilisk Hill-frame relative states

`keplerian_to_cartesian` consumes one OMM frame and emits one OEM
`ephemerisDataBlock` containing one explicit `ephemerisDataLine`.
`cartesian_to_keplerian` consumes one OEM state-vector frame plus one OMM
`gravity_context` frame carrying `GM` and optional object metadata, then emits
one OMM mean-element frame. Epoch and time-system metadata are copied through
without conversion; time-scale normalization belongs in `foundation/time`. All
OMM emitters populate `MEAN_MOTION` in rev/day when `GM > 0` and
`SEMI_MAJOR_AXIS > 0`; parabolic OMM outputs keep mean motion at zero because
semi-major axis is undefined. Parabolic OEM inverse recovery emits Barker mean
anomaly in OMM `MEAN_ANOMALY`.
`opm_to_oem` consumes one OPM frame and emits one OEM `ephemerisDataBlock`
containing the OPM Cartesian state. `opm_keplerian_to_oem` consumes one OPM
frame and emits an OEM state derived from the OPM Keplerian fields and
`TRUE_ANOMALY`, ignoring the OPM Cartesian fields. `opm_keplerian_to_omm`
normalizes those same OPM Keplerian fields into an OMM mean-element frame by
converting `TRUE_ANOMALY` to `MEAN_ANOMALY`. `opm_to_omm` consumes one OPM
frame and emits one OMM mean-element frame by deriving the elements from the
OPM Cartesian state and `GM`, including parabolic states with Barker mean
anomaly.
`vcm_keplerian_to_oem` consumes one VCM frame with `STATE_VECTOR.EPOCH`,
`KEPLERIAN_ELEMENTS`, and `GM`, then emits one OEM `ephemerisDataBlock`
derived from the Keplerian fields, including parabolic `TRUE_ANOMALY` states
when VCM `PERIAPSIS_RADIUS` is present. `vcm_keplerian_to_state` emits the
same derived Cartesian values back into VCM `STATE_VECTOR`.
`vcm_keplerian_to_omm` normalizes those VCM Keplerian fields into one OMM
mean-element frame, converting elliptic, hyperbolic, or parabolic
`TRUE_ANOMALY` to `MEAN_ANOMALY` when required. Parabolic normalization uses
Barker's equation and requires VCM `PERIAPSIS_RADIUS`.
`vcm_keplerian_to_true_anomaly` and `vcm_keplerian_to_mean_anomaly` normalize
the same VCM `KEPLERIAN_ELEMENTS` envelope in place, emitting VCM Keplerian
elements with `ANOMALY_TYPE` set to `TRUE_ANOMALY` or `MEAN_ANOMALY` using
Basilisk-compatible elliptic and hyperbolic anomaly conversions plus Barker's
closed-form parabolic mean-anomaly convention when `PERIAPSIS_RADIUS` is
present.
`vcm_keplerian_mean_to_osculating` and
`vcm_keplerian_osculating_to_mean` consume one elliptical VCM
`KEPLERIAN_ELEMENTS` frame plus one SDS GRV `gravity_context` frame carrying
`EQUATORIAL_RADIUS` and `J2`, then emit a VCM `KEPLERIAN_ELEMENTS` frame using
Basilisk `clMeanOscMap` first-order J2 mean/osculating semantics.
`vcm_state_to_oem` promotes VCM `STATE_VECTOR` fields into OEM,
`vcm_state_to_j_zonal_acceleration_oem` consumes the same VCM `STATE_VECTOR`
plus an SDS GRV `gravity_context` carrying `MU`, `EQUATORIAL_RADIUS`, and
`J2` through `J6`, then emits OEM `ephemerisDataLine` acceleration fields
using Basilisk `jPerturb` J2-J6 zonal perturbation semantics.
`vcm_state_to_srp_acceleration_oem` consumes VCM `STATE_VECTOR` plus VCM
`MASS`, `SOLAR_RAD_AREA`, and `SOLAR_RAD_COEFF`, and a CRD `sun_vector` whose
`X/Y/Z` values are the central-body-to-Sun vector in AU, then emits OEM
`ephemerisDataLine` acceleration fields using Basilisk `solarRad` semantics.
`vcm_state_to_omm` derives OMM mean elements from VCM `STATE_VECTOR` and `GM`,
including parabolic state vectors by converting the recovered true anomaly to
Barker mean anomaly. `vcm_state_to_keplerian` derives VCM
`KEPLERIAN_ELEMENTS` from the same state vector while storing
`ANOMALY_TYPE=MEAN_ANOMALY` for elliptic and hyperbolic states. For parabolic
VCM state-vector inverse recovery,
`vcm_state_to_keplerian` emits `SEMI_MAJOR_AXIS=0`, `ECCENTRICITY=1`, and
`ANOMALY_TYPE=TRUE_ANOMALY`, plus `PERIAPSIS_RADIUS` for forward round trips.
Recovered parabolic true anomaly follows Basilisk `rv2elem` conic-range
semantics and remains signed instead of being wrapped to `[0, 360)`.
`vcm_state_to_equinoctial` derives VCM `EQUINOCTIAL_ELEMENTS` from the same
recovered mean-anomaly elements.
`keplerian_to_equinoctial` consumes one VCM frame with `KEPLERIAN_ELEMENTS` and
emits one VCM frame with `EQUINOCTIAL_ELEMENTS` populated while preserving the
input Keplerian elements and orbit metadata.
`equinoctial_to_keplerian` consumes one VCM frame with `EQUINOCTIAL_ELEMENTS`
and emits one VCM frame with `KEPLERIAN_ELEMENTS` populated with
`TRUE_ANOMALY`, preserving the input equinoctial elements and orbit metadata.
`vcm_equinoctial_to_omm` consumes one VCM frame with `EQUINOCTIAL_ELEMENTS`,
`STATE_VECTOR.EPOCH`, and `GM`, then emits one SDS OMM mean-element frame by
recovering the classical true anomaly and converting it to `MEAN_ANOMALY`.
`vcm_equinoctial_to_oem` uses the same recovered true-anomaly elements to emit
one SDS OEM Cartesian state vector, while `vcm_equinoctial_to_state` emits the
same Cartesian result as a VCM `STATE_VECTOR`. Circular prograde equinoctial
inputs are accepted by treating `L` as true longitude, deriving RAAN from
`CHI`/`PSI` when inclination is defined, and setting undefined argument of
pericenter to zero.
`vcm_pair_to_cdm_relative_hill` consumes chief and deputy VCM `STATE_VECTOR`
records and emits one SDS CDM whose `RELATIVE_POSITION_R/T/N` and
`RELATIVE_VELOCITY_R/T/N` fields use Basilisk's `rv2hill` radial,
transverse, and normal Hill-frame convention. Inputs and outputs are in km and
km/s. `cdm_relative_hill_to_vcm_deputy_state` consumes the same chief VCM
`STATE_VECTOR` plus a CDM Hill relative state and emits a deputy VCM
`STATE_VECTOR` using Basilisk's inverse `hill2rv` convention.

For circular inverse conversions, undefined angles are normalized rather than
invented: circular inclined states set `ARG_OF_PERICENTER` to zero and store
the argument of latitude in `MEAN_ANOMALY`; circular equatorial states set both
`RA_OF_ASC_NODE` and `ARG_OF_PERICENTER` to zero and store true longitude in
`MEAN_ANOMALY`.

For non-circular equatorial inverse conversions, undefined RAAN is normalized
to zero and the longitude of pericenter is stored in `ARG_OF_PERICENTER` while
`MEAN_ANOMALY` remains the elliptic mean anomaly. For circular retrograde
equatorial states, `RA_OF_ASC_NODE` and `ARG_OF_PERICENTER` are both zeroed and
`MEAN_ANOMALY` stores the retrograde true longitude.

For hyperbolic conversions, `SEMI_MAJOR_AXIS` is negative, `ECCENTRICITY` is
greater than one, and `MEAN_ANOMALY` stores the non-periodic hyperbolic mean
anomaly in degrees. Parabolic VCM forward conversion uses
`PERIAPSIS_RADIUS` and accepts either `TRUE_ANOMALY` or Barker mean anomaly in
the VCM `ANOMALY` field. OMM parabolic normalization emits Barker mean anomaly
and zero mean motion; equinoctial conversion remains fail-closed for parabolic
states. Basilisk `orbElemConvert` parity coverage includes the upstream
inclined/equatorial elliptic, circular, parabolic, and hyperbolic parameter
sweep, converted from SI source units into SDS km, km/s, km^3/s^2, and degree
VCM fields, through both Keplerian-to-state and state-to-Keplerian paths.

For VCM equinoctial conversion, this module currently supports finite
elliptical Keplerian elements with `TRUE_ANOMALY` or `MEAN_ANOMALY`, and finite
elliptical equinoctial elements including circular prograde cases. The output uses SDS VCM fields
`AF=e*cos(ARG_OF_PERICENTER+RA_OF_ASC_NODE)`,
`AG=e*sin(ARG_OF_PERICENTER+RA_OF_ASC_NODE)`,
`CHI=tan(INCLINATION/2)*sin(RA_OF_ASC_NODE)`,
`PSI=tan(INCLINATION/2)*cos(RA_OF_ASC_NODE)`, `N=SEMI_MAJOR_AXIS`, and
`L=RA_OF_ASC_NODE+ARG_OF_PERICENTER+TRUE_ANOMALY`. The inverse emits
`ANOMALY_TYPE=TRUE_ANOMALY`; the OMM normalization path converts that recovered
true anomaly into elliptic mean anomaly, while the OEM path converts it through
the shared Keplerian Cartesian equations.

## Build And Test

```bash
npm install
npm run build
npm test
npm run test:sdk-compat
```
