# GLONASS Precise Ephemeris (IAC SP3) Data Source (A2.2c-2)

Typed contracts 1.0 (FlatBuffers only, no JSON, no base64). The module fetches and stores nothing itself: it is a
pure request-and-parse node beside `hostcap/http-request`, and its `$OEM` output is consumed in memory by
`analysis/od` (`fit`), never stored, signed or published.

## Flow (`src/glonass_source.cpp`)

| Method | In | Out |
| --- | --- | --- |
| `request` | `tick`: `TimerTick` (TICK; fields not read) | `request`: one GET `HttpRequest` (HREQ) for an IAC GLONASS precise ephemeris (SP3-d) |
| `emit` | `response`: the file's `HttpResponse` (HRSP) | `oem`: one $OEM per GLONASS satellite (position-only, frame/time as the SP3 header declares), at most `objectCap` when positive |

Node config through `plugin.getConfig` (sdm_piv, one `ModuleConfig` read in place; the module's only hostcall):
`sourceUrl`, `objectCap` (default: the whole constellation). Capabilities: none. A transport error, a status other than 200, an empty body
or a file with nothing fittable fails closed (`fetch-failed` / `fetch-empty`); nothing partial is emitted. The flow's
trigger sets the cadence (the former module timer's cadence is noted in the manifest).

The former `pull` method (JSON hostcalls; it declared a signed `$PNM` output but only ever returned the in-memory `$OEM`
stream) and the hand-built guest-link (`guest-link/emit_entry.cpp`, `manifest.js`) are gone: the SDK compiler builds the
module and its guest-link object (`dist/guest-link/`). `test/module.test.mjs` runs the methods in the SDK browser harness
on the fixtures and checks the `$OEM` bytes against the legacy artifact's (`test/fixtures/legacy/oem-stream.bin`).

## ⚠️ Frame / time preserved AS DECLARED (a mission correction)

The A2.2c-2 packet expected IAC GLONASS ephemerides to be **"PZ-90.11 ECEF state
vectors"**. Live investigation of the actual IAC product (2026-07-13) corrects
that — the real SP3-d headers declare:

| SP3 header field                | value    | note |
|---------------------------------|----------|------|
| coordinate system (cols 47–51)  | `IGS20`  | the IGS realization of **ITRF2020** — **NOT PZ-90.11** |
| time system (`%c`, cols 10–12)  | `GPS`    | GPS system time — **NOT GLONASS time / UTC(SU)** |

PZ-90.11 / GLONASS-time is the frame of the GLONASS **broadcast navigation
message** — a *different* product. IAC, as a full multi-GNSS IGS Analysis Center
(AC code "IAC"), publishes its **precise** orbits in standard IGS conventions
(IGS20 / GPS time) for interoperability.

The adapter **preserves what the file declares** — `REFERENCE_FRAME` = the SP3
coordinate-system field (e.g. `IGS20`), `TIME_SYSTEM` = the SP3 time-system field
(e.g. `GPS`) — and does **not** relabel to PZ-90.11 and does **not** transform
frames. The OD module owns any frame transform (A2.2a). A `COMMENT` +
`FRAME_NOTE` provenance record the finding so nothing downstream mistakes the
frame.

## Representation: position-only (no fabricated velocity)

Every IAC SP3 sampled (and the CODE/GFZ MGEX products cross-checked) is
**position-only** — `P` records only, no `V`/velocity records. Per the A2.2a
ethos we do **not** fabricate velocities. The OEM is therefore **verbose**
(`STEP_SIZE = 0`, explicit `EPOCH` per line) with `STATE_VECTOR_SIZE = 3` and
`X`/`Y`/`Z` (km) only. SP3 satellite-clock values are not orbital state and are
dropped (a bad/absent clock `999999.999999` does **not** invalidate the
position; an absent position — SP3 sentinel `0.000000` on all of X/Y/Z — is
skipped). `OBJECT_ID` / `NORAD_CAT_ID` are absent (SP3 carries only the `Rnn`
GLONASS slot id; the slot→NORAD map is not fabricated).

## A2.4 implication (gate achievable, with OD-side prerequisites)

Unlike GPS (whose almanac is not a state-vector ephemeris), the IAC SP3 **is** a
real state-vector ephemeris, so the A2.4 **hard-RMS gate is achievable** — but
only after these OD-side prerequisites land (they are **not** in A2.2a yet):

1. **IGS20/ITRF2020 (ECEF) → TEME** transform. A2.2a implemented inertial
   EME2000/J2000/GCRF → TEME only; an Earth-fixed (ITRF) frame needs
   Earth-rotation + polar motion + UT1 (an ECEF↔inertial rotation) the OD module
   does not yet do (it fail-closes on non-inertial frames).
2. **GPS → UTC** (leap seconds). A2.2a is UTC-only; the SP3 declares `GPS` time.
3. **Position-only fit** — confirm the OD SGP4 fit accepts a position-only state
   series.
4. **Slot → NORAD** cross-reference for element-space parity vs CelesTrak.

Full detail + the exact `GLONASS-RE` CelesTrak query are in
`test/fixtures/supgp-reference-draft/`. CelesTrak was unreachable from this env
(connection timed out) so the reference pair is a DRAFT (mirrors A2.2c-1).

## Fetch politeness / cadence / transport

- One SP3 file per run (single GET). The module `timers` block runs a run (flow trigger) every
  **12h**; IAC regenerates its precise products ~daily (rapid) with a rolling
  ultra-rapid, so 12h captures the refresh promptly.
- `objectCap` (default: none, the whole constellation) bounds per-run *record* churn (one record per
  GLONASS satellite), not fetch load. Configurable via `{"objectCap":…,
  "sourceUrl":…}`.
- **Transport residual (OWNER-ASSIST):** at capture time the IAC **HTTPS**
  frontend (`glonass-iac.ru`) returned `502 Bad Gateway`; the live products are on
  the IAC **anonymous FTP** (`ftp.glonass-iac.ru`, reachable). The default
  `sourceUrl` therefore points at `ftp://.../LATEST/Final.sp3`. Whether the host
  `http` capability can fetch `ftp://` is a host concern — if not, the fetch
  needs an FTP-capable host fetch or an HTTPS mirror (`sourceUrl` override).

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
