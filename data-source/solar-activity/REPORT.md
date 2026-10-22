# Solar activity — implementation gate and live evidence

Status: BLOCKED; production records stopped pending SDS oracle.
Branch: `task/solar-activity-data-sources-20261022`.
Recovered work and schema proposal committed and pushed first as
`d37b67a9` on resumption. The earlier Git sandbox restriction is resolved.
The coordinator routes the proposal to the SDS oracle; this lane files nothing.
At the 17:16Z resumption the worktree was clean and origin matched `d62b1eeb`.
The cadence/latency separation was committed and pushed as `1602bb29`.
Docker/Desktop must never be started; the owner waived that parity leg on
2026-10-22. Browser and native WasmEdge checks still require an approved module.

Resumed source parsing now preserves all 222 region rows, 78 GOES rows, and
700 edited-event rows in the retained capture, including 12 flagged location
tokens, absent peak/flux/region fields, qualified event times, all event types,
observer-specific rows, and revisions. It does not associate GOES flares with
regions by time proximity. Strict calendar, SRS, and WCS validation rejects
malformed or ambiguous inputs. These are test-only source parsers pending the
approved C++/WASM wire contract, not production SDS records.

## Schema fit check

The supplied nested SDS path does not exist. The canonical checkout has the
IDL at `repos/main-packages/spacedatastandards.org/schema/` instead.
Inspected checkout: `2c1f01ddceda11b2f538c80e33d8fa1a3fcb813e`, package version
`1.251.0+1792119709545`. This repository currently pins SDS `1.220.0`.
No solar package pin or new record type has been added.

Preliminary result: no complete typed fit found; **this is not a THEMIS verdict**.
The owner instructed: if no schema fits, propose it in this report and stop that
part. The following candidates were checked against the canonical IDL:

| Candidate | Fit and missing semantics |
| --- | --- |
| SPW | `schema/SPW/main.fbs:22`, `:93`, `:96`: daily geomagnetic/F10.7/sunspot-number indices; no individual NOAA regions, locations, classes, event intervals, or imagery WCS. |
| SEO | `schema/SEO/main.fbs:70`, `:72`, `:92`: environment measurements; LAT/LON describe the observatory, not a region on the Sun. No active-region or GOES event contract. |
| CSO | `schema/CSO/main.fbs:123`, `:140`, `:142`, `:187`: astrophysical sources with ICRS RA/DEC, transient times, and photometry. No solar region identifiers/heliographic coordinates or GOES class contract. |
| SKI | `schema/SKI/main.fbs:14`, `:28`, `:46`, `:70`, `:82`: sky image metadata with ECEF observer position and azimuth/elevation/FOV; no helioprojective FITS WCS or solar observer geometry. |
| SKT | `schema/SKT/main.fbs:50`, `:200`, `:292`: HEALPix celestial tiles; not a native full-disk helioprojective JP2. |
| FIL / PNM | `schema/FIL/main.fbs:66`, `schema/PNM/main.fbs:38`: suitable for carrying/announcing original files; not a typed replacement for the requested scientific records. |

The pin is recorded in both root `package.json` and `package-lock.json`; no
dependencies were installed or upgraded. The fit check uses the newer checked-out
IDL and is submitted for oracle review, not represented as an authoritative LACK
ruling. SDK rules were read from the actual checkout at
`repos/ancillary-packages/space-data-module-sdk/`.

## Proposed schema for THEMIS (not ratified or implemented)

Three logical records are proposed; THEMIS decides whether to add standards or
extend existing ones. Names below are proposals only. No codes, file identifiers,
root types, manifests, generated bindings, or repo-local `.fbs` are assigned.
Unknown values must remain absent (nullable scalars / absent strings), never
default observations of zero. Each record needs source URL, source content CID
and SHA-256, retrieval UTC, source record identity, and citation. Preserve original
source bytes using FIL/PNM rather than a JSON blob in a scientific field.

**SolarRegionObservation**

