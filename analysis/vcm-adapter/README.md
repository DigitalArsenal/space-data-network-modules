# analysis/vcm-adapter

Vector Covariance Messages in and out of the stack. A VCM (the SP VECTOR/
COVARIANCE MESSAGE V2.0; format in spacedatastandards.org
`survey/legacy-messages/vcm`) becomes what `propagator/hpop` runs, and a
propagation result becomes a VCM.

| Method | In | Out |
| --- | --- | --- |
| `read` | `message`: one VCM as text; `options` (JSON, optional) | `request`: `$PRW` EXECUTION_REQUEST; `earth_orientation`: `$PRW` EARTH_ORIENTATION; `vcm`: `$VCM`; `report`: JSON |
| `write` | `result`: `$PRW` EXECUTION_RESULT (EME2000); `header` (JSON, optional) | `message`: VCM text |

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
- **`$VCM`.** Identity, state, equinoctial elements (with `N` as the schema
  documents it, the semi-major axis in km), model flags, the stated sigmas and
  the Cartesian 6×6 covariance. The schema has no fields for B, BDOT, AGOM,
  T or the parameter rows; those travel in the request and the report.

Options: `meanMotionUnit` (`fraction`, default: the covariance's n row as
dn/n; or `rad/ks`, `rad/s`, `rad/min`, `rev/day`), `scaleCovarianceByWeightedRms`
(default true: times max(1, WTD RMS)^2), `arcSeconds` (default 86400),
`ephemerisSource` (default `JPL_SPK`: attach a DE440 kernel on HPOP's kernel
port), `parameterRows` (`fractional`, default, or `absolute`; see below).

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
message goes back out the way it came in. The reading is inferred, not yet
measured: a message for an object with a precise orbit, propagated against
it, would measure it.

## What `write` writes

J2K from the result (EME2000 required), ECI as TEME of date
(`foundation/frames` axis engine, IAU 2006/2000A) and EFG by GMST 1982 of
UT1 without polar motion, as the format defines them; model, solar and Earth
orientation lines from the header; UVW sigmas and the equinoctial covariance
with B, BDOT, AGOM and T in their slots (the size is the last slot used).

## Verification

`tests/vcm_adapter.test.mjs`: the sample's sigmas reproduced within 1 % (and
not with rad/s, rad/min or rev/day); the Cartesian covariance against an
independent finite-difference Jacobian written in the test (2.3e-7 of the
sigmas); the private messages when `VCM_PRIVATE_DIR` is set (all within 1 %,
the scaling rule, and rad/ks excluded); the request run through HPOP for an
hour with B as a parameter; the result written as a VCM in SP's Fortran
number format and read back (state to the printed digits, covariance to
1.8e-5 of the sigmas, with and without a weighted RMS above 1); and
`parameterRows` both ways (the six element rows identical, the B sigma
5.14 x B as printed and 4.25 % as a fraction, and a fractional B row written
back unchanged).

```sh
npm run build   # SDN_WASI_* toolchain environment as for propagator/hpop
npm test
```
