# Streaming Ephemeris OD Design

**Date:** 2026-07-23
**Status:** Approved by the owner
**Scope:** `flows/supplemental-omm/**` only

## Goal

Supplemental OMM must fetch each complete provider-native ephemeris, send that
complete file directly to orbit determination, persist the resulting
epoch-specific OMM and OCM records, and release the raw ephemeris immediately
after its processing lifetime ends.

The flow must resume after a restart from the last durably completed catalog
position. It does not need a durable raw-ephemeris cache, a whole-catalog
download barrier, per-file source synchronization, or a durable download
generation.

This design supersedes only the Supplemental OMM two-phase Starlink
download-ahead/spool behavior approved on 2026-07-22. It does not change the
approved isomorphic flow-host architecture.

## Required Architecture

- Timer, providers, OD, FlatSQL, publication, and status remain independently
  signed and instantiated WASM nodes.
- The exact same signed child artifacts and composed flow bundle execute in the
  browser harness and WasmEdge.
- Every port retains paired canonical SDS FlatBuffer and aligned-binary
  representations with identical schema identity.
- Hosts remain application-blind. No Go or JavaScript host code implements
  Supplemental OMM scheduling, cursor policy, OD, storage semantics, or graph
  behavior.
- FlatSQL remains the only durable application-record store. The host may only
  persist FlatSQL-owned or node-owned opaque bytes.

## Data Flow

1. The Starlink provider fetches the catalog manifest and freezes a
   deterministic ordered run plan.
2. A bounded provider worker window downloads complete ephemeris files in
   parallel.
3. Each successfully validated complete file is emitted immediately to OD. The
   provider does not wait for the rest of the catalog and does not write the
   raw file to opaque durable storage.
4. OD processes a bounded batch of complete files with a flow-owned WASM worker
   pool. Every fit sees the entire source ephemeris.
5. Each successful fit emits multiple epoch-specific OMM and OCM records.
6. FlatSQL durably and idempotently commits the OMM and OCM records for one
   source ephemeris as one logical transaction.
7. FlatSQL returns a success acknowledgement correlated to the deterministic
   source transaction identity.
8. The Starlink provider consumes acknowledgements, advances the highest
   contiguous completed catalog position, and persists the compact cursor.
9. The raw ephemeris frame is released when OD has consumed it; no raw source
   file remains in the flow's durable state.

There is no full-catalog download phase and no later storage-only OD drain.

## Restart State

The provider may persist only compact run metadata:

- run identifier;
- ordered catalog plan or an equivalent deterministic plan encoding;
- manifest hash;
- highest contiguous FlatSQL-acknowledged catalog position; and
- the corresponding source identity needed to reject a mismatched resume.

Raw ephemeris bytes, compressed source chunks, generation manifests, durable
drain cursors, and source-file checksums used solely to reconstruct cached raw
files are forbidden in persisted provider state.

Parallel work may finish out of order. The live WASM instance can retain a
bounded in-memory completion set for its current worker window, but the durable
cursor advances only across a contiguous acknowledged prefix. Results beyond
the cursor use deterministic FlatSQL identities, so replay after a crash is an
idempotent recomputation rather than a duplicate append.

## Failure Semantics

- Download, validation, or OD failure leaves the cursor before that catalog
  entry. Retry may refetch the complete ephemeris.
- FlatSQL failure does not advance the cursor.
- A crash after FlatSQL commit but before cursor persistence may refetch and
  refit that file; the deterministic transaction is idempotent.
- A crash after cursor persistence resumes at the next incomplete catalog
  entry.
- A manifest that cannot reproduce the persisted run plan fails closed rather
  than applying the cursor to a different ordering.
- Releasing a transient raw frame is not a completion event. Only successful
  OMM/OCM storage acknowledgement makes an entry complete.

## OBD Removal

OBD is not part of this application. Remove it from:

- OD record generation and output ports;
- flow edges;
- FlatSQL configuration and table bindings;
- publication inputs;
- status aggregation;
- UI labels and counters; and
- tests and benchmark acceptance criteria.

OMM and OCM retain their existing canonical SDS identities, numerical gates,
complete-arc fitting, and multiple epoch-specific output behavior.

## Performance Model

The steady-state server path is a bounded pipeline rather than two serialized
catalog-wide phases. The signed flow owns both provider and OD concurrency.
Browser execution is a correctness/isomorphism target; the under-one-hour
performance target applies to WasmEdge.

Benchmarks must report:

- catalog entries and source bytes;
- download, validation, OD, FlatSQL, and publication wall time;
- completed files per second and source bytes per second;
- OD objects per second;
- worker width, aggregate CPU utilization, peak RSS, and peak transient bytes;
- cursor write count and bytes;
- raw-provider opaque write, sync, and delete call counts, which must all be
  zero except compact cursor metadata operations;
- OMM and OCM record counts and numerical quality gates; and
- exact signed child and outer artifact hashes in browser and WasmEdge.

The release target is three repeated full-catalog WasmEdge runs at or below
48 minutes, leaving operational margin under the one-hour requirement.

## Acceptance Criteria

- A complete file reaches OD in the same provider wave that downloaded it.
- OD begins before the complete catalog has downloaded.
- Raw ephemerides are absent from durable opaque provider state.
- Restart resumes from the highest contiguous FlatSQL-acknowledged entry.
- Replayed work produces no duplicate OMM or OCM rows.
- OBD is absent from source behavior, manifests, graph edges, FlatSQL bindings,
  publication, status, UI, and signed artifacts.
- Exact signed browser and WasmEdge artifacts remain byte-identical.
- No handwritten Go file is edited.