| Proposed field | Type / meaning |
| --- | --- |
| NOAA_REGION | uint; original reported region number; do not add an inferred cycle prefix. |
| ISSUED_AT_UTC | string; SRS issue instant, distinct from observation time. |
| OBSERVED_DATE | string; original JSON date label when supplied. |
| POSITION_EPOCH_UTC | string; SRS `day/2400Z` normalized to next-day midnight. Do not assign an unstated instant to a JSON date. |
| SECTION | enum: Sunspots / HAlphaPlage; distinguishes SRS I and IA. |
| SOURCE_LOCATION | string; original N/S/E/W position token. |
| HELIOGRAPHIC_LATITUDE_DEG | nullable double; north positive. |
| STONYHURST_LONGITUDE_DEG | nullable double; west positive, east negative, with Earth-centered observer convention explicitly documented by the oracle. NOAA JSON `longitude` has the opposite sign in the captured rows; any conversion belongs in WASM. |
| CARRINGTON_LONGITUDE_DEG | nullable double; reported Lo in degrees, no inferred rotation. |
| AREA_MICROHEMISPHERES | nullable double; corrected area in millionths of the solar hemisphere. |
| MCINTOSH_CLASS / MAGNETIC_CLASS | strings; preserve the source spelling, with any normalized enum separately defined by SDS. |
| LONGITUDINAL_EXTENT_DEG / SPOT_COUNT | nullable double / uint; preserve absence for plages. |

Use SRS as the positional/morphology authority for the SRS-issued snapshot.
JSON updates are separate revisions with their own provenance; do not overwrite
SRS area/class or propagate positions to a later epoch without a separate model.

**SolarEventObservation**

| Proposed field | Type / meaning |
| --- | --- |
| SOURCE_EVENT_ID / PRODUCT / OBSERVATORY | strings; stable source identity, product, and observer. Edited-event `bin`, `obsid`, type, time, and observatory must not be collapsed across observers. |
| EVENT_TYPE | source string or ratified enum covering at least XRA and FLA; other edited event types must be preserved or explicitly filtered. |
| BEGIN_UTC / PEAK_UTC / END_UTC | nullable strings; source UTC instants, retaining incomplete/qualified times rather than inventing endpoints. |
| BEGIN_QUALITY / PEAK_QUALITY / END_QUALITY | nullable source quality strings. |
| GOES_CLASS | nullable string; X-ray class such as C1.4; optical importance SF is a distinct field, not a GOES class. |
| OPTICAL_IMPORTANCE | nullable string; optical event class. |
| PEAK_FLUX_W_M2 / FLUENCE_J_M2 | nullable doubles; GOES long-channel values with the passband separately specified. |
| PASSBAND / SATELLITE | source string / nullable uint. |
| NOAA_REGION | nullable uint; only an explicit upstream association. |
| STATUS_CODE / STATUS_TEXT / CHANGE_FLAG | nullable source values for revisions. |

The captured GOES product has **0/78** rows with a `region` field. Do not infer
one from time proximity. Edited events provide explicit region associations and
multiple observatories; the eight current-day rows are not eight unique flares.
Joining the products requires a separately justified association rule.

**SolarDiskImageObservation**

| Proposed field | Type / meaning |
| --- | --- |
| OBSERVATORY / INSTRUMENT / MEASUREMENT | strings; SDO, HMI continuum or AIA passband; do not relabel continuum as Ic_flat without source evidence. |
| SOURCE_ID / IMAGE_ID | original Helioviewer identities. |
| REQUESTED_AT_UTC / OBSERVED_AT_UTC | strings; desired epoch and actual DATE-OBS, never retrieval time substituted for observation. |
| DATE_OBS_RAW / TIME_SCALE | strings; retain the original header value and its declared/interpreted scale. T_OBS/T_REC marked TAI are distinct. |
| SOURCE_CADENCE_S / ACQUISITION_INTERVAL_S | nullable doubles; native published cadence and host sampling interval are different quantities. |
| IMAGE_CID / HEADER_CID / MIME_TYPE / BYTE_LENGTH | content addresses, image/jp2 or FITS media type, uint64 byte count. |
| WIDTH / HEIGHT | uint; native image dimensions. |
| CTYPE1 / CTYPE2 / CUNIT1 / CUNIT2 | strings; preserve FITS helioprojective projection and units. |
| CRPIX1 / CRPIX2 | doubles; FITS one-based reference pixels, not zero-based texture coordinates. |
| CRVAL1 / CRVAL2 / CDELT1 / CDELT2 | doubles; world-coordinate values and scales in the stated CUNITs. |
| CROTA2 or PC/CD matrix | optional typed orientation representation, preserving the source's convention. |
| RSUN_OBS_ARCSEC | nullable double; observed angular radius. |
| DSUN_OBS_M | nullable double; observer distance. |
| CRLN_OBS_DEG / CRLT_OBS_DEG / HGLN_OBS_DEG | nullable doubles; Carrington observer longitude/latitude and supplied Stonyhurst observer longitude. |
| QUALITY / CONTENT / PROCESSING_DESCRIPTION | source values; retain quality flags and browse-processing identity. |

