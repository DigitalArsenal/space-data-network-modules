# Bounded, resumable global terrain builds

The native coarse-ocean target is `regions/global-z8.json`: retain all
131,072 geographic z8 records, then reduce four actual sibling records to each
parent through z0 (43,690 parents, including both roots). Missing records are
errors, never water observations. The native planner accepts the explicit
`skipOceanTiles: false` option; its existing default remains true.

This is a build recipe, **not evidence of a completed global dataset**. Before
a global run, reproduce a bounded coastal cut with current native source,
V8/WasmEdge/container parity and native OrbPro decode/culling checks. Measure
actual source/cache, DTT and static-directory bytes and elapsed time. Admit the
job against the host's free-disk floor, including the cache, original leaves,
derived store and temporary sorts. The config's 32 GiB cache and provisional
4 GiB DTT / 48 GiB static ceilings are separate bounds. Historical Liguria
measurements explain the estimates; they do not establish that the new global
job fits. A host with 115 GiB free and a 100 GiB floor cannot admit this job.

The z8 ceiling is a coarse-data proof, not a drop-in replacement for a finer
land provider. Publication and console adoption also require a verified native
route that retains the existing close-ground detail. Completing water masks
does not authorize lowering the active terrain's maximum detail.

After that admission and matching native source/planner/compiled-flow builds:

```sh
node tools/terrain-pyramid/global-build.mjs \
  --config tools/terrain-pyramid/regions/global-z8.json --out <scratch>/z8-leaves \
  --shards 24 --workers 1 --cache-max-bytes 34359738368
node tools/terrain-pyramid/coarsen.mjs \
  --input <scratch>/z8-leaves --out <scratch>/z0-z8-derived
node tools/terrain-pyramid/verify.mjs --out <scratch>/z0-z8-derived
```

The first verifier receipt says `validated: true`, `publishable: false` and
`coarseCoverage.phase: "leaves"`. That allows a completed leaf cut to resume
without pretending it is ready to publish. The IPFS publisher requires the
final `publishable: true` receipt, complete native coarse coverage and zero
unmeasured ancestor placeholders or available-but-unstored addresses.

`coarsen.mjs` uses bounded address/offset/hash external sorts and at most one
four-record native invocation at a time. `reduce_parent` consumes a single
`children` port containing exactly four canonical size-prefixed `$DTT` records
and returns one on `records`. JavaScript neither decodes terrain for production
nor computes heights, masks, interpolation or accuracy. The native method
orders SW/SE/NW/NE, derives the parent address, and refuses incompatible
siblings. Its SOURCE_QUERY binds all four **unprefixed full-record** SHA-256
multihashes, method/version, mesh-bound method and water-coverage reduction.
This is area reduction of decoded water coverage, not averaging source WBM
category identifiers.

Original leaf bytes and source-post measurements remain unchanged. Native
parents report a conservative child/parent mesh-envelope difference and an
inherited source bound only when all children supply one. An observed ocean
record can have no DEM source-post bound; the resulting unknown source
accuracy remains unknown upstream. The verifier reports those parents
separately and never counts a mesh-only bound as a direct source-post test.

The reducer writes a new directory, retains original leaf-state/verification
receipts and public source metadata, and writes `coarsen-report.json` only
after all quartets and files succeed. It refuses an existing output directory;
a failed attempt is retained without a successful receipt, not silently
resumed or published. The original terminal leaf directory is never modified.

### Bounded coastal observation, 2026-09-09

The native planner cut the four z8 children of Genoa-area parent z7/134/95
from 18 public Copernicus DEM/WBM responses, all HTTP 200, totaling
280,468,510 unique source bytes. Direct public SDK invocations used source
WASM `37e99d2682e03d7c4eb4b85caabb79d360c431b368a1030e578daf691ceebdae`.
The four DTT records totaled 15,160 bytes; their native parent totaled
10,676 bytes. This was a direct-module rehearsal, not compiled-flow parity
or a global throughput sample.

Native `route`/`respond` with identity encoding materialized just these five
stored tiles: 429,211 logical bytes and 446,464 allocated file bytes from
the 25,836-byte combined DTT stream (16.61 times its size). This excludes
`layer.json`, catalog records, UnixFS and directory overhead. The regional
verifier also identified eight unstored ancestors; this measurement is not
a complete static directory or publication acceptance. Do not apply this
five-tile ratio as a global capacity estimate.

The production verifier accepted the four recorded source-post bounds and
the separate inherited parent bound. Independent public OrbPro interpolation
checked 1,156 parent/child samples: maximum difference 278.285 m against the
native 1,024.421 m mesh-envelope bound. Those values describe coarse z8/z7
geometry and do not establish close-ground terrain quality.

## Existing deeper regional/global cut

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
not prefill `retrieved_at`: each cell derives its DTT lineage value from the
latest immutable `observed_at` among the source objects it actually prefetched;
build start remains separately named metadata. It stores source-backed z8--z10 records; z0--z7 are
declared global ancestors synthesized by the serving flow. Those placeholders
do not solve global coarse ocean coverage; use the native reduction target
above for that requirement. It does not publish
an IPFS CID, tunnel to a host, or deploy a flow.

Template shape is not enough: every requested URL is also checked as a real
Copernicus southwest tile (`S90..N89`, `W180..E179`, with zero canonically
`N00`/`E000`), and repeated directory/filename coordinates must agree. An
out-of-world planner bug cannot become an authoritative 404 or ocean fact.

## Boundaries and resume contract

