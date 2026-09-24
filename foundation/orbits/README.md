# Foundation Orbits

`foundation/orbits` is an SDK-compliant C++ module that converts between SDS
OMM mean Keplerian element messages and SDS OEM Cartesian state-vector messages,
promotes SDS OPM and OCM Cartesian and element-set records into OEM or OMM
forms, and converts between OCM Cartesian, Keplerian and equinoctial
trajectories. It also maps chief/deputy OCM Cartesian state pairs into SDS CDM
relative RTN/Hill state fields and maps a CDM Hill relative state plus a chief
OCM state back into a deputy OCM state.

OCM replaces the superseded VCM. Legacy VCM text and `$VCM` records convert to
`$OCM` through `files/orbit-products` (`normalize_vcm`, `vcm_to_ocm`).

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
- OCM trajectories carry one `STATE_DATA` row in CCSDS 502.0-B-3 units:
  `CARTESIAN_PV` in km and km/s; `KEPLERIAN` / `KEPLERIAN_MEAN`
  `[a km, e, i, RAAN, argument of periapsis, true or mean anomaly deg]`;
  `EQUINOCTIAL` `[a km, af, ag, mean longitude deg, chi, psi, fr]` and
  `EQUINOCTIAL_MOD` `[p km, af, ag, true longitude deg, chi, psi, fr]`, as
  defined by the SANA Orbital Elements registry
- OCM `PERTURBATIONS.GM` in km^3/s^2 for element conversions; OCM
  `ORB_AVERAGING` `OSCULATING` (or absent) or `BROUWER`
- OCM epoch (`METADATA.START_TIME`, else `EPOCH_TZERO`), `METADATA.TIME_SYSTEM`,
  `CENTER_NAME` and `TRAJ_REF_FRAME` are required and copied to every output;
  OEM outputs carry the frame as `REFERENCE_FRAME`
- GRV `EQUATORIAL_RADIUS` in km, GRV `MU` in km^3/s^2, and GRV `J2` through
  `J6` as unitless zonal coefficients for Basilisk J-perturbation acceleration
  and first-order mean-to-osculating maps
- OCM `PHYSICAL_PROPERTIES` `WET_MASS` in kg, `SRP_CONST_AREA` in m^2 and
  `SOLAR_RAD_COEFF` unitless, plus CRD `X/Y/Z` in AU, for Basilisk solar
  radiation pressure acceleration
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
`ocm_keplerian_to_oem` and `ocm_keplerian_to_state` derive a Cartesian state
from an OCM Keplerian or equinoctial element set and `PERTURBATIONS.GM`,
emitting SDS OEM or an OCM `CARTESIAN_PV` trajectory. `ocm_keplerian_to_omm`
normalizes the element set into one OMM mean-element frame.
`ocm_keplerian_to_true_anomaly` and `ocm_keplerian_to_mean_anomaly` re-express
the elements as `KEPLERIAN` or `KEPLERIAN_MEAN` using Basilisk-compatible
elliptic and hyperbolic anomaly conversions.
`ocm_keplerian_mean_to_osculating` and `ocm_keplerian_osculating_to_mean`
apply Basilisk `clMeanOscMap`, the first-order J2 Brouwer map, with a GRV
`gravity_context` carrying `EQUATORIAL_RADIUS` and `J2`; the input must declare
`ORB_AVERAGING` `BROUWER` or osculating respectively, and the output declares
the other.
`ocm_state_to_oem` copies an OCM Cartesian state into OEM;
`ocm_state_to_j_zonal_acceleration_oem` adds Basilisk `jPerturb` J2-J6 zonal
acceleration from a GRV context; `ocm_state_to_srp_acceleration_oem` adds
Basilisk `solarRad` acceleration from OCM `PHYSICAL_PROPERTIES` and a CRD
central-body-to-Sun vector in AU. `ocm_state_to_omm` derives OMM mean elements,
including parabolic states with Barker mean anomaly. `ocm_state_to_keplerian`
emits `KEPLERIAN_MEAN` elements with `ORB_AVERAGING` `OSCULATING`, and
`ocm_state_to_equinoctial` emits `EQUINOCTIAL` elements.
`keplerian_to_equinoctial` and `equinoctial_to_keplerian` convert between the
OCM element sets; `ocm_equinoctial_to_omm`, `ocm_equinoctial_to_oem` and
`ocm_equinoctial_to_state` follow the Keplerian paths above.
`ocm_pair_to_cdm_relative_hill` consumes chief and deputy OCM Cartesian states
and emits one SDS CDM whose `RELATIVE_POSITION_R/T/N` and
`RELATIVE_VELOCITY_R/T/N` fields use Basilisk's `rv2hill` radial, transverse
and normal Hill-frame convention, in km and km/s.
`cdm_relative_hill_to_ocm_deputy_state` inverts it with Basilisk `hill2rv`; the
deputy OCM takes the CDM `TCA` as its epoch and carries none of the chief's
identity.

Every OCM output is the input OCM with its trajectory replaced. An input
covariance is not carried into a different representation, and the header says
so.

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
anomaly in degrees. SANA Keplerian element sets need a finite semi-major axis,
so parabolic orbits are refused on OCM element-set input and output; parabolic
Cartesian states still convert to OMM with Barker mean anomaly and zero mean
motion. Equinoctial conversion is fail-closed for non-elliptical orbits.

OCM equinoctial elements follow the SANA registry exactly, through the
GMAT-parity conversions in `src/state_representations.hpp`:
`af=e*cos(argp+fr*RAAN)`, `ag=e*sin(argp+fr*RAAN)`,
`chi=tan(i/2)^fr*sin(RAAN)`, `psi=tan(i/2)^fr*cos(RAAN)`, `L=M+argp+fr*RAAN`
(mean longitude) for `EQUINOCTIAL` and `L'=nu+argp+fr*RAAN` (true longitude)
with `p=a(1-e^2)` for `EQUINOCTIAL_MOD`. Output uses `fr=+1` for direct and
`fr=-1` for retrograde orbits. The earlier VCM output, which used true
longitude and no retrograde factor, matched neither SANA set.

## Build And Test

```bash
npm install
npm run build
npm test
npm run test:sdk-compat
```
