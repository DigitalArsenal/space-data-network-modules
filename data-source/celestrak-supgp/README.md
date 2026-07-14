# celestrak-supgp — CelesTrak SupGP multi-provider supplemental-OMM data source (A2.9)

**Owner directive:** *"we should have more providers than this."* This ONE
generic, token-parameterized adapter grows the catalog's honest coverage for the
A2.1 providers whose **raw operator ephemeris is NOT public**, by ingesting
CelesTrak's **published Supplemental GP (SupGP)** OMM sets and re-emitting each
object as a schema-exact SDS OMM record — clearly labeled **non-independent**.

It does **not** duplicate the Tier-1 adapters (which ingest operator-raw or
our-fit lanes). It fills the gap for Tier-2 providers where a hard OD parity gate
is impossible without owner-gated data access.

## What it does

On a `pull` (2h timer, or manual invoke) it iterates a data-driven SOURCE-token
registry and, per token, issues **one** query:

```
GET https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=<token>&FORMAT=JSON
```

parses the CCSDS OMM set (JSON array; CSV auto-detected and parsed as a fallback),
and for each object: builds a schema-exact SDS **OMM** record → `storage.ingest_
with_source` (SourceTags) → `keyslot.sign(CID)` → schema-exact **PNM** →
`pubsub.publish` on the provider's own channel `sdn/data-source/<sourceName>`.
Built on the shared `common/provider_source.hpp` template.

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

- **SourceTags.SourceName** = the provider registry token (distinct per provider,
  and distinct from every Tier-1 adapter's SourceName). This is the classifier /
  grouping / PNM-topic key.
- Record body carries flat `USER_DEFINED_*` markers:
  `USER_DEFINED_SDN_DATA_SOURCE = "CelesTrak SupGP"`,
  `USER_DEFINED_SDN_INDEPENDENT = "false"` (the NON-INDEPENDENT flag),
  `USER_DEFINED_SDN_SOURCE_NAME = <sourceName>` (synthesis fallback key),
  plus `USER_DEFINED_SDN_CELESTRAK_DATA_SOURCE` (CelesTrak's own token, e.g.
  `AST-E`) and `USER_DEFINED_SDN_CELESTRAK_RMS` (CelesTrak's fit residual).
- A CCSDS `COMMENT` array states the same in prose.
- `RMS` and `DATA_SOURCE` are **not** part of the canonical SDS OMM schema, so
  they live only under `USER_DEFINED`, never as bare record fields.
- Frame/time are declared honestly: SupGP OMMs are SGP4 GP records by
  construction → `REFERENCE_FRAME = TEME`, `TIME_SYSTEM = UTC`,
  `MEAN_ELEMENT_THEORY = SGP4`, `CENTER_NAME = EARTH`. Element values are copied
  faithfully to full double precision (both JSON and CSV paths agree).

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
surfaces distinctly in `USER_DEFINED_SDN_CATALOG_GATE_STATUS` / the board. Using
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

## Invoke overrides

```jsonc
{ "token": "SES-E", "sourceName": "ses" }   // registry becomes JUST this token
{ "format": "CSV" }                          // fetch format for all tokens (JSON default)
{ "baseUrl": "https://…/sup-gp.php" }        // override the endpoint base
{ "sourceUrl": "https://…" }                 // full URL override (single-token)
{ "objectCap": 25 }                          // per-token emit cap (D4/A2.6 blast radius)
```

Default per-token cap is 2000 (covers Kuiper-E's 393 with headroom).

## Politeness

`analysis/conjunction-assessment/scripts/CELESTRAK_FETCH_POLICY.md` semantics: one
query per token per cycle; default cadence **2h** (SupGP refreshes every 2h — "no
need to check more often"); the registry is de-duplicated (a token is never
re-fetched within a cycle); and the cycle **HALTS on any non-200** (CelesTrak's
M2M rule) — tokens already processed keep their records, remaining tokens are not
queried. Prod runs on the celestrak node (reachable); tests are fixture-driven.

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
node --test test/*.test.mjs
```

Outputs `dist/celestrak-supgp.wasm` (signed) + `dist/isomorphic/module.wasm`
(loadable). Suite: 12 pass / 0 fail (ABI, signed artifact, manifest+caps,
2h-cadence timer, 7-provider default registry, single-token JSON, AST
token/DATA_SOURCE/SourceName distinction, CSS-E multi-segment distinct FILE_IDs,
CSV fallback, halt-on-non-200, fail-closed on non-OMM 200).
