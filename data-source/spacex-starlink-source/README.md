# SpaceX Starlink Data Source

SpaceX Starlink operator ephemeris (the public MEME files under
`https://api.starlink.com/public-files/ephemerides/`) as SDS `$OEM`, in memory
only, for the OD flow. Typed contracts 1.0: every port is one FlatBuffer type,
no JSON and no base64. No credentials and no host capabilities beyond the node
config; `hostcap/http-request` does the fetching.

## Nodes

| method | in | out |
|---|---|---|
| `plan` | `tick` TimerTick (TICK) | `requests` HttpRequest (HREQ): GET `MANIFEST.txt` |
| `select_objects` | `manifest` HttpResponse (HRSP) | `requests` HREQ, one per MEME file, 16 per invocation (the rest yielded as backlog); `status` FlowNotice (FNTC) |
| `emit` | `ephemerides` HRSP (up to 32) | `oem` SDS `$OEM`, one per object; `status` FNTC |

- **Job state** travels as `HttpRequest.CONTEXT`: one size-prefixed `$OEM`
  header record per object (one ephemeris data block whose `OBJECT` carries
  `OBJECT_NAME` and `NORAD_CAT_ID` from the MEME filename, no states), echoed by
  the http connector and read by `emit`. Pairing is by CONTEXT; a response
  without it is refused (`missing-context`).
- **`$OEM`**: explicit state rows in EME2000, UTC, km and km/s. Each source
  timestamp is preserved without passing through a floating-point Julian date;
  gaps stay gaps. START/STOP_TIME are the first and last retained records.
  All 21 supplied covariance entries remain in the declared UVW or EME2000
  frame, with their matching epochs. UVW uses the existing RSW_INERTIAL
  convention of the native Modified ITC and OD consumers, with NAME=UVW retained.
  No covariance is synthesized, calibrated, scaled or repaired by this reader.
  All-state-only input emits no covariance. Mixed supplied/missing matrices,
  malformed values, nonfinite values and unsupported frames produce a named
  Missing notice. A partial HTTP range drops an incomplete trailing record,
  including a potentially truncated numeric token, and records that omission
  in the OEM comment. OBJECT_ID stays empty: the filename's fourth field is an
  internal identifier, not a COSPAR designation.
- **Notices**: `select_objects` - Info `object-count` (probe), Missing
  `manifest-unavailable`, Skipped `nothing-to-fetch`; `emit` - Missing
  `objects-unavailable` (not 200/206, empty, or no state vector).

## Config (`plugin.getConfig`, one ModuleConfig)

| key | default | |
|---|---|---|
| `manifestUrl` | the public MANIFEST.txt | |
| `objectCap` | unlimited | > 0 caps the objects a pull covers |
| `offset`, `count` | the whole `[0, total)` | a window into the capped manifest |
| `rangeBytes` | 131072 | leading byte range per file (~2-3 orbits, the fit window); 0 = whole file |
| `probe` | false | report the object count (FlowNotice Info) instead of fetching |
| `timeoutMs` | connector default | HttpRequest TIMEOUT_MS |

## Build & test

```
export SPACE_DATA_STANDARDS_ROOT=<spacedatastandards checkout>
node build.mjs                 # SDK compiler; inlines RFM TIM IDM PLD LCC CAT PPE OEM + common/oem_fb_builder.hpp
node --test tests/*.test.mjs
```

`node tests/covarianceE2E.mjs` verifies the built module through typed
manifest/response frames in browser WASM and WasmEdge. It compares every state
and covariance value to the decimal tokens in SpaceX's published example,
checks exact epochs, gaps, absent/malformed covariance and HTTP range edges,
and passes emitted OEMs to the built CA consumer. The independent native
Modified ITC parser and the analytic straight-line encounter give the reference
miss distance and probability. This is input fidelity and computational
conformance evidence; it does not establish covariance calibration.

Authority: [SpaceX Space Safety trajectories](https://docs.space-safety.starlink.com/docs/tutorial-basics/trajectories/),
Modified ITC section. The retained example's hash, units, frames and exact-value
criterion are in `tests/fixtures/itc-authority/provenance.json`.

The public census retains its original pinned reader and reports its covariance
loss explicitly. Reprocessing those raw bytes with this version requires a
separately registered amendment; completed propagator scores are not rewritten.
