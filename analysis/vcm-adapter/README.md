# analysis/vcm-adapter

Vector Covariance Messages in and out of the stack. A VCM (the SP VECTOR/
COVARIANCE MESSAGE V2.0; format in spacedatastandards.org
`survey/legacy-messages/vcm`) becomes what `propagator/hpop` runs and an SDS
`$OCM`; a propagation result becomes an `$OCM`; and the legacy VCM text is
generated from an `$OCM` for the systems that still read it. SDS `$VCM` is
deprecated: the `$OCM` carries everything a VCM does.

| Method | In | Out |
| --- | --- | --- |
| `read` | `message`: `$FIL` whose CONTENT is one VCM as text | `request`: `$PRW` EXECUTION_REQUEST; `earth_orientation`: `$PRW` EARTH_ORIENTATION; `eop`: `$EOP` records; `ocm`: `$OCM`; `report`: FlowNotice Info |
| `ocm` | `result`: `$PRW` EXECUTION_RESULT (EME2000) | `ocm`: `$OCM` |
| `write` | `ocm`: `$OCM`; `eop`: `$EOP` records (optional) | `message`: `$FIL` (NAME `<satellite>.vcm`, MEDIA_TYPE `text/plain`, CONTENT the VCM text) |

Typed contracts 1.0: every port is one FlatBuffer type. The settings are node
config (`plugin.getConfig`, one ModuleConfig): table `read` (the read options
below), table `header` (the `ocm` header: identity, model lines, parameter
values, space weather, integrator lines, `weightedRms`, `covarianceScale`,
`meanMotionUnit`, `parameterRows`) and table `write` (`meanMotionUnit`,
`parameterRows`, `covarianceScale`). Values are strings, numbers or booleans;
unknown read/write keys are refused. `read`'s report is a FlowNotice Info:
SCHEMA `OCM.fbs`, SOURCE_NAME the satellite number, COUNT the covariance
size, REASON the notes, ITEMS `key=value` lines (numbers `%.17g`, lists
space-separated, one `parameterSigma=<name> <unit> <value> <sigma>` per
parameter row, one `note=` per note).

## What `read` builds

- **State.** J2K POS/VEL as an EME2000 resident state; HPOP rotates it by the
  IAU 2000 frame bias and integrates in GCRF.
- **Forces.** GEOPOTENTIAL `<model> mmZ,nnT` as EGM96 (or EGM2008 standing in
  for a model HPOP does not embed) to degree max(mm, nn), order nn, tesserals
  to nn; LUNAR/SOLAR as the Sun and Moon; SOLAR RAD PRESS with Cr·A/m = AGOM;
  DRAG with Cd·A/m = B (mass 1000 kg and area 1 m², so Cd = 1000 B and
  Cr = 1000 AGOM): JAC70 as Jacchia-Roberts, JB… as JB2008 (which reads the
  `jb2008_indices` input; a VCM does not carry SET's indices, so the report
  says so), otherwise NRLMSISE-00, with F10, AVERAGE F10 and AVERAGE AP held
  as WEATHER; BDOT as `DRAG_AREA_OVER_MASS_RATE_M2_KG_S`; SOLID EARTH TIDES as
  IERS 2010; IN-TRACK THRUST with THRUST ACCEL.
- **Covariance.** The rows the fit solved for (nonzero variance, force on)
  among B, BDOT, AGOM and T become `DYNAMIC_PARAMETERS`, and the covariance
  over the state and those parameters is transformed from equinoctial to
  Cartesian SI: J P Jᵀ with J = ∂(r, v)/∂(af, ag, L, n, χ, ψ) evaluated
  exactly with forward-mode dual numbers through the closed-form conversion.
  By default it is scaled by WTD RMS², as the VCM's printed sigmas are.
  Consider parameters (C1, C2, …) have no PRW force and are dropped.
- **Earth orientation.** The single EOP point becomes daily `$EOP` rows from
  the day before the epoch to the day after the arc: UT1 − UTC moving at the
  stated rate (LOD = −rate), stepping by a second at the stated leap second,
  polar motion held.
- **`$EOP`.** The same daily rows as `earth_orientation`, one size-prefixed
  `$EOP` record per day, for `write` and for any reader of `$EOP`.
