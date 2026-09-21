# OD covariance publication contract

The C++ OD fit and OCM builder must distinguish a missing estimate from zero
uncertainty. Residual RMS is a fit error summary; it is not an observational
covariance. The builder never substitutes an RMS-scaled diagonal matrix or a
zero state when an estimate is missing.

## Wire representation

The existing SDS OCM schema carries a size-prefixed `$OCM` FlatBuffer. No new
schema or ABI is introduced. A valid single epoch Cartesian state has six
values in `STATE_DATA`: x, y, z in km, followed by vx, vy, vz in km/s, in TEME.
`METADATA.START_TIME`, `STOP_TIME` and `EPOCH_TZERO` identify the fit epoch;
`TIME_SYSTEM` is UTC. User-defined parameters explicitly record frame, units,
covariance layout and interpretation.

`COVARIANCE_DATA` contains all 21 lower-triangular entries in row-major order:
(0,0), (1,0), (1,1), (2,0), …, (5,5). Entry (i,j) has the product of state units
i and j. Cross terms are preserved exactly. The covariance is at the same epoch
and in the same frame as the state; no frame rotation or propagation occurs here.

When state or epoch is unavailable, `STATE_DATA` is absent. When covariance is
unavailable, invalid, or the fit did not converge, `COVARIANCE_DATA` is absent
and `ORBIT_DETERMINATION.OD_COV_REDUCTION` is `UNAVAILABLE`. A real state can be
retained without covariance. Consumers must not interpret absence as zeros.

## Formal estimate and rejection criteria

For N position observations and p fitted parameters, the fitter forms the
central-difference residual Jacobian J and epoch-state Jacobian G:

    sigma² = rᵀr / (3N - p)
    P_parameters = sigma² (JᵀJ)⁻¹
    P_state = G P_parameters Gᵀ

This is an unweighted formal least-squares estimate. It assumes the residual
model is appropriate and does not account for correlated provider errors,
force-model bias, timing bias, or propagated process noise. It is **not** a
calibrated prediction covariance or evidence of collision-probability accuracy.
The published status is `FORMAL_UNWEIGHTED_NORMAL_EQUATIONS`.

The normal matrix must be finite and every singular value must exceed
`1e-12 * largest_singular_value * p`. This retains the existing inversion cutoff
but rejects a deficient estimate instead of assigning zero variance to truncated
modes. The criterion is parameter-scale dependent and deliberately conservative;
some short arcs and unobservable SGP4 parameters will produce no covariance.

The complete state covariance must be finite with positive diagonal entries.
Cholesky factorization of its dimensionless correlation matrix must have every
pivot greater than 1e-12. Singular, indefinite and numerically marginal matrices
are withheld. Positive diagonal entries alone are insufficient. Integer bit
inspection with a volatile observation keeps nonfinite rejection effective under
fast-math compilation; ordinary `isfinite` can be optimized away in that mode.

## Verification and release boundary

Run `npm run test:covariance-publication` in `analysis/od`. The native C++ test
compiles both normally and with `-ffast-math`, decodes the actual OCM output, and
checks a closed-form SPD matrix with nonzero position/velocity cross terms.
Its three independent 2x2 blocks have determinants 3, 32 and 135 in the stated
state units. Serialization has zero tolerance because it performs no numerical
transform. Tests also cover absent data, missing epoch, indefinite and singular
matrices, NaN, infinity, unconverged fits, and unobservable normal-matrix modes.

OD 0.1.2 emits OMM and OCM together for typed OEM input. Text input retains its
existing JSON result. OCM can report unavailable covariance; absence must not
be used as zero covariance when computing collision probability. Independently
retaining epoch state when covariance fails remains separate work. HPOP
uncertainty propagation and covariance calibration remain unverified.

## Rebuilding and runtime verification

Set `SDN_OD_EIGEN_DIR` to an Eigen include directory and run `npm run build:wasi`.
The multi-translation-unit build uses the SDK's public WASI toolchain resolver,
FlatBuffer runtime/schema headers, manifest encoder, artifact guard and compliance
validator. It preserves isolated SDS translation units and the tested PIV bridge;
it does not use the historical raw batch ABI in `build-isomorphic-threads.sh`.
The target is `wasm32-wasip1-threads`, with the `wasi-sequential` execution model.
Fast-math retains the fitter's established numerical configuration; covariance
publication tests explicitly cover that configuration.

The output is unsigned `dist/isomorphic/module.unsigned.wasm`. Sign that exact
hash through the authorized node publication API, verify the public signature,
and install the signed result as `dist/isomorphic/module.wasm`. Signing keys
never enter the build. `npm test` covers SDK loading and public reference fits;
`npm run test:release` compares exact output payloads for text/OEM/error inputs
across browser, native WasmEdge and Docker WasmEdge 0.16.4. The Docker test requires
`space-data-module-sdk/parity-wasmedge:0.16.4` (or `OD_PARITY_DOCKER_IMAGE`).
WasmEdge must enable its threads feature to load WASI shared memory, even though
the module itself spawns no threads. Browser delivery requires cross-origin
isolation for the same shared memory.
