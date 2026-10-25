# sdn-ap-propagator

General-perturbations propagation of whole catalogs in one isomorphic WASM module (browser and WasmEdge),
with three theories:

| Theory | Sets | Source |
|---|---|---|
| SGP4 | type 0 | SPACETRACK REPORT No. 3; Vallado et al. 2006 (AFSPC mode) |
| SGP4XP | type 4: BTERM, AGOM (m^2/kg) | the US Space Force SGP4-XP theory, clean room (side B): the public change list, then SPEC.md section by section |
| SDN-AP | SDN's own | SDN's improved theory, labeled as its own |

License: Apache-2.0 ([LICENSE](LICENSE)), the SGP4/SDP4 base included (written clean room from Spacetrack Report No. 3
and the corrections AIAA 2006-6753 documents); [NOTICE](NOTICE) names what the build compiles and reads.

Build: `npm run build` (module SDK compiler lane, clang `wasm32-wasip1-threads`, no exception handling) writes
`dist/isomorphic/module.wasm`; it reads NRLMSISE-00, ERFA and EGM96 from this repository and the build data below
from `SDNAP_HAC_ROOT`.

## Build data

The build reads these files from `SDNAP_HAC_ROOT` (default `/opt/data/sdn-archive/hac`), pinned by SHA-256 in
`build.mjs`, and refits them into tables; the repository carries none of them. `npm run fetch-build-data` (or
`node tools/fetch-build-data.mjs [--root DIR] [--verify-only]`) fetches each from its publisher and verifies it.

| File | Source | Terms | SHA-256 |
| --- | --- | --- | --- |
| `pds-grail-gravity/gggrx_0660pm_sha.tab` | GRGM660PRIM, GRAIL lunar gravity (Lemoine et al. 2013), NASA GSFC, PDS Geosciences Node | NASA PDS public data, no restrictions | `a77ee9996aff7341ef89f69aa401f39ba0c2949ed80411505fb4826b771dd63e` |
| `naif-kernels/pck/moon_pa_de440_200625.bpc` | DE440 lunar principal-axis orientation, NASA JPL NAIF | NAIF public data; unmodified kernels may be redistributed | `60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f` |
| `naif-kernels/spk/planets/de440s.bsp` | DE440 planetary ephemeris (short span), NASA JPL NAIF | NAIF public data; unmodified kernels may be redistributed | `c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2` |

## Interface

- Propagator ABI: `plugin_init_omm`, `plugin_init`, `plugin_propagate`, `plugin_propagate_batch`,
  `plugin_entity_count`, `plugin_destroy`; Earth-fixed meters. `OrbProOMMRecord`s are read as SGP4XP sets
  (BTERM in `bstar`, AGOM in `mean_motion_ddot`) unless `sdnap_set_omm_theory(0)` selects SGP4.
- Batch, structure of arrays: `sdnap_init_elements(rows, count)` (168-byte `ElementRow`s, split Julian epoch,
  theory per row, SDN-AP flags); `sdnap_propagate_soa(jdWhole, jdFrac, first, count, frame, out, status)` and
  `sdnap_propagate_minutes_soa(minutes, first, count, out, status)` write six planes (x, y, z, vx, vy, vz) of
  `count` doubles, TEME km and km/s or Earth-fixed m and m/s. `sdnap_threads(n)` starts the pool; results are
  the same bytes at any thread count.
