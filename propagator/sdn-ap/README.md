# sdn-ap-propagator

Version 0.6.56 (dist 2131db19).

General-perturbations propagation of whole catalogs in one isomorphic WASM module (browser and WasmEdge), with two
theories and AP, an advanced propagator that builds on the entire history of astrodynamics ($PCF FORCES selects its drag
atmosphere, gravity terms and solid Earth tide; SPEC 15, 16).
When you fit real data with AP, state `FORCES.SOLID_TIDES = IERS_2010` beside the gravity terms: the Earth has the solid
tide, and without it AP's error on a low orbit after a 72 h fit is about twice as large at day 5 against a numerical
propagator that carries it (SPEC 16.14).
An `$OMM` whose MEAN_ELEMENT_THEORY is neither SGP4 nor SGP4XP, a `$PCF` whose THEORY is not UNSPECIFIED, SGP4 or SGP4XP and an
`ElementRow` of theory 16 are refused.

| Theory | Sets | Source |
|---|---|---|
| SGP4 | type 0 | SPACETRACK REPORT No. 3; Vallado et al. 2006 (AFSPC mode) |
| SGP4XP | type 4: BTERM, AGOM (m^2/kg) | [Payne et al. (2022)](https://amostech.com/TechnicalPapers/2022/Astrodynamics/Payne_2.pdf); clean-room implementation from the public change list and SPEC.md |

License: PolyForm Noncommercial 1.0.0 ([LICENSE](LICENSE)): free for any noncommercial purpose; commercial use needs a license from Edgesource Corporation (tj@edgesource.com). Versions released before 2026-11-08 stay under Apache-2.0. The SGP4/SDP4 base is included (written clean room from Spacetrack Report No. 3
and the corrections AIAA 2006-6753 documents); [NOTICE](NOTICE) names what the build compiles and reads.

Build: `npm run build` (module SDK compiler lane, clang `wasm32-wasip1-threads`, no exception handling) writes
`dist/isomorphic/module.wasm`; it reads ERFA from this repository. No build data is fetched.

AP's zonal tail at epoch eccentricity at or below 0.3 carries long-period harmonics through |w| = 6 in its mean-element
rates (SPEC 16.3, stack #595). Finite Hansen coefficients use a 0.002 eccentricity grid whose cell center depends on
the state alone, with a floor at e 0.01. The largest offset above the floor is 0.001. The five-day crossing test's
excess second difference is 0.000682 m; the boundary-side same-field residual difference is 0.004882 m.
The original hp400/e0.05/i55 and hp300/e0.01/i55 pairs have maximum 3D errors of 14.515642 and 15.180303 m,
within the 20 m bound, and day-1/day-5 once-per-revolution amplitudes below 10 m. The e0 0.2999 control comparison
is 0.796426 m, including approximation and truncation. SPEC 16.3 gives the value/slope envelopes and controls.

The degree70 table costs 6,768 bytes per set versus 1,552 before the added harmonics. A 3,992-byte per-thread cache
holds cell coefficients independently of semimajor axis. Alternating degree70/order31 five-day fits against 0.6.48
cost 1.242354 times as much at hp300/e0.01/i55 and 1.755229 times at hp800/e0.05/i20. Warm and cold state costs
are tabulated in SPEC 16.3; cold day-7 calls for the measured decaying orbit cost 6,262.855 versus 3,697.333 µs.
A covariance bank shares the nominal table: legacy |w| <= 1 entries depend on nominal e0 (a measured 1.854 m
five-day difference for a set 2e-4 away); the added contribution is bit-identical under either owner.
The output map and the terms above e 0.3 retain their definitions.

## Interface

- Propagator ABI: `plugin_init_omm`, `plugin_init`, `plugin_propagate`, `plugin_propagate_batch`,
  `plugin_entity_count`, `plugin_destroy`; Earth-fixed meters. `OrbProOMMRecord`s are read as SGP4XP sets
  (BTERM in `bstar`, AGOM in `mean_motion_ddot`) unless `sdnap_set_omm_theory(0)` selects SGP4.
- Batch, structure of arrays: `sdnap_init_elements(rows, count)` (112-byte `ElementRow`s, split Julian epoch, theory per
  row: 0 SGP4, 4 SGP4XP; any other theory is held refused); `sdnap_propagate_soa(jdWhole, jdFrac, first, count, frame,
  out, status)` and `sdnap_propagate_minutes_soa(minutes, first, count, out, status)` write six planes (x, y, z, vx, vy,
  vz) of `count` doubles, TEME km and km/s or Earth-fixed m and m/s. `sdnap_threads(n)` starts the pool; results are
  the same bytes at any thread count. A threaded batch grows no memory (SPEC 9, stack #487). A batch whose pool thread
  stops returns -20, with every status 9, and later batches run on the calling thread. `sdnap_pool_stats(out)` reads
  the pool's counts. Before 0.6.31 a pool thread could trap on a block in pages another thread had just grown, and
  the calling thread then waited forever. On a loaded machine that happened in AP batches of a test build, never in the
  shipped build with SGP4XP rows (0 of 40 processes).
- Display quantities (the module's own conversions; `test/exports.e2e.mjs` checks each against its inverse):
  `sdnap_mean_elements_at(index, minutes, out)` the mean a (km), e, i, RAAN, argp and M (deg) of an SGP4XP row at
  minutes from its epoch (an SGP4 row is refused); `sdnap_osculating_elements(r, v, out)` the osculating elements of a
  TEME state about the Earth theory's GM and `sdnap_state_of_elements(whole, frac, el, frame, out)` its inverse;
  `sdnap_mean_motion_of(a, e, i)` the mean motion (rev/day) an SGP4XP set carries for a mean a (km), the inverse of
  `sdnap_mean_elements_at` (a round trip within 1e-12 relative from LEO to GEO); `sdnap_frame_to_uvw(r, v, vec, out)` a
  vector's radial, in-track and cross-track components and `sdnap_uvw_to_frame` its mirror.
- The osculating Kepler solve (SPEC 16.21; `test/perigee-kepler-branch.e2e.mjs`): `sdnap_kepler_unconverged(reset, which)`
  counts solves, every caller's, whose Newton ended its 30 steps without meeting its tolerance: `which` 0 AP's whose last
  step was 1e-12 or more (then solved by bisection), 1 section 8's whose last step was 1e-12 or more (then solved by
  bisection), 2 AP's whose last step was under 1e-12 (solved; section 8's such endings are in no count); `reset` non-zero
  reads and clears it in one step.
- The fit's iteration ceiling (SPEC 12.1): `sdnap_fit_ceiling_met(reset, which)` counts the fit passes that ended at their
  ceiling with the cost still falling: `which` 0 at 1,000 a pass (a fit that solves no drag term: the set above the drag,
  or a drag term its prior holds), 1 at any other ceiling (40 a pass where the fit solves a drag term, or an `sdnap_fit`
  caller's own); `reset` non-zero reads and clears it in one step. Such a record states CONVERGED false and, in a line of
  its OD COMMENT no version before wrote, says so: a fit under the drag that ends at 40 keeps the elements, statistics and
  flights of the version before, and its record's bytes differ by that line alone.
- Memory (SPEC 1.6, 16.11; `test/grid-cache.e2e.mjs`): a method during which one of the module's own allocations failed
  refuses with errorCode `out-of-memory` and emits nothing, never success nor another reason (a decay answer, SPEC 16.25,
  included); `sdnap_fit` then gives status -1 and leaves its row as it came. At its memory limit the module refuses a
  state, never aborts (`test/memory-limit.e2e.mjs`): a thread's caches are made before its first state, and a state on a
  thread that cannot make them answers the theory's refusal code.
  `sdnap_wide_grid_budget(bytes, out)` sets the grid cache's byte bound (512 MiB by default; live and idle grids, each at
  its allocated bytes, the least recently used idle grid freed first) when bytes is 1 or more (1 keeps no idle grid), and
  writes the bound, the bytes held, the grids held and those idle. The bound decides which grids are kept, never a state.
- Covariance (SPEC 12; `test/covariance.e2e.mjs`): `fit` writes, for its SGP4XP sets, the fit's covariance at its epoch
  as COVARIANCE (TEME, 21 values) with USER_DEFINED_SDNAP_COV_x rows (the BTERM and AGOM parameters' covariances, the
  theory floor, the process noise); `sdnap_covariance_at(omm, length, minutes, count, out)` gives, per time, the TEME
  state and its 6 x 6 covariance (42 doubles), carried by the theory's own state transition matrix (central
  differences of the theory in its parameters) plus the fitted process noise; `propagate` writes a
  COVARIANCE_MATRIX_LINES line per state, in the block's axes, for a set that carries COVARIANCE.
- Epoch store (SPEC 14; `test/epoch-store.e2e.mjs`): `load_epochs` replaces the resident store with a snapshot (size-prefixed
  `$OMM` records end to end on 'omm', the element-sync module's output) under the `$PCF` EPOCH_STORE table: per series
  (NORAD_CAT_ID, OBJECT_ID, theory, ORIGINATOR) the sets of CACHE_DAYS (7) before the newest epoch of the load, at most
  MAX_SETS_PER_OBJECT, of THEORIES (SGP4, SGP4XP). SELECTION NEAREST or LATEST_BEFORE by binary search; across
  BLEND_WINDOW_SECONDS (3600) around each switch the two sets' states blend (SMOOTHSTEP weight with its derivative in
  the velocity, or HERMITE: set a plus a cubic correction landing on set b), position and velocity continuous; the
  covariance mixture where sets carry COVARIANCE. Two AP sets on different branches (SPEC 16.7), or a carried forecast and
  a theory state (SPEC 18), are not blended: their switch is a step, `_select` gives b = -2 (branches) or -3 (carried and
  theory) in its window and `propagate_epochs` names it in the block's COMMENT. Exports `sdnap_epochs_count`, `_stats` (records, kept, aged, capped,
  by THEORIES, not centered on the Earth, same-epoch duplicates, bytes), `_series`, `_select`, `_set_at`, `_at` (a
  batch of series at one time, TEME or Earth-fixed, with the covariance); `propagate_epochs` gives the same for a
  snapshot and a grid in one stateless call. Seven days of the Space-Track catalog (2026-10-07 .. 13, 228,129 records,
  13 frames of at most 4 MiB) load in 0.1 s into 30,931 series and 106,813 sets, 17.0 MiB (577 bytes a series) before
  any series is propagated.
- Carried forecast (SPEC 18; `test/carried-*.e2e.mjs`), a separate product: the record carries a numerical forecast made
  by another propagator (propagator/ffm, or an operator's ephemeris) and returns it inside its span; its figures are
  that forecast's and the record's, never AP's accuracy, which is the theory's alone. `fit` with `$PCF`
  OUTPUT.START_TIME and STOP_TIME writes the
  ephemeris block's states between them into the `$OCM` as Chebyshev position segments (POLYNOMIAL_POSITION_RECORDS,
  TRAJ_TYPE POLYNOMIAL_POS, in the set's TRAJ_REF_FRAME) held to 1 cm and 0.1 mm/s against the forecast (about
  0.2 mm/s from states 60 s apart in low orbit), joints
  continuous to the acceleration, with the record's statement of its span and source (TRAJECTORY_BLOCKS, METADATA
  START_TIME and STOP_TIME); its theory is anchored at the span's start (the observation cutoff; its covariance grows
  forward), and `fit` with OUTPUT.START_TIME alone at the stop makes the hand-over set (TRAJ_ID "HAND-OVER") fitted to
  the forecast's last part; the steps at each end are in the OD COMMENT. `propagate`, `load_epochs` with
  `sdnap_epochs_set_at` and `sdnap_epochs_at`, and `propagate_epochs` fly the forecast inside its span, the hand-over
  set after it and the theory elsewhere, one block per record or series with every state's source in its COMMENT
  (SPEC 18.8's grammar; `sdnap_epochs_source_at` for the store); a record's segments are read when first flown, safely
  for concurrent readers. The compression test on FFM
  forecasts in 12 regimes up to e 0.9 (`test/carried-compression.e2e.mjs`): at most 5 mm and 0.051 mm/s off the build's
  times, joints under 0.6 mm; 20 to 68 KB per object-day in low orbit, 0.3 to 10 KB above it and on eccentric orbits.
  States at most 0.1 rad of arc apart (60 s in low orbit, the common operator step, holds 1 cm and about 0.2 mm/s; at
  most 0.05 rad, 30 s, 1 cm and 0.1 mm/s); `sdnap_carried_frame_error` gives the frame's bound.
- Configuration (SDS 1.272.0, `$PCF` 1.0.6): `propagate`, `fit` and `maneuver` take one `$PCF` on their required
  `configuration` port. Each reads THEORY and its own tables (propagate and maneuver: OUTPUT, FORCES;
  fit: FIT, FORCES); another method's tables are left to it. Fields left unset take the defaults
  schema/PCF/main.fbs documents, each this module's own, so a table whose fields are all unset (or written at their
  defaults) reads as an absent one, but one: a BTERM prior left unset (FIT.DRAG_PRIOR absent or without a sigma, its
  form unset) is LOG_NORMAL with median 0.01 m^2/kg and sigma of the log ln 10, where the schema's text says 0 +- 0.05;
  a field set to a value the module cannot apply is refused by name
  (configuration-refused, "TABLE.FIELD: why"; configuration-missing without one). THEORY: propagate and maneuver read
  UNSPECIFIED as each set's own (another value must match it); fit fits SGP4XP (UNSPECIFIED, SGP4XP); FFM and
  KEPLER are refused. FORCES carries an empty EPHEMERIS_SOURCE (the theories' own analytic Sun and Moon series: SGP4XP's
  of SPEC 5; AP's own of SPEC 16.17, a fit to DE440 within 4.1 arcsec of it over 2010-2035, in the module): the
  averaged theories apply their own forces; on `fit` and `propagate` it also selects SGP4XP's drag atmosphere (SPEC 15,
  below) and AP's gravity terms (SPEC 16, below), on `fit` the solid Earth tide (SOLID_TIDES, SPEC 16.14, below) and
  ECOM2's Y0 (SPEC 16.13, below), and any other FORCES field is refused by name. INTEGRATOR is refused
  (the averaged theories integrate on their own grid), EVENTS when not empty. FIT (every field) and OUTPUT (TEME,
  GCRF or EME2000, at most 500,000 states) apply with their documented ranges; FIT.DRAG_PRIOR_FORM and SRP_PRIOR_FORM
  LOG_NORMAL need their prior (HAS_SIGMA true, the MEAN its median > 0), refused by name without it.
