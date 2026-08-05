# Streaming Ephemeris-to-OD Benchmark

**Date:** 2026-07-23  
**Status:** The corrected signed OD child has passed an exhaustive retained
catalog benchmark under one hour and byte-identical browser/WasmEdge/AOT result
parity. Production outer-bundle signing and a reusable-thread defect in the
generic WasmEdge host remain open.

## Workstation

- Mac Studio, Apple M3 Ultra
- 28 CPU cores (20 performance, 8 efficiency)
- 256 GB unified memory
- macOS 26.3.1

No raw ephemeris was written to disk by the catalog benchmarks below. Response
bodies were consumed and released in memory.

## Current full catalog

Command:

```sh
node scripts/benchmark-starlink-catalog.mjs --concurrency 64
```

The live Starlink manifest was 1,198,507 bytes. It contained 16,252 valid
generation entries and selected 10,917 latest stable identities using the same
manifest-order/latest-generation rule as the signed provider.

A 64-way `Range: bytes=0-0` census completed all 10,917 entries with zero
failures:

| Metric | Result |
|---|---:|
| Complete source bytes | 22,133,960,445 B |
| Complete source size | 20.61 GiB |
| Census wall time | 115.441 s |
| File probes/s | 94.568 |

## Direct full-download ceiling

Command:

```sh
node scripts/benchmark-starlink-catalog.mjs --concurrency 64 --download
```

The benchmark streamed and discarded every byte of every selected complete
file. It performed no provider opaque writes, syncs, or deletes.

| Metric | Result |
|---|---:|
| Completed files | 10,917 / 10,917 |
| Downloaded bytes | 22,133,960,445 B |
| Failures | 0 |
| Wall time | 147.579 s |
| Throughput | 149,980,909 B/s |
| Throughput | 1.200 Gbit/s |
| Files/s | 73.974 |

This is the authoritative workstation wire/download baseline: about 2.46
minutes for the current complete catalog. It proves the previous multi-hour
ingestion was not imposed by the Starlink source size or link; durable raw-file
spooling/checkpoint work dominated that implementation.

## Fetch-concurrency sample

The following command downloaded 256 complete files selected evenly across the
entire ordered 10,917-file catalog, including both endpoints:

```sh
for width in 1 2 4 8 16 32; do
  node scripts/benchmark-starlink-catalog.mjs \
    --download --sample 256 --concurrency "$width"
done
```

Every width transferred the same 519,864,349 bytes with zero failures.

| Width | Wall time | Throughput |
|---:|---:|---:|
| 1 | 4.908 s | 105.919 MB/s |
| 2 | 2.026 s | 256.649 MB/s |
| 4 | 1.248 s | 416.406 MB/s |
| 8 | 1.085 s | 479.183 MB/s |
| 16 | 1.089 s | 477.161 MB/s |
| 32 | 1.116 s | 465.924 MB/s |

The short sample benefits from CDN and connection conditions and must not be
linearly substituted for the full run. It does show that four concurrent
complete-file downloads are sufficient to drive this workstation link hard;
64 is useful for hiding whole-catalog tail latency, not because 64 CPU cores
are required.

## Signed streaming provider

The development-signed Starlink child is:

```text
ffb27b6965c9caf4e0e4df516e693390568602a1493cc2203c713a740ccb090b
```

Its 51 focused checks prove complete-file emission from the active bounded
fetch wave, deterministic plan/run/source identities, COMPLETE-only correlated
FlatSQL acknowledgements, highest-contiguous cursor advancement, crash replay,
completed-plan rollover, and zero raw-ephemeris opaque persistence. The only
opaque value is the compact versioned cursor at
`primary/starlink.cursor.v1`.

The direct full-download measurement above is source/network evidence, not a
claim that the browser SDK ran 64 HTTP requests. The browser SDK deliberately
uses the signed guest's sequential `EAGAIN` fallback for a child that imports
the application-blind hostcall surface. Actual bounded parallel guest fetch
remains a WasmEdge acceptance measurement.

## Corrected signed OD acceptance

The accepted development-signed OD child is:

```text
952227b000a57578f0986b652b5ecb8d551b1d160ac9db7db26628863bbcbb7a
```