Rendering/rotation transformations are outside this source qualification and
must run in the eventual WASM consumer. Helioviewer's DB `scale` differs from
FITS `CDELT1` in the captured HMI response; do not substitute the former for WCS.

## Live-source findings (2026-10-22 UTC)

All four specified NOAA URLs and Helioviewer `getDataSources` returned HTTP 200.
The SRS issued 2026-10-22 00:30 UTC explicitly gives positions valid at
2026-10-21 24:00 UTC. Joining it to JSON `observed_date=2026-10-22` is wrong:
the JSON already contains later positions. The JSON rows for October 21 have
matching position strings and Carrington longitudes for the seven SRS regions.
Other fields differ (e.g. region 4560 area/class); the SRS must remain an
independent authority, with issue and observation times distinguished.

The live catalog identifies HMI continuum as source 18 and AIA 171/193/304 as
10/11/13. The final capture ran **16:05:25.912–16:05:28.298 UTC**, at a fixed
15-minute acquisition target of **16:00:00 UTC**. All **17** downloads returned
HTTP 200. [Provenance](tests/evidence/2026-10-22-ts940s/provenance.json) contains
the exact URLs, retrieval times, lengths, and SHA-256 hashes. Original JSON,
SRS, XML, and JP2 bytes are retained in separate source directories.

| Product | Total source rows | Rows beginning/observed today |
| --- | ---: | ---: |
| Solar regions | 222 | 7 |
| GOES flares | 78 | 7 |
| Edited events | 700 | 8 (multiple observers; not a unique-event count) |

| Image | DATE-OBS UTC | Offset from 16:00 target, seconds | Bytes |
| --- | --- | ---: | ---: |
| HMI continuum | 13:36:28.100 | -8611.900 | 1,053,786 |
| AIA 171 | 15:31:33.351 | -1706.649 | 1,077,960 |
| AIA 193 | 15:27:28.843 | -1951.157 | 1,078,098 |
| AIA 304 | 15:28:17.138 | -1902.862 | 1,077,796 |

All four are 4096×4096 and have the requested WCS/solar observer fields. Each
embedded JP2 header matches the selected image's API header; DATE-OBS matches
the database time within its one-second precision. HMI declares CADENCE=45 s
and fails that bound. AIA does not declare CADENCE in these headers, so its
source-cadence verdict was **unverified** in this initial capture; the
resumed qualification below supplies the published feed cadence. **0/4** images meet even
the separate 900-second acquisition-interval bound. Current-day data alone
does not prove current-cadence freshness. The resumed qualification probes JSOC availability below.

## Resumed image qualification (2026-10-22 UTC)

