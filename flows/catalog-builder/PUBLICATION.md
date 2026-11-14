# Catalog publication requirements

Product snapshots grow with retained history, and replaced CAT records can
vanish before a deferred batch publication. A successful final catalog rebuild
does not establish that every changed batch was announced. These two gates
prevent complete catalog publication through the existing configuration.

## Paired publication

The node's paired automatic-publication mode supports a batch rule and a
periodic source rule for each provider/source/schema. Its default snapshot
interval is 24 hours. It defers rate-limited batches and reconstructs unfinished
work from retained storage. It requires append-retained records and
`publishing.retention.keep_series: 0`, including matching overrides.

That storage precondition fails for this flow's CAT source. CAT ingestion
replaces the previous record for an object in the same provider/source. In a
synthetic test with two editions of 32 objects, storage received two CAT batches
and two OCM batches before publication. After reopening storage, the paired
publisher exported one CAT batch and both OCM batches. Export of the older CAT
batch returned `no records match export query`. No explicit expiry or source
reconciliation ran. The append-retained OCM control preserved both editions.

The relevant node code is `internal/storage/record_supersede.go`,
`internal/storage/format4_daemon_writes.go`, and
`internal/api/auto_publish_paired.go`. Preserving pending publication bytes
across CAT replacement requires a durable storage-to-publication handoff.
Immediate publication requests and in-memory observers leave a crash gap.

## Compact snapshots

A synthetic storage test used 32 annotated AP products and an initial edition
followed by three daily changes to every object. It exported every daily batch
before measuring the source snapshots. It exercised storage and export only;
it did not refit each day's synthetic orbit.

| Daily changes after initial edition | Product records | Product shard bytes | CAT records | CAT shard bytes |
| --- | ---: | ---: | ---: | ---: |
| 0 | 32 | 491,776 | 32 | 10,752 |
| 1 | 64 | 983,552 | 32 | 10,752 |
| 2 | 96 | 1,475,328 | 32 | 10,752 |
| 3 | 128 | 1,967,104 | 32 | 10,752 |

The selected product set remains 32 records and 491,776 bytes. Each annotated
fixture product occupies 15,368 bytes. At 33,000 objects, simple multiplication
of this fixture gives 518,232,000 raw bytes for selected products plus CAT,
versus 2,039,664,000 bytes for four retained product editions plus CAT. These
are synthetic size projections, excluding export indexes and transport; they
are not full-catalog measurements.

Separate current-product and current-index sources also need a consistent
publication boundary. A control replaced the product source and interrupted
before replacing the index source. All 32 selected product identifiers were
absent from the exported product source. Retaining older products prevents that
missing-reference failure but leaves history in the full-source export.

A compact exporter needs one completed CAT selection and exactly the OCM bytes
it references, with a defined cutoff for subsequent changed batches. It must
validate and protect those references across export and replacement. The node's
existing `ExportDatasetRecords` writes selected records; the configured source
export has no selection-closure predicate or shared catalog-generation boundary.

Superseded-product reclamation must follow successful changed-batch export and
preserve products referenced by retained selections or snapshots. The paired
mode's required retain-all series setting retires no publication assets.
Arrival-time record expiry does not check selection references or publication
completion.

## Verified boundary

The integrated native controller passes first build, changed-only work,
equal-epoch correction, refusal, weather recovery, expiry fallback, removal,
and process recovery after product storage before index replacement. Actual
SDS snapshot and batch exports reproduce the final selection map and resolve
every selected product identifier. Distinct-object publication process failures
at commit, shard creation, announcement handoff, and completion also recover
with an inert publication service.

Final-map convergence and distinct-object recovery do not cover the missing
same-object CAT batches described above. No signing, network delivery, consumer
trust, or anonymous-access claim follows from these checks. Complete publication
requires both the durable pending-CAT handoff and a consistent compact snapshot.
