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
- **`$OEM`**: compact row-major states (km, km/s), `CelestialFrame` EME2000 (the
  MEME `UVW` line names only the covariance frame; analysis/od rotates EME2000 to
  TEME before the SGP4 fit), UTC, `CENTER_NAME` EARTH, START/STOP_TIME and
  STEP_SIZE from the MEME header. `OBJECT_ID` stays empty (the filename's 4th
  field is SpaceX-internal). Covariance rows are skipped. A range's truncated
  trailing record is dropped.
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

The tests run the compiled wasm in the SDK browser harness through
plan -> select_objects -> emit, with the checked-in MEME fixtures served as the
http connector would. `tests/fixtures/legacy-oem` holds the `$OEM` bytes the
last JSON-lane artifact produced on the same inputs; the typed nodes emit the
same bytes. The EME2000 check fits each emitted `$OEM` with analysis/od and
scores it against a reference element set (synthetic suite public, SpaceX/
CelesTrak SupGP suite private).

`tests/meme_oem_test.cpp` is the native parse test (see its header).