- Configuration (SDS 1.268.0, `$PCF` 1.0.2): `propagate`, `fit`, `maneuver`, `detect_maneuvers`, `reentry`, `launch_set` and
  `launch_batch` take one `$PCF` on their required `configuration` port. Each reads THEORY and its own tables
  (propagate and maneuver: MEAN_ELEMENT, SEGMENTS, OUTPUT, FORCES; fit: FIT, MEAN_ELEMENT, SEGMENTS, FORCES;
  detect_maneuvers: MEAN_ELEMENT, MANEUVER_DETECTION; reentry: REENTRY, MEAN_ELEMENT, FORCES; launch_set and
  launch_batch: LAUNCH, MEAN_ELEMENT); another method's tables are left to it. Fields left unset take the defaults
  schema/PCF/main.fbs documents, each this module's own, so a table whose fields are all unset (or written at their
  defaults) reads as an absent one: FORCES.EMPIRICAL_TERMS holds tauc and taus above the drag regime by default
  (HELD_ABOVE_DRAG_REGIME true), and an SGP4 or SGP4XP set or fit refuses that table only for a field set off its
  default ("FORCES.EMPIRICAL_TERMS.<FIELD>: ..."); a field set to a value the module cannot apply is refused by name
  (configuration-refused, "TABLE.FIELD: why"; configuration-missing without one). THEORY: propagate, maneuver and
  reentry read UNSPECIFIED as each set's own (another value must match it); fit fits SGP4XP (UNSPECIFIED, SGP4XP) or
  SDN-AP (SDNAP); detect_maneuvers, launch_set and launch_batch work with SDNAP (UNSPECIFIED); FFM and KEPLER are
  refused. MEAN_ELEMENT applies to SDN-AP (SGP4XP's truncations are its specification's: another value is refused for
  an SGP4 or SGP4XP set). FORCES carries only EMPIRICAL_TERMS (SDN-AP), the density-correction relaxation 0 (held)
  and an empty EPHEMERIS_SOURCE (the theories' own analytic Sun and Moon series): the averaged theories apply their
  own forces. INTEGRATOR is refused (the averaged theories integrate on their own grid), EVENTS when not empty.
  Applied with their documented ranges: FIT (every field), REENTRY (WINDOW_METHOD LINEAR; C4 from
  HANDOFF_SAWTOOTH_KM, a positive length, and HANDOFF_SAWTOOTH_MINIMUM_ECCENTRICITY, an eccentricity in [0, 1)), LAUNCH, OUTPUT (TEME,
  GCRF or EME2000, at most 500,000 states), MANEUVER_DETECTION (FALSE_ALARMS_PER_OBJECT_YEAR 1, CORRELATION_MODEL
  WHITE or ONE_SAMPLE_PER_REVOLUTION), SEGMENTS (the cislunar and heliocentric steps and the 6 h cislunar segment
  at their defaults).
- Invoke surface (SDS buffers plain or size-prefixed): `ingest_omm` takes `$OMM` records (MEAN_ELEMENT_THEORY SGP4,
  SGP4XP or SDNAP); `propagate` returns one `$OEM` per `$OMM` on the grid of an optional
  'grid' `$OEM` template, as modules propagator/sgp4-xp reads it: explicit EPOCHs or START_TIME / STOP_TIME /
  STEP_SIZE (defaults: the set's epoch, one day, OUTPUT.STEP_SECONDS 60 s), TEME, GCRF or EME2000 (OUTPUT.FRAME
  for a template that names none), at most OUTPUT.MAXIMUM_STATES (500,000) states a request;
  the grid's span decides how far a set runs. `test/wasmedge-parity.mjs` runs it through the browser host and
  native WasmEdge 0.16.4: identical `$OEM` bytes.
- `fit` takes `$OEM` ephemerides and returns per block one SGP4XP (THEORY UNSPECIFIED or SGP4XP) or SDN-AP
  (THEORY SDNAP, MEAN_ELEMENT_THEORY SDNAP) `$OMM` on `elements` and one `$OBD` on
  `determination` (fit interval, spans, method, first, best and published RMS in km, held-out error growth,
  iterations, states accepted). The block's REFERENCE_FRAME is read, never assumed (the CelestialFrame
  enumeration, an RFM coordinate system, or NAME): TEME; GCRF or ICRF (TEME = R3(GAST06 - GMST82) NPB06 GCRF,
  IAU 2006/2000A through ERFA); EME2000 or J2000 (the IAU 2006 frame bias, then GCRF); Earth-fixed (GMST82);
  UT1 = UTC and the pole at its mean position. No frame, or an enumeration and NAME that disagree, is refused
  by name (reference-frame-undeclared, reference-frame-conflict). Fit span: USEABLE_START_TIME to
  USEABLE_STOP_TIME (or FIT.HOLDOUT_HOURS before the data's end); without USEABLE_START_TIME the span rule (DESIGN
  2e.3, $PCF FIT), validated on the data: FIT.DEFAULT_SPAN_HOURS (48 h; ECCENTRIC_DEFAULT_SPAN_HOURS 24 h above
  ECCENTRICITY_THRESHOLD 0.5), then CANDIDATE_SPANS_HOURS (48, 72 and 120 h; 24 h in front for an eccentric orbit)
  each fitted to the data before the latest TAIL_HOURS (24 h) and scored on that tail (a day-1 prediction); the
  span with the smallest tail error (a longer one only when within EXTENSION_MARGIN 0.9, eccentric 0.7, of the best
  shorter one's) is refitted on all the data. The arc grows from two revolutions by threes to the fit interval. A 'prior' `$OMM` carrying a previous set's SDNAP_B_EFF and _B_EFF_SIGMA makes that
  B_eff the next arc's prior (sigma floored at 10 %).
- Segment sets (SDN-AP 2h.2 / 2h.3 / 2h.5) through the same methods: `fit` (THEORY SDNAP) routes a Sun-centered block, a
  Moon-centered block whose first state's apocentre lies beyond 10,000 km (or an open orbit) and an Earth-centered
  block whose apocentre lies beyond 250,000 km (the documented reach rule) to a segment fit, in ICRF / J2000 axes
  (UTC; a TEME or Earth-fixed far block is refused by name); the `$OMM` carries CENTER_NAME (EARTH, MOON, SUN),
  REFERENCE_FRAME ICRF, the fitted epoch state's osculating elements with SEMI_MAJOR_AXIS and GM (an open orbit:
  e > 1, a < 0, the hyperbolic mean anomaly), MEAN_ELEMENT_THEORY SDNAP, USER_DEFINED_SDNAP_REGIME CISLUNAR or
  HELIO, the force-model parameters (SDNAP_AGOM; SDNAP_BETA, SDNAP_RTN_R/T/N, SDNAP_RTN_RATE_R/T/N),
  SDNAP_MANEUVER_BEFORE_SECONDS when the set's epoch was carried past a maneuver or a sphere-of-influence passage
  and SDNAP_ARC_END_SECONDS. `propagate` writes such a set's states about its center in ICRF axes on a grid whose
  CENTER_NAME is absent or the set's (else grid-center-mismatch); `ingest_omm` refuses it (unsupported-theory). A
  Sun-centered block ending inside a planet's sphere of influence is refused (inside-sphere-of-influence).
- Third-party code, read from the open modules repository (this repository vendors nothing) and pinned by SHA-256
  in `build.mjs` (the build fails on any other bytes; `dist/build-provenance.txt` records the path, commits and
  hashes): NRLMSISE-00 (Brodowski's public-domain port) and ERFA (BSD-3-Clause, derived with permission from IAU
  SOFA; license carried in `LICENSES/ERFA.txt` and `dist/LICENSES/ERFA.txt`).

## SDN-AP (DESIGN: orbit-accuracy-experiments, experiments/sdn-gp-starlink-ffm-match at ab0824d)

