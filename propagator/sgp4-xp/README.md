# propagator/sgp4-xp

SGP4 and SGP4-XP from the US Space Force's own library, as one space data module that runs unchanged in the browser,
WasmEdge and Docker WasmEdge, and SDN's own SGP4-XP element sets fitted to any ephemeris.

SGP4-XP is the Space Force's perturbation model with two more fitted terms than SGP4: BTERM (ballistic, m^2/kg) in
BSTAR and AGOM (solar radiation pressure, m^2/kg) in MEAN_MOTION_DDOT of the `$OMM`. The Space Force publishes
the model's code, not the sets; sets are fitted by whoever has the ephemeris. This module fits them, to any source's
ephemeris, and says which source it was.

| | |
|---|---|
| Plugin id | `com.digitalarsenal.propagator.sgp4-xp` 0.1.1 |
| Family, thread model | `propagator`, `wasi-sequential` |
| Library | US Space Force Sgp4Prop WebAssembly 9.1.1.0 (Astro Standards v9.1), XP build, SHA-256 `9f061110...cbeb7` |
| Artifact | `dist/isomorphic/module.wasm`, the one file the three runtimes load; imports WASI only |
| Licence | [US Space Force Open Source Agreement for SGP4](third_party/ussf-sgp4/AGREEMENT.txt), [NOTICE](third_party/ussf-sgp4/NOTICE.md) |

## Methods

| Method | In | Out |
| --- | --- | --- |
| `propagate` | `omm` (one or more `$OMM`, MEAN_ELEMENT_THEORY SGP4XP or SGP4); optional `grid` (`$OEM` template) | `ephemeris`: one `$OEM` per set |
| `fit` | `ephemeris` (`$OEM`); optional `eop` (`$EOP`) | `elements` (`$OMM` SGP4XP), `determination` (`$OBD`) |
| `ingest_omm` | `omm` (SGP4XP sets) | the element table the propagator ABI propagates |

**propagate.** Each set to a trajectory in TEME (`TEMEOFDATE`), GCRF or EME2000, km and km/s, UTC. The grid names
START_TIME, STOP_TIME and STEP_SIZE (default: the epoch, a day later, 60 s) or lists epochs in
EPHEMERIS_DATA_LINES. The set's elements are rounded to the digits of two-line text before they reach the library
(next section), so the trajectory is the library's for the set as published.

**fit.** An ephemeris to the SGP4-XP set that fits its declared interval: USEABLE_START_TIME to USEABLE_STOP_TIME of
the block (the whole block when it declares none). States after the interval are held out and score the fit before
anyone uses it. Frames: TEME, GCRF (ICRF), J2000 (EME2000), Earth-fixed (ITRF, ECEF); time: UTC, GPS, TAI, TT;
center EARTH; compact (`STATE_VECTOR_SIZE` 3, 6, 9) or verbose states; positions alone are enough. The set has the
epoch of the first state of the interval. Its ORIGINATOR is the ORIGINATOR of the ephemeris: the source is named.

The `$OMM` carries the statistics in COMMENT and in USER_DEFINED_PARAMETERS: FIT_START, FIT_STOP, FIT_STATES,
FIT_RMS_KM (3D, TEME, over the interval), FIT_RADIAL/ALONG_TRACK/CROSS_TRACK_RMS_KM, HELD_OUT_STATES,
HELD_OUT_RMS_KM, HELD_OUT_DAYk_RMS_KM (the RMS over the k-th day after the interval) and the fitter's iterations. The
`$OBD` has WRMS, the span, EFFECTIVE_FROM/UNTIL and ERROR_GROWTH_RATE (held-out km per day).

Refusals are named, never thrown: `missing-ephemeris`, `invalid-oem`, `unsupported-frame`,
`unsupported-time-system`, `unsupported-center`, `bad-epoch`, `bad-state-size`, `bad-ephemeris-data`, `no-states`,
`too-many-states`, `frame-failed`, `too-few-states`, `epochs-not-increasing`, `arc-too-short`, `leap-second-in-arc`,
`no-start`, `fit-failed`, `invalid-eop`; for `propagate` `invalid-omm`, `invalid-grid`, `element-set-refused`,
`propagation-failed`, `bad-grid`. An arc across a leap second is refused: minutes since epoch are counted in
86400-second days.

