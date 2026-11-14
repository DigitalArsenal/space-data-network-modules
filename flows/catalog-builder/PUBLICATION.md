# Catalog publication requirements

Durable publication adds retained SDS copies and synchronous writes. Attempt
state adds separate operational writes before numerical work. Snapshot export
and reclamation consume storage and memory. Sustained capacity is unmeasured.

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

## Validation boundary

The compiled controller tests cover product-before-index ordering, deterministic
batch reuse after interruption, unchanged refusals, operational attempt recovery,
removals and equality of stored AP/SGP4 fields and propagation to their inputs.
The native first-build check exercises actual storage pages and acknowledgment
of operational events before fitting. Older export-fixture byte counts and
throughput readings do not describe this controller.

Operational `catalog-attempts` events are not selected products and are not part
of paired catalog snapshots or announcements. Their latest per-object state
must survive restart. A host retention policy that deletes it removes failure
backoff. Reclamation must preserve pending publication bytes and active product
references; live expiry alone does not prove safe journal reclamation.

Signing, announcement delivery, consumer trust, signed-out reads and deployment
are outside these checks. Current-generation snapshot export, superseding-batch
recovery and publication reclamation require host validation with the intended
configuration; no obsolete fixture counts are presented as that evidence.
