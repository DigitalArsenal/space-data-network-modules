# ISS (NASA public OEM) Data Source (A2.2c)

Typed contracts 1.0 (FlatBuffers only, no JSON, no base64). The module fetches and stores nothing itself: it is a
pure request-and-parse node beside `hostcap/http-request`, and its `$OEM` output is consumed in memory by
`analysis/od` (`fit`), never stored, signed or published.

## Flow (`src/iss_source.cpp`)

| Method | In | Out |
| --- | --- | --- |
| `request` | `tick`: `TimerTick` (TICK; fields not read) | `request`: one GET `HttpRequest` (HREQ) for NASA's public ISS ephemeris (CCSDS OEM KVN) |
| `emit` | `response`: the file's `HttpResponse` (HRSP) | `oem`: one $OEM (verbose, explicit epochs, EME2000/UTC/EARTH as declared, NORAD 25544) |

Node config through `plugin.getConfig` (sdm_piv, one `ModuleConfig` read in place; the module's only hostcall):
`sourceUrl`. Capabilities: none. A transport error, a status other than 200, an empty body
or a file with nothing fittable fails closed (`fetch-failed` / `fetch-empty`); nothing partial is emitted. The flow's
trigger sets the cadence (the former module timer's cadence is noted in the manifest).

The former `pull` method (JSON hostcalls; it declared a signed `$PNM` output but only ever returned the in-memory `$OEM`
stream) and the hand-built guest-link (`guest-link/emit_entry.cpp`, `manifest.js`) are gone: the SDK compiler builds the
module and its guest-link object (`dist/guest-link/`). `test/module.test.mjs` runs the methods in the SDK browser harness
on the fixtures and checks the `$OEM` bytes against the legacy artifact's (`test/fixtures/legacy/oem-stream.bin`).

## Schema / frame / time decisions

- **Frame preserved as declared (honest, per A2.2a).** The NASA OEM declares
  `REF_FRAME = EME2000`; the adapter emits `REFERENCE_FRAME: "EME2000"` and does
  **NOT** transform to TEME — the OD side owns the EME2000→TEME transform
  (validated in A2.2a at <1 m fit RMS). `TIME_SYSTEM: "UTC"`, `CENTER_NAME`
  normalized `Earth`→`EARTH`.
- **Real identity.** `OBJECT_NAME: "ISS"`, `OBJECT_ID: "1998-067-A"` (a real
  international designator, unlike Starlink's SpaceX-internal field), and the
  canonical `NORAD_CAT_ID: 25544` (not in the file — constant for the ISS).
- **Verbose OEM format (explicit epochs).** The upstream OEM is **non-uniform**
  in time: mostly 240 s (4-min) steps, but with 58/79/180/223 s steps near
  ascending-node boundaries / reboosts. The adapter therefore emits the SDS OEM
  **verbose** format (`STEP_SIZE = 0` + `EPHEMERIS_DATA_LINES` with an explicit
  `EPOCH` per state), not Starlink's compact row-major array — no reconstruction
  drift, faithful to the source. `META` span fields (`START_TIME`,
  `USEABLE_START_TIME`, `USEABLE_STOP_TIME`, `STOP_TIME`) are preserved.
- **Raw OEM bound by SHA-256, not mislabeled.** The raw source bytes go into
  signed provenance (`SOURCE_SHA256`), never under a data schema.

## Fetch politeness / cadence math

- One file per run (single GET); no per-object load. Full upstream ≈ 700 KB
  (5403 vectors, 15-day span).
- **Cadence** — a run (flow trigger) every **12h** (2×/day). NASA refreshes the OEM a few times
  a week, but each file is a *continuous* 15-day ephemeris, so 12h catches every
  refresh with margin: `~700 KB × 2/day ≈ 1.4 MB/day`. Configurable via
  `{"sourceUrl":…}`.

## Build & test

```
export SPACE_DATA_STANDARDS_ROOT=<spacedatastandards.org checkout>
node build.mjs
node --test test/*.test.mjs
```

`build.mjs` compiles through the SDK (`scripts/lib/build-source-module.mjs`: the SDS `$OEM` headers generated for the
build, `common/oem_fb_builder.hpp`, this module's source). The test drives the methods in the SDK browser harness with
the node config on `plugin.getConfig`, hands the fixtures back as `HttpResponse`s, compares the `$OEM` bytes with the
legacy artifact's and checks the config overrides and the fail-closed cases. No live network is touched.

## Residuals (handoff)

- **A2.4 parity pair.** The CelesTrak SupGP (`SOURCE=ISS-E`) same-epoch reference
  was not captured (CelesTrak `ECONNREFUSED` from this env). Draft + exact query
  in `test/fixtures/supgp-reference-draft/`.
- **Resolved by typed contracts 1.0:** the module emits `$OEM` FlatBuffers that `analysis/od` reads in memory; no JSON record is built.
