# Ephemeris source retrieval

This package implements the 13 anonymous acquisition sources in the exact 17-entry registry of [starlink_downloader](https://github.com/DigitalArsenal/starlink_downloader/blob/1a1caaf9c062d296cc96fd5ef0829f2c412640fa/src/host/sources/index.ts). `sources.json` records that revision, source IDs, provider names, allowed origins and suggested refresh intervals. The four credentialed acquisition adapters belong in the restricted modules repository; a registry entry is not evidence that a credentialed feed is active.

The portable C++ WASM core plans listing requests, discovers file URLs from explicit response frames, checks byte bounds and source-file signatures and emits canonical NCD descriptors. The companion WasmEdge adapter executes the same discovery code through generic HTTP, IPFS and storage capabilities. It never manufactures orbital records. Parsing physical states remains a downstream operation: existing `files/orbit-products` provides validated SP3 and CCSDS OEM interpretation; this package does not change their frames, units or time scales.

| Source ID | Upstream acquisition format |
| --- | --- |
| spacex-starlink | Starlink manifest and MEME files |
| eutelsat-oneweb | OneWeb LTEF CSV |
| planet | Planet states and TLE files |
| iss | NASA ISS CCSDS OEM KVN |
| ses | SES orbital-data page and I11 files |
| intelsat | Intelsat public selector and ECF files |
| telesat | FleetLong index and per-satellite COB CSV |
| css-tiangong | CMSE index and OEM ZIP |
| gps-precise | BKG current/previous GPS-week SP3 gzip |
| glonass-precise | ESA current/previous GPS-week SP3 gzip |
| esa-pod | ESA GNSS, Swarm A and CryoSat SP3 gzip |
| eumetsat | EUMETSAT TLE JavaScript data files (never executed) |
| cpf | ESA latest CPF prediction per target |
| spire | Restricted bearer API, ephemeris and TLE paths |
| space-track | Restricted login/cookie and five registry GP groups |
| vimpel | Restricted login and provider page; no demonstrated orbital export |
| cpf-edc | Restricted EDC prediction listing and CPF download |

## Runtime contract

`com.digitalarsenal.data-source.ephemeris-source` has no host imports. Its methods are `describe_sources`, `plan_source_requests`, `discover_sources`, and `describe_artifact`. JSON ports carry explicit control or foreign-format frames with SDK wildcard justifications; NCD output uses SDS `$NCD`. Direct URL sources need no listing requests and return their resource descriptors immediately. Supply listing responses as a URL-keyed object to `discover_sources`; a 404 GPS-week listing permits previous-week fallback.

`com.digitalarsenal.data-source.ephemeris-source-host` is a standalone SDK module. Its `pull` timer runs every 60 seconds with an optional `request` control frame, and emits `descriptor` / `status`. The host supplies the timer through its existing CronProvider; no flow wrapper is required. Call `configure` with one JSON `request` frame and persist that method input using the host's runtime input settings. On restart the host reapplies `configure` before scheduled retrieval. Configuration never fetches data or reads secrets. Explicit known `plugin.getConfig` options take precedence over saved guest options; absent or null host configuration leaves saved inputs in effect.

Safe configuration fields are:

- `ephemeris_enabled`: false until explicitly activated.
- `ephemeris_source_id`: exact registry ID.
- `ephemeris_max_resources`: 1–64, default 4; count per invocation, not a source truncation limit.
- `ephemeris_max_bytes`: 1 KiB–32 MiB per HTTP body, default 16 MiB. Oversized or truncated responses fail.
- `ephemeris_timeout_ms`: 1–30 seconds, default 15 seconds. CMSE may require 30 seconds.
- `ephemeris_max_runtime_ms`: 1–300 seconds, default 90 seconds, including listing HTTP requests.
- `ephemeris_archive_max_bytes`: cumulative queue/raw pin reservation budget, default 1 GiB, maximum 32 GiB (minimum 1 KiB).
- `ephemeris_refresh_interval_sec`: 1 hour–7 days; registry defaults apply after a completed queue.
- Restricted extensions additionally receive `ephemeris_secret_id` and `ephemeris_spire_paths`; no secret values belong in these fields or published metadata.

The adapter reserves bytes durably in canonical IRM.NOTES before each queue or raw pin. The versioned reservation ledger is cumulative across completed refreshes and restarts; it never uses a hot-window NCD query to infer historical disk use. A failed or repeated pin may conservatively consume another reservation. At the limit the adapter returns `archive-budget-reached` without pinning or advancing the resource cursor. Legacy checkpoints without the ledger fail closed and require explicit operator migration. Before the queue has a CID, an initial position-zero IRM identifies the canonical provider origin; a crash then restarts discovery with another reservation. The adapter pins the immutable credential-free discovery envelope and stores its CID before fetching the first resource. Each successful file is pinned unchanged, described with canonical NCD source CID / byte length / SHA-256, and ingested through `storage.ingest_with_source`. Attribution uses `provider_id=ephemeris-provider:<source_id>`, `source_name=<source_id>`, the actual resource URL, and the actual raw file SHA-256 as its batch ID. The separate discovery job remains in IRM and safe provenance. Duplicate reconciliation accumulates the source and deduplicates retries. Per-resource URL/hash/format/time provenance contains no authentication material. An IRM advances only after raw pin and source ingestion succeed. A recreated runtime restores the same queue; full constellations are never silently shortened to one invocation's cap.

The SDN source publisher signs and announces NCD datasets independently, including catch-up and retry. Configure the opt-in `publishing.auto_publish[].publish_scope: source` host mode to coalesce source changes and publish the accumulated source window: an automatic publisher that suppresses a batch after its first notification or drops later batches inside a rate limit does not cover a multi-file source. Consumers follow NCD.SOURCE_CID to the immutable raw bytes. This module does not invent a raw-only DPM signature protocol or report synchronous PNM delivery. Canonical NCD registration and the existing source publisher must be enabled in the host. A Vimpel HTML page produces `provider-page-only` status and no NCD or raw public pin; it is not an orbital container.

All host calls use the SDK binary envelope. Expected validation, HTTP and storage failures return a structured SDK error and preserve instance reuse; a later invocation resumes from durable IRM. Unexpected internal JSON failures remain fail-closed traps and require instance replacement. Restricted extensions scrub transient credentials with ordinary RAII cleanup on success and error, and a final cleanup hook on an unexpected trap. No username, password, cookie, bearer token or authentication POST body is persisted in queues, NCD, provenance or IRM.

## Build and verification

`npm ci --ignore-scripts`, `npm run build`, `npm test`. Dependencies pin the published SDK 0.8.19 and SDS 1.215.0; canonical generated headers are extracted from the published SDS package. Existing aggregate C++ helpers are read without modification.

`SDN_RUN_EPHEMERIS_PARITY=1 node --test tests/parity.test.mjs` runs real Chrome, native WasmEdge and container WasmEdge on the same portable artifact. `node tests/live.mjs` performs bounded real public HTTP acquisition through the shipped WASM, using isolated IPFS/storage fixtures; its report is not live SDN publication evidence. `SOURCE_IDS=css-tiangong node tests/live.mjs` limits a probe. Native integration fixtures prove exact byte hashes, attribution and queue recovery after ingestion failure, including failure before the first file.

The September 2026 sampled Starlink run discovered 11,134 files and fetched a 2,041,024-byte sample. Multiplication gives about 22.7 GB (21.2 GiB), an estimate rather than a full-queue measurement. Pinned files are not bounded by a Kubo garbage-collection target. The default 1 GiB archive budget intentionally cannot finish this estimated Starlink edition; an explicit 32 GiB budget permits the initial edition but will eventually pause future refreshes. Reservations bound cumulative queue/raw pins, not host metadata or other applications using the same IPFS store. Operators must provide disk reserve; this package does not automatically remove prior editions.


### Large provider directories (0.1.1)

The scheduled adapter requests exact binary HTTP response segments when the host
supports `response_encoding: "binary"`; legacy string responses remain accepted.
The binary path avoids expanding source bytes into JSON or base64 copies. The
ESA CPF directory scanner selects the newest date and numeric sequence per target
in one pass, without a regex backtracking over the complete directory. Response,
archive and resource limits remain unchanged. The native regression covers a
16 MiB listing inside SDN's 64 MiB guest ceiling and the actual ESA directory.
See `tests/reliability-verification.json` for exact candidate hashes and parity
results. A server without the binary response option may still exceed its guest
memory ceiling on very large listings; update the runtime before this rollout.

### Primary object coverage

Version 0.1.5 emits source-scoped CAT records alongside OEM archives when a
complete OEM metadata block declares an international designator. The NASA form
`1998-067-A` is normalized to `1998-067A`. Numeric NORAD/native identifiers are
never substituted for missing designators. Unsupported formats continue to
publish their original NCD archives without claiming object coverage.

`backfill_coverage` reprocesses a required `descriptors` NCD stream supplied
from a source-filtered archive query, without fetching the provider. It never
uses the FlatSQL hot window as a substitute for full history. Its optional
JSON control input accepts `source_id`,
`offset` and `limit` (default/max 4). Each file must match its descriptor's SHA-256
and byte length; a page is capped at 64 MiB. The returned offset permits explicit
paging. This method is not scheduled automatically. Coverage retains the source
provider, immutable CID and hash provenance; it is not an assertion that an
unparsed archive or an incomplete acquisition covers a whole constellation.

Planet TLE streams and EUMETSAT TLE JavaScript assignments also publish the
international designator carried in the element set. Both line checksums and
the line-pair identifier must match. Non-designator placeholders such as
`PLANET` remain unresolved. JavaScript is parsed as literal assignments, never
executed. The two-digit launch year follows the [documented TLE convention](https://celestrak.org/columns/v04n03/),
and the designator comes from [line 1 columns 10–17](https://celestrak.org/norad/documentation/tle-fmt.php).
This validates the pair's structure; it does not use the numeric satellite
catalog field as an object matching key.