- Invoke surface (SDS buffers plain or size-prefixed): `ingest_omm` takes `$OMM` records (MEAN_ELEMENT_THEORY SGP4 or
  SGP4XP); `propagate` returns one `$OEM` per `$OMM` on the grid of an optional 'grid' `$OEM` template, as modules
  propagator/sgp4-xp reads it: explicit EPOCHs or START_TIME / STOP_TIME / STEP_SIZE (defaults: the set's epoch, one day,
  OUTPUT.STEP_SECONDS 60 s), TEME, GCRF or EME2000 (OUTPUT.FRAME for a template that names none), at most
  OUTPUT.MAXIMUM_STATES (500,000) states a request; the grid's span decides how far a set runs. `test/wasmedge-parity.mjs`
  runs it through the browser host and native WasmEdge 0.16.4: identical `$OEM` bytes.
- `fit` takes `$OEM` ephemerides and returns per block one SGP4XP `$OMM` on `elements` and one `$OBD` on
  `determination` (fit interval, spans, method, first, best and published RMS in km, held-out error growth,
  iterations, states accepted). The block's REFERENCE_FRAME is read, never assumed (the CelestialFrame
  enumeration, an RFM coordinate system, or NAME): TEME; GCRF or ICRF (TEME = R3(GAST06 - GMST82) NPB06 GCRF,
  IAU 2006/2000A through ERFA); EME2000 or J2000 (the IAU 2006 frame bias, then GCRF); Earth-fixed (GMST82);
  UT1 = UTC and the pole at its mean position. No frame, or an enumeration and NAME that disagree, is refused
  by name (reference-frame-undeclared, reference-frame-conflict); a block centered elsewhere than the Earth
  (unsupported-center). Fit span: USEABLE_START_TIME to USEABLE_STOP_TIME (or FIT.HOLDOUT_HOURS before the data's end);
  without USEABLE_START_TIME the span rule (DESIGN 2e.3, $PCF FIT), validated on the data: FIT.DEFAULT_SPAN_HOURS (48 h;
  ECCENTRIC_DEFAULT_SPAN_HOURS 24 h above ECCENTRICITY_THRESHOLD 0.5), then CANDIDATE_SPANS_HOURS (48, 72 and 120 h; 24 h
  in front for an eccentric orbit) each fitted to the data before the latest TAIL_HOURS (24 h) and scored on that tail
  (a day-1 prediction); the span with the smallest tail error (a longer one only when within EXTENSION_MARGIN 0.9,
  eccentric 0.7, of the best shorter one's) is refitted on all the data. The arc grows from two revolutions by threes
  to the fit interval. `fit` shortens a span whose fit RMS passes FIT.IMPLAUSIBLE_RMS_KM (100 km) to its latest half,
  down to FIT.MINIMUM_SPAN_HOURS (24 h), and refuses an Earth arc still beyond it (fit-implausible); a fit that stops on
  a switch (SPEC 16.7: class, the 1,100-minute regime, the eccentricity switches; within 1e-8) is settled on one branch;
  when on each side the best set lies across the switch, a fit at a limit in n is refused fit-at-branch-limit and one at
  an eccentricity switch (0.3; the first-order tesseral families' 0.05 in class 0, 0.3 in every other class) with no
  limit in n near ends on one side, its set held at the switch (the record's OD COMMENT says so; its covariance is the
  curvature at a set that is not the cost's minimum, uncalibrated there); an eccentric block's
  fits (e > FIT.ECCENTRICITY_THRESHOLD) take the theory's one-sided differences for the element and drag columns where
  no step along the analytic Jacobian lowers the cost. BTERM and AGOM carry FIT.DRAG_PRIOR and FIT.SRP_PRIOR. BTERM's
  default is LOG_NORMAL, median 0.01 m^2/kg and sigma of the log ln 10, the prior of the free fits of experiments
  xp2-fit-design (1,214 windows, every one converged); the GAUSSIAN_SIGNED 0 +- 0.05 it replaced ended at BTERM <= 0,
  no drag at all, on a real ISS window, and is asked for by stating its mean and sigma. AGOM's default is
  GAUSSIAN_SIGNED 0 +- 0.05 m^2/kg on arcs of 36 h or more and the Space Force wrapper's 0 +- 0.1 m^2/kg on shorter
  arcs (SPEC 12.1; a stated FIT.SRP_PRIOR holds on every arc). The data are weighed against these priors at their own
  sigma, the post-fit scatter, which the covariance then uses too, above the drag and, under the drag (the fitted set's
  perigee below 2,500 km), on an arc of 71 h or more at or below e 0.3; a shorter arc, or a set above e 0.3, under the
  drag is weighed at 1 km, a stated limit
  (stack #489) under which each prior acts about 100 times more strongly in the estimate than the covariance states
  (SPEC 12.1, the fit's weighting; `test/fit-data-sigma.e2e.mjs`, `test/fit-cost-curvature.e2e.mjs`). On the radiation
  lane's 800 km sphere a 72 h fit's AGOM goes from 0.356 to 0.937 of the truth (`test/radiation-sphere-agom.e2e.mjs`). At 1 km a 24 h medium Earth
  orbit fit returned AGOM 15 % low at the median of 254 real windows and was 121 m off at day 5; at its own sigma it
  returns 1.01 of a numerical sphere's coefficient and is 33 m off. On 748 already-read 24 h GNSS windows (exploratory) the
  median paired day-3 error of SGP4XP minus the Space Force library's falls from +56.107 to -4.097 m; 746 72 h
  windows are unchanged (`test/fit-short-arc-priors.e2e.mjs`). From 0.6.13, weighted at the data's sigma, SGP4XP's
  24 h median day-3 error there is 145.75 m (152.29 m on 0.6.11) and its paired difference from the library -1.752 m;
  GPS IIF 41019 is worse on 149 of its 150 windows (day 3 114.7 to 155.5 m; SPEC 12.1). Under LOG_NORMAL the iteration steps in the term's natural log, starting at the
  prior's median (the two-revolution stage holds BTERM there, every stage before the last AGOM), so the term is never
  <= 0. An SGP4XP set is rounded to the two-line digits and searched on their lattice (an AP set keeps full precision,
  SPEC 16.9); a term whose prior sigma, in its own
  units (sigma of the log times the term under LOG_NORMAL), is at most one unit of its last digit is not stepped. The
  `$OBD` BALLISTIC_COEFF_MODEL and AGOM_MODEL state each prior's form and values as used; under LOG_NORMAL with a
  covariance, the posterior sigma of the log, and "covariance prior-limited" when it passes 0.5 (the term effectively
  unobserved). The raw export `sdnap_fit` takes the 56-byte fit options with drag_log and agom_log, and fit_bdot,
  fit_thrust and fit_outgassing, refused `parameter-not-modeled:<NAME>` (SPEC 17.2; `sdnap_fit_refusal`).
- Known limit of BTERM's default start (study 2026-10-31): the fit starts at the prior's median, 0.01 m^2/kg, and an
  object whose B lies far below it can stop in a local minimum. On noise-free synthetic tracks (a day of an SGP4XP set's
  own states at 60 s, e 0.0003, i 51.6 deg, AGOM 0.01 m^2/kg, n 15.5, 15.2 and 14.9 rev/day for 400, 500 and 600 km,
  fitted back) B of 0.0005 to 0.002 m^2/kg at 400 km and 0.0005 to 0.004 at 500 and 600 km end at a fit RMS of 4.0 to
  14.7 m, against 0.96 to 1.19 m from the former default's start at no drag; B of 0.01 and above recovers to about 1 m
  at 400 and 500 km. A caller that knows its object's B states a LOG_NORMAL median near it. On 94 real ISS windows
  (NASA's daily files, every eighth from 2020-09-10 to 2026-10-13, the first 24 h of each) the former default ended at
  BTERM <= 0 on 42 (median fit RMS 472 m) and this one on none (457 m; lower on 65, never more than 5 % higher).
- Third-party code, read from the open modules repository (this repository vendors nothing) and pinned by SHA-256
  in `build.mjs` (the build fails on any other bytes; `dist/build-provenance.txt` records the path, commits and
  hashes): ERFA (BSD-3-Clause, derived with permission from IAU SOFA; license carried in `LICENSES/ERFA.txt` and
  `dist/LICENSES/ERFA.txt`); NRLMSISE-00, the public-domain C port in `third_party/nrlmsise00` (the files at modules
  fe5e4ca0; propagator/ffm, analysis/density-calibration and analysis/od compile the same files, and a change there
  is taken here by updating the pin).

## Products (SPEC 17; `test/products-parameters.e2e.mjs`)

- Covariance rows: the state, then DRAG_AREA_OVER_MASS, DRAG_AREA_OVER_MASS_RATE, SRP_AREA_OVER_MASS,
  IN_TRACK_ACCELERATION, OUTGASSING_ACCELERATION when solved, in that order; COV_UNITS one per row. A record's rows the
  theories have no sensitivity to fly as constant parameters.
- `fit` writes WEIGHTED_RMS (FIT_RMS_KM / sqrt(3) over the sigma OD_DATA_WEIGHTING states: 1 km under drag on an arc
  under 71 h or above e 0.3, the data's own otherwise) and SEDR, and one `$ODR` per fit on
  `residuals`: a row per input state (geocentric distance observed and computed, weight, accepted).
- `sdnap_covariance_full_at` gives the covariance of the state and the parameter rows per time; no sensitivities are
  exposed, so P8 is refused.

## AP's gravity terms (SPEC 16; `fit`, `propagate`, `load_epochs` and `propagate_epochs`)

`FORCES.HAS_MAXIMUM_TESSERAL_DEGREE` and `MAXIMUM_TESSERAL_DEGREE` add tesseral gravity (in the low table with a degree above
12, from 0.6.42, the first-order terms with |l - 2p| up to 17 and the m-daily terms to the degree asked, up to 70, each above
the table's size cut of 0.5 m, and none inside the slow band at more than 1 - w of its epoch rate: SPEC 16.1's band rule and
band guard; on every other branch m-daily
and the other first-order terms to 12; in class 0 with a period under 1,100 minutes near-resonant terms and shallow
resonances to 31; the half-day and one-day resonant tails to 31 (the one-day tail at e 0.3 or below); each to the degree
asked if lower; elsewhere nothing above 12;
MAXIMUM_TESSERAL_DEGREE is a cap on families, not the degree of a field: SPEC 16.1; in the low table the slow set below takes
degree 70 whatever degree is asked, so a record at tesseral 31, 20 or 12 still flies slow terms to degree 70, as its
GRAVITY_MODEL states: "EGM2008; slow tesseral terms to degree 70"); `HAS_MAXIMUM_DEGREE`
and `MAXIMUM_DEGREE` add the zonal tail from J6. With either set, mean elements hold the axes of the set's epoch and each state is
carried to TEME of its date. The field is EGM2008 (from 0.6.36; EGM-96 through 0.6.34), pinned from propagator/ffm/lib by `build.mjs`. From 0.6.36 a flight
refuses an AP set with gravity terms whose PERTURBATIONS.GRAVITY_MODEL is not that field (gravity-model-mismatch): every
such record written before 0.6.36 is fitted again. With both at 0 or unset the theory is
SGP4XP bit for bit. A set fitted with them records `SDNAP_GRAVITY_TERMS`, and a call with other degrees refuses it
(`gravity-terms-mismatch`); `ingest_omm` refuses any such set. E2E: `test/ap-terms.e2e.mjs`.

The one-day tail (from 0.6.19) adds the resonant terms of degrees 5 to 31 to the one-day class below e 0.3, which
carried degrees 2 to 4 only. On made-up geostationary sets, AP against FFM with the same 20 x 20 field after a 72 h fit
went from 16.9-136.1 m to 8.5-11.1 m at day 7 at 12 longitudes; what remains is AP's analytic Moon (stack #446;
`test/one-day-resonant-tail.e2e.mjs`).

The slow set (from 0.6.25) carries, in a fitted low orbit, whatever MAXIMUM_TESSERAL_DEGREE the record states, every tesseral
term of degree 2 to 70 with j = 1 to 6 and |q| up
to 4 (from 0.6.27; q = 0 in 0.6.25) whose own angle drifts within 1.3 x 0.045 n at the epoch and whose size reaches 0.5 m
(along track through the mean motion, or from 0.6.27 once per revolution through the eccentricity vector). Each term is
tapered by its own current rate, and the output table holds the rest, so a term that drag moves through its band's edge
leaves no step. Gravity alone against FFM 70 x 70, 300 to 1,500 km, the worst day-5 error after a pinned fit went from 1,584 m to
218 m at i 53 and from 1,905 m to 423 m at i 97.6. On real 72 h fits, AP's day-5 forecast within 100 m of the full
numerical arm's went from 21 to 34 of 56 windows on laser spheres and from 28 to 42 of 112 on altimetry (0.6.25). SPEC 16.18
has the q != 0 part's measurements (`test/slow-set-partition.e2e.mjs`, `test/slow-set-taper.e2e.mjs`). Against a model
truth cut below degree 70, AP is compared like with like only with `sdnap_slow_degree_cap` set to the truth's degree (a test
hook; no flight reads it): against a 31 x 31 truth, a record at tesseral 31 flies slow terms of degree 32 to 70 that the
truth leaves out.

The zonal theory's constant radial term (from 0.6.43; SPEC 16.23). Held to the dynamics' mean rates, the theory's mean
radius on a near-circular orbit sat (R_E^4 / a^3)[J2^2 (199 c^4 - 80 c^2 + 25) / 32 - J4 (15/64)(35 s^4 - 40 s^2 + 8)]
above the true one (c and s the cosine and sine of i): about +11 m at i 87.5 and 420 km, -2.4 m at i 55, +42 m near the
equator. Every AP set with gravity terms takes that off its radius, at the same osculating energy (AP's output velocity
is not the rate of its positions, stack #549); SGP4XP is unchanged. Against FFM with J2 to J5 and the Sun and Moon,
fitted over 0 to 5 days, the offset left is -0.4 to +0.2 m on 42 near-circular cases from 300 to 1,400 km, at most 1.3 m
at e 0.05, 1.8 m at e 0.1 and 9.1 m at e 0.3 (the eccentric terms are stack #532; `test/zonal-radius-term.e2e.mjs`).

The field's census (from 0.6.32; SPEC 16.20) lists, for a set of mean elements, every tesseral term of the field to degree 70
whose size over a 5-day forecast reaches 0.5 m, with the weight each carrier the set builds holds of it and the term's
period. `test/field-census.e2e.mjs` sweeps 101 sets over every class and both sides of every switch. It fails on a term
carried twice, or carried nowhere outside the known holes, each of which is named with its issue.

The half-day tail adds every even-order resonant term through degree 31. Against FFM after a 72 h fit, the
day-7 errors are 60.1 m for the half-day case (a sample 1 h after a perigee; the day's RMS is 34 m along-track and
23 m radial), 419.4 m for Molniya with drag (its fitted drag coefficient; SPEC 16.11) and 244.3 m for GTO.
SPEC 16.6 and `test/results/heo-model-truth.json` give the fixtures and day-1, 3 and 7 RTN errors.

A set's branch (resonance class, the 1,100-minute regime, the eccentricity switches) is decided at its epoch and held
for the whole flight, so its output is continuous in time (SPEC 16.7); AP's elements are defined per branch, and the
module never differences or blends two branches (covariance, fit, epoch store). On the decaying-GTO fixture, whose mean
motion leaves the half-day band during the week, the day-7 along-track error is -22,912.217 m with the class held
against -20,534.324 m for the noncrossing companion (11.6 %; E2E bound 25 %). SPEC 16.7 defines the fixture. Through 0.6.11
these were -168,218.829 and -136,267.630 m (-167,341.326 m when 0.6.6 and 0.6.7 rebuilt their tables for the current
class): the epoch state at perigee came after the whole drag pass, which FFM, seeded there, still flies in part.

An AP flight ends at its decay (SPEC 16.25, stack #564). The decay comes when the set loses more perigee radius over a
revolution, or over the grid's next step where that is longer, than one density scale height at its mean perigee (drag's own
part of the perigee radius's rate, counted only where it lowers the perigee), or when its mean perigee falls under 100 km. That time is the record's, the same in any call order.
- Past it, a state has status 4 (ORBPRO_STATE_DECAYED).
- `propagate` and `propagate_epochs` answer the epochs before it, the block stating "decayed:<time>; <n> epochs after it
  refused", and refuse a call with none before it as `decayed:<time>`.
- `fit` refuses a set that decays inside its arc (`decayed-in-arc:<time>`) and, for an AP set whose mean perigee is under
  400 km, notes "decays at <time>" in the record's OD COMMENT when the set decays within 7 days of its epoch.
- Before this rule, #564's two seeds flew on to 31,250 km and 14.5 km of jump and under the surface. They now stop at
  136.5 km (136.7 km through 0.6.48) and 160.7 km, every state before that unchanged to the bit for a set at or below e 0.3 (`test/decay.e2e.mjs`);
  above e 0.3, the states in the last fifth of a 48 h interval whose next node lies past the crossing are answered from the
  interval's own grid (SPEC 16.25).

Above e 0.3 with drag, each perigee pass changes the osculating elements smoothly over the pass, at the pass's own width
in the mean anomaly (SPEC 16.12). Through 0.6.11 they changed in one step at perigee, so the output jumped there: by 42
to 77 m and 0.12 to 0.14 m/s on that fixture, and by 5.5 to 9.3 cm and 3.5e-4 m/s on Molniya. From 0.6.12 the steps are
at most 2 mm and 6e-7 m/s, the same as with drag off.

From 0.6.3 above e 0.3 and from 0.6.4 above e 0.05, to 0.6.10, a set outside every resonance class (class 0) near an m:1
commensurability with the Earth's rotation (4, 5, 6, 7, 8 rev/day, within about 4.5 % of n) flew without its slow tesseral
terms of q != 0: after a 72 h fit, 2.3 to 5.9 km along-track at day 7 at e 0.25, 1.5 km at e 0.1, 14.6 km at e 0.35 (stack
#393). From 0.6.11 the eccentric-anomaly grid leaves out only what the first-order table leaves out: 6 to 29 m at 4 to 7
rev/day, 220 m at 8 (the 8:1 resonance's shoulder) and 159 m at 6 rev/day e 0.35; orbits off those bands fly the same bytes.
The exact resonance (an order-m term slower than 1e-3 n, 8.05 rev/day at e 0.25: 1.27 km) is not carried. SPEC 16.11 has the
table; `test/class0-commensurability.e2e.mjs` pins it.

## The solid Earth tide (SPEC 16.14; `fit` and every flight)

From 0.6.20, `fit` under `$PCF` FORCES.SOLID_TIDES IERS_2010 (with the gravity terms) puts the solid Earth tide in AP's theory: the
degree-2 tide the Moon and the Sun raise, with the Love numbers of IERS 2010 per order and its frequency-dependent
diurnal band, the same field and model FFM reads. Averaged over the orbit it has a closed form, added to the mean-element
rates at every step; nothing is added at output time. The record states PERTURBATIONS.SOLID_TIDES_MODEL "IERS 2010" and
every flight reads it there. NONE, the default on the wire, leaves the tide out; an AP set with gravity terms fitted
without it says so in its OD COMMENT, and flies as before, bit for bit. On model truth (16 low orbits, 690 to 1,490 km,
FFM with the tide), the median day-5 error after a 72 h fit is 68.3 m without the term and 28.3 m with it (28.5 m with
no tide on either side); after a 24 h fit 64.0 and 48.1 m (48.2 m). On medium, geostationary and eccentric orbits the
tide moves the day-5 error of a 72 h fit by 0.07 to 6.5 m and the term carries it to within 0.03 m. The stated covariance does not
shrink. E2E: `test/solid-tides.e2e.mjs`.

## The radiation term Y0 (SPEC 16.13; `fit` and every flight)

For satellites whose solar panels track the Sun (navigation satellites), `fit` under `$PCF` FORCES.ECOM2 also solves
ECOM2's Y0, a constant acceleration (m/s^2) along the axis normal to the Sun and the satellite's radius, beside the
sphere's AGOM, on fits of 72 h or more above the drag; elsewhere it is held at FORCES.ECOM2.Y0_M_S2. Through 0.6.18 it
was held in the one-day (geosynchronous) class too. From 0.6.19 that class solves it: on real 72 h windows the share
within 100 m of the numerical propagator at day 5 went from 23 to 26 of 32 (geostationary: six windows on, three of C020
off, stack #457) and from 52 to 59 of 59 (inclined geosynchronous). The inclined row's medians rose from 27.0 to 31.3 m
at day 5 and from 38.7 to 56.4 m at day 7, because the Moon's position error (stack #446) leaks into Y0 there (SPEC 16.13). The record carries it as ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS ECOM2_Y0 (SOLVED_FOR
truthful) and every flight reads it there; nothing else carries it (an SGP4XP row of `sdnap_init_elements` or `sdnap_fit`
with mean_motion_dot not 0 is refused). The theory applies its averaged rates to the mean elements in 6 h blocks; a set
without Y0 flies as before, bit for bit. On the real 72 h windows of experiments headline-loop (0.6.13 against 0.6.15,
the table's own $PCF), medium Earth orbit's median at day 5 went from 35.1 to 15.1 m and the windows within 100 m of
the numerical propagator from 200 to 250 of 251; Galileo's from 111.1 to 29.2 m and from 20 to 42 of 42. 46 of the 293
windows are worse at day 5 by any amount between the two release tables (44 by more than 1 m in the radiation pull
request's own flight), the worst by 43 m. Not for spheres (laser geodetic satellites: 11 to 29 m at day 7) or
eccentric science orbits. A shorter fit can hold the Y0 of an earlier 72 h fit (FORCES.ECOM2.Y0_M_S2 = its VALUE):
medium Earth orbit 24 h fits went from 35.5 to 20.7 m at day 5. Y0 is not a covariance row. Cost: a record with Y0
takes 12 % longer to fly its first week (about 22 microseconds per 6 h block, 5.14 to 5.76 ms for a week hourly, a
Galileo record; under a load of 10 on 28 cores) and nothing more per state once its grid exists. E2E:
`test/radiation-y0.e2e.mjs`.

## AP's shadow (SPEC 16.15; every flight of an AP set with AGOM or Y0)

The sphere's averaged rates take the cylindrical shadow on the mean orbit. Its entry and exit are bracketed roots
solved to full precision; no tolerance decides between "sunlit arc" and "wholly sunlit". SGP4XP keeps section 4's
closed form, whose 1e-12 test decided that by rounding:
- where a boundary lay near an apse of the mean orbit;
- always at geosynchronous radius for near-equatorial sets.

Under a change of 1e-10 in the mean motion, flights in an eclipse season moved by up to 35 m (145 m on a transfer
orbit) instead of a linear drift of 0.2 to 0.6 m. They now move linearly to 0.9 mm in 7 days.

On real fitted records the same defect was worth 5 to 30 m. Two of the release table's 0.6.20 records (QZS-2G and
Galileo IOV 2, 72 h under ECOM2) were flown with the solid tide stated and with it removed. The tide's term is about a
meter. On 0.6.20 the two flights differed by 8.1 and 33.7 m at day 7; now they differ by 1.7 and 3.1 m, within 0.2 m
of the same flights with the shadow out of play.

The rates agree with the same sphere and cylinder averaged numerically over one revolution within 7.6e-7 of their
scale, through grazing and with a boundary at the perigee (`sdnap_ap_srp_rates`).

Not carried:
- the penumbra: the numerical propagator flies a cone, AP the cylinder; 0.3 mm to 5.7 cm in 7 days, by regime;
- section 4's sunlit-arc eccentricity-vector rate at high eccentricity (stack #466): 2.3 to 3.5 m at day 7 on a
  transfer orbit;
- the shadow's periodic motion in section 4's output-time terms (stack #472): in an eclipse season, up to 1.4 m radial
  RMS and a 3 to 8 m along-track span within the day on medium Earth orbit and geosynchronous sets.

AP's mean longitude over a sunlit arc takes the output-time Delta n over the whole revolution, as the output-time
terms map it (SPEC 16.16). Section 4's rate takes it over the sunlit arc only, and in season its response to the
sphere drifted along track against the same sphere flown numerically: 92 m geostationary, 77 m GPS-like and 116 m
Galileo-like at day 7. With 16.16 that is -3.7, -3.0 and 13.7 m; out of season nothing moves.

E2E: `test/radiation-shadow.e2e.mjs`.

## Radiation pressure of the long-period regime (SPEC 16.22; AP above e 0.3 at a period of 1,100 minutes or more)

From 0.6.41 an AP set with gravity terms whose epoch elements lie above e 0.3 at a period of 1,100 minutes or more takes
radiation pressure where its Sun and Moon already go (SPEC 16.19): the sphere's acceleration at the output's position,
in the light the satellite has over a one-step window about the moment (16.15's cylinder, crossed along the straight
line). SPEC 4's averaged rates and periodic terms are off there. Seeded, with J2 and radiation alone on both sides, a
TESS-like set's day-7 distance to the numerical propagator goes from 704 to 1,543 m to 139 to 210 m, by node. What
remains is AP's pressure constant, 4.5e-6 N/m^2 against the numerical propagator's 4.540e-6. Every other set flies bit
for bit.

The record states the model. Such a set with an area-to-mass above 0 writes `PERTURBATIONS.SOLAR_RAD_PRESSURE` "SPHERE
(AGOM) THROUGH THE OUTPUT MAP, CYLINDRICAL SHADOW OVER THE STEP" (with ", AND ECOM2 Y0 (ARNOLD ET AL. 2015)" when it
carries Y0, exactly when the record carries an `ECOM2_Y0` entry).
- A record of that regime with an area-to-mass above 0 that does not state it is refused, `radiation-model-superseded`.
  Every such record fitted before 0.6.41 is fitted again.
- These are refused `radiation-model-mismatch`: a record that states it outside the regime, or without an area-to-mass
  above 0; the Y0 text without an `ECOM2_Y0` entry; the plain text with one.
- A record outside the regime, or without an area-to-mass above 0, that states neither text reads and flies as before.

E2E: `test/long-period-radiation.e2e.mjs`.

## AP's Sun and Moon (SPEC 16.17; every AP flight and fit)

AP reads its own Sun and Moon; SGP4XP keeps SPEC 5's bit for bit. They are trigonometric series fitted to DE440 over
1990-2060 (`tools/ap-bodies-fit.mjs`, coefficients in `src/ap_bodies_series.inc`), evaluated at TT (UTC through ERFA's
leap seconds) and carried to TEME of date (IAU 2006 obliquity, IAU 2000B's largest nutation terms, the equation of the
equinoxes); flights read the quintic through their values at nodes 8 h apart on an absolute grid, which every set and
thread reads alike (each thread keeps the nodes it has read). Against DE440 over 2010-2035 the Moon is within
0.74 arcsec on average and 4.1 at worst (SPEC 5 as AP read it through 0.6.21: 91.5 and 377, 38 of it the time argument)
and 0.68 km RMS in distance; the Sun within 0.44 and 1.1 arcsec. The Moon's acceleration error at the geostationary
radius falls from 3.7e-9 to 3.7e-11 m/s^2 RMS. The Moon is within 0.74 arcsec on average inside 1990-2060, growing to 25
arcsec in the 1960s and 45 arcsec in the 2090s, and better than SPEC 5's throughout 1957-2100 (SPEC 16.17, by decade). Not
carried: the epoch-axis branches hold TEME of the epoch while the bodies are in TEME of date, about 1 arcsec at day 7
(3.5e-11 m/s^2 at the geostationary radius). A batch at one time (`plugin_propagate_batch`, `sdnap_propagate_soa`) is
SGP4XP's path: the shipped module's row store holds no AP set.
E2E: `test/ap-bodies.e2e.mjs` (407 stored DE440 samples).

## Drag atmosphere (SPEC 15; `fit`, `propagate`, `load_epochs` and `propagate_epochs`)

SGP4XP's drag is section 3's (Jacchia 1970 on the generic flux model) unless the call's `$PCF` FORCES selects another;
with no FORCES field off its default and no 'space_weather' or 'density_correction' frame the outputs are SGP4XP's bit
for bit (the conformance E2E reproduces XP 72dcf6005046 and the control 9ecfafcd9027 on this build). Under NRLMSISE-00
or `< 24 h` minimum spans, `fit` enables finite-difference Jacobian fallback and scales an unset LOG_NORMAL BTERM prior
median by mean altitude (`0.01` below `600 km`, `0.002` at `600-800 km`, `0.0005` at `>= 800 km`), with the sigma of
the log `10 ln 10` under NRLMSISE-00 at `800-1400 km` so that the arc, not the median, sets BTERM there (SPEC 12.8),
falling back to the band median's `ln 10` prior where that arc's BTERM is undetermined, moved far on a rough arc, or the
arc holds a gap or an along-track step. An arc of `71 h` or more under NRLMSISE-00 at or below e 0.3 is judged on its
perigee's height instead, and with the perigee at `600-2,500 km` takes median `0.008` and sigma of the log `10 ln 10`
with no fall-back: the arc decides BTERM, the fit weighing the data at their own sigma (SPEC 12.1). The band medians sat 2
to 40 times below the numerical propagator's fitted Cd A/m on every satellite measured. Against the numerical
propagator's own forecast of each window (the RMS distance over the day ending at day 5), the headline loop's 72 h fits
come within 100 m on 48 of 56 sphere windows (median 45.6 m), 105 of 112 altimetry windows (32.8 m) and 50 of 69 near
700 km (52.3 m), against 49, 99 and 50 of them (54.3, 50.3 and 58.8 m) with the data weighed at 1 km (SPEC 12.1). Such a
record states BTERM's sigma of the log by SPEC 12.8's width 1: 3.14 times the arc's part, at most the population's
spread of 1.09, named in a second COV_REALISM entry; the forecast maps the formal variance. A stated `FIT.DRAG_PRIOR` is
fitted as given, which is how a caller carries an object's prior from its previous fit.

One fit call carries each object's priors (SPEC 12.8). The two-fit sequence of a daily refit:

1. `fit` with `configuration` = the call's $PCF and one `ephemeris` $OEM per object; each object gives an $OMM and an
   $OBD whose BALLISTIC_COEFF_MODEL and AGOM_MODEL carry its posterior (`posterior sigma of the log s; posterior
   median B m^2/kg`, `posterior A +- sA m^2/kg`), BALLISTIC_COEFF_MODEL then the arc check (and the drag path where SPEC 12.8's fall-back is judged).
2. The next day, `fit` with `configuration` = the call's $PCF followed by one $PCF per `ephemeris` frame, in their
   order, whose FIT states only `DRAG_PRIOR` {MEAN B, SIGMA max(s, 0.3)} with `DRAG_PRIOR_FORM` LOG_NORMAL and
   `SRP_PRIOR` {MEAN A, SIGMA max(sA, 0.01)} with `SRP_PRIOR_FORM` GAUSSIAN_SIGNED; an object whose $PCF states none
   takes the band default. When
`FIT.MINIMUM_SPAN_HOURS < 24` and `FIT.DEFAULT_SPAN_HOURS >= 36` on a non-eccentric orbit, `fit` runs a two-stage
decoupled solve: Stage 1 solves `BTERM` and `AGOM` over `48-72 h`; Stage 2 solves the 6 mean elements over the trailing
`MINIMUM_SPAN_HOURS` (e.g. `17.1 h`, the `12 h` order-2 tesseral null) with `BTERM` and `AGOM` pinned to Stage 1 and the
epoch placed at the cutoff (`last_useable`).

| FORCES | Inputs | Drag density |
| --- | --- | --- |
| (none) | | Jacchia 1970, generic flux model (SPEC 3) |
| WEATHER_SOURCE RECORDS (or UNSPECIFIED with rows) | 'space_weather' `$SPW` rows | Jacchia 1970 on measured F10.7, F10.7a and Ap |
| ENABLE_DRAG true, ATMOSPHERE_MODEL NRLMSISE00, WEATHER_SOURCE RECORDS | rows | NRLMSISE-00 |
| as above, DENSITY_CORRECTION DCA_COMMON_MODE | rows, one 'density_correction' `$DCL` | NRLMSISE-00 x exp(s(t)), the open-DCA common mode |

The drivers on UTC day d: F10.7 of day d - 1, the 81-day centered mean and Ap of day d (propagator/ffm's convention),
the last row holding past the rows (WEATHER_EXTENSION UNSPECIFIED or HOLD_LAST); the rows must begin by the day before
the call's earliest day. s(t) is linear between the `$DCL`'s UTC nodes and held outside them (the producer's forecast
nodes carry its 48 h decay). A set fitted under NRLMSISE-00 carries `SDNAP_ATMOSPHERE_MODEL` (`"NRLMSISE00"` or
`"NRLMSISE00_DCA"`) in `$OMM.USER_DEFINED_PARAMETERS`; `propagate`, `ingest_omm`, `load_epochs` and `propagate_epochs`
refuse a set whose mark disagrees with the call's atmosphere (`atmosphere-mismatch`).

`test/atmosphere.e2e.mjs` (2026-10-26, this build):
- the default inert: no FORCES, FORCES written at every default, the atmosphere fields at their defaults: one set of
  bytes for propagate and for fit;
- NRLMSISE-00 at 240 drag-node points (120-980 km, 8 days of rows that move every day): analysis/density-calibration
  `evaluate` at the node's own geodetic point within 1.2e-9 relative, the drivers of the right days at every point;
  `drag_work` at the point carried to GCRF (ERFA's Earth-fixed axes) within 7.9e-5 (the two geometries);
- the open DCA: s = 0 gives the NRLMSISE-00 bytes; s = ln 2 gives the NRLMSISE-00 states with BTERM doubled, the same
  numbers over 3 days;
- a GPS-like set: the same bytes under every atmosphere (1e-20 kg/m^3 above 2500 km);
- 17 refusals by name, FORCES.THIRD_BODY_MAXIMUM_DEGREE and _ORDER among them;
- probe model 3: a constant s = ln 2 doubles model 2 within 2.2e-16, a varying s scales it by exp(s(t)) within 2.1e-13.

Cost (owner Mac, browser host, 20 sets at 400 km, 7 days on a 1 h grid): 0.17 ms per object-day for section 3 and for
Jacchia 1970 on rows, 0.91 ms with NRLMSISE-00.

Fit diagnostics (the fit-design study, not configuration): `sdnap_fit_epoch_diagnostic(p)` puts the fitted set's
epoch at the fit interval's first state (0, the module's), the state nearest its middle (1) or its last state (2);
`sdnap_fit_jacobian_diagnostic(1)` takes the finite-difference element and drag columns wherever the analytic ones stop
lowering the cost, in every fit (0: eccentric orbits only). `sdnap_atmosphere_probe` gives a drag node's density,
geodetic point and drivers at a TEME position: model 0 the theory's own, 1 Jacchia 1970 and 2 NRLMSISE-00 on `$SPW`
rows, 3 NRLMSISE-00 on the rows times exp(s(t)) of a `$DCL`.

## Maneuvers (DESIGN 5.1; method `maneuver`)

- The inverse map y = h^-1(x, t) (`src/events.inc`): the mean elements whose output state is x, by fixed-point
  iteration in equinoctial elements from the osculating ones (4 steps to 1e-9 km and 1e-12 km/s; where the output
  map's rounding floor stays above that, a few um at a circular orbit, the best of the 20 steps within 1e-6 km and
  1e-9 km/s).
- `maneuver`: an Earth SGP4XP `$OMM` across `$MNV` (0.0.4) burns: the impulse map (14) at EVENT_START_TIME, or a finite
  burn (EVENT_END_TIME or TOTAL_BURN_TIME) at its centroid with the eccentricity-vector and plane changes scaled by
  sinc(dL/2) (15); out: one post-burn `$OMM` per burn (epoch the centroid), one `$MNV` with PRE_EVENT and POST_EVENT
  (TEME, osculating elements, BALLISTIC_COEFF = 1/BTERM) and the CHARACTERIZATION from the Delta v, and with a 'grid'
  the TEME states across the burns. Refusals: maneuver-before-epoch, invalid-mnv, maneuver-failed.
  `test/maneuver.e2e.mjs`: at the burn the post set's state is the pre-burn state plus the Delta v to 1 um and 5e-9
  km/s for impulses of 1 mm/s to 1 m/s along U, V and W; a finite burn's eccentricity-vector increment is the
  impulse's times sinc(dL/2) to 1e-4 (10 and 60 minutes).

## Covariance realism

From 0.6.23 a record's covariance is a function of the record and the time alone. Through 0.6.22 it depended on what
the thread had flown before it (stack #491, SPEC 12.3). On real records, CryoSat-2's covariance asked right after
Ajisai's gave a position sigma of 336,299 m at hour 1, against 992 m alone. Asked in turn with other records, real
geostationary records moved by up to 0.5 %. The covariance's moved sets were also 4.75 % (geostationary) from themselves
flown on their own. `test/set-caches.e2e.mjs` holds the rule bit for bit.

Neither table earns a realism label. The covariance is positive semidefinite by construction and is not calibrated. The
band of SPEC 12.7 cannot establish realism: it accepts variance errors of 2.3, 0.2 and 0.01 on the three principal axes
together, a perfect covariance fails it with probability 0.65 at 20 independent forecasts and 0.15 at 200, and the noise
sizes were tuned on the windows tested. With the model otherwise exact, the fitted sigma of B and S is too small by
sqrt(3N - L), 46 for a 24 h arc sampled every 120 s. SDNAP's DRAG row (0.6.1, SPEC 12.5) is fitted per radial, in-track
and cross-track axis. On 0.6.42's own flights of the low table's records (tesseral 31, zonal 70), 8 of the 42 judged cells
(strong drag 2026, laser spheres, altimetry and near 700 km; three axes; days 1, 3, 5 and 7) have their median |z| inside
0.603 to 0.754. Too wide: cross-track outside near 700 km at day 1 and everywhere from day 3 (2.6 to 8.2 times from day
3), in-track outside strong drag, and the radial of the laser spheres from day 3 and of altimetry at days 3 and 5. Too
narrow: strong drag 2026's in-track at every day and its radial at days 5 and 7. SPEC 12.5 names each cell's cause. From
0.6.45 the DRAG row's drag share on a strong-drag record of the low table (its own stated drag rate at or above 2.41e-6 per
day, a smooth step in the rate from 7.59e-7) is 1.162 times the row's; a weak-drag record keeps the row's share, and every
record keeps its radial floor factor (SPEC 12.5, stack #568). That count does not
establish realism (SPEC 12.7). `node test/covariance-realism.e2e.mjs` prints every judged cell with its shares within 1
and 3 sigma, and the ISS figure.

Above the drag the ABOVE row is 5 to 1,000 times too wide on near-circular orbits and too narrow on TESS, Chandra and
commercial geostationary satellites with burns (stack #433, #444; SPEC 12.5 "Above the drag, by class"). A set above
the drag takes a row by class, from its own elements (HEO above e 0.3; geosynchronous under 1.5 rev/day, medium
Earth orbit under 4, the LAGEOS class above). The row applies only where the fit's data sigma and span lie within
those of the calibration fits; elsewhere the ABOVE row stands. Above the drag, s_d = k |AGOM| / a. The LAGEOS class
(LAGEOS-1, LAGEOS-2, LARES-2; 72 h fits to precise orbits; data sigma 2.43 to 2.76 m for AP, 58.8 to 76.9 m for
SGP4XP) is fitted. On its 32 windows AP's median |z| at days 1, 3, 5 and 7 goes from 0.001 to 0.24 to between 0.52 and
1.04, the 95 % coverage is 0.88 to 0.94, and no cell has more windows above 3 than the acceptance allows (max(as built,
1 % of the windows, 1)). The radial at days 1 and 3 stays somewhat narrow at the median (1.04, 0.95). Medium Earth
orbit, geosynchronous and HEO keep the ABOVE row for now. `test/covariance-above-classes.e2e.mjs` holds the
selection.

SGP4XP measurements below: 2026-10-25, module f20f5a059b76.

Held-out laser-ranged truth (ILRS combination orbits for LAGEOS and Etalon, NSGF arcs for the LEO set; GCRF): each
window a 24 h `fit` (USEABLE_START_TIME to USEABLE_STOP_TIME), then `propagate` of its set onto the reference epochs
of the next 3 days every 30 min, states and covariance lines from the module. d^2 = e^T P^-1 e on the position block,
against chi-square(3): mean d^2 / 3 (1), share inside the 95 % ellipsoid (0.95), median d^2 (2.366). The process
noise was fitted (SPEC 12.5) on 2026-02-01 .. 05-31 arcs of the other satellites; LAGEOS-1 never entered it, and
nothing was tuned after that fit. The experiment's windows are those its rows score (rows/slr-high.jsonl,
rows/slr-low.jsonl; one LAGEOS-1 2026 window lacks reference states). These cells were measured with `fit`'s former
default prior on BTERM (GAUSSIAN_SIGNED 0 +- 0.05) at the build named above, and were not re-measured under 0.2.0's
LOG_NORMAL default.


| Theory | Set | Day | Windows | Samples | Mean d^2/3 | Inside 95 % | Median d^2 | Position RMS (km) |
| --- | --- | --: | --: | --: | --: | --: | --: | --: |
| SGP4XP | LAGEOS-1, experiment windows (2025-09-28 .. 10-22) | 1 | 9 | 432 | 1.82 | 0.725 | 5.43 | 0.234 |
| SGP4XP | LAGEOS-1, experiment windows (2025-09-28 .. 10-22) | 2 | 9 | 432 | 1.93 | 0.738 | 5.49 | 0.417 |
| SGP4XP | LAGEOS-1, experiment windows (2025-09-28 .. 10-22) | 3 | 9 | 432 | 1.91 | 0.773 | 5.33 | 0.608 |
| SGP4XP | LAGEOS-1, 2026-02-01 .. 05-31 | 1 | 12 | 576 | 1.38 | 0.913 | 3.92 | 0.199 |
| SGP4XP | LAGEOS-1, 2026-02-01 .. 05-31 | 2 | 12 | 576 | 1.44 | 0.908 | 4.09 | 0.332 |
| SGP4XP | LAGEOS-1, 2026-02-01 .. 05-31 | 3 | 12 | 575 | 1.44 | 0.93 | 4.15 | 0.476 |
| SGP4XP | LAGEOS-2, Etalon-1, Etalon-2 (experiment windows) | 1 | 27 | 1296 | 1.34 | 0.909 | 3.21 | 0.0876 |
| SGP4XP | LAGEOS-2, Etalon-1, Etalon-2 (experiment windows) | 2 | 27 | 1296 | 0.84 | 0.994 | 2.17 | 0.138 |
| SGP4XP | LAGEOS-2, Etalon-1, Etalon-2 (experiment windows) | 3 | 27 | 1296 | 0.69 | 0.998 | 1.86 | 0.195 |
| SGP4XP | LEO set: Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2 (experiment windows) | 1 | 139 | 6621 | 1.09 | 0.98 | 3.01 | 0.518 |
| SGP4XP | LEO set: Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2 (experiment windows) | 2 | 137 | 5853 | 0.91 | 0.988 | 2.4 | 0.689 |
| SGP4XP | LEO set: Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2 (experiment windows) | 3 | 81 | 3189 | 0.76 | 0.992 | 1.88 | 0.746 |

Against the acceptance band of SPEC 12.7 (mean d^2/3 in [0.8, 1.25], 95 % coverage in [0.93, 0.97], per regime and day)
0 of the 12 SGP4XP cells is inside it; each is a measured limit, reported by name by the rigor suite.

Reproduce (needs /opt/data/sdn-archive/reference-states and the experiment's rows):

    node test/covariance-realism.mjs --set calibration --out test/results/covariance-calibration-sgp4xp.json
    node test/covariance-realism.mjs --set held-out --out test/results/covariance-realism-sgp4xp.json

## Memory and time

XP/AP keeps 12 sparse checkpoints and the latest bracketing pair per direction, with the stride chosen
at ingest to span roughly eight days each way. Checkpoints are filled lazily. A query in an already cached
bracket only interpolates; the first distant query integrates from the epoch. Once the intervening
checkpoints exist, a query within their span integrates at most one checkpoint interval. Beyond that span,
work grows with the time gap from the nearest preceding retained node. Checkpoint storage is bounded;
query work is not bounded independently of lead time.

An AP state is a function of its set and its time alone. The order of requests, the call they come in, the sets flown
between them, and whether the covariance is asked leave its bits unchanged (`test/set-caches.e2e.mjs`, nine orbits). A
store's AP set keeps its own caches and node runs from one pool, 256 MB (the module's default; no typed configuration
carries a budget yet), read by sdnap_cache_stats. SPEC 9 states how room is shared, the caches by part and the one
exception: a record that carries a covariance, through `propagate`, differs by 0.39 mm.

Memory per AP set flown: the module's own count (`sdnap_epochs_stats`), 250 made-up sets of each orbit, each flown a day
at 300 s, headline forces. A loaded set that has not been flown holds 0.3 KB.

| Orbit | Per set flown | Of it, caches from the pool | 30,000 such sets, without caches |
| --- | ---: | ---: | ---: |
| 500 km | 116 KB | 71.5 KB | 1.3 GB |
| 830 km | 103 KB | 64.2 KB | 1.1 GB |
| MEO (2 rev/day) | 158 KB | 19.8 KB | 4.0 GB |
| GEO | 40 KB | 33.3 KB | 0.19 GB |
| low orbit, e 0.052 (no tesseral terms) | 19 KB | 13.3 KB | 0.17 GB |
| transfer orbit, e 0.72 (no tesseral terms) | 26 KB | 15.8 KB | 0.30 GB |
| e 0.1 or transfer orbit, tesseral 31 | 4.8 to 10 MB | 16 to 18 KB | (stack #424) |

The instance's own growth agrees with these within 10 %. The default budget holds the caches of 3,664 sets at 500 km
and 13,252 in MEO; 1 GB holds 14,658 and 53,008 (SPEC 9 has every orbit). Sets beyond it fly on the thread's caches, with
the same states. A host that screens a catalog flies it object by object: at 10,000 sets at 500 km, 0.93 µs a state at
the default budget (0.85 times SGP4-XP), against 9.1 µs time-major (7.8 times; 2.25 µs, 1.9 times, when 1 GB holds them
all), measured at a 1-minute load of 10 to 14 on the 28-core build machine.

A stored set asked for its covariance also holds its bank (SPEC 14.4): 1,000 copies of a fitted 500 km record (tesseral 31,
zonal 70), each flown a day at 300 s, take 356 KB a set with the covariance against 122 KB for states alone, and the
store's count reads 353 KB. The bank's set 0 borrows the stored set's tables; through 0.6.55 it held its own, 391 KB a set,
and the count read 122 KB. Its nominal is the record's own set, so the store's covariance is `propagate`'s: equal to the
bit where both hold the same time (`test/store-covariance.e2e.mjs`). Through 0.6.55 the nominal was rebuilt from the
parameter vector, and the store's covariance could differ from `propagate`'s by more than the matrix's largest element.

Above e 0.048 with tesseral terms, each set holds a grid of its tesseral families of about 4.9 MB (with 0.6.14's slopes),
and a node grid while it is flown: 10 MB a set flown when every set has its own elements (4.8 MB when 100 sets share one
epoch grid). One process holds at most 256 such grids, so beyond them states are refused (stack #424).

AP's cost against SGP4-XP's and SGP4's by request pattern, measured on 2026-11-10 with `test/kernel-patterns.mjs`:

- made-up orbits;
- AP seeded with zonal 20, tesseral 31 at e 0.048 and below, and NRLMSISE-00;
- stock SGP4XP and SGP4 on the same elements;
- CPU time per state, the three theories taken in turn, 7 rounds;
- the 1-minute load printed beside each row.

Each figure is the ratio inside one pass (AP over SGP4-XP, then over SGP4), because a ratio survives a busy machine far
better than microseconds do.

**Many records stepped together, every record at each instant (`sdnap_epochs_at`, 60 s), at 2, 100, 1,000 and 10,000
records.**

| Orbit | AP over SGP4-XP | AP over SGP4 | 0.6.11, AP over SGP4-XP |
| --- | --- | --- | --- |
| 500 km | 1.1 / 0.7 / 1.3 / 7.8 | 8.1 / 2.8 / 4.1 / 28 | 36 / 11 / 11 / 11 |
| 830 km | 0.6 / 0.7 / 1.0 / 6.6 | 2.3 / 2.6 / 1.5 / 26 | 10 / 10 / 9.9 / 9.8 |
| MEO, 10,000 records | 1.1 | 4.1 | 2.6 |

At 10,000 low-orbit records the budget binds: the caches of 3,664 sets fit, and the rest fly on the thread's caches.
The same states object by object cost 0.85 times SGP4-XP. On the carrier lane's catalog mix (70 % low orbit) at 10,000
records: time-major 3.9 times SGP4-XP, object-major 1.5 times (the eccentric sets carry the excess).

**One record in random order over 7 days at 300 s.** AP over SGP4-XP is 0.2 at 500 km and 830 km, 0.4 in MEO, 0.03 at
GEO (SGP4-XP pays 27 to 32 µs a state there) and 19 on the transfer orbit. On 0.6.11 the same rows read 0.7 to 2.2, and
81 on the transfer orbit.

**One warm record in ascending order (W1)**, flown back to back against 0.6.12 in a cleared slot (load 15 to 25). The
figures come from the minimum and the steady rounds: single-threaded rounds swing by up to 5 times on this shared
machine, so a median here means little.

- 500 km about 13 % slower than 0.6.12, 830 km 5 to 7 % slower: about 0.82 of SGP4-XP's cost at 500 km, against 0.71
  on 0.6.12.
- MEO equal; GEO 2.3 times faster; the transfer orbit 1.7 times faster.
- What remains in low orbit: the bracket-anchored bake bookkeeping, about 6 % (stack #441), and the node re-evaluation,
  about 4 % (stack #439).

**The first state of a freshly loaded record**, warm instance: at 7 days, 25 to 28 % slower than 0.6.12 at 500 km and
GEO (#439: each node step evaluates node a's held rates again). Against SGP4-XP: 1.3 at 500 km at 7 days and 3.3 at
GEO. The transfer orbit's first state costs 4.8 to 19.6 ms, about 250 times SGP4-XP: its eccentric zonal tables, which
this cache rework does not touch.

**The full `propagate` call** in GCRF, 7 days at 300 s, one warm record, against 0.6.12:

- a record fitted with covariance is 11 % slower at 500 km (7.0 against 6.3 µs a state) and 15 % at GEO (19.3 against
  16.5);
- a seeded record is equal at 500 km and 13 % slower at GEO.

Above e 0.05 with tesseral 31 (perigee 600 km), a low orbit costs 18 to 20 times SGP4-XP, unchanged (stack #339).
Without the tesseral terms it costs 0.3 to 0.4 times.


## SGP4XP status

`src/xp_theory.inc` is the semi-analytic theory of SPEC.md (side A, closed-modules main ef9e2169): six mean equinoctial elements
integrated on an epoch-anchored grid (two mean periods, or 95 min at epoch periods of 1100 min and up; 38 min for AP with selected gravity replacements in the epoch one-day class; for an AP set above e0 0.3 in that regime at most 0.5 (1 - e0)^1.5 / n0, SPEC 16.10) by the
third-order Runge-Kutta step with its fallbacks, cubic Hermite between nodes, Brouwer J2 short-periodics to TEME.

| SPEC | state |
|---|---|
| 1 conventions, native elements | closed: native elements at epoch exact |
| 2 zonals | closed: SPEC 2's explicit J2-J5 rates (`src/xp_spec_terms.inc`, transcribed mechanically); section-2.2 rates to 1e-8..1e-10, mean-longitude rate to 6e-14..5e-13 |
| 3 drag | closed: SPEC flux model, J70 temperature, the density table of SAO SR 313 Table 6 as printed (pp. 82-87, `src/j70_table6.inc`, SHA-256 checked by `build.mjs`) with USSA 1976 below 90 km, the seasonal-latitudinal term (cos^2 of the geodetic latitude, equator north), SPEC arc, 13-point Gauss-Legendre average. SGP4XP applies the library's own values at 17 entries (`src/j70_library_overrides.inc`: height, temperature, printed and library value, and the spec vector each was observed through; 15 of them printed with a final zero); SDN-AP and the printed table are unchanged. 3.7 row vectors: 136/136 to 2.3e-9; 3.6: 19/19; 3.5: 329/360 (the rest: 12 equator-node round-off cases, 19 at 1e-7 to 4e-3 with no single-entry explanation) |
| 4 SRP, shadow | closed: the shadow by the closed-form boundary quartic with the 1e-12 test, the explicit averaged rates (wholly sunlit, sunlit arc) and the output-time terms; the 4 and 4.4 probes to round-off |
| 5 Sun, Moon, third body | closed: SPEC 5 quadrupole and octupole rates, the 5.4 output-time corrections, the long-period regime's instantaneous point masses; Moon/Earth 0.012300034 in every path (the 5.3, 6.3, 6.4 and 10 vectors to 1e-12; epoch states to 1e-11 km) |
| 6 resonance | closed: the 6.1 terms of each class, the 6.2 tesserals, the 6.3 rate equations with F, G held at epoch, the library's 6.4 functions; vectors 6 and 6.4 to 1e-12, 6.3 to 3e-13 except e = 0.7 (5e-7: the library's e^27 coefficients of the abs(q) = 1 series, which the SPEC does not give); 6.2: one side of five band edges differs (the SPEC's edges are approximate) |
| 7 VDS | the 1100-minute class (SPEC 5, 9) |
| amendment 5 (closed-modules main 726d6b2, e5bfbb7) | resonance: the integrator keeps the epoch class and F, G at e_0, i_0 (6.3; the 6.8 native elements to 7e-14, the 6.9 ones to 6e-10 in their rates); the class of the current n and F, G at the current e and i are what the library reports with its native elements, so `sdnap_xp_native` reports that (6.8 rates 8.5e-6, 6.9 to 6e-10). Drag: the cross-track node rate is -P B q A_r S_su with sin i Omega-dot = sin i times it, and varpi and lambda take (1 - cos i) of it (3.4 writes sin i Omega-dot without sin i and only the -cos i part): the 3.13 sets to 1.9e-9 in n-dot and 5e-9 in the elements over 7 days. USSA 1976 nodes unrounded (the 6.9 perigees at 66-71 km). Refusals node by node (8.4, 4 of 4): a node whose own rates fail ends the grid, a failed stage retries; SGP4XP serves positions below the surface. Shadow envelope: |S| within a factor of ten of 1e-12 both ways. |
| amendment 3 (closed-modules main b7327da) | SPEC 4's shadow as the library's closed-form sequence, step by step and in the stated operation order (`shadow_sequence`, `xp_shadow`: direction cosines from the SPEC 3.4 elements, quartic, monic and depressed, the resolvent cubic with zeros for a complex pair, z2/z3 then z1, the D1/D2 factors, the candidate order, the first two boundaries); the 4.7 vectors (seven sets, hourly for 7 days; the library's decision read from its n-dot against the module's sunlit and arc values at the library's own elements): 1,178 of 1,183 decisions agree (1,050 before), the five others with a second candidate within 1.5x of the 1e-12 test (rounding-limited: sets 2494, 3332 and 1130); the 4.5 GEO-band e 0.3 i 3 set likewise (second candidate 6.7e-13); 3.9 and 3.10 (the 160 km row at 2026 days 250.5-330.5) within 1e-7; conformance: MEO max 50.8 -> 25.1 m, VDS 69.9 -> 43.9 m, GEO 36.6 -> 43.9 m, medians unchanged |
| amendment 2 (closed-modules main bc34b69) | the 3.9 vectors (every table row 90-840 km, 2026 d282.5 and d292.5, four node right ascensions): drag n-rates to 1.4e-8 at all 65 heights after the library's 160 km / 1100 K entry (-11.859 against the printed -11.860; `src/j70_library_overrides.inc`), 5.2e-4 before; the 4.6 SRP vectors (rates at the nodes over 13 steps, the Sun at every stage time) to 2.4e-13, equinoctial elements to 2.6e-9; the 4.5 SRP sets to 4e-9 except the 1.0027 rev/day e 0.3 i 3 set (3.0e-4: the library's closed-form shadow boundaries, SPEC amendment 3 pending, not tuned) |
| 8 short-periodics | closed: epoch states of the long-period regime to 1e-11 km |
| 9 grid, step, interpolation | implemented as specified |
| 10 TEME km, km/s | closed |


## Measured (2026-10-23, owner Mac, Node, browser host)

Conformance measures agreement with the USSF library, not orbit accuracy. Orbit accuracy requires forward
errors against independent truth, with leads counted from the fit's end.

Conformance (`test/results/conformance.json`; the oracle, USSF Sgp4Prop 9.9, black box; 8 times per set over
7 days): SGP4 type-0 control, 1,200 sets: max 0.09 mm. SGP4XP, 10,200 sets: median 0.37 µm (LEO 49 µm, SSO
4.9 µm, MEO 0.18 µm, GEO 0.25 µm, HEO 0.19 µm, VDS 0.24 µm); maxima LEO 28.7 m, SSO 3.58 m, MEO 26.9 m, GEO
35.2 m, HEO 954 m, VDS 116 m. Accepted as inherent: 70 samples of decaying sets; 1,070 rounding-limited SPEC 4
shadow decisions (each envelope run on fresh nodes; the reference between the two runs, or within their spread
where the decisions go in mixed directions); 4 samples where the reference's 9.1.1.0 build is within 1 m of the
module and 9.9 is not; the equator node (29 of 29 within 1 m flipped); the refusal epochs (164 of 164 within 1 %
of the lifetime). No corpus sample is open. The corpus's times are random, so a window of a few milliseconds at a
perigee passage is met only by chance; a perigee-passage part (ten eccentric records, e 0.02 to 0.9, flown every 1 ms for
3 s either side of their first perigee passages, five at e 0.5 and above and two below, every sample held to 1 m) passes
on this build: 0 of its 210,035 samples over 1 m, the largest 5.2e-5 m. Through 0.6.37 it failed at 53 of them, in 10 of 35
passages of three records (e 0.5 at 4 rev/day: all five passages, 7 to 8 ms about 0.55 s before perigee, up to 5.3 km;
e 0.82 at 1 rev/day: one of five, 1 ms, 16,000 km; e 0.9 at 0.5 rev/day: four of five, 1 to 6 ms just after perigee, up to
134,000 km), where the library's states are smooth: section 8's Kepler solve ended there far from its root (SPEC 16.21,
stack #550). From 0.6.38 those solves take the bisection, and they are the only samples that differ from 0.6.37: 54 of the
part's 210,035 (the 53 and one of 1.8 cm), each closer to the library, and none of the corpus's 81,600 states, whose digest
is unchanged. `test/results/open-outliers.md` names the tail's causes
and the decisions that reproduce 9.9. The corpus is
synthetic (seeded). The E2E prints the sha256 of every module output; `--worst N` lists the largest differences
per regime; `--reproduce test/results/conformance.json` checks that a moved or rebuilt tree gives this run bit for
bit. Rebuilt on foundation/sgp4-str3 tree b55a681a (C3 and the delta-M term dropped for e <= 1e-4; modules
de85f301), the run reproduces bit for bit (XP 72dcf6005046, control 9ecfafcd9027): the XP theory does not use that
library, and the control corpus's one set at e = 1e-4 (NORAD 10393, 0.994 rev/day) is deep space, where neither term
applies.

Guard rule for changes that move last bits (coordinator, 2026-10-24): every per-regime median and maximum of the
conformance E2E may move by no more than 1e-6 m, or 1e-12 relative to that value, whichever is larger; otherwise
the outputs must keep their digest.

CPU: the drag nodes carry the geocentric latitude and the exospheric-temperature half angles as sines and cosines
(no asin, sin or cos): about 20 % off a LEO rate evaluation. Two further bit-changing speed-ups (SPEC 4 averaged
SRP trig by angle addition, `tools/spec2cpp.py --hoist-linear`, and the resonance angles by angle addition) are
kept out: they move the near-threshold GEO maximum by 3 to 12 m.


SGP4XP cost (32,770 sets, CPU per object, measured 2026-10-23): step 1.14 µs, 1-day jump 57.7 µs, 7-day 310 µs; a record is 3,344 bytes (`sdnap_record_bytes(4)`).

## Tests

The tests write only under their scratch roots (`test/lib/scratch.mjs`, never a home directory): `SDN_AP_TEST_SCRATCH`, or
`sdn-ap-test-scratch-<tag>` under the operating system's temporary directory, the tag a hash of the checkout's real path,
so two clones never share one. They build or compute what they read there: copies of earlier releases from git, test
builds. The propagator/ffm model truths alone go to a shared folder (`sdn-ap-test-scratch-shared`, or `shared` under
`SDN_AP_TEST_SCRATCH`): each file is named by the SHA-256 of FFM's build and every byte of its request, and written whole,
so any clone may read what another made. The model truth's constant space weather is
built by `test/lib/spw-constant.mjs` (`FFM_SPW_FIXTURE` names another file of such rows).

- `test/conformance.e2e.mjs` (the task's E2E): a randomized corpus across LEO, SSO, MEO, GEO, HEO and VDS
  over 7 days against the black-box oracle; per-regime maximum and median position difference; and the perigee-passage
  part: ten eccentric records flown every 1 ms for 3 s either side of each one's first perigee passages, five at e 0.5
  and above and two below (the oracle's own radius minima), every sample within 1 m (acceptance `perigeePassages`, kept
  apart from the corpus's digests; `--perigee-only` runs it alone, and `--corpus-only` leaves it out for a change that
  cannot reach SGP4XP's output solve, saying so in its output and summary). The oracle (the
  unmodified US Space Force Sgp4Prop library behind a black-box harness) is not in this repository:
  `SDN_AP_ORACLE_ROOT` names its directory (`SDN_AP_ORACLE_VERSION` its leg, 9.9 by default;
  `SDN_AP_ORACLE_SECOND` the other build for the reference-split class, 9.1.1.0 by default), and the E2E and
  `spec-vectors/verify.mjs` refuse without it. `--digest-only` checks the module's side of the stored run alone (the
  SGP4XP corpus's and the SGP4 control's output digests), no oracle; with `--dump FILE` it also writes the SGP4XP
  corpus's sets and every output state and status, so two builds can be compared state by state. The other E2Es end with that digest check
  (`test/lib/conformance-step.mjs`, about 9 s); the oracle comparison is this E2E's alone.
- `test/run-suite.mjs`: every E2E in parallel (14 at a time by default), a table of exit code and time per test at
  the end, logs under the scratch root; its KNOWN_DEFECTS list names tests that fail for an open issue.
- `test/rigor/run.mjs`: the rigor suite (`test/rigor/README.md`).
- `test/bench.mjs`: memory per object and µs per object for a 60 s step, a 1-day jump and a 7-day jump.
- `test/kernel-cost.mjs`: AP's CPU cost per state against SGP4's and SGP4XP's in the resident epoch store (one
  `sdnap_epochs_set_at` a state, TEME, 7 days at 300 s and 60 s, cold calls at 1 and 7 days) on made-up orbits from
  300 km to TESS-like, with `--diff` the largest position and velocity difference between two builds at every state
  over 30 days (in time order, reversed and shuffled).
- `test/kernel-patterns.mjs`: AP's cost against SGP4's by request pattern: many records stepped together and record by
  record, the first state of a fresh record at 0, 1 and 7 days, ascending, random and alternating-ends order, e 0 to
  0.3 in low orbit, and the public `propagate` in TEME and GCRF with and without a covariance.
- `test/output-frames.mjs`: the cost of a `propagate` state in TEME, GCRF and EME2000 (grids and explicit EPOCHS, and
  one-state calls), and with `--diff BEFORE.wasm` the GCRF and EME2000 states of two builds compared (TEME bytes must
  not move) and each build against the per-state IAU 2006/2000A chain with GMST82 in exact arithmetic.
- `test/ap-bodies.e2e.mjs`: AP's Sun and Moon (SPEC 16.17) against 407 stored DE440 samples of 2010-2035, turned to TEME
  of date by the module (the Moon within 8 arcsec and 6 km, RMS 2.5 arcsec and 1.5 km; the Sun within 2 arcsec), the
  cache against the series (0.01 arcsec, 1 m) and its smoothness at the nodes; SPEC 5's numbers printed beside them.
- `test/fit.e2e.mjs`: the GCRF rotation on the Vallado et al. 2006 TEME example (within 1 cm), the fit of one day
  of states in TEME, GCRF and ITRF (the latter two within 1 m of the first) and the `$OBD` against the `$OMM`;
  frames from the enumeration alone, refusals of undeclared and conflicting frames; `propagate` on 4-day TEME,
  GCRF and EME2000 grids; the default 48 h span; a size-prefixed `$OMM`; a Moon-centered `$OMM` refused
  (unsupported-center); an `$OMM`, a `$PCF` and an `ElementRow` that name the removed SDN-AP theory refused; the prior
  forms on NASA's ISS file of 2025-01-23, its first 24 h (a window from before plan XM's period, read from the local
  archive, `SDNAP_ISS_ARCHIVE`, SHA-256 pinned; NOT MEASURED without it): the stated GAUSSIAN_SIGNED 0 +- 0.05 ends at
  BTERM -7.2e-37 with a fit RMS of 880 m and gives the sets of 0.1.0's default byte for byte, LOG_NORMAL N(ln 0.01,
  ln 10) at 0.01106 m^2/kg with 481 m; sqrt(C_BB) = B x the posterior sigma of ln B (0.0198) within 2.2e-16; an
  unobserved AGOM (posterior sigma of its log 2.21) marked prior-limited; AGOM held at 0.01 under SRP_PRIOR 0.01 +- 1e-9
  and +- 1e-6 and stepped just above the 1e-6 unit; a BTERM prior left unset (no FIT table, a FIT table without a drag
  prior, a drag prior without its sigma, the forms written GAUSSIAN_SIGNED) giving the bytes of the fit that states
  that LOG_NORMAL, on the TEME example and on the ISS window, where it ends at BTERM > 0; the LOG_NORMAL refusals by
  name; `sdnap_fit` with drag_log.
- `test/fit-data-sigma.e2e.mjs`: SPEC 12.1, the fit's weighting (stack #324): above the drag AGOM recovered to 0.1 % on
  the module's own GPS-like and geostationary flights with the record's data sigma under 1 m; with a stated sigma the
  estimate pulled toward its prior by what the record's covariance implies; 2,400 km and 700 km sets keep UNIT WEIGHTS,
  a 2,600 km set states its sigma.
- `test/covariance-above-classes.e2e.mjs`: SPEC 12.5, above the drag by class (stack #433): on the module's own
  flights, a LAGEOS-class fit inside its calibrated data sigma and span states the LAGEOS row (AP and SGP4XP) with s_d
  = k |AGOM| / a; above that data sigma, over 24 h, and in the classes not yet fitted (HEO, medium Earth orbit) the
  ABOVE row; every record flies with its covariance.
- `test/covariance.e2e.mjs`: the covariance record of an SGP4XP fit (positive definite, its rows),
  `sdnap_covariance_at` against it at the epoch and against `propagate`'s TEME and GCRF covariance lines, the process
  noise against its closed form, and the refusals (no COVARIANCE, an SGP4 set, a malformed row).
- `test/epoch-store.e2e.mjs`: `load_epochs` on a synthetic history (an SGP4XP series of the module's own mean
  elements every 6 h with covariances, an SGP4 series, an aged set, a duplicate) and its counts, MAX_SETS_PER_OBJECT
  and THEORIES; selection against brute force and every handover's continuity for NEAREST / LATEST_BEFORE x SMOOTHSTEP
  / HERMITE; the blended covariance; `propagate_epochs` against the resident store bit for bit; and, from the local
  Space-Track archive, seven days of the catalog (its memory, selection and continuity on a sample; NOT MEASURED
  without the archive).
- `test/class0-commensurability.e2e.mjs`: SPEC 16.11 (#393): class 0 sets at e 0.25 at 4, 5, 6, 7 and 8 rev/day, at 4.5 and
  6.5, and at 6 rev/day e 0.35, each a 72 h fit flown 7 days against FFM 2.3.0 (named by its SHA-256), day-7 along-track under
  a bound. `test/class0-exact-resonance.e2e.mjs`: the exact 8:1 resonance (8.05 rev/day, e 0.25), a known defect (#419).
- `test/branch-at-epoch.e2e.mjs`: SPEC 16.7 and 14.3: continuity in time at the five class limits and the regime limit,
  the covariance about a limit, a fit 3e-8 from a limit, a fit refused fit-at-branch-limit at a class limit and one held
  on one side of the eccentricity switch at 0.3 (at or under 0.3 from below, its OD COMMENT, flown back to its stated
  RMS), and the epoch store's step between two sets on different branches; at e 0.3 a set at exactly 0.3 blends with one
  the next double down (one branch) and not with one the next double up; inside a carried span its set alone (two
  forecasts never blend), the step to the theory at the span's end.
- `test/perigee-drag-continuity.e2e.mjs`: SPEC 16.12: no step at perigee above e 0.3 with drag. On the transfer-orbit
  fixture and on Molniya, at three perigees each, the position step stays at most 1 cm and the velocity step at most
  1e-5 m/s (5 ms states); within 10 min of perigee the 10 s jump detector stays within 1.5 times the drag-off flight's.
- `test/egrid-continuity.e2e.mjs`: SPEC 16.11: the first-order families' grid in E read continuously with its slope. On
  the transfer orbit and on Molniya with drag off, the jump detector within 600 s of perigee stays at most 0.08 m at 10 s
  and 5 mm at 1 s (0.395 and 0.031 m on the transfer orbit through 0.6.13, kinks about 80 s apart).
- `test/maneuver.e2e.mjs`: the `maneuver` method (impulses, finite burns, the `$MNV` record), the fit of an arc across
  a burn (the span rule's shortening, fit-implausible), `$PCF` refusals, and the method's refusals.
- `test/exports.e2e.mjs`: the display exports, each against its inverse.
- `test/atmosphere.e2e.mjs`: the drag atmosphere of SPEC 15 (above).
- `test/wasmedge-parity.mjs`: `propagate`, `fit`, `propagate` on a GCRF grid, `maneuver`, `propagate_epochs`,
  `propagate` and `fit` under NRLMSISE-00 times the open DCA (SPEC 15), and a fit under LOG_NORMAL priors on BTERM
  and AGOM, through the browser host and native WasmEdge 0.16.4: identical bytes.

AP one-day integration uses a 38-minute step: the registered GEO/IG day-7 differences to a 95/16-minute
reference are 4.591/4.140 m, down from 72.534/65.087 m at 95 minutes, at 1.133x flight cost. On new AP6
cutoffs (18 GE, 36 IG windows), day-3 median forward errors change from 46.658/34.989 to 41.876/33.328 m;
day-7 GE worsens from 217.657 to 235.913 m. Numerical convergence does not establish uniform forecast
improvement. SPEC 9 and 16 give the fixtures, shared-truth limitation and all leads;
`test/geo-step-convergence.e2e.mjs` enforces <5 m, <2x cost and the unchanged XP digest.

From 0.6.16 an AP set in the long-period regime above e0 0.3 steps at most half its perigee pass's time scale,
0.5 (1 - e0)^1.5 / n0: 8.2 min on a THEMIS-like orbit (e 0.82), where the 38-minute step left 174 m of the theory's own
integration error at day 5 (0.08 m now), and 919 m against FFM model truth with the Sun and Moon (123 m now; SPEC 16.10,
`test/long-period-perigee-step.e2e.mjs`, stack #445). Sets at e0 0.3 and below are unchanged.

When the local Hansen expansion is selected (SPEC 6.4), the original AP resonance coefficients are exact at the epoch eccentricity
to numerical-integral precision and third order within |de| <= 0.02. Measured per-term relative truncation
errors are 1.1e-4 at |de| = 0.01, 1.5e-3 at 0.02, and 4-15% at 0.05; these are not uniform error bounds.
SPEC 6.4 and 16.2 distinguish this approximation from the added high-degree half-day tail.

Every AP set carries its epoch-axis states to TEME of date by M(t) M(t0)^T, in fitting and propagation alike
(SPEC 16.4). That includes the long-period regime's class 0 sets, the sets with epoch periods of about 1,795
minutes and more. A covariance's sigma sets take the same rotation as their nominal. SGP4XP takes no such
rotation. `test/heo-frame.e2e.mjs` prints the TESS replay's every window and the four synthetic HEO fixtures.

AP adds each third body's tidal terms of degree 4 to 10 to the averaged rates of orbits with periods below 1100 min
(SPEC 16.8; XP's stop at degree 3). On the eleven already-read AP6 windows of each (exploratory), the median paired
day-3 AP-minus-numerical-reference error falls from 26.64 to 22.42 m on Etalon-1 and from 36.39 to 23.55 m on
Etalon-2; LAGEOS-1, LAGEOS-2 and LARES-2 move from 15.44, 11.89 and 15.04 m to 14.10, 12.24 and 11.00 m, and IG and
GE are unchanged (`test/etalon-resonance.e2e.mjs`).

AP sets keep the fit's full precision; SGP4XP sets keep the two-line lattice the Space Force library reads (SPEC
16.9). One unit of an angle's last digit is 44 m at 25,500 km, and that rounding, not the 12-hour class's tesseral
terms, was the cross-track floor of medium orbits: on an Etalon-like orbit without Sun or Moon the day-7 cross-track
RMS falls from 22-23 m to under 0.8 m and the along-track RMS to under 7 m. On the already-read AP6 windows
(exploratory) the day-3 errors fall to 10.12 and 9.74 m paired against the numerical reference on Etalon-1 and -2,
and the medians to 7.81 m (LAGEOS-1), 6.78 m (LAGEOS-2), 9.73 m (LARES-2), 17.10 m (IG) and 45.86 m (GE)
(`test/twelve-hour-class-terms.e2e.mjs`).

AP takes the third bodies' short-period terms of degree 2 to 10 by quadrature instead of SPEC 5.4's closed form, which
averages over the eccentric anomaly where the rates average over the mean longitude: against a numerical integration
over one orbit the closed form is off by up to 298 m at e 0.72 and the quadrature by under 0.1 m (SPEC 5.4). With it
the degree 4 to 10 terms apply at every eccentricity. On the e 0.72-0.74 model-truth fixtures the day-7 whole-day RMS
(along-track/radial) falls from 228/85 to 84/75 m (half-day), 687/391 to 150/176 m (Molniya) and 232/60 to 158/105 m
(12 hours at 55 deg); GTO moves from 885/860 to 961/935 m, within 3 % of its error with no Sun or Moon on either side.
On the already-read AP6 windows (exploratory) Etalon-1 and -2 fall to 6.64 and 7.58 m paired against the numerical
reference, and LAGEOS-1/2, LARES-2, IG and GE stay within 0.03 m (SPEC 16.6, 16.8,
`test/third-body-short-period-eccentric.e2e.mjs`). A propagation costs 1.6-12.0 ms per object-day on a 1 h grid and
52-86 ms on a 1 min grid (1.4-12.3 and 51-66 ms before; SPEC 16.8).

AP's half-day class (1.604 to 2.406 rev/day) steps at most a 32nd of the period of its resonant angle lambda - 2 theta
instead of two revolutions, which away from the commensurability (GTO at 2.40 rev/day: 2.5 days) do not resolve the
class's terms (SPEC 16.10). Against the class stepped at 23.75 min the step is within 0.065 m RMS over one GTO orbit
(two revolutions: 84.5 m). On FFM model truth the GTO fixture's day-7 whole-day RMS (along-track/radial) falls from
960.82/935.27 to 419.32/455.90 m and the 500 km perigee fixture's from 605.15/576.31 to 295.44/304.96 m; the half-day,
Molniya and 12-hour 55 deg fixtures are unchanged bit for bit. On the Etalon-like synthetic orbit the day-7
along-track RMS falls to 1.65-3.22 m at the four nodes (1.77-6.76 m at 0.4.11); on the already-read AP6 windows
(exploratory) Etalon-1 and -2 move from 6.64 and 7.58 to 6.72 and 7.74 m and LAGEOS-1/2, LARES-2, IG and GE not at all
(`test/gto-geopotential-perigee.e2e.mjs`). What remains on GTO grows with the field's degree (233 to 628 m from 4x4 to
70x70 without Sun or Moon): high-degree terms at perigee that AP does not carry. A propagation on a 1 h grid costs
16.2 ms per object-day on GTO and 10.5 ms on Galileo-like orbits (12.0 and 5.8 before).

Above e 0.3 AP's zonal tail carries every long-period term (w = l - 2p for every p, G = O(e^|w|)) and its first-order
tesseral families of degree 2 to 12 are a grid in the eccentric anomaly, complete in j, not a series in M (SPEC 16.11): the
term table builds none of the general set there (`src/tesseral.inc:324`, `for (int l = 2; l <= degree && !wide; ++l)`) and
keeps only the near-resonant terms above degree 12 (`src/tesseral.inc:323`); the families are the grid of `wide_grid_build`
(`src/tesseral.inc:750`; kSpCap = 12 at `src/tesseral.inc:35`). From 0.6.4 the tesseral switch is by resonance class (`wide_set`,
SPEC 16.11): a set in no resonance band (low orbit, the LAGEOS band, orbits below 0.8 rev/day) flies the grid above e 0.05,
where the first-order set fails the one-day line against the full field and the grid passes it (Ajisai, LAGEOS-1, LAGEOS-2 at
e 0.05 to 0.2) at 88 to 408 ms less per flight; the one-day, half-day, eight-hour and sixteen-hour classes keep 0.3 (the grid
does not reach their resonant share and costs 70 to 167 ms more). The zonal tail, the perigee drag passage and the fit's wide
blocks keep 0.3 in every class. Every flight outside "class 0 with 0.05 < e <= 0.3" is byte-identical to 0.6.3. On FFM model truth
the GTO fixture's day-7 whole-day RMS (along-track/radial) falls from 419.32/455.90 to 204.15/133.92 m, the 500 km
perigee fixture's from 295.44/304.96 to 109.46/70.85 m, the half-day's from 84.22/75.28 to 34.33/23.12 m and the 12-hour
55 deg's from 158.02/105.47 to 67.25/25.32 m. Molniya with drag, its coefficient fitted, rises from 149.82/175.90 to
291.41/219.72 m: the fit takes 0.0457 m^2/kg against the truth's 0.044 and the along-track error grows quadratically;
with the coefficient pinned at the truth it is 144/120 m (0.4.14: 159/92). The 4x4 case of SPEC 16.10 compared XP's J5
with a truth without it; with J5 zero on AP's side it is 98.9 m (0.4.14) and 89.6 m. Against independent integrations
over one GTO orbit the new terms agree within 0.0002 m per element (`test/gto-high-degree-perigee-terms.e2e.mjs`). A
propagation on a 1 h grid costs 37.0 ms per object-day on GTO, 30.3 on the half-day and 30.5 on Molniya (24.6, 16.3 and
18.2 before). The method is fixed once per flight from the fitted epoch elements (`src/tesseral.inc:264`, `wide_set`:
kWideE = 0.3 in the resonance classes, kWideENonResonant = 0.05 in class 0), so no flight switches method in flight. Against an independent full-force reference (propagator/ffm 2.2.1,
the same field, DE440 Sun and Moon, in vacuum; orbit-accuracy-experiments e53a8ef0e1261523f5d28a617b9a5177d629e4f2,
results/ap-truth/tesseral-all-regimes/table.json) a set fitted at e 0.29 and flown one day is 22 m RMS (41 m at most) for a
one-day orbit, 27 m (55 m) for a half-day Molniya-like orbit and 25 m (56 m) for GTO; fitted just above 0.3 it is 10 m RMS
(12 m), 26 m (45 m) and 15 m (29 m). Two sets fitted on either side of 0.3 can differ by about the first-order set's own
error, the set above 0.3 the nearer to the reference (SPEC 16.11).

Above e 0.3 AP's drag is evaluated per perigee passage (SPEC 16.12): the mean of the passages before and after the
rate's time, each node at the Earth angle and date of its own time on the pass, over the whole orbit, with the pass's
short-period steps in the output so the osculating elements step at perigee where the mean elements ramp. From 0.6.6
the output takes those rates from three evaluations per stretch of a revolution inside one grid interval (SPEC 16.12),
not one at every state. At e 0.3 and
below, and without drag, propagations are 0.4.15's byte for byte. Seeded at the truth's drag coefficient with the Sun
and Moon off, AP's drag energy per pass over FFM's goes from 0.9840, 0.9907 and 0.9958 to 1.0026, 0.9991 and 0.9987
(Molniya, GTO, 500 km perigee GTO), and the drag theory's own day-7 along-track error with the Sun and Moon on from 594 m,
99.6 km and 1,118 m to 26.5 m, 3.26 km and 32.0 m. Molniya with the coefficient pinned at the truth falls from 165.9 to
70.9 m along-track at day 7 (AGOM pinned at 0; 78.3 m with AGOM fitted, 0.4.15: 144 m). Against the module's
independent integral over one orbit the drag's rates agree within 0.023 m RMS per element. A 72 h arc at e 0.74 does
not separate the drag coefficient from the third bodies' and the field's residuals (SPEC 12.8): Molniya's fitted case
moves from 291.41/219.72 to 276.44/208.33 m and the 500 km perigee GTO's from 322.5 to 736.2 m along-track on a wide
prior; seven days determine the coefficient to 0.5 %, and carried into the next 72 h arc with the sigma of the log at
least 0.005 they give 103.5 and 87.7 m with the coefficient within 0.5 %. Above e 0.3 the band default's median follows
the perigee's altitude (`test/drag-high-eccentricity.e2e.mjs`). With drag a propagation on a 1 h grid costs 22.5, 34.9 and 31.5 ms
per object-day on Molniya, GTO and GTO-500 (20.5, 27.1 and 25.8 before) and on a 1 min grid about twice 0.4.15's, the
output's short-period steps evaluating the drag's rates at every sample.

Above e 0.3 with the perigee below 2,500 km and no stated drag prior, `fit` takes the longest arc the ephemeris holds up
to 7 days (SPEC 12.8): Molniya's day-7 along-track goes from 279.5 m on a 72 h arc to 135.5 m with the coefficient
within 0.46 %, the 500 km perigee GTO's from 736.2 to 291.3 m within 0.28 % (158.8 m with the coefficient pinned at the
truth). On a shorter arc the determination names the coefficient not separable and widens its posterior from the RMS
floor (Molniya 72 h: 22.4 % against the formal 1.08 %), the set's covariance with it; the truth lies within one sigma on
both fixtures. At e 0.3 and below fits are 0.4.16's byte for byte (`test/high-e-fit-arc.e2e.mjs`).

Every fit's $OBD BALLISTIC_COEFF_MODEL states an arc check: the arc's hours, its largest gap, and an along-track step
test on the fit residuals (per-revolution means against a quadratic and a hinge: the velocity step, its time and F;
flagged at 0.002 m/s and F 100); where the fall-back is judged it and the $OMM COMMENT also state the drag path taken
(SPEC 12.8). After a 72 h fit
under NRLMSISE-00 at 800-1400 km on the band default (since the default of a 71 h arc, an orbit above e 0.3) the fit is redone under 0.4.11's band-median prior when BTERM's
posterior sigma of the log exceeds 0.5, or BTERM is more than 3 sigmas from the median while the fit RMS exceeds the
band's model-truth median (15.16 m) by 25 %, or the arc is flagged; B, k and the median come from the model-truth
fixtures, where the fall-back is taken only where BTERM is undetermined (within 0.7 m). On AP8's read altimetry windows
the fall-back had returned Sentinel-3A 2025-10-15 to 0.087 km at day 3 (0.4.17: 0.312) and Sentinel-3B 2025-10-25 to
0.113 km at day 7 (1.335); the default of a 71 h arc, which has no fall-back, gives 0.314 and 1.344 km, and against
0.4.11 the median day-3 change is -85 % on HY-2C, -92 % on HY-2D, -73 % on Jason-3, -48 % on SWOT, -35 % on SARAL and
+1.4 % on CryoSat-2 (stack #470). A 0.5 m/s step after the arc leaves the fit bit for bit; one inside it leaves a fit
RMS of 28 km and BTERM undetermined (`test/drag-prior-fallback.e2e.mjs`).
