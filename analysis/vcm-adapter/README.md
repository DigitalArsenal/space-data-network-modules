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

Options: `meanMotionUnit` (`rad/ks`, default, `rad/s`, `rad/min`,
`rev/day`), `scaleCovarianceByWeightedRms` (default true), `arcSeconds`
(default 86400), `ephemerisSource` (default `JPL_SPK`: attach a DE440 kernel
on HPOP's kernel port), `parameterRows` (`absolute`, default, or
`fractional`; see below).

## The units of n

The format does not state them. The survey's sample is a real ISS message
(epoch revolution 37693), so its printed U, V, W sigmas (8.4, 40.2, 7.4 m)
are SP's own evaluation of its covariance. Transformed with n in radians per
1000 s and scaled by the weighted RMS, the covariance reproduces them to the
printed digits (8.40, 40.23, 7.42 m); with rad/s the radial sigma is 1.4 km,
rad/min 26 m, rev/day 8.0 m and the canonical time unit 8.5 m. The V and W
sigmas do not depend on n's unit and match in every case, which is what
identifies the weighted-RMS scaling. Every read reports the recomputed
sigmas beside the stated ones, so a message in other units shows itself.

## The units of the parameter rows

Not stated either, and the printed sigmas cannot settle them: they cover the
six elements only. `parameterRows: "absolute"` (the default) takes the B,
BDOT, AGOM and T rows in the units printed on the model lines (m²/kg,
m²/kg/s, m/s²); `"fractional"` takes the B and AGOM rows as fractions of B
and AGOM (BDOT and T rows still as printed). The sample tells the two apart
only by plausibility: as printed, its B sigma is 5.1 times B itself, which
propagates to an in-track sigma of tens of kilometres after a day for an
orbit fitted to 40 m; as a fraction it is 4.3 % of B. Every read reports the
parameter sigmas it carried (`parameterSigmas`), and `write` takes the same
key in its header so a message goes back out the way it came in. A VCM for
an object with a precise orbit to check it against, or the format's
interface document, will settle it.

## What `write` writes

J2K from the result (EME2000 required), ECI as TEME of date
(`foundation/frames` axis engine, IAU 2006/2000A) and EFG by GMST 1982 of
UT1 without polar motion, as the format defines them; model, solar and Earth
orientation lines from the header; UVW sigmas and the equinoctial covariance
with B, BDOT, AGOM and T in their slots (the size is the last slot used).

## Verification

`tests/vcm_adapter.test.mjs`: the sample's sigmas reproduced (and not with
the other units); the Cartesian covariance against an independent
finite-difference Jacobian written in the test (2.3e-7 of the sigmas); the
request run through HPOP for an hour with B as a parameter; and the result
written as a VCM and read back (state to the printed digits, covariance to
3.5e-6 of the sigmas); `parameterRows` both ways (the six element rows
identical, the B sigma 5.14 × B as printed and 4.25 % as a fraction, and a
fractional B row written back unchanged).

```sh
npm run build   # SDN_WASI_* toolchain environment as for propagator/hpop
npm test
```
