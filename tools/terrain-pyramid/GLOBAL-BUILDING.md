# Bounded, resumable global terrain builds

`run.mjs` remains the authoritative one-cell flow host. This companion
orchestrator is the only supported way to scale that host to a global run:

```sh
node tools/terrain-pyramid/global-build.mjs \
  --config tools/terrain-pyramid/regions/global-z10.json --out <scratch>/global-z10 \
  --shards 24 --workers 6 --cache-max-bytes $((96 * 1024 * 1024 * 1024))
```

This is an off-fleet build command. The checked approved source policy is
`regions/global-z10.json`: it records the public GLO-30 endpoint and immutable
object-naming templates, dataset epoch, fixed timeout/retry rules, a <=96 GiB
cache ceiling, and the distinction between an immutable 404 no-coverage
observation, all-water synthesis, and a failing non-water/no-data gap. It does
not prefill `retrieved_at`: the coordinator supplies one real run-start receipt
to satisfy tile lineage, while every actual HTTP response carries its own
`observed_at` source-manifest observation. It stores source-backed z8--z10 records; z0--z7 are
declared global ancestors synthesized by the serving flow. It does not publish
an IPFS CID, tunnel to a host, or deploy a flow.

## Boundaries and resume contract

- The shared source cache is capped at 96 GiB. Capacity reservation,
  eviction and generation publication are serialized by an inter-process lock;
  each URL has a second producer lock, so competing 200/404 observations can
  only publish one immutable body/status generation. Each active cell holds
  leases for its planned granules; LRU eviction skips live leases. Owners carry
  both PID and a process-start identity where the OS exposes one, so a live
  reused PID is reclaimed rather than pinning capacity. On platforms without
  that identity, the actual lock/lease holder refreshes a 20-second ownership
  heartbeat; a live identity-less owner is protected past the ordinary cache
  TTL and is reclaimed only after a separate five-minute no-heartbeat crash
  bound. Pulses are token-named, non-creating sidecars; timer cleanup and
  post-write token checks prevent an old holder from recreating or overwriting
  a successor. Malformed ownership gets only the bounded expiry. Interrupted publication
  directories and corrupt generation pointers are reclaimed under that same
  global lock before usage/capacity accounting.
- Network retries are deterministic exponential backoff: four retries after
  the first attempt, starting at 250 ms, with a 120-second request deadline
  and an explicitly capped eight retained response observations.
  Redirects are refused: the configured immutable object URL is what is
  observed. HTTP 404 remains a source result and is not retried; 408, 425, 429
  and 5xx responses are retried. CLI retry/cache overrides must exactly match
  the checked source policy.
- Each source request appends a bounded JSONL row containing its public URL (or
  stable SHA-256 key), final status, actual body length and digest,
  ETag/Last-Modified when supplied, cached-vs-network status, `requested_at`,
  and exact response `observed_at`. Cache receipts sit beside the immutable
  cache generation; a cache hit without one fails rather than inheriting
  unprovenanced bytes. A `source-epoch.json` receipt refuses policy/epoch
  mixing and a legacy cache with unreceipted entries.
- Regions are cut into deterministic, non-overlapping longitude slices. A
  worker owns one shard output and a durable `global-build-state.json` records
  its config digest, attempts and output digest. A resumed command refuses a
  changed config or shard count and skips only shards whose clean report and
  stream digest still match. A `--max-cells` run report is explicitly
  `drained: false`, so it remains resumable work rather than being mistaken for
  a completed shard.
- Shard merging rejects every boundary duplicate, including byte-identical
  `$DTT` records: a de-duplicated store would otherwise hide the overlap from
  `verify.mjs`. Byte disagreement also stops immediately; a coordinate is
  never silently won by a worker. Record facts are externally sorted in bounded runs, and the
  report digest is accumulated in that canonical order rather than from an
  address map. Ocean skips follow the same path: `ocean-skipped.lines` is the
  raw ASCII one-`level/x/y`-per-line (`terrain-ocean-skips-lines-v1`) sorted
  unique address stream and `ocean-skipped.json` is its small format,
  count, and digest receipt. Duplicate ocean addresses also fail instead of
  being collapsed (the merger still streams legacy JSON arrays on input). The
  merge report's sorted address/digest set is the order-independent
  parity identity used to compare a multi-worker rehearsal with the existing
  single-process lane.
- Only after every shard is terminal and `verify.mjs` passes does the
  coordinator externally sort and deduplicate the shard logs into immutable
  `source-manifest.ndjson`. Rows are canonical JSONL ordered by stable source
  key; conflicting observations for one URL fail the run. Its SHA-256 digest,
  source-policy digest, dataset epoch, and canonical complete-config digest are
  bound into `global-merge-report.json`. An interrupted shard or a
  `--skip-verify` source-policy invocation cannot create that manifest.
- `measure-accuracy.mjs` and `cross-check-accuracy.mjs` stream
  `tiles.dttstream`; accuracy retains at most 32 high-relief entries plus one
  flat control per level, uses a bounded heap instead of sorting each streamed
  record, consumes each bounded DTT reference frame one child at a time, and
  reads the selected immutable `granule-cache/entries/<key>/current.json`
  generation.

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

It starts a local-only deterministic DEM/WBM fixture and drives the existing
`run.mjs` single lane, then `global-build.mjs --shards 2 --workers 2` and its
real OS child workers/merge. It compares the non-empty complete `$DTT`
address/byte digest. The JSON report records both timings and is intentionally
outside the repository: it is performance evidence for the current box, not
evidence that a global pyramid exists. The checked representative result is
[`evidence/global-rehearsal.json`](./evidence/global-rehearsal.json); reproduce
it before relying on its timings.