- **`$OCM`.** The message as the one record the stack publishes: see below.

Read options (config table `read`): `meanMotionUnit` (`fraction`, default: the covariance's n row as
dn/n; or `rad/ks`, `rad/s`, `rad/min`, `rev/day`), `scaleCovarianceByWeightedRms`
(default true: times max(1, WTD RMS)^2), `arcSeconds` (default 86400),
`ephemerisSource` (default `JPL_SPK`: attach a DE440 kernel on HPOP's kernel
port), `parameterRows` (`fractional`, default, or `absolute`; see below).

## The `$OCM`

`read` and `ocm` write the same record, built by `common/ocm_fb_builder.hpp`,
the builder `analysis/od` writes its fits' OCMs with.

| VCM | OCM |
| --- | --- |
| message time, center | `HEADER.CREATION_DATE`, `HEADER.ORIGINATOR` |
| satellite number, int. des., common name | `METADATA.OBJECT_DESIGNATOR` (CATALOG_NAME `SATCAT`), `INTERNATIONAL_DESIGNATOR`, `OBJECT_NAME` |
| epoch (UTC), epoch rev | `METADATA` START_TIME, STOP_TIME, EPOCH_TZERO; `ORB_REVNUM` |
| J2K position and velocity | `STATE_DATA` (km, km/s), `TRAJ_REF_FRAME` EME2000, `CENTER_NAME` EARTH |
| covariance | `COVARIANCE_DATA`: Cartesian, `COV_TYPE` CARTPV, `COV_ORDERING` LTM, `COV_SIZE` 6 plus the parameter rows, `COV_PARAMETERS` naming them, `COV_UNITS`, `COV_REF_FRAME` EME2000; scaled by the weighted RMS as the message's sigmas are (`COVARIANCE_SCALE`) |
| B, BDOT, AGOM, THRUST ACCEL | `ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS` (DRAG_AREA_OVER_MASS, DRAG_AREA_OVER_MASS_RATE, SRP_AREA_OVER_MASS, IN_TRACK_ACCELERATION, each with its value, units and whether the fit solved for it); thrust only when IN-TRACK THRUST is ON |
| WTD RMS, EDR | `WEIGHTED_RMS`, `SEDR` |
| geopotential, drag, lunar/solar, solar radiation pressure, solid earth tides, F10, average F10, average AP | `PERTURBATIONS`: `GEOPOTENTIAL_MODEL` (`EGM-96 70Z,70T`), `GRAVITY_MODEL`, `GRAVITY_DEGREE`, `GRAVITY_ORDER`, `ATMOSPHERIC_DRAG`, `N_BODY_PERTURBATIONS`, `SOLAR_RAD_PRESSURE`, `SOLID_TIDES_MODEL`, `FIXED_F10P7`, `FIXED_F10P7_MEAN`, `FIXED_GEOMAG_AP`, `GM` |
| TAI-UTC, UT1-UTC, leap second time | `METADATA.TAIMUTC_AT_TZERO`, `UT1MUTC_AT_TZERO`, `NEXT_LEAP_EPOCH` |
| UT1 rate, polar motion | the `$EOP` records (LOD, X and Y pole) |
| integrator mode, coordinate system, partials, step mode, fixed step, step size selection, initial step, error control, nutation terms, C.M. offset, indicator | `USER_DEFINED_PARAMETERS` named `VCM_*` |
| ECI and EFG states, U, V, W sigmas | not stored: `write` computes them from the J2K state, the epoch and the covariance |

`USER_DEFINED_PARAMETERS` also records how the covariance was made from the
printed one (`COVARIANCE_SCALE`, `MEAN_MOTION_UNIT`, `PARAMETER_ROWS`) so that
`write` undoes it, and `options` on `write` can override them. The record is
EME2000 only: `write` refuses another frame, a covariance that is not CARTPV,
or a parameter row a VCM has no slot for. `ocm` builds the same record from an
HPOP result and the `header` lines (the keys `write` took before the OCM:
identity, model lines, parameter values, weightedRms, `meanMotionUnit`,
`parameterRows`, and now `covarianceScale`); the Earth orientation comes from
the `$EOP` records, not the header.

## The units of the covariance

