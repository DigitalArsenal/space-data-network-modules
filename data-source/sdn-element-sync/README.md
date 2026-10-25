# sdn-element-sync

The merge step of the SDN-AP element data path. A pure WASM module (no hostcalls, no capabilities, no network, no
clock): the SDN host connectors move the bytes, the harness schedules, this module decides what the node keeps.

```
 peer A  --p2p.latest_dataset-->  hostcap/p2p-discovery  ->  pulled ($OMM) + notice ($PNV, signature verified)
 cache   --storage query-------->  hostcap/flatsql-query ->  cached ($OMM)
 harness                                                  ->  window ($QRP Request: now, cache days)
                                                              |
                                              sdn-element-sync merge
                                                              |
   omm      window snapshot, sorted         -> SDN-AP epoch store load port
   store    sets the cache does not hold    -> hostcap/storage-ingest (writes the cache)
   expire   $QRP Request, TO_EPOCH_MS       -> storage expire (drops epochs before the window)
   notice   accepted $PNV, byte for byte    -> the host re-seeds connected peers with the sets
   summary  $QRP Page with the counts
```

## Method `merge`

| Port | Dir | Type | Meaning |
| --- | --- | --- | --- |
| `window` | in, required | `$QRP` Request | `FROM_EPOCH_MS` window start (now minus the cache days; 7 days by default), `AS_OF_MS` now, `TO_EPOCH_MS` optional upper bound, `LIMIT` optional cap (oldest dropped first) |
| `cached` | in | `$OMM` | sets read back from the cache (one record or a size-prefixed stream per frame) |
| `pulled` | in | `$OMM` | sets pulled from a peer; kept only beside a `$PNV` notice whose entries are all `SIGNATURE_VERIFIED` |
| `notice` | in | `$PNV` | the pulled batch's signed provenance |
| `omm` | out | `$OMM` | window snapshot sorted by `NORAD_CAT_ID`, `OBJECT_ID`, theory, `ORIGINATOR`, `EPOCH`; size-prefixed streams of at most 4 MiB per frame |
| `store` | out | `$OMM` | pulled sets the cache lacks (new key, or the same key with different bytes) |
| `expire` | out | `$QRP` Request | `SCHEMA_NAME` OMM, `TO_EPOCH_MS` the window start |
| `notice` | out | `$PNV` | accepted notices, unchanged |
| `summary` | out | `$QRP` Page | `SCANNED`, `RECORD_COUNT`, `STORED`, `TOTAL_COUNT`, `PARTIAL` (a pull was refused or capped), `TRUNCATED`, counts in `MESSAGE` |

Rules: expiry is by `EPOCH` (a set before the window start is dropped on the way in and again at the cache by the
`expire` cutoff); a set is identified by (object, theory, originator, epoch) and a pulled set wins over a cached one;
SGP4 and SGP4XP sets of any originator pass (the epoch store selects by theory); an unsigned, unverified or notice-less pull
is refused whole and nothing of it is cached or seeded. The module never signs and never alters a notice: re-seeding
sends the original sets with the original publisher's notice, so a third node verifies the original signature.

Offline start: call `merge` with the cached frames and no `pulled`; the snapshot is the cache's window.

## Verify

```
node build.mjs && node tests/sync.e2e.mjs
```

`tests/sync.e2e.mjs`: three nodes (A publishes a signed 9-day catalog of all three lanes, B pulls and caches, C is
seeded by B), the offline restart, the two-day slide, the re-issued set, the cap, the tampered/unsigned/notice-less
refusals, with every merge run on the browser host and native WasmEdge and compared byte for byte.