Theory 16 on the same integrator, grid, checkpoints and batch entry. In now: 2a drag on NRLMSISE-00 (`gtd7d`, the
public-domain Brodowski port the FFM truth uses, read from the open modules repository's vendored copy) times
exp(s(t)), with the K = 12 trapezoid in eccentric anomaly for near-circular orbits and the SPEC 3.4 perigee band
otherwise (the environment in force via `sdnap_set_environment(f107, f107a, ap, s)` until `$SPW`/`$DCL` ingestion);
2b signed B_eff with kappa carried; 2c tau0, tauc, taus with g(t). One NRLMSISE-00 call costs about 5.1 µs CPU in
WASM (DESIGN open question 3). B_eff and tau0 act in the drag regime only (perigee below 2500 km). There tauc and
taus decay after the arc (2c); above it they carry SRP's once-per-revolution part with AGOM and are held after the
arc (USER_DEFINED_SDNAP_TAU_HELD = 1): GNSS (54 ESA final-orbit windows, day 3) 0.176 km against 0.219 with them
off, 0.243 decaying and SGP4XP's 0.222. B_eff is free at any value (coordinator, 2026-10-24). The 2c.2 rule is opt-in
(a 'prior' $OMM with USER_DEFINED_SDNAP_TAU0_RULE = 1): a B_eff above 0.5 m^2/kg is replaced by tau0 with B at its
prior, the set carries USER_DEFINED_SDNAP_LOWERING = 1 and its tau0 is held after the arc. On the experiment's 19
lowering Starlinks (FFM truth: plain drag at B_eff 0.52-13.6 m^2/kg), day-3 median: free B_eff 7.4 km (all 19 below
SGP4XP's 25.3), the rule 169 km, the rule with tau0 decaying after the arc 1,191 km (the earlier blow-up: it is the
rule's, not the kernel's; the same 1,191 km with the kernel fixed, which moved free B_eff from 364.6 to 48.6 km on
the B_eff 13.6 set).

The shared density kernel (2a.4) holds log rho (float) on 79 heights x 13 latitudes x 16 local times every 3 h,
96 grids (10.7 days): never interpolated across the daily environment step at 0 UT (the last interval of a day
ends on a 0 UT grid built with that day's environment), exp(s(t)) applied at the query time. Against the direct
path along 53-degree orbits: ln(kernel/direct) rms 0.21 / 0.33 / 0.47 % at 350 / 450 / 550 km, max 1.7 %
(before: 1.8 / 2.6 / 3.3 %, max 22 %, from the 21-24 UT interval).

2d, tesseral gravity (EGM-96 normalized to degree 70, pinned in `build.mjs`; EGM2008 by `SDNAP_GRAVITY=egm2008`,
the same to 1 % in the terms below): the m-daily short-periodics (k = 0, even l to 12, all m) first order at output
time, inclination functions per object at the epoch; the shallow resonances (k = 1, q = 0, odd l to 31, every
order m whose angle drifts slower than 0.045 n) integrated with the rates. Inclination functions are Fourier
coefficients of the normalized Legendre recurrence (stable to degree 70; Kaula's closed form loses digits past
l = 40), checked against N_lm x Kaula to 2.6e-12 for l <= 15. Against FFM order 15 alone (EGM2008 70 x 70) the
m = 15 family gives 89-107 % of the along-track drift on 53-degree shells.

Found by fitting SDN-AP to FFM truths with their own gravity truncations (zonal only, tesserals to degree 2-6,
order 14, full; the experiment's M1-M3 method): (a) the odd-l tesseral terms with q = +-1 and j = 0 (psi = w omega +
m (Omega - theta_G), w = -q) are O(e) in G but O(1) in the eccentricity vector (Lagrange's 1/e) and oscillate at the
m-daily frequency, amplified by n / psi-dot; with them (2d.3b, l to 7, output time) the tess3 truth's fit RMS goes
from 0.274 to 0.051 km and day 3 from 2.6 to 0.37 km. (b) The zonal-only floor was the missing J6+ (SPEC 2 stops at
J5): cross-track 0.35 km at day 3; the zonal tail (2d.6, J6-J20 secular and odd-l long-period terms in the rates)
brings the zonal truth's day 3 from 0.35 to 0.047 km. The q = 0, j != 0 short-periodics (families 1 and 4 of
`sp_mask`) are tens of meters and pay little for 31 KB a set.

Resonance (SPEC 6) in SDN-AP uses the correct functions where the Space Force library's SGP4XP departs from them
(SGP4XP replicates the library):

- G_lpq(e) is the Hansen coefficient itself, valid at every eccentricity; the library's truncated Maclaurin
  polynomial diverges above the Laplace limit e = 0.6627 (Molniya orbits sit near e = 0.72).
- dF_632/di is the exact derivative; the library uses a different polynomial (SPEC 6.4: -119.140 against 0.562 at
  i = 0.9 rad) in the 8 h and 16 h classes.
- The 16 h class's G_410 has the correct e^2 coefficient 1 (the library's is 2).
- The 16 h class's dG_40,-2/de keeps its e^13 and e^15 terms (the library drops them).
- The 1-day class's G_30,-1 keeps its e^27 term (the library ends at e^25).
- Like the library, the four function values of each term are held at their epoch values.

`sdnap_fit(row, minutes, positions, count, options, stats)`: Levenberg-Marquardt on the theory's own residuals with
analytic Jacobians (exact derivatives of two-body motion with the J2 secular drifts; the drag column through the
theory's n-dot per unit B) and a prior row on B (DESIGN 2e.3); SGP4XP or SDN-AP rows (160-byte ElementRow).

## SDN-AP Moon-centered (DESIGN 2h.1, first version)

`fit` (THEORY SDNAP) fits an `$OEM` block with CENTER_NAME MOON (ICRF or J2000 axes, UTC) and `propagate` writes a Moon-centered
SDN-AP `$OMM` (CENTER_NAME MOON, USER_DEFINED_SDNAP_REGIME MOON) on a grid template, in ICRF axes; `ingest_omm` and
the batch entries stay geocentric (a Moon-centered record is refused there by name). Mean equinoctial elements in the
DE440 principal-axis frame frozen at the epoch; the $OMM carries them referred to ICRF.

- Data (the build data above, pinned by SHA-256; never in the repository): GRGM660PRIM (Lemoine et al. 2013, NASA GSFC, PDS) truncated to degree 100, and the DE440 lunar
  principal-axis orientation (NAIF moon_pa_de440_200625.bpc) refitted to 16-day Chebyshev records of degree 13 over
  2022-2029: max 5.9e-9 rad against the kernel (10 mm at the surface); the DE440 geocentric Moon and Sun (NAIF
  de440s.bsp: Moon - Earth about the EMB; Sun - EMB - Earth) refitted over the same span to 16-day records of degree 18
  (max 1.6 m) and 32-day records of degree 12 (max 3.3 km); the heliocentric planets (system barycentres minus the
  Sun) over 2012-2029: Venus 64 d / degree 14 (2.6 m), the Earth-Moon barycenter 64 d / 12 (39 m), Mars 128 d / 14
  (0.12 km), Jupiter and Saturn 128 d / 12 (0.25 km); errors recorded in `dist/build-provenance.txt`.
- Rates: every GRGM660PRIM term to degree 70 whose angle has no mean anomaly (|q| <= 2), F and G held at the epoch,
  evaluated in the PA frame of the time (the DE440 pole and spin from the refit; the rates carried back to the
  epoch-PA inertial frame through the orbit's vectors); Earth and Sun by SPEC 5's averaged quadrupole and octupole;
  SRP by SPEC 4's averaged rates with the Moon's cylindrical shadow, AGOM fitted (the Earth's shadow, a lunar
  eclipse, is left out). Output: the first-order j != 0 terms to degree 8 with |q| <= 2 (q = 0 alone made the fit
  worse: the q = +-1 terms carry the eccentricity vector's O(1) part).
- Maneuvers (documented rule): each half of the arc fitted on its own; when the whole arc's RMS exceeds 3 x the
  cleaner half's + 0.05 km, the burn's epoch is the arg max of the six-element GLR on the whole-arc set's position
  residuals, profiled over the epoch elements (DESIGN 5.1.4 (15) on the Moon-centered theory: S(t) and dx/dy0 by
  one-sided differences of six sets, the osculating elements' change per unit impulse, robust weights once per
  revolution; at least 2 h before and 6 h after the epoch), and the joint segment fit (the pre-burn elements, AGOM
  and the impulse over the whole arc; the post-burn set the pre-burn mean elements at the epoch plus the impulse's
  change of the osculating ones) gives the post-burn set when its RMS is within max(2 x, 0.05 km more than) the
  cleaner half's (the COMMENT carries the epoch, Lambda and dv). Otherwise the set is refitted on the longest latest
  segment (3/4 .. 1/4 of the arc, at least 6 h) within that bound. Either carries
  USER_DEFINED_SDNAP_MANEUVER_BEFORE_SECONDS; with neither the block is refused (maneuver-suspected). FFM-1 about
  the Moon (GRGM660PRIM 70, Earth, Sun, SRP; 100 km polar, 24 h at 300 s): 2 and 5 cm/s in-track impulses at 12 h
  give segments from 11.63 and 11.71 h with dv V 20.7 and 50.6 mm/s (U and W absorb the theory's own 0.1 km);
  the same arc without the burn and with a 3 cm/s radial one is fitted whole (about 30 s CPU in the browser host).
  On the 04-27 LRO maneuver (2.9 cm/s) inside the arc, the split-half rule alone: day 3 5.68 -> 1.32 km and 10.42 ->
  1.05 km.
- CPU: a 24 h fit (289 states, degree 70) 4.6-6.1 s in the browser host (the term angles by recurrence, Hermite
  dense output between grid nodes; 24.7 s before).

Measured on the experiment's JPL Horizons windows (8 each, 24 h fits at 5 min, days 1 / 2 / 3, medians, km): LRO
(about 90 km) fit RMS 0.146, 0.55 / 1.09 / 1.83 (max day 3 13.5, a 2.9 cm/s maneuver on day 2 of the prediction);
Danuri (about 130 km, perilune 60 km) fit RMS 0.117, 0.53 / 2.11 / 4.04 (max 28.1, maneuvers of 08-28 and 08-30).
The averaged degree: 10 / 30 / 50 / 70 gives LRO day 3 6.5 / 3.7 / 1.95 / 1.83 km, Danuri 22.6 / 6.3 / 5.9 / 4.0.

## SDN-AP heliocentric cruise segments (DESIGN 2h.3 / 2h.5; `fit` (THEORY SDNAP) and `propagate`, CENTER_NAME SUN)

`src/helio.inc`: the ICRF Sun-centered epoch state with mu_eff = mu_Sun (1 - beta) (radial SRP), the DE440 planets
(Venus, the Earth-Moon barycenter, Mars, Jupiter, Saturn; system GMs; tabulated every 6 h over the segment) and an
RTN acceleration a0 + a1 t (thrust arcs, and what the planets leave); RK4 at 1800 s on a fixed node grid, each node
step cut into parts of 2 % of the distance over the speed inside a planet's sphere of influence a_p (m_p /
M_Sun)^(2/5). Levenberg-Marquardt with Jacobi scaling, weak priors on beta and the RTN terms. Hand-offs: the arc is
cut after its latest sphere-of-influence passage (the set's epoch carried across the flyby), then the segmentation
rule (src/segment.inc: the whole arc and its latest 1/2 and 1/4, at least 5 days; the longest within max(2 r, r +
0.05 km) of the shortest's RMS r; a thrust change before it). Not yet: planet-centered sets inside a sphere, the
Laplace-Lagrange secular terms. Measured on the experiment's 90 cruise windows (720 h fits, hourly; lead days
1 / 3 / 7 / 15, medians, km; 0.31 s CPU per window): Psyche (20, solar-electric thrust, the May 2026 Mars flyby)
0.1 / 0.3 / 1.4 / 5.6; Lucy reconstruction (15) 0.0 / 0.1 / 0.6 / 4.3; Lucy reference (33) 0.1 / 0.2 / 0.6 / 3.5;
Juno cruise (22) 0.1 / 0.2 / 0.9 / 5.8. Without the planets: Psyche 0.2 / 0.6 / 2.5 / 16.7 (the 2026-04-09 window,
the Mars flyby in its prediction: day 7 126,592 km, with the planets 19.5; day 15 1.43e6 and 204 km). The whole arc
without segmentation: Psyche 4.1 / 10.1 / 36.6 / 293; two-body fits 41 to 96 km at day 1. Worst day 15: Psyche
2025-08-12 (40,000 km, fit RMS 121 km: a thrust change inside every segment), Lucy reference 2026-02-05 (21,700),
Juno 2013-07-12 (21,200). Measured and dropped: holding a0 + a1 t at its fit-end value (worse everywhere); refining
the segment start by bisection (Psyche day 15 16.7 -> 19.4).

## SDN-AP cislunar segments (DESIGN 2h.2 / 2h.5; `fit` (THEORY SDNAP) and `propagate`, CENTER_NAME MOON or EARTH)

`src/cislunar.inc`: the ICRF epoch state about the Moon or the Earth; the other body and the Sun as DE440 point masses
(tabulated hourly per segment), the center's J2 (the Moon's about its pole at the epoch), radial SRP (AGOM); RK4 at
60 s on a fixed node grid (a state-dependent step makes the finite-difference Jacobian discontinuous). The
segmentation rule of src/segment.inc with segments of at least 6 h. Not yet: Richardson's base and the
Sundman-phase series. From the truth state with no fit, the SPEC 5 Sun and Moon series put CAPSTONE 341 km off at
24 h (an apolune tidal error of 0.09 mm/s^2); DE440: 0.45 km. Measured on the experiment's windows (medians, km):
- CAPSTONE NRHO (50 windows, 336 h fits at 5 min, lead days 1 to 7): segmented 1.9 / 5.0 / 9.8 / 17.2 / 23.1 /
  36.4 / 48.4 (fit 0.42); the whole arc (station-keeping maneuvers inside) 20.6 / 28.4 / 37.9 / 41.7 / 51.4 / 63.1 /
  67.2. About 0.4 s CPU per window. (The earlier 1.7 / 2.8 / 4.3 / ... came from a scorer that dropped states whose
  time stamps carry 1 ms of jitter; these are re-scored on every state.)
- Artemis I, Earth-centered (11 windows, 24 h fits, days 1 / 2 / 3): 26.1 / 209 / 17,727 (149 / 266 / 17,740 unsegmented:
  the correction burns inside the arcs; day 3 holds the powered lunar flyby, not predictable without the burn plan);
  Moon-centered (2 windows, 336 h across the flyby and the DRO insertion): 2,193 at day 1.

## SDN-AP libration-point series (DESIGN 2h.2; diagnostic export `sdnap_nrho_series_fit_predict`)

`src/nrho.inc`: the Earth-Moon synodic frame about the Moon, pulsating with the DE440 Earth-Moon distance; a Sundman
anomaly s (ds/dt = 1 / r), theta1 = 2 pi s / S (S from the perilunes in the arc), theta2 the Moon's mean anomaly
(optionally the Sun's 2D as theta3); each normalized coordinate and t(s) a series sum_{k <= K, |l| <= L} of cos and
sin (k theta1 + l theta2), fitted by linear least squares; a prediction solves t(s) = t with the target time's
phases. Richardson's third-order halo, built for small amplitudes, is no base for a 70,000 km NRHO: the fitted series
starts from nothing. CAPSTONE (50 windows, 336 h, medians, km): K 10 / L 1 (1.76 KB) in-span 0.30, days 1 / 3 / 7
5,918 / 53,670 / 62,331; K 20 / L 1 (3.36 KB) 0.20 in span, 32,977 / 52,059 / 53,238. Without theta2 the in-span RMS
is 1,600 km (the revolutions differ by thousands of km), with the Sun's 2D 1.2 km at 9.4 KB. A compact
representation of a span, not a predictor: the forcing terms of a 14-day arc (half a theta2 cycle) do not
extrapolate. The cislunar segments predict (1.9 / 9.8 / 48.4 km at days 1 / 3 / 7).

## Maneuvers, reentry and launch (DESIGN 5; methods `maneuver`, `detect_maneuvers`, `reentry`, `launch_set`, `launch_batch`)

- The inverse map y = h^-1(x, t) (`src/events.inc`): the mean elements whose output state is x, by fixed-point
  iteration in equinoctial elements from the osculating ones (4 steps to 1e-9 km and 1e-12 km/s; where the output
  map's rounding floor stays above that, a few um at a circular orbit, the best of the 20 steps within 1e-6 km and
  1e-9 km/s). An SDN-AP set of eccentricity exactly 0 propagates (the m-daily terms' dG/de is 0 there).
- `maneuver`: an Earth SGP4XP or SDN-AP `$OMM` across `$MNV` (0.0.4) burns: the impulse map (14) at EVENT_START_TIME,
  or a finite burn (EVENT_END_TIME or TOTAL_BURN_TIME) at its centroid with the eccentricity-vector and plane changes
  scaled by sinc(dL/2) (15); out: one post-burn `$OMM` per burn (epoch the centroid), one `$MNV` with PRE_EVENT and
  POST_EVENT (TEME, osculating elements, BALLISTIC_COEFF = 1/B_eff) and the CHARACTERIZATION from the Delta v, and
  with a 'grid' the TEME states across the burns. Refusals: maneuver-before-epoch, invalid-mnv, maneuver-failed.
- `detect_maneuvers` (5.1.4): the six-element GLR (16) on the innovations of the inverse map against a fit of the
  arc (B_eff, then AGOM, as `fit` (THEORY SDNAP)), M_k = Phi(t_k, t_b) G(t_b) = S(t_k) N with the theory's own
  transition, MAD weights per revolution (MANEUVER_DETECTION: THRESHOLD 20, MARGIN_STATES 12, REFINE_WINDOW_HOURS 2,
  MINIMUM_STATES 48). Detection: the largest Lambda against the burn-free fit (the calibrated form; 0 detections on
  40 burn-free FFM-1 arcs of 72 h, largest 18.5). Epoch and Delta v: the likelihood profiled over the epoch elements
  and B_eff (the nuisance re-estimated with and without the burn: Lambda = u' Nt (Nt' P Nt)^-1 Nt' u, P = A+ - A+ A^-1 A+,
  u = b+ - A+ A^-1 b from suffix sums of J' W J and J' W e), so a long pre-burn arc no longer pulls the epoch to the
  arc's start; the $MNV names the epoch's interval (the profile within 3.84 of its peak) and a burn-free report the
  floor at the best epoch (sqrt(THRESHOLD / F_cc) per axis; FFM-1, 48 h arc: U 70, V 5.5, W 54 mm/s). With a burn, the pre-burn set and a second scan on its innovations start the joint
  segment fit (y_0, Delta v and t_b over the whole arc, the post-burn set the impulse map of y_0 at t_b); out the
  pre-burn and post-burn sets and a `$MNV` (DETECTED, Lambda and the joint fit's RMS in ALGORITHM).
- `reentry` (5.2): C1 / C2 / C3 of (18) and C4 (an eccentric orbit's perigee-pass sawtooth (3 pi / 8) |Delta a_rev|
  above 0.5 km, e > 0.02) along the mean trajectory (REENTRY: NODE_STEP_MINUTES 30 within HORIZON_DAYS 120;
  HANDOFF_DECAY_RATIO 0.05, HANDOFF_PERIGEE_ALTITUDE_KM 180, HANDOFF_ECCENTRICITY_COLLAPSE 0.01 above
  HANDOFF_MINIMUM_ECCENTRICITY 0.01), the one-way hand-off to the module's osculating integration
  (`src/osculating.inc`: EGM96 20 x 20, Sun and Moon, NRLMSISE-00 x exp(s) with B_eff, radial SRP; RK4 at
  OSCULATING_STEP_SECONDS 10 s; hour chunks above 150 km, a chunk that runs into the ground redone in minute chunks)
  to ALTITUDE_KM (80 km) within the horizon; a lowering set (USER_DEFINED_SDNAP_LOWERING with a negative _TAU0) decays
  by its sustained transverse thrust with B_eff at its prior; the window (20; WINDOW_DENSITY_SIGMA,
  WINDOW_CORRELATION_DAYS, WINDOW_BALLISTIC_SIGMA else the set's own B_eff sigma) with the time to go from the data
  cutoff (the fit arc's end, _ARC_END_MIN after the set's epoch), ORBIT_LIFETIME from the set's epoch; one `$RDM`.
- `launch_set` (5.3.1): the first set of a `$LAM` INSERTION orbit or a `$BOV` burnout vector (Earth-fixed km and km/s,
  rotated to TEME by GMST; the schema states no unit, a radius outside 6,000-100,000 km is refused) by the inverse
  map, B_eff and AGOM priors (LAUNCH, 0.01 m^2/kg each, or a 'prior' `$OMM`'s), the (21) sigmas for a `$LAM`; an early `$OEM` goes to `fit` (THEORY SDNAP).
- `launch_batch` (5.3.3): one parent state ($LAM or $BOV), each object's TEME block the impulse map of the parent set
  with its separation Delta v_k and B_k; the parent's elements, the shared tauc and taus and the batch mean B with
  per-object Delta v_k and B_k (priors B_k ~ N(B_mean, SHRINK_SIGMA_M2_KG^2), absent the prior B; Delta v_k ~
  N(0, SEPARATION_SIGMA_M_S^2), 1 m/s; B_mean ~ N(B_prior, BATCH_MEAN_SIGMA_M2_KG^2)), the arrowhead
  normal matrix by the Schur complement; each object's set with its along-track order (22), and with 'catalog' sets
  the association by that order at the latest catalog epoch. Synthetic FFM-1 batches of 27 objects from a 300 km
  insertion (separations uniform within 30 cm/s per axis, B_eff 0.008-0.012 m^2/kg; 3 seeds), median day 3 joint
  against per-object fits: 6 h 5.1 / 33.9 / 13.9 against 15.5 / 51.0 / 23.4 km, 12 h 3.3 / 0.34 / 3.6 against 4.6 /
  0.71 / 4.0 km; the events E2E's six-object draw is the case where the per-object fits lead at 6 h. 24 h batches
  of 27 from 252 km converge (a joint fit that stopped at the inverse map's rounding floor, 2.5e-9 km, now takes its
  best iterate).
- `fit` shortens a span whose fit RMS passes FIT.IMPLAUSIBLE_RMS_KM (100 km) to its latest half, down to
  FIT.MINIMUM_SPAN_HOURS (24 h), and refuses an Earth arc still beyond it (fit-implausible), and the span rule keeps 24
  h for e > 0.5 (a longer span only on a 30 % better tail, none past a 36 h period). An eccentric block's fits
  (e > FIT.ECCENTRICITY_THRESHOLD) take the theory's one-sided differences for the element and drag columns where no
  step along the analytic Jacobian lowers the cost: on a THEMIS-like FFM-1 orbit (1.05 rev/day, e 0.82) the 48 h fit
  stopped at 6 iterations with B_eff and tau at 0 and RMS 0.32-0.51 km; it now converges to 0.13-0.14 km (24 h fits
  0.08-0.10 km, which the rule keeps).

Measured (`test/events.e2e.mjs`; reference FFM-1, the modules' propagator/ffm, of a LEO state with the same burns,
under the same space weather; an SDN-AP set fitted on 48 h, days 1 / 2 / 3 after a burn at the arc's end; burn-free
0.089 / 0.156 / 0.203 km): impulses of 1 mm/s, 10 cm/s and 1 m/s along V and 1 m/s along U and W through
`maneuver`: 0.089 / 0.155-0.156 / 0.199-0.222 km; a 30 min 1 m/s in-track burn: excess over the burn-free error
0.000 km with the sinc map, 0.812 km as a centroid impulse. `detect_maneuvers` on 48 h arcs with a burn at 30 h: no
detection on the burn-free arc (Lambda 2.5), 20 cm/s burns within 0.9 min and 9.8 % (U), 9.8 % (W), 11.5 % (V) in
Delta v, the residue a common (-16, 1, +11) mm/s from the theory's 63-65 m RMS against FFM-1 (on the theory's own
states the joint fit returns 200.00 mm/s on the burn's axis at 0.0 min); 5 cm/s V below the floor (Lambda 16.1).
False alarms against FFM-1 (burn-free LEO arcs at 300 s, 350-650 km, seeded): none on 48 arcs of 72 h (largest
Lambda median 7.2, max 14.8) or 24 of 48 h (3.6, 9.4); a Gumbel fit puts one false alarm per object-year at Lambda
17.4 (72 h windows) and 11.3 (48 h), and the threshold 20 at 0.35 and 0.005 per object-year. The innovations'
integrated correlation time is 0.1-0.4 revolution in most elements (a_f, a_g up to 5 on some arcs), but weights from
it (one sample per correlation time) raise false alarms to 10 of 12 arcs (Lambda median 126): the theory's
low-frequency error matches a burn's step and ramp, so the weights keep one sample per revolution.
`reentry` of an SDN-AP set at 250 km, B_eff 0.02: 8.200 days against FFM-1's 8.086 at 100 km (1.4 % of the
lifetime). `launch_set`: the first set at its epoch 0.0000 m from the insertion state ($LAM and $BOV), day 1
1.019 km against FFM-1. `launch_batch`, six objects from a 300 km insertion (separations up to 30 cm/s per axis,
B_eff within 20 %), 6 h arcs: separations relative to the batch mean within 9.6 mm/s, 6 of 6 associated with
their own day-2 catalog sets; days 1 / 2 / 3 2.12 / 10.43 / 25.96 km against 1.08 / 5.21 / 12.84 km for per-object
fits of the same arcs (the shared parent and B take up the theory's error that per-object fits spread over their
own elements, AGOM and tau).

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
35.2 m, HEO 954 m, VDS 116 m. Accepted as inherent: 70 samples of decaying sets, 375 rounding-limited SPEC 4
shadow decisions, the equator node (29 of 29 within 1 m flipped), the refusal epochs (164 of 164 within 1 % of
the lifetime). Not accepted: 699 samples of 199 sets above 1 m (worst 623 m, HEO), listed with their element
sets in `test/results/open-outliers.md`; the E2E's acceptance fails on them (xpMaxNonInherent). The corpus is
synthetic (seeded). The E2E prints the sha256 of every module output; `--worst N` lists the largest differences
per regime; `--reproduce test/results/conformance.json` checks that a moved or rebuilt tree gives this run bit for
bit.

Guard rule for changes that move last bits (coordinator, 2026-10-24): every per-regime median and maximum of the
conformance E2E may move by no more than 1e-6 m, or 1e-12 relative to that value, whichever is larger; otherwise
the outputs must keep their digest.

CPU: the drag nodes carry the geocentric latitude and the exospheric-temperature half angles as sines and cosines
(no asin, sin or cos): about 20 % off a LEO rate evaluation. Two further bit-changing speed-ups (SPEC 4 averaged
SRP trig by angle addition, `tools/spec2cpp.py --hoist-linear`, and the resonance angles by angle addition) are
kept out: they move the near-threshold GEO maximum by 3 to 12 m.

SDN-AP against the experiment's FFM truth (Starlink, 29 windows, EGM2008 70 x 70 with drag and third bodies; 24 h
fit, held-out days 1 / 2 / 3, RMS km, medians): SGP4XP 1.49 / 5.00 / 10.80 (the experiment's best-case XP: 9.87 at
day 3); SDN-AP without 2d 1.49 / 5.06 / 11.44; with the m-daily and shallow terms and the kernel fix 0.53 / 0.95 /
1.58; with the eccentricity terms and the zonal tail (the shipped defaults) 0.18 / 0.44 / 0.96 (fit RMS 0.071 km;
0.18 / 0.41 / 0.84 without the five lowering sets; 26 of 29 below SGP4XP at day 3). Where adding 2d terms stops paying (day 3): m-daily degree 8 / 12 / 16: 4.26 /
2.03 / 2.22; shallow degree 21 / 31 / 41 / 70: 2.15 / 1.89 / 2.02 / 2.03; k = 2, 3 and bands past 0.045 n: no
gain. The 19 lowering Starlinks: see the 2c.2 note above. Fit span on the same windows, error over 72-96 h:
24 / 48 / 72 h fits 0.96 / 0.225 / 0.122 km (SGP4XP 10.8 / 2.29 / 0.83). The near-resonant terms just outside the
shallow band at output time (2d.5b, `sdnap_near_band`) made day 3 worse (0.96 to 1.19-1.32 km) and are off.

Carried B_eff prior (a previous arc's set as the next arc's prior), the same spheres: two 48 h arcs, day 3 0.122 km
alone, 0.110 km with the prior; two 24 h arcs, 0.300 alone, 0.409 with it (24 h B_eff estimates change sign between
arcs: they carry more than drag). The span rule's extension, not the prior, is the measured gain.

Laser-ranged LEO spheres (ILRS NSGF arcs chained, Ajisai, LARES, LARES 2, Larets, Starlette, Stella, WESTPAC; 21
windows; fits ending at the same time, held-out days 1 / 2 / 3, km): 24 h fits 0.071 / 0.161 / 0.300 (SGP4XP
0.638 / 0.861 / 0.957); 48 h 0.064 / 0.087 / 0.122; 72 h 0.051 / 0.065 / 0.106; 120 h 0.050 / 0.056 / 0.074.
The span rule on 168 h of data (21 windows, days 1 / 2 / 3): 48 h 0.061 / 0.092 / 0.144; forced 120 h 0.061 / 0.058 /
0.080; the rule with a 24 h tail 0.061 / 0.086 / 0.093 (48 h 13, 72 h 3, 120 h 5); with a 6 h tail 0.061 / 0.092 /
0.144 (48 h 17: a 6 h tail scores the fit's short-period error, not the drag estimate). GNSS rapid (GFZ MGEX): the GEO
(QZS-3) and IGSO (BDS C38) windows keep 48 h with either tail (forced 120 h: GEO day 3 0.136 against 0.101).

SDN-AP cost (500 Starlink sets, CPU per object): rate evaluation 2.97 µs, 3.26 with the shallow terms and the
zonal tail; output 1.08 µs, 2.11 with the m-daily and eccentricity terms; memory 3.33 KiB, 4.64 with every 2d term
(float coefficients: 42 m-daily pairs, 30 eccentricity and 22 zonal-tail terms of 16 bytes, 16-byte shallow records).
SGP4XP mode: 3.47 KiB, step 1.14 µs, 1-day jump 57.7 µs, 7-day 310 µs (32,770 sets). The
density kernel's 6.3 MiB holds 10.7 days, so a catalog's 7-day jump builds each grid once (before: 48 grids, an
LRU sweep that rebuilt them for every object, 2.8 s per object).

## Tests

- `test/conformance.e2e.mjs` (the task's E2E): a randomized corpus across LEO, SSO, MEO, GEO, HEO and VDS
  over 7 days against the black-box oracle; per-regime maximum and median position difference. The oracle (the
  unmodified US Space Force Sgp4Prop library behind a black-box harness) is not in this repository:
  `SDN_AP_ORACLE_ROOT` names its directory (`SDN_AP_ORACLE_VERSION` its leg, 9.9 by default), and the E2E and
  `spec-vectors/verify.mjs` refuse without it.
- `test/bench.mjs`: memory per object and µs per object for a 60 s step, a 1-day jump and a 7-day jump.
- `test/fit.e2e.mjs`: the GCRF rotation on the Vallado et al. 2006 TEME example (within 1 cm), the fit of one day
  of states in TEME, GCRF and ITRF (the latter two within 1 m of the first) and the `$OBD` against the `$OMM`;
  frames from the enumeration alone, refusals of undeclared and conflicting frames; `propagate` on 4-day TEME,
  GCRF and EME2000 grids; the default 48 h span; a size-prefixed `$OMM`; the lunar round trip and maneuver
  segmentation; the segment sets (an NRHO-like Moon-centered set, an Earth orbit reaching the Moon, a thrusting cruise
  set) through propagate, fit (THEORY SDNAP) and propagate again (within 20 m), a grid of another center refused
  (grid-center-mismatch) and the batch refusing a segment set (unsupported-theory).
- `test/environment.e2e.mjs`: `$SPW` and `$DCL` read as FFM reads them.
- `test/wasmedge-parity.mjs`: `propagate`, `fit`, `propagate` on a GCRF grid, `fit` (THEORY SDNAP) and its set on the grid,
  the lunar set, and the three segment sets (propagate, fit (THEORY SDNAP), propagate) through the browser host and native
  WasmEdge 0.16.4: identical bytes.
