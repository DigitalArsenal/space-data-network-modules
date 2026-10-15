# celestrak-supgp — CelesTrak SupGP multi-provider supplemental-OMM data source (A2.9)

**Owner directive:** *"we should have more providers than this."* This ONE
generic, token-parameterized adapter grows the catalog's honest coverage for the
A2.1 providers whose **raw operator ephemeris is NOT public**, by ingesting
CelesTrak's **published Supplemental GP (SupGP)** OMM sets and re-emitting each
object as a schema-exact SDS OMM record — clearly labeled **non-independent**.

It does **not** duplicate the Tier-1 adapters (which ingest operator-raw or
our-fit lanes). It fills the gap for Tier-2 providers where a hard OD parity gate
is impossible without owner-gated data access.

## What it does (typed contracts 1.0: FlatBuffers only)

Two flow nodes; the flow fetches, stores and publishes, the module performs no I/O
(its one hostcall is `plugin.getConfig`, one ModuleConfig read in place):

- **`request`** — the flow's TimerTick (`TICK`) → one GET `HttpRequest` (`HREQ`)
  per SOURCE token of the registry, for `hostcap/http-request`:

  ```
  GET https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=<token>&FORMAT=JSON
  ```

  Each request's `CONTEXT` is the parse job, ONE size-prefixed SDS `$ICN` record
  (CONNECTOR_ID `celestrak-supgp-<token>`, DATASET_ID `supgp-<token>`, SOURCE_NAME
  the provider's source name, PROVIDER_ID, ENDPOINT_URL, CelesTrak origin and usage
  terms), echoed by `hostcap/http-request` in its `HttpResponse`.
- **`parse`** — one `HttpResponse` (`HRSP`) → that token's batch for
  `hostcap/storage-ingest`: an `IngestRequest` on `omm_meta` (SCHEMA `OMM.fbs`,
  SOURCE_NAME the provider's, BATCH_ID sha256 of the body, archive
  `celestrak/celestrak_supgp_<token>.<json|csv>`, provenance with the token, format
  and `CelesTrak SupGP` as attributes), the size-prefixed `$OMM` stream on
  `omm_records`, the response itself on `raw`. HTTP 304 is a FlowNotice Unchanged
  on `unchanged`; a transport error, another status or a body without a valid
  object is a FlowNotice Missing on `status`. JSON or CSV is detected from the body.

Signing and publication (the legacy `keyslot.sign` + PNM on
`sdn/data-source/<sourceName>`) are the flow's publication step, not this module's.

## The registry (final, with live/dead evidence)

Verified 2026-07-13 via the read-only host proxy (full probe log:
`test/fixtures/PROVENANCE.md`). URL pattern `…/sup-gp.php?SOURCE=<token>&FORMAT=JSON`.

| Token | SourceName | Cadence | Probe | Objects |
|-------|-----------|---------|-------|---------|
| `SES-E` | `ses` | 2h | 200 LIVE | 68 |
| `Planet` | `planet` | 2h | 200 LIVE | 109 |
| `Iridium` | `iridium` | 2h | 200 LIVE | 80 |
| `Telesat` | `telesat` | 2h | 200 LIVE | 15 |
| `Kuiper-E` | `kuiper` | 2h | 200 LIVE | 393 |
| `AST` | `ast-spacemobile` | 2h | 200 LIVE | 10 (DATA_SOURCE = `AST-E`) |
| `CSS-E` | `css` | 2h | 200 LIVE | 28 (1 object, 28 segments, NORAD 48274) |

~676 unique objects of new honest coverage. **Kuiper-E is LIVE on CelesTrak SupGP**
(A2.1 had it as "Amazon shares via Space-Track only" — CelesTrak publishes a
393-object SupGP set for it, so we ingest it directly here).

**Re-probed transient tokens (A2.1 "uncertain"):**

| Token | Probe (2026-07-13) | Verdict |
|-------|--------------------|---------|
| `GPS-E` | 404 JSON **and** CSV ("No SupGP data found") | DEAD on sup-gp.php — see GPS-E note below |
| `EUMETSAT-E` | 404 JSON | DEAD |
| `Orbcomm-TLE` | 404 JSON | DEAD |
| `Intelsat-E`, `SES-11P`, `METEOSAT-SV` | not re-probed (12-request budget) | A2.1 status carried (uncertain/transient) |

The registry is **overridable at invoke** (see below); dead tokens are simply not
in the built-in table.

## Honesty model (critical)

These are **CelesTrak-FITTED SGP4 mean elements**, NOT our OD and NOT the
operator's raw product. Every record is marked non-independent so synthesis and
the status board keep them in their own lane and they **never count as "our OD":**

