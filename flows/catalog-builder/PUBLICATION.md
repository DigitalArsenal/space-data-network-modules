# Catalog publication requirements

Compact annotated products average 9,858 bytes against a 5,088-byte fit record
in the synthetic sample. Durable publication adds a synchronous retained SDS
copy before storage commits. Retained writes serialize, disk usage grows with
history, and automatic journal reclamation is absent. Snapshot selection and
export also consume bounded memory. The numerical throughput measurements do
not include this retention path or publication costs.

## Producer and host contract

Each selected product is acknowledged in `catalog-products` before its CAT
replacement is submitted to `catalog-index`. The batch identity is
`catalog-<content digest>` for a product and
`catalog-<content digest>:complete` for an index. Each single-object replacement
is one completed catalog generation, including removals with an empty product
list. A completed generation can represent partial progress through a bounded
timer invocation or the initial catalog build; it guarantees reference closure,
not that every input object has been processed.

The host must retain exact pending batch bytes durably before CAT replacement,
recover them after restart, defer publication across rate limits, and acknowledge
completion only after successful publication. A product-only interruption leaves
the previous completed index visible. The terminal index batch completes the
updated selection after reference validation. Ordinary live-record replacement,
expiry, or deletion must not erase pending publication bytes.

Enable retention on empty CAT and OCM sources before the first ingest, with
format-4 storage and exact provider/source identities. Existing unretained
history cannot be reconstructed. An example host configuration is:

```yaml
publishing:
  enabled: true
  retention:
    keep_series: 0
  auto_publish:
    - schema: OCM.fbs
      provider_id: catalog-producer
      source_name: catalog-products
      retain_for_publication: true
      min_interval: 5m
      settle: 10s
    - schema: CAT.fbs
      provider_id: catalog-producer
      source_name: catalog-index
      retain_for_publication: true
      min_interval: 5m
      settle: 10s
    - schema: CAT.fbs
      provider_id: catalog-producer
      source_name: catalog-index
      publish_scope: source
      paired_publication: true
      catalog_product_source: catalog-products
      min_interval: 24h
```

The provider must match `catalog.provider`. Effective retention overrides also
require `keep_series: 0`. The product-source selection setting does not activate
retention by itself. Backlog or recovery errors require operator attention;
adding service partitions inside a store does not enlarge its shared bounds.

## Compact snapshots and consumers

A snapshot captures the last completed index generation and exactly the products
it references at one durable cutoff. The host validates every reference and
protects the captured bytes across concurrent replacement and export. Publication
exports products before the index; a product failure prevents index publication.
The paired export sidecars carry the same `publicationCutoff`. A product
announcement alone does not commit a catalog generation.

A consumer starts with that pair and applies later changed batches in journal
order through completed generations. `PRODUCTS_AS_OF` is descriptive metadata,
not a conflict-resolution clock. A batch crossing the snapshot cutoff is replayed
in full. Duplicate content identifiers are harmless. Empty product lists remove
selected products. Consumers must have every referenced product before exposing
a completed index selection.

## Verified behavior

Unsigned synthetic tests exercise the compiled native controller and actual SDS
exports with inert signing and transport boundaries:

- First build, unchanged tick, equal-epoch correction, refused fit, weather
  recovery, old-span fallback, and removal pass. A SIGKILL after product storage
  resumes with only the missing index write.
- Two editions of 32 objects retain and export all four changed batches after
  superseding ingestion and restart: two CAT and two OCM batches. The older CAT
  export remains readable.
- Initial storage plus three daily metadata revisions produces exactly 32 CAT
  entries and 32 selected compact products in every snapshot. Each snapshot has
  315,456 product bytes and 10,752 CAT bytes; export indexes add 13,472 and 15,417
  bytes respectively. These fixtures reuse fitted synthetic products and do not
  represent daily numerical refits.
- The native controller's actual initial snapshot plus 13 post-cutoff exports
  matches a fresh compact snapshot, with identical selected product bytes, one
  fallback, and one removal. All 17 changed batches survive: ten CAT and seven
  OCM. Completed publication receipts suppress restart replay.
- Process failures at storage commit, shard creation, announcement handoff, and
  completion recover using actual exported SDS files. Repeated announcement at
  the handoff boundary requires content-identifier deduplication.
- Captured selection, retention, rate-limit recovery, and production sequencing
  tests cover product-only SIGKILL, live expiry, concurrent updates during
  export, and refusal to publish an index after product export fails.

The separate-current-source control remains unsafe: replacing products before
its index leaves all 32 selected references unresolved. Compactness depends on
a consistent completed-generation export, not separate source replacement.

## Capacity and excluded behavior

The tested host bounds retained state at 100,000 journal entries and 200,000
indexed retained records, with 4,096 pending batches per source. It also bounds
reference metadata at 128 MiB, selections at 100,000 records, shard-index metadata
at 64 MiB, and individual payloads at 16 MiB. Completed history consumes these
limits. Each changed object normally adds a product and an index transaction;
a first build of 100,000 objects therefore exceeds the journal-entry bound in
one store. The 33,000-object first build consumes about 66,000 entries before
further history. Compute/schedule arithmetic is not a sustained publication-rate
guarantee. Separate stores and a supported drain/retirement procedure are
prerequisites for larger or long-running catalogs.

Reclamation requires completed changed-batch publication and preservation of
all retained-generation references. Retain-all completion policy retires no
assets. Live expiry is not journal reclamation. A retained source can be retired
only after pending and unapplied entries drain; whole-journal removal requires
all sources to retire and the node to stop. Existing published bytes remain
outside that storage cleanup.

Signing, network announcement delivery, consumer trust verification, signed-out
reads, deployment, and automatic journal reclamation are outside these tests.
