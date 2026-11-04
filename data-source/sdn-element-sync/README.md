# sdn-element-sync

The merge step of the SDN-AP element data path. A pure WASM module (no hostcalls, no capabilities, no network, no
clock): the SDN host connectors move the bytes, the harness schedules, this module decides what the node keeps.

```
 peer A  --p2p.latest_dataset-->  hostcap/p2p-discovery  ->  pulled ($OMM), pulled_ocm ($OCM) + notice ($PNV, signature verified)
 cache   --storage query-------->  hostcap/flatsql-query ->  cached ($OMM), cached_ocm ($OCM)
 harness                                                  ->  window ($QRP Request: now, cache days)
                                                              |
                                              sdn-element-sync merge
                                                              |
   omm      SGP4 lane snapshot, sorted       -> SDN-AP ingest_omm (foreign $OMM as received)
   ocm      element-set lane snapshot        -> SDN-AP load_epochs (SGP4XP and AP $OCM)
   store    SGP4 sets the cache lacks        -> hostcap/storage-ingest (writes the cache)
   store_ocm element sets the cache lacks    -> hostcap/storage-ingest
   expire   one $QRP Request per lane        -> storage expire (drops epochs before the window)
   notice   accepted $PNV, byte for byte    -> the host re-seeds connected peers with the sets
   summary  one $QRP Page of counts per lane
```

## Method `merge`

| Port | Dir | Type | Meaning |
| --- | --- | --- | --- |
| `window` | in, required | `$QRP` Request | `FROM_EPOCH_MS` window start (now minus the cache days; 7 days by default), `AS_OF_MS` now, `TO_EPOCH_MS` optional upper bound, `LIMIT` optional cap per lane (oldest dropped first) |
| `cached` | in | `$OMM` | SGP4 lane: sets read back from the cache (one record or a size-prefixed stream per frame) |
| `pulled` | in | `$OMM` | SGP4 lane: sets pulled from a peer; kept only beside a `$PNV` notice whose entries are all `SIGNATURE_VERIFIED` |
| `cached_ocm` | in | `$OCM` | element-set lane (SGP4XP, AP): sets read back from the cache |
| `pulled_ocm` | in | `$OCM` | element-set lane: sets pulled from a peer, under the same notice rule |
| `notice` | in | `$PNV` | the pulled batch's signed provenance |
| `omm` | out | `$OMM` | SGP4 lane snapshot sorted by `NORAD_CAT_ID`, `OBJECT_ID`, theory, `ORIGINATOR`, `EPOCH`; size-prefixed streams of at most 4 MiB per frame |
| `ocm` | out | `$OCM` | element-set lane snapshot sorted by `METADATA.NORAD_CAT_ID`, `METADATA.INTERNATIONAL_DESIGNATOR`, `MEAN_ELEMENTS.MEAN_ELEMENT_THEORY`, `HEADER.ORIGINATOR`, `MEAN_ELEMENTS.EPOCH`; size-prefixed streams of at most 4 MiB per frame |
| `store` | out | `$OMM` | SGP4 pulled sets the cache lacks (new key, or the same key with different bytes) |
| `store_ocm` | out | `$OCM` | element-set pulled sets the cache lacks |
| `expire` | out | `$QRP` Request | one per lane: `SCHEMA_NAME` OMM, then OCM; `TO_EPOCH_MS` the window start |
| `notice` | out | `$PNV` | accepted notices, unchanged |
| `summary` | out | `$QRP` Page | one per lane (`SCHEMA_NAME` OMM, then OCM): `SCANNED`, `RECORD_COUNT`, `STORED`, `TOTAL_COUNT`, `PARTIAL` (a pull was refused or capped), `TRUNCATED`, counts in `MESSAGE` |

Rules: one record type per theory lane: foreign SGP4 sets travel as the `$OMM` received, SGP4XP and AP sets as `$OCM`.
Every record passes byte for byte (an AP record's `SPACE_WEATHER` rows and density-correction nodes included). Expiry
is by `EPOCH` (a set before the window start is dropped on the way in and again at the cache by the `expire` cutoff); a
set is identified by its lane's key and a pulled set wins over a cached one; an unsigned, unverified or notice-less
pull is refused whole and nothing of it is cached or seeded. Refused by name, the whole call with no output: any record
with `USER_DEFINED_PARAMETERS` (`user-defined-parameters:<count>`), an `$OCM` without `MEAN_ELEMENTS`
(`mean-elements-missing`) or with `MEAN_ELEMENT_THEORY` UNSPECIFIED (`mean-element-theory-unspecified`), a frame that is
not its port's type (`invalid-omm-frame`, `invalid-ocm-frame`). The module never signs and never alters a notice: re-seeding
sends the original sets with the original publisher's notice, so a third node verifies the original signature.

Offline start: call `merge` with the cached frames and no `pulled`; the snapshot is the cache's window.

## Verify

```
node build.mjs && node tests/sync.e2e.mjs && node tests/ocm-lane.e2e.mjs
```

`tests/sync.e2e.mjs`: three nodes (A publishes a signed 9-day catalog of all three lanes, B pulls and caches, C is
seeded by B), the offline restart, the two-day slide, the re-issued set, the cap, the tampered/unsigned/notice-less
refusals, with every merge run on the browser host and native WasmEdge and compared byte for byte.

`tests/ocm-lane.e2e.mjs`: on the fixtures of `tests/fixtures` (PROVENANCE.md), the SGP4 lane equals the 0.1.0 dist byte
for byte, the `$OCM` lane keeps the XP and AP sets deduped on its key, the refusals by name, and the 4 MiB chunk count
of a 34-row AP record.
