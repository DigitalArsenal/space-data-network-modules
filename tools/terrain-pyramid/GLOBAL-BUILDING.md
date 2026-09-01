# Bounded, resumable global terrain builds

`run.mjs` remains the authoritative one-cell flow host. This companion
orchestrator is the only supported way to scale that host to a global run:

```sh
node tools/terrain-pyramid/global-build.mjs \
  --config <approved-global-run.json> --out <scratch>/global-z10 \
  --shards 24 --workers 6 --cache-max-bytes $((128 * 1024 * 1024 * 1024))
```

This is an off-fleet build command. It must run only after the global source
config has been approved. It does not publish an IPFS CID, tunnel to a host,
or deploy a flow.

## Boundaries and resume contract

- The shared source cache is capped (128 GiB by default). Capacity reservation,
  eviction and generation publication are serialized by an inter-process lock;
  each URL has a second producer lock, so competing 200/404 observations can
  only publish one immutable body/status generation. Each active cell holds
  leases for its planned granules; LRU eviction skips live leases, and a resume
  reclaims a lease only after its recorded PID is no longer alive (or a malformed
  owner has exceeded the bounded expiry).
- Network retries are deterministic exponential backoff: four retries after
  the first attempt, starting at 250 ms. HTTP 404 remains a source result and
  is not retried; 408, 425, 429 and 5xx responses are retried.
- Regions are cut into deterministic, non-overlapping longitude slices. A
  worker owns one shard output and a durable `global-build-state.json` records
  its config digest, attempts and output digest. A resumed command refuses a
  changed config or shard count and skips only shards whose clean report and
  stream digest still match. A `--max-cells` run report is explicitly
  `drained: false`, so it remains resumable work rather than being mistaken for
  a completed shard.
- Shard merging accepts a boundary duplicate only when the complete `$DTT`
  record bytes agree. It otherwise stops; a coordinate is never silently won
  by a worker. The merge report's sorted address/digest set is the
  order-independent parity identity used to compare a multi-worker rehearsal
  with the existing single-process lane.
- `verify.mjs` now reads `tiles.dttstream` record-by-record. It retains only
  its indexes and edge data, rather than attempting one >2 GiB Buffer.

## Rehearsal before any global cut

Run the same small, multi-longitude regional config twice: once through the
existing single `run.mjs` lane and once through `global-build.mjs`. Compare
the two merge reports' `recordSetDigest`, then run `verify.mjs` on each.
Exercise recovery without touching a source dataset by running the tooling
test suite; its injected transient failure proves retries and its persisted
state test proves completed work is skipped on resume. For an authorised small
rehearsal, `--fault-after-shards 1 --workers 1` stops immediately after the
first completed shard; rerun the exact command without that test flag and
confirm the state reports one retained completion rather than recutting it.

Do not treat a regional rehearsal as evidence that the global z<=10 data set
exists. The global cut and publication remain separate, explicitly authorised
tasks.

## Checked local rehearsal

Run this before an authorised source-backed global rehearsal:

```sh
node tools/terrain-pyramid/rehearse.mjs --out /tmp/terrain-global-rehearsal.json
```

It runs the shipped terrain-source artifact over two adjacent representative
regions using the same local DEM/WBM fixture, then compares a single-lane cut
with two concurrent cuts by complete `$DTT` address/byte digest. The JSON
report records both timings and is intentionally outside the repository: it is
performance evidence for the current box, not evidence that a global pyramid
exists. The checked representative result is
[`evidence/global-rehearsal.json`](./evidence/global-rehearsal.json); reproduce
it before relying on its timings.
