# Named Parameter Catalog

Evaluates named calculation parameters on orbital states, and publishes its own
roster as an SDS `$PCE` catalog.

## What it answers

The classical and equinoctial element sets, the derived orbit scalars, the
angular-momentum triple, the B-plane and asymptote sets, the planet-relative
angles, the atomic and dynamical time scales, and the state-transition
sub-matrices — over the same IAU-2006/2000A chain and the same element-set
library that `foundation/frames` and `foundation/orbits` own. There is no second
copy of either here.

## Where the roster comes from

`fixtures/reference-parameter-roster.json` carries every named calculation
parameter of the reference mission-analysis tool R2026a, extracted from its
Apache-2.0 source (`src/base/factory/ParameterFactory.cpp`) at the commit the
parity program names, with that file's SHA-256 recorded beside it.
`generate-parameter-roster.mjs` classifies each name — owner class, unit, value
kind, frame dependency, availability — and emits the C++ roster.

**A name that is not classified fails the build, by name.** That is the point: a
hand-typed roster drifts from the source it claims parity with and the drift is
invisible, because a misspelled parameter simply never matches.

`generate-pce-crosswalk.mjs` does the same for the published `pceParameter`
vocabulary: every member is either mapped to a roster entry or listed as
deliberately unmapped with its reason, so a later SDS release cannot add a
parameter this module silently ignores.

## Declared and refusing

Attitude, hardware, torque, power, mean-element and covariance parameters are in
the roster and are **refused by name**, with `AVAILABILITY` =
`DECLARED_UNAVAILABLE` and an `UNAVAILABLE_REASON` naming the provider family
that is missing. A publisher never substitutes a neighbouring quantity.

## Verification

```sh
npm run generate && npm run build && npm test
```

- `tests/parameter_catalog_parity.test.mjs` compiles the same headers natively
  and measures them against the external library's own unit-test vectors, the
  published IAU-1982 sidereal worked example, and exact identities.
- `tests/parameters.test.mjs` measures the SHIPPED artifact on the wire.