- **SourceTags.SOURCE_NAME** (the IngestRequest's tags) = the provider's source
  name (distinct per provider, and distinct from every Tier-1 adapter's). This is
  the classifier / grouping key.
- Each `$OMM` carries CCSDS USER_DEFINED parameters (`USER_DEFINED_PARAMETERS`):
  `SDN_SOURCE_NAME = <sourceName>`, `SDN_DATA_SOURCE = "CelesTrak SupGP"`,
  `SDN_INDEPENDENT = "false"` (the NON-INDEPENDENT flag),
  `SDN_CELESTRAK_DATA_SOURCE` (CelesTrak's own token, e.g. `AST-E`) and
  `SDN_CELESTRAK_RMS` (CelesTrak's fit residual).
- The `COMMENT` states the same in prose (its lines joined by a line feed).
- `RMS` and `DATA_SOURCE` are **not** part of the canonical SDS OMM schema, so
  they live only under `USER_DEFINED`, never as bare record fields.
- Frame/time are declared honestly: SupGP OMMs are SGP4 GP records by
  construction → `REFERENCE_FRAME = TEME`, `TIME_SYSTEM = UTC`,
  `MEAN_ELEMENT_THEORY = SGP4`, `CENTER_NAME = EARTH`. Element values are copied
  faithfully to full double precision (both JSON and CSV paths agree); EPOCH is
  kept as the feed writes it.

### catalog-synthesis config entry needed (DATA, not code — owned elsewhere)

`analysis/catalog-synthesis` today has only two source classes (`OursFit`,
`SpacetrackGp`) and privileges exactly one gate level (`hard-pass`). A record whose
SourceName is not in `spacetrackSourceNames` is classified `OursFit`, but **any
gate level other than `hard-pass` means it can never outrank Space-Track GP**. So
these SupGP providers must be added to
`analysis/catalog-synthesis/config/provider-gate-status.json` under `"providers"`
at a NON-`hard-pass` level:

```jsonc
"ses": "non-independent",
"planet": "non-independent",
"iridium": "non-independent",
"telesat": "non-independent",
"kuiper": "non-independent",
"ast-spacemobile": "non-independent",
"css": "non-independent"
```

Because `decide()` only special-cases `hard-pass` (every other string is treated
as "never outranks"), a new `"non-independent"` level needs **zero code change** —
it is published, kept when sole-source, and never outranks Space-Track GP, and it
surfaces distinctly in the catalog's gate status / the board. Using
the existing `"blocked"` for all seven has the identical runtime effect if a new
level string is not wanted. (If left out entirely, `defaultLevelForUnlistedProvider
= "interim"` also never outranks — but an explicit entry is the honest, auditable
choice.)

**Recommended follow-up (code, in catalog-synthesis's lock):** add a third
`SourceKind` (e.g. `CelestrakSupGp`) driven by a new `celestrakSupgpSourceNames`
list (mirroring `spacetrackSourceNames`) = the seven tokens above, so the summary
counts them as their own class rather than folding them under `OursFit`.

## GPS-E scout finding (task 4)

`GPS-E (GPS Ephemeris)` is documented on the queries page as a state-vector
product (the path to a real GPS OD hard gate), but on `sup-gp.php` it returns
**404 "No SupGP data found" in BOTH JSON and CSV** (probes #9/#10). `sup-gp.php`
serves OMM mean elements only, so a genuine state-vector GPS ephemeris would not
live there — it would be an OEM-class product at a different endpoint. No fixture
or format could be captured. Full analysis + the follow-up plan:
`docs/gps-ephemeris-scout.md`.

## Node config (plugin.getConfig)

```jsonc
{ "token": "SES-E", "sourceName": "ses" }   // registry becomes JUST this token (sourceName defaults to its lower case)
{ "format": "CSV" }                          // fetch format for all tokens (JSON default)
{ "baseUrl": "https://…/sup-gp.php" }        // override the endpoint base
{ "sourceUrl": "https://…" }                 // full URL override (single-token)
{ "objectCap": 25 }                          // per-token record cap (default 2000)
{ "providerId": "…", "license": "…", "licenseUrl": "…", "citation": "…" }  // the job's tags
```

Default per-token cap is 2000 (covers Kuiper-E's 393 with headroom).

## Politeness

`analysis/conjunction-assessment/scripts/CELESTRAK_FETCH_POLICY.md` semantics: one
query per token per cycle (the registry is de-duplicated); the flow's trigger sets
the cadence (**2h**: SupGP refreshes every 2h — "no need to check more often").
The legacy in-module loop HALTED the remaining tokens on a non-200; the typed
requests go out together and a failed token is a FlowNotice Missing of its own.

## Build & test

```
SPACE_DATA_STANDARDS_ROOT=<spacedatastandards.org tree> node build.mjs   # default: node_modules/spacedatastandards.org
node --test test/*.test.mjs
```

Builds on the SDK compiler (`dist/isomorphic/module.wasm`, `dist/guest-link/`).
The tests run that artifact in the SDK browser harness: the request jobs, every
registry fixture parsed into `$OMM` with the feed's values, JSON = CSV, objectCap,
304 / non-200 / transport error / no records / missing job, surplus frames.
