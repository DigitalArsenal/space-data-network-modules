# NOAA SWPC real-time producer

C++/WASM request planning and source parsing. All module ports and published
records are FlatBuffers; only NOAA's upstream documents are JSON. The host
owns HTTP, scheduling, storage, signing and publication. NOAA SWPC products
are public domain: https://www.weather.gov/disclaimer.

SDS 1.274.0 is pinned locally by this package. `plan_sfe` requests GOES flares
and `parse_sfe` publishes every source field as SFE. Begin/end classes and
peak ratio/time use the appended fields. A null peak ratio remains NaN; a null
ratio time remains absent. `EVENT_ID` retains the source satellite and
`time_tag` as `<satellite>/<time_tag>`; `PLATFORM` also retains the satellite.

## Sources and records

The base URL is `https://services.swpc.noaa.gov/`.

| Source | Record | Mapping |
| --- | --- | --- |
| `json/rtsw/rtsw_mag_1m.json` | SWS | Bt, XYZ GSE/GSM, phi/theta GSE/GSM; platform, active, quality, counts and all flags |
| `json/rtsw/rtsw_wind_1m.json` | SWS | Proton/alpha speed, density, temperature and XYZ velocities; all flags/counts |
| `json/rtsw/rtsw_ephemerides_1h.json` | SWS | Position/velocity components in the source's GCI/GSE/GSM frames, cadence and active |
| `products/geospace/propagated-solar-wind-1-hour.json` | SWS | Speed, density, temperature, IMF and velocity components, original and arrival epochs |
| `json/planetary_k_index_1m.json` | SWS | Estimated Kp; `kp_index` and exact categorical `kp` tokens retained as flags |
| `products/noaa-planetary-k-index-forecast.json` | SWS | Kp, per-sample observed/estimated/predicted status and NOAA G scale |
| `json/goes/primary/xrays-7-day.json` | SWS | Corrected/observed flux per band/satellite; electron correction and contamination flags |
| `json/goes/primary/integral-protons-7-day.json` | SWS | Integral flux per energy/satellite; S scale for the >=10 MeV channel |
| `json/goes/primary/integral-electrons-7-day.json` | SWS | Integral flux per energy/satellite |
| `products/alerts.json` | SWA | Product, issue time, complete message; parsed code, serial/reference, message kind, explicit times and NOAA scale |
| `json/goes/primary/xray-flares-7-day.json` | SFE | Event identity, satellite, begin/peak/end times and classes, peak flux, fluence, peak ratio/time |

`plan_sws` emits nine GET requests; `parse_sws` accepts exactly one complete
200 response for each URL. `plan_swa`/`parse_swa` handle alerts, and `plan_sfe`/`parse_sfe` handle flares separately.
All six methods accept an optional `config` port containing a `ModuleConfig`
(MCFG) FlatBuffer. The source contracts currently have no configurable settings:
an empty config is accepted, while nonempty, malformed or duplicate configs
are refused before any output. JSON settings are never read.

Requests have a 90-second timeout and 16 MiB body limit. Explicit validators
request full bodies. Failed, duplicate, missing or malformed responses refuse
the batch before output; a partial batch cannot replace a complete lane.

Each SWS record holds one quantity, platform, energy channel and UTC day.
Epochs are stably sorted; repeated epochs retain every source sample in source order. Values retain binary64 precision;
null measurements and numeric flags become NaN, including all-null columns.
Flags are flag-major. Nullable counts/quality remain in flags even when their
integer convenience columns cannot represent null. Categorical `kp` tokens use
one-hot flag columns named `kp=<verbatim token>`.

Quantities absent from the SWS enum (ephemerides and alpha velocity components)
use Unspecified with their original quantity name and units. GCI/GSE/GSM names
are retained in RFM; no frame conversion occurs. The propagated IMF frame is
not declared by the feed, so it remains absent. Sample-time convention and
forecast issue time remain unspecified because these products do not state
them. No spacecraft identity is inferred from the `SOLAR1` token.

S levels are computed in WASM from >=10 MeV proton flux thresholds 10, 100,
1,000, 10,000 and 100,000 pfu, per
https://www.spaceweather.gov/noaa-scales-explanation. Measurement values are
never recomputed. Every record has public-domain PVN attribution, source URL,
SHA-256, raw CIDv1 identity and retrieval time. The raw CID identifies source
bytes; it does not imply that the source document has been pinned.

All three lanes use provider `space-weather`, source `noaa-swpc-rt`, with schemas
`SWS.fbs`, `SWA.fbs` and `SFE.fbs`. Each schema reconciles its complete source batch.

## Build and verify

From this directory:

```sh
npm ci
node build.mjs --unsigned
node --test tests/sdk_compat.test.mjs
node tests/config.test.mjs
```

From modules root:

```sh
npm ci --prefix flows/swpc-realtime
node flows/swpc-realtime/build.mjs --unsigned
node flows/swpc-realtime/build.mjs --unsigned --fixtures
SDN_NODE_BINARY=/absolute/path/to/current/spacedatanetwork node data-source/swpc-realtime/tests/swpc-realtime.e2e.mjs
```

The E2E can build the replay flow when absent. The binary must embed SDS 1.274.0
(SDN 50eea40d5 or later). A lane-local test binary in `tests/bin/` is also
accepted. The production module and flow build require explicit `--unsigned`;
owner signing and host-02 installation remain owner-run. The test signs only
its replay artifact using the isolated node's fresh key.

The replay adapter replaces only the HTTP boundary with captured responses.
The native scheduled flow runs the production planner, parser and storage
connector, auto-publishes signed SWS/SWA/SFE lanes, and reads their manifests and
shards by CID. The E2E also publishes and reads each standalone record by CID.
An independent reader checks every source field, quantity, timestamp, flag,
platform, channel and unit with zero numerical tolerance. It prints counts
and exits 0 PASS or 1 FAIL. Flares are mandatory acceptance criteria: all twelve
source fields are checked after standalone-record and signed-lane CID readback,
including both null and non-null peak ratios in the captured fixture.

`tests/capture.py` retrieves real documents and retains verbatim selected JSON
elements. `tests/fixtures/provenance.json` records URLs, fetch times, full and
trimmed hashes and original row indices. No expected measurement is generated
by the producer. The fixtures cover spacecraft, energy channels, Kp statuses,
nulls and multiple days. Native node state uses unique directories and ports;
cleanup signals only the child processes started by the test. A closed
loopback bootstrap address prevents the node's empty-list public fallback.
