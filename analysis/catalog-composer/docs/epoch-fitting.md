# Epoch-state conversion, validation and refinement

This path never derives the initial velocity from ten-minute provider positions.
The reader converts osculating elements to an analytic J2000 position/velocity
using the existing `foundation/orbits` implementation. The catalog module checks
propagated positions against the provider's independently supplied position arc.

## Binary module interfaces

| Module / method | Inputs | Outputs |
| --- | --- | --- |
| `files.orbit-products / normalize_vimpel` | NCD descriptor followed by exact orbit-table bytes; format `vimpel-orbits-text` | One size-prefixed OPM per row, plus the unchanged NCD |
| `catalog-composer / validate_epoch` | `recipe` control metadata, `seed` OPM, `reference` NCD+position-file bytes, one `ephemerides` OEM | Diagnostic report |
| `catalog-composer / fit_epoch_step` | Same inputs, with seven OEMs: nominal then perturbations of x,y,z,vx,vy,vz | Unvalidated candidate OPM and diagnostic report |

The reference NCD must specify `vimpel-ephemeris-text`, its exact byte length and
SHA-256, and the archive member filename containing native ID and epoch. A host
extracting the RAR must retain the parent archive CID/hash and member path in its
source provenance. This module does not decompress an archive or authenticate
provider downloads. The fetched orbit-table NCD already uses the supported name.

OPM positions are km; velocities km/s. Its object name is `vimpel:<numeric-native-id>`;
no COSPAR or NORAD identifier is inferred. Dates, negative age markers, unknown
uncertainty markers, effective area/mass and the original native-ID spelling
remain recoverable through the original NCD and bytes. Uncertainties are never
coerced to zero. Invalid dynamical elements fail the bounded batch atomically.
Limit: 8 MiB / 20,000 orbit rows.

Position-only provider data remains native data. It is **not** emitted as an OEM
with invented zero velocities: the canonical OEM requires six or nine components.
A validation OEM must instead contain propagated six-component Earth-centered
J2000/UTC states at 600-second intervals, starting at the seed epoch. Native ID,
epoch, initial state, frame, grid and content hash must all agree. At least nine
samples and two held-out samples are required. A prefix of the available arc is
allowed; the report records its exact span. An accepted four-hour prefix does
not validate the remaining week. Limits: 4 MiB native position input, 4,096 source
positions, 16 MiB per OEM and 128 MiB total invocation payload.

## Explicit policy

Example **tuning**, not a provider covariance or calibrated collision threshold:

```json
{
  "version": 1,
  "propagatorId": "com.orbpro.hpop",
  "propagatorArtifactSha256": "<64 lowercase hex characters>",
  "forceModel": {"centralBody": true, "j2": true, "j3": true, "j4": true,
                 "thirdBody": true, "drag": false, "srp": false},
  "frameTransformationRef": "<immutable frame-module/configuration reference>",
  "holdoutStride": 4,
  "positionToleranceKm": 1,
  "positionPerturbationKm": 0.01,
  "velocityPerturbationKmS": 0.00001,
  "positionWeightKm": 0.05,
  "positionRegularizationKm": 200,
  "velocityRegularizationKmS": 0.1
}
```

The caller must route propagation through the artifact/model it records; a
report preserves the supplied metadata, it does not independently attest host
execution. The verification driver records the actual artifact hashes.

## Fit and acceptance

Every fourth position (indices 3,7,11,...) is withheld in the example policy.
Those samples never enter the fitting equations. Both training and withheld
**maximum** position residuals must satisfy the configured tolerance for a
`validated` result. RMS values and counts are reported separately. `validated`
means consistency with this source product over this arc, not object identity,
independent absolute accuracy, or collision-probability certification.

For refinement, the host propagates the current seed and six seeds perturbed by
the configured amounts. The module checks each trajectory's initial state to
reject stale or reordered sensitivities. It requires six numerically independent
position-sensitivity columns, then reuses the existing estimation module's
regularized batch least-squares implementation for one update. The configured
position weights and regularization scales are tuning parameters. They are not
measurements of the provider's uncertainty, and the internal covariance is never
published. Corrections outside those trust-region scales are refused.

The result is always `candidate-needs-propagation`. It contains an OPM with the
fitted PV and cleared stale Keplerian fields. Preserve the original OPM/NCD,
propagate the candidate again, and rerun validation. Repeat within a bounded
iteration budget. Set `maximumHoldoutRmsKm` to the prior iteration's measured
held-out RMS; validation returns `rejected-holdout-regression` if it worsens
(by more than 1e-9 km numerical slack), even inside the absolute tolerance. Exhausting
the budget is failure, not permission to publish the last iterate. Model changes
require a new policy/provenance record and a fresh fit. No state is automatically
promoted into the authoritative catalog by either method.

## HPOP verification and limitations

The opt-in integration driver composes the actual reader, `foundation/frames`,
`foundation/time`, HPOP, and catalog WASM artifacts. J2000 is explicitly rotated
to GCRF and back. UTC sample times are explicitly converted to TDB for HPOP.
Physics and state fitting run in C++ WASM; the JS driver only routes requests,
serializes units/records, and computes test diagnostics.

The tested model uses Earth central gravity, J2–J4 and analytical Sun/Moon, with
RKF78. Drag and SRP are disabled: Vimpel's effective area/mass is not enough to
infer separate drag/SRP coefficients. This does **not** reproduce the provider's
degree-8/DE405/GOST model. The current HPOP GOST enum is a placeholder, not GOST.
Do not label this configuration as a matching provider force model.

All 13,808 rows of the downloaded table converted. Three four-hour arcs (one
near-circular and two eccentric, e≈0.893 and 0.841) each passed the example
1 km gate after one update. Held-out RMS improved from 6–11 km to 53–70 m;
maximum withheld residuals were 73–97 m. These are three examples, not a
catalog-wide accuracy claim. Input-derived aggregate results and exact artifact
hashes are in `verification-vimpel-epoch-fit-20260921.json`.

The driver also compares analytic velocity with generated-trajectory derivatives
at 1 s and 0.5 s. Smaller steps did not always improve the result: absolute
Julian-date precision and subtraction/integration roundoff affect this diagnostic.
No finite-difference velocity is used as the accepted epoch velocity, and no
convergence claim is made for that diagnostic.

## Reproduction

From the modules repository, install dependencies in `files/orbit-products`,
`analysis/catalog-composer`, `foundation/frames`, and `propagator/hpop`. Build the
two changed packages in that order. Existing frame/time/HPOP artifacts are inputs.

```sh
node --test files/orbit-products/tests/vimpel.test.mjs analysis/catalog-composer/tests/epoch-fit.test.mjs
node files/orbit-products/tests/vimpel-parity.mjs
SDN_RUN_CATALOG_PARITY=1 node --test analysis/catalog-composer/tests/parity.test.mjs
node analysis/catalog-composer/tests/vimpel-live.mjs ELEMENTS_FILE EPHEMERIS_RAR
```

The last command is offline verification. It does not fetch data, open credentials,
install modules, update the node's catalog, or publish state products.
