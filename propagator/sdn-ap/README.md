# sdn-ap-propagator

General-perturbations propagation of whole catalogs in one isomorphic WASM module (browser and WasmEdge), with two
theories. The bundle keeps its name; the SDN-AP theory it once carried was removed (owner 2026-10-25), and an `$OMM` whose
MEAN_ELEMENT_THEORY is neither SGP4 nor SGP4XP, a `$PCF` whose THEORY is not UNSPECIFIED, SGP4 or SGP4XP and an
`ElementRow` of theory 16 are refused.

| Theory | Sets | Source |
|---|---|---|
| SGP4 | type 0 | SPACETRACK REPORT No. 3; Vallado et al. 2006 (AFSPC mode) |
| SGP4XP | type 4: BTERM, AGOM (m^2/kg) | the US Space Force SGP4-XP theory, clean room (side B): the public change list, then SPEC.md section by section |

License: Apache-2.0 ([LICENSE](LICENSE)), the SGP4/SDP4 base included (written clean room from Spacetrack Report No. 3
and the corrections AIAA 2006-6753 documents); [NOTICE](NOTICE) names what the build compiles and reads.

Build: `npm run build` (module SDK compiler lane, clang `wasm32-wasip1-threads`, no exception handling) writes
`dist/isomorphic/module.wasm`; it reads ERFA from this repository. No build data is fetched.

## Interface

- Propagator ABI: `plugin_init_omm`, `plugin_init`, `plugin_propagate`, `plugin_propagate_batch`,
  `plugin_entity_count`, `plugin_destroy`; Earth-fixed meters. `OrbProOMMRecord`s are read as SGP4XP sets
  (BTERM in `bstar`, AGOM in `mean_motion_ddot`) unless `sdnap_set_omm_theory(0)` selects SGP4.
- Batch, structure of arrays: `sdnap_init_elements(rows, count)` (112-byte `ElementRow`s, split Julian epoch, theory per
  row: 0 SGP4, 4 SGP4XP; any other theory is held refused); `sdnap_propagate_soa(jdWhole, jdFrac, first, count, frame,
  out, status)` and `sdnap_propagate_minutes_soa(minutes, first, count, out, status)` write six planes (x, y, z, vx, vy,
  vz) of `count` doubles, TEME km and km/s or Earth-fixed m and m/s. `sdnap_threads(n)` starts the pool; results are
  the same bytes at any thread count.
- Display quantities (the module's own conversions; `test/exports.e2e.mjs` checks each against its inverse):
  `sdnap_mean_elements_at(index, minutes, out)` the mean a (km), e, i, RAAN, argp and M (deg) of an SGP4XP row at
  minutes from its epoch (an SGP4 row is refused); `sdnap_osculating_elements(r, v, out)` the osculating elements of a
  TEME state about the Earth theory's GM and `sdnap_state_of_elements(whole, frac, el, frame, out)` its inverse;
  `sdnap_mean_motion_of(a, e, i)` the mean motion (rev/day) an SGP4XP set carries for a mean a (km), the inverse of
  `sdnap_mean_elements_at` (a round trip within 1e-12 relative from LEO to GEO); `sdnap_frame_to_uvw(r, v, vec, out)` a
  vector's radial, in-track and cross-track components and `sdnap_uvw_to_frame` its mirror.
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
  covariance mixture where sets carry COVARIANCE. Exports `sdnap_epochs_count`, `_stats` (records, kept, aged, capped,
  by THEORIES, not centered on the Earth, same-epoch duplicates, bytes), `_series`, `_select`, `_set_at`, `_at` (a
  batch of series at one time, TEME or Earth-fixed, with the covariance); `propagate_epochs` gives the same for a
  snapshot and a grid in one stateless call. Seven days of the Space-Track catalog (2026-10-07 .. 13, 228,129 records,
  13 frames of at most 4 MiB) load in 0.1 s into 30,931 series and 106,813 sets, 17.0 MiB (577 bytes a series) before
  any series is propagated.
- Configuration (SDS 1.271.0, `$PCF` 1.0.5): `propagate`, `fit` and `maneuver` take one `$PCF` on their required
  `configuration` port. Each reads THEORY and its own tables (propagate and maneuver: OUTPUT, FORCES;
  fit: FIT, FORCES); another method's tables are left to it. Fields left unset take the defaults
  schema/PCF/main.fbs documents, each this module's own, so a table whose fields are all unset (or written at their
  defaults) reads as an absent one; a field set to a value the module cannot apply is refused by name
  (configuration-refused, "TABLE.FIELD: why"; configuration-missing without one). THEORY: propagate and maneuver read
  UNSPECIFIED as each set's own (another value must match it); fit fits SGP4XP (UNSPECIFIED, SGP4XP); FFM and
  KEPLER are refused. FORCES carries an empty EPHEMERIS_SOURCE (the theories' own analytic Sun and Moon series): the
  averaged theories apply their own forces; on `fit` and `propagate` it also selects SGP4XP's drag atmosphere (SPEC 15,
  below), and any other FORCES field is refused by name. INTEGRATOR is refused
  (the averaged theories integrate on their own grid), EVENTS when not empty. FIT (every field) and OUTPUT (TEME,
  GCRF or EME2000, at most 500,000 states) apply with their documented ranges.
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
  down to FIT.MINIMUM_SPAN_HOURS (24 h), and refuses an Earth arc still beyond it (fit-implausible); an eccentric block's
  fits (e > FIT.ECCENTRICITY_THRESHOLD) take the theory's one-sided differences for the element and drag columns where
  no step along the analytic Jacobian lowers the cost.