**Propagator ABI.** `plugin_init_omm`, `plugin_propagate`, `plugin_propagate_batch`, `plugin_destroy` and the
rest of the exports of [`propagator/keplerian-reference`](../keplerian-reference/README.md), Earth-fixed metres, so
OrbPro's pluggable propagation and the maneuver detector's propagator query port route to this module.
`space-data-module conformance propagator` passes with the corpus in [`vectors/`](vectors/PROVENANCE.md): 15 Tier B
anchors from the unmodified US Space Force runtime across LEO, sun-synchronous, MEO, GEO and highly eccentric orbits;
the vis-viva and period invariants, two-body statements, are declared not applicable. `space-data-module
parity-gate` finds the module satisfied in the browser, Docker WasmEdge and native WasmEdge lanes.

**Call order (0.1.1).** The library carries integration state from one call to the next. Continuing away from the
epoch reproduces the fresh epoch-to-time propagation byte for byte; any other request does not (a repeated instant
came back 243 m off, a return towards the epoch up to 18 m). Each entity keeps its satellite while calls move away
from its epoch, returns the stored state for a repeated instant, and otherwise starts again at its epoch. Removing
one of several live XP satellites crashes the library itself (out-of-bounds access inside `Sgp4RemoveSats`,
reproduced on its own runtime), so satellites leave only by restoring the library to its starting state, which also
returns the memory it keeps of each XP satellite. Sequential calls cost about 4 µs; 100,000 calls do not grow
memory. One residual remains: the deep-space integrator's state is shared between satellites, so interleaving MEO or
highly eccentric sets can move a result from the fresh evaluation (in 300 random-order calls, 4 differed: three by
under 1 µm, one by 6.3 m).

## The digits of two-line text

The library reads two-line element text and nothing else. An element set is therefore a lattice point: angles to
1e-4 degree (12 m at low orbit), mean motion to 1e-8 rev/day, eccentricity to 1e-7, BTERM and AGOM to five
digits, the epoch to 1e-8 day (0.86 ms). `fit` searches the lattice (every evaluation propagates the rounded set), so
the published set is the one scored, not a continuous optimum that rounds worse. The least the lattice leaves is a
few metres. The search spends at most 100 evaluations: against 400 it changes the GNSS fit RMS by 0.1 m and saves a
quarter of the time; with none the fit RMS is 8% larger.

## How the fit works

Levenberg-Marquardt on six mean elements plus BTERM and AGOM, in non-singular parameters (mean motion, e cos(w+O),
e sin(w+O), tan(i/2) sin O, tan(i/2) cos O, M+w+O), with forward-difference Jacobians and a weak prior on BTERM and
AGOM about zero. The arc grows from two revolutions to the whole interval, each stage starting from the last (the
along-track error of an osculating start is many radians over days). BTERM and AGOM join in the last stage and only
on an arc of about a day or more: a shorter arc cannot see them and keeps them at zero. Positions alone start from
Gibbs' method. At most 240 states, evenly spaced, enter the optimisation; the statistics use all of them (the Starlink
windows of `tests/measure` score the same at 240 as at 480 and cost a quarter less).

## One artifact for three runtimes

The Space Force package is a prebuilt Emscripten build: WebAssembly plus JavaScript glue that answers the nine
imports the build leaves open. A module cannot ship the glue (WasmEdge has no JavaScript) and physics does not go in
JavaScript, so `build.mjs` joins the library to the SDN code in WebAssembly:

1. `src/*.cpp` (the SDN code) compile through the SDK with the library's functions left as imports of the module `ussf`.
2. `src/shim.wat` answers the library's nine Emscripten imports (log lines, heap growth, files it is never asked for)
   in WebAssembly, and provides the copies between the two memories.
3. binaryen's `wasm-merge` resolves every import between the SDN code, `third_party/ussf-sgp4/Sgp4Prop.xp.wasm` and
   the shim. The result has the SDN code's memory as memory 0 (the one hosts see) and the library's as memory 1, and
   imports only WASI. `join-ussf.mjs` is the join; the OD node of `flows/supplemental-omm` uses the same one.

`wasm-merge` re-encodes the library's functions; their behaviour is the library's. The artifact has two memories and uses
bulk memory, so a runtime needs WebAssembly multi-memory (V8 and WasmEdge 0.16.4 run it; the parity gate runs both).
`tests/ussf_parity.test.mjs` runs 640 element sets (SGP4 and SGP4-XP, from low orbit to highly eccentric) through
this module and through the library with its own JavaScript runtime, and requires every position and velocity to be
the same double. `tests/parity.mjs` runs 24 requests through the SDK's parity gate in the browser, native WasmEdge and
Docker WasmEdge and requires byte-identical outputs (`conformance/parity.json`).

