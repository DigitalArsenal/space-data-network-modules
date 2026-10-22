# Deep-space spacecraft 0.2.0

42 spacecraft from NASA/JPL Horizons VECTORS, published by trajectory segment.
Each `(NAIF id, catalog)` gets one size-prefixed SDS `$OEM`, containing only that
regime's blocks. Lane: `OEM.fbs`, provider `deep-space-spacecraft`, source name
from the table below. A spacecraft can occupy several lanes; Juno has both its
Sun-centered archive and a Jupiter-centered window. Ended missions are lifecycle
attributes, never catalogs. **This module produces no `<body>-surface` catalogs.**

All parsing, planning, geometry and interpolation run in C++/WASM. The host HTTP
connector moves request/response bytes. The module has no network imports.

| Catalog (`source_name`) | Membership rule | Cadence |
| --- | --- | --- |
| `lunar-orbit` | Moon window maximum radius <= 30,000 km | 24 h |
| `cislunar` | Sun rows within 500,000 km of Earth after exclusions; remaining Earth/Moon windows | 24 h |
| `earth-moon-lagrange` | Within 60,000 km of EM L1/L2 (Sun-centered runs need 30 days of station-keeping); Moon window maximum <= 120,000 km after lunar-orbit | 24 h |
| `sun-earth-l1` | Earth distance 500,000–2,500,000 km, sunward within 45 degrees of Sun-Earth line | 168 h |
| `sun-earth-l2` | Same distance/cone, outward beyond Earth | 168 h |
| `mercury-orbit` | Mercury window median radius < 100 Mercury radii | 24 h |
| `venus-orbit` | Venus window median radius < 100 Venus radii | 24 h |
| `mars-orbit` | Mars window median radius < 100 Mars radii | 24 h |
| `jupiter-orbit` | Jupiter window median radius < 100 Jupiter radii | 24 h |
| `saturn-orbit` | Saturn window median radius < 100 Saturn radii | 24 h |
| `heliocentric` | Remaining Sun rows and distant planet windows | 168 h |

Sun rows within **60,000 km** of Earth are dropped; Earth-orbit OMM catalogs own
those objects. EM L1/L2 lie at **0.8369 / 1.1557** Moon distances along the
Earth-to-Moon vector. Earth windows use median Earth distance for exclusion,
then median distance to the nearer L1/L2 point (< 60,000 km), else cislunar.
Planet mean radii in km: Mercury **2439.7**, Venus **6051.8**, Mars **3389.5**,
Jupiter **69911**, Saturn **58232**. Non-Sun windows are classified as a whole.

Sun classification uses the rows actually present across daily and dense blocks.
Runs shorter than **3 days** merge backward, or forward when first; Earth-Moon
and Sun-Earth L1/L2 runs need **30 days** of station-keeping, so brief lunar
swingbys such as Wind's and Earth-assist cone crossings fold into a neighbor.
The launch leg (first run) needs **20 days**. The published solar cone rules
use the same **45-degree** half-angle as the classifier. Non-Sun window rules
and all reference frames are unchanged by the dwell requirement. Splits share
the first row of the new run; pieces with fewer than two rows are dropped.
Row values, labels, steps and Hermite degree 7 remain intact. Excluded Earth
segments can leave gaps. Membership never changes the row's reference center.

The analytic classification model is JPL/Standish Table 1 EMB elements and rates
(1800–2050), Kepler-solved, minus `moon_geo / 82.3005`. The Moon uses the first
12 terms of each Meeus chapter 47 longitude/distance and latitude table, with
general longitude precession removed. AU = **149597870.7 km**; J2000 obliquity =
**23.43928 degrees**. These approximations are for regime classification only,
not trajectory evaluation. Times are seconds from **2000-01-01T12:00:00 TDB**.

The 23 archive craft are Roadster, Voyager 1/2, Pioneer 10/11, New Horizons,
Parker Solar Probe, JWST, Juno, Europa Clipper, Lucy, Psyche, OSIRIS-APEX,
SOHO, ACE, DSCOVR, Wind, Gaia, Euclid, BepiColombo, Solar Orbiter, LCROSS Shepherd
and Danuri/KPLO. The original 13 retain their event table. The ten additions
have no encounter events and use the same public JPL Horizons license and credit.

| Added archive craft | NAIF id | Horizons name | COSPAR | NORAD | Aliases | Lifecycle |
| --- | --- | --- | --- | --- | --- | --- |
| Solar Orbiter | -144 | `solar orbiter` | 2020-010A | 45167 | Solo | Active |
| LCROSS Shepherd | -18 | `lcross` | 2009-031B | 35490 | LCROSS | Ended 2009-10-09 |
| Danuri | -155 | `danuri\|kplo` | 2022-093A | 52790 | KPLO; Korea Pathfinder Lunar Orbiter | Active |

