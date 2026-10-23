# Source covariance contract

Implemented in gp-error-model 0.9.0 for `modules-source-covariance-gcrf-20261022`.

Placement: `analysis/gp-error-model`, alongside `attach_covariance`, which owns
the catalog paper section 2.2 rule chain. Reuse its SDS record readers and
`stm` matrix congruence and `pair_statistics`' bounded linear covariance interpolation. Astronomy
uses `foundation/frames`' ERFA chain. Propagation remains the caller's
composition with its own propagator through the published PRW interface.

The `source_covariance` method consumes one source record ($OCM,
$OEM, or $CDM), a $PRW request carrying the clock epoch and the object's GCRF
state, and Earth orientation when needed. It returns a $PRW resident state
with a 6x6 row-major SI covariance and an $ERM attach report carrying rule
Operator and the covariance epoch. A time series is interpolated only within
its covariance span; a single covariance remains at its own epoch.

Ports are `ocm`/`oem`/`cdm` (exactly one record), `request` ($PRW), and
outputs `state` ($PRW) and `report` ($ERM). The request supplies
`RESIDENT_STATE` and `RESIDENT_REQUEST.TARGET_EPOCH`, both UTC ISO 8601.
The resident state is Cartesian GCRF/ICRF, Earth-centered, in SI, at the
source epoch for a singleton or the clock epoch for a time series.
Use the object's catalog number or object ID to select the record's object.

Frames: GCRF/ICRF, RTN/RSW/RIC/UVW/RSW_INERTIAL, TNW/TNW_INERTIAL,
EME2000/J2000, TEME, ITRF/ECEF (including named ITRF realizations).
Terrestrial axes require covering `EARTH_ORIENTATION.ROWS`; there is no
network fetch or zero-EOP fallback. OCM supports Cartesian PV/PVA with
CARTPV lower-triangle 6x6 covariance; CDM uses its first 21 RTN entries.
Unsupported frame/time/representation and out-of-span requests return errors.
Rotating orbital velocity coordinates require a separate angular-rate contract
and are refused. No process noise is invented. Hand the returned resident state
to the chosen propagator to carry a singleton to the clock.

THEMIS/CONSULT — HAVE. SDS 1.259.0: OCM/main.fbs:763,800,812 gives covariance,
frame and epochs; OEM/main.fbs:146,193,214 gives covariance epochs and per-line
frame overrides; CDM/main.fbs:101,123,143 gives the RTN lower triangle, km
units and TCA. PRW/main.fbs:420,436 and ERM/main.fbs:1375,1388 carry the result
matrix, state/epoch and rule label. No local schema extension is needed.

Validation: `node analysis/gp-error-model/scripts/e2e-source-covariance.mjs`.
The same artifact must pass headless-browser/native-WasmEdge parity and the
node's AOT prewarm. Docker is waived by the owner's 2026-10-22 ruling.
Set `SDN_PREWARM_BINARY` to the local node binary linked to WasmEdge 0.16.4.
The E2E uses an independent WASM matrix/ERFA oracle (SI, UTC 2020-01-01,
relative tolerance 1e-12), distinct interpolation endpoints, and the public
FFM resident gravity-only interface over 86400 seconds. Its synthetic seed
has radius 8000 km, safely above the reentry surface throughout that arc.