The format states none. Four messages settle the mean-motion row: the
survey's sample (an ISS solution) and three SP messages on hand that are not
redistributed (a geostationary orbit, a GPS satellite, and an orbit of
eccentricity 0.59 with perigee in the atmosphere). With the n row and column
read as dn/n and the covariance scaled by max(1, WTD RMS)^2, every printed
U, V and W sigma of all four is reproduced within 1 % (the printed covariance
has five digits). No absolute unit does: the eccentric message's radial
sigma is 45.8 m printed, 45.8 m as dn/n, 36.9 m with n in rad per 1000 s and
51.1 m in rev/day; rad per 1000 s, which fits the ISS sample alone (8.40 m
against 8.4), misses the geostationary and GPS radial sigmas by factors of
2.0 and 1.7. The V and W sigmas do not depend on n's reading; they identify
the scaling: the eccentric message (WTD RMS 0.86) matches unscaled, the
others (1.09 to 1.15) only scaled. Every read reports the recomputed sigmas
beside the stated ones. `tests/vcm_adapter.test.mjs` checks the sample, and
the private messages when `VCM_PRIVATE_DIR` names a directory of them.

The parameter rows (B, BDOT, AGOM, T) are not covered by the printed sigmas.
Read like the n row, as fractions of their values (`parameterRows:
"fractional"`, the default), the four messages give sigmas of 1.5 % to 9.7 %
of B or AGOM; read as printed in m^2/kg (`"absolute"`), 0.38 to 5.6 times the
parameter itself, which fits of tens of metres would hardly leave. B and
AGOM rows are scaled by their values when fractional; BDOT and T rows are
taken as printed. Every read reports the parameter sigmas it carried
(`parameterSigmas`), and `write` takes the same keys in its header so a
message goes back out the way it came in. One measurement supports the
fractional reading: the GPS message, propagated a day by HPOP and compared
with ESA's final orbit for the satellite, has radial and in-track errors
with RMS 0.46 and 0.64 of their sigmas when its AGOM row is read as a
fraction; read as printed, the sigmas overstate the radial error about 20
times and the in-track error about 7 times after half a day (in-track sigma
1.29 km at 24 h against an error of 93 m). One satellite over one day is
evidence, not a calibration of either reading.

## What `write` writes

The legacy text, from an `$OCM` in EME2000: J2K from the state, ECI as TEME of
date (`foundation/frames` axis engine, IAU 2006/2000A) and EFG by GMST 1982 of
UT1 without polar motion, as the format defines them; the model, parameter,
weather, integrator and leap second lines from the OCM; TAI-UTC and UT1-UTC
from its metadata, the UT1 rate and the pole from the `$EOP` record of the
epoch's day (0 without one); UVW sigmas from the covariance and the
equinoctial covariance with B, BDOT, AGOM and T in their slots (the size is the
last slot used).

## Verification

`tests/vcm_adapter.test.mjs`: the sample's sigmas reproduced within 1 % (and
not with rad/s, rad/min or rev/day); the Cartesian covariance against an
independent finite-difference Jacobian written in the test (2.3e-7 of the
sigmas); the private messages when `VCM_PRIVATE_DIR` names them (all within
1 %, the scaling rule, and rad/ks excluded; each also through VCM -> OCM ->
VCM text); the sample through VCM -> OCM -> VCM text (printed sigmas within
1 % and the covariance identical to its five printed digits, with every model,
parameter, Earth orientation, integrator and leap second line as printed); the
decoded `$OCM` (state, covariance with its parameter row, parameter values,
force model, settings); the request run through HPOP for an hour with B as a
parameter, the result written as an `$OCM` and as VCM text and read back (state
to the printed digits, covariance to 1.8e-5 of the sigmas, with and without a
weighted RMS above 1); and `parameterRows` both ways (the six element rows
identical, the B sigma 5.14 x B as printed and 4.25 % as a fraction, and a
fractional B row written back unchanged).

`tests/parity.mjs`: read, ocm and write byte-identical in the browser,
WasmEdge and Docker WasmEdge (`conformance/parity.json`).

```sh
npm run build   # SDN_WASI_* toolchain environment as for propagator/hpop
npm test
npm run test:parity
```
