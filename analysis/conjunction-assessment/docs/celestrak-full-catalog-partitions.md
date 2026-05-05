# CelesTrak Full-Catalog Partition Runs

The `run-sdn-omm-partitioned-screen-catalog.mjs` runner is the supported path
for screening `space-data-network-02` / `celestrak.eth` OMM full-catalog exports
without one monolithic `screen_catalog` invocation.

## Input

Use an SDN data API OMM stream framed as `uint32be` length-prefixed SDS `OMM`
records:

```bash
node scripts/run-sdn-omm-partitioned-screen-catalog.mjs \
  --catalog /path/to/celestrak-full-catalog.OMM.uint32be.bin \
  --provider-id celestrak.eth \
  --source-id celestrak-full-catalog \
  --partition-size 100 \
  --checkpoint-dir /path/to/ca-celestrak-checkpoints \
  --resume \
  --max-partitions 25 \
  --output /path/to/ca-celestrak-summary.json
```

`--max-partitions` bounds each scheduled run. Re-run the same command with
`--resume` until the summary reports `"complete": true` and
`aggregate.failedPartitions` is `0`.

## Catalog Windows

For launch verification against a production-scale export, the runner can slice
deterministic frame windows from one downloaded full-catalog stream before
screening:

```bash
node scripts/run-sdn-omm-partitioned-screen-catalog.mjs \
  --catalog /path/to/celestrak-full-catalog.OMM.uint32be.bin \
  --catalog-start-frame 50000 \
  --catalog-frame-limit 1000 \
  --partition-size 50 \
  --checkpoint-dir /path/to/ca-celestrak-window-50000 \
  --output /path/to/ca-celestrak-window-50000-summary.json
```

The summary records both the source catalog size and the screened window:
`sourceObjectCount`, `sourceCatalogBytes`, `catalogStartFrame`,
`catalogEndFrame`, `objectCount`, and `catalogBytes`. Windowed runs are exact
inside the selected frame range; they are not a substitute for the complete
all-catalog pair sweep.

## Distributed Shards

For private-node or worker-pool execution, split the ordered partition plan by
shard:

```bash
node scripts/run-sdn-omm-partitioned-screen-catalog.mjs \
  --catalog /path/to/celestrak-full-catalog.OMM.uint32be.bin \
  --checkpoint-dir /shared/ca-celestrak-checkpoints \
  --resume \
  --partition-shard-count 8 \
  --partition-shard-index 0 \
  --max-partitions 10 \
  --output /shared/ca-celestrak-shard-0.json
```

Run shard indexes `0..7` with the same catalog and checkpoint directory. Each
successful partition writes an atomic checkpoint named
`partition-<index>-<start>-<end>.json`; resumed runs skip successful checkpoint
files and retry failed or missing partitions.

## Exact Block-Pair Mode

For production-scale exact coverage, prefer catalog block pairs over the legacy
ordered-primary partition mode:

```bash
node scripts/run-sdn-omm-partitioned-screen-catalog.mjs \
  --catalog /path/to/celestrak-full-catalog.OMM.uint32be.bin \
  --catalog-block-size 1000 \
  --checkpoint-dir /shared/ca-celestrak-block-pairs \
  --resume \
  --partition-shard-count 16 \
  --partition-shard-index 0 \
  --max-partitions 4 \
  --output /shared/ca-celestrak-block-pairs-shard-0.json
```

`--catalog-block-size` changes the schedule to the upper-triangular block-pair
grid. Diagonal partitions screen one block internally. Off-diagonal partitions
screen primary block `A` against secondary block `B`. Each invocation slices the
input stream down to only the one or two blocks needed for that partition and
sets explicit primary and secondary ordered ranges in the request.

For a 100,000-object catalog and `--catalog-block-size 1000`, the exact plan has
5,050 block-pair partitions. Run shard indexes `0..15` with a shared checkpoint
directory and repeat with `--resume` until all shards report no deferred ranges.
This is the current supported exact full-catalog execution path.

To generate resumable worker commands without loading WASM, use
`--write-shard-script`:

```bash
node scripts/run-sdn-omm-partitioned-screen-catalog.mjs \
  --catalog /path/to/celestrak-full-catalog.OMM.uint32be.bin \
  --catalog-block-size 1000 \
  --checkpoint-dir /shared/ca-celestrak-block-pairs \
  --resume \
  --partition-shard-count 16 \
  --max-partitions 4 \
  --shard-output-dir /shared/ca-celestrak-block-pair-summaries \
  --write-shard-script /shared/ca-celestrak-block-pair-run.sh
```

The command prints a plan summary with total, completed, and pending partitions
per shard, then writes one command per shard to the script. Re-run the generated
script as workers finish; successful partition checkpoints are skipped and
failed or missing partitions remain eligible for retry.

## Evidence

The summary JSON records:

- catalog path, byte length, object count, partition window, shard settings, and
  completion state;
- partition mode, including `catalog-block-pair` and the configured
  `catalogBlockSize` when exact block-pair scheduling is enabled;
- every completed partition with status, object count, conjunction count, and
  screening statistics;
- aggregate failed/deferred counts and screening statistics;
- deterministic provenance hashes over canonical query, config, and result
  objects;
- optional Ed25519 result signature when `--signing-private-key` or
  `CA_RESULT_ED25519_PRIVATE_KEY` is supplied;
- signed CDM artifact metadata for actual `emit_cdm` outputs via
  `signCdmOutput(...)`, which signs the emitted `$CDM` byte hash and publication
  metadata.

The partitioned full-catalog runner itself remains an aggregate `screen_catalog`
runner, not a per-event CDM emitter. Its provenance object keeps
`cdmOutputMetadata.available` false unless a future per-event partition mode
emits concrete `$CDM` bytes that can be signed with the package helper.