The [Helioviewer user guide](https://helioviewer-project.github.io/user_guide/)
states a **36-second browse-feed cadence** for AIA 171/193/304, from native
12-second observations; HMI is supplied at its source production cadence
(**45 seconds** in these headers). This resolves the missing AIA cadence
without inserting an invented FITS keyword. The guide documents SDO delivery
latency separately from cadence. Its original HTML is retained with a hash.

The new [capture](tests/evidence/2026-10-22-freshness-R5Cpu0/provenance.json)
contains 27 HTTP-200 responses and two failed JSOC HTTPS probes. All eight
JP2s match their corresponding API headers, are current-day 4096×4096 images,
and retain WCS and observer geometry. The diagnostic selected its fixed
three-hour backfill offset before fetching; it does not change the E2E's
current acquisition target.

| Image | Current DATE-OBS UTC | Offset from 17:15 UTC, s | Backfill DATE-OBS UTC | Offset from 14:15 UTC, s |
| --- | --- | ---: | --- | ---: |
| HMI continuum | 14:21:28.100 | -10411.900 | 14:14:43.100 | -16.900 |
| AIA 171 | 16:49:09.348 | -1550.652 | 14:14:45.349 | -14.651 |
| AIA 193 | 16:46:40.843 | -1699.157 | 14:15:16.843 | +16.843 |
| AIA 304 | 16:47:29.128 | -1650.872 | 14:15:05.129 | +5.129 |

**0/4** current-slot images meet their source cadence or the 900-second
acquisition interval. **4/4** backfill images meet source cadence at the
explicit 14:15 UTC target. This demonstrates same-day historical retrieval,
not a fresh view at 17:15 UTC. No latency allowance is silently substituted
for the cadence requirement. The `getStatus` response is retained as service
context; its representative AIA 94 / HMI magnetogram times are not timestamps
for these requested channels.

Both `https://jsoc.stanford.edu/` and the read-only latest HMI continuum
`jsoc_info` query failed with `ERR_SSL_UNSUPPORTED_PROTOCOL` before an HTTP
response. No HTTP status, FITS data, or JSOC fallback success is claimed.
The probe did not bypass TLS, register an account, or submit an export job.

## Final committed-code E2E rerun

On commit `4ad0f4a1`, the updated E2E captured live sources at
**2026-10-22 17:27:19.695–17:27:22.973 UTC** and exited **2 (BLOCKED_SCHEMA)**.
The [final capture](tests/evidence/2026-10-22-AfCFXB/summary.json) retains
18 HTTP-200 responses. Positions remain **7/7 exact**. Source totals are
222 region rows, 78 GOES rows, and 697 edited-event rows; current-day counts
are 7 / 7 / 8, respectively. The edited-event feed changed since the initial
700-row capture; both original revisions are preserved.

At the unchanged 17:15 UTC target, the latest HMI/AIA 171/193/304 offsets were
**-10411.900 / -866.650 / -799.158 / -714.872 seconds**. All four images are
current-day; **0/4** meet the 45/36-second source-cadence bounds; **3/4** meet
the separate 900-second acquisition interval. The earlier backfill diagnostic
still establishes 4/4 cadence matches at its explicitly delayed epoch.
The raw CID round-trip below covers the first two capture directories (44
source files); the final capture's 18 responses were not part of that earlier
transport run.

## Acceptance measurements and commands

| Acceptance line | Measured result |
| --- | --- |
| Current-day records published locally and read back by CID | **Not met for typed records:** 0 solar records published/read back. Separately, 44 original source files stored on a real local SDN node and read back by CID byte-for-byte; no typed record or PNM announcement is claimed. |
| Active-region positions match same day's SRS exactly | **Source check only:** 7/7 exact location and Carrington-longitude matches at the SRS-stated epoch; 0/7 if wrongly joined on issue calendar date. Includes 3 sunspot regions and 4 plages. No published records to compare yet. |
| Image timestamps within source cadence | **Not met for current slot:** 4/4 current day, 0/4 within source cadence (HMI 45 s; AIA feed 36 s), 3/4 within 15 minutes in the final rerun. Separate fixed three-hour backfill: 4/4 within source cadence; not current-slot freshness. |

Numerical source checks state source, units, epoch, frame, tolerance, and
rationale in `tests/evidence.test.mjs`. Exact position transcription uses zero
tolerance; no scientific transformation is applied. The image/API timestamp
bound is less than one second because the API truncates subsecond precision.

Commands run:

```sh
node data-source/solar-activity/tests/solar-activity.e2e.mjs
# Exit 2: captures live evidence, then reports the unresolved schema/publication gate.
node --test data-source/solar-activity/tests/*.test.mjs
# 15 tests passed, 0 failed, 0 skipped.
node data-source/solar-activity/tests/image-freshness.mjs
# Exit 0: source-only qualification; 0/4 current, 4/4 backfill cadence matches.
git diff --check
# Exit 0.
```

The source-only command `node data-source/solar-activity/tests/source-evidence.mjs`
captures a new dated evidence directory without claiming module acceptance.
The E2E entry point deliberately cannot report PASS until replaced by actual
approved-record, module-runtime, and local-node publication verification.

## Publication and verification gate

A real local-node harness exists at
`../gaia-octree/tests/lib/provider-node.mjs`. Its mock alternatives are not
publication evidence. Once SDS approves and releases the contract, adapt that
harness to an isolated solar lane, publish the approved binary records and
image bytes, retrieve each advertised CID, verify bytes/hashes and decode the
records, then compare positions to the same SRS issue and image epochs to the
selected cadence. Use the test node's signing API, never read its private key.

No typed-record publication, SDK compatibility, browser/native WasmEdge parity, or gauntlet PASS is
claimed while the schema gate is unresolved. **Gauntlet: not run; receipt path:
none.** The owner's prerequisite (passing E2E on a committed branch) was not met.
The local-node harness exists, so its absence is not used as a publication waiver.
The solar adaptation now exists in `tests/lib/local-node.mjs`: explicit
`SOLAR_NODE_WORK`, random loopback ports, no bootstrap peers/flow execution,
GOMAXPROCS=2, GOMEMLIMIT=1GiB, and exact-child shutdown in `finally`. It uses
the full native SDN daemon's in-process Kubo; no Docker is involved.

The [raw-file receipt](tests/evidence/source-cid-roundtrip.json) records
**44/44** successful add-and-CID-read-back checks (13,584,393 bytes) for the retained NOAA and
Helioviewer source bytes. Each read-back equals the original bytes and SHA-256;
the receipt identifies the native binary by its SHA-256 and records shutdown.
The node reports version 1.1.0. This is raw source storage only, with
publishing/flows disabled, **not** SDS solar records, signed announcements,
a service deployment, or an acceptance PASS. Node state remains in the lane's
durable scratch directory; no private key was read, printed, or committed.

```sh
SDN_NODE_BINARY=<absolute-native-full-node-path> \
SOLAR_NODE_WORK=<absolute-durable-lane-directory> \
node data-source/solar-activity/tests/source-cid-roundtrip.mjs
# PASS_RAW_SOURCE_FILES_ONLY: 44 files, nodeStopped=true.
```

A preliminary `version` probe of the separate edge-relay binary unexpectedly
started its relay (that binary accepts unused positional arguments). It was
terminated by its exact child PID, 65460, before the isolated full-node test;
it supplied no publication evidence.

No heavy builds, browser, Docker, or background worker was started. The
isolated full node and preliminary edge relay have both stopped. The Docker
parity leg is waived, not failed or pending. Source captures are deliverable evidence inside this worktree, not
scratch files under `/tmp`. Schema approval and live-image age remain separate
blockers.

83 added files are confined to `data-source/solar-activity/`: README/report, the E2E
gate, source and image capture scripts, three offline test files, shared
test-only parsers/capture helpers, three dated evidence directories, and a
raw CID read-back receipt. No
production manifest, SDK artifact, schema, or host flow has been introduced.

## Sources and credits

- [SWPC regions](https://services.swpc.noaa.gov/json/solar_regions.json)
- [GOES flares](https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json)
- [Edited events](https://services.swpc.noaa.gov/json/edited_events.json)
- [SRS](https://services.swpc.noaa.gov/text/srs.txt)
- [Helioviewer API](https://api.helioviewer.org/docs/v2/api/index.html)
- [SWPC user guide](https://www.swpc.noaa.gov/sites/default/files/images/u2/Usr_guide.pdf)
- NOAA credit: NOAA/NWS Space Weather Prediction Center; SRS prepared jointly
  by NOAA SWPC and the U.S. Air Force. [NWS data policy](https://www.weather.gov/disclaimer/).
- SDO credit: “Courtesy of NASA/SDO and the AIA, EVE, and HMI science teams.”
  [SDO data rules](https://sdo.gsfc.nasa.gov/data/rules.php). Helioviewer is the
  access service; browse images are not calibrated science products.