| Window center | Step | Craft |
| --- | --- | --- |
| Moon (301) | 300 s | LRO, CAPSTONE, ARTEMIS P1/P2, LADEE, GRAIL-A/B |
| Earth (399) | 900 s | TESS, Artemis I/II |
| Mars (499) | 300 s | MRO, MAVEN, Mars Odyssey, Mars Express, TGO |
| Venus (299) | 300 s | Akatsuki, Venus Express |
| Mercury (199) | 300 s | MESSENGER |
| Jupiter (599) | 600 s | Juno (also archive) |
| Saturn (699) | 300 s | Cassini |

`src/notables.hpp` is the identity/event/lifecycle source. Missing COSPAR/NORAD
values stay empty/zero. Pioneer 10/11, LADEE, GRAIL-A/B, Artemis I, Venus Express,
MESSENGER, Cassini, Gaia (**2025-03-27T00:00:00**) and LCROSS Shepherd
(**2009-10-09T00:00:00**) carry explicit mission end times. If coverage ends before
`now_tdb`, lifecycle falls back to ended with that coverage end. A terminal
archive encounter truncates that archive, not the mission lifecycle.

Configuration and retrieval:

1. Host node configuration is a typed `ModuleConfig`, read through
   `sdm_piv::get_config()`. `deep_space_enabled` is a Bool; false or absent emits
   one `FlowNotice` Skipped (`disabled`) and nothing else. Enabled runs require
   a non-empty String `producer_peer_id` (`missing-producer-peer-id` otherwise).
2. `objects` is an optional NumberList of known NAIF ids; omitted means all 42.
   `plan_horizons` requires one `TimerTick`. Its UTC `FIRED_MS` is floored to the
   UTC day for the internal `now_tdb` day label; the window plan uses only that
   day, not a sub-day UTC/TDB conversion. The exact milliseconds remain in state
   as `config.retrieved_ms` for creation dates and provenance. No wall clock is read.
3. `limits` is an optional TableList of `{id: Number, start: String, stop: String}`
   tables; start/stop may be omitted. TDB calendar bounds clamp archive and
   window coverage; window limits round inward to whole days.
4. `page_rows` defaults to 80,000; allowed range 1–89,000. The Horizons line cap
   is 90,024. Smaller pages can exceed the fixed six-stage request budget and
   fail with `too-many-requests`.
5. Archives retain the existing daily grid: `floor(lo) + 2` seconds through
   `floor(hi) - 1`, clamped by limits and terminal encounters. Departure covers
   two days; encounter windows snap outward to that grid and touching windows
   merge. Dense archive windows use 600 s steps.
6. Each rolling phase spans `[floor_day(now) - 2 days, floor_day(now) + 28 days]`.
   Coverage is `[ceil_day(lo + 1 day), floor_day(hi - 1 day)]`. A window entirely
   after/before coverage uses its last/first 30 days, then clamps to coverage
   and limits. Each phase is a separate group, labeled `window <body>-centered`.
7. `plan_horizons` queues two probes per craft (1900/2300) and emits at most 60.
   Each of six `advance` calls absorbs its pending responses, then emits at
   most 60 more requests. Vectors are planned only after all probes are absorbed.
8. Exhausted advances increment `stage` and emit zero requests. `build_oem`
   accepts stage six or any earlier exhausted vector queue, consuming the last
   pending response batch itself. Response counts must exactly match pending.
9. State retains six float64 components per row as base64; daily rows strictly
   inside dense archive windows are omitted. State frames must be below 64 MiB.

Coverage, trajectory-plan and HTTP-200 vector parse/validation failures skip only
that craft with the named code, release its stored groups and suppress its future
requests; already-emitted responses are consumed and ignored. Other craft keep
identical OEM bytes. Skipped craft emit no records. Plan/advance emit one Info `FlowNotice` on
`status`, with the active craft count and skipped `ITEMS` as `<naif_id>:<code>`.
Build emits a Missing notice per skipped craft and one Info summary of all eleven
catalog counts on `notice`. An all-skipped build fails with `no-trajectories`.
Requests are plain GET `HttpRequest` frames (HREQ), with no headers; URLs retain
the cassette's exact encoding. Responses are `HttpResponse` (HRSP), paired by
request order. A transport ERROR fails with `fetch-failed`; non-200 status or an
empty BODY fails with `horizons-http-error`. Invalid response envelopes, response
counts, state and configuration remain fatal.

Each vector page's `Target body name:` line must contain its id and a case-insensitive `horizons_name` substring (`|` separates alternatives), or that craft is skipped with `vector-target-mismatch`.

`build_oem` outputs one pair per populated catalog in the table order:

