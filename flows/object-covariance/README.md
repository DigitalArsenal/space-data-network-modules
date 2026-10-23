# Incremental object covariance

Task: `sdn-object-covariance-reactor-20261022`.

The cron flow reads the newest OMM and covariance epoch per NORAD object from
the node's storage query capability. Only an object with a newer OMM proceeds:
read its causal history, invoke `gp-error-model.object_covariance` at age zero,
then ingest its covariance-bearing OCM. A successful OCM is the durable cursor;
no host application logic or separate watermark is needed. A failed calculation
or ingest remains eligible on the next tick. An object with no new OMM produces
no record.

The output lane is `OCM.fbs / object-covariance / celestrak-gp-object-covariance`. Each record has
NORAD `METADATA.OBJECT_DESIGNATOR`, UTC `METADATA.START_TIME` equal to the new
OMM epoch, one GCRF state and covariance row, `COV_REALISM`, and `PROVENANCE`.
The matrix uses SDS units (km and km/s); comparison with the method's ERM SI
matrix happens only in the E2E. Keep the latest record per object independently
of the cadence of other objects; a tick is not a full-catalog snapshot.

Contract prerequisite: SDS 1.259.0 has the OCM carriage fields but lacks a CVR
rule for empirical history shrinkage. Its enum value 2 means ScaledFit, while
gp-error-model 0.8.1 currently uses 2 for empirical-history-shrunk. This is an
upstream SDS escalation, never a substitute label. The gp-error-model write
scope remains with `modules-source-covariance-gcrf-20261022` until it is done.

Acceptance (one local-node E2E): a scratch node built from SDN origin/main
receives an OMM for test object A; its new OCM has that epoch and the same
matrix as offline WASM `object_covariance` on the same history. Object B has
no new OMM and receives no new OCM. Prewarm the exact signed flow with the
node's WasmEdge 0.16.4 before running it. Headless browser/native parity applies;
Docker is waived by the owner (2026-10-22).

Initial artifact check: gp-error-model 0.8.1 portable SHA-256
`f3d06fd4840686a893753fa8fdd19d30b39caa745d23cc2dd867d462886f2778`
successfully AOT-compiled with native `wasmedgec` 0.16.4. Final node
`prewarm-aot` acceptance remains required for the completed flow.

Controller build and node prewarm-aot passed on the exact portable artifact
`7fcff0ffff716efa7dac96b77f5c7626b4a3a58a10fd21497006715fd1990ea2`.
The declared E2E currently stops at its prerequisite check: object_covariance
has no OCM port. No end-to-end or deployment success is claimed.