- The historical z10 source cache is capped at 96 GiB (the new z8 target uses
  32 GiB), while every individual source
  response is capped at the approved 128 MiB before it is buffered. The runner
  rejects an over-cap `Content-Length` and streams body chunks with abort-on-cap
  while the request observation timer remains live. Capacity reservation,
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
- Each source request contributes a bounded JSONL row containing its public URL (or
  stable SHA-256 key), final status, actual body length and digest,
  ETag/Last-Modified when supplied, cached-vs-network status, `requested_at`,
  and exact response `observed_at`. Cache receipts sit beside the immutable
  cache generation. The receipt is written inside the producer lock after the
  full response body is read but before `current.json` publishes; a cache hit
  without one fails rather than inheriting
  unprovenanced bytes. A `source-epoch.json` receipt refuses policy/epoch
  mixing and a legacy cache with unreceipted entries. The row is staged in the
  same per-cell journal as tiles/index/ocean output and is fsynced before that
  cell's terminal `$IRM` mark, so a resumed mark can never outrun the exact
  requests that justified it. Receipt creation and the EEXIST path both use a
  stable regular `O_NOFOLLOW` descriptor; the descriptor and receipt parents
  are durable before a cache generation can become current.
- Regions are cut into deterministic, non-overlapping longitude slices. A
  worker owns one shard output and a durable `global-build-state.json` records
  its config digest, attempts and output digest. A resumed command refuses a
  changed config or shard count and skips only shards whose clean report and
  stream digest still match. Before that state checkpoint, the coordinator
  copies report, stream, source-log, and ocean inputs through bounded,
  no-follow descriptors into coordinator-owned immutable snapshots, records
  their byte counts/digests, rechecks every one on every resume, and refuses a
  cumulative snapshot set over the approved static-directory ceiling. A
  `--max-cells` run report is explicitly
  `drained: false`, so it remains resumable work rather than being mistaken for
  a completed shard.
- Shard merging rejects every boundary duplicate, including byte-identical
  `$DTT` records: a de-duplicated store would otherwise hide the overlap from
  `verify.mjs`. Byte disagreement also stops immediately; a coordinate is
  never silently won by a worker. Record facts are externally sorted in bounded runs, and the
  report digest is accumulated in that canonical order rather than from an
  address map. Ocean skips follow the same path: `ocean-skipped.lines` is the
  raw ASCII one-`level/x/y`-per-line (`terrain-ocean-skips-lines-v1`) sorted
  unique address stream in canonical numeric `level,y,x` order (not raw
  lexical address order) and `ocean-skipped.json` is its small format,
  count, and digest receipt. Repeated lines recovered within one shard are
  collapsed and counted; the same address from distinct shards fails (the
  merger still streams legacy JSON arrays on input). The
  merge report's sorted address/digest set is the order-independent
  parity identity used to compare a multi-worker rehearsal with the existing
  single-process lane.
- After every shard is terminal, the coordinator externally sorts and
  deduplicates its immutable snapshots into staged `source-manifest.ndjson`.
  Rows are canonical JSONL ordered by stable source key; conflicting
  observations for one URL fail the run. The staged manifest is fsynced and
  added to the same four-artifact transaction as merged tiles and ocean
  receipts before any destination rename. The durable terminal state then
  records its SHA-256 digest, source-policy digest, dataset epoch, and
  canonical config digest. `verify.mjs` runs only against those exact terminal
  state bytes and must emit its v2 input receipt before
  `global-merge-report.json` is exposed or transaction backups are finalized.
  A crash in either interval preserves the transaction and resumes verification
  rather than re-merging. An interrupted shard or a `--skip-verify`
  source-policy invocation cannot create a terminal manifest.
- Each cell stages records, index rows, ocean lines, and its durable `$IRM`
  mark under an attempt journal. The journal records pre/post lengths and
  digest-chain receipts; startup completes an exact partial append or refuses
  an unexpected length, and commits the mark last. Cell detail is append-only
  bounded JSONL with a fixed report sample, while tile-byte percentiles use an
  exact fixed histogram under the DTT size cap.
- Global output includes `approved-run-config.json`; its digest is carried by
  every shard report, the manifest receipt, and the terminal merge report.
  Accuracy tools require that approved config and manifest lineage for global
  output. Legacy regional stores require their explicit compatibility flags.
- `regions/global-z10.json` also carries an immutable `publication_policy`.
  Its 12 GiB `max_verified_store_bytes` is a 41% margin over the 8.51 GiB
  measured compressed-store upper estimate. Its **separate** 128 GiB
  `max_static_directory_bytes` follows checked Liguria evidence: 450,180,397
  identity-directory bytes / 35,149,748 DTT-store bytes = 12.8075×; that
  ratio applied to the 8.51 GiB global upper estimate is 108.99 GiB, leaving
  17.4% within the reviewed binary ceiling. Neither number is a host-capacity
  placeholder. The exact
  raw policy and policy digest are carried in every shard `run-report.json`;
  the approved config is its exact immutable lineage. Global state and its
  merge receipt carry the verifier's normalized
  `terrain-publication-policy-v1` wrapper (including the same config digest,
  byte ceilings, and grid), so verifier and coordinator consume one unambiguous
  shape; a shard that reports any other raw policy is refused.
  The policy fixes `terrain_synth_grid_size: 2`: the shipped source module
  accepts `[2,255]`, and a flat land/water/ancestor tile needs only the four
  coplanar vertices of a 2x2 lattice. The publisher passes that exact key to
  its module harness, so the mount and IPFS generation remain one function.
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