Its extracted portable WASM payload is
`9ae58c93a7cc4078aea5b5e901492d73b872b04a04990eb8b1be5abe7f0c1b83`.
The frozen 11-translation-unit fit object is
`e1f1baa093cb52ef6fc880e4aa4de958c2bb074b8dac4d7826c50fa540e94ea8`.
An executable provenance gate reconstructed the pinned source revision, applied
the pinned source patch, checked the separately compiled ABI header, and
rebuilt that object byte-for-byte with the recorded wasi-sdk 24 image.

The exhaustive retained-catalog command used the exact signed child, a
16-object fit width, every latest stable identity selected from the local
retained files, and output-inclusive timing through the final zero-input drain
and decoded record validation:

```sh
SDN_OD_REAL_MEME_BENCHMARK=1 \
SDN_OD_REAL_MEME_DIR=/Users/tj/software/starlink_downloader/ephemerides \
SDN_OD_REAL_MEME_WIDTHS=16 \
SDN_OD_REAL_MEME_SAMPLE_COUNT=999999 \
SDN_OD_REAL_MEME_REPETITIONS=1 \
SDN_OD_REAL_MEME_COLLECT_FAILURES=1 \
node --test --test-concurrency=1 \
  --test-name-pattern='^benchmark OD on complete real MEME files sampled across the retained catalog$' \
  tests/od-node.test.mjs
```

| Metric | Result |
|---|---:|
| Current stable catalog objects | 10,581 / 10,581 |
| Complete input bytes | 21,423,356,144 B (19.952 GiB) |
| Failed objects | 0 |
| Pipeline wall time | 2,737.987713 s (45m37.988s) |
| External wall time | 2,738.86 s (45m38.86s) |
| End-to-end throughput | 3.8645 objects/s |
| Fit/drain/validation throughput | 4.0809 objects/s |
| Total test CPU | 27,083.517 s (7.523 CPU-hours) |
| Full-wall average CPU | 9.967 cores |
| Peak RSS | 1,306.156 MiB |
| OMM records | 125,981 |
| OCM records | 125,983 |
| Terminal OCM-only objects | 2 |
| Maximum observed iterations | 60 |
| Maximum accepted RMS | 10.307872 km |
| Full-batch p50 / p95 / p99 | 4.051564 / 5.727383 / 6.682784 s |

The two extra OCMs are intentional terminal reentries: NORAD 46144 and 47587
each emitted exactly one complete-trajectory OCM and no OMM, covariance, or
orbit-determination block. All other 10,579 objects emitted strict OMM/OCM
pairs; eight of them used the complete four-hour fallback. Hash-pinned direct
regressions for NORAD 46535, 46753, 44748, 45668, 46144, and 47587 all passed.
The same signed child also retained the exact-source CelesTrak gate:
`0.241108373 km` SDN RMS versus `0.275328465189 km` for the captured CelesTrak
elements over the same observations.

The benchmark sample digest is
`9c8869ac31122f6d938553a6b189d99372d130fa3e3d867e163b299275b57674`.
The exclusive attempt log is 6,936,963 bytes with SHA-256
`aa062be4a405af6538245ded3f09eb7ae63fdc2be4b92acfb68fed31392f1436`;
the 1,934-byte stdout evidence has SHA-256
`a5e43848781bc74bcf351bfecf7621ae468c63ebb975e6b13ee344e567035ee2`.
An unrelated pre-existing test process consumed one workstation core for the
entire run, so this measurement is conservative.

### Linear CPU capacity boundary

The measured 27,083.517 CPU-seconds establish useful lower bounds without
assuming durable raw-file spooling:

| vCPUs | Optimistic CPU-only lower bound | Conclusion |
|---:|---:|---|
| 4 | 112.85 min | Cannot meet one hour |
| 8 | 56.42 min | No room for scheduling, fetch, FlatSQL, or publication |
| 12 | 37.62 min | Possible only with comparable per-core speed and good scaling |
| 16 | 28.21 min | Measured 45.63 min end to end on this workstation |

The signed node currently admits at most 16 concurrent fit objects, so more
than 16 vCPUs will not accelerate one unsharded flow instance. The practical
starting size is therefore a dedicated 16-vCPU CPU-optimized VM, not a 4-vCPU
VM. The measured OD peak is only 1.31 GiB; 32 GiB leaves ample room for the
independent FlatSQL/runtime stages. The production streaming design deletes
each complete ephemeris after its acknowledged OD/store transaction and
persists only its compact cursor plus OMM/OCM records, so the 19.952 GiB retained
test corpus is benchmark input, not a production durable-spool requirement.