- `<id>_records`: one stream concatenating every size-prefixed `$OEM` in that
  catalog, sorted by descending NAIF id. Port ids replace hyphens with underscores
  (`lunar_orbit_records`, `sun_earth_l1_records`, etc.). Blocks retain their
  original centers, ICRF, TDB, row bits and Hermite interpolation.
- `<id>_meta`: one `IngestRequest` (INGQ), schema `OEM.fbs`, reconciliation Current,
  provider `deep-space-spacecraft`, source name the hyphenated catalog id,
  source peer `producer_peer_id`, and batch id the SHA-256 hex of the paired stream.
- `catalogs_records` / `catalogs_meta`: the existing size-prefixed `$EGP` group
  stream and its `EGP.fbs` ingest request. Source name `catalogs`; batch id is the
  stream SHA-256 plus `@<retrieved_ms>`. Each populated lane has a `QUERY_LIVE`
  group with id `deep-space-spacecraft/<catalog>`, sorted tags, the existing
  `sdn-data-query` query text, and object count.
- `notice`: one Missing `FlowNotice` per skipped craft (`REASON` the code,
  `ITEMS` the NAIF id), then one Info (`catalog-counts`) with total record count
  and `ITEMS` `<catalog>:<count>` for all eleven catalogs, including empty ones.

Both ingest requests carry the Horizons URL, HTTP status 200, exact retrieval
milliseconds, parser `deep-space-spacecraft` version `0.2.0`, normalized SHA-256,
record count, schema/count vectors and one provenance attribute per object:
`naif:<id>` = `<name>; lifecycle active|ended`. Tags carry
`LicenseRef-NASA-JPL-Horizons-PD` and `Ephemeris: NASA/JPL-Caltech Horizons`.

The internal JSON state and `evaluate_oem` / `reconcile_id` contracts remain.
Every new external port names one concrete FlatBuffer type. There is no receipt
input or host adapter. Each OEM COMMENT retains `CATALOG`, `LIFECYCLE`, aliases,
license, credit and segment labels. `retrieved_ms` supplies OEM `CREATION_DATE`
and EGP UTC timestamps; output bytes are deterministic for identical inputs.

`flow.mjs` composes the timer-bound plan, seven HTTP stages, six advances and
build with eleven OEM storage-ingest nodes plus one EGP storage-ingest node.
Only internal state edges are opaque. Storage-ingest 0.5.0 supplies `oem_records`.
The Horizons predictions refresh defaults to **604800000 ms (7 days)**.
The existing `daily` trigger id remains stable; its interval is weekly.
The UTC day conversion in `src/runtime_contracts.hpp` still uses 86400000 ms
per day, independently of refresh cadence or trajectory sampling steps.

License: NASA/JPL Horizons On-Line Ephemeris System (Solar System Dynamics Group):
U.S. Government work, public domain. Credit: Ephemeris: NASA/JPL-Caltech Horizons.
Both travel in every block and EGP provenance, with the Horizons API source URL.

`evaluate_oem` verifies the FlatBuffer, accepts every block center, honors its
interpolation and prefers the smaller step at shared edges. Out-of-span epochs
fail. `reconcile_id` maps mission `artemis-ii` kernel `-24` to Horizons `-1024`;
an unqualified `-24` remains Pioneer 11.

```sh
cd data-source/deep-space-spacecraft
npm install --offline --no-audit --no-fund
node build.mjs
PATH="$HOME/.wasmedge/bin:$PATH" HORIZONS_RECORD=0 node --test tests/*.e2e.test.mjs
```

The standalone offline E2E validates the SDK artifact and explicitly probes the
original 13 identities. The original `tests/fixtures/horizons/cassette.json.gz`
contains **three** craft (Roadster, Voyager 1/2), **29** requests and **60** independent Horizons TLIST reference
epochs, in Sun-centered ICRF km/km/s and JD TDB. Position tolerance is 1 km for
source rounding/interpolation; observed errors remain meter scale. The cassette
has no JWST/Juno vectors, Earth positions or geocentric distances and remains
unchanged. Its optional `HORIZONS_RECORD=1` refresh mode requires network access.
Solar Orbiter, LCROSS Shepherd and Danuri have no recorded Horizons responses.
Recorded replays keep their explicit `objects` selections and historical
`limits`, so none requests an uncached URL. The new craft remain in the default
roster and run in the offline C++ synthetic tests, including the full-roster
stress run; no synthetic body is added to either recorded cassette.

`tests/fixtures/horizons/regime-cassette.json.gz` is a separate **27-request**
recording made on **2026-10-21** by a live drive of the compiled module against
`https://ssd.jpl.nasa.gov/api/horizons.api`, with the TimerTick **FIRED
2026-10-21T12:34:56Z** (`firedMs: 1792586096000`). The live drive answered the
module's requests through `plan_horizons` → six `advance` calls → `build_oem`
and saved `{firedMs, config, responses}` with each exact URL mapped to its full
Horizons response text. It selected eight objects and applied these per-craft
`limits` (TDB calendar timestamps, all at `00:00:00`):

