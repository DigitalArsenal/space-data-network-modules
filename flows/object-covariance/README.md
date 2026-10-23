# Incremental object covariance

Task: `sdn-object-covariance-reactor-20261022`.

A cron flow that keeps one covariance record per object per OMM: when a new
OMM arrives on the node's CelesTrak GP lane, the object's covariance is derived
from its own history by `gp-error-model` `object_covariance` and stored as an
SDS `$OCM` on its own lane. Orchestration only (`src/control.cpp`, WASM); the
numerics are the module's, the query and ingest are the node's generic hooks
(`hostcap/flatsql-query`, `hostcap/storage-ingest`). No host application code.

```
tick -> control -> query -> control -> query -> control -> covariance -> control -> ingest -> control
        (record      (newest OMM    (histories of   (object_covariance   (the batch's
         keys)        per object)    one batch)      per object)          records)
```

## One run

1. The position: every record carries `object-covariance|<object key>|<first
   epoch>|<method>|omm-rowid:<n>` as its message id, `n` the row id of the last
   OMM of the batch it was made in. The store exposes a record's body, not its
   header's fields, so the newest record's bytes are searched for that marker and
   only the id leaves the store. No record, or an `n` above the OMM lane's newest
   row id, is position 0. Nothing else is kept.
2. The stale objects: those whose newest OMM (by epoch) has a row id above the
   position, in arrival order, one `ROW_NUMBER()` pass over `OMM@celestrak-gp`.
   The first run is position 0, so the same query serves the first pass over the
   catalog and every later increment.
3. In batches of 256, at most 4 batches per run (the host's drain bound of 1000
   iterations ends a run after about three, some 750 objects; a batch not yet
   ingested is redone by the next run):
   - one pass over the OMM lane returns the histories of the whole batch (the
     lane is not indexed by object, so a pass per object would cost a pass over
     the lane each);
   - per object, `object_covariance` runs on that object's history up to its new
     OMM, at ages 0, 0.5, 1, 2, 3, 5 and 7 days;
   - the batch's records are ingested together, or none are; every one carries
     the batch's last row id, so the newest record is the new position.
4. A run with nothing stale ends with a `FlowNotice` Unchanged: the node counts
   it a success without a batch, not a failed retrieval (a failed retrieval
   doubles the flow's window up to 24 hours). A refusal ends the run with a
   `FlowNotice` Info that carries its reason, and status 500.

An object without a new OMM is never touched. A run that stops anywhere (a
refusal, the budget, a restart) resumes from what the lane holds, and a batch
stored twice holds one copy (duplicates are dropped; the records are a pure
function of the history). Module SQL sees the engine's resident window of a lane
(`storage.engine_hot_window` for `$OMM`, 400K records by default;
`engine_generic_hot_window` for `$OCM`): the histories the covariance is derived
from are the OMMs in that window, so a node that holds fewer than 30 days of the
catalog derives from fewer sets and labels more rows with the population rule.

## The record

One `$OCM` per object and OMM epoch (lane `OCM.fbs / object-covariance /
celestrak-gp-object-covariance`, relation `OCM@celestrak-gp-object-covariance`):
`METADATA.OBJECT_DESIGNATOR` the NORAD ID, `START_TIME` and `STATE_EPOCHS[0]` the
new OMM's epoch, one row per age (GCRF state in km and km/s, the covariance's
21-value lower triangle in km², km²/s, km²/s² in GCRF, one CVR in `COV_REALISM`),
and `PROVENANCE` naming the CelesTrak GP element sets. A row's CVR is
EmpiricalHistoryShrunk (SDS 1.261.0 rule 5) with `HISTORY_SAMPLES`,
`HISTORY_SETS`, `HISTORY_WINDOW` and `SHRINKAGE_WEIGHT` when the object's history
supports the age, else the population model's SourceModel/PooledModel rule. An
age the model cannot cover (a regime with no cells, or beyond its bins) has its
row with NaN covariance and a rule-0 CVR whose `EVIDENCE` says why, so the record
is still the cursor. The labels come from the module; the controller moves bytes.
`analysis/gp-error-model/README.md` has the full contract.

Ages 0 usually label as the population rule: the empirical history has
residual pairs only from the spacing of the object's own element sets (hours),
so the youngest age bin rarely holds enough distinct older sets.

## Acceptance

`tests/local-node.e2e.mjs` (declared `end_to_end`): an isolated node built from
SDN origin/main runs the exact signed GP ingest and covariance flows after the
node's own `prewarm-aot` (WasmEdge 0.16.4), over synthetic GP rows for two
objects. After the first pass each object has one record. A new OMM is served
for object A only: A gets a new record whose first epoch is that OMM's epoch and
which equals, byte for byte, the record `object_covariance` gives offline (SDK
browser host) from the same history; B, with no new OMM, gets none; the covariance
matrix of every row equals the module's `covariance` output in SDS units. Browser
and native parity of the module's covariance and report ports runs on the same
inputs (headless Chromium shell and native WasmEdge). Docker is waived by owner
ruling (2026-10-22); it is never started.

Build: `npm ci`, then `node build.mjs` (compiles the controller and the two hooks
with the SDK's wasi toolchain, links them with `analysis/gp-error-model` into
`dist/runtime`). Run the E2E with `SDN_NODE_BINARY` the node binary built from SDN
origin/main.
