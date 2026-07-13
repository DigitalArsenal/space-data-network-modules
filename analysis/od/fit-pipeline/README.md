# OD Fit Pipeline (App 2 — task A2.3)

Scheduler-driven module that turns stored operator-ephemeris **OEM** records into
SDN-fitted supplemental GP (**SupGP / OMM**) records, per object, per provider.

```
storage.query(schema="OEM")            [consumption lane, cap: storage_query]
   → canonical OEM JSON record          (Starlink compact / ISS verbose)
   → odpipe::oem_record_to_series        (reuse od frame/time machinery)
   → od::fit_sgp4_series                 (REUSE the existing OD fit — no parallel path)
   → schema-exact OMM JSON + provenance COMMENT/lineage
   → storage.write(OMM) → keyslot.sign(CID) → schema-exact PNM
   → pubsub.publish(<provider OMM topic>)          [common/provider_source.hpp]
```

The fitted OMMs are the input to **A2.7** (CelesTrak-replacement catalog
synthesis), so every record carries honest provenance back to its source
ephemeris.

## Reuse, not a fork

The build (`build.mjs`) compiles the pipeline together with the **existing** OD
fit library sources — `sgp4_fitter.cpp` (`od::fit_sgp4_series`,
`elements_to_json`), `meme_parser.cpp` (`od::iso_to_jd`), `frame_transform.cpp`
(`od::eci_j2000_to_teme`), and Vallado `SGP4.cpp`. There is **no** second OD
runtime path: the fit math is byte-for-byte the code the OD `fit` module runs.
The OD `fit` module and its gate suite are untouched by this module (it lives in
a sibling directory and shares source, not artifacts), so the Starlink reference
gate (10/10) and the full OD suite stay green.

## Consumption lane (chosen: `storage.query`)

A cron/timer method receives **no input** (SDN `plugins/manager.go` invokes it
with `nil`; `Input:"none"`), so the pipeline fetches its own inputs via a
host read op. Available guest read ops (all gated by `storage_query`,
implemented in SDN `internal/modulert/caps/storage.go`):

| op | shape | why chosen / not |
|---|---|---|
| **`storage.query`** | indexed lookup `{schema,day,norad_cat_id,entity_id,limit}` → JSON `[]Record` | **chosen** — JSON-native, matches what the adapters `storage.write`; schema-generic (works for `OEM`) |
| `storage.flatsql_query_stream` | arbitrary SQL → **aligned FlatBuffer** stream | rejected for now: returns FlatBuffers, but the adapters write JSON OEM; would need a JSON→FlatBuffer ingest first |
| `storage.flatsql_epoch_stream` | epoch profile → stream | **OMM-only** (hard-coded unified-OMM SQL); no OEM profile exists |

Each `storage.query` `Record` carries `CID`, `Data` (base64 record bytes), and
`SourceTags` (incl. `SourceName`). The pipeline decodes `Data` → canonical OEM
JSON, SHA-256s the consumed record bytes for fit lineage, and groups records by
`SourceTags.SourceName` against the configured provider set.

### OEM record → StateSeries (`src/oem_record_series.hpp`)

The adapters store two first-class SDS OEM representations; the converter handles
both and is the JSON-record analogue of `od::parse_oem` (which reads KVN text):

- **COMPACT** (Starlink): `EPHEMERIS_DATA` flat row-major + `START_TIME` +
  `STEP_SIZE(>0)`; sample `i` epoch = `START_TIME + i·STEP_SIZE` s.
- **VERBOSE** (ISS): `EPHEMERIS_DATA_LINES` of `{EPOCH,X,Y,Z,X_DOT,Y_DOT,Z_DOT}`,
  `STEP_SIZE=0`.

It **reuses** `od::iso_to_jd` and `od::eci_j2000_to_teme` (never reimplements the
frame math) and is **fail-closed** (A2.2a policy): TEME native; EME2000/J2000/GCRF
→ TEME; **UTC only; EARTH only**. Anything else is an honest skip, never a wrong
fit.

## Windowing / fit policy (data-driven)

Per-provider fit config (resolution order: **request payload > `plugin.getConfig`
module config > compiled fallback**), never hardcoded per provider:

- `maxIterations` — reuses the OD max-iteration cap (clamped 1..300 by the fit path).
- `fitWindowSec` — fit span (default 11520 s ≈ 2 LEO orbits).
- `subsample` — 0 = auto (~144 points over the window).
- `convergenceTol`, `requireConverged` (default true — non-converged fits are
  skipped with a reason, never published as OMMs).

## Timers shape (zero Go changes)

Manifest `timers` block `od-fit-pull → fit_pipeline`, default **2 h** (matches
CelesTrak's 2 h SupGP regeneration — no value re-fitting faster than the sources
refresh). SDN derives `CronMethods` from the manifest timers automatically
(`internal/modulert/module.go`: `Input:"none"`, `Output:"json"`); **no Go change
is required** to schedule this module.

## Honest-skip taxonomy

Per object, in the summary `providers[].skipped[]`:

| reason | cause |
|---|---|
| `unsupported-frame:<F>` | non-TEME/EME2000 frame (e.g. GLONASS PZ-90/ITRF ECEF) |
| `unsupported-frame:UNKNOWN` | undecodable "honest shell" (e.g. OneWeb LTEF, A2.2c-1) |
| `unsupported-time-system:<T>` / `unsupported-center:<C>` | non-UTC / non-EARTH |
| `empty-ephemeris` / `ragged-ephemeris` | no / malformed state data |
| `compact-without-step` / `unparseable-start-time` | compact record can't reconstruct epochs |
| `too-few-samples:<n>` | fewer than 8 usable samples |
| `<norad>:fit-not-converged:rms=<r>` | fit did not converge under the provider policy |

Records tagged for a provider not in the config are counted as `unconfigured`
(never fitted under the wrong provider's labels).

## Open gaps (for the coordinator / follow-on tasks)

1. **`storage.query` has no source filter.** Per-provider isolation relies on
   `SourceTags.SourceName`, which the current adapters do **not** set — they write
   via `provider_source.hpp::storage_write` (`{schema,data}` only), not
   `storage.ingest_with_source` (which sets `SourceTags`/`_source`). Until the
   adapters migrate to `ingest_with_source`, only a **single-provider** deployment
   is unambiguous (the pipeline attributes untagged records to the sole provider).
   Fix: adapters → `storage.ingest_with_source`, or add a source-tag-aware read op.
2. **storage.write → storage.query round-trip not verified end-to-end.** The
   A2.2b residual flagged the same `storage.write` vs `ingest_with_source` split;
   the mock-host test proves the pipeline logic against the real record/response
   shapes, but a live daemon round-trip (A2.6) should confirm written OEM records
   are returned by `storage.query`.
3. **Reference-frame coverage.** Providers whose data is not TEME/EME2000
   (GLONASS PZ-90 ECEF, undecoded OneWeb LTEF) are honestly skipped until a
   transform / decode lands upstream (owner-assist items from A2.2c).

## Build & test

```
SDN_LOCAL_EMSDK_DIR=<repo>/licensing/core/deps/emsdk node build.mjs
node --test test/module.test.mjs
```

The test builds the fixture constellation from the OD gate's own reference
fixtures (Starlink MEME → compact OEM, ISS CCSDS OEM → verbose OEM) plus
honest-skip records, drives the rebuilt WASM through a mock `space_data_module_host`
bridge (serving `storage.query`, capturing `storage.write`/`pubsub.publish`,
signing `keyslot.sign`), and asserts per-provider fitted OMMs with schema-exact
keys + provenance and the skip taxonomy.