The library keeps about 29 KB of every SGP4-XP satellite it has propagated, however the satellite is removed (28.6 KB
each with the library's own runtime; none for SGP4 sets). A fit propagates thousands, so when no satellite is live
the module restores the library's memory to its state at start every 256 of them (`Library::recycle`,
`src/ussf.hpp`): the library keeps everything in that memory, its one global is the stack pointer. The parity test
covers it (it also passes with a restoration before every satellite). A set that stays in the propagator ABI's element
table keeps its memory until `plugin_destroy`, and the library's memory is limited to 2 GiB: 40,000 SGP4-XP sets ingest
(about 15 KB each), 100,000 are refused with `element-set-refused`.

## Accuracy against SDN's SGP4

Median 3D position error (km, TEME) of the sets fitted to 24 hours of an ephemeris, on the fit and on the days after it, SGP4-XP / SDN's SGP4 on the windows both fitted. [tests/measure/README.md](tests/measure/README.md) has every table, the windows and the limits.

| Source | Windows | Fit | Day 1 | Day 3 | Day 7 |
| --- | --: | --: | --: | --: | --: |
| ISS (NASA OEM) | 14 | 0.455 / 0.461 | 2.16 / 2.12 | 16.5 / 16.4 | 88.9 / 88.8 |
| Starlink (SpaceX MEME) | 196 | 0.539 / 0.534 | 3.67 / 5.92 |  |  |
| GPS, Galileo, GLONASS (ESA final orbits) | 98 | 0.022 / 0.134 | 0.057 / 0.420 | 0.161 / 2.40 | 0.419 / 14.2 |
| LAGEOS-1/2, Etalon-1/2 (ILRS) | 36 | 0.095 / 0.116 | 0.104 / 0.227 | 0.242 / 1.22 | 0.570 / 6.61 |
| Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2 (ILRS) | 139 | 0.371 / 0.389 | 0.735 / 0.977 | 1.16 / 5.10 |  |

The low laser-ranged satellites have four-day arcs: their day-3 column is the last one. Starlink files hold two to three days.

## Licence of the Space Force library

"Use" is defined by the Agreement (section 1.L) as the application of the software for any purpose. Its introduction
describes the propagator's intended purpose as propagating 18th Space Defense Squadron two-line sets; this module
also fits sets to other ephemerides and propagates sets that are not 18 SDS's; SDN relies on the Agreement's definition
of Use (1.L) and its grant (2.A). The module is distributed under the Agreement as it stands: the copyright notice, the Agreement and its disclaimer travel with the library
(`third_party/ussf-sgp4/`), with this README and inside `module.wasm` as the custom section `ussf-sgp4-notice`; the US
Space Force and its contributors do not endorse this module or anything derived from it; the module was not written,
reviewed or approved by the US Space Force or by 18 SDS; and export of goods or technical data from the United States
may require a license from the U.S. Government (Agreement 3.H), which nothing here provides. `NOTICE.md` at the root of
this repository carries the row.

## Files

| | |
| --- | --- |
| `plugin-manifest.json` | the manifest; concrete SDS ports, no wildcards; `space-data-module check` passes |
| `src/types.hpp` | dates, mean elements in the units of the text, the text itself, the records of a fit |
| `src/ussf.hpp`, `src/shim.wat` | the library's exports, the satellite RAII, the restoration; the shim |
| `src/frames.hpp` | TEME, GCRF, EME2000, ITRF over `foundation/frames` (IAU 2006/2000A, ERFA) |
| `src/fit.hpp`, `src/window.hpp`, `src/engine.hpp` | the fitter; intervals and windows; what the OD node calls |
| `src/sds.hpp`, `src/records.hpp`, `src/module.cpp` | the SDS records; the `$OMM` and `$OBD` of a fit; the methods and the ABI |
| `build.mjs`, `engine-source.mjs`, `join-ussf.mjs` | the build, the engine as one translation unit, the join |
| `third_party/ussf-sgp4/` | the library as released, its JavaScript runtime (a test oracle only), Agreement, release notes, notice |
| `tests/` | `ussf_parity` (exact against the library), `fit` (known answer, real NASA ISS, refusals), `artifact` (imports, notice, manifest), `parity.mjs` (three runtimes) |
| `tests/measure/` | the measurement of SGP4-XP against SDN's SGP4 on ISS, Starlink, GNSS and laser-ranged satellites: [README](tests/measure/README.md), `run.mjs`, `tables.mjs`, `resummarize.mjs`, `results/` |

## Commands

```sh
npm ci
npm run build          # dist/isomorphic/module.wasm
npm test               # node --test tests/*.test.mjs
PATH=$HOME/.wasmedge/bin:$PATH npm run test:parity   # browser, WasmEdge, Docker WasmEdge; needs Docker running
```