| Craft | NAIF id | Start | Stop |
| --- | --- | --- | --- |
| JWST | -170 | 2021-12-28 | 2022-03-01 |
| SOHO | -21 | 1996-01-15 | 1996-09-01 |
| ACE | -92 | 1998-01-01 | 1998-06-01 |
| LRO | -85 | 2026-10-19 | 2026-10-26 |
| CAPSTONE | -1176 | 2026-08-07 | 2026-08-14 |
| MRO | -74 | 2026-10-19 | 2026-10-26 |
| Juno | -61 | 2026-10-19 | 2026-10-26 |
| Artemis I | -1023 | 2022-12-04 | 2022-12-11 |

The recorded-regime test reuses `tests/horizons-stages.mjs` and the stored config
and tick without network access or a fetch fallback; all 27 URLs must match
exactly once. Independent mission expectations require JWST only at Sun-Earth
L2, SOHO only at L1, LRO in lunar orbit, CAPSTONE in Earth-Moon Lagrange,
MRO in Mars orbit, Artemis I in cislunar, and the same Juno identity (-61) in both
heliocentric and Jupiter-orbit catalogs. ACE's limits precede its recorded
2006 coverage start, so it must skip with `empty-trajectory-range`. Artemis I
has ended; CAPSTONE is marked ended because its recorded coverage ends before
FIRED (this does not assert that the mission terminated). The test checks exactly
one EGP per non-empty catalog, the recorded reference centers (including
CAPSTONE MOON/301 and Artemis I EARTH/399), and `evaluate_oem` at an interior
TDB epoch in every block. It has a 60-second timeout.

`tests/composed-flow.e2e.test.mjs` checks the deployment wiring offline. It calls
`deepSpaceFlow` with the deployment builder's node/typed-edge helpers and dependency
map, runs SDK CLI `flow check` and `flow compile` into a temporary directory, and
loads the compiled isomorphic artifact with `createFlowRuntimeHost`. The actual
source, HTTP and storage-ingest guests run linked inside the JS flow host. Only
their typed `$PIV` hostcalls are answered by the test: config, the local Horizons
cassette and a recording `storage.ingest_with_source` stand-in. There is no network
fallback, even in record mode, and no native WasmEdge dependency for this test.

One TimerTick on the weekly interval (trigger id `daily`) selects the three
cassette craft via `objects`, using the cassette's page size and historical
limits. All 29 HTTP URLs must be cached and
unique. Only the heliocentric OEM and catalogs EGP ingest nodes may run; their
streams must equal the shared standalone staged replay byte for byte, with source,
peer, Current reconciliation and batch tags intact. OEM batch IDs are stream
SHA-256; EGP retains its existing `SHA-256@<retrieved_ms>` contract. Node status,
typed routing, ingest results and the catalog-count summary are checked. A second,
disabled run must emit just one Skipped notice with no HTTP or ingest calls and
no downstream guest invocations. The test compiles once, cleans its temporary
directory, has a three-minute timeout and normally takes about 15 seconds:

```sh
HORIZONS_RECORD=0 node --test tests/composed-flow.e2e.test.mjs
```

`browser and WasmEdge produce byte-identical frames` replays that cassette and
the 20-object synthetic plan's first two advances on both direct harnesses.
It compares every frame's port, type reference and SHA-256, exact final
records/metas/groups/notices and request URLs, and the `invalid-state` error/status
pair. Both lanes receive the same config and TimerTick. Diagnostics report 12
invocations per lane and their durations; missing WasmEdge explicitly skips this
named test. The parity replay always uses local responses, including in record mode.

Independent C++ synthetic fixtures additionally test body thresholds, a published
Meeus lunar point, solar geometry from a separate Meeus approximation, 44/46-degree
cone edges, 5/29-day passes versus 30/40-day dwells at Sun-Earth and Earth-Moon
L1/L2 (including first, interior and final lunar runs), 15/19-day launch legs versus
the 20-day boundary, three-day interior/final smoothing, exact run boundaries,
shared edges, exact row preservation, Juno's two centers, EGP tags/queries,
lifecycle, tick timestamps, coverage clamps, skipped probes and early builds.
It also verifies typed ports, disabled/missing-producer behavior, every ingest
metadata/record pairing and digest, notices and typed flow topology.
The 20-object paged run and 42-object 1970–2050 stress run finish within six
advances. The latter issues 147 vector requests and retains at most 57,680,723
bytes of state, below 64 MiB. Identity/lifecycle tests check the three
new archive craft and Gaia's explicit end date, and flow tests check the weekly default.
