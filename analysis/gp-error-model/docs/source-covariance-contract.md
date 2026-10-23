# Source covariance contract

Implementation work in progress for `modules-source-covariance-gcrf-20261022`.

Placement: `analysis/gp-error-model`, alongside `attach_covariance`, which owns
the catalog paper section 2.2 rule chain. Reuse its SDS record readers and
`covreal` covariance rotation and bounded ephemeris interpolation. Astronomy
uses `foundation/frames`' ERFA chain. Propagation remains the caller's
composition with its own propagator through the published PRW interface.

The proposed `source_covariance` method consumes one source record ($OCM,
$OEM, or $CDM), a $PRW request carrying the clock epoch and the object's GCRF
state, and Earth orientation when needed. It returns a $PRW resident state
with a 6x6 row-major SI covariance and an $ERM attach report carrying rule
Operator and the covariance epoch. A time series is interpolated only within
its covariance span; a single covariance remains at its own epoch.

THEMIS/CONSULT — HAVE. SDS 1.259.0: OCM/main.fbs:763,800,812 gives covariance,
frame and epochs; OEM/main.fbs:146,193,214 gives covariance epochs and per-line
frame overrides; CDM/main.fbs:101,123,143 gives the RTN lower triangle, km
units and TCA. PRW/main.fbs:420,436 and ERM/main.fbs:1375,1388 carry the result
matrix, state/epoch and rule label. No local schema extension is needed.

Validation: `node analysis/gp-error-model/scripts/e2e-source-covariance.mjs`.
The same artifact must pass headless-browser/native-WasmEdge parity and the
node's AOT prewarm. Docker is waived by the owner's 2026-10-22 ruling.