- Third-party code, read from the open modules repository (this repository vendors nothing) and pinned by SHA-256
  in `build.mjs` (the build fails on any other bytes; `dist/build-provenance.txt` records the path, commits and
  hashes): ERFA (BSD-3-Clause, derived with permission from IAU SOFA; license carried in `LICENSES/ERFA.txt` and
  `dist/LICENSES/ERFA.txt`); NRLMSISE-00, the public-domain C port in `third_party/nrlmsise00` (the files at modules
  fe5e4ca0; propagator/ffm, analysis/density-calibration and analysis/od compile the same files, and a change there
  is taken here by updating the pin).

## Drag atmosphere (SPEC 15; `fit` and `propagate`)

SGP4XP's drag is section 3's (Jacchia 1970 on the generic flux model) unless the call's `$PCF` FORCES selects another;
with no FORCES field off its default and no 'space_weather' or 'density_correction' frame the outputs are SGP4XP's bit
for bit (the conformance E2E reproduces XP 72dcf6005046 and the control 9ecfafcd9027 on this build). The fit estimates
BTERM and AGOM the same way under every atmosphere.

| FORCES | Inputs | Drag density |
| --- | --- | --- |
| (none) | | Jacchia 1970, generic flux model (SPEC 3) |
| WEATHER_SOURCE RECORDS (or UNSPECIFIED with rows) | 'space_weather' `$SPW` rows | Jacchia 1970 on measured F10.7, F10.7a and Ap |
| ENABLE_DRAG true, ATMOSPHERE_MODEL NRLMSISE00, WEATHER_SOURCE RECORDS | rows | NRLMSISE-00 |
| as above, DENSITY_CORRECTION DCA_COMMON_MODE | rows, one 'density_correction' `$DCL` | NRLMSISE-00 x exp(s(t)), the open-DCA common mode |