### Browser and WasmEdge result parity

The exact 539,036-byte signed child
`952227b000a57578f0986b652b5ecb8d551b1d160ac9db7db26628863bbcbb7a`
verified as an Ed25519 whole-bundle signature, then yielded the 533,004-byte
portable payload
`9ae58c93a7cc4078aea5b5e901492d73b872b04a04990eb8b1be5abe7f0c1b83`.
WasmEdge 0.14.1 compiled that payload to the explicitly unsigned, sanctioned
AOT derivative
`f6494929a65d5b1c4bc01504e704f813bdfc8e984ba947fadc6826a0c292f099`.
The AOT file is not a replacement for, or an additional signature over, the
signed portable child.

Fresh one-object runs produced byte-identical decoded result streams in the
Node/V8 browser-compatible harness, portable WasmEdge, and WasmEdge AOT:

| NORAD | Case | Browser | Portable WasmEdge | WasmEdge AOT | Records |
|---:|---|---:|---:|---:|---|
| 44748 | normal | 0.895 s | 91.186 s | 2.100 s | 8 OMM + 8 OCM |
| 46753 | four-hour fallback | 3.210 s | 318.142 s | 7.663 s | 14 OMM + 14 OCM |
| 46144 | terminal reentry | 0.048 s | 2.343 s | 0.0566 s | 1 OCM |
| 47587 | terminal reentry | 0.058 s | 3.034 s | 0.0788 s | 1 OCM |

Both terminal records have no OMM, covariance, or orbit-determination block
and retain a finite complete source-state trajectory. These one-object runs
reported zero `wasi.thread-spawn` calls, so they prove artifact/result parity
but do not prove multi-core host throughput.

## Withdrawn OD candidate

The following development-signed OD child is **not** an acceptance candidate:

```text
94fbfbb0219de8c26c29a67e1c78b18aac6f623e3819611e21c42a26a42a1180
```

Its complete-arc/multi-epoch structure and OBD removal passed focused tests,
but the Starlink parser wrapped EME2000/J2000 MEME vectors as TEME instead of
using the existing EME2000-to-TEME transform. A low self-fit RMS cannot detect
that consistently rotated frame. The runtime also lacked aggregate assembly
and pending-queue bounds and did not reject every non-converged or
`RMS >= 12 km` epoch before output.

The original scaling timer stopped after the first invocation fitted a batch;
it drained the remaining per-object output transactions after the timer.
Consequently, the following results are retained only as withdrawn diagnostic
evidence and must not size a deployment:

| Worker bound | Objects/s | Average CPU cores | Projected 10,917-object OD |
|---:|---:|---:|---:|
| 1 | 0.5164 | 1.004 | 352.34 min |
| 2 | 0.8410 | 1.712 | 216.35 min |
| 4 | 1.3535 | 2.896 | 134.43 min |
| 8 | 2.4142 | 5.253 | 75.37 min |
| 16 | 3.9483 | 9.752 | 46.08 min |

The three 128-file 16-worker projections of 43.82, 46.79, and 46.08 minutes are
withdrawn for the same reason. The corrected benchmark must start before the
batch fit and stop only after every output continuation reaches a terminal
drain.

## Withdrawn CelesTrak comparison

The earlier `0.253951679 km` SDN versus `40.8759049689 km` CelesTrak comparison
was computed after treating raw EME2000 observations as TEME. It is invalid and
no advantage is claimed. The corrected scorer must convert the common
observation set to TEME first, recompute both candidates over the exact same
481 states, and report honestly whether SDN wins or loses. CelesTrak's captured
`0.177 km` field is useful warning evidence because the erroneous
40.8759049689 km result is consistent with an unmodeled frame rotation.
The frame correction is grounded in Starlink's official trajectory
documentation
(`https://docs.space-safety.starlink.com/docs/tutorial-basics/trajectories/`)
and the 18th Space Control Squadron Spaceflight Safety Handbook
(`https://www.nasa.gov/wp-content/uploads/2020/03/spaceflight_safety_handbook_for_operators_v1.5_aug201.pdf`):
Modified-ITC/MEME position and velocity are EME2000/J2000, while SGP4 fitting
requires conversion to TEME.

## FlatSQL production-shape measurement

A separate temporary benchmark exercised the exact independently signed
FlatSQL child over 10,917 unique source transactions, with 12 OMM and 12 OCM
records per source:

| Metric | Result |
|---|---:|
| Transactions | 10,917 |
| Records | 262,008 |
| Logical record payload | 141,091,272 B |
| Total invocation input | 339,868,008 B |
| Append wall time | 422.212 s |
| Append average CPU | 1.964 cores |
| Append peak RSS | 3,328,655,360 B |
| Opaque replace/sync calls | 21,834 / 21,835 |
| Allocated persisted bytes | 223,596,544 B |
| Fresh-worker bounded reload | 6.332 s |

The result JSON SHA-256 is
`7f9c15a631997393553ce6082898254a7304657786d900d875350b3fd8d8e203`.
It was measured on macOS arm64/APFS through the SDK worker/browser-WASI
harness, not WasmEdge/Linux. Its repeated payloads came from the withdrawn OD
candidate, so the 7.04-minute FlatSQL cost is production-shape evidence rather
than final-artifact parity. It must be rerun if corrected record counts or
sizes change materially.

## Deployment sizing recommendation and open host gate

The corrected output-inclusive benchmark rejects a four-vCPU deployment and
supports a 16-vCPU starting size. DigitalOcean's CPU-Optimized 16-vCPU plan
provides 32 GiB RAM and 200 GiB SSD for $0.50/hour or $336/month; its dedicated
CPU model fits this sustained batch workload. The Premium Intel variant is
preferred when available because DigitalOcean documents newer Xeon CPUs, NVMe,
and up to 10 Gbit/s network throughput:

- `https://www.digitalocean.com/pricing/droplets`
- `https://www.digitalocean.com/products/droplets/cpu-optimized`

This is a workstation-derived provisioning recommendation, not yet a remote
SLA. One-object browser/WasmEdge/AOT result parity has passed. A production-host
width-16 run is still required, and no slower serial interpreter result may be
substituted for that gate.

The production generic WasmEdge host currently blocks that measurement. Its
neutral four-worker test passed with four distinct operating-system threads,
but a production-shaped reusable-cohort regression completed wave one and
deadlocked as wave two began. The failure reproduced under WasmEdge 0.14.1 at
about four cores of CPU after 90.01 seconds without cost accounting enabled,
which isolates the failure to the generic reusable `wasi.thread-spawn`
shared-memory worker lifecycle rather than Supplemental OMM policy. The
production route is source-reachable from `origin/main`; the deployed binary
revision has not yet been established. No valid width-2 or width-16 production
WasmEdge benchmark exists until that adapter passes repeated worker cohorts.

## Nonconforming production observation

The currently installed historical spool-first artifact is not a candidate
benchmark, but its live counters provide a useful control. At
2026-07-23T12:22:33Z the two-vCPU Premium AMD host had been running that
artifact for 8,969 seconds and reported:

| Metric | Observation |
|---|---:|
| Starlink complete files | 10,917 / 10,917 |
| Starlink source bytes | 22,133,960,445 B |
| OD objects | 49 |
| FlatSQL records | 3,348 |
| Process CPU | 146% |
| Process RSS | 1,454,500 KiB |
| Process high-water RSS | 2,199,724 KiB |
| Process threads | 79 |

This does **not** establish a 149-minute fetch time because the polling
observation occurred after fetch completion. It does establish that completing
the raw catalog is not equivalent to completing catalog OD: the old artifact
had fitted only 49 of 10,917 Starlink objects. Its result must not be used to
size the streaming replacement.

## Acceptance results

- [x] Zero raw-provider opaque write/sync/delete counts, separated from
  permitted compact cursor metadata operations.
- [x] OMM/OCM counts, worst RMS, maximum iterations, and absence of OBD.
- [x] Exhaustive corrected signed-child catalog run below one hour.
- [x] Browser and WasmEdge/AOT execution of byte-identical result streams for
  normal, four-hour-fallback, and terminal cases.
- [ ] Production WasmEdge host width-16 CPU, RSS, FlatSQL, and publication
  timing on the recommended Droplet.
- [ ] Rebuild and release-sign the outer bundle so it embeds the accepted
  Starlink and OD child hashes.

The repository's fail-closed compiler will not compose the two
development-signed children into a new parent. A release-signed outer artifact
therefore remains intentionally unbuilt until the shared release signer is
available. No compiler or publisher policy was weakened to bypass that gate.
The 16-vCPU recommendation can be provisioned for the final measurement, but
release acceptance is not recorded until the remaining host and signing gates
pass.
