# Getting an off-fleet pyramid onto host-01

The builder writes a store directory; it does not talk to the fleet. This is
how those bytes become tiles host-01 serves, and why the path is the one it is.

## What the builder produces

    <out>/tiles.dttstream     size-prefixed $DTT records: [u32 LE length][record]
    <out>/tiles.index.jsonl   one line per record (address, height range, mask
                              kind, payload bytes) — a manifest for review, NOT
                              the authority
    <out>/resume-mark.json    the durable mark: the next CELL index of the walk
    <out>/granules/           the source granule cache (never published)
    <out>/run-report.json     the run's own numbers

`tiles.dttstream` is the artifact. It is exactly the framing
`hostcap/storage-ingest` consumes and exactly what the flow emitted — the
builder appends the flow's record stream verbatim and never re-encodes it.

## Why the build is off-fleet

Owner law: release artifacts are built LOCALLY under Docker linux/amd64 and
pushed, never built on hosts. A terrain pyramid is a release artifact by every
property that matters — it is large, it is cut once per dataset edition, and it
is byte-identical for every consumer. Building it on host-01 would also put a
multi-hour CPU-and-network job on the box that has to answer tile requests
while it runs, and workload placement on a named box is the owner's decision,
not a builder's convenience.

So: the build machine CUTS the pyramid, and host-01 SERVES it. The build
machine is deliberately not a node — no identity, no peering, no service
lifetime. It runs four host operations and writes a directory.

## The publication path

The $DTT records ride the existing dataset-publication lane, the same one the
cellular density-tile snapshot uses:

1. **Publish the record stream by CID.** The stream is content-addressed and
   added to the dataset lane; the CID is the artifact's identity, so what
   host-01 ingests can be verified rather than trusted.
2. **host-01 ingests it into its record store** through
   `hostcap/storage-ingest`, the same node the ingest flow uses, so the records
   land under the same dataset/epoch/batch attribution they were cut with.
3. **The serving flow's config is updated** with the availability index the run
   produced (`terrain_available`) and `terrain_maxzoom`, because layer.json's
   availability is the ORCHESTRATOR's knowledge and is configured, not
   aggregated per request.

Steps 1 and 2 are the ship lane's to execute (Hephaestus) against the live
host; this repo's job ends at the artifact. `deployment/topology.json` carries
the host-side recipe and its ledger.

## Verifying a run before publishing anything

    node tools/terrain-pyramid/verify.mjs --out <out>

It re-reads the record stream independently of the encoder and states: tile
count, store bytes, the gzipped-size distribution against the serving bounds,
the uniform-mask ratio, that no ocean tile was stored, that every address is
unique, and the availability index the tileset should declare.
