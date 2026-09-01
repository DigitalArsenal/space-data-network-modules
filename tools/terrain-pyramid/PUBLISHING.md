# Getting an off-fleet pyramid onto host-01

The builder writes a store directory; it does not talk to the fleet. This is
how those bytes become tiles host-01 serves, and why the path is the one it is.

> **SUPERSEDED IN PART, owner 2026-08-27: terrain files are requested over
> IPFS.** The pyramid is DELIVERED as a content-addressed IPFS directory —
> `layer.json` plus every `{z}/{x}/{y}.terrain` — added and pinned through the
> node's IPFS API, and clients fetch from `<node>/ipfs/<cid>/`. That path, what
> the gateway measurably does with it, and the $DTT catalogue record naming the
> CID are in **[IPFS-DELIVERY.md](IPFS-DELIVERY.md)**; run
> `tools/terrain-pyramid/ipfs-publish.mjs` after `verify.mjs`.
>
> Everything below still holds for the RECORD lane, which has not gone away:
> the records remain the artifact `verify.mjs` judges and the source the IPFS
> directory is materialized from, host-01 still ingests them, and the mount
> still answers `layer.json` and tiles as the same-origin fallback and the
> local-development path. What changed is which of the two a browser fetches.

## What the builder produces

    <out>/tiles.dttstream     size-prefixed $DTT records: [u32 LE length][record]
    <out>/tiles.index.jsonl   one line per record (address, height range, mask
                              kind, payload bytes) — a manifest for review, NOT
                              the authority
    <out>/irm.records         THE DURABLE RESUME MARK: $IRM records, size-prefixed,
                              written by the flow through hostcap/storage-write and
                              read back by mark_query through the code-named view
    <out>/resume-mark.json    the same mark as JSON, for an operator to read. It is
                              NOT the durable one and nothing resumes from it
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
cellular density-tile snapshot uses. (Under IPFS delivery the tile BYTES reach
a browser from the gateway instead, and it is the CATALOGUE record — one $DTT
naming the directory CID — that this lane most needs to carry; see
IPFS-DELIVERY.md.)

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
the uniform-mask ratio, that no ocean tile was stored, that no tile flat at sea
level claims land, that every address is unique, that adjacent tiles agree on
their shared height posts AND on their shared water-mask bytes, that every
CHILD_AVAILABILITY bit a record sets names a child the tileset really serves,
the per-level worst MEASURED vertical accuracy against Atlas's bound, and the
availability index the tileset should declare — with its ancestor closure,
because a client asks `computeMaximumLevelAtPosition(tile centre) >= level` and
not per-level membership.

It exits non-zero, naming every bound that does not hold, and a ship gate must
not read a run as green without it.

## Both engines cut every tile

The compiled flow runs in this Node process, so its wasm executes in V8 whatever
`runtimeTarget: "wasmedge"` declares — that is a declaration gate, not a
dispatch. So every cell is cut TWICE: once by the flow, and once under the
PINNED NATIVE WasmEdge (AOT where the toolchain has the compiler) on the parity
artifact, with the two record streams compared byte for byte. A divergence stops
the run. `--docker` builds and uses an image carrying BOTH Node and that pinned
WasmEdge, so a containerized run is authoritative for the engine as well as the
CPU target; `node:22-bookworm` alone was only ever the latter.

`run-report.json` states `wasmedgeVerifiedCells` and `wasmedgeRuntime`; anything
less than one per cell means the engine the fleet serves under has not seen
these bytes.

## The capability the ingest flow needs

`flows/terrain-ingest` declares `storage_write` for ONE node (`mark_write`),
which persists the $IRM resume mark. Without the grant the flow stores tiles and
then restarts at cell 0 on the next tick, which is exactly what happened while
the mark went to egress only. A deployment of this flow needs that approval
alongside `storage_query` and `storage_ingest`; the SERVING flow needs neither —
it declares `storage_query` and nothing else.