The drivers on UTC day d: F10.7 of day d - 1, the 81-day centered mean and Ap of day d (propagator/ffm's convention),
the last row holding past the rows (WEATHER_EXTENSION UNSPECIFIED or HOLD_LAST); the rows must begin by the day before
the call's earliest day. s(t) is linear between the `$DCL`'s UTC nodes and held outside them (the producer's forecast
nodes carry its 48 h decay). The ABI exports and the epoch store keep section 3. A set fitted under an atmosphere
describes the orbit under that atmosphere and carries no mark of it.

`test/atmosphere.e2e.mjs` (2026-10-26, this build):
- the default inert: no FORCES, FORCES written at every default, the atmosphere fields at their defaults: one set of
  bytes for propagate and for fit;
- NRLMSISE-00 at 240 drag-node points (120-980 km, 8 days of rows that move every day): analysis/density-calibration
  `evaluate` at the node's own geodetic point within 1.2e-9 relative, the drivers of the right days at every point;
  `drag_work` at the point carried to GCRF (ERFA's Earth-fixed axes) within 7.9e-5 (the two geometries);
- the open DCA: s = 0 gives the NRLMSISE-00 bytes; s = ln 2 gives the NRLMSISE-00 states with BTERM doubled, the same
  numbers over 3 days;
- a GPS-like set: the same bytes under every atmosphere (1e-20 kg/m^3 above 2500 km);
- 15 refusals by name.

Cost (owner Mac, browser host, 20 sets at 400 km, 7 days on a 1 h grid): 0.17 ms per object-day for section 3 and for
Jacchia 1970 on rows, 0.91 ms with NRLMSISE-00.

Fit diagnostics (the fit-design study, not configuration): `sdnap_fit_epoch_diagnostic(p)` puts the fitted set's
epoch at the fit interval's first state (0, the module's), the state nearest its middle (1) or its last state (2);
`sdnap_fit_jacobian_diagnostic(1)` takes the finite-difference element and drag columns wherever the analytic ones stop
lowering the cost, in every fit (0: eccentric orbits only). `sdnap_atmosphere_probe` gives a drag node's density,
geodetic point and drivers at a TEME position.

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

## Covariance realism (SPEC 12; measured 2026-10-25, module f20f5a059b76)

Held-out laser-ranged truth (ILRS combination orbits for LAGEOS and Etalon, NSGF arcs for the LEO set; GCRF): each
window a 24 h `fit` (USEABLE_START_TIME to USEABLE_STOP_TIME), then `propagate` of its set onto the reference epochs
of the next 3 days every 30 min, states and covariance lines from the module. d^2 = e^T P^-1 e on the position block,
against chi-square(3): mean d^2 / 3 (1), share inside the 95 % ellipsoid (0.95), median d^2 (2.366). The process
noise was fitted (SPEC 12.5) on 2026-02-01 .. 05-31 arcs of the other satellites; LAGEOS-1 never entered it, and
nothing was tuned after that fit. The experiment's windows are those its rows score (rows/slr-high.jsonl,
rows/slr-low.jsonl; one LAGEOS-1 2026 window lacks reference states).


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

One allocation per ingest: a propagation record per object plus, for resonant objects, checkpoints of the
integrated resonance state at every 720-minute node for 32 days each way. Nothing allocates while
propagating. A time within the checkpoint span costs no integration; beyond it, integration from the last
checkpoint. Results do not depend on the order times are requested in.


## SGP4XP status

`src/xp_theory.inc` is the semi-analytic theory of SPEC.md (side A, closed-modules main ef9e2169): six mean equinoctial elements
integrated on an epoch-anchored grid (two mean periods, or 95 min at epoch periods of 1100 min and up) by the
third-order Runge-Kutta step with its fallbacks, cubic Hermite between nodes, Brouwer J2 short-periodics to TEME.

| SPEC | state |
|---|---|
| 1 conventions, native elements | closed: native elements at epoch exact |
| 2 zonals | closed: SPEC 2's explicit J2-J5 rates (`src/xp_spec_terms.inc`, transcribed mechanically); section-2.2 rates to 1e-8..1e-10, mean-longitude rate to 6e-14..5e-13 |
| 3 drag | closed: SPEC flux model, J70 temperature, the density table of SAO SR 313 Table 6 as printed (pp. 82-87, `src/j70_table6.inc`, SHA-256 checked by `build.mjs`) with USSA 1976 below 90 km, the seasonal-latitudinal term (cos^2 of the geodetic latitude, equator north), SPEC arc, 13-point Gauss-Legendre average. SGP4XP applies the library's own values at 23 entries (`src/j70_library_overrides.inc`: height, temperature, printed and library value, and the spec vector each was observed through; 15 of them printed with a final zero); SDN-AP and the printed table are unchanged. 3.7 row vectors: 136/136 to 2.3e-9; 3.6: 19/19; 3.5: 329/360 (the rest: 12 equator-node round-off cases, 19 at 1e-7 to 4e-3 with no single-entry explanation) |
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

