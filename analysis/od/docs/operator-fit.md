# Operator-seeded FFM fit

Implementation task: modules-od-ffm-operator-fit-20261023.

The operator fit estimates the six epoch-state components and effective
ballistic coefficient, B_eff = (1-kappa) B. Kappa is identifiable only with an
explicit B prior. SRP stays fixed. MEME states are EME2000; UVW describes their
covariance, not their state frame. Fits must stop before the blended forecast's
48-hour boundary and at detected discrete maneuvers. Forecast residuals are fit
quality, not prediction accuracy; independent scores use fresh file starts.

Reuse the existing MEME/OEM parsers, SGP4 element fitter and FFM library dynamics
(the variational path shared with ResidentDynamics::covariance). Raw ephemerides
remain in memory. The task's E2E is scripts/e2e-operator-fit.mjs; browser/native
WasmEdge parity and the node's exact-artifact AOT compilation are required.
Docker is waived by the owner's 2026-10-22 ruling.

Status: WIP library, typed fit_ffm entry and records implemented. Compilation and E2E measurements pending; no acceptance claim yet.
