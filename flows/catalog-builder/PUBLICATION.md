# Catalog publication requirements

Evicting a final failure forgets its changed-input requirement: the object is fitted once more when reached and its outcome is recorded again. An evicted backoff retries sooner; an evicted poison is detected and recorded again on its source read. The attempt state is a cache of recent attempts; eviction removes no catalog product or selection.

Recovery re-sends the selected product bytes, even when identical bytes remain in
live storage. Durable publication adds retained SDS copies and synchronous writes. Attempt
state adds separate operational writes before numerical work. Snapshot export
and reclamation consume storage and memory. Sustained capacity is unmeasured.


The combined attempt/poison cache holds at most 4,096 entries. Admission evicts the oldest unprotected entries by the sequence of their latest event; capacity never skips or stops an object build. Eviction is normal operation and the Info notice reports `evicted=<count>`. Staged selections, prepared product-batch references awaiting terminal-index acknowledgment, and the interruption suspect are protected. The batch-size bound is checked against the cache limit (`batch_size + 1 < state_limit`). An eviction forces a full `RECONCILE=Current` snapshot before dispatch so deleted entries cannot reappear after restart. Complete source reads prune unprotected objects absent from both identities and index; other unused entries age out through FIFO eviction.

## Producer and host contract

Each tick stages its successful selections and acknowledges their products in
`catalog-products` before submitting one CAT stream to `catalog-index`. Product
batches contain at most 4 MiB and 1,000 records; the terminal index stream is at
most 4 MiB. Batch identities are `catalog-<content digest>` for product streams
and `catalog-<content digest>:complete` for the index stream. Only that final
index write declares the generation complete, including removals and identity
updates. Failed objects do not prevent the others from committing. A generation
guarantees reference closure for the tick's successful objects, not completion
of the entire input catalog.

Prepared product batch identities are written to durable attempt state before
product ingestion. Recovery queries those batches and re-sends every selected
product before the terminal index, including byte-identical records and changed
groupings. The host journals duplicates as fresh entries: a live record alone
does not close a publication generation after journal reclamation. Metadata-only
selections omit product writes. Entries with prepared products and earlier in-progress
entries are ready on the following run. The latest attempt by sequence becomes a
suspect if it is in progress and lacks a prepared-product marker. It can be a
finished healthy object after interruption during a flush before preparation is
durable, a refused marker write, or a byte-bound deferral. Identity-only and removal
generations have no prepared-product marker. The suspect waits 20 minutes on its
first attempt, doubling with repeated attempts to a 24-hour ceiling. Staged
selections are committed before retrying that suspect. A product
or terminal-index refusal stops generation storage. The previous complete
published selection remains visible; refused terminal rows can exist in the live
index. The node quarantines the refused terminal entry. On recovery the flow
accepts matching live rows as committed, drops their attempts, and sends nothing
for unchanged inputs. Quarantine discard alone does not restore publication;
the flow has no automatic recovery for this case. A new producer submission is
required to restore the missing publication.
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

Operational `catalog-attempts` state (or the partition-specific source) are not selected products and are not part
of paired catalog snapshots or announcements. Live failed/in-progress entries must survive restart. Single-object dispatch/failure markers are appended; boundary snapshots use current-source batch reconciliation to compact them and remove completed markers. A host retention policy that deletes it removes failure
backoff. Reclamation must preserve pending publication bytes and active product
references; live expiry alone does not prove safe journal reclamation.

A native synthetic build produces 256 AP selections. A loopback integration check runs the production publication signer/exporter and verification/import path with a test IPFS pin adapter and a separate consumer store. Two snapshot announcements plus two changed-batch announcements import 514 records and reconstruct the publisher's 256 selections exactly. The consumer rejects an announcement signed by a second untrusted test key and rejects a tampered shard before import. Both Ed25519 keys are randomly generated in process memory; no key file or signed test artifact is distributed.

This is a local integration check, not a deployed daemon, public gossip/DHT or live IPFS-network test. The test adapter carries announcements over loopback HTTP. The schema allow-list is inspected; anonymous record-route behavior is not changed or claimed as a live access test. Production publication retention/reclamation sizing and deployment require host validation with the intended configuration.

## Consumer trust and anonymous reads

A consumer needs the publisher's authenticated signing public key and explicit permission to import both `CAT.fbs/catalog-index` and `OCM.fbs/catalog-products` for the configured provider. A node operator enrolls the publisher through its trusted-peer configuration and permits these source identities in `peers.trusted_import.allow`; unlisted new sources are denied by default, and explicit deny rules win. A reachable peer address alone does not authorize importing its publications.

Verify the PNM with the pinned provider key, resolve its content-addressed DPM, verify the DPM signature with that same key, and verify each asset's CID/hash and declared size before import. Resolve product references before exposing the index generation. The client helper `verifySignedPnm` accepts an optional public key: omitting it validates envelope fields without checking the signature. A trusted catalog consumer must supply the key and perform manifest/asset verification as well.

The inspected host's anonymous-read allow-list includes `CAT.fbs` and excludes `OCM.fbs`. CAT metadata is anonymously readable through the standard public record/sync surface; OCM needs private-read authorization there. The list is schema-wide, so adding OCM affects the standard's records across sources. Publication pins and schema authorization are separate: an exposed public content gateway can serve pinned bytes to a reader with their CID. No allow-list, authorization or deployment setting is changed by this flow.

The operator example requires node main with the paired publication change. The
first scheduled snapshot follows an early completed generation and can contain
only a small part of the input catalog. The operator publishes a full paired
snapshot through the local admin publication route after the initial build;
24-hour automatic snapshots do not track completion of that build.