Conformance (`test/results/conformance.json`; the oracle, USSF Sgp4Prop 9.9, black box; 8 times per set over
7 days): SGP4 type-0 control, 1,200 sets: max 0.09 mm. SGP4XP, 10,200 sets: median 0.37 µm (LEO 49 µm, SSO
4.9 µm, MEO 0.18 µm, GEO 0.25 µm, HEO 0.19 µm, VDS 0.24 µm); maxima LEO 28.7 m, SSO 3.58 m, MEO 26.9 m, GEO
35.2 m, HEO 954 m, VDS 116 m. Accepted as inherent: 70 samples of decaying sets; 1,070 rounding-limited SPEC 4
shadow decisions (each envelope run on fresh nodes; the reference between the two runs, or within their spread
where the decisions go in mixed directions); 4 samples where the reference's 9.1.1.0 build is within 1 m of the
module and 9.9 is not; the equator node (29 of 29 within 1 m flipped); the refusal epochs (164 of 164 within 1 %
of the lifetime). No sample is open, and the E2E passes. `test/results/open-outliers.md` names the tail's causes
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

- `test/conformance.e2e.mjs` (the task's E2E): a randomized corpus across LEO, SSO, MEO, GEO, HEO and VDS
  over 7 days against the black-box oracle; per-regime maximum and median position difference. The oracle (the
  unmodified US Space Force Sgp4Prop library behind a black-box harness) is not in this repository:
  `SDN_AP_ORACLE_ROOT` names its directory (`SDN_AP_ORACLE_VERSION` its leg, 9.9 by default;
  `SDN_AP_ORACLE_SECOND` the other build for the reference-split class, 9.1.1.0 by default), and the E2E and
  `spec-vectors/verify.mjs` refuse without it.
- `test/rigor/run.mjs`: the rigor suite (`test/rigor/README.md`).
- `test/bench.mjs`: memory per object and µs per object for a 60 s step, a 1-day jump and a 7-day jump.
- `test/fit.e2e.mjs`: the GCRF rotation on the Vallado et al. 2006 TEME example (within 1 cm), the fit of one day
  of states in TEME, GCRF and ITRF (the latter two within 1 m of the first) and the `$OBD` against the `$OMM`;
  frames from the enumeration alone, refusals of undeclared and conflicting frames; `propagate` on 4-day TEME,
  GCRF and EME2000 grids; the default 48 h span; a size-prefixed `$OMM`; a Moon-centered `$OMM` refused
  (unsupported-center); an `$OMM`, a `$PCF` and an `ElementRow` that name the removed SDN-AP theory refused.
- `test/covariance.e2e.mjs`: the covariance record of an SGP4XP fit (positive definite, its rows),
  `sdnap_covariance_at` against it at the epoch and against `propagate`'s TEME and GCRF covariance lines, the process
  noise against its closed form, and the refusals (no COVARIANCE, an SGP4 set, a malformed row).
- `test/epoch-store.e2e.mjs`: `load_epochs` on a synthetic history (an SGP4XP series of the module's own mean
  elements every 6 h with covariances, an SGP4 series, an aged set, a duplicate) and its counts, MAX_SETS_PER_OBJECT
  and THEORIES; selection against brute force and every handover's continuity for NEAREST / LATEST_BEFORE x SMOOTHSTEP
  / HERMITE; the blended covariance; `propagate_epochs` against the resident store bit for bit; and, from the local
  Space-Track archive, seven days of the catalog (its memory, selection and continuity on a sample; NOT MEASURED
  without the archive).
- `test/maneuver.e2e.mjs`: the `maneuver` method (impulses, finite burns, the `$MNV` record), the fit of an arc across
  a burn (the span rule's shortening, fit-implausible), `$PCF` refusals, and the method's refusals.
- `test/exports.e2e.mjs`: the display exports, each against its inverse.
- `test/atmosphere.e2e.mjs`: the drag atmosphere of SPEC 15 (above).
- `test/wasmedge-parity.mjs`: `propagate`, `fit`, `propagate` on a GCRF grid, `maneuver`, `propagate_epochs`, and
  `propagate` and `fit` under NRLMSISE-00 times the open DCA (SPEC 15), through the browser host and native WasmEdge
  0.16.4: identical bytes.
