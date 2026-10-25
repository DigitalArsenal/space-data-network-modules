# Supplemental OMM OD node

`org.sdn.flows.supplemental-omm.od` 2.0.1, typed contracts 1.0 (FlatBuffers only).

| method | in | out |
| --- | --- | --- |
| `fit` | `starlink`, `glonass`, `intelsat`, `cpf`, `iss`: SDS `$OEM`, one object a frame, from the flow's source modules | `omm_meta` + `omm`, `ocm_meta` + `ocm`, `obd_meta` + `obd`: each an IngestRequest (INGQ) and the size-prefixed record stream it files; `status`: FlowNotice (FNTC) |
| `publish_request` | `result` IngestResult (INGR) + `meta` the IngestRequest it stored | `request` HttpRequest (HREQ): POST `omm_publish_url`, BODY the IngestResult |

Each `$OEM` is read into the object's states in the source's own axes and time scale (EME2000 or Earth-fixed
CustomFrame ECEF; UTC or GPS) and handed to the frozen complete-arc OD core as before: the velocity-bearing sources
(Starlink MEME, ISS OEM) as a verbose `$OEM`, the position-only ones (GLONASS SP3, Intelsat ECF, CPF) as the compact
position-only `$OEM` (STATE_VECTOR_SIZE 3) the fitter seeds its velocities from, an arc the core cannot fit (fewer than
three states, a repeated epoch, an unbound velocity seed) refused before it. One object is fitted an invocation, the
rest wait as backlog. The object's records go out as one stream per standard with an IngestRequest: SCHEMA, TAGS
(PROVIDER_ID `supplemental-omm`, SOURCE_NAME `spacex-starlink` / `glonass` / `intelsat` / `cpf` / `iss`, BATCH_ID the
stream's SHA-256, CONTENT_KEY_ID `public`), RECONCILE Duplicates, PROVENANCE (PARSER, NORMALIZED_SHA256 and COUNT).
Notices: Info `fitted` (ITEMS the completion message, COUNT the `$OMM` records, BATCH_ID the `$OMM` batch), Skipped
`unfittable` and `fit-failed`. A frame that is not a readable `$OEM` in EME2000 or Earth-fixed axes refuses the
invocation (`od-input-invalid`).

## SGP4-XP beside SGP4

Every ephemeris is also fitted with SGP4-XP, the US Space Force's perturbation model with a fitted ballistic term
(BTERM) and solar-radiation term (AGOM). A window is a day to fit (two thirds of an ephemeris shorter than a day and a
half) and up to a day after it to score the fit; the next window starts where the last fit ended, while the ephemeris
lasts, at most 16 windows. An ephemeris too short to hold a fit and three hours to score it gets no XP set. The optimisation sees at most 240 states of a window, evenly
spaced, as in `propagator/sgp4-xp`; the statistics are over all of them. The OD core's sets are unchanged either way.

Each window is one `$OMM` (MEAN_ELEMENT_THEORY SGP4XP, BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT; epoch the first state of
the fit) and one `$OBD`, appended to the `omm` and `obd` record streams the OD core's records go in, and each names its
source:

| Port | ORIGINATOR | Axes, time |
| --- | --- | --- |
| `starlink` | SpaceX | EME2000, UTC |
| `glonass` | CODE (Astronomical Institute, University of Bern) | Earth-fixed, GPS time, positions |
| `intelsat` | Intelsat | Earth-fixed, UTC, positions |
| `cpf` | ILRS (EDC, DGFI-TUM) | Earth-fixed or EME2000, UTC, positions |
| `iss` | NASA/JSC/FOD/TOPO | EME2000, UTC |

The OMM's COMMENT holds `SOURCE <source module plugin ID>` (`com.orbpro.spacex-starlink-source`, ...), the fit interval
and the fit and held-out statistics (N, RMS, maximum and radial, along-track and cross-track RMS, km, in TEME); the
OBD's sensor is the source module. A set
whose NORAD number the source does not give has 99999, as the core's. When XP sets were made the object's completion
status says how many (`OD fit complete: ISS (NORAD 25544); SGP4-XP: 14 sets`).

The engine is [`propagator/sgp4-xp`](../../../../propagator/sgp4-xp/README.md)'s: its sources compile as one object
with no SDS record in it (this node's SDS pin is not that module's), and the Space Force Sgp4Prop build is joined to
the linked node in WebAssembly by `wasm-merge` (`build.mjs`, `propagator/sgp4-xp/join-ussf.mjs`): the node's memory
stays memory 0, the library's becomes memory 1 (16 MiB at start; a fit returns it to its start state every 256 satellites), and
the node imports what it imported before. The node's set for an
ephemeris is that module's set for the same states. Earth-fixed positions are rotated with UT1 = UTC and the mean pole:
the node has no Earth orientation input, so the OD core's sets stand on the same assumption.

The Space Force library is distributed under its [Agreement](../../../../propagator/sgp4-xp/third_party/ussf-sgp4/AGREEMENT.txt),
which travels with the node as the custom section `ussf-sgp4-notice`; the US Space Force does not endorse this node.

## Build

`WASI_SDK_PATH=<wasi-sdk 30> node build.mjs` builds `dist/isomorphic/module.wasm`, unsigned, through the SDK compiler
(`build.mjs`). The frozen core returns its results in `std::vector` and `std::string`; libc++ 20 onwards lays
`std::vector` out by size under ABI v2 (Homebrew's wasi-runtimes 23), and a node built so frees the core's vectors as
garbage, so `src/node.cpp` refuses that libc++ and the build takes wasi-sdk 30 (libc++ 21). The flow's release
(`scripts/release.mjs`) adds the WasmEdge universal-AOT section and the signature. `vendor/NOTICE.md` records the
core's provenance.

