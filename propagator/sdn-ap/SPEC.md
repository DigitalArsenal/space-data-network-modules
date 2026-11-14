# SGP4-XP: mathematical specification (clean room, side A)

Version 0.6.58 (dist 4b7ffed8).

**License note.** The US Space Force Sgp4Prop library is used under the USSF open source agreement
(`space-data-network-modules/propagator/sgp4-xp/third_party/ussf-sgp4/AGREEMENT.txt`; the 9.9 package carries the
same agreement as `Licenses/SGP4_Open_License.txt`). Its section 2.A grants Use, Distribution, Reproduction,
Redistribution and Display; it does not grant Modification. This document therefore holds no code of the library and
nothing derived from its code as code: only mathematics in prose and notation, constants with their values, units and
sources, branch conditions and order of operations, each tied to open literature or to black-box behavior of the
unmodified library observed through the oracle harness (private: closed-modules `packages/sgp4-xp-oracle`). Side B
builds from this document and the oracle alone.

**Version specified.** 9.9 (native MacOS ARM library of the archived 9.9 package). Its native library works as an
oracle (the harness's leg `9.9`). Section 11 states where 9.1.1.0 (the vendored WebAssembly build) differs.

**Implementation.** Side B builds the bundle `propagator/sdn-ap/` of the public modules repository (Apache-2.0, except this directory: PolyForm Noncommercial 1.0.0) from this
document; it keeps the name SDN-AP and carries SGP4 and SGP4XP. The public description of SGP4-XP is
[Payne et al. (2022), Improvements to the SGP4 Propagator (SGP4-XP)](https://amostech.com/TechnicalPapers/2022/Astrodynamics/Payne_2.pdf).
Agreement with the USSF library measures implementation conformance, not orbit accuracy. Orbit accuracy
requires forward errors against independent truth, with lead time counted from the end of the fit.

**Status (2026-10-24, side A).** Sections 1-11 are complete, the refusal rules of 8 and 9 included. Not fixed by any
specification: shadow decisions that are rounding-limited (4), for which both outcomes conform. Explicit and
confirmed against the library: constants (1), the native elements (1.5), the zonal rates through J5 (2) and the
averaged third-body rates (5), whose sum reproduces the library's native rates to 1e-8..1e-10; the flux model,
Jacchia-70 temperature, density grid and the complete drag formulation (3, drag rates to 1e-9), with the density
table identified as SR 313's printed Table 6 (3.3); the output-time Sun/Moon (5.4) and SRP (4) corrections and the
J2 short-period corrections (8), which together reproduce epoch states to 1e-9 km; the shadow rule and the
shadow-averaged SRP rates (4); the analytic Sun and Moon (5); the resonance terms of every class with their rate
equations, coefficients, series and exact band limits (6, n-dot to 2e-12); the integrator (9); the version
difference (11).

**Markers.** *[probe]* = confirmed by black-box probing through the oracle; the matching vectors are in
`spec-vectors/` under the same section number. *[doc]* = stated by the library's public release notes, JIRA
summaries or interface documents. *[lit]* = follows the cited open literature. *[study]* = the mathematics as read
from the compiled 9.1.1.0 library (equations, constants and branch conditions only; nothing of its code). *[open]* =
not yet pinned; the probe that pins it is named.

---

## 1. Conventions and constants

### 1.1 Element set (ephemeris type 4)

A type-4 element set is a two-line element set whose line 1 column 63 holds `4` *[doc: Tle interface document;
release notes 8.0, figure 3]*. Fields that differ from types 0 and 2:

| field | type 0/2 meaning | type 4 meaning | columns |
| --- | --- | --- | --- |
| line 1, 34-43 | n-dot/2 | not used | 34-43 |
| line 1, 45-52 | n-ddot/6 | AGOM, solar radiation pressure area-to-mass, m^2/kg, `±NNNNN±E` = ±0.NNNNN x 10^±E | 45-52 |
| line 1, 54-61 | B* (1/earth radii) | B, ballistic coefficient, m^2/kg, same exponent format | 54-61 |
| line 2, 53-63 | Kozai mean motion (type 0) | Brouwer mean motion, rev/day | 53-63 |

All other fields (epoch, inclination, node, eccentricity, argument of perigee, mean anomaly, revolution number) have
their usual meaning (Hoots & Roehrich 1980, section 2). The angles and eccentricity are Brouwer mean elements; no
Kozai-to-Brouwer recovery is applied to type 4 *[doc: release notes 8.0, figure 3 item 4; probe 1.1]*. AGOM folds the reflectivity coefficient in (AGOM = C_R A/m: the SRP acceleration is P AGOM, section 4,
*[study; probe 4.1]*); B = C_D A/m, the drag acceleration being -(1/2) rho B |v_rel| v_rel (section 3.4) *[study; probe 3.2, 3.5]*.

### 1.2 Time

- Epoch: two-digit year (57-99 = 19xx, 00-56 = 20xx) and day of year with fraction, UTC (Hoots & Roehrich 1980).
- Propagation time t: minutes since epoch (`mse`). Days since 1950 January 0.0 UTC (`ds50utc`, the library's
  absolute time) = ds50(epoch) + t/1440 *[probe 1.2]*.
- Greenwich sidereal angle for theory use (resonance, VDS longitudes) follows the 1970-referenced formula of
  Vallado et al. 2006 (the AFSPC "operations mode" alternative): with d = d50 - 7305, days since 1970 January 0.0
  UTC (d = 1 at 1970 January 1.0; d_i = d truncated toward zero, d_f = d - d_i),
  theta_G = THGR70 + C1 d_i + (C1 + 2 pi) d_f + FK5R d^2, reduced to [0, 2 pi),
  THGR70 = 1.7321343856509374 rad, C1 = 1.72027916940703639e-2 rad/day, FK5R = 5.07551419432269442e-15 rad/day^2
  *[lit: Vallado et al. 2006, sgp4 code "ops mode"; study: the three values and the day origin are the library's]*.
  The library's JIRA ASTROSTDS-937 (9.0) records that its theta differs from the theory author's only through the
  flattening used *[doc]*.
- Earth rotation rate: omega_E = 4.37526908801129966e-3 rad/min, the SGP4 deep-space value *[lit: Hoots &
  Roehrich 1980; Vallado et al. 2006; value compiled into the library]*. It is the co-rotation rate of the atmosphere in drag (3.4)
  *[probe 3.2]*.

### 1.3 Earth model (EGM-96 for type 4)

Type 4 uses EGM-96 constants in place of WGS-72 *[doc: release notes 8.0, figure 3 item 8; probe 1.1]*:

| constant | value | units | source |
| --- | --- | --- | --- |
| mu (GM) | 398600.4415 | km^3/s^2 | EGM-96 (Lemoine et al. 1998) |
| R_E | 6378.1363 | km | EGM-96 |
| k_e = 60 sqrt(mu/R_E^3) | 0.074366859954178854 | R_E^1.5 / min | derived; compiled value |
| J2 | 1.08262668355315e-3 | - | EGM-96 unnormalized zonal (-C20 sqrt 5) |
| J3 | -2.53265648533224e-6 | - | EGM-96 |
| J4 | -1.619621591367e-6 | - | EGM-96 |
| J5 | -2.27296082868698e-7 | - | EGM-96; added for XP "for consistency with PPT3 and Brouwer" *[doc: release notes 8.0, item 5]* |
| k2 = J2/2 | 5.4131334177655e-4 | - | Hoots & Roehrich 1980 notation |
| k4 = -3 J4 / 8 | 6.07358096762625e-7 | - | Hoots & Roehrich 1980 notation |
| f (flattening) | 3.3528197529902951e-3 (1/f = 298.256415099) | - | the corrected EGM-96 value adopted for XP in 9.0 *[doc: release notes 9.0, EnvConst]* |

Tesseral and sectoral coefficients for resonance are the full-precision EGM-96 values (fully normalized
C_lm, S_lm from the EGM-96 coefficient file, unnormalized for use) *[doc: release notes 9.1; JIRA ASTROSTDS-1140]*.
Which (l, m) are used is given in section 6.

Kozai/Brouwer mean-motion conversions elsewhere in the library always use WGS-72 *[doc: release notes 8.0,
figure 1 item 10]*; they do not enter type-4 propagation.

### 1.4 Units and canonical scaling

Internally the theory is written in Earth radii and minutes (Hoots & Roehrich 1980): distance unit R_E, time unit
minutes, mu = k_e^2. Positions and velocities are scaled back to km and km/s with the EGM-96 R_E (the 8.2 fix
ASTROSTDS-667 made the back-conversion use the type-4 constants) *[doc; probe 1.1]*.

Mean semi-major axis from the Brouwer mean motion: a = R_E (k_e / n)^(2/3), n in rad/min. At t = 0 the library's
mean Keplerian output equals the element-set values and this a exactly (a = 6883.97761201 km for n = 15.2 rev/day)
*[probe 1.1]*.

### 1.5 Native element set

The theory carries **mean equinoctial elements** (Broucke & Cefola 1972; Cefola 1972), observable through the
oracle's `nativeElements` *[probe 1.3]*:

| # | element | definition | rate units |
| --- | --- | --- | --- |
| 1 | a_f | e cos(omega + Omega) | 1/min |
| 2 | a_g | e sin(omega + Omega) | 1/min |
| 3 | chi | tan(i/2) sin Omega | 1/min |
| 4 | psi | tan(i/2) cos Omega | 1/min |
| 5 | lambda | M + omega + Omega, degrees | deg/day |
| 6 | n | Brouwer mean motion, rev/day | rev/day^2 |

(direct/retrograde factor +1; i < 180 deg). At epoch they equal the element-set values exactly, and lambda advances at
the mean longitude rate (5471.4021 deg/day for the 15.2 rev/day, 51.6 deg case) *[probe 1.3]*. The library's
interface describes the longitude as held relative to Greenwich internally ("subtract thetaG"); the values it
returns are the inertial mean longitude *[doc + probe 1.3]*.

**A native-element report at time t is a fresh initialization at t** *[study; probe 6.8, 6.9]*. The library
propagates the set to t, makes from the mean elements there a new element set with epoch t (same B and AGOM, the
values carried in full precision), initializes it, and reports that set's epoch elements and epoch rates. The
elements are therefore the integrated mean elements at t (cubic Hermite between nodes, 9). The rates are the rate
function at those elements, but as of a new epoch: what initialization fixes, among it the resonance class (6) and
the resonance function values F and G (6.3), is taken from the elements at t instead of the epoch, and theta_G is
the 1.2 value at t. At t = 0 report and integrator agree; later the reported rates are not the rates the
integrator used, and the elements of later times do not follow from integrating them.

### 1.6 Memory *[stack #497]*

The module's own malloc, calloc, realloc and aligned_alloc calls, and its counted nothrow news (the theories' tables and
grids, the set caches, a thread's caches, the fit's arrays, the stores), go through one accounting (`sdnap::mem`), which
counts the allocations that fail and the largest request. The epoch store's allocations are among them: the blocks of 1,024
decoded records a load fills (one allocated when the one before it is full, so a load's memory follows the records
decoded, never the frame count the payload claims), the arrays of kept sets, entries and series (sized from the kept
count), the weather pool (which at least doubles when full), each set's covariance matrix, and the second slot of a
series of more than one set, and a carried forecast's track (its copy of the record's bytes, which a record that carries one
holds whole, and its arrays of segments). A covariance matrix that cannot be allocated refuses `out-of-memory`, not
`invalid-covariance`.

**The memory grows in steps of at least 4 MiB.** The allocator grows its heap through `sbrk` a few 64 KiB pages at a
time, and each growth of the memory costs about 0.3 ms. Grown by exactly what the allocator asks, a serial first pass of
20,000 AP series spends a third of its time growing it: 774 µs an object, against 501 with the memory grown beforehand.
So `sbrk` keeps the allocator's break itself, at or below the end of the memory it has grown (`sbrk(0)` answers the
break, or -1 when the break is at 4 GiB, the memory at its maximum: a request of nothing there is refused like any other):
- A request below that end moves the break.
- One past it grows the memory by at least a step (64 pages, 4 MiB). When a step does not fit under the memory's maximum,
  it grows by exactly what the request lacks, and only then refuses.
- Pages found beyond that end were grown by another party (a host's buffer). They are never served: the break moves past
  them. The module's own slack below them is given up, at most one step per such growth. When another party grows the
  memory between sbrk's check and its own growth, the break moves to the start of sbrk's new pages, and that one request
  may be refused although the memory grew (the pages stay as slack).
- Nothing is served at or past 4 GiB, the end of the address space. Such a request is refused, never wrapped.

So the memory the module grew and has not served is at most one step, plus at most one step given up at each growth by
another party, and it refuses only where the request itself does not fit. `sdnap_pool_stats` counts the growths and the
pages they added. `test/memory-step.e2e.mjs` probes the break directly. Against a test build with the step 0 it shows
the same bytes and the same sets answered at a limit, a host's pages intact, and at most 100 growths where the step-0
build makes thousands.

**A method during which one of them failed refuses with errorCode `out-of-memory` and emits nothing.** That holds for
`propagate`, `propagate_epochs`, `load_epochs`, `load_epochs_open`, `load_epochs_part`, `load_epochs_close`, `fit`, `maneuver`, `ingest_omm` and `export_omm`, whatever the method
would otherwise have answered. That includes the decay answers of SPEC 16.25:
- `decayed:<time>` and `decayed-in-arc:<time>`;
- a record whose held-out states past the crossing read DECAYED;
- a record whose last pass stopped on a column it could not difference.

The message names how many allocations failed since the method began and the largest.

A method's mark counts every thread's failures, because its batch spans the pool. A step that runs on one thread
compares that thread's own count (`mem::thread_failures`). That covers a set's initialization (AP's tables, the slow
terms, the odd zonal G1 table) and an epoch-store slot's build. On a pool thread, another thread's refused growth never
fails it. Compared with the instance's count, it would: a set no growth had refused would be refused, not deferred, and its
slot would keep the refusal (the no-reserve case of `test/epoch-pool.e2e.mjs` shows it).

**AP initialization storage (0.6.53).** Shared sample arrays use counted allocations; each memo is local to one
initialization and retains the scalar evaluator's operation order. An inclination column is keyed by inclination,
degree, order, and quadrature size; a changed inclination or degree rebuilds its columns. Against 0.6.52, the measured
allocator peak for one synthetic 15.2 rev/day, e = 0.001, i = 97.4 degree set with tesseral degree 70, zonal degree 20,
and slow terms is 31,888 versus 1,340,432 bytes after shared caches are warm. Both builds retain 31,888 bytes for that
set and release them all. In a fresh instance both peak at 1,342,912 bytes because persistent caches dominate.
The added 71 by 71 field-magnitude table occupies 45,376 bytes per thread. The largest initialization stack frame is
half_day_terms at 25,936 bytes; ap_init uses 3,664 bytes.

**Where sets are built, and the stack they take.** The calling thread builds the row store's sets (`sdnap_init_elements`,
`ingest_omm`), a fit's trial sets and a covariance's moved sets. Pool threads fly the row store's prepared sets. In the
epoch store's threaded call they also build the sets of the series they own: slot_of, xp_init, ap_init, every table
build, the decay probe with drag and NRLMSISE-00, and the flight. A pool thread's stack is 256 KiB
(`pthread_attr_setstacksize`). `test/pool-stack.e2e.mjs` paints each pool thread's stack and reads how deep it wrote,
over a store of every class: low orbit at 500 and 290 km, the half-day and one-day classes and e 0.2, each at degree 31
and at 70 with the slow set, plus a decaying set and SGP4XP. The deepest is 31,192 bytes, a margin of 8.4 (2.1 on
wasi-libc's default 64 KiB). The test holds every thread under half its stack. A thread's thread-local block is 343,956
bytes. With the stack it fits the 1 MiB room the pool makes free before it creates the thread. A pool thread costs
192 KiB more of the instance than on wasi-libc's default stack. After starting 15 pool threads, an instance started at
64 MiB holds 104,857,600 bytes, against 100,139,008 on 0.6.57: 2.9 MB of stacks, the rest the 4 MiB step's rounding.

Through 0.6.47 such a call answered one of five ways:
- the theory's refusal of the elements (`element-set-refused`);
- a state not reached (`propagation-failed`);
- a fit that did not converge (`fit-failed`), or an implausible one;
- a decay answer. A fit's start refused for want of memory was tested for a crossing in the arc, and a column whose
  flight below a decaying bump failed for want of memory stopped the pass as a column refused on both sides (status 2);
- success. A fit absorbs a failed flight as a step that did not improve, and a covariance that could not be prepared was
  dropped or refused as `invalid-covariance`. So the record could depend on how much memory was free.

**A fit pass** (`fit::run_free`) during which an allocation failed answers status -1, whatever it reached: never 0, 1 or 2,
and never -2 (a start the theory refused). The `sdnap_fit` export then gives status -1 and the error `out-of-memory`, and
leaves its row as it came.

In one instance's run of the 19 real THEMIS and Chandra windows with a measuring build at tesseral degree 31, the last four
catalog fits read "fit-failed: The fit did not converge on the block". By then the instance had reached the 2,048 MB the
module SDK's host gives a module by default, 1,858 MB of it idle grids. Each of the four fits when run alone.

**What a failed initialization leaves.** A set whose initialization fails after the theory took memory releases it
(`xp_init`, on every failing return), so no table and no grid reference outlives it. An epoch-store slot whose
initialization failed for want of memory answers that state with the theory's refusal code. It is not kept: the next call
initializes it again.

**The resident exports**, which have no method error (`sdnap_epochs_*`, the row store's `sdnap_propagate_*`), answer a
state whose set could not be initialized with the theory's refusal code, as before, and so a state on a thread whose caches
cannot be made (below). `sdnap_wide_grid_cache` and `sdnap_wide_grid_budget` show the instance's grids and bytes.

**A thread's caches** *[stack #600]*. A thread keeps nine caches, fixed in size, 1,796,968 B (1.71 MiB) together:
- the short-period evaluator's thread cache with its storage (614,288 B) and its 196,608 B coefficient block;
- the grouping and term scratch (22,816 and 84,896 B);
- the half-day cache (45,024 B) and the covariance's step cache (645,432 B);
- the Sun and Moon node store (18,432 B), the drift and GCRF node slots (163,840 and 5,632 B).

A set's theory reads some or all of them:
- an AP set reads all nine;
- an SGP4XP set without AP's terms reads the step cache alone (its rates).

What a set reads is made, through the accounting, before the thread's first state or initialization of such a set: all
nine for AP, and before any threaded batch; the step cache alone for an SGP4XP flight, where 0.6.55 made it, in the set's
first rates. A state or an initialization on a thread where one cannot be had is refused with the theory's refusal code (in
a method: `out-of-memory`). An epoch-store slot is left as it was, and the next state asks again. A row-store row
(`sdnap_init_elements`, `ingest_omm`) whose set was refused at its initialization holds that refusal until the store is
built again. Where the node store or the node slots cannot be had, a node is computed at each use without them, to the
same numbers.

Through 0.6.55 each was made at its first use. The coefficient block is first used when a set's tesseral cache is baked
again from its table, a day or so into a flight. When the memory was full by then, the module aborted there (a wasm
`unreachable`). Take 547 AP sets at 500 km in an instance held to 128 MiB, flown a day and then two days after their
epoch (test/memory-limit.e2e.mjs):
- 0.6.55 answers 543 of them in the first pass, then aborts at the second pass's first set;
- now 541 answer in each pass and 6 are refused (the coefficient block, made first, takes two sets' room);
- every state answered equals the same state at the default maximum, bit for bit.

The same test holds three other entries at their limits, every answer the default maximum's bit for bit:
- the store's covariance (400 copies of a fitted record, 128 MiB): 69 covariances answered, the rest NaN or refused;
- a threaded row-store batch (2,000 AP rows, two pool threads, 128 MiB);
- 6,000 SGP4XP sets without AP's terms at 80 MiB: 2,480 answer, the sets 0.6.55 answers and no other.

The pool's list of the sets that hold caches (SPEC 9) grows through the accounting as well. When the list cannot grow, the
set holds no caches and flies on the thread's.

**Outside the rule** (no call mark; what each does when one of the module's allocations fails):
- `sdnap_covariance_at` and `sdnap_covariance_full_at`: a covariance bank that cannot be prepared answers their existing
  refusal code -3, and so does a time the bank cannot reach.
- `sdnap_epochs_at` (and the other `sdnap_epochs_*` readers) with a covariance asked: a bank that cannot be built, or a moved
  set's flight that fails, gives status 0 and the state without its covariance.
- `ingest_omm`, refused `out-of-memory`: by then the old row store is dropped (the new store's build begins by freeing it).
  When the new store's arrays could be had, it is installed; a row whose set failed to initialize for want of memory holds
  the theory's refusal. Its $OCM outputs are discarded with the refusal.
- `load_epochs`, refused once its build has begun (a record, a failed allocation, series-forces-differ): the old snapshot is gone
  and the store is empty. A `load_epochs` refused before its build begins (a frame of a wrong type, a bad $PCF) leaves the old
  snapshot as it was. A record's carried forecast is a counted block (its copy, when it is kept) and counted arrays, refused
  `out-of-memory`. The forecast check that flies a set
  at the carried span's ends (`carried::build`) is reached only by `fit`; there a set that cannot be initialized writes "the
  theory does not reach it", and the fit then answers `out-of-memory`.

**Not counted, and trapping (as before) when they fail:**
- std::vector and operator new under -fno-exceptions, including the paths a caller's input sizes:
  - a fit's states;
  - the output times (up to OUTPUT.MAXIMUM_STATES);
  - the records of a load: the strings of a record's identity, its weather rows and nodes and its covariance as the decode reads
    them (a part's or a call's), which are std::string and std::vector, until the record is kept or dropped, and the Track object
    of a record that carries a forecast (`std::make_shared`: the object and its control block, about 200 bytes);
  - the $OMM sets, the burns, the $SPW rows;
  - every output's FlatBufferBuilder.
- A record's covariance as a load reads it (`load_epochs`, `new`), and a carried forecast's segment states.
- The row store's threaded batch's list of deferred rows (`batch`, a `static std::vector` resized to the batch's count
  before it starts).

**Counted, then trapping when it fails:** a thread's caches on a path that reaches them before any state or set
initialization on that thread: the diagnostic exports that read a set's mean state (`sdnap_xp_native`, `sdnap_rates_repeat`,
`sdnap_shadow_margin`, `sdnap_drag_orbit_check`) on a thread that has flown no set.

**Not memory:** `sbrk`'s abort on a negative or non-page increment (a malformed call from the allocator).

**The stack.** No array whose size follows the grid's anomalies or a degree lies on it: the grid builder's anomaly arrays
(9 x 128 doubles) and the m-daily family's inclination functions are on the heap. The fixed-size arrays indexed by the
m-daily and grid caps (kMdailyCap, kSpCap) are checked against them at compile time.

---

## 2. Secular and long-period terms (zonals J2-J5)

**Model.** The zonal problem through J5 is treated in the Brouwer (1959) manner. The integrated elements are
averaged over the short period only: the zonal part of the mean-element rates is the derivative of Brouwer's
short-period-averaged Hamiltonian, so it holds both the secular terms (J2, J2^2, J4) and the long-period terms in
omega, 2 omega and 3 omega (J2^2, J3, J4, J5); no separate zonal long-period correction is added at the output
*[lit: Brouwer 1959 sections 4-6; study]*. The rates are formed in Keplerian variables and carried into the
equinoctial rates of 1.5 by the chain rule (Broucke & Cefola 1972) *[study]*. PPT3, which the release notes name,
has the same zonal content through J5 *[doc: release notes 8.0 item 5]*.

Leading secular rates (k2 = J2/2, p = a(1 - e^2), R_E and minutes):

- Omega-dot = -3 k2 n cos i / p^2 x [1 + O(J2)]
- omega-dot = (3/2) k2 n (5 cos^2 i - 1) / p^2 x [1 + O(J2)]
- M-dot = n [1 + (3/2) k2 sqrt(1 - e^2) (3 cos^2 i - 1) / p^2 + O(J2^2, J4)]

with the second-order terms of Brouwer 1959, equations (16)-(18).

**Explicit zonal rates** *[study; probe 2.2]*. The zonal part of the rate function gives the same six-component
set as the output-time third-body terms (5.4): a zero mean-motion rate, then e-dot, i-dot, e varpi-dot (varpi =
omega + Omega), sin i Omega-dot and lambda-dot - n, in rad/min. Notation: n the mean motion (rad/min), p = a (1 - e^2)
in R_E with a = (k_e/n)^(2/3), s = sin i, c = cos i, eta = sqrt(1 - e^2), J2-J5 of 1.3. Each rate is the sum of
the terms listed, each a J coefficient times the bracket:

**e-dot** =
- J2^2 x [-3 e n s^2 (e - 1) (e + 1) (15 s^2 - 14) sin(2 omega)/(32 p^4)]
- J3 x [-3 n s (e - 1) (e + 1) (5 s^2 - 4) cos(omega)/(8 p^3)]
- J4 x [-15 e n s^2 (e - 1) (e + 1) (7 s^2 - 6) sin(2 omega)/(32 p^4)]
- J5 x [-15 n s (e - 1) (e + 1) (126 c^4 e^2 cos(omega) - 63 c^4 e^2 cos(3 omega) + 168 c^4 cos(omega) - 84 c^2 e^2
  cos(omega) + 70 c^2 e^2 cos(3 omega) - 112 c^2 cos(omega) + 6 e^2 cos(omega) - 7 e^2 cos(3 omega) + 8
  cos(omega))/(256 p^5)]

**i-dot** =
- J2^2 x [3 e^2 n (14 - 15 s^2) sin(2 i) sin(2 omega)/(64 p^4)]
- J3 x [3 c e n (4 - 5 s^2) cos(omega)/(8 p^3)]
- J4 x [15 e^2 n (6 - 7 s^2) sin(2 i) sin(2 omega)/(64 p^4)]
- J5 x [15 c e n (-126 c^4 e^2 cos(omega) + 63 c^4 e^2 cos(3 omega) - 168 c^4 cos(omega) + 84 c^2 e^2 cos(omega) -
  70 c^2 e^2 cos(3 omega) + 112 c^2 cos(omega) - 6 e^2 cos(omega) + 7 e^2 cos(3 omega) - 8 cos(omega))/(256 p^5)]

**e varpi-dot** =
- J2 x [3 e n (-2 c - 5 s^2 + 4)/(4 p^2)]
- J2^2 x [3 e n (240 c e^2 s^2 cos(omega)^2 - 140 c e^2 s^2 - 112 c e^2 cos(omega)^2 + 40 c e^2 + 144 c eta s^2 - 96
  c eta + 160 c s^2 - 144 c + 540 e^2 s^4 cos(omega)^2 - 315 e^2 s^4 - 632 e^2 s^2 cos(omega)^2 + 280 e^2 s^2 + 112
  e^2 cos(omega)^2 + 360 eta s^4 - 528 eta s^2 + 192 eta + 120 s^4 cos(omega)^2 + 370 s^4 - 112 s^2 cos(omega)^2 -
  768 s^2 + 384)/(128 p^4)]
- J3 x [3 n s (5 c^3 e^2 - 10 c^2 e^2 - 30 c e^2 s^2 + 15 c e^2 - 5 c s^2 + 4 c - 30 e^2 s^2 + 26 e^2 - 5 s^2 + 4)
  sin(omega)/(8 p^3 (c + 1))]
- J4 x [15 e n (56 c e^2 s^2 cos(2 omega) - 84 c e^2 s^2 - 24 c e^2 cos(2 omega) + 48 c e^2 - 56 c s^2 + 32 c + 126
  e^2 s^4 cos(2 omega) - 189 e^2 s^4 - 140 e^2 s^2 cos(2 omega) + 252 e^2 s^2 + 24 e^2 cos(2 omega) - 72 e^2 + 28
  s^4 cos(2 omega) - 196 s^4 - 24 s^2 cos(2 omega) + 248 s^2 - 64)/(128 p^4)]
- J5 x [5 n s (-2646 c^5 e^4 sin(omega) + 441 c^5 e^4 sin(3 omega) - 5670 c^5 e^2 sin(omega) + 189 c^5 e^2 sin(3
  omega) - 504 c^5 sin(omega) - 2268 c^4 e^4 sin(omega) + 378 c^4 e^4 sin(3 omega) - 5166 c^4 e^2 sin(omega) + 189
  c^4 e^2 sin(3 omega) - 504 c^4 sin(omega) + 1512 c^3 e^4 s^2 sin(omega) - 252 c^3 e^4 s^2 sin(3 omega) + 1764 c^3
  e^4 sin(omega) - 490 c^3 e^4 sin(3 omega) + 2016 c^3 e^2 s^2 sin(omega) + 3780 c^3 e^2 sin(omega) - 210 c^3 e^2
  sin(3 omega) + 336 c^3 sin(omega) + 1512 c^2 e^4 sin(omega) - 420 c^2 e^4 sin(3 omega) + 3444 c^2 e^2 sin(omega) -
  210 c^2 e^2 sin(3 omega) + 336 c^2 sin(omega) - 504 c e^4 s^2 sin(omega) + 140 c e^4 s^2 sin(3 omega) - 126 c e^4
  sin(omega) + 49 c e^4 sin(3 omega) - 672 c e^2 s^2 sin(omega) - 270 c e^2 sin(omega) + 21 c e^2 sin(3 omega) - 24
  c sin(omega) - 108 e^4 sin(omega) + 42 e^4 sin(3 omega) - 246 e^2 sin(omega) + 21 e^2 sin(3 omega) - 24
  sin(omega))/(256 p^5 (c + 1))]

**sin i Omega-dot** =
- J2 x [-3 c n s/(2 p^2)]
- J2^2 x [3 c n s (30 e^2 s^2 cos(2 omega) - 5 e^2 s^2 - 14 e^2 cos(2 omega) - 4 e^2 + 36 eta s^2 - 24 eta + 40 s^2
  - 36)/(32 p^4)]
- J3 x [3 c e n (4 - 15 s^2) sin(omega)/(8 p^3)]
- J4 x [15 c n s (14 e^2 s^2 cos(2 omega) - 21 e^2 s^2 - 6 e^2 cos(2 omega) + 12 e^2 - 14 s^2 + 8)/(32 p^4)]
- J5 x [5 c e n (-378 c^4 e^2 sin(omega) + 63 c^4 e^2 sin(3 omega) - 504 c^4 sin(omega) + 1512 c^2 e^2 s^2
  sin(omega) - 252 c^2 e^2 s^2 sin(3 omega) + 252 c^2 e^2 sin(omega) - 70 c^2 e^2 sin(3 omega) + 2016 c^2 s^2
  sin(omega) + 336 c^2 sin(omega) - 504 e^2 s^2 sin(omega) + 140 e^2 s^2 sin(3 omega) - 18 e^2 sin(omega) + 7 e^2
  sin(3 omega) - 672 s^2 sin(omega) - 24 sin(omega))/(256 p^5)]

**lambda-dot - n** =
- J2 x [3 n (-2 c - 3 eta s^2 + 2 eta - 5 s^2 + 4)/(4 p^2)]
- J2^2 x [3 n (960 c e^4 s^2 cos(2 omega) - 160 c e^4 s^2 - 448 c e^4 cos(2 omega) - 128 c e^4 + 1152 c e^2 eta s^2
  - 768 c e^2 eta - 960 c e^2 s^2 cos(2 omega) + 1440 c e^2 s^2 + 448 c e^2 cos(2 omega) - 1024 c e^2 - 1152 c eta
  s^2 + 768 c eta - 1280 c s^2 + 1152 c + 2256 e^4 eta s^4 cos(2 omega) - 27 e^4 eta s^4 cos(4 omega) - 806 e^4 eta
  s^4 - 2016 e^4 eta s^2 cos(2 omega) - 80 e^4 eta s^2 + 368 e^4 eta + 2160 e^4 s^4 cos(2 omega) - 1512 e^4 s^4 -
  2528 e^4 s^2 cos(2 omega) + 1248 e^4 s^2 + 448 e^4 cos(2 omega) - 64 e^4 + 288 e^2 eta s^4 cos(2 omega) + 1312 e^2
  eta s^4 + 448 e^2 eta s^2 cos(2 omega) - 3584 e^2 eta s^2 + 1280 e^2 eta - 1680 e^2 s^4 cos(2 omega) + 6104 e^2
  s^4 + 2080 e^2 s^2 cos(2 omega) - 9376 e^2 s^2 - 448 e^2 cos(2 omega) + 3648 e^2 + 480 eta s^4 cos(2 omega) - 6176
  eta s^4 - 448 eta s^2 cos(2 omega) + 8704 eta s^2 - 3328 eta - 480 s^4 cos(2 omega) - 4592 s^4 + 448 s^2 cos(2
  omega) + 8128 s^2 - 3584)/(1024 p^4 (e^2 - 1))]
- J3 x [-3 e n s (5 c^3 e^2 - 5 c^3 eta - 5 c^3 - 10 c^2 e^2 + 10 c^2 eta + 10 c^2 - 20 c e^2 eta s^2 + 16 c e^2 eta
  - 50 c e^2 s^2 + 31 c e^2 + 55 c eta s^2 - 35 c eta + 50 c s^2 - 31 c - 20 e^2 eta s^2 + 16 e^2 eta - 50 e^2 s^2 +
  42 e^2 + 55 eta s^2 - 46 eta + 50 s^2 - 42) sin(omega)/(8 p^3 (c + 1) (-e^2 + eta + 1))]
- J4 x [15 n (56 c e^2 s^2 cos(2 omega) - 84 c e^2 s^2 - 24 c e^2 cos(2 omega) + 48 c e^2 - 56 c s^2 + 32 c + 70 e^2
  eta s^4 cos(2 omega) - 105 e^2 eta s^4 - 60 e^2 eta s^2 cos(2 omega) + 120 e^2 eta s^2 - 24 e^2 eta + 126 e^2 s^4
  cos(2 omega) - 189 e^2 s^4 - 140 e^2 s^2 cos(2 omega) + 252 e^2 s^2 + 24 e^2 cos(2 omega) - 72 e^2 - 28 eta s^4
  cos(2 omega) + 24 eta s^2 cos(2 omega) + 28 s^4 cos(2 omega) - 196 s^4 - 24 s^2 cos(2 omega) + 248 s^2 - 64)/(128
  p^4)]
- J5 x [5 e n s (2268 c^5 e^4 eta sin(omega) - 378 c^5 e^4 eta sin(3 omega) + 4914 c^5 e^4 sin(omega) - 819 c^5 e^4
  sin(3 omega) - 4032 c^5 e^2 eta sin(omega) + 1008 c^5 e^2 eta sin(3 omega) + 1638 c^5 e^2 sin(omega) + 819 c^5 e^2
  sin(3 omega) - 7056 c^5 eta sin(omega) - 6552 c^5 sin(omega) + 2268 c^4 e^4 eta sin(omega) - 378 c^4 e^4 eta sin(3
  omega) + 4536 c^4 e^4 sin(omega) - 756 c^4 e^4 sin(3 omega) - 3654 c^4 e^2 eta sin(omega) + 945 c^4 e^2 eta sin(3
  omega) + 1512 c^4 e^2 sin(omega) + 756 c^4 e^2 sin(3 omega) - 6552 c^4 eta sin(omega) - 6048 c^4 sin(omega) - 1512
  c^3 e^4 eta sin(omega) + 420 c^3 e^4 eta sin(3 omega) - 1512 c^3 e^4 s^2 sin(omega) + 252 c^3 e^4 s^2 sin(3 omega)
  - 3276 c^3 e^4 sin(omega) + 910 c^3 e^4 sin(3 omega) + 1512 c^3 e^2 eta s^2 sin(omega) - 252 c^3 e^2 eta s^2 sin(3
  omega) + 2688 c^3 e^2 eta sin(omega) - 1120 c^3 e^2 eta sin(3 omega) - 504 c^3 e^2 s^2 sin(omega) - 252 c^3 e^2
  s^2 sin(3 omega) - 1092 c^3 e^2 sin(omega) - 910 c^3 e^2 sin(3 omega) + 2016 c^3 eta s^2 sin(omega) + 4704 c^3 eta
  sin(omega) + 2016 c^3 s^2 sin(omega) + 4368 c^3 sin(omega) - 1512 c^2 e^4 eta sin(omega) + 420 c^2 e^4 eta sin(3
  omega) - 3024 c^2 e^4 sin(omega) + 840 c^2 e^4 sin(3 omega) + 2436 c^2 e^2 eta sin(omega) - 1050 c^2 e^2 eta sin(3
  omega) - 1008 c^2 e^2 sin(omega) - 840 c^2 e^2 sin(3 omega) + 4368 c^2 eta sin(omega) + 4032 c^2 sin(omega) + 108
  c e^4 eta sin(omega) - 42 c e^4 eta sin(3 omega) + 504 c e^4 s^2 sin(omega) - 140 c e^4 s^2 sin(3 omega) + 234 c
  e^4 sin(omega) - 91 c e^4 sin(3 omega) - 504 c e^2 eta s^2 sin(omega) + 140 c e^2 eta s^2 sin(3 omega) - 192 c e^2
  eta sin(omega) + 112 c e^2 eta sin(3 omega) + 168 c e^2 s^2 sin(omega) + 140 c e^2 s^2 sin(3 omega) + 78 c e^2
  sin(omega) + 91 c e^2 sin(3 omega) - 672 c eta s^2 sin(omega) - 336 c eta sin(omega) - 672 c s^2 sin(omega) - 312
  c sin(omega) + 108 e^4 eta sin(omega) - 42 e^4 eta sin(3 omega) + 216 e^4 sin(omega) - 84 e^4 sin(3 omega) - 174
  e^2 eta sin(omega) + 105 e^2 eta sin(3 omega) + 72 e^2 sin(omega) + 84 e^2 sin(3 omega) - 312 eta sin(omega) - 288
  sin(omega))/(256 p^5 (c + 1) (-e^2 + eta + 1))]

These are Brouwer's (1959) secular and long-period terms of the short-period-averaged zonal Hamiltonian through
J5, the J3 and J5 terms in the nonsingular combinations e varpi-dot and sin i Omega-dot (Lyddane 1963).

*[probe 2.2]* Confirmed together with the averaged third-body rates of section 5: their sum reproduces the
library's native rates at 13-15.2 rev/day (drag and SRP off) to 1e-8 to 1e-10 relative (lambda-dot to 6e-13).

**Deep-space always on.** For type 4 there is no 225-minute period switch: the lunar-solar terms of section 5 are
added for every orbit *[doc: release notes 8.0, item 6]*.

**Confirmed.** For drag-free, SRP-free sets the rates of the native elements are reproduced by the vectors of
section 2 *[probe 2.1]*; the zonal part carries no mean-motion rate. 

## 3. Drag: Jacchia-70 and the generic flux model

**Force.** Atmospheric drag on a cannonball with ballistic coefficient B (1.1); its contribution to the mean-element
rates is the orbit average of the Gauss planetary equations under the drag acceleration, evaluated by 13-point
Gauss-Legendre quadrature in true anomaly (section 3.4) *[lit: Gauss equations, Montenbruck & Gill 2000 3.5;
quadrature Abramowitz & Stegun 1964 table 25.4]*. The density is Jacchia (1970) driven by a solar-flux and
geomagnetic model that is a fixed function of date *[doc: release notes 8.0 item 9; lit: Jacchia 1970]*.

### 3.1 Generic flux model (no F10.7 or Ap input)

With d50 the time in days since 1950 January 0.0 UTC (1.2), the solar-cycle clock is
Y = (d50 - 25567) / 365.2425 years from 2019 December 31 0h UTC (the start of solar cycle 25). Y is reduced into
[0, 11) by whole 11-year cycles, counting the cycle index k = 7 for the cycle that starts at the reference, k - 1 per
cycle earlier, k + 1 per cycle later, clamped to k <= 8 (later cycles reuse cycle 8). The cycle phase is
x = Y / 11 in [0, 1).

- Solar flux (10.7 cm, sfu), the same value serving as daily flux F and 81-day mean F-bar:
  F = (A_k x^p_k (1 - x)^q_k + 70) [(1 + 0.01671 cos(2 pi frac(Y))) / 0.999721]^2,
  frac(Y) the fractional part of Y (the annual 1/r^2 factor with e = 0.01671, normalized by 0.999721).
- Geomagnetic index: Ap = 27.6558 x^0.93682 (1 - x)^0.92198 + 8.
- Cycle coefficients (values compiled into the library; the k = 6 cycle peaks near F = 137 sfu, k = 1 near 246 sfu,
  matching solar cycles 24 and 19):

| k | cycle starts (about) | A_k | p_k | q_k |
| --- | --- | --- | --- | --- |
| 0 | 1942.9 | 3941.23 | 2.10492 | 2.85759 |
| 1 | 1953.9 | 45065.1 | 3.20864 | 5.10803 |
| 2 | 1964.9 | 1125.51 | 1.51623 | 2.34156 |
| 3 | 1975.9 | 11732.2 | 2.81733 | 3.66706 |
| 4 | 1986.9 | 11696.1 | 2.15674 | 5.01571 |
| 5 | 1997.9 | 1367.0 | 1.11698 | 3.21707 |
| 6 | 2008.9 | 8881.53 | 3.06443 | 4.09606 |
| 7 | 2019.9 | 3213.79 | 2.18364 | 3.29520 |
| 8 | 2030.9 and later | 5106.98 | 2.10492 | 3.67530 |

Domain: for d50 < 2192 (before 1956 January 1) the day of year used by the semiannual and seasonal-latitudinal
terms is held at 1.0 of 1956 (N = 366); the cycle index k stays at 0 back to 1942.9 and is undefined before it, so
the model's domain begins at 1942.9 (the release notes say the fit reaches back to 1947) *[study]*.

### 3.2 Exospheric temperature

Jacchia 1970 with the constants below (SR 313 form; R, m, n, beta, p, gamma as named there):

- Night-time minimum: T_c = 383 + 1.80 F + 1.52 F-bar (equivalently 383 + 3.32 F-bar + 1.80 (F - F-bar)).
- Diurnal: T_l = T_c [1 + 0.31 (S + (C - S) cos^3(tau / 2))], S = sin^2.5(|phi + delta_sun| / 2),
  C = cos^2.5(|phi - delta_sun| / 2), tau = H - 37 deg + 6 deg sin(H + 43 deg), phi the geodetic latitude,
  delta_sun the Sun's declination, H the Sun-relative hour angle of the point, tau wrapped to (-pi, pi].
- Semiannual: with D = day of year minus 1 (fractional) and N the days in that year,
  tau_SA = D/N + 0.1145 ([(1 + sin(2 pi D/N + 342.3 deg)) / 2]^2.16 - 1/2),
  Delta T_SA = F-bar (0.349 + 0.206 sin(2 pi tau_SA + 226.5 deg)) sin(4 pi tau_SA + 247.6 deg).
- Geomagnetic: Delta T_G = Ap + 100 (1 - exp(-0.08 Ap)).
- T_inf = T_l + Delta T_SA + Delta T_G + 2.41, clamped to [600, 2000] K.

### 3.3 Density

The density is log10 rho(h, T_inf) (rho in g/cm^3) on a fixed grid, bilinear in (T_inf, h), plus one additive term
*[study; probe 3.5]*:

- **Temperature nodes**: T_c = 600 + 50 (c - 1) K, c = 1..29 (600 to 2000 K). T_inf is clamped to [600, 2000] K;
  for T_c-1 <= T_inf < T_c the value is linear in T_inf with weight (T_inf - T_c-1)/50.
- **Height nodes** (km), H_1..H_111: 10 to 90 every 5 (17 nodes), 92 to 110 every 2 (10), 115 to 160 every 5 (10),
  170 to 400 every 10 (24), 420 to 1000 every 20 (30), 1050 to 1500 every 50 (10), 1600 to 2500 every 100 (10).
- **Height interval**: for the geodetic height h, with the band (B, S, I) = (0, 1000, 1) for h < 10 km, (10, 5, 2)
  for 10 <= h < 90, (90, 2, 18) for 90 <= h < 110, (110, 5, 28) for 110 <= h < 160, (160, 10, 38) for
  160 <= h < 400, (400, 20, 62) for 400 <= h < 1000, (1000, 50, 92) for 1000 <= h < 1500 and (1500, 100, 102) for
  h >= 1500, the upper node is r = min(111, floor((h - B)/S + I + 1e-5)); log10 rho is linear in h between
  H_r-1 and H_r.
- **Below 10 km and above 2500 km** *[study; probe 3.14]*: for a geodetic height below 10 km, negative heights
  included, rho is the 10 km node value at every T_inf (0.41351 kg/m^3): the lowest interval is not
  interpolated. Above 2500 km, rho = 1e-20 kg/m^3. Both reach the rates: drag
  nodes down to -10 km at the epoch give the library's n-dot to 1e-13 with this rule, and above 2500 km the drag
  part of n-dot is linear in B and nonzero (MEO at 20,200 km: 5.5e-14 rev/day^2 for B = 0.01).
- **Node values, 10-85 km** (observed behavior): log10 (g/cm^3) of the U.S. Standard Atmosphere 1976 density at
  the geometric height, the density as the 1976 tables print it (five significant digits) and its logarithm kept to
  nine decimals, independent of T_inf; for example 0.41351 kg/m^3 at 10 km gives -3.383513983 *[lit: U.S. Standard
  Atmosphere 1976; study: all 16 nodes follow this to 5e-10, while the model's own unrounded densities differ by up
  to 1e-5 in the logarithm; probe 6.9: side B's fit of the decaying sets with perigees at 66-71 km finds these
  logarithms (offsets of -0.087 to +0.201 thousandths from the three-decimal values; rates to 2.8e-8 instead of
  4.1e-4)]*.
- **Node values, 90 km**: log10 3.46e-9 = -8.461 at every T_inf, Jacchia's 1970 boundary density (SR 313).
- **Node values, 90-2500 km: the printed table of SR 313** *[study; probe 3.7]*. The 90-2500 km part of the table is
  Jacchia's printed "Summary of log densities", Table 6 of SAO Special Report 313 (Jacchia 1970, pp. 82-87): decimal
  logarithms of the density (g/cm^3) to three decimals for exospheric temperatures 600 to 2000 K every 50 K
  (pp. 82-83: 600-1050 K; pp. 84-85: 1100-1550 K; pp. 86-87: 1600-2000 K; the first page of each pair 90-400 km, the
  second 420-2500 km), on exactly the heights of the grid above. Table 5 of the same report (pp. 52-81) gives the
  full models every 100 K, and its log-density column agrees with Table 6. The printed table is the regeneration
  recipe: side B transcribes Table 6 from the report (open literature); recomputing Jacchia's models does not
  reproduce it to its last digit (a numerical evaluation with the 1971 constants misses by up to 0.13 dex above
  130 km), so it should not be recomputed. Compared entry by entry over a sample (whole rows at 130, 200, 250 and
  420 km, and the 90-290 km block at 600-1050 K), the library's values equal the printed ones except isolated
  entries that are one unit higher in the third decimal, all of them printed with a final zero; they shift the
  density there by 0.23 %. The 3.7 row vectors detect them black-box: with rows transcribed from Table 6, the
  3.7 rates are reproduced exactly (to 1e-9) wherever a row has no such entry, and to 4e-5 to 2e-4 relative at the
  solar-minimum dates where the probe samples one. *[probe 3.9]* The 3.9 vectors pin the rows from 90 to 840 km at
  2026 days 282.5 and 292.5, with the node right ascension at 0, 90, 180 and 270 deg: equatorial near-circular orbits
  whose 13 nodes all sit on one table height, so each n-dot depends only on that row's cells at the nodes'
  exospheric temperatures (900 to 1200 K on those dates), entering with weights that change with the right
  ascension. Of the 37 cells side B lists that are printed with a final zero, the vectors show the library one unit
  higher in the third decimal only at 160 km, 1100 K: the printed entry misses the 160 km vectors by 3e-4 to 5e-4,
  the entry one unit higher reproduces them to 6e-8.
- **Row probes per cell** *[probe 3.11]*: one vector for each of the 379 table cells that side B's heavy-drag sets
  use (90 to 840 km, 900 to 1200 K): an equatorial near-circular orbit on that height, on the 2026 date (days 250.5
  to 330.5) and at the node right ascension (every 30 deg) where its n-dot depends most on that cell. Each vector
  records that dependence, the relative n-dot change that a change of 0.001 in the one entry causes (3.7e-5 to
  9.0e-4, median 5.5e-4). The library's entries reproduce all 379 to 2.3e-7, so an entry held 0.001 away from the
  printed value shows as a miss of about the recorded size. Of the 37 cells side B marks as printed with a final
  zero, only 160 km, 1100 K is held away (next item).
- **Observed behavior, 160 km and 1100 K** *[probe 3.9, 3.10, 3.11]*: the library's entry is one unit above the
  printed Table 6 value in the third decimal. With that entry the 28 vectors on the 160 km row (3.9, and 3.10 at 2026 days
  250.5 to 330.5 with the node right ascension every 90 deg) are reproduced to 7e-8; with the printed value they are
  missed by 1.7e-4 to 5e-4.
- **Observed behavior, further entries** *[probe 3.12]*: 39 more row probes of the 3.11 kind (24 cells of side B's
  refreshed heavy-drag list and its 16 remaining override cells, at the year, date and node right ascension where each
  cell weighs most; recorded weight 9.2e-5 to 8.9e-4). The library's entry is one unit above the printed value in the
  third decimal at 92 km (650, 700, 750 and 800 K), 94 km (700 K), 125 km (850 K), 130 km (650 K), 320 km (1250 K),
  330 km (1350 K), 360 km (800 K), 370 km (750 K), 380 km (750 and 850 K), 500 km (700 K) and 740 km (900 K), and one
  unit below it at 1600 km (700 K); every other probed cell equals the printed value. A row whose vectors disagree with Table 6 elsewhere points at
  another such cell.
- **Seasonal-latitudinal term**, for 90 < h < 300 km only: Delta log10 rho = (1/50) (h - 90) exp(-0.045 (h - 90))
  sin(2 pi (D + 100) / N) cos^2(phi), negated when the geodetic latitude phi of the point (3.4) is negative
  (phi = 0, of either sign of zero, counts as north), D the day of year minus 1, N the days in the year.
- **Units**: rho (kg/m^3) = 10^(log10 rho + Delta log10 rho + 3).

### 3.4 Drag rates and orbit averaging

All quantities in R_E and minutes unless stated; n, a, e, i, Omega, omega the mean elements at the evaluation time,
eta = sqrt(1 - e^2), p = a eta^2, theta = cos i, omega_E = 4.37526908801129966e-3 rad/min, eps^2 = f (2 - f) with
the flattening f of 1.3, B the ballistic coefficient (m^2/kg) *[study; probe 3.5, 3.6]*.

**Arc.** With h_p = R_E [a (1 - e) - 1 + f sin^2 i sin^2 omega] (km) and b = min(900, max(90, h_p)), the band above
perigee is Delta = b (c1 + b (c2 + b (c3 + b (c4 + b (c5 + b (c6 + b c7)))))) km, c1 = -3.130124,
c2 = 0.061710434, c3 = -3.4111266e-4, c4 = 8.7321429e-7, c5 = -1.122534e-9, c6 = 7.1123451e-13,
c7 = -1.776575e-16. If Delta/R_E < 2 a e, nu_c = arccos[(r_p e - Delta/R_E) / (e (r_p + Delta/R_E))],
r_p = a (1 - e); otherwise nu_c = pi.

**Nodes.** nu_j = nu_c x_j, j = 1..13, with the Gauss-Legendre nodes x_j and weights w_j (Abramowitz & Stegun 1964,
table 25.4): x = 0, +/-0.23045831595513480, +/-0.44849275103644692, +/-0.64234933944034023,
+/-0.80157809073330988, +/-0.91759839922297803, +/-0.98418305471858814; w = 0.23255155323087390,
0.22628318026289720, 0.20781604753688851, 0.17814598076194571, 0.13887351021978719, 0.092121499837728452,
0.040484004765315877. At each node, u = omega + nu, D = 1 + e cos nu, and:

- omega (like Omega and M) is the current mean element recovered from the equinoctial set, omega = atan2(a_g, a_f)
  minus atan2(chi, psi), then reduced to [0, 2 pi): an angle beyond 2 pi in magnitude is first reduced modulo 2 pi,
  and a negative one has 2 pi added; u = omega + nu in double precision. With argp = 0 at the epoch (a_f = e
  cos(omega_0 + Omega_0), a_g = e sin(omega_0 + Omega_0), chi = tan(i_0 / 2) sin Omega_0, psi = tan(i_0 / 2) cos
  Omega_0, the angles the element set's degrees times pi / 180) the central node (nu = 0) lies on the equator only
  to rounding: the two arctangents differ by zero or a few units in the last place, and a negative difference
  becomes 2 pi in double precision (6.283185307179586, or one unit lower), whose sine is negative (-2.449e-16). That
  node then counts as southern in the seasonal-latitudinal term (3.3); a zero or positive difference makes it
  northern *[study; probe 3.5, 3.8: all 84 equator-node cases follow this, 15 of them southern]*.
- radius, mean orbit plus the J2 short-period radius of section 8: r = p/D + c [(1 - theta^2) cos 2u
  - (3 theta^2 - 1)(e cos nu/(1 + eta) + 2 eta/D + 1)], c = J2/(4p);
- geocentric latitude phi' = arcsin(sin i sin u); with N = eps^2 sin phi' cos phi', n0 = 1 - eps^2 cos^2 phi',
  W0 = sqrt(1 - eps^2 sin^2 phi'): t1 = N / (n0 + W0 (r - W0)), phi1 = phi' + arctan t1,
  W1 = sqrt(1 - eps^2 sin^2 phi1);
- geodetic height h = R_E [r / sqrt(1 + t1^2) - W1] (km) and geodetic latitude phi = phi' + arctan(N / (n0 + W1 h/R_E));
- Sun-relative hour angle H = alpha - alpha_sun reduced to [0, 2 pi), alpha the right ascension of the direction
  (cos Omega cos u - sin Omega sin u theta, sin Omega cos u + cos Omega sin u theta), alpha_sun and delta_sun from the
  Sun of section 5 at the evaluation time;
- density rho (kg/m^3) from 3.1-3.3 at (h, T_inf), the diurnal term using the GEOCENTRIC latitude phi' with
  delta_sun and H, the seasonal-latitudinal term using the GEODETIC latitude phi (below 10 km and above 2500 km
  as in 3.3);
- speed factor V = sqrt(1 + 2 e cos nu + e^2 - 2 q theta + q^2 cos^2 phi' / D^2), q = omega_E eta^3 / n, which is
  eta |v - omega_E x r| / (n a) (atmosphere co-rotating with the Earth);
- weight K = w_j rho V / D^2.

**Sums** over the 13 nodes: G = sum K, S_D = sum K D, S_e = sum K (e + cos nu), S_su = sum K sin u cos u / D^2,
S_n = sum K sin nu / D, S_nc = sum K sin nu cos nu / D^2, S_uu = sum K cos^2 u / D^2,
S_s = sum K sin nu (1 - q theta / D^2), S_w = sum K (D cos nu + e + cos nu) / D^2.

**Rates** (rad/min; same six as sections 2 and 5): with P = 500 R_E nu_c / pi (R_E in km; P = (R_E in m)
nu_c / (2 pi)), A_r = eta^2 n a / 2, oa = q theta:

- n-dot = P B 3 n (n a / 2) [S_D + e S_e - oa G];
- e-dot = P B A_r [oa S_w - 2 S_e];
- i-dot = -P B sin i q A_r S_uu;
- Omega-dot = -P B q A_r S_su, so the component of section 2 is sin i Omega-dot = -P B q A_r sin i S_su;
- e varpi-dot = P B [e (oa - q) A_r S_su + e oa A_r S_nc - 2 A_r S_s];
- lambda-dot - n = P B [(oa - q) A_r S_su + 2 eta e A_r S_n + (1 - eta) oa A_r S_nc - (2 e A_r / (1 + eta)) S_s].

Since oa - q = -q (1 - cos i), the S_su parts of e varpi-dot and lambda-dot - n are e (1 - cos i) Omega-dot and
(1 - cos i) Omega-dot *[probe 3.13, 6.9, 8.5; side B's fit at 580 of the library's hourly states
along the 3.13 sets gives every coefficient as 1.00000. At 290 library states along the ten 3.13 sets these
equations, with the zonal and third-body rates, reproduce the library's six rates to 2e-7 relative in a_f, chi,
psi and lambda-dot - n and to 2e-5 in a_g (whose rate passes near zero), against 1e-2 to 6e-5 with sin i Omega-dot
for Omega-dot and oa for oa - q; with resonance and SRP added they reproduce the epoch rates of the decaying
0.5-day sets of 6.9 and 8.5 to 1e-8 in every component]*.

For a circular orbit with the atmosphere at rest this is n-dot = (3/2) n rho B v, the drag acceleration
-(1/2) rho B |v_rel| v_rel with B = C_D A/m: no factor 1/2 is folded into B.

*[probe 3.5]* Confirmed: these equations, with the density of 3.1-3.3, reproduce the library's drag rates on the
3.5 cases to 1e-9 (worst 4e-6) relative.

**Sizes of the formulation elements** (log10 of the library's drag n-dot over a variant, 2024 day 100.5; first
value circular at i = 51.6 deg, second e = 0.05 at i = 0.1 deg) *[study; probe 3.6]*:

| element removed | 200 km | 400 km | 600 km | 1000 km |
| --- | --- | --- | --- | --- |
| geodetic height (spherical instead) | -0.080 / 0.000 | -0.044 / 0.000 | -0.034 / 0.000 | -0.013 / 0.000 |
| J2 radius at the nodes (mean radius instead) | +0.008 / +0.107 | +0.005 / +0.058 | +0.004 / +0.046 | +0.001 / +0.019 |
| co-rotation (V without q) | -0.034 / -0.054 | -0.035 / -0.057 | -0.037 / -0.060 | -0.040 / -0.066 |
| perigee arc (full orbit instead) | 0.000 / -0.022 | 0.000 / -0.005 | 0.000 / 0.000 | 0.000 / 0.000 |
| hour angle H shifted by pi | 0.000 / +0.099 | +0.003 / +0.345 | +0.006 / +0.518 | +0.005 / +0.251 |
| hour angle sign flipped (-H) | +0.002 / +0.023 | +0.018 / +0.078 | +0.041 / +0.113 | +0.038 / +0.069 |
| geodetic instead of geocentric latitude in the diurnal term | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 |
| seasonal-latitudinal term | -0.001 / -0.002 | 0.000 / 0.000 | 0.000 / 0.000 | 0.000 / 0.000 |

A positive entry means the variant gives less drag than the library. Circular orbits average the diurnal bulge over
local time; eccentric orbits sample it at the perigee's local time, so the hour-angle convention shows there. The section-3.6 vectors separate these
elements black-box: inclination 0.1-179.9 deg at a 300 km circular perigee (co-rotation and latitude), perigee
latitude 0-90 deg at i = 90 deg and e = 0.05 (oblate height), and e = 0.0001-0.2 at a 300 km perigee (arc and the
J2 radius), each as the B = 0.01 minus B = 0 n rate.

**Confirmed.** *[probe 3.1]* Drag changes the mean motion secularly and depends on the date through the flux model:
for a circular orbit at inclination 51.6 deg, B = 0.01 m^2/kg, the n-dot (rev/day^2) and the effective density
rho_eff = (2/3) (n-dot / n) / (B v) (circular-orbit relation, v the circular speed) are:

| altitude (km) | rho_eff 2009-04-10 (kg/m^3) | rho_eff 2024-04-09 (kg/m^3) |
| --- | --- | --- |
| 300 | 8.29e-12 | 2.50e-11 |
| 400 | 8.35e-13 | 4.23e-12 |
| 500 | 1.12e-13 | 9.12e-13 |
| 600 | 2.12e-14 | 2.27e-13 |
| 800 | 3.27e-15 | 2.16e-14 |

The 2024/2009 ratio follows 3.1 (cycle 25 near maximum against the cycle-24 minimum).

*[probe 3.5]* The density check vectors: the drag part of the n rate (rev/day^2, B = 0.02 and 0.01 minus B = 0)
at epoch for perigee heights 200-1200 km, six dates across solar cycles 22-25 (flux and Ap of 3.1), e = 0.0001 to
0.1 and i = 0.1 to 97.5 deg (360 cases); the matching semi-major-axis rate is a-dot = -(2/3) a n-dot / n. The drag
part is exactly linear in B (ratio 2 to 1e-6), positive, and falls with perigee height at every date, so B enters
only as a factor and the vectors pin rho through the averaged Gauss equations.

*[probe 3.2]* The atmosphere co-rotates with the Earth and the drag is quadratic in the relative speed: at 400 km
the retrograde/prograde equatorial n-dot ratio is 1.2945 against ((v + omega_E r) / (v - omega_E r))^2 = 1.2946,
so the acceleration is -(1/2) rho B |v_rel| v_rel with v_rel = v - omega_E x r and B = C_D A/m (3.4).

*[probe 3.13]* Along 7 days of the ten heavy-drag sets side B lists as worst (15.0 to 15.8 rev/day, e up to 0.02,
perigees near 200 km; AGOM 0), the drag rates of this section with the library's entries reproduce the library's
n-dot, which is the drag alone there, at every hour to 1.4e-9 relative.

## 4. Solar radiation pressure and shadow

**Force.** Cannonball SRP: acceleration magnitude P AGOM, directed away from the Sun, zero in the Earth's shadow,
with P = 4.5e-6 N/m^2 *[study; probe 4.1]* and AGOM from the element set (1.1, so AGOM carries C_R). The value is
scaled to Earth radii and minutes (x 3600 s^2/min^2, / 1000 R_E m) *[study]* and by (1 AU / r_sun)^2, AU =
149597870 km *[probe 4.2: the GEO SRP e-vector rate at perihelion over aphelion is 1.0695, the inverse-square
ratio]*.

**Shadow** (Escobal 1965, 5.3, cylindrical shadow of radius R_E) *[study; probe 4.4, 4.7]*. On the current mean orbit,
with A, B the Sun's unit vector on P, Q (5.4), p = a (1 - e^2) in R_E, x = cos nu and n(nu) = A cos nu + B sin nu,
the boundary function is S(nu) = p^2 n^2 + (1 + e cos nu)^2 - p^2: the satellite is in shadow where n < 0 and S > 0.
Eliminating sin nu gives the quartic in x
K(x)^2 - 4 A^2 B^2 x^2 (1 - x^2) = 0, K(x) = (B^2 - A^2) x^2 + (1 - B^2) - (1 + e x)^2 / p^2.
The library solves it in closed form and then keeps only the roots that pass a boundary test of 1e-12. Its roots
carry rounding errors well above that test at many geometries, so which shadows it finds depends on the exact
sequence below. Every quantity is a double-precision number; sums and products are evaluated from left to right
as written, parentheses first; pow is the general power function, sqrt the square root, atan2(y, x) the
two-argument arctangent, and cbrt(x) = sign(x) |pow(|x|, 1/3)| with 1/3 the double 0.3333333333333333. The
elements are the current mean elements recovered from the equinoctial set: a = pow(k_e / n, 2/3) with 2/3 the double
0.6666666666666666, e = sqrt(a_f a_f + a_g a_g), i = t + t with t = atan(sqrt(chi chi + psi psi)),
Omega = atan2(chi, psi) and omega = atan2(a_g, a_f) - Omega, both reduced to [0, 2 pi) as in step 7 (3.4); the Sun
is that of section 5 at the evaluation time.

1. Direction cosines, with cw = cos omega, sw = sin omega, cO = cos Omega, sO = sin Omega, ci = cos i, si = sin i
   and the Sun's unit vector (s_x, s_y, s_z):
   B = (cw si) s_z + s_x ((cO (-sw)) - ci (cw sO)) + s_y (ci (cw cO) - sO sw),
   A = (sw si) s_z + s_x ((cw cO) - ci (sO sw)) + s_y ((cw sO) + (ci sw) cO).
2. Quartic coefficients, with G = B^2, H = A^2, F = G + H, e2 = e e, p = (1 - e2) a, j = (1/p)(1/p), h = j j,
   k = G - H, g = 1 - G and m = j (-2):
   c4 = (F F + (h e2) e2) + e2 (k m),
   c3 = (e e2)(4 h) + (e (-4 j)) k,
   c2 = (((H (-4)) G + (k + k) g) + (g m) e2) + (6 h) e2 + k m,
   c1 = (4 h) e + (e (-4 j)) g,
   c0 = ((g m + h) + g g).
   If c4 = 0 there is no boundary.
3. Monic and depressed: a3 = c3/c4, a2 = c2/c4, a1 = c1/c4, a0 = c0/c4, f = a3 (-0.25), f2 = f f,
   f3 = pow(f, 3), f4 = pow(f, 4), b3 = 3 a3:
   P = (a2 + 6 f2) + b3 f,
   Q = ((a1 + (a2 + a2) f) + 4 f3) + b3 f2,
   W = (((((a0 + a1 f) + a2 f2) + f4) + a3 f3) (-4)) + P P.
4. Depressed resolvent cubic t^3 + s1 t + s3 = 0:
   s3 = (((Q Q)(-27) + pow(P, 3) 16) + (P (-18)) W) / 27,  s1 = (3 W + (P P)(-4)) / 3,
   D = (s3 s3) 0.25 + pow(s1, 3) / 27, and its roots:
   - D > 0: t1 = cbrt(s3 (-0.5) + sqrt(D)) + cbrt(s3 (-0.5) - sqrt(D)), and t2 = t3 = 0 (zeros stand in for the
     complex pair);
   - D = 0: t1 = 2 cbrt(s3 (-0.5)), t2 = t3 = cbrt(s3 0.5);
   - D < 0: w = sqrt(pow(-s1, 3) / 27), c = -s3 / (w + w), phi = atan2(sqrt(1 - c c), c) / 3,
     u = 2 sqrt(s1 / (-3)): t1 = u cos phi, t2 = u cos(phi + 2 pi/3), t3 = u cos(phi + 4 pi/3), the two angles
     added as the doubles 2.0943951023931953 and 4.1887902047863905;
   - otherwise (D not a number): t1 = t2 = t3 = 0.
5. Resolvent root: z_k = (P (-2)) / 3 + t_k; z is z_2 if z_2 > z_3, else z_3; then z_1 if z_1 > z, else z. If
   z < 0 there is no boundary.
6. Quadratic factors, with r = sqrt(z) and q = Q / r:
   D1 = ((((P + z) - q) 0.5) (-4)) + z and D2 = ((((P + z) + q) 0.5) (-4)) + z.
   Where D1 is not negative it gives y = (sqrt(D1) - r) 0.5 and y = (-r - sqrt(D1)) 0.5; where D2 is not negative
   it gives y = (r + sqrt(D2)) 0.5 and y = (r - sqrt(D2)) 0.5, in this order. Each gives x = f + y and the true
   anomaly nu = arccos x; an x outside [-1, 1] gives no candidate.
7. Candidates, in this order: the (up to) four nu, then 2 pi - nu for each of them in the same order (2 pi the double
   6.283185307179586; every angle reduced to [0, 2 pi): an angle beyond 2 pi in magnitude is first reduced modulo
   2 pi, a negative one has 2 pi added). For each: n = A cos nu + B sin nu, d = e cos nu + 1,
   S = ((p p) n) n + d d - p p, and dS/dnu = ((e d)(-2)) sin nu + ((-A) sin nu + B cos nu)(p p)(n + n). The candidate
   is a boundary when n < 0 and |S| < 1e-12: an entry when dS/dnu > 0, otherwise an exit. Entry and exit anomalies
   start at 0; each of the first two boundaries found sets one of them, and later boundaries are ignored. With fewer
   than two boundaries the orbit counts as wholly sunlit.
8. Eccentric anomalies: E = 2 atan(tan(nu/2) k), k = sqrt((1 - e)/(e + 1)), reduced to [0, 2 pi); E_1 at the exit,
   E_2 at the entry, E_2 + 2 pi when E_2 < E_1; the sunlit arc runs from E_1 to E_2. If |E_2 - E_1| < 1e-12 the
   wholly sunlit formulas apply.

This sequence is SGP4XP's. AP sets take 16.15's shadow, whose boundaries are continuous in the elements.

The 1e-12 test is tight against the rounding of this sequence. At GEO (p^2 near 44) its roots usually miss the test,
so the GEO eclipse season is averaged as wholly sunlit, while LEO, MEO and HEO shadows are mostly found *[study;
probe 4.4]*. At high eccentricities the misses are frequent too *[probe 4.7]*: hourly along 7 days of seven of side
B's listed sets (e = 0.70 to 0.73 in the 0.5-day band, and two MEO sets), the library averages 35, 19, 47 and 30 of
the 169 evaluations of four HEO sets as wholly sunlit although the orbit crosses the shadow, and 5 of one MEO set.
The sequence above reproduces the library's decision at 1,179 of the 1,183 evaluations, every miss included. The
other four are rounding-limited: a root near nu = 0 or 2 pi, where arccos magnifies the last bits of x, with |S|
within a factor of three of 1e-12. Two of the listed sets, with e = 0.70 at 2.21 rev/day and with e = 0.016 at 5.43
rev/day, show no misses at all, but 6 and 17 of their 169 evaluations have such a rounding-limited candidate; there
the decision depends on the last bits of the arithmetic (operation order, fused multiply-adds, the elementary
functions), which no specification of the mathematics can fix. The 9.9 and 9.1.1.0 versions differ in this test
in the same way (section 11).

**Rounding-limited decisions** *[study; probe 4.9, 4.10]*. The 9.9 build evaluates parts of this sequence with fused
multiply-adds, and near the 1e-12 test its decision follows from that arithmetic. A decision is rounding-limited
when (a) some candidate with n < 0 has 1e-13 <= |S| <= 1e-11 in the sequence above, or (b) moving each input of the
sequence (a, e, i, Omega, omega and the three components of the Sun direction) by up to 8 units in the last place
changes the decision. Both outcomes of a rounding-limited decision conform. This applies to every rate
evaluation, the node and stage evaluations of the integrator (9) included, and not only to output times. On the
720 geometries of 4.9 the sequence takes the library's decision at 575; all 145 others are rounding-limited (136 by
(a) alone), and 566 of the 720 are rounding-limited in all, the near-circular GEO sets in the eclipse season nearly
always.

**Averaged rates** *[study; probe 4.4]*. With F_s = 4.5e-6 AGOM 3600 / (1000 R_E (r_sun/AU)^2) (R_E/min^2), a in
R_E, n in rad/min, eta = sqrt(1 - e^2) and A, B, C on P, Q, W, the SRP contributions to the equinoctial rates
(rad/min; lambda-dot, n-dot in rad/min^2, chi-dot, psi-dot, a_f-dot, a_g-dot), added to the other rates after their
conversion to equinoctial form:

**Wholly sunlit orbit:**

- lambda-dot = F_s ( A [-3 e (2 e^2 - 3 eta - 2)/(2 a n (e^2 - eta - 1))] + C [-3 e (eta + 1) sin(i) sin(omega)/(2 a
  n (cos(i) + 1) (e^2 - eta - 1))] )
- n-dot = 0
- chi-dot = F_s ( C [3 e sin(Omega + omega)/(2 a eta n (cos(i) + 1))] )
- psi-dot = F_s ( C [3 e cos(Omega + omega)/(2 a eta n (cos(i) + 1))] )
- a_f-dot = F_s ( A [-3 eta sin(Omega + omega)/(2 a n)] + B [-3 eta cos(Omega + omega)/(2 a n)] + C [-3 e^2 sin(i)
  sin(omega) sin(Omega + omega)/(2 a eta n (cos(i) + 1))] )
- a_g-dot = F_s ( A [3 eta cos(Omega + omega)/(2 a n)] + B [-3 eta sin(Omega + omega)/(2 a n)] + C [3 e^2 sin(i)
  sin(omega) cos(Omega + omega)/(2 a eta n (cos(i) + 1))] )

**Sunlit arc from E_1 to E_2:**

- lambda-dot = F_s ( A [-(-12 E_1 e^3 + 18 E_1 e eta + 12 E_1 e + 12 E_2 e^3 - 18 E_2 e eta - 12 E_2 e + 4 e^4
  sin(E_1) - 4 e^4 sin(E_2) - 6 e^3 sin(2E_1) + 6 e^3 sin(2E_2) - 8 e^2 eta sin(E_1) + 8 e^2 eta sin(E_2) + 16 e^2
  sin(E_1) - 16 e^2 sin(E_2) + 5 e eta sin(2E_1) - 5 e eta sin(2E_2) + 6 e sin(2E_1) - 6 e sin(2E_2) - 20 eta
  sin(E_1) + 20 eta sin(E_2) - 20 sin(E_1) + 20 sin(E_2))/(8 pi a n (e^2 - eta - 1))] + B [(5 e^3 eta sin(E_1)^2 - 5
  e^3 eta sin(E_2)^2 + 5 e^3 sin(E_1)^2 - 5 e^3 sin(E_2)^2 + 8 e^2 eta cos(E_1) - 8 e^2 eta cos(E_2) + 10 e^2
  cos(E_1) - 10 e^2 cos(E_2) - 6 e eta sin(E_1)^2 + 6 e eta sin(E_2)^2 - 5 e sin(E_1)^2 + 5 e sin(E_2)^2 - 10 eta
  cos(E_1) + 10 eta cos(E_2) - 10 cos(E_1) + 10 cos(E_2))/(4 pi a n (e^2 - eta - 1))] + C [-(-3 E_1 e eta sin(omega)
  - 3 E_1 e sin(omega) + 3 E_2 e eta sin(omega) + 3 E_2 e sin(omega) + e^3 sin(E_1)^2 cos(omega) - e^3 sin(E_2)^2
  cos(omega) + 2 e^2 eta sin(E_1) sin(omega) - 2 e^2 eta sin(E_2) sin(omega) + 2 e^2 cos(E_1 - omega) - 2 e^2
  cos(E_2 - omega) - e eta sin(E_1) sin(E_1 + omega) + e eta sin(E_2) sin(E_2 + omega) - e sin(E_1) sin(E_1 + omega)
  + e sin(E_2) sin(E_2 + omega) - 2 eta cos(E_1 + omega) + 2 eta cos(E_2 + omega) - 2 cos(E_1 + omega) + 2 cos(E_2 +
  omega)) sin(i)/(4 pi a n (cos(i) + 1) (e^2 - eta - 1))] )
- n-dot = F_s ( A [-3 (cos(E_1) - cos(E_2))/(2 pi a)] + B [-3 eta (sin(E_1) - sin(E_2))/(2 pi a)] )
- chi-dot = F_s ( C [(-12 E_1 e sin(Omega + omega) + 12 E_2 e sin(Omega + omega) + 8 e^2 sin(E_1) sin(Omega + omega)
  - 8 e^2 sin(E_2) sin(Omega + omega) - 4 e eta sin(E_1)^2 cos(Omega + omega) + 4 e eta sin(E_2)^2 cos(Omega +
  omega) - e cos(-2 E_1 + Omega + omega) + e cos(2 E_1 + Omega + omega) + e cos(-2 E_2 + Omega + omega) - e cos(2
  E_2 + Omega + omega) - 8 eta cos(E_1) cos(Omega + omega) + 8 eta cos(E_2) cos(Omega + omega) + 8 sin(E_1)
  sin(Omega + omega) - 8 sin(E_2) sin(Omega + omega))/(16 pi a eta n (cos(i) + 1))] )
- psi-dot = F_s ( C [(-12 E_1 e cos(Omega + omega) + 12 E_2 e cos(Omega + omega) + 8 e^2 sin(E_1) cos(Omega + omega)
  - 8 e^2 sin(E_2) cos(Omega + omega) + 4 e eta sin(E_1)^2 sin(Omega + omega) - 4 e eta sin(E_2)^2 sin(Omega +
  omega) + e sin(-2 E_1 + Omega + omega) - e sin(2 E_1 + Omega + omega) - e sin(-2 E_2 + Omega + omega) + e sin(2
  E_2 + Omega + omega) + 8 eta sin(Omega + omega) cos(E_1) - 8 eta sin(Omega + omega) cos(E_2) + 8 sin(E_1)
  cos(Omega + omega) - 8 sin(E_2) cos(Omega + omega))/(16 pi a eta n (cos(i) + 1))] )
- a_f-dot = F_s ( A [(e - 1) (e + 1) (-6 E_1 sin(Omega + omega) + 6 E_2 sin(Omega + omega) + 2 e cos(-E_1 + Omega +
  omega) - 2 e cos(E_1 + Omega + omega) - 2 e cos(-E_2 + Omega + omega) + 2 e cos(E_2 + Omega + omega) - cos(2 E_1 +
  Omega + omega) + cos(2 E_2 + Omega + omega))/(8 pi a eta n)] + B [-(12 E_1 e^2 cos(Omega + omega) - 12 E_1
  cos(Omega + omega) - 12 E_2 e^2 cos(Omega + omega) + 12 E_2 cos(Omega + omega) + 8 e^3 sin(-E_1 + Omega + omega) -
  8 e^3 sin(E_1 + Omega + omega) - 8 e^3 sin(-E_2 + Omega + omega) + 8 e^3 sin(E_2 + Omega + omega) - e^2 sin(-2 E_1
  + Omega + omega) + e^2 sin(2 E_1 + Omega + omega) + e^2 sin(-2 E_2 + Omega + omega) - e^2 sin(2 E_2 + Omega +
  omega) + 8 e eta sin(Omega + omega) cos(E_1) - 8 e eta sin(Omega + omega) cos(E_2) - 8 e sin(-E_1 + Omega + omega)
  + 8 e sin(E_1 + Omega + omega) + 8 e sin(-E_2 + Omega + omega) - 8 e sin(E_2 + Omega + omega) + 4 eta sin(E_1)^2
  sin(Omega + omega) - 4 eta sin(E_2)^2 sin(Omega + omega) + sin(-2 E_1 + Omega + omega) - sin(2 E_1 + Omega +
  omega) - sin(-2 E_2 + Omega + omega) + sin(2 E_2 + Omega + omega))/(16 pi a eta n)] + C [-e (-3 E_1 e sin(omega)
  sin(Omega + omega) + 3 E_2 e sin(omega) sin(Omega + omega) + 2 e^2 sin(E_1) sin(omega) sin(Omega + omega) - 2 e^2
  sin(E_2) sin(omega) sin(Omega + omega) - e eta sin(E_1)^2 sin(Omega) - e eta sin(E_1)^2 sin(omega) cos(Omega +
  omega) + e eta sin(E_2)^2 sin(Omega) + e eta sin(E_2)^2 sin(omega) cos(Omega + omega) - e sin(E_1) sin(omega)
  sin(Omega + omega) cos(E_1) + e sin(E_2) sin(omega) sin(Omega + omega) cos(E_2) - 2 eta sin(Omega) cos(E_1) + 2
  eta sin(Omega) cos(E_2) - 2 eta sin(omega) cos(E_1) cos(Omega + omega) + 2 eta sin(omega) cos(E_2) cos(Omega +
  omega) + 2 sin(E_1) sin(omega) sin(Omega + omega) - 2 sin(E_2) sin(omega) sin(Omega + omega)) sin(i)/(4 pi a eta n
  (cos(i) + 1))] )
- a_g-dot = F_s ( A [(e - 1) (e + 1) (6 E_1 cos(Omega + omega) - 6 E_2 cos(Omega + omega) + 2 e sin(-E_1 + Omega +
  omega) - 2 e sin(E_1 + Omega + omega) - 2 e sin(-E_2 + Omega + omega) + 2 e sin(E_2 + Omega + omega) - sin(2 E_1 +
  Omega + omega) + sin(2 E_2 + Omega + omega))/(8 pi a eta n)] + B [(-12 E_1 e^2 sin(Omega + omega) + 12 E_1
  sin(Omega + omega) + 12 E_2 e^2 sin(Omega + omega) - 12 E_2 sin(Omega + omega) + 8 e^3 cos(-E_1 + Omega + omega) -
  8 e^3 cos(E_1 + Omega + omega) - 8 e^3 cos(-E_2 + Omega + omega) + 8 e^3 cos(E_2 + Omega + omega) - e^2 cos(-2 E_1
  + Omega + omega) + e^2 cos(2 E_1 + Omega + omega) + e^2 cos(-2 E_2 + Omega + omega) - e^2 cos(2 E_2 + Omega +
  omega) + 8 e eta cos(E_1) cos(Omega + omega) - 8 e eta cos(E_2) cos(Omega + omega) - 8 e cos(-E_1 + Omega + omega)
  + 8 e cos(E_1 + Omega + omega) + 8 e cos(-E_2 + Omega + omega) - 8 e cos(E_2 + Omega + omega) + 4 eta sin(E_1)^2
  cos(Omega + omega) - 4 eta sin(E_2)^2 cos(Omega + omega) + cos(-2 E_1 + Omega + omega) - cos(2 E_1 + Omega +
  omega) - cos(-2 E_2 + Omega + omega) + cos(2 E_2 + Omega + omega))/(16 pi a eta n)] + C [e (-3 E_1 e sin(omega)
  cos(Omega + omega) + 3 E_2 e sin(omega) cos(Omega + omega) + 2 e^2 sin(E_1) sin(omega) cos(Omega + omega) - 2 e^2
  sin(E_2) sin(omega) cos(Omega + omega) + e eta sin(E_1)^2 sin(omega) sin(Omega + omega) - e eta sin(E_1)^2
  cos(Omega) - e eta sin(E_2)^2 sin(omega) sin(Omega + omega) + e eta sin(E_2)^2 cos(Omega) - e sin(E_1) sin(omega)
  cos(E_1) cos(Omega + omega) + e sin(E_2) sin(omega) cos(E_2) cos(Omega + omega) + 2 eta sin(omega) sin(Omega +
  omega) cos(E_1) - 2 eta sin(omega) sin(Omega + omega) cos(E_2) - 2 eta cos(E_1) cos(Omega) + 2 eta cos(E_2)
  cos(Omega) + 2 sin(E_1) sin(omega) cos(Omega + omega) - 2 sin(E_2) sin(omega) cos(Omega + omega)) sin(i)/(4 pi a
  eta n (cos(i) + 1))] )

*[probe 4.4]* Confirmed: with the shadow rule above and these formulas, the SRP rate contributions are reproduced to
1e-13 relative in LEO, MEO, HEO and wholly sunlit GEO cases; in the GEO equinox case the library takes the wholly
sunlit branch (its boundary test fails), and these formulas reproduce it once the same branch is taken.

**Output-time SRP periodic terms.** With AGOM non-zero, analytic SRP short-period corrections (periodic in the
eccentric anomaly E, the Sun held fixed at the output time, no shadow) are added directly to the equinoctial
elements at the output time, after the third-body corrections of 5.4, in both regimes (in the long-period regime
there are no third-body corrections to come first), with E the eccentric anomaly of the interpolated mean elements
(Kozai 1961; Aksnes 1976) *[study; probe 4.3, 4.5]*. With F_s = 4.5e-6 AGOM 3600 / (1000 R_E (r_sun/AU)^2) (the SRP acceleration in R_E/min^2, R_E in km), a in
R_E, n in rad/min, eta = sqrt(1 - e^2) and A, B, C the Sun's unit vector projected on the perigee frame P, Q, W of
5.4:

- Delta lambda = F_s ( A [-(4 e^4 + 6 e^3 cos(E) - 5 e^2 eta - 14 e^2 - 5 e eta cos(E) - 6 e cos(E) + 10 eta + 10)
  sin(E)/(2 a n^2 (e^2 - eta - 1))] + B [-(10 e^3 eta sin(E)^2 - 5 e^3 eta + 10 e^3 sin(E)^2 - 5 e^3 + 16 e^2 eta
  cos(E) + 20 e^2 cos(E) - 12 e eta sin(E)^2 + 6 e eta - 10 e sin(E)^2 + 5 e - 20 eta cos(E) - 20 cos(E))/(4 a n^2
  (e^2 - eta - 1))] + C [(2 e^3 sin(E)^2 cos(omega) - e^3 cos(omega) - 2 e^2 eta sin(E) sin(omega) - 2 e^2 sin(E)
  sin(omega) + 4 e^2 cos(E) cos(omega) - 2 e eta sin(E) sin(E + omega) + e eta cos(omega) - 2 e sin(E) sin(E +
  omega) + e cos(omega) - 4 eta cos(E + omega) - 4 cos(E + omega)) sin(i)/(4 a n^2 (cos(i) + 1) (e^2 - eta - 1))] )
- Delta n = F_s ( A [3 cos(E)/(a n)] + B [3 eta sin(E)/(a n)] )
- Delta chi = F_s ( C [(4 e^2 sin(E) sin(Omega + omega) - 4 e eta cos(E)^2 cos(Omega + omega) + 2 e eta cos(Omega +
  omega) + e cos(-2 E + Omega + omega) - e cos(2 E + Omega + omega) + 8 eta cos(E) cos(Omega + omega) - 8 sin(E)
  sin(Omega + omega))/(8 a eta n^2 (cos(i) + 1))] )
- Delta psi = F_s ( C [(4 e^2 sin(E) cos(Omega + omega) - 4 e eta sin(E)^2 sin(Omega + omega) + 2 e eta sin(Omega +
  omega) - e sin(-2 E + Omega + omega) + e sin(2 E + Omega + omega) - 8 eta sin(Omega + omega) cos(E) - 8 sin(E)
  cos(Omega + omega))/(8 a eta n^2 (cos(i) + 1))] )
- Delta a_f = F_s ( A [(e - 1) (e + 1) (e cos(-E + Omega + omega) - e cos(E + Omega + omega) + cos(2 E + Omega +
  omega))/(4 a eta n^2)] + B [(2 e^3 sin(-E + Omega + omega) - 2 e^3 sin(E + Omega + omega) - e^2 sin(-2 E + Omega +
  omega) + e^2 sin(2 E + Omega + omega) + 8 e eta sin(Omega + omega) cos(E) - 2 e sin(-E + Omega + omega) + 2 e
  sin(E + Omega + omega) + 4 eta sin(E)^2 sin(Omega + omega) - 2 eta sin(Omega + omega) + sin(-2 E + Omega + omega)
  - sin(2 E + Omega + omega))/(8 a eta n^2)] + C [-e (2 e^2 sin(E) sin(omega) sin(Omega + omega) - 2 e eta
  sin(Omega) cos(E)^2 + e eta sin(Omega) - 2 e eta sin(omega) cos(E)^2 cos(Omega + omega) + e eta sin(omega)
  cos(Omega + omega) + 2 e sin(E) sin(omega) sin(Omega + omega) cos(E) + 4 eta sin(Omega) cos(E) + 4 eta sin(omega)
  cos(E) cos(Omega + omega) - 4 sin(E) sin(omega) sin(Omega + omega)) sin(i)/(4 a eta n^2 (cos(i) + 1))] )
- Delta a_g = F_s ( A [(e - 1) (e + 1) (e sin(-E + Omega + omega) - e sin(E + Omega + omega) + sin(2 E + Omega +
  omega))/(4 a eta n^2)] + B [-(2 e^3 cos(-E + Omega + omega) - 2 e^3 cos(E + Omega + omega) - e^2 cos(-2 E + Omega
  + omega) + e^2 cos(2 E + Omega + omega) + 8 e eta cos(E) cos(Omega + omega) - 2 e cos(-E + Omega + omega) + 2 e
  cos(E + Omega + omega) + 4 eta sin(E)^2 cos(Omega + omega) - 2 eta cos(Omega + omega) + cos(-2 E + Omega + omega)
  - cos(2 E + Omega + omega))/(8 a eta n^2)] + C [e (2 e^2 sin(E) sin(omega) cos(Omega + omega) - 2 e eta sin(E)^2
  sin(omega) sin(Omega + omega) + 2 e eta sin(E)^2 cos(Omega) + e eta sin(omega) sin(Omega + omega) - e eta
  cos(Omega) + 2 e sin(E) sin(omega) cos(E) cos(Omega + omega) - 4 eta sin(omega) sin(Omega + omega) cos(E) + 4 eta
  cos(E) cos(Omega) - 4 sin(E) sin(omega) cos(Omega + omega)) sin(i)/(4 a eta n^2 (cos(i) + 1))] )

*[probe 4.3]* Confirmed: with these terms, the third-body terms of 5.4 and the short-period corrections of section 8,
epoch states with AGOM = 0.05 m^2/kg are reproduced to 1.3e-9 km at 15.2 rev/day and to 1.2e-6 km or better at
1.6-5 rev/day (e = 0.0003-0.72); without them the residual is 0.5 m to 90 m.

*[probe 4.5, 4.6]* Long periods, low inclinations and high eccentricities, both regimes (0.5 to 4 rev/day,
e = 0.05 to 0.6, i = 3 to 30 deg, AGOM 0.03 against 0). The formulas of this section, as printed here, agree with
the library's expressions to 3e-13 at 300 random orbits (e up to 0.85, i from 0.5 deg; sunlit, arc and output-time
terms) *[study]*, and against the library: the SRP rate contributions at epoch are reproduced to 4e-9 relative
wherever the shadow decision agrees; epoch states to 1e-11 km in the long-period regime (the SRP part is 40 to
350 m there); states between integrator nodes (47.5 min) and after 1 and 3 days, rebuilt from the library's native
elements at those times, to 3e-6 km. Along the trajectory the averaged SRP rates are evaluated at every integrator
stage with the Sun at that stage's time: one integrator step from the epoch (9) with the rates of sections 2, 4 and
5 reproduces the library's next node to 1e-10 in a_f, a_g and lambda, while holding the SRP Sun at the step start
misses it by 1e-9 to 8e-9 (4.6 vectors: rates at nodes over 13 steps, reproduced to 4e-7 relative). The 4.5 vectors
also carry 30 element sets with AGOM that side B lists as outliers (high-eccentricity sets in the 0.5-day and 1-day
bands, MEO), as given and with AGOM 0, over 7 days: their SRP effect is 0.1 to 13 km, and at epoch the library uses a
sunlit arc for 28 of them (its SRP n-dot is not zero). For the set with e = 0.719 at 2.3765 rev/day the orbit
enters the shadow geometrically, but the library counts it as wholly sunlit: its closed-form boundaries miss the
1e-12 test, as at GEO, so an implementation that solves the quartic more accurately takes the arc there. This is
not rare at these eccentricities: hourly along 7 days of five of the listed sets (e = 0.70 to 0.73, and one MEO
set), the closed-form boundaries miss the test at 3 % to 28 % of the samples where the geometry has a shadow, and
those evaluations are averaged as wholly sunlit *[study; the epoch decisions of all 30 sets agree with the
library]*. Matching the library there needs its closed-form sequence, rounding included, not a better root.

*[probe 4.9]* Side B's SRP outlier sets (near-circular GEO with e = 0.0005 to 0.0025, MEO and VDS), each at 24 epochs
one hour apart: at an epoch the AGOM on-minus-off n-dot is the SRP n-dot alone, zero exactly where the library counts
the orbit wholly sunlit, so these vectors read the library's shadow decision directly. Near-circular GEO in the
eclipse season is almost entirely rounding-limited (20 to 24 of the 24 geometries of each set have a candidate within
a factor of ten of 1e-12), and over all 720 geometries the sequence above takes the library's decision at 575; the
others depend on the last bits of the arithmetic. The VDS set with e = 0.60 at 0.26 rev/day does meet the shadow: the
library takes a sunlit arc at 23 of its 24 geometries, and the sequence agrees at 23.

*[probe 4.10]* Side B's twenty worst sets with e > 0.66 in the 0.5-day band, at node level: from each of the
library's first 8 nodes, one step of 9 with the rates of sections 2 to 6 (the epoch class and F, G at e_0, i_0 of
6.3, the drag terms of 3.4) reproduces the change of n to the next node to 3e-7 of that change at 153 of the 160
steps, most to 1e-8. Each of the other 7 (misses of 1e-4 to 9e-2 of the change) is reproduced to 2e-9 by taking the
other shadow decision at one evaluation of the step (k1, k2 or k4), and each of those 7 decisions is
rounding-limited by (a), with |S| from 1.3e-13 to 1.3e-12; the sequence takes the library's decision at 4 of them.
One such stage decision changes n by up to 2e-9 rad/min, which along track over the remaining days is 80 to 340 m
on these orbits, the size of side B's listed differences for them (30 to 623 m).

*[probe 4.8]* Long periods, e = 0.6 and low inclinations over a week (0.2 to 4 rev/day, i = 1 and 4 deg, AGOM 0.03
against 0; native elements, rates and states every 6 hours for 7 days, and the native elements at the first four
integrator nodes). The output chain of section 8, with the SRP terms at the output time, rebuilds the library's
states from its native elements to 1e-9 km after the first integrator step and to 1e-6 km within it, out to 7 days
and to periods of 14,400 min. Over one integrator step of the long-period regime, the AGOM on-minus-off increment
of a_f, a_g, chi, psi and lambda equals the step of the averaged SRP rates taken at the stage states and times
to 2e-4, whatever the AGOM (0.03, 0.003 or 1e-4); the remainder is of the size of the coupling between the SRP
change and the instantaneous third-body rates. Over a week a remainder of that size moves the position by about
1e-4 of the SRP displacement, so a difference of a per cent of it shows step by step against these node vectors.

**Confirmed.** *[probe 4.1]* For a near-circular GEO orbit on 2024-04-09 with AGOM = 0.02 m^2/kg, the SRP part of
the eccentricity-vector rate is |d(a_f, a_g)/dt| = 2.565e-9 per minute. The circular-orbit relation
|e-dot| = (3/2) F / (n a) gives F = 8.76e-8 m/s^2, consistent with P AGOM cos(delta_sun) (1 AU/r)^2 = 8.9e-8 m/s^2
for P = 4.5e-6 N/m^2, less a sunlit fraction of about 0.985 for that day (GEO eclipse season). The section-4
vectors hold this case and the solstice case (no eclipses). Versions 9.1.1.0 and 9.9 differ only when SRP (and in
some cases drag) is on (section 11), which places the shadow computation as the changed part.

## 5. Lunar and solar terms

**Bodies.** Point-mass Sun and Moon. Mass ratios to the Earth: Sun 332946.038, Moon 0.0123 (also 0.012300034 in
places) *[study; lit: IAU 1976 system]*. Positions:

- Sun *[study; lit: Meeus 1998 ch. 25; Explanatory Supplement 1992]*: with T = (d50 - 18263.5) / 36525 Julian
  centuries from J2000 (d50 as in 1.2), all angles in degrees:
  - mean anomaly M = 357.52772333333 + 35999.05034 T - 1.6027777777777777e-4 T^2 - 3.3333333333333e-6 T^3;
  - eccentricity e = 0.01670832 - 4.2229e-5 T - 1.26e-7 T^2;
  - longitude of perigee varpi = 282.938346111111 + 1.71945722222222 T + 4.62777777777776e-4 T^2
    + 3.3333333333333e-6 T^3;
  - obliquity epsilon = 23.4392635861111 - 0.0130253805555555 T - 1.30555555555555e-7 T^2
    + 5.02777777777776e-7 T^3;
  - true anomaly nu = M + (2e - e^3/4 + 5e^5/96) sin M + (5e^2/4 - 11e^4/24) sin 2M + (13e^3/12 - 43e^5/64) sin 3M
    + (103e^4/96) sin 4M + (1097e^5/960) sin 5M (the classical equation of the center to e^5);
  - ecliptic longitude lambda = nu + varpi; unit vector (cos lambda, sin lambda cos epsilon, sin lambda sin epsilon)
    in the mean equator and equinox of date;
  - distance r = A (r/a) with A = 149597870 km, converted to Earth radii with R_E, and the classical expansion
    r/a = 1 + e^2/2 - (e - 3e^3/8 + 5e^5/192) cos M - (e^2/2 - e^4/3) cos 2M - (3e^3/8 - 45e^5/128) cos 3M
    - (e^4/3) cos 4M - (125e^5/384) cos 5M (Brouwer & Clemence 1961).
  *[study; probe 5.3: this Sun reproduces the library's direction to 1e-14 and distance to 2e-16 relative]*
- Moon *[study; lit: Brown's lunar theory, main terms; IAU 1980 fundamental arguments (Seidelmann 1982); Montenbruck &
  Pfleger 2000]*. Arguments in arcseconds (converted with 1 arcsec = 4.84813681109536e-6 rad), T as for the Sun:
  - l = 485866.733 + 1717915922.633 T + 31.31 T^2 + 0.064 T^3 (Moon's mean anomaly);
  - L = 785939.157 + 1732564372.598 T - 5.802 T^2 + 0.019 T^3 (Moon's mean longitude);
  - D = 1072261.307 + 1602961601.328 T - 6.891 T^2 + 0.019 T^3 (mean elongation);
  - F = 335778.877 + 1739527263.137 T - 13.257 T^2 + 0.011 T^3 (argument of latitude);
  - l' = the Sun's mean anomaly M above.
  - Ecliptic longitude of date, lambda = L + [22639.5 sin l - 4586.465 sin(l - 2D) + 2369.912 sin 2D
    + 769.016 sin 2l - 668.146 sin l' - 411.608 sin 2F - 211.656 sin(2l - 2D) - 205.962 sin(l + l' - 2D)
    + 191.953 sin(l + 2D) - 165.145 sin(l' - 2D) + 147.687 sin(l - l') - 125.154 sin D
    - 109.673 sin(l + l')] arcsec.
  - Latitude argument S = F + [22609.07 sin l - 4578.13 sin(l - 2D) + 2373.36 sin 2D + 767.96 sin 2l
    + 192.72 sin(l + 2D) - 182.36 sin(l + l' - 2D) - 165.06 sin(l' - 2D) - 152.53 sin(2l - 2D) - 138.76 sin(l' - l)
    - 126.98 sin l' - 115.18 sin(l + l') - 112.79 sin D] arcsec.
  - Factor g = 1.00000271 - 1.39978e-4 [0.53858 cos(3.040944319 - 9.253193406 T) + 3.33179 cos(4.523601504
    - 9.242202921 T) + 0.064043 cos(3.295762417 - 9.246503573 T)].
  - Ecliptic latitude (rad) beta = 0.089785955 g sin S - 3.02572e-5 g^3 sin 3S + 1.94e-8 g^5 sin 5S
    - 0.00255045 sin(F - 2D).
  - Horizontal parallax pi = 3422.7 + 186.5398 cos l + 34.3117 cos(l - 2D) + 28.2333 cos 2D + 10.1657 cos 2l
    + 3.0861 cos(l + 2D) + 1.9178 cos(l' - 2D) + 1.4437 cos(l + l' - 2D) + 1.1528 cos(l - l') - 0.9781 cos D
    - 0.949 cos(l + l') - 0.7136 cos(l - 2F) + 0.6215 cos 3l + 0.6008 cos(l - 4D) - 0.3997 cos l'
    + 0.3722 cos(2l - 4D) - 0.3039 cos(2l - 2D) - 0.3 cos(l' + 2D) + 0.2833 cos(2l + 2D) + 0.2607 cos 4D
    + 0.2302 cos(l - l' + 2D) - 0.2257 cos(l - l' - 2D) + 0.1494 cos(l' + D) + 0.1268 cos(2l - l')
    - 0.1187 cos(3l - 2D) - 0.1093 cos(l + D) - 0.1052 cos(2F - 2D) - 0.1038 cos(2l + l') arcsec.
  - Position in Earth radii: (cos beta cos lambda, cos beta sin lambda cos epsilon - sin beta sin epsilon,
    cos beta sin lambda sin epsilon + sin beta cos epsilon) / sin pi, epsilon the obliquity of the Sun model;
    the distance is its norm, the direction its unit vector (mean equator and equinox of date).
  *[study; probe 5.3: this Moon reproduces the library's direction and distance to 3e-13]*
- JPL ephemerides are used only when loaded; the oracle does not load them, and release notes 9.3-9.9 still list
  "replace analytical theory of Sun and Moon position with JPL ephemeris for SGP4-XP" as planned work *[doc]*.
- From 0.6.22 AP does not read this section's Sun and Moon (16.17); through 0.6.21 it did. Against DE440 over 2010-2035,
  read as AP read them (UTC as the time argument, the mean equator of date taken for TEME; measured on 0.6.16), they are
  off by 91.5 arcsec on average and 377 at worst (the Moon; 38 of it the time argument, 5.5 the frame) and 10.9 and 32
  arcsec (the Sun): a third-body acceleration error of 3.7e-9 m/s^2 RMS at the geostationary radius. AP's own series are
  within 0.74 and 4.1 arcsec (Moon) and 0.44 and 1.1 arcsec (Sun) there, 3.7e-11 m/s^2. Known approximation: AP's
  bodies are in TEME of date, while every AP set holds
  its elements in TEME of the epoch (16.4); the two part by about 1 arcsec at day 7
  (0.42, 0.70 and 0.98 arcsec at days 3, 5 and 7), a third-body acceleration error at the geostationary radius of 1.5e-11,
  2.5e-11 and 3.5e-11 m/s^2 RMS (the Moon; the Sun 1.6e-11 at day 7) that AP does not carry.

**In the rates, averaged regime (epoch period below 1100 min).** The third-body disturbing function averaged over
the satellite's mean anomaly, to the octupole (Legendre degree 3), each body held fixed at its position at the
evaluation time of the Runge-Kutta stage (Kozai 1959; Danielson et al. 1995) *[lit; study]*. With the strengths
C2 = (mu_b/mu)(a/r_b)^3 n and C3 = C2 (a/r_b) and the direction cosines A, B, C of the output-time terms, the
contributions to the six rates (same set as section 2: n-dot, e-dot, i-dot, e varpi-dot, sin i Omega-dot,
lambda-dot - n; rad/min) are, per body, C2 Q2 + C3 Q3 with *[study; probe 2.2]*:

**n-dot** = 0.

**e-dot** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A B [-15 e eta/2]
- Q3 = A^2 B [75 eta (6 e^2 + 1)/16] + B^3 [-75 eta (e - 1) (e + 1)/16] + B [-15 eta (3 e^2 + 4)/16]

**i-dot** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A C [3 (4 e^2 + 1) cos(omega)/(2 eta)] + B C [3 (e - 1) (e + 1) sin(omega)/(2 eta)]
- Q3 = A^2 C [-75 e (4 e^2 + 3) cos(omega)/(16 eta)] + A B C [-75 e (e - 1) (e + 1) sin(omega)/(8 eta)] + B^2 C [75
  e (e - 1) (e + 1) cos(omega)/(16 eta)] + C [15 e (3 e^2 + 4) cos(omega)/(16 eta)]

**e varpi-dot** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [6 e eta] + B^2 [-3 e eta/2] + A C [3 e (4 e^2 + 1) sin(i) sin(omega)/(2 eta (cos(i) + 1))] + B C [-3 e
  (e - 1) (e + 1) sin(i) cos(omega)/(2 eta (cos(i) + 1))] + [-3 e eta/2]
- Q3 = A^3 [-75 eta (4 e^2 + 1)/16] + A B^2 [75 eta (3 e^2 - 1)/16] + A^2 C [-75 e^2 (4 e^2 + 3) sin(i)
  sin(omega)/(16 eta (cos(i) + 1))] + A B C [75 e^2 (e - 1) (e + 1) sin(i) cos(omega)/(8 eta (cos(i) + 1))] + B^2 C
  [75 e^2 (e - 1) (e + 1) sin(i) sin(omega)/(16 eta (cos(i) + 1))] + A [15 eta (9 e^2 + 4)/16] + C [15 e^2 (3 e^2 +
  4) sin(i) sin(omega)/(16 eta (cos(i) + 1))]

**sin i Omega-dot** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A C [3 (4 e^2 + 1) sin(omega)/(2 eta)] + B C [-3 (e - 1) (e + 1) cos(omega)/(2 eta)]
- Q3 = A^2 C [-75 e (4 e^2 + 3) sin(omega)/(16 eta)] + A B C [75 e (e - 1) (e + 1) cos(omega)/(8 eta)] + B^2 C [75 e
  (e - 1) (e + 1) sin(omega)/(16 eta)] + C [15 e (3 e^2 + 4) sin(omega)/(16 eta)]

**lambda-dot - n** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [-3 (2 e^2 eta + 4 e^2 + eta + 1)/(eta + 1)] + B^2 [3 (e^2 eta + 2 e^2 - 2 eta - 2)/(2 (eta + 1))] + A C
  [3 (4 e^2 + 1) sin(i) sin(omega)/(2 eta (cos(i) + 1))] + B C [-3 (e - 1) (e + 1) sin(i) cos(omega)/(2 eta (cos(i)
  + 1))] + [(3 e^2 eta + 6 e^2 + 4 eta + 4)/(2 (eta + 1))]
- Q3 = A^3 [75 e (4 e^2 eta + 8 e^2 + 5 eta + 6)/(16 (eta + 1))] + A B^2 [-75 e (3 e^2 eta + 6 e^2 - 5 eta - 6)/(16
  (eta + 1))] + A^2 C [-75 e (4 e^2 + 3) sin(i) sin(omega)/(16 eta (cos(i) + 1))] + A B C [75 e (e - 1) (e + 1)
  sin(i) cos(omega)/(8 eta (cos(i) + 1))] + B^2 C [75 e (e - 1) (e + 1) sin(i) sin(omega)/(16 eta (cos(i) + 1))] + A
  [-15 e (9 e^2 eta + 18 e^2 + 20 eta + 24)/(16 (eta + 1))] + C [15 e (3 e^2 + 4) sin(i) sin(omega)/(16 eta (cos(i)
  + 1))]

*[probe 2.2]* Confirmed: the zonal rates of section 2 plus these Sun and Moon rates reproduce the library's native
rates at epoch (13-15.2 rev/day, drag and SRP off) to 1e-8 to 1e-10 relative in a_f, a_g, chi, psi and 6e-13 in
lambda-dot.

These rates stop at the octupole; AP adds each body's terms of degree 4 to 10 in this regime (16.8).

**At the output time, averaged regime.** The third-body short-period terms (periodic in the satellite's eccentric
anomaly E, the body held fixed at the output time) are added to the interpolated mean elements, once for the Sun
and once for the Moon, from one formula with the body's parameters *[study]*:

- quadrupole strength C2 = (mu_b / mu) (a / r_b)^3 n and octupole strength C3 = (mu_b / mu) (a / r_b)^4 n, with
  mu_b / mu the mass ratio (5), r_b the body's distance and n the mean motion;
- the body's unit vector projected on the satellite's perigee frame: A = s.P, B = s.Q, C = s.W, with
  P = (cos w cos O - sin w sin O cos i, cos w sin O + sin w cos O cos i, sin w sin i),
  Q = (-sin w cos O - cos w sin O cos i, -sin w sin O + cos w cos O cos i, cos w sin i),
  W = (sin O sin i, -cos O sin i, cos i) (w = omega, O = Omega);
- the terms are trigonometric polynomials in E, 2E, 3E and 4E with coefficients in e, sqrt(1 - e^2), A, B, C and
  cos omega, sin omega, giving corrections to a (or n), e, i, Omega, omega and the mean longitude; the Sun and Moon
  corrections are summed, then carried to the equinoctial elements (Delta a_f = Delta e cos(w + O) - e sin(w + O)
  Delta(w + O), Delta a_g likewise, Delta chi and Delta psi through 1 / (1 + cos i)) *[study]*.

This is the classical first-order third-body short-period solution in closed form in E (Kozai 1959; Giacaglia 1973)
and the XP counterpart of SGP4's deep-space lunar-solar periodics (Hoots & Roehrich 1980) *[lit]*.

The six corrections are, in order, Delta n (rad/min, entering a through a = (k_e/n)^(2/3) before the short-period
step), Delta e, Delta i, e Delta varpi, sin i Delta Omega and Delta lambda (radians); each body's are computed with
its own C2, C3, A, B, C and summed, then added to the equinoctial elements as above *[study]*. The explicit terms
follow in 5.4.

*[probe 5.3]* Confirmed. With the Sun and Moon of this section, the terms of 5.4 and the short-period corrections of
section 8, the library's epoch state is reproduced to 1.3e-9 km at 15.2 rev/day (0.6 m without the 5.4 terms),
to 1.2e-6 km at 1.6 rev/day with e = 0.0003 and 0.4 (460 m and 600 m without them), and to 5e-7 km at 2 and
5 rev/day (e = 0.05, 0.2). Velocities agree to 1.6e-10 km/s or better.

### 5.4 Output-time third-body corrections, explicit

Notation: e, i, omega the mean elements, eta = sqrt(1 - e^2), E the eccentric anomaly from M = E - e sin E, n the
mean motion (rad/min), C2 and C3 as above, A, B, C the body's unit vector on P, Q, W. Each correction is
C2 Q2 + C3 Q3 with Q2 quadratic and Q3 cubic in (A, B, C); brackets hold the coefficient of each monomial.
*[study; probe 5.3]*

**Delta n** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [9 (4 e cos(E) - cos(2E))/4] + A B [9 eta (e - cos(E)) sin(E)] + B^2 [-9 (e - 1) (e + 1) cos(2E)/4] + [3
  e (e cos(2E) - 4 cos(E))/4]
- Q3 = A^3 [-15 (12 e^2 cos(E) + 12 e sin(E)^2 - 6 e + 3 cos(E) + cos(3E))/8] + A^2 B [45 (e - 1) (e + 1) (4 e^2
  sin(E) - 4 e sin(2E) + sin(E) + sin(3E))/(8 eta)] + A B^2 [45 (e - 1) (e + 1) (2 e cos(2E) + cos(E) - cos(3E))/8]
  + B^3 [15 (e - 1)^2 (e + 1)^2 (-3 sin(E) + sin(3E))/(8 eta)] + A [-9 (2 e^3 cos(2E) - 11 e^2 cos(E) - e^2 cos(3E)
  + 4 e cos(2E) - 4 cos(E))/8] + B [-9 (e - 1) (e + 1) (e^2 sin(E) + e^2 sin(3E) - 4 e sin(2E) + 4 sin(E))/(8 eta)]

**Delta e** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [-(e - 1) (e + 1) (6 e sin(E)^2 - 3 e + 3 cos(E) + cos(3E))/(4 n)] + A B [-eta (3 e^2 sin(E) + e^2
  sin(3E) + 9 e sin(2E) - 18 sin(E) - 2 sin(3E))/(4 n)] + B^2 [(e - 1) (e + 1) (12 e sin(E)^2 - 6 e + 15 cos(E) +
  cos(3E))/(4 n)] + [(e - 1) (e + 1) (e cos(2E) - 4 cos(E))/(4 n)]
- Q3 = A^3 [-5 eta^2 (192 e^3 cos(E) + 48 e^2 sin(E)^2 - 24 e^2 + 48 e cos(E) + 16 e cos(3E) - 24 sin(E)^4 + 48
  sin(E)^2 - 15)/(64 n)] + A^2 B [5 eta (120 e^3 sin(E) + 16 e^3 sin(3E) + 120 e^2 sin(2E) - 6 e^2 sin(4E) - 372 e
  sin(E) - 48 e sin(3E) + 48 sin(2E) + 9 sin(4E))/(64 n)] + A B^2 [15 eta^2 (192 e^3 cos(E) + 8 e^2 sin(E)^4 + 64
  e^2 sin(E)^2 - 35 e^2 + 112 e cos(E) + 16 e cos(3E) - 24 sin(E)^4 + 64 sin(E)^2 - 23)/(64 n)] + B^3 [-5 eta (192
  e^3 sin(E) + 8 e^3 sin(3E) + 48 e^2 sin(2E) + 228 e sin(E) - 40 e sin(3E) + 24 sin(2E) + 3 sin(4E))/(64 n)] + B^2
  [-5 e eta (-180 e^2 sin(E) + 8 e^2 sin(3E) - 3 e sin(4E) - 240 sin(E) + 24 sin(3E))/(64 n)] + A [-3 eta^2 (8 e^2
  sin(E)^4 + 16 e^2 sin(E)^2 - 11 e^2 + 64 e cos(E) + 16 sin(E)^2 - 8)/(64 n)] + B [eta (-84 e^3 sin(E) + 32 e^3
  sin(3E) - 192 e^2 sin(2E) - 3 e^2 sin(4E) + 336 e sin(E) + 24 sin(2E))/(64 n)]

**Delta i** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A C [(12 e^3 sin(E) cos(omega) + 3 e^2 eta sin(omega) cos(2E) + 6 e^2 sin(2E) cos(omega) - 15 e eta
  sin(omega) cos(E) - e eta sin(omega) cos(3E) - 27 e sin(E) cos(omega) - e sin(3E) cos(omega) + 3 eta sin(omega)
  cos(2E) + 3 sin(2E) cos(omega))/(4 eta n)] + B C [(3 e^3 sin(E) sin(omega) + e^3 sin(3E) sin(omega) - 3 e^2 eta
  cos(2E) cos(omega) - 3 e^2 sin(2E) sin(omega) + 15 e eta cos(E) cos(omega) + e eta cos(3E) cos(omega) - 3 e sin(E)
  sin(omega) - e sin(3E) sin(omega) - 3 eta cos(2E) cos(omega) + 3 sin(2E) sin(omega))/(4 eta n)]
- Q3 = A^2 C [-5 (144 e^4 sin(E) cos(omega) + 24 e^3 eta sin(omega) cos(2E) + 72 e^3 sin(2E) cos(omega) - 48 e^2 eta
  sin(omega) cos(E) - 16 e^2 eta sin(omega) cos(3E) - 324 e^2 sin(E) cos(omega) - 24 e^2 sin(3E) cos(omega) + 36 e
  eta sin(omega) cos(2E) + 3 e eta sin(omega) cos(4E) + 96 e sin(2E) cos(omega) + 3 e sin(4E) cos(omega) - 24 eta
  sin(omega) cos(E) - 8 eta sin(omega) cos(3E) - 72 sin(E) cos(omega) - 8 sin(3E) cos(omega))/(64 eta n)] + A B C
  [-5 (36 e^4 sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) - 24 e^3 eta cos(2E) cos(omega) - 24 e^3 sin(2E)
  sin(omega) - 3 e^3 sin(4E) sin(omega) + 144 e^2 eta cos(E) cos(omega) + 16 e^2 eta cos(3E) cos(omega) - 60 e^2
  sin(E) sin(omega) - 60 e eta cos(2E) cos(omega) - 3 e eta cos(4E) cos(omega) + 24 e sin(2E) sin(omega) + 3 e
  sin(4E) sin(omega) + 24 eta cos(E) cos(omega) + 8 eta cos(3E) cos(omega) + 24 sin(E) sin(omega) - 8 sin(3E)
  sin(omega))/(32 eta n)] + B^2 C [5 (36 e^4 sin(E) cos(omega) + 8 e^4 sin(3E) cos(omega) - 24 e^3 eta sin(E)^4
  sin(omega) + 9 e^3 eta sin(omega) - 24 e^3 sin(2E) cos(omega) - 3 e^3 sin(4E) cos(omega) + 24 e^2 eta sin(omega)
  cos(E) + 8 e^2 eta sin(omega) cos(3E) - 60 e^2 sin(E) cos(omega) + 24 e eta sin(E)^4 sin(omega) + 48 e eta
  sin(E)^2 sin(omega) - 33 e eta sin(omega) + 24 e sin(2E) cos(omega) + 3 e sin(4E) cos(omega) + 72 eta sin(omega)
  cos(E) - 8 eta sin(omega) cos(3E) + 24 sin(E) cos(omega) - 8 sin(3E) cos(omega))/(64 eta n)] + C [-(-108 e^4
  sin(E) cos(omega) + 8 e^4 sin(3E) cos(omega) - 12 e^3 eta sin(omega) cos(2E) - 3 e^3 eta sin(omega) cos(4E) - 96
  e^3 sin(2E) cos(omega) - 3 e^3 sin(4E) cos(omega) + 72 e^2 eta sin(omega) cos(E) + 24 e^2 eta sin(omega) cos(3E) +
  264 e^2 sin(E) cos(omega) + 24 e^2 sin(3E) cos(omega) - 72 e eta sin(omega) cos(2E) - 72 e sin(2E) cos(omega) + 96
  eta sin(omega) cos(E) + 96 sin(E) cos(omega))/(64 eta n)]

**e Delta varpi** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [eta (12 e^2 sin(E) - 15 sin(E) + sin(3E))/(4 n)] + A B [-(6 e^3 sin(E)^2 - 3 e^3 + 33 e^2 cos(E) - e^2
  cos(3E) + 6 e sin(E)^2 - 3 e - 18 cos(E) + 2 cos(3E))/(4 n)] + B^2 [-eta (6 e^2 sin(E) - 3 e sin(2E) - 3 sin(E) +
  sin(3E))/(4 n)] + A C [e (24 e^3 sin(E) sin(omega) + 12 e^2 eta sin(E)^2 cos(omega) - 6 e^2 eta cos(omega) + 6 e^2
  cos(2E - omega) - 6 e^2 cos(2E + omega) + 30 e eta cos(E) cos(omega) + 2 e eta cos(3E) cos(omega) - 54 e sin(E)
  sin(omega) - 2 e sin(3E) sin(omega) + 12 eta sin(E)^2 cos(omega) - 6 eta cos(omega) + 3 cos(2E - omega) - 3 cos(2E
  + omega)) sin(i)/(8 eta n (cos(i) + 1))] + B C [-e (6 e^3 sin(E) cos(omega) + 2 e^3 sin(3E) cos(omega) - 12 e^2
  eta sin(E)^2 sin(omega) + 6 e^2 eta sin(omega) - 3 e^2 sin(2E - omega) - 3 e^2 sin(2E + omega) - 30 e eta
  sin(omega) cos(E) - 2 e eta sin(omega) cos(3E) - 6 e sin(E) cos(omega) - 2 e sin(3E) cos(omega) - 12 eta sin(E)^2
  sin(omega) + 6 eta sin(omega) + 3 sin(2E - omega) + 3 sin(2E + omega)) sin(i)/(8 eta n (cos(i) + 1))] + [-eta (e^2
  + e cos(E) - 2) sin(E)/(2 n)]
- Q3 = A^3 [-5 eta (144 e^3 sin(E) + 24 e^2 sin(2E) - 252 e sin(E) + 8 e sin(3E) + 24 sin(2E) - 3 sin(4E))/(64 n)] +
  A^2 B [15 (32 e^4 sin(E)^2 - 16 e^4 + 160 e^3 cos(E) + 16 e^2 sin(E)^4 + 48 e^2 sin(E)^2 - 30 e^2 - 104 e cos(E) +
  8 e cos(3E) - 24 sin(E)^4 - 16 sin(E)^2 + 17)/(64 n)] + A B^2 [5 eta (156 e^3 sin(E) + 8 e^3 sin(3E) - 96 e^2
  sin(2E) + 3 e^2 sin(4E) - 132 e sin(E) + 24 e sin(3E) + 48 sin(2E) - 9 sin(4E))/(64 n)] + B^3 [5 (e - 1) (e + 1)
  (-72 e cos(E) + 8 e cos(3E) - 24 sin(E)^4 + 9)/(64 n)] + A^2 C [-5 e (144 e^4 sin(E) sin(omega) + 48 e^3 eta
  sin(E)^2 cos(omega) - 24 e^3 eta cos(omega) + 36 e^3 cos(2E - omega) - 36 e^3 cos(2E + omega) + 48 e^2 eta cos(E)
  cos(omega) + 16 e^2 eta cos(3E) cos(omega) - 324 e^2 sin(E) sin(omega) - 24 e^2 sin(3E) sin(omega) - 24 e eta
  sin(E)^4 cos(omega) + 96 e eta sin(E)^2 cos(omega) - 39 e eta cos(omega) - 24 e sin(E)^3 sin(omega) cos(E) + 51 e
  cos(2E - omega) - 51 e cos(2E + omega) + 24 eta cos(E) cos(omega) + 8 eta cos(3E) cos(omega) - 72 sin(E)
  sin(omega) - 8 sin(3E) sin(omega)) sin(i)/(64 eta n (cos(i) + 1))] + A B C [5 e (36 e^4 sin(E) cos(omega) + 8 e^4
  sin(3E) cos(omega) - 48 e^3 eta sin(E)^2 sin(omega) + 24 e^3 eta sin(omega) + 24 e^3 sin(E)^3 cos(E) cos(omega) -
  15 e^3 sin(2E - omega) - 15 e^3 sin(2E + omega) - 144 e^2 eta sin(omega) cos(E) - 16 e^2 eta sin(omega) cos(3E) -
  60 e^2 sin(E) cos(omega) + 24 e eta sin(E)^4 sin(omega) - 144 e eta sin(E)^2 sin(omega) + 63 e eta sin(omega) - 24
  e sin(E)^3 cos(E) cos(omega) + 15 e sin(2E - omega) + 15 e sin(2E + omega) - 24 eta sin(omega) cos(E) - 8 eta
  sin(omega) cos(3E) + 24 sin(E) cos(omega) - 8 sin(3E) cos(omega)) sin(i)/(32 eta n (cos(i) + 1))] + B^2 C [5 e (36
  e^4 sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) + 24 e^3 eta sin(E)^4 cos(omega) - 9 e^3 eta cos(omega) + 24 e^3
  sin(E)^3 sin(omega) cos(E) - 15 e^3 cos(2E - omega) + 15 e^3 cos(2E + omega) - 24 e^2 eta cos(E) cos(omega) - 8
  e^2 eta cos(3E) cos(omega) - 60 e^2 sin(E) sin(omega) - 24 e eta sin(E)^4 cos(omega) - 48 e eta sin(E)^2
  cos(omega) + 33 e eta cos(omega) - 24 e sin(E)^3 sin(omega) cos(E) + 15 e cos(2E - omega) - 15 e cos(2E + omega) -
  72 eta cos(E) cos(omega) + 8 eta cos(3E) cos(omega) + 24 sin(E) sin(omega) - 8 sin(3E) sin(omega)) sin(i)/(64 eta
  n (cos(i) + 1))] + A [-eta (-276 e^3 sin(E) + 8 e^3 sin(3E) - 168 e^2 sin(2E) + 3 e^2 sin(4E) + 624 e sin(E) - 24
  sin(2E))/(64 n)] + B [-3 (32 e^4 sin(E)^2 - 16 e^4 + 88 e^3 cos(E) + 8 e^3 cos(3E) - 8 e^2 sin(E)^4 + 48 e^2
  sin(E)^2 - 21 e^2 - 32 e cos(E) - 16 sin(E)^2 + 8)/(64 n)] + C [-e (-108 e^4 sin(E) sin(omega) + 8 e^4 sin(3E)
  sin(omega) + 24 e^3 eta sin(E)^4 cos(omega) - 48 e^3 eta sin(E)^2 cos(omega) + 15 e^3 eta cos(omega) + 24 e^3
  sin(E)^3 sin(omega) cos(E) - 51 e^3 cos(2E - omega) + 51 e^3 cos(2E + omega) - 72 e^2 eta cos(E) cos(omega) - 24
  e^2 eta cos(3E) cos(omega) + 264 e^2 sin(E) sin(omega) + 24 e^2 sin(3E) sin(omega) - 144 e eta sin(E)^2 cos(omega)
  + 72 e eta cos(omega) - 36 e cos(2E - omega) + 36 e cos(2E + omega) - 96 eta cos(E) cos(omega) + 96 sin(E)
  sin(omega)) sin(i)/(64 eta n (cos(i) + 1))]

**sin i Delta Omega** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A C [(12 e^3 sin(E) sin(omega) - 3 e^2 eta cos(2E) cos(omega) + 6 e^2 sin(2E) sin(omega) + 15 e eta cos(E)
  cos(omega) + e eta cos(3E) cos(omega) - 27 e sin(E) sin(omega) - e sin(3E) sin(omega) - 3 eta cos(2E) cos(omega) +
  3 sin(2E) sin(omega))/(4 eta n)] + B C [-(3 e^3 sin(E) cos(omega) + e^3 sin(3E) cos(omega) + 3 e^2 eta sin(omega)
  cos(2E) - 3 e^2 sin(2E) cos(omega) - 15 e eta sin(omega) cos(E) - e eta sin(omega) cos(3E) - 3 e sin(E) cos(omega)
  - e sin(3E) cos(omega) + 3 eta sin(omega) cos(2E) + 3 sin(2E) cos(omega))/(4 eta n)]
- Q3 = A^2 C [-5 (144 e^4 sin(E) sin(omega) - 24 e^3 eta cos(2E) cos(omega) + 72 e^3 sin(2E) sin(omega) + 48 e^2 eta
  cos(E) cos(omega) + 16 e^2 eta cos(3E) cos(omega) - 324 e^2 sin(E) sin(omega) - 24 e^2 sin(3E) sin(omega) - 36 e
  eta cos(2E) cos(omega) - 3 e eta cos(4E) cos(omega) + 96 e sin(2E) sin(omega) + 3 e sin(4E) sin(omega) + 24 eta
  cos(E) cos(omega) + 8 eta cos(3E) cos(omega) - 72 sin(E) sin(omega) - 8 sin(3E) sin(omega))/(64 eta n)] + A B C [5
  (36 e^4 sin(E) cos(omega) + 8 e^4 sin(3E) cos(omega) + 24 e^3 eta sin(omega) cos(2E) - 24 e^3 sin(2E) cos(omega) -
  3 e^3 sin(4E) cos(omega) - 144 e^2 eta sin(omega) cos(E) - 16 e^2 eta sin(omega) cos(3E) - 60 e^2 sin(E)
  cos(omega) + 60 e eta sin(omega) cos(2E) + 3 e eta sin(omega) cos(4E) + 24 e sin(2E) cos(omega) + 3 e sin(4E)
  cos(omega) - 24 eta sin(omega) cos(E) - 8 eta sin(omega) cos(3E) + 24 sin(E) cos(omega) - 8 sin(3E)
  cos(omega))/(32 eta n)] + B^2 C [5 (36 e^4 sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) + 24 e^3 eta sin(E)^4
  cos(omega) - 9 e^3 eta cos(omega) - 24 e^3 sin(2E) sin(omega) - 3 e^3 sin(4E) sin(omega) - 24 e^2 eta cos(E)
  cos(omega) - 8 e^2 eta cos(3E) cos(omega) - 60 e^2 sin(E) sin(omega) - 24 e eta sin(E)^4 cos(omega) - 48 e eta
  sin(E)^2 cos(omega) + 33 e eta cos(omega) + 24 e sin(2E) sin(omega) + 3 e sin(4E) sin(omega) - 72 eta cos(E)
  cos(omega) + 8 eta cos(3E) cos(omega) + 24 sin(E) sin(omega) - 8 sin(3E) sin(omega))/(64 eta n)] + C [-(-108 e^4
  sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) + 12 e^3 eta cos(2E) cos(omega) + 3 e^3 eta cos(4E) cos(omega) - 96
  e^3 sin(2E) sin(omega) - 3 e^3 sin(4E) sin(omega) - 72 e^2 eta cos(E) cos(omega) - 24 e^2 eta cos(3E) cos(omega) +
  264 e^2 sin(E) sin(omega) + 24 e^2 sin(3E) sin(omega) + 72 e eta cos(2E) cos(omega) - 72 e sin(2E) sin(omega) - 96
  eta cos(E) cos(omega) + 96 sin(E) sin(omega))/(64 eta n)]

**Delta lambda** = C2 [ Q2 ] + C3 [ Q3 ], with
- Q2 = A^2 [-(60 e^3 eta sin(E) + 84 e^3 sin(E) + 42 e^2 eta sin(2E) + 42 e^2 sin(2E) - 159 e eta sin(E) - 9 e eta
  sin(3E) - 189 e sin(E) - 7 e sin(3E) + 21 eta sin(2E) + 21 sin(2E))/(8 n (eta + 1))] + A B [(3 e^4 cos(2E) - 33
  e^3 cos(E) + e^3 cos(3E) + 21 e^2 eta^2 cos(2E) + 21 e^2 eta cos(2E) + 3 e^2 cos(2E) - 105 e eta^2 cos(E) - 7 e
  eta^2 cos(3E) - 105 e eta cos(E) - 7 e eta cos(3E) + 18 e cos(E) - 2 e cos(3E) + 21 eta^2 cos(2E) + 21 eta
  cos(2E))/(4 n (eta + 1))] + B^2 [(9 e^3 eta sin(E) + 7 e^3 eta sin(3E) + 21 e^3 sin(E) + 7 e^3 sin(3E) - 15 e^2
  eta sin(2E) - 21 e^2 sin(2E) - 15 e eta sin(E) - 9 e eta sin(3E) - 21 e sin(E) - 7 e sin(3E) + 21 eta sin(2E) + 21
  sin(2E))/(8 n (eta + 1))] + A C [(24 e^3 sin(E) sin(omega) + 12 e^2 eta sin(E)^2 cos(omega) - 6 e^2 eta cos(omega)
  + 6 e^2 cos(2E - omega) - 6 e^2 cos(2E + omega) + 30 e eta cos(E) cos(omega) + 2 e eta cos(3E) cos(omega) - 54 e
  sin(E) sin(omega) - 2 e sin(3E) sin(omega) + 12 eta sin(E)^2 cos(omega) - 6 eta cos(omega) + 3 cos(2E - omega) - 3
  cos(2E + omega)) sin(i)/(8 eta n (cos(i) + 1))] + B C [-(6 e^3 sin(E) cos(omega) + 2 e^3 sin(3E) cos(omega) - 12
  e^2 eta sin(E)^2 sin(omega) + 6 e^2 eta sin(omega) - 3 e^2 sin(2E - omega) - 3 e^2 sin(2E + omega) - 30 e eta
  sin(omega) cos(E) - 2 e eta sin(omega) cos(3E) - 6 e sin(E) cos(omega) - 2 e sin(3E) cos(omega) - 12 eta sin(E)^2
  sin(omega) + 6 eta sin(omega) + 3 sin(2E - omega) + 3 sin(2E + omega)) sin(i)/(8 eta n (cos(i) + 1))] + [-e (-51
  e^2 eta sin(E) + 7 e^2 eta sin(3E) - 63 e^2 sin(E) + 7 e^2 sin(3E) - 57 e eta sin(2E) - 63 e sin(2E) + 144 eta
  sin(E) + 168 sin(E))/(24 n (eta + 1))]
- Q3 = A^3 [5 (144 e^4 eta sin(E) + 288 e^4 sin(E) + 120 e^3 eta sin(2E) + 144 e^3 sin(2E) - 396 e^2 eta sin(E) - 56
  e^2 eta sin(3E) - 648 e^2 sin(E) - 48 e^2 sin(3E) + 168 e eta sin(2E) + 9 e eta sin(4E) + 192 e sin(2E) + 6 e
  sin(4E) - 144 eta sin(E) - 16 eta sin(3E) - 144 sin(E) - 16 sin(3E))/(64 n (eta + 1))] + A^2 B [-15 (16 e^5
  cos(2E) - 160 e^4 cos(E) + 48 e^3 eta^2 cos(2E) + 48 e^3 eta cos(2E) + 32 e^3 cos(2E) - 2 e^3 cos(4E) - 288 e^2
  eta^2 cos(E) - 32 e^2 eta^2 cos(3E) - 288 e^2 eta cos(E) - 32 e^2 eta cos(3E) + 104 e^2 cos(E) - 8 e^2 cos(3E) +
  120 e eta^2 cos(2E) + 6 e eta^2 cos(4E) + 120 e eta cos(2E) + 6 e eta cos(4E) - 20 e cos(2E) + 3 e cos(4E) - 48
  eta^2 cos(E) - 16 eta^2 cos(3E) - 48 eta cos(E) - 16 eta cos(3E))/(64 n (eta + 1))] + A B^2 [-5 (60 e^4 eta sin(E)
  + 40 e^4 eta sin(3E) + 216 e^4 sin(E) + 48 e^4 sin(3E) - 48 e^3 eta sin(2E) - 21 e^3 eta sin(4E) - 144 e^3 sin(2E)
  - 18 e^3 sin(4E) - 228 e^2 eta sin(E) - 24 e^2 eta sin(3E) - 360 e^2 sin(E) + 96 e eta sin(2E) + 27 e eta sin(4E)
  + 144 e sin(2E) + 18 e sin(4E) + 144 eta sin(E) - 48 eta sin(3E) + 144 sin(E) - 48 sin(3E))/(64 n (eta + 1))] +
  B^3 [5 (e - 1) (e + 1) (-72 e^2 cos(E) + 8 e^2 cos(3E) - 48 e eta^2 sin(E)^4 + 18 e eta^2 - 48 e eta sin(E)^4 + 18
  e eta + 12 e cos(2E) - 3 e cos(4E) - 144 eta^2 cos(E) + 16 eta^2 cos(3E) - 144 eta cos(E) + 16 eta cos(3E))/(64 n
  (eta + 1))] + A^2 C [-5 (144 e^4 sin(E) sin(omega) + 48 e^3 eta sin(E)^2 cos(omega) - 24 e^3 eta cos(omega) + 36
  e^3 cos(2E - omega) - 36 e^3 cos(2E + omega) + 48 e^2 eta cos(E) cos(omega) + 16 e^2 eta cos(3E) cos(omega) - 324
  e^2 sin(E) sin(omega) - 24 e^2 sin(3E) sin(omega) - 24 e eta sin(E)^4 cos(omega) + 96 e eta sin(E)^2 cos(omega) -
  39 e eta cos(omega) - 24 e sin(E)^3 sin(omega) cos(E) + 51 e cos(2E - omega) - 51 e cos(2E + omega) + 24 eta
  cos(E) cos(omega) + 8 eta cos(3E) cos(omega) - 72 sin(E) sin(omega) - 8 sin(3E) sin(omega)) sin(i)/(64 eta n
  (cos(i) + 1))] + A B C [5 (36 e^4 sin(E) cos(omega) + 8 e^4 sin(3E) cos(omega) - 48 e^3 eta sin(E)^2 sin(omega) +
  24 e^3 eta sin(omega) + 24 e^3 sin(E)^3 cos(E) cos(omega) - 15 e^3 sin(2E - omega) - 15 e^3 sin(2E + omega) - 144
  e^2 eta sin(omega) cos(E) - 16 e^2 eta sin(omega) cos(3E) - 60 e^2 sin(E) cos(omega) + 24 e eta sin(E)^4
  sin(omega) - 144 e eta sin(E)^2 sin(omega) + 63 e eta sin(omega) - 24 e sin(E)^3 cos(E) cos(omega) + 15 e sin(2E -
  omega) + 15 e sin(2E + omega) - 24 eta sin(omega) cos(E) - 8 eta sin(omega) cos(3E) + 24 sin(E) cos(omega) - 8
  sin(3E) cos(omega)) sin(i)/(32 eta n (cos(i) + 1))] + B^2 C [5 (36 e^4 sin(E) sin(omega) + 8 e^4 sin(3E)
  sin(omega) + 24 e^3 eta sin(E)^4 cos(omega) - 9 e^3 eta cos(omega) + 24 e^3 sin(E)^3 sin(omega) cos(E) - 15 e^3
  cos(2E - omega) + 15 e^3 cos(2E + omega) - 24 e^2 eta cos(E) cos(omega) - 8 e^2 eta cos(3E) cos(omega) - 60 e^2
  sin(E) sin(omega) - 24 e eta sin(E)^4 cos(omega) - 48 e eta sin(E)^2 cos(omega) + 33 e eta cos(omega) - 24 e
  sin(E)^3 sin(omega) cos(E) + 15 e cos(2E - omega) - 15 e cos(2E + omega) - 72 eta cos(E) cos(omega) + 8 eta
  cos(3E) cos(omega) + 24 sin(E) sin(omega) - 8 sin(3E) sin(omega)) sin(i)/(64 eta n (cos(i) + 1))] + A [(-372 e^4
  eta sin(E) + 40 e^4 eta sin(3E) - 648 e^4 sin(E) + 48 e^4 sin(3E) - 408 e^3 eta sin(2E) - 21 e^3 eta sin(4E) - 576
  e^3 sin(2E) - 18 e^3 sin(4E) + 960 e^2 eta sin(E) + 144 e^2 eta sin(3E) + 1584 e^2 sin(E) + 144 e^2 sin(3E) - 408
  e eta sin(2E) - 432 e sin(2E) + 576 eta sin(E) + 576 sin(E))/(64 n (eta + 1))] + B [3 (16 e^5 cos(2E) - 88 e^4
  cos(E) - 8 e^4 cos(3E) + 24 e^3 eta^2 cos(2E) + 6 e^3 eta^2 cos(4E) + 24 e^3 eta cos(2E) + 6 e^3 eta cos(4E) + 20
  e^3 cos(2E) + e^3 cos(4E) - 144 e^2 eta^2 cos(E) - 48 e^2 eta^2 cos(3E) - 144 e^2 eta cos(E) - 48 e^2 eta cos(3E)
  + 32 e^2 cos(E) + 144 e eta^2 cos(2E) + 144 e eta cos(2E) - 8 e cos(2E) - 192 eta^2 cos(E) - 192 eta cos(E))/(64 n
  (eta + 1))] + C [-(-108 e^4 sin(E) sin(omega) + 8 e^4 sin(3E) sin(omega) + 24 e^3 eta sin(E)^4 cos(omega) - 48 e^3
  eta sin(E)^2 cos(omega) + 15 e^3 eta cos(omega) + 24 e^3 sin(E)^3 sin(omega) cos(E) - 51 e^3 cos(2E - omega) + 51
  e^3 cos(2E + omega) - 72 e^2 eta cos(E) cos(omega) - 24 e^2 eta cos(3E) cos(omega) + 264 e^2 sin(E) sin(omega) +
  24 e^2 sin(3E) sin(omega) - 144 e eta sin(E)^2 cos(omega) + 72 e eta cos(omega) - 36 e cos(2E - omega) + 36 e
  cos(2E + omega) - 96 eta cos(E) cos(omega) + 96 sin(E) sin(omega)) sin(i)/(64 eta n (cos(i) + 1))]

**AP: the quadrature form.** AP (16.1) replaces these corrections with the first-order short-period terms of each
body's tidal terms of degree 2 to 10 (16.8's acceleration), computed by quadrature: for each equinoctial element, the
Gauss rate on the mean orbit at the 32 eccentric longitudes F_j = 2 pi j / 32, less its average over the mean
longitude, times r/a (d lambda = (r/a) dF), is integrated in F through its trigonometric interpolant (a table of the
nodes' cosines and sines) and divided by n, the constant chosen so that the term averages to zero over the mean
longitude; lambda also takes 1/n times the integral of the mean motion's own term. Each body is held at its
output-time position. Against a numerical integration over one orbit (two-body plus the same tidal terms, the bodies
fixed, RK4 in 128,000 steps) at n 2.0059 rev/day, e 0.05, 0.3 and 0.72, in 16.8's three orientations, every element
agrees within 0.10 m RMS for degrees 2 and 3 and for 2 to 10. The closed form above is off by up to 298.2 m in the
mean longitude (G1, e 0.72), 110.6 m in a_f (G2, e 0.72) and 12 m at e 0.05. Most of the mean-longitude error is a
constant over the orbit: the closed form averages to zero over the eccentric anomaly, while the rates of 5 average
over the mean longitude; less its own mean, it is still off by up to 103 m in a_f and 26 m in lambda. The averaged
rates of 5 agree with the quadrature average within 0.001 m per day and are unchanged.
`test/third-body-short-period-eccentric.e2e.mjs` checks these numbers.

**Long-period regime (epoch period 1100 min or more).** The output-time third-body periodic terms are not added;
instead the rates are evaluated from the instantaneous geometry: at each stage the satellite position is computed
from the current equinoctial elements (equinoctial Kepler equation lambda = F + a_g cos F - a_f sin F, solved by a
Halley-type iteration of at most 25 steps) and the third-body accelerations enter the Gauss equations directly,
with the 95-minute step resolving the orbit *[study; probe 9.2]*.

## 6. Resonances

**Model.** Tesseral resonance terms for commensurabilities of the mean motion with Earth rotation enter the rates
through Kaula's disturbing function, restricted to the resonant terms of a class (6.1) and differentiated through
Lagrange's planetary equations (6.3). The tesseral coefficients are the full-precision EGM-96 values (6.2); the
inclination and eccentricity functions are Kaula's F_lmp(i) and G_lpq(e) (6.4) *[doc: release notes 8.0 item 2;
lit: Kaula 1966, ch. 3; Hujsak 1979; study; probe 6.3, 6.4]*:

| regime | commensurability | heritage |
| --- | --- | --- |
| 1 day (GEO) | n ~ 1 rev/day | SGP4 synchronous resonance (Hujsak 1979), extended |
| 0.5 day (GPS, Molniya and other half-day orbits) | n ~ 2 rev/day | SGP4 half-day resonance, now all eccentricities |
| 16 h | n ~ 1.5 rev/day | new in XP |
| 8 h | n ~ 3 rev/day | new in XP |

Release notes 9.0 record a corrected geosynchronous resonance computation; release notes 9.1 the switch to
full-precision tesserals ("using an older version of the propagator with TLEs built with the newer version ... will
sometimes give very inaccurate results"); the 9.1 JIRA records that 18 per-harmonic routines became one general
harmonic routine *[doc]*. The 9.9 oracle confirms the 9.1.1.0 study of this section wherever an effect is measurable
(6.5).

Above the eccentricity switch AP carries the resonances 1:1, 2:1, 3:1 and 3:2 only; every other commensurability is absent:
0.5 to 1.8 km a week on a transfer orbit. On a transfer orbit of 600 x 35,786 km (2.2535 rev/day; 4n = 9.014, 9 omega_E =
9.025) after a 72 h fit with the same forces on both sides, the day-7 error is 485 m with a 12 x 12 field, 58 m with order 9
removed from the truth, and 1.5 to 1.8 km with the full field; a one-day orbit at e 0.82 is 3.65 km at degree 12 against 0.56 km
at degree 4.

A set in no class at an exact m:1 commensurability (its order-m harmonics drifting slower than 1e-3 n: 8.05 rev/day at e 0.25)
flies without those harmonics: the first-order table and the grid of 16.11 both leave them out and no class carries them in the
rates, 1.27 km along-track at day 7 after a 72 h fit at e 0.25 (stack #419; `test/class0-exact-resonance.e2e.mjs`, a known
defect).

**Bands.** The resonance class is decided once, at initialization, from the epoch mean motion n_0 in rad/min (the
element set's mean motion in rev/day times 2 pi / 1440), tested in this order *[study; probe 6.2, 6.10]*:

| class | condition on n_0 (rad/min) | rev/day | period (min) |
| --- | --- | --- | --- |
| 1 day | 0.0035003818 < n_0 < 0.0052505727 | 0.8022284153 - 1.2033426229 | 1196.67 - 1795.00 |
| 0.5 day | 0.0070007636 <= n_0 <= 0.0105011454 | 1.6044568306 - 2.4066852459 | 598.33 - 897.50 |
| 8 h | 0.0105011454 < n_0 <= 0.015751718 | 2.4066852459 - 3.6100278459 | 398.89 - 598.33 |
| 16 h | 0.0052505727 <= n_0 <= 0.007875859 and not 0.5 day, so in effect n_0 < 0.0070007636 | 1.2033426229 - 1.6044568306 | 897.50 - 1196.67 |
| none | otherwise | | |

The six limits are exactly these decimal constants: 0.8, 1.2, 1.6, 2.4, 3.6 and 1.8 times 2 pi / 1436 rad/min, each
rounded to eight significant digits (periods 1795, 1196.67, 897.5, 598.33, 398.89 and 797.78 min). The 16 h upper
limit, 0.007875859 rad/min (1.8050139230 rev/day), lies inside the 0.5-day band and never decides a class.
Inside a band the class's terms are always summed, whether or not the orbit is close to exact commensurability. The
class is held for the whole propagation: when drag carries n out of its band, every rate evaluation of the
integrator still sums the epoch class's terms, and a set outside every band at the epoch never gains terms
*[study; probe 6.10: two decaying sets, of the 0.5-day and the 8 h class, whose n crosses 2.4066852459 and
3.6100278459 rev/day near day 2. From each library node, one step of 9 with the epoch class and F, G at e_0, i_0
reproduces the change of n to the next node to 1e-7 of that change, before and after the crossing; with the class
and F, G of the current elements it misses by up to 4e-3 after the crossing, and with no resonance terms by 6e-4
to 3e-3 throughout]*. A native-element report is different: it re-initializes the set at the requested time (1.5), so its rates
take the class of the mean motion at that time *[probe 6.9]*.
AP holds its class the same way, with its rate and output tables of the epoch class for the whole flight (16.7).

The legacy SGP4 bands (synchronous for 0.0034906585 < n < 0.0052359877 rad/min; half-day for 8.26e-3 <= n <= 9.24e-3
and e >= 0.5) are not used for type 4.

### 6.1 Resonant terms per class

AP adds the half-day terms of degrees 6 through min(d, 31), for every even order m and p = 0..l,
with k = m/2 and q = k - l + 2p (16.2). In the one-day class, at an epoch eccentricity at or below 0.3, AP adds the terms
of degrees 5 through min(d, 31), for every order m from 1 to 16 and p = 0..l, with k = m and q = m - l + 2p (16.2; stack
#434). SGP4XP keeps the class table below.
Against FFM model truth after a 72 h fit, day-1/3/7 3D errors in meters at 0.4.15 are 27.5/70.0/60.1
for the half-day fixture, 45.9/27.0/419.4 for Molniya with drag (its fitted drag coefficient, 16.11), 115.3/79.2/244.3
for GTO, and 22.2/61.4/56.4 for the 55-degree fixture (16.11). Section 16.6 defines the fixtures and signed RTN errors.

A term is labeled (l, m, p, q). Its resonant angle is

    psi_lmpq = (l - 2p) omega + (l - 2p + q) M + m (Omega - theta_G(t)),   theta_G(t) = theta_G(epoch) + omega_E t

(theta_G(epoch) and omega_E as in 1.2), and the class fixes the multiplier k = l - 2p + q of M through
k n ~ m omega_E, so that q = k - l + 2p. The library sums exactly these terms and no others *[study; probe 6.3,
6.4]*:

| class | k | (l, m) with the p used | q | terms |
| --- | --- | --- | --- | --- |
| 1 day | m | (2,2) p = 0-2; (3,1) 0-3; (3,2) 0-2; (3,3) 0-2; (4,1) 0-3; (4,2) 0-3; (4,3) 0-2; (4,4) 0-2 | abs(q) <= 4 | 27 |
| 0.5 day | m/2 | (2,2), (3,2), (4,2), (4,4), (5,2), (5,4), each with every p = 0 to l | -4 to 7 | 29 |
| 8 h | 1 (m = 3) | (3,3) p = 0-3; (4,3) 0-4; (5,3) 0-4; (6,3) 1-5 | -4 <= q <= 5 | 19 |
| 16 h | 2 (m = 3) | (3,3) p = 0-3; (4,3) 0-4; (5,3) 0-4; (6,3) 0-5 | q <= 6 | 20 |

For example the 0.5-day terms of (2,2) are (2,2,0,-1), (2,2,1,1) and (2,2,2,3), with the angles
2 omega + M + 2 (Omega - theta_G), M + 2 (Omega - theta_G) and -2 omega + M + 2 (Omega - theta_G). Degrees run from
2 to 6; there is no (2,1) term.

### 6.2 Tesseral coefficients

Unnormalized EGM-96 values (Lemoine et al. 1998: the normalized coefficients times
N_lm = sqrt((2 - delta_0m)(2l + 1)(l - m)! / (l + m)!)), dimensionless *[study; lit]*:

| coefficient | C_lm | S_lm |
| --- | --- | --- |
| (2,2) | 1.57446037456404e-6 | -9.03803806638557e-7 |
| (3,1) | 2.19263852916859e-6 | 2.68424890296779e-7 |
| (3,2) | 3.08989206880511e-7 | -2.11437612437343e-7 |
| (3,3) | 1.00548778064384e-7 | 1.97222559005906e-7 |
| (4,1) | -5.08799360403833e-7 | -4.49144872839336e-7 |
| (4,2) | 7.84175859843762e-8 | 1.48177868295612e-7 |
| (4,3) | 5.92099402629132e-8 | -1.20077667633627e-8 |
| (4,4) | -3.98407411766274e-9 | 6.52571425370430e-9 |
| (5,2) | 1.05587168390898e-7 | -5.23291936216342e-8 |
| (5,3) | -1.49300637492288e-8 | -7.09734236889537e-9 |
| (5,4) | -2.29930029012696e-9 | 3.86712335850938e-10 |
| (6,3) | 1.18542072651316e-9 | 1.87163685038141e-10 |

### 6.3 Disturbing function and rates

In the canonical units of 1.4 (Earth radii and minutes; mu = k_e^2, equal to n^2 a^3 with a = (k_e / n)^(2/3)), the
resonant disturbing function of a class is the sum over its terms (6.1)

    R = sum of (mu / a^(l+1)) F_lmp G_lpq S_lmpq,
    S_lmpq = C_lm cos psi_lmpq + S_lm sin psi_lmpq      for l - m even,
    S_lmpq = -S_lm cos psi_lmpq + C_lm sin psi_lmpq     for l - m odd

(Kaula 1966, ch. 3). Its partial derivatives are taken term by term: d/dM, d/domega and d/dOmega act on psi only
(factors k, l - 2p and m), d/de on G_lpq only (giving dG_lpq/de), d/di on F_lmp only (dF_lmp/di), and
dR/da = -(l + 1) R_lmpq / a. The rates are Lagrange's planetary equations (Kaula 1966, ch. 3; Brouwer and Clemence
1961), with eta = sqrt(1 - e^2):

    da/dt     = 2 / (n a) dR/dM
    de/dt     = eta^2 / (n a^2 e) dR/dM - eta / (n a^2 e) dR/domega
    di/dt     = (cos i dR/domega - dR/dOmega) / (n a^2 eta sin i)
    domega/dt = -cos i / (n a^2 eta sin i) dR/di + eta / (n a^2 e) dR/de
    dOmega/dt = dR/di / (n a^2 eta sin i)
    dM/dt - n = -eta^2 / (n a^2 e) dR/de - 2 / (n a) dR/da

They are added to the six-component rate set of section 2 as

    n-dot += -(3 n / (2 a)) da/dt,   e-dot += de/dt,   i-dot += di/dt,
    e varpi-dot += e (domega/dt + dOmega/dt),   sin i Omega-dot += sin i dOmega/dt,
    lambda-dot - n += (dM/dt - n) + domega/dt + dOmega/dt

*[study: the library's six resonance rates equal these, symbolically in all inputs, to 1e-15 for every class;
probe 6.3, 6.4]*.

The four function values of each term, F_lmp, dF_lmp/di, G_lpq and dG_lpq/de, are computed once, at initialization,
from the epoch mean elements i_0 and e_0, and held for the whole propagation. Every other quantity in the equations
(a, n, e, eta, cos i, sin i, M, omega, Omega and theta_G(t) = theta_G(epoch) + omega_E t) follows the state being
evaluated *[study; probe 6.8: from each of the 8 library nodes of six 0.5-day HEO sets with AGOM and B zero, one
step of 9 with F and G at e_0, i_0 reproduces the library's change of n to the next node to 4e-9 of that change;
with F and G at the current e and i it misses by 3e-4 to 4e-2]*. The rates of a native-element report at time t are
those of a fresh initialization at t (1.5): F and G at e(t), i(t) and theta_G from 1.2 at t. Because theta_G of 1.2
advances at (C1 + 2 pi) per day, 4.25e-10 rad/min faster than omega_E, the report's resonance angles lead the
integrator's by 6.1e-7 rad per day since the epoch *[probe 6.8: the reported n-dot is reproduced to 1e-13 of its
largest value as a fresh initialization at t; with theta_G(epoch) + omega_E t and F, G at e(t), i(t) to 7e-6; with
F, G at e_0, i_0 to 3e-4 to 2e-3]*.
The terms are the same in the averaged and in the long-period regime (5, 9), and no resonance term
enters the output-time corrections (8) *[study]*.

### 6.4 Inclination and eccentricity functions

**Inclination functions.** F_lmp(i) is Kaula's closed form (Kaula 1966, ch. 3), with k = floor((l - m) / 2):

    F_lmp(i) = sum over t = 0 .. min(p, k) of
               (2l - 2t)! / (t! (l - t)! (l - m - 2t)! 2^(2l - 2t)) sin^(l - m - 2t) i
               x sum over s = 0 .. m of binom(m, s) cos^s i
                 x sum over c of binom(l - m - 2t + s, c) binom(m - s, p - t - c) (-1)^(c - k),

c running over the integers for which both binomial coefficients are defined. The library's F_lmp agree with this to
1e-12 *[study]*. dF_lmp/di is the exact derivative of F_lmp, with one exception *[study; probe 6.3]*: for
(l, m, p) = (6, 3, 2), which occurs in the 8 h and 16 h classes, the library uses in its place, with c = cos i and
s = sin i,

    D_632(i) = (259875 c^6 + 259875 c^5 - 390285 c^4 - 372330 c^3 + 155925 c^2 + 127575 c - 10395) / 128
               - (2835 / 8) s c (1 + c),

whereas the derivative is (311850 c^6 + 259875 c^5 - 448875 c^4 - 326970 c^3 + 162540 c^2 + 82215 c - 10395) / 128
(at i = 0.9 rad: D_632 = -119.140, the derivative 0.562).

**Eccentricity functions.** G_lpq(e) is the Hansen coefficient X^{-(l+1), l-2p}_{l-2p+q}(e) (Kaula 1966, ch. 3;
G_lpq = G_l,l-p,-q):

    G_lpq(e) = (1 / 2 pi) integral over M from 0 to 2 pi of (a / r)^(l+1) cos((l - 2p) f - (l - 2p + q) M) dM.

The library uses its Maclaurin polynomial in e, the terms e^|q|, e^(|q|+2), ... up to e^26 for even q and e^27 for
odd q, and for dG_lpq/de the derivative of that polynomial *[study; probe 6.3]*. The polynomial, not the function, is
the model. The Laplace limit e = 0.6627 concerns a Maclaurin expansion about e = 0 (Brouwer and Clemence 1961),
not an eccentricity cutoff for the Hansen integral or a bound on a finite polynomial's truncation error.
The library evaluates the finite polynomial at every e, with no closed form and no other expansion
*[probe 6.3: at e = 0.7 the library's n-dot matches the polynomials to 4e-14 and the closed-form functions only to
7.5e-4]*. Each term of 6.1 takes the G_lpq of its own (l, p, q): the 0.5-day class has no k = 0 term (no G_20,-2,
for example), and the 16 h term (4,3,1,0) uses G_410. The library's coefficients agree with the exact Maclaurin coefficients to 2e-8 relative, with these
exceptions *[study; probe 6.3, 6.5, 6.6]*:

- 16 h class, G_410: the coefficient of e^2 is 2 instead of 1. The derivative used with it is that of the exact
  polynomial (2e + ...).
- 16 h class, dG_40,-2/de: the e^13 and e^15 terms are absent.
- Series with abs(q) = 1: the coefficient of e^27 is c_27 - 2 c_1 b_27 in place of the exact c_27, where c_1 is the
  series' e^1 coefficient and b_27 = C_13 / 2^27 = 742900 / 134217728 = 0.005535036325454712 is the e^27 coefficient
  of beta = e / (1 + sqrt(1 - e^2)) = sum over k >= 0 of C_k e^(2k+1) / 2^(2k+1) (C_k the Catalan numbers): the
  polynomials are those of an expansion in beta whose series stopped after its e^25 term. The c_1 are -1/2, 3/2, -1,
  3, -3/2, 1/2, 9/2, 5/2, 0, 4, 3/2 and 7/2 for G_20,-1, G_211, G_30,-1, G_311, G_40,-1, G_41,-1, G_411, G_421,
  G_51,-1, G_521, G_62,-1 and G_631 (so G_51,-1 is exact). The derivative series is the derivative of this
  polynomial, with e^26 coefficient 27 (c_27 - 2 c_1 b_27). The rule reproduces every such library coefficient to
  1e-9 relative.
- 1 day class, G_30,-1: the polynomial ends at e^25, while its derivative series also has the e^26 term
  27 (c_27 + 2 b_27) e^26 = 0.5751355376693 e^26 (c_27 the exact e^27 coefficient of G_30,-1, whose c_1 is -1): the
  derivative of the polynomial through e^27 of the previous item, as the 16 h class uses it.

**AP eccentricity approximation.** Section 16.2 uses the corrected Maclaurin coefficients below
`kSeriesE = 0.3`. When the expansion center satisfies e0 > 0.3 and e0 + 0.001 < 1 (from 0.6.40 strictly above,
as the other eccentricity switches: a set at exactly 0.3 is the below side's; through 0.6.39 e0 >= 0.3), the original
resonance terms use the Hansen integral at e0 and a third-order Taylor expansion in de = e - e0 for
current e >= 0.3; otherwise they use the corrected Maclaurin polynomial. They are exact at the
epoch eccentricity to the numerical integral's precision, third order within |de| <= 0.02. The measured
per-term relative truncation errors reported on 2026-11-02 are 1.1e-4 at |de| = 0.01, 1.5e-3 at 0.02,
and 4-15% at 0.05. These are measured errors, not uniform bounds over all terms or eccentricities.
The stated approximation range is |de| <= 0.02; it is not an enforced propagation-refusal condition.
The epoch class expands about epoch e0 for the whole flight (16.7).
The added high-degree half-day tail has its own quadrature and cubic tables described in 16.2.

### 6.5 Checks against the oracle

*[probe 6.3]* Averaged regime (0.5 day, 8 h and 16 h classes; 16 vectors, e = 0.01 to 0.7), drag and SRP off. The
zonal (2) and averaged third-body (5) rates have no n-dot, so the n-dot of the six-rate set is the resonance alone.
The equations of 6.3 with the library's function values reproduce it to 2e-12 relative in every vector, and so do
exact Maclaurin coefficients with the exceptions of 6.4; with exact e^27 coefficients instead, the agreement is only
2e-8 for e <= 0.6 and 5e-7 at e = 0.7. Without the G_410 exception the 16 h n-dot is off by 1e-4 (e = 0.01) to
100 % (e = 0.5). The other five rates equal the library's
minus the zonal and third-body rates to within that subtraction's own accuracy (3e-13 per minute), and the 8 h
class's sin i Omega-dot needs D_632 (without it 2e-3 relative off at e = 0.5).

*[probe 6.4]* 1-day class, always in the long-period regime, where the third body enters through the instantaneous
geometry (5). For fixed elements at 24 epochs over one sidereal day, the library's n-dot minus the n-dot of 6.3 is a
smooth function of the epoch: a degree-8 polynomial fit leaves 8e-22 rad/min^2 RMS, against 8e-13 for the library's
n-dot alone and a resonance n-dot amplitude of 1.6e-11 rad/min^2. The theta_G harmonics of the 1-day terms are
reproduced to about 5e-11 relative.

*[probe 6.5]* High eccentricity, averaged regime (0.5 day at e = 0.72 and 0.74, 16 h at 0.75 and 0.78, 8 h at 0.62
and 0.66): with the exceptions of 6.4 the n-dot is reproduced to 5e-13 relative; with exact e^27 coefficients the
error is 7e-7 to 6e-6.

*[probe 6.6]* 1-day class at e = 0.73 and 0.8, fixed elements at 24 epochs over one sidereal day: the library's
lambda-dot minus that of 6.3 is smooth in the epoch (degree-8 fit residual 4e-19 and 6e-19 rad/min RMS) with the
e^26 term of dG_30,-1/de, and not without it (1e-17 and 3e-16).

*[probe 6.2]* The class changes exactly at the limits above. At each of the five limits that decide a class, the
two element sets that straddle it (mean motions 1e-8 rev/day apart, the element-set resolution) have n-dots that
differ by 10^6 to 10^8 times the step between neighbors on the same side (across 2.4066852459 rev/day n-dot changes
sign); across 0.007875859 rad/min nothing changes. Between two element sets on either side of a limit the class
therefore makes a discontinuity in the rates; along one propagation the class does not change (Bands). The
section-6 vectors scan n through each commensurability; the lambda-dot and n-dot response gives the strength of each
harmonic.

*[probe 6.8]* Six 0.5-day HEO sets with AGOM and B zero, where n-dot is the resonance alone: native reports every
3 hours for 7 days and at the first 9 integrator nodes (t_k+1 = t_k + 4 pi / n_k, n_k reported at node k). The
integration follows F and G at e_0, i_0 (6.3: each node-to-node change of n to 4e-9 of that change, against 3e-4 to
4e-2 with F and G at the current e and i), and the reported rates are those of a fresh initialization at each
time (1.5: the reported n-dot to 1e-13 of its largest value).

*[probe 6.9]* Ten decaying 0.5-day sets (AGOM 0, perigees 66 to 103 km) whose n rises into the 8 h band, and for
several past 3.61 rev/day, within a day: reports every hour for 7 days. Their elements follow the integrator with
the epoch class; their rates take the class and F, G of the elements at each time (1.5), with the drag of 3.3 and
3.4.

*[probe 6.10]* Two decaying sets (AGOM 0, perigees 130 and 140 km), of the 0.5-day and the 8 h class, whose n
crosses 2.4066852459 and 3.6100278459 rev/day near day 2; the first 9 integrator nodes with their reports, reports
every hour and states every 6 hours for 7 days. They separate the integrator's epoch class from the class of the
reports (Bands): after the crossing the reported rates switch class, the node-to-node steps do not.

**AP and the 12-hour class.** XP's averaged lunisolar rates (5) stop at Legendre degree 3; AP adds degrees 4 to 10
for epoch periods below 1100 min and epoch eccentricities below 0.1 (16.8). This class's degree-2 terms (the resonant
table of 6.1, the m-daily and the short-period terms of 16.2) reproduce a numerical reference (EGM96 J2 and J22, no
third bodies, an Etalon-like orbit at 2.13 rev/day) within 0.3 m cross-track and 0.9 m along-track at day 7 once the
fitted set keeps its full precision (16.9): the cross-track floor and the node-dependent errors first attributed to
them were the two-line lattice of the fitted set.

## 7. Very deep space (VDS) / cislunar region

**Model.** "The Very Deep Space / cislunar region is added for multiday orbits" *[doc: release notes 8.0 item 7]*.
The library divides type-4 orbits at an epoch period of 1100 minutes (sections 5, 9): below it, averaged rates with
steps of two periods and analytic output-time lunar-solar periodics; at or above it, rates from the instantaneous
geometry with 95-minute steps and no output-time lunar-solar periodics *[study; probe 9.2]*. Release notes 9.6-9.9
list "add lunar potential and lunar shadow for cislunar propagations" as planned, so 9.9 has neither *[doc]*; the 9.2
JIRA ASTROSTDS-1243 notes the analytic Moon's weakness near the Moon.

The library has no further class: every type-4 orbit with an epoch period of 1100 minutes or more is propagated in
the long-period regime, which is what the release notes call the VDS/cislunar region *[study]*. The section-7
vectors hold states for mean motions 0.9, 0.5, 0.25 and 0.1 rev/day.

## 8. Short-periodics and the osculating output

**Order of operations at the output time** *[study]*:

1. Cubic Hermite interpolation of the mean equinoctial elements between nodes (section 9).
2. Conversion to Keplerian mean elements (angles reduced to [0, 2 pi)); failure if n <= 0 or e >= 1; e < 0 is set
   to 0.
3. Averaged regime only: the Sun and Moon periodic corrections (section 5) are added to the mean elements.
4. With SRP on, in both regimes: the output-time SRP periodic terms of section 4 are added to the equinoctial
   elements, with E the eccentric anomaly of the interpolated mean elements of step 1 and the Sun at the output time
   *[probe 4.3, 4.5]*.
5. Kepler's equation (eccentric anomaly E from M = E - e sin E), true anomaly nu, and the first-order J2
   short-period corrections of Brouwer (1959, section 7), in the arrangement of the SGP4 final step (Hoots &
   Roehrich 1980): corrections to the radius r, the argument of latitude u = omega + nu, the node Omega, the
   inclination i, the radial velocity r-dot and the transverse velocity r f-dot *[lit; study; probe 8.2]*.
6. Position and velocity from the corrected (r, u, Omega, i, r-dot, r f-dot) with the orientation vectors of the
   SGP4 final step, scaled to km and km/s (section 10).

**Refusals** *[study; probe 8.4, 8.5]*. The integrator advances node by node from the epoch (section 9). When a step
fails for good (the tests and the single 90-minute retry of 9), the grid ends at the last good node: the epoch and
every output time up to that node are served, and every later time is refused with the code of the failed test,
4 (eccentricity above 1) or 9 (mean motion not positive); the native elements there carry the same code. A node
whose own rates fail ends the grid the same way. With the first step failing, every time after the epoch is
refused from 1e-6 min on. Strong drag at a low perigee does this: the epoch n-dot is so large that a stage state
leaves the elliptic range.

- Side B's sets 1786, 3850 and 7042 (perigees 56-62 km above the equatorial radius, epoch n-dot 206 to
  553 rev/day^2): the two-period step fails at k2 (e = 4.2 to 12.5). The 90-minute retry fails at k4 for 1786
  (n = -0.40 rev/day, code 9) and 7042 (n = -0.0009 rev/day, code 9); for 3850 its k2 state lies below the ground,
  the 10 km density there (3.3) drives the k3 state to e = 1e4, code 4. Every time after the epoch is refused with
  that code. A 30-minute step would pass for all three (k4 at n = 0.25 to 1.60 rev/day, e < 0.9), but 9.9 has no
  such fallback (9).
- The decaying sets 8788 and 4210 of 6.9 (perigees 66 and 71 km, epoch n-dot 43 and 58 rev/day^2) fail the
  two-period step at k3 (k2 below the ground, k3 at e = 3e4 and 7e4) and pass the 90-minute retry: their first node
  is at 90 min, the next step is two periods at that node's n, and they are served for the 7 days (these steps
  reproduce the library's elements at 90 min and two periods later to 1e-8).
- The 8.4 cases of amendment 5: with a 130 km perigee the first step fails at both lengths (refused from
  1e-6 min); with a 150 km perigee the first two-period step passes (node at 175.24 min) and the second fails at
  both lengths (refused after that node).

**Short-period corrections.** Units R_E and minutes; a = (k_e / n)^(2/3), n the interpolated mean motion
(rad/min), e, i, M, Omega, omega the mean elements after step 3, eta = sqrt(1 - e^2), p = a eta^2,
r = p / (1 + e cos nu), theta = cos i, u = omega + nu, and the abbreviations
c = J2 / (4 p), d = J2 / (4 p^2), Q = (nu - M) + e sin nu with nu - M the equation of the center reduced to
(-pi, pi], n_a = k_e / a^(3/2):

- Delta r = c [ (1 - theta^2) cos 2u - (e cos nu / (1 + eta) + 2 r / (a eta) + 1)(3 theta^2 - 1) ]
- Delta i = d theta sin i [ 3 cos 2u + e (3 cos(2 omega + nu) + cos(2 omega + 3 nu)) ]
- Delta Omega = d theta [ 3 sin 2u - 6 Q + e (3 sin(2 omega + nu) + sin(2 omega + 3 nu)) ]
- Delta u = d [ (1 - eta)(3 theta^2 - 1) sin nu (e / (1 + eta) + cos nu) - 3 (1 - 5 theta^2) Q
  + (1/2)(1 - 7 theta^2) sin 2u + e ((2 - 5 theta^2) sin(2 omega + nu) - theta^2 sin(2 omega + 3 nu)) ]
- Delta r-dot = eta [ -2 c n_a (a/r)^2 (1 - theta^2) sin 2u + c n_a e sin nu (3 theta^2 - 1)((a/r)^2 / (1 + eta)
  + 1/eta^3) ]
- Delta (r f-dot) = eta [ -n_a (a/r)^2 Delta r + n_a (a^2 / r) d sin^2 i (3 cos 2u + e (3 cos(2 omega + nu)
  + cos(2 omega + 3 nu))) ]

with the unperturbed r-dot = n_a a e sin nu / eta and r f-dot = n_a a^2 eta / r. The corrected quantities are
r_k = r + Delta r, u_k = u + Delta u, Omega_k = Omega + Delta Omega, i_k = i + Delta i, and the two velocities plus
their corrections; velocities are converted from R_E/min to km/s by R_E/60. J2 here is the EGM-96 J2 of 1.3.

*[probe 8.2, 8.3]* Confirmed exactly. In the long-period regime (epoch period 1100 min or more) no output-time
Sun/Moon terms are added, so at t = 0 the state is these corrections applied to the element-set values: over 28
cases (n = 1.0027 and 1.3 rev/day, e = 0.0003 to 0.4, i = 0.05 to 63.43 deg, mean anomaly every 45 deg) the
formulas reproduce the library's position to 3e-11 km and velocity to 2e-15 km/s. In the averaged regime the LEO
case (15.2 rev/day, e = 0.001, i = 51.6 deg) is reproduced to 0.6 m (2.4 km without the corrections), the remainder
being the output-time Sun and Moon terms of step 3; at 1.6 rev/day the remainder is 0.15-0.6 km, the size of those
terms there.

**Confirmed.** *[probe 8.1]* The library reports both the mean and the osculating Keplerian elements at each time;
at t = 0 the mean elements are the element-set values and the osculating ones differ by the periodic terms (for
the 15.2 rev/day, e = 0.001, i = 51.6 deg case: osculating a = 6881.0358 km against mean 6883.9776 km, osculating
e = 0.000971, i = 51.5903 deg).

## 9. The internal integrator

**What is integrated.** The six equinoctial elements of 1.5 (with the mean motion carried in rad/min and the angles
in radians) under the rate function of sections 2-7: short-period-averaged rates when the epoch period is below
1100 minutes, rates from the instantaneous third-body geometry at or above it (sections 5, 7) *[probe 1.3: the
native elements and their rates are the library's own observable; study]*.

**Grid.** A fixed grid of nodes anchored at the epoch, built outward from the epoch separately forward (t > 0) and
backward (t < 0). Node 0 is the epoch state with its rates. The step from node k to node k+1 is

- h_k = 4 pi / n_k, two mean periods at the mean motion n_k (rad/min) of node k, for orbits whose epoch period
  2 pi / n_0 is below 1100 minutes;
- h = 95 minutes for orbits whose epoch period is 1100 minutes or more (this class is fixed at initialization).
  AP with a selected gravity replacement and the epoch one-day resonance class uses 38 minutes instead,
  and an AP set with e_0 above 0.3 steps at most 0.5 (1 - e_0)^(3/2) / n_0 (16.10);
  the checkpoint stride uses that same step. Default FORCES retains the 95-minute XP grid.

The grid depends only on the epoch state *[probe 9.1: the library's direct, 1-minute stepped and backward-approach requests
agree to 0 mm]*. An AP state in this module is a function of its set and its time alone (0.6.18): the order of requests,
the call they come in (one epoch, the first state of a call, a state inside a batch), the sets flown before or between
them, whether the covariance is asked, and the path (`propagate`, `propagate_epochs`, the epoch store's exports) leave its
bits unchanged, with one exception stated below. What makes it so:

- Every evaluation cache an AP state reads holds a function of the set and the time. The tesseral terms are baked on the
  state's own bracket (the a, e and cos i of its two nodes, and cells of them), the zonal tail and the shallow terms at the
  state's a. A store's set keeps its own third-body bracket tables, m-daily terms and tesseral cache (the pool below)
  while it holds them, the thread's otherwise, and both give the same numbers.
- A step depends on its first node alone: rk3 evaluates the parts of node a's rates the stages hold fixed again from the
  node's own state (before that step's corrections), never from what the step before left. The grid's nodes are the same
  whichever node an integration starts from.
- The drag-pass segment above e 0.3 (16.12) takes its perigee time and period from its bracket's lower node, not from the
  first state asked.
- The third body's bracket tables are the bracket's own (stack #475). The bracket's lower node chooses their builder,
  rows and sub-interval count, and they are read only as far as the builder wrote.
  Through 0.6.22 two things followed the state asked first instead:
  - the builder and the sub-interval count;
  - the rows past those written, read as the last set had left them.
  So a state near the three mean motions where the builder changes (0.006, 0.015 and 0.035 rad/min) moved with the order
  of requests, by up to 0.285 m (0.015 rad/min, 1e-7 above). Against the earlier states asked in ascending order it is
  now at most 14.3 mm (0.015), 5.8 mm (0.006) and 2.5 mm (0.035), and unchanged elsewhere.
- A record's covariance is likewise a function of the record and the time (12.3).
- The epoch store times an AP set from the split Julian date, with the expression `propagate` uses. Minutes from J2000
  round by up to 1e-7 s at today's dates, 1 mm in low orbit. SGP4XP and SGP4 in the store keep the minutes from J2000:
  their output is 0.6.9's bit for bit, and it differs from `propagate`'s by up to that rounding.

The exception: a record that carries a covariance flies its nominal state through `propagate` by the covariance's combined
evaluation (xp_propagate_cov_at). That evaluation takes the third-body short-period terms at the state, because their
derivative is needed, and the Sun from the call's hourly table. Every other path interpolates both linearly across the
bracket's sub-interval (eval_tbsp_lerp_f32, the bracket's Sun). On the AP fixture fit the two differ by 0.39 mm (stack
#420). The same record without its covariance flies the same bits through every path.

test/set-caches.e2e.mjs holds this on nine made-up orbits: 500 km, 830 km, MEO, GEO, e 0.1 and 0.25 with tesseral 31, the
transfer orbit with and without tesseral 31, and Molniya. Against ascending order, to the bit:

- random order and alternating ends over 7 days at 300 s;
- one state of a freshly loaded record;
- two records interleaved, at the pool's default budget and at 1 MB;
- through `propagate`, a time asked alone against the same time in a 2,016-state call.

test/carried-identity.e2e.mjs holds the paths: `propagate_epochs`, the store, and `propagate` of the record without its
covariance give the same bits.

The pool's threads change no state. Over 1,000 AP rows of a catalog mix in the row store, sdnap_propagate_soa on 0, 4 and
15 threads gives one digest; 0.6.12 differed at 120 values between 0 and 4 threads (test/set-caches.e2e.mjs holds 0
against 4). The exception today is stack #424: above e 0.048 with tesseral terms, a process holds at most 256 family
grids. Beyond them a state is refused, and which eccentric set is refused depends on which thread asked first.

The epoch store's state-only `sdnap_epochs_at` also uses the pool. A chunk holds 16 consecutive series; one thread
owns both slots of each series through selection, initialization, flight and replacement. A series containing a wide
set is initialized and flown on the calling thread, in series order, because both initialization and output-time nodes
acquire the shared 256-slot grids. A wide set is an AP set above e 0.05 in no resonance class (class 0: low orbit, the
LAGEOS band, below 0.8 rev/day) and above e 0.3 in a resonance class (`tess::wide_set`, SPEC 16.11). So a store of
low-orbit sets at e 0.1 is built and flown serially, and the pool's speed-up holds for the near-circular sets below
those switches. Calls requesting covariance remain serial. The atmosphere and force bindings and
NRLMSISE-00's mutable state belong to each thread. Constant drag, gravity and leap-second tables are initialized before
the batch. The context identifier, short-period generation tag and grouping identifier are cache keys only.

Two rules keep one pool thread's work out of another's:
- **A set leaves the cache pool under the pool's lock.** A store's set releasing its caches does so under the pool's lock,
  whether it still holds them or not. A reclaim on another thread drops a set's caches and stores the unlock of the set's
  cache lock within one hold of that lock. A release that read the null left by such a drop without the lock could free
  the set before the unlock landed in it.
- **A slot names its set only once the set is built.** Until then it holds none.

**After a dead batch** (a pool thread taken for dead, the batch's return -20, every status 9), a thread that was only
slow may still be building, flying or replacing its series' slots. So the store's slots are not read again until the
store is replaced:
- `sdnap_epochs_at` answers -20 with every status 9, `sdnap_epochs_set_at` and `sdnap_drag_orbit_check` answer 9, and
  the store's byte count (`sdnap_epochs_stats`, the eighth value) reads NaN;
- `load_epochs` and `load_epochs_open` refuse "pool-dead" while a pool thread is active, before they free anything:
  the store stays as it is, and no load is open (a part or a close answers "load-not-open"). `load_epochs_open`
  refuses so before it reads its $PCF, so a bad $PCF there also answers "pool-dead"; `load_epochs` reads its inputs
  first and answers their refusals as before. A thread that trapped never stops being active.
- Once no pool thread is active, `load_epochs`, or `load_epochs_open` and the parts and the close, replace the store.
  The pool is not used again: the new store's calls run on the calling thread.
- The other readers of the store (`sdnap_epochs_count`, `_series`, `_select`, `_source_at`) read only its entries and
  series, which no pool thread writes: `sdnap_epochs_count` answers the store's count.

**A pool thread that traps while it holds a lock** (the module's locks are spin locks with no owner: the cache pool's,
a set's cache lock, the family grids', sbrk's break) leaves it held. The calling thread's next call that needs that lock
spins without end, which on a browser's main thread is a hang. A host that sees a pool thread trap, or a batch taken
for dead, discards the instance and starts a new one.

`test/epoch-pool-safety.e2e.mjs` holds both rules (256 series, a 1 MiB cache budget, slots replaced in every batch, 4
and 15 threads) and the dead batch (one pool thread held in its first chunk, the calling thread going on only once a
pool thread holds it): every answer above while the thread is held, then the store loaded again by the three calls and
by `load_epochs` once it has left, each equal to a fresh instance's states.

Three more rules for the pool threads:
- **No pool thread waits on a static's first use.** The calling thread and every pool thread make, before any batch,
  each guarded static a pool thread can first touch (pool::warm_thread: the thread's caches and NRLMSISE-00's flag
  table).
- **The cache pool sorts copies.** A reclaim picks its victims from stamps read once under the pool's lock (an owner
  moves its stamp under its own cache lock alone, atomically). It orders them by stamp alone, with the comparator of
  sdn-ap 0.6.57 (which sorted the holders themselves) over the holders in its order. Equal stamps are common, since
  consecutive cached flights share one, and a serial reclaim keeps 0.6.57's choice among them: the choice can move the
  state of an AP set that was asked on both sides of its epoch (its bake caches use one id for the brackets on both sides
  of the set's epoch, below).
- **The missing weather day is a note, not a result.** `Store::short_day` is written by the thread that flew the state
  that found no row. `propagate_epochs` reads it on the calling thread right after that state. After a threaded
  `sdnap_epochs_at` it names some series' missing day; each series' own status is in its status code.

`test/epoch-pool.e2e.mjs` flies 2,048 seeded series (6,144 records) at 6 h, 18 h and 30 h: a blend of sets 0 and 1, then
of 1 and 2 (slots replaced inside the batch), then set 2 alone. The store holds SGP4, SGP4XP and AP series, AP on
NRLMSISE-00 at node heights under and over 325 km and on Jacchia 1970, two force sets and two weather tables
alternating, covariance on half, and eight wide series flown on the calling thread.
- The reference is each series alone on the calling thread. Its digest is the one sdn-ap 0.6.57 gives.
- On 0, 1, 4 and 15 threads, in slices of 100 series, and with each building thread's scratch and its half-day
  evaluation cache's values poisoned before every set: every state and status byte equals the reference. Every state is
  answered.
- After the threaded instants, every series' covariance in one call equals the reference's to the bit. A call with a
  covariance plane runs no batch.
- Counted per thread: at least a quarter of the rows, slot replacements and NRLMSISE-00 evaluations (on each side of
  325 km) are on pool threads, and more than one pool thread flies at 4 and 15 threads. On the shipped build,
  `sdnap_pool_stats` shows rows on pool threads and at least two pool threads with rows at 4 and 15 threads, the
  store loaded whole or in parts.
- With no reserve (every growth of the memory inside a batch refused; the case still refuses and defers): every status
  equals the reference. Every state equals the reference, or, for a series deferred at that instant, the serial state
  with its slots dropped just before its flight. That allowance covers one defect alone: one cache id for the brackets
  on both sides of a set's epoch in the tesseral and m-daily bake caches.
- The test build's counters show every path taken.

The 400-wide-series control at 0 and 15 threads also keeps every refusal in the same series.

The pool and the memory (stack #487). A threaded batch grows nothing, and a pool thread uses no page it does not see.
- Before the batch the calling thread makes its room. The reserve is 128 KiB for each AP row whose set holds no caches,
  at most the pool's free budget plus 1 MiB, plus 8 MiB. The calling thread then publishes the memory's size and sets
  the rule that nothing grows. Only then does it store the batch's chunk total and wake the pool threads.
- An epoch call runs in slices of at most 4,096 series, one batch each, and the memory may grow between them, so the
  high-water is the sets made plus one slice's reserve. A threaded call holds more memory than a serial one: the
  slice's reserve, and each pool thread's own caches and scratch. After a first pass of 20,000 AP series the instance
  held 1,092 to 1,135 MiB on 1 to 15 pool threads, against 972 MiB on the calling thread alone. A slice's reserve is its
  own:
  - 64 KiB per selected cold SGP4XP or AP set (an SGP4 set: its satellite and deep-space checkpoints);
  - the cache pool's available room, at most 128 KiB per AP set;
  - each thread's combined-table bound plus its term storage (the largest selected tesseral degree, 2,048
    complementary slow terms; a diagnostic that keeps raw terms also reserves their bound);
  - 8 MiB; at most 1 GiB.

  A reserve that cannot be had is not a failure of the call. The slice is halved, and a slice of 32 series or fewer whose
  reserve still cannot be had runs on the calling thread. Each series depends only on its own inputs and the time, so
  slicing changes no byte.
- 64 KiB is a mean, not a bound (a table can reach 416 KB at degree 31 and 694 KB at 70). A pool thread can reach the
  following allocations inside a batch. Each is counted and refuses cleanly: the series releases its slots and is deferred.
  - the slot's set (SGP4XP or AP) or satellite (SGP4), and SGP4's deep-space checkpoints;
  - AP's per-set tables (resonance Taylor terms, m-daily, combined and raw short-period terms, zonal, half-day, shallow,
    resonant coefficients) and the thread's table scratch and half-day scratch, grown to the set's bound;
  - the set's caches from the pool (its record, tesseral copy, node runs). The pool's lists are made room for before the
    batch and are never grown inside one.

  Never reached inside a batch: the wide grids (a wide series flies on the calling thread), covariance (such calls are
  serial), the thread's caches and guarded statics (made before the batch), and the call's own flags and deferred list
  (made through the counted allocator before the first slice; without them the call runs on the calling thread).
- Inside the batch, sbrk refuses every growth of the memory on every thread. It still serves a request below the
  memory's end, moving the allocator's break (1.6): those pages were in the memory when the batch published its size,
  before any thread claimed a chunk, so every thread's view covers them. The trap (Why, below) came from pages grown
  after a thread's view was taken, and moving the break grows nothing.
  - A set refused its caches flies on the thread's caches. The states are the same, except for an AP set that was asked
    on both sides of its epoch before, which can differ. The cause: its bake caches use one id for the brackets on both
    sides of the set's epoch, so what it answers depends on which caches it flew with before (pull request 86 removes
    it).
  - A row that a refusal stopped is computed again by the calling thread after the batch, in row order. For the epoch
    store, the series' two slots are released first, keeping the slot to be replaced next, and its sets are built
    again. The state is the same, except for an AP set that was asked on both sides of its epoch before, which can differ
    for the same cause.
  - The sizes measured: under a millimeter in every class measured (500 km, 830 km, medium orbit, geosynchronous,
    eccentric: 0 to 0.13 mm) except strong drag, where one of eight sets with perigee under about 350 km differed by
    49.7 mm (asked every second for 81,000 s across its epoch, against a fresh instance; one by 0.11 mm, six by
    nothing). No command of this repository prints the 49.7 mm; `node test/epoch-pool.e2e.mjs` prints how many of its
    deferred states differ and the largest difference.
  - Which sets are refused their caches and which series are deferred depend on the threads' timing, so for such a set
    two runs of the same calls can differ by that much. Serially the answer is the same every run for the same calls.
- A pool thread runs a chunk only once its own memory.size covers the size published for the batch. Its claim read the
  batch's total, which was stored after that size, so it reads that size.
- Outside a batch only the calling thread grows the memory, so its view is its own. The one exception is a pool
  thread's once-per-thread caches, made as it starts, one thread at a time. That thread publishes its size, and the
  calling thread goes on once its own view covers it.
- `sdnap_pool_stats(out, count)` writes the first min(count, 16) of 16 doubles and nothing past them (a count of 16 is 128
  bytes):
  - [0] the threads running;
  - [1] the threaded batches run;
  - [2] the growths of the memory refused inside them (every thread);
  - [3] the rows deferred to the calling thread after them;
  - [4] the batches after which the calling thread saw a larger memory (the invariant: 0);
  - [5] whether the pool was taken for dead (1);
  - [6] the polls without a completed row a waiting caller allows a batch;
  - [7] the last batch's reserve in bytes;
  - [8] the waits for a thread's view of the memory that had to yield, and [9] the most yields one took;
  - [10] the memory's growths since the instance started (sbrk's, 1.6), and [11] the 64 KiB pages they added;
  - [12] the epoch store's slices halved for want of their reserve, and [13] its slices run on the calling thread
    because even the smallest slice's reserve could not be had;
  - [14] the batches' rows completed on pool threads since the instance started, and [15] the pool threads that
    completed at least one.

Why. Measured on Node 25.4.0 (V8 14.1.146.11), through the module SDK's wasi-threads glue:
- A thread can trap (memory access out of bounds) when it bulk-fills or bulk-copies a block in pages another thread has
  just grown. Its memory.size still reads the older size, and the bulk instruction is checked against that size. Plain
  loads and stores of the same pages succeed.
- This was reproduced outside the propagation code, with only the allocator, memset, memcpy and pthreads (#487).
- In the pool it happened in two ways:
  - threads grew the memory inside a batch: 0.6.20 failed 8 of 30 runs of the threaded test, and 0.6.21 failed 4 of 40;
  - the chunk total was stored before the room was made. A thread that woke late for one batch then claimed a chunk of
    the following batch while the calling thread grew the memory for it.
- The pool's own stress shows the second way. In it the calling thread grows the memory before every batch, and every
  chunk fills blocks in the new pages (4 threads, 3,000 batches a process, fresh processes one at a time):
  - It needs an oversubscribed machine: a pool thread descheduled between its claim and its fill. On an idle machine
    (load about 6 to 12 on 28 cores) neither order trapped, 0 of 100 processes each.
  - With 40 busy threads beside it (load about 50), the total stored first trapped 98 of 100 processes, and stored last
    0 of 100.
  - The same split had shown under other sessions' load earlier: 15 of 20 against 0 of 20.
- A host call or a grow of zero pages on wake did not prevent it: the late thread made that call on its wake for the
  earlier batch, before the growth it then used.
- The view wait:
  - In the loaded campaign it waited in 98 of 100 processes, 318 times, never more than one yield.
  - The waits at a thread's start count too: the calling thread grows the memory for a new thread's stack just before
    the thread first runs.
- This is the engine's behavior as measured, not a guarantee read in the standard. test/pool-growth.e2e.mjs runs the
  stress, 20 processes, in every suite. With SDN_AP_POOL_GROWTH_LOAD=1 it loads the machine itself (busy threads, twice
  the cores, at the lowest priority), so that it can fail. Without that, the default, it can fail only on a machine
  that is busy already.

The timer.
- A batch returns -20, with every row's status 9, once the calling thread has polled 2^35 times (2^37 through 0.6.32)
  while waiting for its last chunks without a row completing on any thread. The pool is then not used again. The row
  store's later batches run on the calling thread. The epoch store the batch ran over is refused (After a dead batch,
  above) until it is loaded again with no pool thread active; a store loaded then runs on the calling thread.
- The heartbeat is a row, not a chunk (from 0.6.33; through 0.6.32 a chunk had to complete). Each thread counts the
  rows it completes in a counter of its own (each counter aligned to 64 bytes), and the calling thread reads their sum at
  each poll. In a cold batch of 1,534 rows that each build a node grid (sets above their switch, flown 4 days from their
  epoch), the calling thread on 0.6.31 waited 2.3e9 polls for one chunk. That was 1/60 of the limit at the lowest
  priority on a busy machine, and could come within a factor of ten of it on a machine that polls fast.
- It is a count of the calling thread's polls, not wall time. The module imports no clock (loaders that build their own
  import objects give none), and the calling thread may be a browser's main thread, which may not block on a timed
  wait.
- Through 0.6.32 the fastest rate measured here was 2.1e9 polls a second, so 2^37 polls were 65 s, about twice the
  30 s aimed at; that loop made one poll in about one and a half clock cycles.
- From 0.6.33 a poll also reads the running threads' row counters (threads + 1 of them), so it costs more. Measured
  with 4 threads under load 61 to 67 at the lowest priority, the loop makes 2.1e8 polls a second, against 7.6e8 to
  1.0e9 for 0.6.32's loop under load near 90. So the count is 2^35: 164 s at 2.1e8 a second. At the 3 to 4 times slower
  poll, 0.6.32's fastest rate gives about 50 to 70 s, as 2^37 did before.
- On a slower or busier machine the count takes longer, and a suspended process does not count.
- Starting a thread, the calling thread waits at most 2^34 yields for its own view: 89 s at the 1.9e8 yields a second
  measured here.
- test/set-caches.e2e.mjs measures both rates and checks each default is at least 30 s at them. It also checks two
  slowed batches, each bit for bit against the same rows unslowed:
  - every chunk slowed by 0.4 of the count before its rows: the batch outlasts the count and completes, because chunks
    keep completing;
  - only the pool threads' rows slowed, each by 0.05 of the count: the calling thread finishes its own chunks and then
    waits for the pool threads' chunks, longer than twice the count, while their rows keep completing. The batch
    completes. Counted in chunks, the same case returns -20 (a diagnostic build whose wait resets on chunks only).
- A trapped thread therefore no longer leaves the calling thread waiting forever: in the stress, every trapped process
  returned the error.
- What the timer does not cover: a thread that traps while holding the allocator's lock or a set's lock still stops any
  thread that then waits for that lock.

What the caches cost in accuracy. The reference is a build of this module's own sources that bakes every evaluation cache
at the state itself on every call: the tesseral base, ae, pe and resonance bakes and the m-daily terms, with the
third-body bracket, drag-pass and half-day caches never reused. Against it, over 30 days at 60 s
(test/kernel-cost.mjs --diff):

- this module is within 0.2 to 5.6 mm on near-circular low orbits (300 to 1,400 km), 0.07 mm in MEO, 0.15 mm at GEO and
  0.22 mm in IGSO;
- with tesseral 31 it is within 27 mm at e 0.05, 4.9 mm at e 0.1 and 1.5 mm at e 0.2;
- on the eccentric orbits without tesseral terms (transfer, Molniya, THEMIS, TESS, and e 0.05 to 0.2) it gives the
  reference's own bits;
- 0.6.15 sits up to 0.98 m from the same reference (500 km, high drag, active weather), 0.53 m (400 km, high drag, quiet)
  and 0.18 m (e 0.05, tesseral 31). Its other near-circular rows are 2 to 40 mm away. Its rows without tesseral terms
  are 0.13 to 0.64 mm away; that is this change's rk3 and drag-pass work, not caches. (0.6.15 against the reference
  built before 0.6.16's long-period step.)

On the epoch store's stored record (test/fixtures/ap-fit-0.6.4.ocm, 289 states over a day at 550 km), this module and
0.6.17 are each within 1 mm of the reference: 0.84 and 0.86 mm. The fit of the same inputs
(test/covariance.e2e.mjs) gives an epoch covariance 4.8e-5 of its largest entry from the reference's on this module, and
1.74e-3 on 0.6.17.

The fit's covariance at epoch comes from central differences of the theory over steps of 1e-7 in the elements. Taking
steps ten times larger moves it by 3.3e-6 of its largest entry on this module, and by 1.57e-3 on 0.6.15 (the fit lane's
measurement, stack #456). 0.6.15's cells put non-smooth changes into those differences; the sets' caches do not.

Through a fit, the millimeters can become tens of meters (stack #456). The headline harness flew this change against
0.6.15 on its 2,096 real windows. XP's output is the same bits, and AP's states move by millimeters. But every AP
forecast there comes out of a fit, and the fit stops where no step along its columns lowers the cost, which is not a
minimum. A millimeter can move where a loose fit stops.
- Galileo 72 h fits with Y0 solved show it most. Their median error at 7 days went from 43.8 to 45.9 m; 41 of 42
  windows stay within 100 m of the numerical propagator, against 42; one window moved 43.4 m.
- The two windows that moved most were flown by three builds: 0.6.15, this build and the reference. One fitted set,
  flown by all three, gives the same errors to 0.17 mm at every lead day. Fits of the same arc end within 0.05 m of RMS
  of each other yet part by up to 64 m at 7 days, and by 6 m with Y0 held.
- The largest change of one window's error is below 0.3 m on laser spheres, laser geodetic, MEO, IGSO and 24 h
  altimetry fits. It is 0.8 to 2.6 m on 72 h altimetry, near-700 km, THEMIS 72 h and 24 h Galileo fits; 8 to 45 m
  on geostationary, strong-drag, Chandra 168 h and TESS 72 h fits; and 68 and 286 m on commercial geostationary 72 h
  and 24 h fits.
- On the commercial geostationary window that moved most, the reference's fitted set flies 34 m from this build's and
  705 m from 0.6.15's at 7 days.
- One TESS 336 h fit moved 9.75 km: this build's fit stopped at 1,083 m of RMS, against 868 m for 0.6.15 and the
  reference.

A comparison of two builds
(test/kernel-cost.mjs --diff --bound M,MPS) holds the time-order pass to its stated tolerance (0,0 for byte identity), and
prints the reversed and shuffled differences beside it. SGP4XP GEO nodes fall on
multiples of 95 minutes *[probe 9.2: native elements between epoch and 95 minutes are reproduced by cubic Hermite
interpolation of the two node values and rates to 1e-8 of their change, against 6e-5 for a 96-minute grid]*.

**Side B cache and query work.** XP/AP retains 12 sparse checkpoints and the latest pair of bracketing
nodes per direction. The ingest-time stride targets roughly eight days each way; checkpoints fill lazily.
A query inside an already cached bracketing interval interpolates without integration. The first distant
query integrates from the epoch through its bracket, creating checkpoints on the way. Once the intervening
checkpoints exist, a query within their span integrates at most one checkpoint interval. Beyond the stored
span it integrates from the nearest preceding retained node, so work grows with the remaining time gap.
The node cache has bounded storage, not a time-independent bound on query work.

**Side B: the sets' caches (0.6.18).** An AP set of the epoch store (`load_epochs`) takes its caches from one pool
while it is flown: its third-body bracket tables, m-daily terms and tesseral cache, and its nodes
as two runs (forward and backward) up to the checkpoint span. A time inside a run is a lookup, never a re-integration. A
run starts from the latest node known at or before the time (the epoch, a checkpoint or the window's), and starts again
when a time precedes it.

The pool's budget is the module's default, 256 MB. Configuration reaches a module only as a typed message, and none
carries the budget yet (PCF.EPOCH_STORE has no such field; a standards issue asks for one), so no export sets it.
sdnap_cache_stats reads the pool, as 8 doubles: the budget and the bytes held; the sets holding caches, and of them those
holding tesseral caches; the caches reclaimed; the caches and tesseral caches refused; and the tesseral caches made.

Caches per set flown a day (a week), by part, and the sets whose caches a budget holds:

| Orbit | Total | Tesseral | Node runs | Third-body bracket | m-daily | 256 MB | 1 GB | 2 GB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 km | 71.5 KB (79.0) | 58.2 | 2.5 (10.0) | 5.8 | 4.6 | 3,664 | 14,658 | 29,317 |
| 830 km | 64.2 KB (71.1) | 50.9 | 2.5 (9.4) | 5.8 | 4.6 | 4,082 | 16,328 | 32,656 |
| low orbit, e 0.052 | 13.3 KB (20.2) | 0 | 2.5 (9.4) | 5.8 | 4.6 | 19,691 | 78,766 | 157,532 |
| MEO | 19.8 KB | 7.1 | 1.9 | 5.8 | 4.6 | 13,252 | 53,008 | 106,017 |
| GEO | 33.3 KB (62.1) | 2.5 | 20.0 (48.8) | 5.8 | 4.6 | 7,861 | 31,447 | 62,894 |
| transfer orbit | 15.8 KB (22.1) | 0 | 5.0 (11.3) | 5.8 | 4.6 | 16,578 | 66,313 | 132,626 |
| THEMIS-like (n 1.0496, e 0.822) | 90.8 KB (232.1) | 0 | 80.0 (221.3) | 5.8 | 4.6 | 2,886 | 11,546 | 23,093 |
| Chandra-like (n 0.378, e 0.685) | 20.8 KB (44.6) | 0 | 10.0 (33.8) | 5.8 | 4.6 | 12,595 | 50,382 | 100,764 |
| TESS-like (n 0.073, e 0.55) | 15.8 KB (30.8) | 0 | 5.0 (20.0) | 5.8 | 4.6 | 16,578 | 66,313 | 132,626 |

The rest of the caches is 0.4 KB a set. Each set also carries its drag-pass segments, 0.8 KB, in the set itself. The node
runs of a set above e 0.3 follow its long-period step (16.10). The THEMIS-like set steps 8.2 minutes, so it holds 351 nodes
of 160 B a day and 1,402 a week. A run holds at most the checkpoint span, 8 days or about 1,405 nodes (225 KB) a direction:
256 MB holds the week's caches of 1,129 such sets.

A catalog is flown object by object. At 10,000 low-orbit sets (500 km), measured per state at load 10 to 14:

| Pattern | 256 MB (the default) | All held (1 GB) | SGP4-XP |
| --- | --- | --- | --- |
| Object-major | 0.93 µs, 0.85 times SGP4-XP | 0.78 µs, 0.73 times | 1.09 µs |
| Time-major | 9.1 µs, 7.8 times | 2.25 µs, 1.9 times | 1.17 µs |

A caller that screens a catalog flies it object by object, or in blocks that fit the budget. The time-major pattern (every
set at each instant) is what display segments are for.

What the exact state costs a single record, against 0.6.12, flown back to back in a cleared slot (load 15 to 25). The
figures come from the minimum and the steady rounds: single-threaded rounds swung by up to 5 times on the shared
machine, so a median means little.

- The first state of a fresh record at 7 days is 25 to 28 % slower at 500 km and GEO (stack #439). Each node step
  evaluates node a's held rates (third body, drag, SRP, the zonal tail) again at the node's own state, which is what
  makes a step depend on its first node alone. Recovering it takes either carrying the held parts in each node (about
  7 KB more per set, node runs 2.5 times larger), or restructuring the step's last stage so the node's own evaluation is
  the one the next step holds fixed (a numerics change with its own accuracy check).
- The full `propagate` call (GCRF, 7 days at 300 s) of a record fitted with covariance is 11 % slower at 500 km and 15 % at
  GEO; a seeded record is equal at 500 km and 13 % slower at GEO. The integration of the nominal's nodes carries the node
  re-evaluation.

**The warm record's bakes (stack #441).** AP's compact tesseral cache reads block coefficients from the thread cache
when both hold the same grouping id. An atomic counter assigns each grouping its id before coefficients are written;
the compact copy preserves it. Otherwise a base bake rebuilds all block coefficients from the terms, and a resonant
bake rebuilds only resonant blocks. The pool charges `sizeof` for these structures. A thread cache matched by `sp_matches` (table pointer, count, tag,
a0, e0, and sentinel coefficients) is taken as the same table for grouping and coefficient reuse.

AP memoizes a, e, and cos i at the bracket's two nodes, keyed byte for byte on n, af, ag, chi, and psi at both nodes.
The memo belongs to the set while its cache lock is held, and to the thread otherwise. The propagation entry
clears the anchor; epoch calls clear it without consulting the memo. SGP4XP computes its anchor directly.

Inline tesseral and m-daily checks compare the bracket identity, first time, length, and each bake level's part key
before calling the synchronization routines. The checks use the same part-key expression as the bakes. The stored
part counts and keys follow the cache's existing lock ownership. These shortcuts reuse values without changing
arithmetic in the bakes or the returned states.


A warm record makes no bake when no bake key changes. Four alternating rounds comparing 0.6.50 with 0.6.51 give
the AP costs below, in microseconds per state, median [minimum, maximum], on identical saved fitted records over
seven days at normal priority. The one-minute load range was 16.50–17.41.

| Orbit | Spacing | 0.6.50 | 0.6.51 |
|---|---|---:|---:|
| 500 km | 60 s | 0.821 [0.812, 0.837] | 0.676 [0.658, 0.682] |
| 500 km | 300 s | 1.365 [1.359, 1.400] | 0.839 [0.827, 0.864] |
| 830 km | 60 s | 0.695 [0.694, 0.708] | 0.600 [0.587, 0.605] |
| 830 km | 300 s | 0.965 [0.949, 0.971] | 0.694 [0.689, 0.718] |

Test-build `sizeof` measurements against 0.6.50 give SetCaches 11,088 to 11,264 bytes (+176), MdailyEvalCache 4,704 to
4,736 (+32), SpEvalCache 1,376 to 1,424 (+48), and AnchorMemo 136 bytes. At 1,000 AP sets, store and pool accounting
measure 176 additional bytes per pooled set before flight and 224 after W5 (one day at 300 s). Thread-owned
structures add 216 bytes, excluding allocator and TLS alignment overhead; the instance's grouping counter adds
8 shared bytes. The 10,000-set / 256 MB figures above were not re-measured.

How room is shared:

- The pool's clock ticks at every ask for room. A holder's stamp is the clock when it was last flown.
- A set takes free room, or reclaims holders not flown since its own previous ask, least recently flown first, never
  one being flown. A first ask takes free room only.
- A steady cycle over more sets than fit therefore keeps its holders, and the other sets fly on the thread's caches.
  Holders no longer flown give way.
- A set refused room flies on the thread's caches at their cost. Its state is the same either way.
- A smaller budget reclaims at once.
- Each set's lock is taken once per state, without contention on one thread, and costs about 0.2 % of an AP state.

Memory per set flown and cost per pattern: README, Memory and time.

**AP one-day convergence.** The registered unfitted sets have epoch 2026-10-29 00:00 UTC,
n = 1.0027 rev/day, e = 0.0002, i = 0.1 or 15 degrees, node = 40 degrees, argument of perigee = 30 degrees,
M = 20 degrees, B = AGOM = 0 and FORCES (31,20). Against the same module with a 95/16-minute RK3 step,
the measured 3D differences on 2026-11-03 are:

| Inclination | Step (min) | Day 1 (m) | Day 3 (m) | Day 7 (m) |
|---|---:|---:|---:|---:|
| 0.1 degrees | 95 | 12.562 | 35.539 | 72.534 |
| 0.1 degrees | 38 | 0.852 | 2.205 | 4.591 |
| 15 degrees | 95 | 11.121 | 32.048 | 65.087 |
| 15 degrees | 38 | 0.780 | 1.970 | 4.140 |

The 47.5-minute candidate leaves 8.991 and 8.101 m at day 7; 38 minutes is the longest passing step in the
registered set {47.5, 38, 95/3}. A five-day flight of 241 states at 30-minute cadence, including public
`propagate` initialization and output, takes median 11.910 ms versus 10.514 ms at 95 minutes (1.133x),
over nine alternating calls after two warm-ups. These are same-machine synthetic timings, not the
archive fitting workload. Default-FORCES SGP4XP retains its bit-exact conformance digest.
`test/geo-step-convergence.e2e.mjs` asserts day-7 differences below 5 m for both sets and cost below 2x;
`test/results/geo-step-convergence.json` records the measurements.

**Step method.** One explicit Runge-Kutta step per node interval, of third order, with the rates at the start node
as the first stage (they are the node's stored rates). With y0 the start node, f the averaged-rate function, h the
step:

- k1 = f(t0, y0) (stored);
- k2 = f(t0 + (3/8) h, y0 + (3/8) h k1);
- k3 = f(t0 + (9/16) h, y0 + (9/16) h k2), an evaluation whose result does not enter the update;
- k4 = f(t0 + (25/32) h, y0 + h (-(125/672) k1 + (325/336) k2));
- y1 = y0 + h ((37/225) k1 + (44/117) k2 + (448/975) k4), and the new node's rates are f(t0 + h, y1), evaluated
  in the rate function's node mode (the same rates, plus node-only quantities such as the SRP set of section 4).

When the library's partials service is active, seven-element auxiliary integrals are also carried node to node by
the trapezoid rule and interpolated linearly; they do not feed back into the state *[study; probe 9.1]*.

The weights satisfy the order conditions through third order (sum b = 1, sum b c = 1/2, sum b c^2 = 1/3,
b4 a42 c2 = 1/6) and not the fourth (sum b c^3 = 0.2389). The decimal values are -0.18601190476190477,
0.96726190476190477, 0.16444444444444445, 0.37606837606837606, 0.45948717948717949 (study of the compiled library;
the rationals above reproduce them to the last digit). The k3 evaluation only refreshes auxiliary node quantities, which the k4 stage and the new
node's evaluation overwrite; omitting it leaves the state unchanged *[study]*.

**Step control.** No error estimate and no adaptive control *[study; probe 8.4, 8.5]*. Each rate evaluation of a step
(k2, k3 and k4, in that order, and the new node's) first tests the state it is given, converted to Keplerian
elements: an eccentricity above 1 fails with code 4, a mean motion zero or negative with code 9, and, with drag on,
1 - e^2 at or below 1e-12 with code 10. The k3 evaluation, whose rates do not enter the update, is tested like the
others. A NaN passes these tests (they are comparisons). When k2, k3 or k4 fails and the step is longer than
90 minutes, the step is redone once from the same node and rates with 90 minutes (same direction); the node then
lies 90 minutes on, and the step after it is the regular one again (two periods at that node's n). When the
90-minute step fails, or a shorter step fails, or the new node's own rates fail, the integration ends there (8,
Refusals). 9.9 has no further fallback: the 30-minute steps of the 9.1.1.0 build (section 11) are not reached in
9.9.

The step is fixed (95 min in the long-period regime, 38 min in AP's one-day class) with no error control. It resolves perigee
only for (1 - e)^(3/2) >= 2 pi h / P: e up to 0.44 at 95 min and 0.70 at 38 min on a one-day orbit. Beyond that the theory's
own equations are integrated with a mean-longitude error of 0.2 km a week at e 0.5 and 0.4 to 4.6 km a week at e 0.7 to 0.82 at
95 min, and 0.09 to 0.17 km at e 0.82 at 38 min. From 0.6.16 an AP set above e_0 0.3 takes the shorter step of 16.10.

**Output between nodes.** Cubic Hermite interpolation on the bracketing nodes (values and rates), with
q = (t - t_k) / (t_k+1 - t_k): y(t) = (1 + 2q)(1 - q)^2 y_k + q (1 - q)^2 h y'_k + q^2 (3 - 2q) y_k+1 +
q^2 (q - 1) h y'_k+1. If the interpolated mean motion is not positive, linear interpolation of all six elements is
used instead (the "mean motion check for XP interpolator", JIRA ASTROSTDS-1018) *[doc + probe 9.2]*. At a node the
node values are returned unchanged.

**After interpolation** (order of operations): equinoctial to Keplerian mean elements with angles reduced to
[0, 2 pi); Sun and Moon geometry at the output time (section 5); the output-time periodic terms and the
short-period terms (section 8); position and velocity (section 10). Failure codes: mean motion not positive,
eccentricity at or above 1, or an angle beyond 1e10 rad; a negative interpolated eccentricity is set to 0.

## 10. Frames and output

- Output frame: TEME (true equator, mean equinox of date), the same as legacy SGP4 (Vallado et al. 2006,
  section on TEME) *[probe 10.1: the oracle's 9.1.1.0 and 9.9 legs agree; library interface documents]*.
- Units: position km, velocity km/s, scaled with the EGM-96 R_E and k_e of 1.3 *[probe 10.1]*.
- The library also reports geodetic latitude, longitude and height (EGM-96 R_E and the flattening of 1.3, longitude
  from theta_G of 1.2), revolution number, nodal period, apogee and perigee, and the mean and osculating Keplerian
  elements (section 8) *[probe 10.1]*.
- Errors: a nonzero return code marks a refused or decayed propagation; the library tests the mean motion near
  decay before interpolating (JIRA ASTROSTDS-1018) *[doc]*. A mean perigee radius a (1 - e) below 1 R_E is flagged
  as decayed; a failed rate evaluation (for example a non-positive mean motion or e > 1 inside a stage) fails the
  step and triggers the fallbacks of section 9 *[study]*.

---

## 11. 9.1.1.0 (vendored WebAssembly) versus 9.9 (native)

From the JIRAs and release notes between 9.1 and 9.9 the XP-relevant changes are *[doc]*:

- 9.2: JPL Sun/Moon ephemerides made available to XP (used only when loaded; not by the oracle).
- 9.3: shadow quartic made safe for the cube root of a negative number; error handling for NaN cases.
- 9.6: errors from the rate evaluation propagated to its callers.
- 9.9: a new computation of the "G2 matrix" (Hoots) for XP. Probe 11.1 shows no change of the propagated state
  with SRP and drag off, consistent with it serving the differential correction's partials.
- Step control *[study; probe 8.5]*: the 9.1.1.0 driver carries a further fallback to 30-minute steps for a step
  that still fails after its 90-minute retry; in 9.9 that fallback is never reached and the integration ends there
  (9). Side B's sets 1786, 3850 and 7042 are refused after the epoch by both builds (9.1.1.0 with code 2).

The 9.1.1.0 WebAssembly build is a C translation of the 9.1 Fortran; its own release notes record XP mismatches
against the Fortran baseline traced to the SHADOW computation.

*[probe 11.1]* Over 50 XP element sets (LEO, sun-synchronous, MEO, GEO, HEO; to 14 days) the two legs agree to
2 micrometers in GEO, 0.1 m sun-synchronous, 2.1 m LEO, 3.7 m MEO and 15 m HEO. With AGOM set to zero the
differences fall below 1e-6 m in every regime, and for the MEO and LEO cases setting either AGOM or B to zero
removes them: the versions differ only in the non-gravitational (shadow-dependent) path. **This specification
follows 9.9.**

---

## 12. SGP4XP covariance (side B's method, outside the SGP4-XP specification)

This section is side B's own: it specifies how the module gives a covariance with the states of the sets it fits,
SGP4XP. Nothing in it comes from the Space Force library, and no SGP4XP conformance vector depends on it.

**12.1 Fit covariance.** The parameter vector p of a fit is the fit's own (`params_of`): the mean equinoctial af, ag,
chi, psi, lambda0 (rad), n (rad/min), then those of the drag term (BTERM; m^2/kg) and AGOM
(m^2/kg) the fit solved for, each as its natural log where its prior's form is LOG_NORMAL ($PCF FIT.DRAG_PRIOR_FORM,
SRP_PRIOR_FORM: the iteration steps in the log). At the solution (an SGP4XP set at its two-line digits, an AP set at full precision: 16.9), with the residuals e_k (model minus reference position, km, TEME) of the N fit states,

- J_k = d r_k / d p, every column the central difference of the theory itself (steps 1e-6 in af, ag, chi, psi and
  lambda0, 1e-7 n, max(1e-3 |p|, 1e-5) in BTERM and AGOM or their logs; AGOM forward where p - h <= 0,
  the theory reading AGOM <= 0 as no SRP (its log moves both ways); every moved set flies the set's own branch (16.7),
  never the branch its own elements would decide, here and in 12.3;
- sigma_d^2, the data variance per component. Above the drag, and under the drag on an arc of 71 h or more at or below
  e 0.3, it is the sigma_r^2 the fit itself weighted the data with (the fit's weighting, below); under drag on a
  shorter arc or above e 0.3 it is s^2 = sum |e_k|^2 / (3N - dim p), the post-fit residual variance;
- A = sum J_k^T J_k / sigma_d^2 + diag(1 / sigma^2) over the fit's priors (drag, AGOM: FIT.DRAG_PRIOR, FIT.SRP_PRIOR;
  under LOG_NORMAL sigma is that of the log). BTERM's prior, where FIT.DRAG_PRIOR is absent or without a sigma and
  FIT.DRAG_PRIOR_FORM is unset, is LOG_NORMAL with median 0.01 m^2/kg and sigma of the log ln 10, the prior of the free
  fits of experiments xp2-fit-design (1,214 windows, every one converged); AGOM's is GAUSSIAN_SIGNED with mean 0 and
  sigma 0.05 m^2/kg on an arc of 36 h or more and, on a shorter arc (the fit interval's first to last state), the
  Space Force wrapper's AGOM prior, GAUSSIAN_SIGNED 0 +- 0.1 m^2/kg (`propagator/sgp4-xp/src/fit.hpp`
  SGP4XP_PRIOR_SIGMA_AGOM); a FIT.SRP_PRIOR stated with its sigma holds on every arc. Both theories the fit solves
  (SGP4XP, and AP with its FORCES) take the rule. BTERM's prior keeps its form on short arcs: the wrapper's 0 +- 0.05
  moves no drag-free orbit and, below, ended at BTERM <= 0. A Gaussian on BTERM is stated by its mean and sigma
  (FIT.DRAG_PRIOR with HAS_SIGMA true): 0 +- 0.05 ended at BTERM <= 0, no drag at all, on the real ISS window of
  test/fit.e2e.mjs;
- P_p = A^-1; a term estimated as its log is carried back to m^2/kg by the Jacobian (the delta method): its rows and
  columns of P_p times the term, so sigma_B = B sigma_lnB. The $OBD gives the posterior sigma of the log and marks the
  term's covariance prior-limited when that passes 0.5 (the term effectively unobserved: the delta method then stands
  in poorly for a wide log-normal).

An AP set's radiation term Y0 (16.13), solved or held, is not in p: the moved sets fly the Y0 the set carries.

The fit's weighting *[2026-11-10, stack issue 324; real windows of experiments headline-loop]*. The fit minimizes

    Phi = sum |e_k|^2 / sigma_d^2 + ((x_B - mu_B) / s_B)^2 + ((x_S - mu_S) / s_S)^2

over p, x_B and x_S the drag and AGOM terms (or their logs) and mu, s their priors' means and sigmas; where the fit
solves an AP set's Y0 (16.13) the cost has one more such term, ((x_Y - mu_Y) / s_Y)^2. sigma_d depends on
the fitted set's regime (12.5: its perigee height against 2,500 km, above which the theory's density is 1e-20 kg/m^3,
3.3; one function, `cov::regime_of`, gives the regime the record states and the weighting):

- ABOVE (the perigee at or above 2,500 km, where drag acts nowhere on the orbit). The staged passes (two revolutions,
  the arc grown by threes, the whole arc with BTERM, then with AGOM) weigh at 1 km, which is enough to reach the basin.
  The whole-arc fit is then redone at the data's own sigma, sigma_r = max(s, the block's stated sigma, 1 mm), s the
  post-fit scatter of the pass before, and again until sigma_r is within 10 % of the sigma the pass weighted with (at
  most 8 passes). These passes take the theory's one-sided differences for the element and drag columns where no step
  along the analytic Jacobian lowers the cost, and stop when a step lowers Phi by less than 1e-6. The block's stated
  sigma is the root of the mean of (CX_X + CY_Y + CZ_Z) / 3 over its COVARIANCE_MATRIX_LINES, 0 when it has none. The
  covariance divides by the same sigma_r^2, so P_p is the inverse curvature of the cost the fit minimized: one weighting
  for the estimate and the covariance. A redone fit the theory refuses, or one that ends at a limit in n (16.7), leaves
  the pass before (the first leaves the 1 km fit, and the record says UNIT WEIGHTS); one held at an eccentricity switch
  (16.7) is kept.
- DRAG (the perigee below 2,500 km), an arc of 71 h or more (the fit interval's first to last state;
  `pcf::kDataSigmaUnderDragMinArcHours`) at or below e 0.3, the rule of 12.8's default of a 71 h arc: as above the
  drag, the whole-arc fit is redone at sigma_r and the covariance divides by the same sigma_r^2, so every prior acts at
  its written sigma in the estimate as in the covariance *[stack #489, #39]*.
- DRAG, a shorter arc, or a set above e 0.3 on any arc. The cost keeps sigma_d = 1 km, as in every version before, and
  the covariance divides by s^2: there the estimate and the covariance do not use one weighting, and each prior acts in
  the estimate as if its sigma were sigma_d / s times its written one (about 100 times, at s of 10 m) while the
  covariance states it at its written sigma. This is a stated limit, not the design (stack #489 stays open for these
  sets). On a short arc, weighed at its bare scatter, a 24 h arc lets BTERM and AGOM absorb the theory's own error, which
  under drag is correlated along the arc, not noise (below), and the band priors of 12.8 hold the term there only at
  1 km. Above e 0.3 the rule was measured on no real eccentric rows; on a first look, model truth, the data's own sigma
  moved the Molniya fixture of `test/heo-frame.e2e.mjs` 9.5 m worse at day 7 and the 7-day Molniya arc's day-7
  along-track 125 to 143 m, while its BTERM came from 6.12 to 4.98 of its stated sigma (#438). Arcs under 71 h and sets
  above e 0.3 are bit for bit those of the version before.

The iteration ceiling *[stack #479, #541]*. A pass ends when it converges: when a step lowers the cost by less than 1e-6
(a pass at the data's sigma, chi-square units) or by less than 1e-10 of it, or when no step lowers it. Otherwise it ends at
its ceiling: the record then states CONVERGED false in FIT_STATISTICS and, in the OD COMMENT, "fit: not converged; the last
pass ended at its ceiling of N iterations with the cost still falling", and `sdnap_fit_ceiling_met(reset, which)` counts the
pass (which 0: at 1,000; 1: at any other ceiling). The record states its last pass: an earlier pass that ends at its
ceiling is counted, not written. A fit that solves no drag term, the set above the drag (12.5) or a drag
term its prior holds (a sigma above 0 and at most 1e-6, of BTERM or of its log), has a ceiling of 1,000 iterations a pass.
A fit that solves a drag term keeps 40 a pass, as every version before: under the drag the cost is flat along the drag
term. Of nine real 72 h fits of the laser-ranged spheres that end at 40, the same fits run to convergence leave the fit
RMS unchanged to 0.1 m while BTERM falls by 1 to 63 %, and the forecast follows the point the iterations stop at: the
largest distance to the numerical forecast over five days is worse on 5 (by 2.7 to 26.6 m), better on 3 and unchanged on
1, and day 5 against the reference worse on 4 (by 2.2 to 18.0 m), better on 2 and unchanged on 1, with no day 5 on 2. On
model truth at 800 to 900 km (FFM 70 x 70, NRLMSISE-00 at constant weather, 72 h fits) the least-squares minimum along
BTERM lies 0.28 to 0.5 % off the truth's term, a 0.5 % move of BTERM changes the fit RMS by 3 to 60 mm of 13 m and day 7
by 25 to 70 m, and a fit stopped at its ceiling and one run to its minimum differ by tens of meters at day 7 (stack #541).
Neither is shown to be the better forecast, so the ceiling stays at 40, where the released figures were measured, until
#541 gives the drag term a determined minimum.

What a holder comparing record bytes sees: a record whose last pass ends at its ceiling now carries the OD COMMENT line
above, which no version before wrote. Under the drag such a fit keeps 40 and takes the arithmetic of the version before,
so its elements, statistics and flights are unchanged and its bytes differ by that line alone: on 0.6.41's table, nine of
the 78 72 h fits of the laser-ranged spheres and one 72 h fit near 700 km. No committed test reaches the line. From the
experiments repository, `node experiments/synthetic-orbits/run.mjs --modules-commit <commit> --modules-root <modules
checkout> --fit forecast-span --only grid-hp200-e0.3-i70` writes it: on 0.6.44 the row's record holds "fit: not converged;
the last pass ended at its ceiling of 40 iterations with the cost still falling".

Measured on the real windows above the drag with 400 iterations a pass in place of 40 (sdn-ap 0.6.41 otherwise): of 1,889
fits of the arc before the cutoff and 1,887 fits to the numerical forecast over 0 to 120 h (the long-period rows at 72,
168 and 336 h, medium Earth orbit, the geosynchronous rows), one ended at 40: a 336 h arc of a highly elliptical orbit,
89 iterations in all. It converges in 110, its largest distance to the numerical forecast over 0 to 120 h from 915.8 to
430.6 m and its error against the reference at day 5 from 5,352 to 4,959 m (the numerical propagator's own, 4,615 m).
Every other pass converged under 40 (the largest total 36 iterations), so it takes the same arithmetic under either
ceiling: those records are bit for bit those of the version before. A pass that does not converge above the drag is
bounded by nothing but its ceiling: it ends only by converging (no step lowering the cost among them), by a failed flight
of its starting set, or at 1,000, and a
fit runs at most a start on two revolutions, its staged arcs, the whole arc, the arc with AGOM and 8 passes at the data's
sigma. The longest fit above the drag measured is that 336 h arc: 61.5 s of fit at 40, 91.9 s run to convergence.

Why 1 km was wrong above the drag. Against residuals of 8 m the AGOM prior 0 +- 0.1 m^2/kg acts like 0 +- 0.0008: the
priors outweigh data good to meters. Measured on precise orbits, AP 0.6.9 against this rule (median 3D error against
the truth over the day ending at the lead, m; AGOM as a ratio to the radiation coefficient a numerical propagator's
sphere fits on the same arc, 5th percentile / median / 95th):

| Regime, fit arc | Windows | Day 1 | Day 3 | Day 5 | Day 7 | AGOM ratio |
| --- | --: | --: | --: | --: | --: | --- |
| Medium Earth orbit, 24 h | 254 | 23.8 > 7.1 | 71.2 > 17.1 | 121 > 33.4 | 170 > 56.2 | 0.63 / 0.85 / 0.91 > 0.95 / 1.01 / 1.06 |
| Medium Earth orbit, 72 h | 252 | 10.0 > 7.3 | 21.6 > 16.4 | 40.9 > 35.1 | 68.2 > 64.4 | 0.92 / 0.98 / 1.00 > 1.00 / 1.01 / 1.02 |
| Galileo, 24 h | 42 | 19.7 > 11.3 | 58.6 > 39.0 | 122 > 94.7 | 188 > 161 | 0.64 / 0.93 / 0.97 > 0.96 / 1.02 / 1.06 |
| Inclined geosynchronous, 72 h | 60 | 5.8 > 4.8 | 14.4 > 13.0 | 28.6 > 27.0 | 41.3 > 38.7 | 1.00 / 1.00 / 1.01 > 1.01 / 1.01 / 1.01 |

Why it is kept under drag. The same weighting flown on every regime (a build that redid the fit at sigma_r whatever the
regime) moved the laser-ranged spheres' 24 h fits from 20.8 / 51.6 / 144 / 233 m at days 1 / 3 / 5 / 7 to 24.4 / 106 /
298 / 561 m: BTERM over the numerical propagator's went from 0.02 / 0.17 / 0.80 to 0.00 / 0.11 / 10.3 and AGOM from 0.03
/ 0.40 / 1.63 to 0.47 / 6.8 / 41, while the fit RMS barely moved (Larets, 690 km: 24.8 to 22.0 m with BTERM 2.9 times
the numerical value and 59 m to 4,148 m at day 5). The record's own sigma of ln BTERM at that weighting was too small by
about 5 on 24 h arcs and 10 on 72 h arcs. On 72 h arcs the same build gained (spheres 129 to 86 m at day 5, altimetry
756 to 494 m), and on altimetry 24 h arcs too (1,757 to 758 m), there because BTERM left a band median 30 times below
those satellites' value: under drag one weighting does not serve the short arcs of both kinds of object.

Under drag at 71 h and up *[2026-11-11, stack #489, #39, #481, #482; the 72 h windows of experiments headline-loop's
low-orbit rows]*. Against the numerical propagator's forecast of the same window (D5, the RMS of the 3D distance over the
24 h ending at day 5), this rule with 12.8's default of a 71 h arc, against that default weighed at 1 km: laser-ranged
spheres 48 of 56 windows under 100 m (median 45.6 m) against 49 (54.3 m); altimetry 105 of 112 (32.8 m) against 99
(50.3 m); Near 700 km 50 of 69 (52.3 m) against 50 (58.8 m); LARES 17.0 m. The free band's prior at the population's
median and spread of ln B per band (600 to 800, 800 to 1,400 and 1,400 to 2,500 km), in place of 12.8's, was measured
and lost five altimetry windows (100 against 105), in-sample. On the 800 km sphere of `test/radiation-sphere-agom.e2e.mjs` (AGOM 0.01
m^2/kg in a conical shadow, BTERM held at 0) AGOM lands at 0.937 of the truth, 0.98 of its stated sigma, against 0.356
at 9.9 at 1 km (`test/radiation-sphere-agom.e2e.mjs`). `test/fit-cost-curvature.e2e.mjs` holds the rule: the profile
of the cost the fit minimized in one parameter, the others refitted, against the record's variance of it, for BTERM on
the 71 h default (ratio 1.0001) and for AGOM on the case 7 sphere (0.9998).

A maneuvering object. On a 72 h arc of a satellite that keeps its orbit with burns, the free drag term takes the thrust in or near the
arc into itself, as the numerical propagator's does, and the forecast lands on the numerical propagator's rather than on the orbit. On
the Near 700 km row's 72 h windows against the precise orbits, paired against the version before, this rule alone was worse on 102 and
better on 50 (stack #489). The scoreboard therefore fits such an object on the arc after its last burn known at the cutoff, 24 to 70 h, so
under the short-arc rule (experiments headline-loop, `MANEUVER72`: perigee 600 km or above, a burn ending within 7 days before the
cutoff). With that fit process the same windows are better on 75 and worse on 58, with a median paired change of -15.8 m.
`test/fit-data-sigma.e2e.mjs` holds the rule on model truth: above the drag AGOM is recovered to 0.1 % and, with a
stated sigma, pulled toward its prior by exactly what the record's covariance implies; the 2,400 km and 2,600 km sets
fall on either side of the line.

Known limit of BTERM's default start *[study 2026-10-31, noise-free synthetic tracks]*. The fit starts at the prior's
median, 0.01 m^2/kg, and an object whose B lies far below it can stop in a local minimum. A day of an SGP4XP set's own
states at 60 s (e 0.0003, i 51.6 deg, AGOM 0.01 m^2/kg; n 15.5, 15.2 and 14.9 rev/day for 400, 500 and 600 km), fitted
back: B of 0.0005 to 0.002 m^2/kg at 400 km and 0.0005 to 0.004 at 500 and 600 km end at a fit RMS of 4.0 to 14.7 m,
against 0.96 to 1.19 m from the former default's start at no drag; B of 0.01 and above recovers to about 1 m at 400 and
500 km. A caller that knows its object's B states a LOG_NORMAL median near it. On 94 real ISS windows (NASA's daily
files, every eighth from 2020-09-10 to 2026-10-13, the first 24 h of each) the former default ended at BTERM <= 0 on 42
(median fit RMS 472 m) and this one on none (457 m; lower on 65, never more than 5 % higher).

Short-arc AGOM prior *[exploratory, 2026-11-03: the AP5 GNSS windows of the 2026-11-03 gap diagnosis, already read]*.
On 748 windows of five GNSS satellites (24 h arcs, 2026-01-01 to 2026-05-31, leads from the fit end), the median paired
day-3 error of SGP4XP minus the Space Force library's fitted SGP4-XP falls from +56.107 m to -4.097 m (medians 211.8
and 152.3 m against the library's 149.4 m); the wrapper's two prior constants stated in $PCF FIT give -4.097 m, within
0.001 m of the AGOM prior alone. On 746 windows of 72 h arcs the errors are unchanged (median paired change 0.000 m at
days 1, 3 and 7). `test/fit-short-arc-priors.e2e.mjs` prints both; unread-window confirmation is separate. From 0.6.13
these fits, above the drag, are weighted at the data's own sigma (the fit's weighting, above), SGP4XP's as AP's: on the
same windows SGP4XP's 24 h median day-3 error is 145.75 m against 0.6.11's 152.29 m (median paired change -18.61 m, 427
of 748 windows better), and its paired difference from the Space Force library is -1.752 m: every satellite's fit
moves toward the library's. One loses: GPS IIF 41019, day 3 114.7 to 155.5 m and day 7 265.9 to 366.7 m, worse on 149
of 150 windows, its freed AGOM 0.0293 m^2/kg against 0.0257 at 1 km and 0.0244 from its 72 h fits (SGP4XP's own
error on a 24 h arc taken up by AGOM). The 72 h fits move -0.53 / -0.93 / -2.29 m at days 1, 3 and 7.

**12.2 Epoch covariance and its record.** With J_0 = d x(0) / d p (x the TEME state, km, km/s), F(x) the theory floor
(12.4) at a state x, and x_F the state the epoch floor is taken at (12.4: from 0.6.39 the two-body state of an AP record's
mean elements; x(0), the theory's epoch state, for an SGP4XP record), the $OMM carries

- COVARIANCE = J_0 P_p J_0^T + F(x_F), lower triangle (21 values, km^2, km^2/s, km^2/s^2), COV_REFERENCE_FRAME TEME;
- USER_DEFINED_SDNAP_COV_DRAG, _AGOM (those fitted, in that order): for the k-th of them the
  space-separated row of its covariance with X, Y, Z, X_DOT, Y_DOT, Z_DOT at epoch (J_0 P_p), with the earlier ones,
  then its variance (6 + k + 1 numbers);
- USER_DEFINED_SDNAP_COV_FLOOR_UVW (6 numbers, km^2: uu, vu, vv, wu, wv, ww; the floor F of 12.4, k_F of 12.5 applied), _COV_NOISE (12.5), _COV_NG_RATE (1/day)
  and _COV_REGIME (DRAG or ABOVE).

**12.3 Propagation.** A set is read back as the augmented epoch covariance C (state block COVARIANCE - F(x_F), at the
state the writer took it at, 12.4; consider rows as written). The columns J_0 = [J_x J_c] (elements, consider) give the parameters of a state:
T = [[J_x^-1, -J_x^-1 J_c], [0, I]], P_p = T C T^T. At t minutes from the epoch, J(t) = d x(t) / d p by the same
central differences and

P(t) = J(t) P_p J(t)^T + Q(t) + F(x(t)).

The state transition matrix is J(t) T; at t = 0 it is [I 0], so P(0) = COVARIANCE - F(x_F) + F(x(0)): COVARIANCE itself for
an SGP4XP record. For an AP record the two floors differ by the theory's short-period terms between the two-body and the
flown state, about 1e-3 rad of axis and 2e-3 of the angular rate squared: on the seven cases of 12.4's measurement, P(0)
differs from COVARIANCE by up to 0.6 % of a variance on its diagonal, 3.7 mm and 0.037 mm/s in sigma.

J, here and in 12.1, is made of differences of sets each flown on its own. Every moved set evaluates its rates and
its output at its own state, as any set does. A record's covariance is then a function of the record and the time
alone: it does not depend on the order in which times are asked, or on which records the thread flew before it.

Through 0.6.22 this did not hold (stack #491):
- The moved sets took the nominal's stage parts from the thread's cache, plus their own differences held over four
  steps. In the long-period regime they stepped in pairs.
- At t = 0 the short-period terms were baked on the last set's bracket.
- The third body's bracket tables read rows the last set had left (stack #475).

The figures through 0.6.22 (measured on 0.6.20 and 0.6.21), against each record alone in a fresh instance:
- A record whose covariance was prepared after a record of another orbit had been flown inside its first grid step was
  off by up to 440 times: a made-up 500 km record, 364,849 m against 805 m at hour 1; on real records, CryoSat-2 after
  Ajisai, 336,299 m against 992 m.
- Asked in turn with nine other records, the one-day class at 0.9 rev/day differed by up to 21 % of its day-7 position
  sigma.
- Flown alone, the one-day class was 5 % from its moved sets flown on their own, LEO up to 7e-4.

**12.4 Theory floor.** F is the fit's residual covariance in the UVW axes of the state (U radial, V in-track, W along
r x v), R = (1/N) sum u_k u_k^T, u_k the residual e_k in the UVW axes of the model state at t_k; position block
R in TEME axes, velocity block w^2 R (w = |r x v| / |r|^2), no position-velocity block, times the regime's k_F (12.5).
It is the part of the error a mean-element theory leaves at every time (short-period terms it does not carry) and does
not shrink with N.

*Where the epoch covariance carries it* (from 0.6.39; stack #551). The record's COVARIANCE_DATA includes F at epoch; a
reader takes it off before mapping the epoch covariance onto the parameters, and adds it at every time at the flown
state. What the subtraction leaves is a small part of the total (4.9e-4 of it in along-track velocity on the stored
fixture's 550 km fit, far less on a fit to a numerical forecast), so the reader must take off exactly what the writer put
on. For an AP record (MEAN_ELEMENT_THEORY AP, with gravity terms or without: one rule read from the record alone, the
same in the writer, the reader and the gate) both take F at one state: the two-body state of the record's own mean
elements (TEME; mu and the radius of 1.3, a = (k_e / n)^(2/3), no recovery), a fixed formula on the record's written
numbers. That formula (twobody::state_of) must never change: `test/epoch-floor.e2e.mjs` holds its state for three element
sets bit for bit. A change to the theory's epoch state between the writer and the reader then moves nothing the reader
takes off: read with its gravity caps moved, so that its flown epoch state moves (31 m at 550 km and i 52.9), a record's
remainder is the same bit for bit as computed from the record, and the reader's P(0) agrees with it within 1e-12 of its
largest entry. A set written and flown by one build flies as before (to 1e-11 of a time's largest
entry on the test's cases). An SGP4XP record's F stays at its theory's epoch state, which conformance holds bit for bit.
Through 0.6.38 an AP record's F was taken at the theory's epoch state on both sides; a reader whose theory has moved then
takes off another F. Read by a later theory, 0.6.36's own records came out up to 85 times narrower in along-track
variance at the arc's end, or negative (300 km, i 5 deg), or wider (550 km, i 52.9). So an AP record whose
PROVENANCE.PRODUCER is not exactly "com.spacedatanetwork.sdn-ap-propagator X.Y.Z" (three decimal integers, nothing after
them) with X.Y.Z at 0.6.39 or later has its covariance refused by name, cov-floor-at-theory-state; its states fly. propagate writes such a block without
covariance lines, its COMMENT naming the refusal; load_epochs keeps the set without its covariance; sdnap_covariance_at
returns -7. Fitted again, the set carries its covariance.

*A record is read by the build that wrote it or a later one* (stack #562). Read by an earlier build, nothing is promised.
From 0.6.39 on, its covariance is wrong there and is not refused: an earlier build takes the floor off at its own theory
state from a record that carries it at the two-body state. On 0.6.39's records fitted to zero residual and flown by 0.6.37,
the along-track variance at 24 h (the arc's end) against 0.6.39's own flight:

| Case | 300 km, i 5 | 300 km, i 28.5 | 300 km, i 90 | 420 km, i 97 | 550 km, i 52.9 | 700 km, i 63.4 | 1,200 km, i 0.5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Along-track variance, times 0.6.39's | -538 | -273 | +269 | +235 | -12.2 | +81.7 | -268 |

At 48 h the process noise dominates; the 700 km case is still 45 % wide. The builds this reaches are 0.6.36 to 0.6.38,
none released, and the released 0.6.34, which cannot fly a 0.6.36 record's states rightly either (it flies them on
EGM-96).

**12.5 Process noise.** What a mean-element theory gets wrong over days are its element rates. From the end of the
fit arc t_a (minutes from the epoch; from the epoch backward for t < 0) the rates carry errors constant over
the prediction, with d = (t - t_a) / 1 day:

- eccentricity vector: d af, d ag = s_e d each (independent);
- inclination vector: d chi, d psi = s_i d each;
- mean longitude: d lambda = s_l n_d d (s_l a relative mean-motion error, n_d in rad/day);
- non-gravitational n-dot (drag regime): d n(t) = s_d d, d lambda(t) = s_d d^2 / 2, taken as the epoch perturbation
  that gives them at t: d n0 = d n(t), d lambda0 = d lambda(t) - t d n0; s_d = c |n-dot_ng| (rad/day^2), n-dot_ng the
  non-gravitational part of the theory's epoch n-dot (its rates with and without BTERM; USER_DEFINED_SDNAP_COV_NG_RATE
  = n-dot_ng / n per day).

Each is a column g = J(t) dp of 12.3's J(t), and Q(t) = sum g g^T. Q(t) is an epoch-element perturbation of size s d mapped by
the columns from the epoch; its node-coupled part depends on the arc length and on where the epoch is placed (8 times a rate
error from the arc's end, for a 72 h arc at a 24 h lead). The sizes below belong to their arcs: the SGP4XP rows to 24 h
fits; the SDNAP DRAG row to 24 h and 17 h arcs in strong drag and 72 h and 24 h arcs near 700 km. The set carries its sizes and t_a as
USER_DEFINED_SDNAP_COV_NOISE "s_e s_i s_l s_d t_a". They are fitted per regime (DRAG: perigee below
2500 km; ABOVE) by maximum likelihood, the Gaussian negative log-likelihood of the
position errors under P(t), on laser-ranged arcs of 2026-02-01 to 2026-05-31 (Ajisai, Starlette, Stella, LARETS,
WESTPAC, LARES in DRAG; LARES-2, LAGEOS-2, Etalon-1, Etalon-2 ABOVE; LAGEOS-1 never: it is held out), 24 h fits
scored every 30 min over the next 3 days (`test/covariance-realism.mjs --set calibration`,
`test/results/covariance-calibration-*.json`):

| Theory | Regime | Windows | s_e (1/day) | s_i (1/day) | s_l | c |
| --- | --- | --: | --: | --: | --: | --: |
| SGP4XP | DRAG | 136 | 2.813e-6 | 7.432e-6 | 8.505e-7 | 1.275e-6 |
| SGP4XP | ABOVE | 62 | 2.308e-7 | 3.752e-7 | 2.666e-7 | 0 |

These sizes, and the cells of 12.7, were measured on 2026-10-25 (module SHA-256 1f66e6fdf443 and f20f5a059b76) with
`fit`'s former default prior on BTERM, GAUSSIAN_SIGNED 0 +- 0.05, and were not re-measured under the LOG_NORMAL default
of 0.2.0.

SDNAP uses its own table when FORCES requests AP gravity terms; each row also scales the floor of 12.4 by k_F (the
floor the set carries in COV_PROPAGATION and adds at every time, epoch included; 1 for SGP4XP and for ABOVE).

| Theory | Regime | s_e (1/day) | s_i (1/day) | s_l | c | k_F |
| --- | --- | --: | --: | --: | --: | --: |
| SDNAP | DRAG | 1.8579913326733934e-07 | 1.12761105007012e-06 | 7.647194501793458e-07 | 0.112126311682426 | 1.5127596877626373 |
| SDNAP | ABOVE | 9.6961538661171821e-07 | 8.1531127919544734e-07 | 4.753573962018311e-06 | 0 | 1 |

The DRAG row (0.6.1, 2026-11-05) is fitted per axis. Per radial, in-track and cross-track axis (RIC, the truth's
axes) z = e / sigma, the forward error component over the propagated 1-sigma; calibrated, median |z| = 0.674, and the
band [0.603, 0.754] is the one-axis image of 12.7's (0.674 x sqrt of [0.8, 1.25]). The loss is, per regime, the mean
over R, I, C and lead hours 1 to 167 of (ln(median |z| / 0.674))^2, the regimes averaged; s_e, s_i, s_l, c and k_F
are solved jointly by Nelder-Mead on their logs from four starts. The windows are 0.6.0's flights of the coverage
study (experiments COVARIANCE-COVERAGE.md and COVARIANCE-REFIT.md): strong drag (Swarm A, B, C, GRACE-FO 1, 2; 24 h
and 17 h held-B arcs) and near 700 km (Sentinel-1A, 1C; 72 h and 24 h arcs), split by cutoff with a 10-day guard:
training 2025-04-01 to 08-10 and 2026-01-01 to 03-15, held out 2025-08-21 to 12-21 and 2026-03-26 to 05-31. P(t) is
linear in each squared size and the floor adds, so the fit re-weights the module's own per-term variances; no orbit is
re-fitted. The ABOVE row is the 2026-11-03 minimax row (the worst violation of 12.7's mean band across days 1, 2, 3
and 7 on `operator-theory/ap/b040`), unchanged; above the drag a class with a fitted row replaces it inside that
row's calibrated condition (below, "Above the drag, by class").

Realism is not met, and the covariance is not calibrated (12.7). At the row's fit (0.6.1), on the held-out windows of 0.6.0's
flights re-weighted with the row, the median |z| of 8 of the 18 cells (two regimes, three axes, days 1, 3 and 7) is inside
the band, against 1 for 0.6.0, whose DRAG row (s_e 0.0030020720101006817, s_i 1.3729304605949328e-06, s_l
0.00022005794330391744, c 0.52454406174861778) gave a 1-sigma 274 to 530 times too wide in-track and about 1,000 to
7,600 times radially at day 1. The worst held-out |ln(median |z| / 0.674)| goes from 8.77 to 0.74. Median |z|, 0.6.0
to 0.6.1:

| Regime | Day | R | I | C |
| --- | --: | --- | --- | --- |
| Strong drag | 1 | 5.77e-4 to 0.635 | 2.03e-3 to 0.468 | 0.678 to 0.781 |
| Strong drag | 3 | 3.29e-4 to 0.745 | 5.94e-3 to 0.679 | 0.579 to 0.874 |
| Strong drag | 7 | 3.24e-4 to 0.754 | 0.016 to 0.910 | 0.491 to 0.794 |
| Near 700 km | 1 | 4.38e-4 to 0.638 | 1.07e-3 to 0.322 | 0.385 to 0.660 |
| Near 700 km | 3 | 1.50e-4 to 0.638 | 1.63e-3 to 0.487 | 0.207 to 0.560 |
| Near 700 km | 7 | 1.05e-4 to 0.852 | 2.28e-3 to 0.674 | 0.116 to 0.380 |

On 0.6.1, strong-drag cross-track is overconfident at days 1 and 3 (0.78 to 0.87; 0.6.0 was inside or wide there), and
near 700 km in-track at day 1 and cross-track at day 7 are too wide (0.32, 0.38). The limit is the form of the noise,
not its sizes: wherever the strong-drag cross-track median at day 7 is inside the band, the near-700 km one is 0.17 to
0.32, for every s_i and k_F; a row per regime, or a cross-track size growing with the non-gravitational rate, still
leaves held-out cells outside. On the demo's ISS sample the in-track 1-sigma 12 h from the file's start is 0.147 km on
0.6.1 (0.6.0: 37.78 km) against the error 0.308 km.

These 18 cells set 0.6.0's errors against a build's variances, so they judge one build's covariance on another build's
orbits: on 0.6.42 the same re-weighting reads 3 of the 18 inside the band, the radial up to 1.084. From 0.6.42
`test/covariance-realism.e2e.mjs` judges the build's own flights instead (below): each judged cell's median |z| and its
shares within 1 and 3 sigma, and the ISS figure on the built module.

The low table's fast side (16.1, stack #477; from 0.6.42). The floor is the fit's own residual covariance (12.4), so a theory
that fits its arc better states a smaller uncertainty. Measured on each build's own flights (748 windows of the low table:
strong drag 2025 and 2026, laser spheres, burn-free altimetry, near 700 km; records at 31/20), the fast side takes the fit's
RMS to 0.71 of what it was and the floor's sigma to 0.90 radially, 0.61 in-track and 0.77 cross-track.
- Radially, an AP set in the low table in the DRAG regime whose record states a tesseral degree above 12 takes its floor's
  sigma times kFloorRadialFastSide, exp(0.095) = 1.0997 (the floor's UU times 1.209, VU and WU times 1.0997). It is the
  maximum-likelihood fit (steps of 0.005 in its logarithm) of the radial |z| on 326 choice windows of 0.6.42's own flights
  of records at tesseral 31 / zonal 70 (the low table's records from 0.6.42) with the factor off, judged on the other 422
  (the split rule's SHA-256 d3177de7). Judged, median |z| with the factor off and with it:

  | Row | Day 1 | Day 3 | Day 5 | Day 7 |
  | --- | --- | --- | --- | --- |
  | Strong drag 2026 | 0.72 to 0.66 | 0.79 to 0.75 | 0.81 to 0.79 | 0.78 to 0.77 |
  | Near 700 km | 0.754 to 0.69 | 0.76 to 0.70 | | |
  | Laser spheres | 0.70 to 0.64 | 0.61 to 0.57 | 0.53 to 0.50 | 0.46 to 0.44 |
  | Altimetry | 0.71 to 0.65 | 0.64 to 0.597 | 0.62 to 0.58 | 0.64 to 0.606 |

  Its cost is the laser spheres' and altimetry's radial, wide from day 3, getting wider. One factor, not a size by regime:
  a size by regime is the covariance study's (stack #531).
- Against the records before 0.6.42 (0.6.39 at 31/20), on the 54 judged cells of days 1, 2, 3, 5 and 7: 11 inside the band
  then, 12 now. Two of 0.6.39's inside cells leave it, altimetry radial at days 3 and 5 (0.636 to 0.597, 0.642 to 0.583, too
  wide). Three too-narrow cells get narrower, strong drag 2026 in-track at days 1 to 3 (0.832 to 0.864, 0.900 to 0.928,
  0.883 to 0.896): the floor is 0 to 3 % of in-track, so no floor factor moves them; they are the density forecast's
  (stack #527).
- Cross-track takes no factor. On records at zonal degree 20 its strong-drag cells are too narrow (2026, days 1 to 7: 1.045
  to 1.317 on 0.6.39, 1.5 to 2 times too narrow; day 1 1.303 on 0.6.42's fit at 31/20): the node drift of such a record, the
  zonal terms of degree 21 to 70 that it leaves out (about 12 m of cross-track a day at 440 km, i 88; stack #531). A record at
  zonal degree 70 has no drift, and there the stated cross-track is too wide: in strong drag 2026 0.40 at day 1 to 0.12 at
  day 7, about 2 to 5 times too wide, a loss of realism in size where it was 1.5 to 2 times too narrow; elsewhere 0.55 to
  0.60 at day 1 and 0.08 to 0.26 from day 3 (0.6.42). The sizes s_i are set on records at zonal degree 20 (stack #531).
- The DRAG row's s_i at zonal degree 70 (from 0.6.45, stack #531). An AP record in the DRAG regime whose stated zonal degree
  (PERTURBATIONS.MAXIMUM_ZONAL_DEGREE, the fit's FORCES.MAXIMUM_DEGREE) is 70 writes s_i times kSiZonal70, exp(-2.2) =
  0.1108: 1.2494e-7 per day against 1.1276e-6. The row's s_e and s_l are the row's, and a record at any other zonal
  degree writes the row's s_i as it is, bit for bit (its drag share is the next rule's). A record at a zonal degree from
  21 to 69 keeps the full s_i on purpose: the factor was fitted on records at 70 alone, and a record below 70 still leaves
  out the drift of the zonal degrees above its own. The record states the s_i it was fitted with, so a record written
  before this rule flies as it was. The factor acts on every AP record in the DRAG regime at zonal degree 70 and is fitted
  and judged on the low table's records only: an eccentric record with its perigee under 2,500 km takes it unjudged.
  - The factor is the maximum-likelihood fit of the cross-track |z| (days 1, 2, 3, 5 and 7) on the split rule's 326 choice
    windows of 0.6.42's own flights of records at 31/70 (strong drag 2025, laser spheres, altimetry), on a grid of 0.005 in
    its logarithm. It is judged on the other 422 (strong drag 2026 and near 700 km entirely, laser spheres and altimetry).
  - Judged, cross-track: 1 of 18 cells inside the band on 0.6.42, 12 of 18 with the factor, none too narrow. On the 14 the test
    holds (days 1, 3, 5, 7): 1 to 9. Strong drag 2026 goes 0.40, 0.16, 0.13 and 0.12 to 0.54, 0.61, 0.70 and 0.75 at days 1,
    3, 5 and 7. Radial and in-track move by at most 1.9e-4 in median |z|, none at three decimals.
  - Still too wide: strong drag 2026 at day 1 (0.54) and the laser spheres and altimetry at days 5 and 7 (0.53 to 0.58).
- The DRAG row's drag share on strong drag (from 0.6.45, stack #568). An AP set in the DRAG regime of the low table's fast side
  (a record at a tesseral degree above 12) writes the share c times 1 + (kDragShareStrong - 1) S(|r|), kDragShareStrong =
  exp(0.150) = 1.1618, with r its own stated drag rate (COV_PROPAGATION.NON_GRAVITATIONAL_RATE_PER_DAY, the fit's n-dot / n
  from its drag term at the epoch's weather). S is a cos^2 step in log10 |r| centered on 1.35e-6 per day with a half-width of
  0.25 decade: 0 at or below 7.59e-7, 1 at or above 2.41e-6. The record states the share it was written with
  (NON_GRAVITATIONAL_SHARE), so a reader takes it from the record and a record written before this rule flies as it was.
  - The key and the step were fixed from the keys alone, before any fit. Over the registered 748 windows the weak-drag
    records (laser spheres, altimetry, near 700 km) state at most 6.94e-7 per day and the strong-drag records at least
    2.61e-6. The step's midpoint is the gap's geometric center and its slope lies inside the gap, so no window of the set is
    on it and no weak-drag record of the set changes. Between 7.59e-7 and 2.41e-6 the share is an interpolation no window
    has measured.
  - The factor is the maximum-likelihood fit of the radial and in-track |z| (days 1, 2, 3, 5 and 7) on the 236 strong-drag
    2025 choice windows of 0.6.43's own flights of records at 31/70, with s_i times kSiZonal70, on a grid of 0.005 in its
    logarithm. It is judged on strong drag 2026. No factor was moved after the judged cells were read.
  - Judged, strong drag 2026, median |z| at days 1, 3, 5 and 7: radial 0.677, 0.828, 0.845 and 0.806 on 0.6.43 to 0.666,
    0.754, 0.754 and 0.712 (0.6.42: 0.660, 0.748, 0.788, 0.770); in-track 0.862, 0.902, 0.908 and 0.893 to 0.831, 0.797,
    0.792 and 0.774 (0.6.42: 0.864, 0.896, 0.906, 0.894). Every radial cell is inside the band; day 3's is 0.006 above
    0.6.42's. In-track is still too narrow at every lead, by less: a strong-drag record still understates its in-track
    uncertainty.
  - Not used. A radial floor factor fitted with it for strong drag (the floor's sigma times 1.246 there, the share times
    1.133) takes strong drag 2026's day-1 radial out of the band on the wide side (0.600): it buys days 3 to 7 through the
    floor, and on its own choice windows makes day 1 0.478. A share keyed on the record's own weather (the Ap of the day
    before the cutoff its $SPW rows state, a cos^2 step from 12 to 18; 1.094 quiet and 1.228 in storms) fits 2025 better
    (the log-likelihood by 277 with the floor factor) and beats the single factor on no judged cell of 2026.
  - The weak-drag side keeps the radial floor factor exp(0.095), though the cells that left the band on the wide side with
    0.6.43 (laser spheres and altimetry at day 1, altimetry at day 7, near 700 km at day 1) ask for a factor of about 0.8
    on the floor's sigma: at that factor near 700 km's radial at
    days 2 and 3 leaves the band on the narrow side (0.850 and 0.919), the fault of its 24-hour fits, whose error grows 1.5 m
    a day against the 0.5 m a day they state (stack #568).
- In-track takes no factor of its own: the floor is not what sets it.
- Cells outside the band at the factors, by cause (`test/covariance-realism.e2e.mjs` names each; 28 of the 42 it holds, 14
  inside): strong drag 2026 in-track at every day, too narrow (the drag share against the 2026 storms, and the density
  forecast; stacks #568, #527); radial of the laser spheres and altimetry at every day and of near 700 km at day 1, too
  wide (one radial floor factor serves them with strong drag; the weak-drag factor waits on the 24-hour fits' drag term,
  stacks #568, #489); in-track of the laser spheres, altimetry and near 700 km at every day, too wide (the sizes are set
  on strong drag); cross-track of strong drag 2026 at day 1 and of the laser spheres and altimetry at days 5 and 7, too
  wide (one s_i factor serves every low row).

Above the drag, by class *[2026-11-11, stack #433; experiments headline-loop, sdn-ap 0.6.15]*. Measured on every
first-pass window whose fitted set is above the drag (923 window-arcs per theory), the ABOVE row is too wide on
near-circular orbits, 5 to 1,000 times: median |z| 0.001 to 0.15 on laser geodetic, medium Earth orbit, Galileo,
inclined geosynchronous and geostationary, in track 0.001 to 0.02. It is too narrow on TESS, Chandra and commercial
geostationary, whose truth carries burns (stack #444). A set above the drag therefore takes a row by class, decided by
its own elements: HEO above e 0.3 (from 0.6.40 strictly above, as the theory's switches, so a set at exactly 0.3 is
the below side's in class as in theory; through 0.6.39 at 0.3 or more); otherwise geosynchronous under 1.5 rev/day,
medium Earth orbit under 4 rev/day (GNSS, Etalon), and the LAGEOS class above (LAGEOS, LARES-2).

- The class's row applies only inside its calibrated condition: the data sigma the fit weighted with (12.1) and the
  fit's span within those of the calibration fits. Outside it, and in a class without a fitted row, the ABOVE row
  stands. A record fitted to worse data than the calibration fits, or over another span, is not made narrower without
  measured error behind it.
- s_d above the drag is k |AGOM| / a (rad/day^2; AGOM in m^2/kg, a in Earth radii): the unmodeled force above the drag
  is radiation pressure, which scales with the object's area to mass, so the form carries to objects with other
  area-to-mass ratios. One k serves the LAGEOS, medium Earth orbit and geosynchronous classes as well as a constant per
  class (training losses with the one k against per class: LAGEOS 0.0678 against 0.0677, medium Earth orbit 0.0460
  against 0.0458, geosynchronous 0.1242 against 0.1237). It does not explain Galileo: per satellite, AP's 72 h in-track
  error at day 7 runs from 35 m (GPS IIF) to 492 m (Galileo FOC 15), while AGOM spans only 0.022 to 0.033 m^2/kg.
- The record states the sizes in COV_PROPAGATION as before. Above the drag NON_GRAVITATIONAL_SHARE is 0 and
  NOISE_NON_GRAVITATIONAL_RAD_DAY2 is the record's own statement; the read refuses only a negative or non-finite one
  there. Under the drag the invariant s_d = c |n-dot_ng| n stands.

| Theory | Class | s_e (1/day) | s_i (1/day) | s_l | k | data sigma (km) | span (h) |
| --- | --- | --: | --: | --: | --: | --- | --- |
| SDNAP | LAGEOS | 1.1374623058968726e-08 | 8.083584088270014e-08 | 3.831472309446551e-09 | 1.415e-05 | 0.00243 to 0.00276 | 64.8 to 75.6 |
| SGP4XP | LAGEOS | 2.463673468245377e-07 | 6.564224575525169e-07 | 5.502200043625398e-08 | 3.216e-05 | 0.0588 to 0.0769 | 64.8 to 75.6 |

Acceptance (per regime, fit arc and axis at days 1, 3, 5 and 7, scored against the precise orbits). The count of |z|
above 3 must be at most max(as built, ceil(1 % of the windows), 1). The count inside the 95 % region must not be
significantly below 95 % (one-sided binomial test at 5 %: 28 of 32), nor below the as-built count where that is
already under it. A class whose row fails any cell keeps the ABOVE row. The LAGEOS rows are fitted so that every
regime's 99th percentile of |z| is at most 2.9, on all 32 windows of LAGEOS-1, LAGEOS-2 and LARES-2 (72 h fits), and
they hold leaving each satellite out in turn. The module's own covariance, flown, ABOVE row > LAGEOS row:

| Theory | Day | Windows | median abs(z) R / T / N | abs(z) > 3 R / T / N | 95 % coverage |
| --- | --: | --: | --- | --- | --- |
| SDNAP | 1 | 32 | 0.126 / 0.001 / 0.242 > 1.035 / 0.652 / 0.729 | 0 / 0 / 0 > 0 / 1 / 0 | 1.00 > 0.88 |
| SDNAP | 3 | 32 | 0.042 / 0.001 / 0.094 > 0.951 / 0.832 / 0.670 | 0 / 0 / 0 > 0 / 0 / 0 | 1.00 > 0.94 |
| SDNAP | 5 | 31 | 0.017 / 0.000 / 0.074 > 0.585 / 0.520 / 0.569 | 0 / 0 / 0 > 0 / 0 / 1 | 1.00 > 0.90 |
| SDNAP | 7 | 32 | 0.012 / 0.001 / 0.066 > 0.625 / 0.589 / 0.590 | 0 / 0 / 0 > 0 / 0 / 0 | 1.00 > 0.94 |
| SGP4XP | 1 | 32 | 0.837 / 0.696 / 0.686 > 0.837 / 1.127 / 0.662 | 0 / 0 / 0 > 0 / 0 / 0 | 0.97 > 0.94 |
| SGP4XP | 3 | 32 | 0.612 / 0.376 / 0.973 > 0.608 / 1.083 / 0.773 | 0 / 0 / 0 > 0 / 0 / 0 | 0.94 > 0.88 |
| SGP4XP | 5 | 31 | 0.616 / 0.253 / 0.979 > 0.609 / 0.873 / 0.700 | 0 / 0 / 1 > 0 / 0 / 0 | 0.94 > 0.97 |
| SGP4XP | 7 | 32 | 0.620 / 0.147 / 0.635 > 0.616 / 0.578 / 0.427 | 0 / 0 / 2 > 0 / 0 / 1 | 0.94 > 0.97 |

AP's radial at days 1 and 3 stays somewhat narrow at the median (1.04, 0.95). That part is the epoch covariance, and
the noise starts from zero at the end of the arc.

The other classes keep the ABOVE row for now. Medium Earth orbit: Galileo's in-track errors run 5 to 14 times GPS's,
and nothing the record states ranks them (data sigma: Spearman +0.13 to +0.35 on GPS, -0.02 to -0.43 on Galileo); a
row that holds the acceptance must be tuned to Galileo's tail, which leaves GPS-class satellites about 5 to 10 times
too wide in track. That row, and its second row for sets that solve Y0 (16.13), follow once the fit's end with Y0
solved no longer depends on rounding (stack #456). Geosynchronous: noise scaled by the record's own data sigma,
measured next. HEO: TESS and Chandra, two objects, 14 window-arcs, measured after the eccentric integration step fix.
THEMIS is not in this set: its perigee is in the drag.

The class boundaries make the stated covariance jump where a row changes. At n = 4 rev/day (e 0.01, a 16,763 km) the
growth per day the rows give is, for AP, 2,003 m in track and 16.3 m radially under the ABOVE row against 1.6 m and
0.19 m under the LAGEOS row; for SGP4XP, 112 m and 3.9 m against 23 m and 4.1 m. At e = 0.3 nothing jumps yet:
every class there keeps the ABOVE row.

**12.6 Calls.** `sdnap_covariance_at(omm, length, minutes, count, out)` gives, per time, the TEME state and P(t)
(42 doubles); `propagate` writes a covariance line per state (COVARIANCE_MATRIX_LINES, the block's own axes: P
rotated with the state) for an SGP4XP set that carries COVARIANCE. An SGP4 set has none.


**12.7 Acceptance band.** Covariance realism acceptance band: mean d^2/3 in [0.8, 1.25] and 95 % coverage in [0.93, 0.97].
Per regime and day of lead (the experiments' band, V1c4), with the coverage the share of samples inside the 95 %
ellipsoid. The measured cells (test/results/covariance-realism-sgp4xp.json, README "Covariance
realism"), 0 of 12 inside:

| Theory | Set | Day | Mean d^2/3 | Inside 95 % | Band |
| --- | --- | --: | --: | --: | --- |
| SGP4XP | LAGEOS-1 (experiment windows) | 1 | 1.82 | 0.725 | outside |
| SGP4XP | LAGEOS-1 (experiment windows) | 2 | 1.93 | 0.738 | outside |
| SGP4XP | LAGEOS-1 (experiment windows) | 3 | 1.91 | 0.773 | outside |
| SGP4XP | LAGEOS-1 (2026-02 .. 05) | 1 | 1.38 | 0.913 | outside |
| SGP4XP | LAGEOS-1 (2026-02 .. 05) | 2 | 1.44 | 0.908 | outside |
| SGP4XP | LAGEOS-1 (2026-02 .. 05) | 3 | 1.44 | 0.93 | outside |
| SGP4XP | LAGEOS-2, Etalon-1/2 | 1 | 1.34 | 0.909 | outside |
| SGP4XP | LAGEOS-2, Etalon-1/2 | 2 | 0.84 | 0.994 | outside |
| SGP4XP | LAGEOS-2, Etalon-1/2 | 3 | 0.69 | 0.998 | outside |
| SGP4XP | LEO set | 1 | 1.09 | 0.98 | outside |
| SGP4XP | LEO set | 2 | 0.91 | 0.988 | outside |
| SGP4XP | LEO set | 3 | 0.76 | 0.992 | outside |

Outside the band: SGP4XP in every cell, LAGEOS-1 at 1.38 to 1.93 throughout, the LAGEOS-2 and Etalon and LEO cells
too large from day 2 (coverage 0.98 to 1.0). The band is not widened.

The covariance is positive semidefinite by construction and is not calibrated. The band of SPEC 12.7 cannot establish
realism: it accepts variance errors of 2.3, 0.2 and 0.01 on the three principal axes together, a perfect covariance fails it
with probability 0.65 at 20 independent forecasts and 0.15 at 200, and the noise sizes were tuned on the windows tested. With
the model otherwise exact, the fitted sigma of B and S is too small by sqrt(3N - L), 46 for a 24 h arc sampled every 120 s.


SDNAP: the judged cells of 12.5 (per axis, on the build's own flights; on 0.6.42's flights of records at 31/70, 8 of 42
inside the band); neither theory's table earns a realism label.

**12.8 The drag prior of a fit.** `fit` estimates BTERM under its $PCF FIT.DRAG_PRIOR (MEAN, SIGMA, FORM); a stated
prior is fitted as given on every fit.

Per object: after the call's own $PCF, the `configuration` port takes either no further $PCF or one per 'ephemeris'
frame, in the frames' order. Each states only FIT.DRAG_PRIOR, FIT.SRP_PRIOR and their forms (CONFIGURATION_ID and
PROFILE may stand; anything else is refused by name), and the objects of its frame are fitted under the priors it
states, the call's for the rest: a frame whose $PCF states no drag prior takes the band default below. Each object's
$OBD states its posterior after the prior: under LOG_NORMAL the posterior sigma of the log and the posterior median,
under GAUSSIAN_SIGNED the posterior value and sigma. A catalog that refits daily carries them: BTERM LOG_NORMAL with the
previous posterior median and, as the sigma of the log, the larger of the previous posterior's and 0.3; AGOM
GAUSSIAN_SIGNED with the previous posterior value and the larger of its sigma and 0.01.

Measured on the model truth of the table below, one call with the SWOT-like orbit (true B 0.044) and the
Sentinel-3-like orbit (true B 0.001): each object's set is the bytes of its single-object fit; on the default (the 71 h
arc's, below) the day-3 errors are 94.3 and 110.8 m (B 0.0467 and 0.00219; on 0.4.13's band defaults 82.0 and 24.1 m, B
0.0463 and 0.00115), carried 94.7 and 110.8 m, and with each object's true B (sigma of the log 0.3) 21.9 and 20.4 m. With
SWOT-like's carried prior shared by both, as the call's one $PCF had to before 0.4.13, the Sentinel-3-like object is at
3,195.1 m. A posterior carried from the same arc returns that arc's
estimate (SWOT-like's 0.0467 against 0.044), so the carried prior gains only as the running estimate converges over
successive arcs, which is the catalog's work. `test/fit-per-object-prior-multi.e2e.mjs` measures these numbers. Unset, the prior is LOG_NORMAL with median 0.01
m^2/kg and sigma of the log ln 10; under NRLMSISE-00 (or a minimum span below 24 h) the median follows the mean altitude
(0.01 below 600 km, 0.002 at 600-800 km, 0.0005 above; above e 0.3 the perigee's altitude, where the drag acts), and
under NRLMSISE-00 at 800-1400 km the sigma of the log is 10 ln 10. On an arc of 71 h or more under NRLMSISE-00, an orbit at
or below e 0.3 is judged on its perigee's height instead, and with the perigee at 600 to 2,500 km takes median 0.008 and
sigma of the log 10 ln 10 with no fall-back: the arc decides (below, "The default of a 71 h arc").

The fit estimates ln B by Gauss-Newton from the median. At B = 0.0005 the arc's sensitivity to ln B is B times its
sensitivity to B, so under sigma ln 10 the prior's curvature dominates and the estimate stays at the median whatever
the arc holds; under 10 ln 10 it reaches the value the arc determines (posterior sigma of the log 0.005 to 0.02 at
814-891 km over 72 h). A GAUSSIAN_SIGNED prior starts at its mean, and at B = 0 the theory carries no drag and the
fit does not move B: a flat 0 +- 10 ends at 0. FFM's estimator (analysis/estimation) bounds each step in ln p to a
factor of ten and judges convergence on the undamped step, its a priori Gaussian in p.

Model truth: FFM EGM96 70x70, Sun and Moon from DE440 and NRLMSISE-00 drag at constant weather on both sides; AP
FORCES 31,20 with NRLMSISE-00; 72 h fits from an osculating perigee; day-3 3D RMS over 2-minute samples (m), the fitted
B in brackets (m^2/kg):

| Orbit, true B | 0.4.11 default | sigma 3 ln 10 | 0.4.12 default | median 0.01, ln 10 | flat Gaussian | 7-day arc, 0.4.11 default | per-object prior |
| --- | --: | --: | --: | --: | --: | --: | --: |
| SWOT-like, 891 km, 0.044 | 1,314 (0.0005) | 1,306 (0.0008) | 82 (0.046) | 677 (0.021) | 1,330 (0) | 80 (0.043) | 21 (0.044) |
| Sentinel-3-like, 814 km, 0.044 | 3,957 (0.0008) | 26 (0.044) | 64 (0.045) | 184 (0.042) | 4,027 (0) | 39 (0.044) | 28 (0.044) |
| Sentinel-3-like, 0.01 | 867 (0.0005) | 227 (0.0075) | 49 (0.0105) | 43 (0.0104) | 916 (0) | 84 (0.0096) | 20 (0.0100) |
| Sentinel-3-like, 0.001 | 51 (0.0005) | | 24 (0.0012) | 516 (0.0067) | | | |
| Jason-like, 1,336 km, 0.044 | 256 (0.0005) | | 256 (0.0006) | 202 (0.010) | | | |
| Jason-like, 0.005 | 37 (0.0005) | | 37 (0.0005) | 22 (0.010) | | | |

The per-object prior is the true B with sigma of the log 0.3. The sigma columns keep the median 0.0005, and the 7-day
arc is a 168 h span (FIT.DEFAULT_SPAN_HOURS and MAXIMUM_SPAN_HOURS); the other columns fit 72 h. At 717 km (median
0.002) the arc determines B under ln 10 already (true 0.044, 0.01 and 0.001: 492, 756 and 91 m at day 3); under 10 ln
10 it gives 310, 316 and 324 m, so the 600-800 km band keeps ln 10. At 1,336 km the 0.4.12 default leaves B at the
median as before; that is the per-object path's case.

The read AP6 altimetry windows (descriptive; paired day-3 AP minus FFM's archived F72 arm, median per object, 0.4.11 to
0.4.12): HY-2C 575.7 to 34.2 m, HY-2D 523.2 to 19.0, SWOT 463.7 to 208.2, Jason-3 180.2 to 34.5, Sentinel-6
82.6 to 53.3, Sentinel-3A 43.9 to -1.8, Sentinel-3B 25.9 to 6.6, CryoSat-2 55.7 and SARAL 47.7 (600-800 km)
unchanged; all 121 windows 167.2 to 34.2 m. A read window counts only where FFM's own day-3 error is under 10 km, since
a maneuver in the truth is not propagation error; the E2E prints each excluded window with FFM's error. Sentinel-6B's
windows are its commissioning: FFM misses four of five by 1.9 to 2,626 km, and on the two that FFM keeps under 10 km
the paired value goes from 191.7 to 3.9 m.
`test/fit-bterm-700-1400-km.e2e.mjs` measures every number of the default and per-object paths and of the windows.

**Diagnostics and the fall-back (0.4.18).** Every fit's $OBD BALLISTIC_COEFF_MODEL carries, after the prior and the
posterior above (BTERM in the $OMM's BSTAR, AGOM in its MEAN_MOTION_DDOT and in AGOM_MODEL, the arc in FIT_SPAN), the arc
check: the arc's hours, its largest gap and where it starts, and the step test's revolutions, velocity step, time, F and
verdict. Where the rule below is judged, BALLISTIC_COEFF_MODEL and the $OMM COMMENT also carry the drag path, `drag
prior: band default at 800-1400 km, no fall-back` or `drag prior: fall-back to the band median's prior (...) on
<reasons>; the band default's fit: BTERM, posterior sigma of the log, sigmas from the band median, fit RMS`, and the
COMMENT the arc check; every other $OMM is 0.4.17's byte for byte. $OBD 0.0.3 has no numeric field for a width, a prior
or a flag, so they are its model text; nothing goes in USER_DEFINED_PARAMETERS.

The arc check. A data gap: two consecutive fitted states more than two revolutions apart. An along-track step (a
maneuver indicator): the fit residuals' along-track component (model minus data along the model's velocity), averaged
per revolution over bins of at least 3 states (9 bins at least), is fitted by least squares with a quadratic in time
and with the quadratic plus a hinge max(0, t - t_h) at each bin boundary with 3 bins on either side; the hinge that
lowers the residual sum the most gives F = (RSS_0 - RSS_h) / (RSS_h / (K - 4)) over K bins and, from its slope c, the
velocity step |c| / 3 (a tangential step dv changes the along-track drift rate by 3 dv). A step is flagged at F >= 100
and at least 0.002 m/s. On the nine step-free model-truth arcs below F is at most 26.5 and the step at most 0.0003 m/s;
tangential steps of 0.005, 0.01, 0.02, 0.05 and 0.5 m/s 36 h into the SWOT-like and Sentinel-3-like arcs are recovered
as 0.0047 to 0.4992 m/s at F 1,335 to 6,550, every one flagged. On the read windows below no arc with a fit RMS under
30 m is flagged (the largest F 139, at 0.0008 m/s) and 17 of the 18 above 80 m are (0.005 to 0.030 m/s; Sentinel-6B
2025-12-14 0.51 m/s); Sentinel-6B 2025-12-19 (1.7 km, its commissioning) gives 0.17 m/s at F 85. A step after the arc's end, its states in the $OEM after USEABLE_STOP_TIME, leaves the fit bit for
bit.

The rule. After a fit of at least 71 h (the 72 h arc and longer) under NRLMSISE-00 at 800-1400 km on the band default (since
the default of a 71 h arc below, an orbit above e 0.3 only: a 71 h arc at or below e 0.3 is judged on its perigee, and with
the perigee at 800-1400 km takes that default, which has no fall-back),
the fit is redone under 0.4.11's band-median prior (median 0.0005 m^2/kg, sigma of the log ln 10, which is 0.4.11's fit
bit for bit) when the posterior sigma of the log exceeds B = 0.5, or BTERM is more than k = 3 posterior sigmas from the
band median while the fit RMS exceeds the band's median, 15.16 m, by more than 25 % (18.95 m), or the arc check flags a
gap or a step. B, k and the band median come from the model truth of 0.4.12's table (the band default's fit; the band
median's prior, as 0.4.11; day-3 3D RMS, m):

| Orbit, true B | Band default: B, sigma of the log, fit RMS (m), day 3 | Band median prior: B, day 3 | 0.4.18 |
| --- | --- | --- | --- |
| SWOT-like, 0.044 | 0.0463, 0.011, 14.48, 82.0 | 0.0005, 1,314.5 | default |
| SWOT-like, 0.01 | 0.0110, 0.048, 14.73, 42.9 | 0.0005, 279.2 | default |
| SWOT-like, 0.001 | 0.00069, 0.795, 15.16, 15.2 | 0.0005, 15.9 | fall-back, 15.9 |
| Sentinel-3-like, 0.044 | 0.0447, 0.005, 18.52, 63.6 | 0.0008, 3,957.3 | default |
| Sentinel-3-like, 0.01 | 0.0105, 0.021, 18.55, 49.4 | 0.0005, 867.1 | default |
| Sentinel-3-like, 0.001 | 0.00115, 0.196, 18.68, 24.1 | 0.0005, 50.7 | default |
| Jason-like, 1,336 km, 0.044 | 0.00058, 5.36, 17.27, 263.0 | 0.0005, 263.5 | fall-back, 263.5 |
| Jason-like, 0.01 | 0.00052, 4.23, 12.08, 61.5 | 0.0005, 61.6 | fall-back, 61.6 |
| Jason-like, 0.001 | 0.00051, 4.12, 11.48, 14.07 | 0.0005, 14.09 | fall-back, 14.09 |

Where the arc determines B (sigma of the log 0.196 or less) the wide prior gains 26.6 to 3,893.7 m; where it does not
(0.795 or more) B stays near the median and the two priors agree within 0.7 m. B = 0.5 lies between, the covariance's
prior-limited mark. B moves 4.2 to 896 posterior sigmas from the median where the arc determines it and 0.4 or less
where it does not: k = 3. The band median RMS is the median of the nine fits' RMS; no fixture exceeds 18.95 m (the
largest 18.68 m, Sentinel-3-like), so on the model truth the fall-back is taken only where B is undetermined.

AP8's read altimetry windows (DO, 136 paired AP72 windows; descriptive, these windows were read by AP8 and its
diagnosis), 0.4.11 / 0.4.17 / 0.4.18: Sentinel-3A 2025-10-15 day 3 0.087 / 0.312 / 0.087 km and Sentinel-3B 2025-10-25
day 7 0.113 / 1.335 / 0.113 km. 37 windows fall back, each to 0.4.11's fit bit for bit: 13 on k and the RMS (every
Sentinel-3A and -3B window in the band with B determined, fit RMS 19.2 to 86.5 m), 15 on the sigma alone (12 of
Sentinel-6 Michael Freilich's arcs, Jason-3 2025-12-04 and 12-19, Sentinel-6B 2025-12-19) and 9 on the sigma with a
step (fit RMS 145 m to 25.5 km). The day-3 median
change against 0.4.11 stays 0.4.17's on HY-2C (-84.3 %), HY-2D (-90.9 %), SWOT (-48.2 %) and Jason-3 (-69.1 %); SARAL
and CryoSat-2 (600-800 km) are 0.4.17's bit for bit. The diagnostics show the mechanism: on 11 of the 13 Sentinel-3 windows
both priors leave B determined by the arc (posterior sigma of the log 0.004 to 0.012), and 0.4.17 fits it 5 to 26 %
higher at a lower RMS (2025-10-15: 0.0217 at 21.1 m against 0.0190 at 23.8 m), so the losses are a determined estimate
that does not carry forward, which the width B never flags; the arc's RMS above the band's model-truth median separates
them. On the other two (Sentinel-3A 2025-11-24 and 12-19) 0.4.11 left B near the median (sigma 0.53 and 0.56). The rule
returns Sentinel-3A and -3B to 0.4.11 in the band, its gains with its losses: 0.4.17's -41 % day-1 median change goes
(day 1 median 0.058 to 0.090 km on Sentinel-3A), and 2025-11-24, 2025-10-30 and Sentinel-3B 2025-10-30 go from 0.072,
0.128 and 0.114 km at day 3 back to 1.506, 0.502 and 0.482 km. Jason-3 2025-10-10 (day 3 0.203 / 0.250 km, sigma of the
log 0.039, fit RMS 16.1 m) is not reached by the rule.

Cost: the mean fit time of a 72 h DO arc, 0.4.17 to 0.4.18 (12 workers on the owner Mac), outside the band 1,680 to
1,706 ms (the arc check), on the band default kept 1,834 to 2,210 ms (the first fit's covariance and arc check), on a
fall-back 1,790 to 3,430 ms (the second fit); per object-day of the arc a third of that (560 to 569, 611 to 737 and 597
to 1,143 ms). Propagation does not change (XP digest
72dcf6005046). `test/drag-prior-fallback.e2e.mjs` measures every number here; the printed figures are of
the EGM96 truth it flew through 0.6.34, and from 0.6.36 it flies EGM2008.

**The default of a 71 h arc.** With FIT.DRAG_PRIOR unset under NRLMSISE-00, a fit arc of 71 h or more at or below e 0.3
is judged on its perigee's height, where the drag acts. With the perigee at 600 to 2,500 km, BTERM's prior is LOG_NORMAL,
median 0.008 m^2/kg, sigma of the log 10 ln 10, with no fall-back (`pcf::kDragPriorFreeMedian`, `kDragPriorFreeFloorKm`,
`kDragPriorFreeTopKm`, `kDragPriorFreeMinArcHours`). The $OMM COMMENT and BALLISTIC_COEFF_MODEL read `drag prior: the
default of a 71 h arc with its perigee at 600-2,500 km (median 0.008, sigma of the log 10 ln 10, weighed against the
data at their own sigma), no fall-back`. Such an arc with its perigee below 600 km takes the median 0.01 and one with its
perigee at 2,500 km or above 0.0005, both under ln 10. Shorter arcs, orbits above e 0.3 and fits without NRLMSISE-00 keep
the rules above. An arc of 71 h or more under the drag is fitted at the data's own sigma (12.1), so this prior acts at
its written sigma: 10 ln 10 is no pull on the term, and 0.008 is where the fit starts. The tables and lists of this
block up to "The drag term's stated width" were measured with the data weighed at 1 km (the default as first drafted,
stack #39); 12.1 gives the rows at the data's own sigma.

The band medians this replaces were 2 to 40 times below the numerical propagator's fitted Cd A/m on every satellite
measured: laser spheres 0.002 to 0.016, altimetry 0.01 to 0.05, Sentinel-1 0.008. A 72 h arc kept them, under ln 10 at
600-800 km and through the fall-back at 800-1400 km.

The headline loop's real windows (the LS, DO, S1 and P rows; AP's 72 h fits; day-5 error, m; the pass line is day 5 within
100 m of the row's numerical arm; SGP4XP is this module's, fitted on the same arc), 0.6.16 to this default:

| Row | Median, days 1 / 3 / 5 / 7 | Within the line | Day 5 better / worse (1 m and 1 %) | Closer than SGP4XP at day 5 |
| --- | --- | --- | --- | --- |
| Laser spheres | 23.9 / 58.1 / 129.4 / 205.5 to 22.8 / 46.7 / 88.7 / 146.6 | 32 to 46 of 56 | 27 / 21 of 78 | 54 to 55 of 56 |
| Altimetry | 39.2 / 252.3 / 755.8 / 1,677.4 to 27.8 / 172.7 / 496.4 / 1,076.1 | 57 to 71 of 112 | 55 / 42 of 136 | 94 to 96 of 112 |
| Near 700 km | 237.4 / 1,312.6 / 2,843.4 / 4,526.5 to 240.2 / 1,316.8 / 2,925.8 / 4,762.8 | 67 to 71 of 88 | 27 / 48 of 90 | 67 to 64 of 88 |
| Strong drag 2026 | unchanged (perigees below 600 km) | 90 of 153 | 0 / 0 | 162 of 255 |

- Every 24 h fit is unchanged; the largest difference is 2.5e-8 m.
- 49 windows come inside the line and 17 go outside, each against its row's own numerical arm. The 17: LARES 2025-12-04 (43
  to 135 m, the numerical arm 4 m); Sentinel-3B 2025-10-25 (57 to 770 m, numerical 660), Sentinel-3A 2025-10-15 and
  10-20, SARAL 10-15, 11-14 and 12-09, Jason-3 10-25 and CryoSat-2 12-04; Sentinel-1 39634 on 2026-01-16, 02-12, 02-17 and
  02-21, and 62261 on 01-05, 01-13, 01-22 and 02-06. They end 1 to 227 m past the line.
- On the near-700 km row more windows pass, but the medians lose 82 m at day 5 and 236 m at day 7, more windows get worse
  than better, and AP is closer than SGP4XP on 3 fewer windows.
- On the 1,120 window fits of these rows, keying the band on the perigee gives every day's error of the same rule keyed on
  the mean altitude, to 1e-6 m.

The forecast covariance's in-track coverage does not change on these rows (beyond 3 sigma, count of n, on the 72 h fits).
The one change: at day 5 on the near-700 km row, 20 of 88 windows are beyond 3 sigma, against 19. The numerical propagator
is itself more than 1 km off at day 5 on all 20, and on all 19 before. The BTERM variance is mapped into the forecast
(P = J P J^T + Q + F) but is negligible beside the DRAG row's s_d. The record's sigma of ln BTERM is too small (stack #463,
`test/drag-term-sigma-honesty.e2e.mjs`, a known defect): |z| = |ln(B_AP / B_FFM)| / sigma above 3 on 36 to 51 of 77
sphere windows (median |z| 2.69 to 4.52), 91 to 92 of 119 altimetry (9.67 to 7.02) and 44 to 39 of 55 near 700 km (11.06
to 5.78).

Model truth (the fixtures of the tables above; 72 h fits; day-3 3D RMS, m, the fitted B and its posterior sigma of the log
in brackets), the band default with its fall-back (0.4.18's figures above; this harness gives 0.4.17's band-default rows
within 0.9 m of them) to this default:

| Orbit, true B | Band default, fall-back | The default of a 71 h arc |
| --- | --: | --: |
| SWOT-like, 891 km, 0.044 | 82.0 (0.0463) | 94.3 (0.0467, 0.011) |
| SWOT-like, 0.01 | 42.9 (0.0110) | 94.4 (0.0127, 0.041) |
| SWOT-like, 0.001 | 15.9 (fall-back, 0.0005) | 126.2 (0.0047, 0.11) |
| Sentinel-3-like, 814 km, 0.044 | 63.6 (0.0447) | 67.3 (0.0447, 0.005) |
| Sentinel-3-like, 0.01 | 49.4 (0.0105) | 66.8 (0.0107, 0.021) |
| Sentinel-3-like, 0.001 | 24.1 (0.00115) | 110.8 (0.0022, 0.10) |
| Jason-like, 1,336 km, 0.044 | 263.5 (fall-back, 0.0005) | 16.3 (0.0427, 0.050) |
| Jason-like, 0.01 | 61.6 (fall-back, 0.0005) | 12.6 (0.0108, 0.20) |
| Jason-like, 0.001 | 14.09 (fall-back, 0.0005) | 39.8 (0.0078, 0.27) |

At 814 and 891 km the model truth loses on every fixture, and most where the true B is 0.001. There the fit lands at two to
eight times the truth and states it to 10 to 27 % (stack #463). The real satellites' terms are 0.002 to 0.05, and on the
real rows the default gains. At 1,336 km, where the band default left B at its median, it gains where B is 0.01 and more.

The AP6 read altimetry windows (paired day-3 AP minus FFM's archived F72 arm, median per object, 0.4.11 to this default):
HY-2C 576.4 to 40.7 m, HY-2D 524.0 to 19.4, SWOT 464.1 to 196.7, Jason-3 181.0 to 32.1, Sentinel-6 Michael Freilich 83.4 to
-1.7, SARAL 47.5 to -0.3, Sentinel-3A 44.2 to -12.8, Sentinel-3B 25.6 to 4.1, CryoSat-2 55.8 to 100.1 (scored windows 66.3
to 109.1); all 121 windows 168.0 to 23.2 m. AP8's DO windows (the median day-3 change against 0.4.11): HY-2C -85 %, HY-2D
-92 %, Jason-3 -73 %, SWOT -48 %, SARAL -35 %, Sentinel-3A -0.5 %, Sentinel-3B +1.9 %, CryoSat-2 +1.4 %. Sentinel-3A
2025-10-15 is 0.314 km at day 3 and Sentinel-3B 2025-10-25 1.344 km at day 7, where 12.8's fall-back had kept 0.4.11's
0.087 and 0.113 km. A step of 0.5 m/s 36 h into the SWOT-like and Sentinel-3-like arcs leaves a fit RMS of 28.2 and 28.0
km with B undetermined (posterior sigma of the log 23.0), where 12.8's fall-back took the band median.

What was tried and not taken:
- The same prior on 24 h arcs. Day 5 improves on three rows: spheres 144 to 111 m (24 to 27 of 50 within the line),
  altimetry 1,757 to 750 m (24 to 38 of 112), near 700 km 1,742 to 1,845 m (69 to 73 of 96). But it blunders where AP's
  along-track theory error aliases into a free term on a short arc. LARETS 2025-10-15 goes from 59 to 4,164 m with B 0.0077
  against the numerical 0.0027, stated to 5.4 % (|z| 19); the strong-drag row loses (7,896 to 8,130 m, 75 to 72 of 153).
  Stack #460.
- A fall-back from this default to 0.008 under ln 10 on 12.8's conditions. On 24 h arcs it removes none of the blunders: a
  term determined wrongly sits near the median with a narrow posterior. On 72 h arcs it fires on "rough" (real arcs run 20
  to 60 m against the model-truth 18.95 m) and on "gap" (laser-ranged arcs), where the term was right. Near 700 km goes 71
  to 52 of 88 within the line. With only the width and the step judged, it is still 53 of 88.
- Each object's previous posterior carried as its prior (12.8's catalog rule). Altimetry's 24 h row goes 24 to 50 of 112
  within the line, but near 700 km's 72 h row goes 67 to 48 of 88, and spheres' 72 h median goes 129 to 150 m.
- The perigee key on 24 h arcs. On made-up eccentric orbits (perigee by apogee 450 by 1,800, 550 by 1,500 and 700 by 2,000
  km; true B 0.01 and 0.003; the full force set on real weather), on 72 h arcs the perigee key is better on 4 and equal on
  2 (day 5 1,538 to 1,509, 1,542 to 1,135, 373 to 365 and 393 to 169 m; equal at 700 km). On 24 h arcs it is wrong: 450 by
  1,800 km at B 0.003 goes 52 to 2,508 m. These orbits' fitted B is far off on every key (stack #468).

Arcs with a gap or a burn. Model truth at 800 km (i 98) and 1,340 km (i 66), e 0.001, for two objects: B 0.003 with AGOM
0.0015, and B 0.02 with AGOM 0.015. FFM 70x70, Sun and Moon, solid tide, relativity, NRLMSISE-00 on real GFZ weather; 72 h
fits. Day-5 3D RMS (m), 0.6.16 to this default, with BTERM and AGOM pinned at the truth in brackets:
- clean arcs: 53 to 33 (116), 1,031 to 179 (116), 125 to 88 (112) and 217 to 144 (114);
- 12 h of the arc missing: 56 to 37, 1,039 to 132, 125 to 88 and 218 to 152.
An along-track burn of 1, 5 or 50 cm/s 36 h into the arc, which AP does not model, leaves a fit RMS of 0.54 to 28 km on
both builds, and day 5 stays within 0.5 % of 0.6.16's (5.5 to 341 km). There this default states B undetermined (sigma of
the log 23.0), where 0.6.16's band prior stated 2.3.

CryoSat-2 (717 km) gets worse at day 5 (median 973 to 1,013 m on its 15 real windows) while its fitted term moves closer to
the numerical one (B_AP / B_FFM 0.89 to 0.95): the lower term was offsetting the missing solid tide (#449) and the
commensurability terms above degree 31 at 690 to 800 km (#447). `test/fit-bterm-700-1400-km.e2e.mjs` holds it at or below
115 m paired at day 3 (stack #470).
`test/fit-bterm-700-1400-km.e2e.mjs` and `test/drag-prior-fallback.e2e.mjs` measure the model truth and the AP6 windows;
the real-row figures are the headline loop's.

**The drag term's stated width on a 71 h arc** *[2026-11-11, stack #489, #463; the 72 h windows of experiments
headline-loop's low-orbit rows, burns left out (the numerical propagator's own 3D error at day 3 over 10 km), against
the numerical propagator's fitted term on the same arc]*. A set fitted on this default at the data's own sigma (12.1),
over 71 to 75.6 h, states BTERM's sigma of ln as

    sigma_s^2 = min(1 / (I_arc / m^2 + 1 / sigma_p^2), c^2),   I_arc = 1 / sigma_f^2 - 1 / sigma_p^2

with sigma_f the fit's formal sigma of ln (12.1), sigma_p the prior's 10 ln 10, m = 3.14 and the cap c = 1.09, for a
perigee at 600 to 2,500 km (`cov::kWidth1`). m is the factor that brings the 95th percentile of
|ln(B_AP / B_numerical)| / sigma_f to 1.96 over the windows where sigma_f is under the cap; c is the spread (standard
deviation) of ln B over the numerical propagator's 72 h terms in the band, 246 windows of 18 satellites. Without the cap an
arc that cannot see the term states the prior's 23.0, which is no width. The statement is on BTERM's diagonal alone; the
record's second COV_REALISM entry names it, `sdn-ap drag-term width 1: m 3.14, prior sigma 23.0259, cap 1.09; stated, not
mapped`, and where the cap binds it adds `; capped, formal sigma of ln <sigma_f>`. It is stated, not mapped: `propagate`
derives m, sigma_p and c from the record's own elements, ACTUAL_OD_SPAN and atmosphere, checks them against the entry,
recovers sigma_f (inverting the first form, or reading the entry where the cap binds) and maps that; the flight's
parameter block states the record's own variance. A record the reader cannot match maps its matrix as stated, and the
flight's block COMMENT says `covariance: <entry>: mapped as stated (<why>)`. The width changes no state and no position
covariance of a flight: the forecast maps the formal variance sigma_f^2 B^2, which a reader recovers from the record's
BTERM diagonal and the entry's figures as above (or, where the cap binds, reads in the entry). On these rows that
mapping was measured to hold: beyond 3 sigma radially at day 5, altimetry 10 to 2 of 109 windows, spheres 0.

One band, not two. With one satellite left out of the factor and the cap, the 600 to 1,000 km band alone holds (coverage
of 1.96 0.92, the 95th percentile over 1.96 1.14) and a band of its own for 1,000 to 2,500 km does not (0.81 and 2.75):
five objects, one of them (LARES) 20 times under the rest, cannot carry a factor and a cap of their own. The free band
as one, with one satellite left out: 0.91 and 1.19; by part, 600 to 1,000 km 0.91 and 1.18, and 1,000 to 2,500 km 0.94
and 1.28, over the 1.25 the rule aims at (five objects, one of them 20 times under the rest). On the records themselves:
600 to 1,000 km 0.907 and 1.17 (5 of 193 beyond 3 sigma), 1,000 to 2,500 km 0.943 and 1.19 (3 of 53).

Limit: an arc that does not see the term. On three of LARES's 13 windows the formal sigma of ln is the prior's (22.5 to
22.9) and the fitted B is 0.008 to 0.022 of the numerical propagator's, 3.5 to 4.4 stated sigmas off; the cap bounds what
is stated, not where the estimate goes. The term is too small there to matter in position: on those three windows the
day-5 forecast lies 11.9 to 12.7 m from the numerical propagator's (D5), and 12.2 m from the precise orbit where day 5 is
scored. LARES's along-track sigma at day 5, 2.36 km against errors of 4.5 to 42 m, is the DRAG row's s_l (12.5; 104 m
with s_l at 0), not the term, and the same before this rule (stack #490).

**Above e 0.3.** Until 0.4.16 Molniya's band default followed its mean altitude (20,180 km, median 0.0005) and the 72 h
fit stayed there (0.000831 against the truth's 0.044, 11,063 m along-track at day 7); at its 541 km perigee the median is
0.01. The arc then determines BTERM, but a 72 h arc at e 0.72-0.74 does not separate it from the third bodies' and the
field's residuals. FFM model truth of 16.12 (Sun and Moon on both sides, AGOM pinned at 0, 10-minute grid; day-7
whole-day RMS along-track/radial after the arc, m; B against the truth's 0.044 and the posterior's sigma):

| Arc, prior | Molniya | GTO-500 |
| --- | --- | --- |
| 72 h, Gaussian 0.044 +- 0.1, 0.4.15 | +3.86 %, 1.09 %; 294.97 / 200.89 | +1.56 %, 0.67 %; 322.48 / 215.92 |
| 72 h, Gaussian 0.044 +- 0.1 | +1.78 %, 1.08 %; 279.49 / 190.28 | +2.42 %, 0.67 %; 736.18 / 473.69 |
| 72 h, Gaussian, Sun and Moon off on both sides | +0.13 %, 0.97 %; 110.03 / 91.29 | +1.92 %, 0.67 %; 566.03 / 364.48 |
| 7 days, band default (day 3 after the arc) | -0.46 %, 0.16 %; 46.64 / 36.98 | -0.28 %, 0.09 %; 157.22 / 105.55 |
| 72 h, the 7-day posterior carried (sigma of the log 0.005), days 7 to 10 | -0.46 %, 0.46 %; 103.54 / 75.20 | -0.29 %, 0.39 %; 87.69 / 48.37 |

On Molniya's 72 h arc the fit's weighted RMS is flat in B to 2 % (0.04319 at 0.044, 0.04240 at 0.0458, the arc's
minimum at +4.1 %, and 0.04250 at 0.0466, BTERM pinned at each), while the forecast from those values is 70.9, 557 and
776 m at day 7; the posterior's 1.1 % does not bound that bias, and where the fit stops on the floor moves with any
change of the model (+3.86 % at 0.4.15, +1.78 % here). On GTO-500 the arc's bias is the field's (+1.92 % without the
Sun and Moon), and with AP's drag now right it maps whole into the forecast: 322.48 to 736.18 m along-track, a
regression of the 72 h arc on a wide prior, which the carried prior removes (87.69 m;
modules-sdn-ap-drag-high-eccentricity-20261103). Seven days determine B to 0.5 % on both fixtures. So above e 0.3 a catalog that refits daily carries BTERM with the sigma of the log at least 0.005
rather than 0.3: the 72 h arc's own pull (+4.1 % at a sigma of 1.1 %) moves a prior that narrow by at most
4.1 / (1 + (1.1 / 0.5)^2) = 0.7 %, and the 7-day arcs' errors (0.46 % and less) fit inside it. `test/drag-high-eccentricity.e2e.mjs`
measures the carried and Gaussian rows.

**The arc above e 0.3 (0.4.17).** For a block whose first state is above e 0.3 with its perigee below 2,500 km and no
stated FIT.DRAG_PRIOR, the fit takes the longest arc the ephemeris holds up to 7 days, ending at the latest useable state
(a USEABLE_START_TIME keeps the caller's arc). On an arc shorter than 7 days the determination says so ("drag coefficient
not separable on this arc", with the arc's hours and the formal sigma) and BTERM's posterior width comes from the RMS
floor: the residual there is the theory's, not noise, so the arc's information on BTERM is the formal information over
the residual components (the offset whose signature over the arc equals the RMS floor), combined with the prior's; the
$OMM covariance's BTERM row and column take the ratio of the widths, so a covariance flown from the set carries it. A
prior that pins BTERM (drag off, a pinned coefficient) and every orbit at e 0.3 and below fit as before, byte for byte.
One independent sample per revolution, tried first, left GTO-500's truth outside one sigma on the 72 h Gaussian arc
(1.83 % against 2.42 %).

FFM model truth of 16.12 (Sun and Moon on, AGOM pinned at 0, 10-minute grid): B against 0.044, the posterior's sigma
(the formal one in brackets where the floor sets it), day-7 whole-day along-track/radial after the arc (m):

| Arc, prior | Molniya | GTO-500 |
| --- | --- | --- |
| 72 h, none (band default) | -3.81 %, 25.0 % (1.21 %); 396.1 / 285.7 | +0.29 %, 14.1 % (0.68 %); 62.8 / 50.3 |
| 72 h, Gaussian 0.044 +- 0.1 | +1.78 %, 22.4 % (1.08 %); 279.5 / 190.3 | +2.42 %, 13.7 % (0.66 %); 736.2 / 473.7 |
| 5 days, none | +0.08 %, 9.5 % (0.35 %); 166.3 / 112.3 | +0.26 %, 5.3 % (0.20 %); 70.1 / 61.3 |
| 5 days, Gaussian 0.044 +- 0.1 | +0.70 %, 9.4 % (0.35 %); 257.8 / 175.4 | +0.34 %, 5.3 % (0.20 %); 98.8 / 73.5 |
| 7 days, none (the policy's arc) | -0.46 %, 0.16 %; 135.5 / 89.7 | -0.28 %, 0.09 %; 291.3 / 179.3 |
| 72 h, the 7-day posterior carried (0.005), days 7 to 10 | -0.46 %, 0.50 % (0.46 %); 103.5 / 75.2 | -0.29 %, 0.50 % (0.39 %); 87.7 / 48.4 |
| 7 days, BTERM pinned at 0.044 | 218.9 | 158.8 |

Seven days determine B to 0.5 %; what remains of the forecast after them is the theory's own (the pinned row), and
GTO-500's -0.28 % costs it 130 m against the truth's 158.8. The 7-day formal sigma (0.16 % and 0.09 %) does not cover
those errors either (2.9 and 3.1 sigma); a catalog carries it with the 0.005 floor above. A 5-day fit with its 7-day
flight took 24 to 39 s per run on the owner Mac under load; the 7-day arc's fit time was not timed apart. The 220 km
GTO's 72 h fit did not finish in 16 minutes on this build and was stopped (the 0.4.15 isolation's 7-day GTO fits ran
past 30): its truth is cached (0.04 s), so the time is the fit's own, the Levenberg-Marquardt stages and their
finite-difference Jacobians each propagating the arc, which costs about 0.1 s on GTO (16.12's 1 h grid cost); its
table rows are not measured.
`test/high-e-fit-arc.e2e.mjs` measures every row but the pinned one.

---

## 13. (removed)

The SDN-AP osculating input (`opm_set`, `propagate` with 'opm' frames) went with the SDN-AP theory (owner 2026-10-25); the
number is not reused.

---

## 14. Epoch store (side B's method, outside the SGP4-XP specification)

**14.1 Load.** `load_epochs` replaces the store with a snapshot: 'omm' frames of size-prefixed $OMM records end to end
(or one record a frame), SGP4 and SGP4XP Earth sets, under the $PCF EPOCH_STORE table (SDS 1.270.0). A series is
one (NORAD_CAT_ID, OBJECT_ID, theory, ORIGINATOR). Kept, per series and by epoch: the sets of the CACHE_DAYS (7) before
the newest epoch of the load, the clock being the data's (no wall clock: the store is a function of its input); at
most MAX_SETS_PER_OBJECT (0: no cap), the newest; THEORIES (empty: both). Two records of one series at one epoch:
the later in the snapshot replaces the earlier. Sets not centered on the Earth are counted and
not stored. A record's theory record (SGP4 Sat or SGP4XP integrator) is made when first needed. A series
of one set holds one slot, and a series of more than one holds two (the second is allocated with the series, counted,
and a load that cannot allocate it is refused `out-of-memory`); of those, the two sets last used hold a theory record
at a time. Two series that carry equal weather share one copy of it: equal means every row, node and node value the
same in every bit, so which of two series is kept never depends on their order. A `load_epochs` refused once its build has
begun (a record, a failed allocation, series-forces-differ) leaves no snapshot: the store is empty and its arrays are freed. One
refused before its build begins (a frame of a wrong type, a bad $PCF) leaves the store as it was. A load that builds while a counted
allocation failed answers `out-of-memory` with the store empty (through 0.6.56 the built store stayed in place).

**14.1.1 Load in parts.** A host that cannot stage the whole catalog in the module's memory takes it in parts with three methods:
`load_epochs_open` (the optional $PCF EPOCH_STORE, read once), `load_epochs_part` (the 'ocm' frames of one part, framed as for
`load_epochs`; any number of times) and `load_epochs_close`. `load_epochs` is these three in sequence on one payload.
- **Equality.** The store built from any partition of a list of frames into parts, the parts in order, equals set for set and in
  order the store `load_epochs` builds from the whole list: the kept sets, each series' order, capped and theory-filtered loads,
  same-epoch duplicates in whichever parts they fall (the later in input order replaces), the interned weather, the covariances.
  What is decided at a part: the theory filter and the skip of a set not centered on the Earth (counted, not held). What waits for
  the close: the aging and the cap (they need the newest epoch of the whole load), the same-epoch replacement and series-forces-differ
  (it compares every record of a series). So a record the close later drops is held until the close, a forecast record whole.
- **Status.** A non-zero status of any of the three methods means the load is closed and the store is empty, except `load-not-open`,
  which changes nothing (a part or a close with no load open; a loaded store stays), and `pool-dead`, which leaves the store in
  place:
  - an open drops the load in progress and empties the store, whether or not its configuration is accepted (a refused open
    leaves no load open and no store);
  - except after a threaded batch over the store taken for dead (SPEC 9), while a pool thread is still active. That thread may
    still be reading or writing the store, so the open frees nothing and refuses `pool-dead`, before it reads its $PCF (a bad $PCF
    in that open is reported as `pool-dead`). The store stays as the dead batch left it: `sdnap_epochs_count` answers its count,
    the eighth statistic of `sdnap_epochs_stats` is NaN, `sdnap_epochs_at` answers -20 with every status 9, and
    `sdnap_epochs_set_at` and `sdnap_drag_orbit_check` answer 9. No load is open, so a part or a close answers `load-not-open`.
    Once no pool thread is active, an open empties the store and the three calls load as usual;
  - a part refused for any reason (a type, a frame, a record, `out-of-memory`) drops the load and empties the store;
  - a close always ends the load, accepted or refused (series-forces-differ, `out-of-memory`, `missing-ocm` for a close with no
    part), and a refused close leaves the store empty.

  `load_epochs` abandons a load in progress, accepted or refused. With no load open, a `load_epochs` refused before its build begins
  (a wrong frame type, a bad $PCF, `pool-dead`) leaves the store as it was, as it always did, where a refused open empties it (the
  open's contract is the empty store; `pool-dead` excepted, above).
- **The first failure.** The reported failure is the first one met in input order: within a part as `load_epochs` reports it
  (every frame's type is checked before any record is decoded, so within one part a wrong type is reported before an earlier
  record's decode refusal), across parts the earlier part's. Two cases differ from `load_epochs` on the whole list: (1) a record that
  cannot be decoded in an earlier part and a frame of a wrong type in a later one (`load_epochs` reports the wrong type, the parts the
  record); (2) a bad $PCF, which the open reports before any frame's type is seen, where `load_epochs` checks the frames' types first.
  series-forces-differ and the refusals of the install come at the close. An allocation that fails in a counted site (SPEC 1.6),
  including the copy of a forecast and the arrays of a track, refuses by name `out-of-memory`; what SPEC 1.6 lists as not counted
  (the strings and vectors the decode reads a record into) still traps.
- **A difference from 0.6.56.** A load (`load_epochs` included) that builds while a counted allocation failed now answers `out-of-memory`
  with the store empty; through 0.6.56 the built store stayed in place.
- **State of the store.** From the open to the close the store is empty and no state is served: the open empties it and a part
  adds nothing to it. The `sdnap_epochs_*` exports answer as for a store that holds nothing, and not uniformly: `sdnap_epochs_count`
  0; `sdnap_epochs_stats` zero counts and, in the eighth statistic, the bytes the open load holds (below); `sdnap_epochs_series`,
  `_select` and `_set_at` -1 (no such series); `sdnap_epochs_at` and `_source_at` -1 for any request of one series or more and 0 for
  a request of none; `sdnap_drag_orbit_check` -4 (ORBPRO_PROP_BAD_INPUT). A host reads no state between the open and the close.
- **One load at a time.** There is one load per instance, with no handle: a part or a close acts on the load open, whoever opened it,
  and an open from any caller drops the load in progress. A host serializes one load per instance. No export, the statistics
  included, may run on another thread while any of the three methods or `load_epochs` runs: the open frees a loaded store, the
  install writes the resident store in place with no guard (as `load_epochs` never had), and the statistics walk the open load. One
  pool entry reads and writes this store: `sdnap_epochs_at` without a covariance plane runs its series on the pool's threads (SPEC
  9). It returns only once every chunk is done, so no pool thread touches the store while a load call runs. The exception is a
  batch taken for dead, whose slow thread may still be in its chunk: `load_epochs` and `load_epochs_open` then refuse `pool-dead`
  while a pool thread is active, before they free anything.
- **Memory.** Nothing of a part's bytes is kept after the call: a host stages every part in one buffer, allocated once and reused
  (the module reads a part's frames in place and has copied what it keeps before the call returns). What is held between parts is the
  decoded records (identity, elements, forces and covariance, the weather interned once, and, for a record that carries a forecast,
  the whole record's bytes copied out of the part's, as one counted allocation) and the arrays that index them. They are counted in
  the eighth statistic of `sdnap_epochs_stats` (the bytes held), so a host sees what a load in progress holds. The sort and the
  install happen at the close, as in `load_epochs`, so the decoded records of every part are held until then, and at the close the
  decoded records and the installed store are resident together: that is the high-water. Measured on sdn-ap 0.6.57 (32-bit WebAssembly
  with threads, 2 MiB initial memory, the host's staging buffer reused), 100,000 AP records, each the stored fitted 500 km record at
  the angles of a seeded mix (85 % low near-circular, 5 % medium orbit, 5 % geosynchronous, 5 % eccentric): in parts of 1,000 the
  instance (including that high-water, since WebAssembly memory keeps its high-water size) is 150,470,656 bytes (143.5 MiB), of which
  the installed store counts 112,404,152 bytes (107.2 MiB); in one call it is 6,465.8 bytes an object (616.6 MiB), the payload
  included. A record that carries a forecast holds the whole record: 3,000 such records of 13,576 bytes each, in parts of 100, hold
  15,360 bytes each while the load is open and 15,349 bytes each in the store, and the instance is 16,908 bytes an object (30,015 in
  one call, which holds the payload besides).

**14.2 Selection.** With E_0 < ... < E_{n-1} a series' epochs and t the request time: NEAREST takes the set whose
epoch is nearest t (switch between E_i and E_{i+1} at tau_i = (E_i + E_{i+1}) / 2); LATEST_BEFORE the latest set at or
before t (switch at tau_i = E_{i+1}; before E_0, set 0). Binary search: O(log n) per series and request.

**14.3 Blend.** With W = BLEND_WINDOW_SECONDS (0: no blend), around each switch tau_i the half-width
h_i = min(W / 2, (E_{i+1} - E_i) / 2) (LATEST_BEFORE also min((E_{i+2} - E_{i+1}) / 2)), so windows never overlap.
For t in (tau_i - h_i, tau_i + h_i), s = (t - tau_i + h_i) / (2 h_i), and x_a, x_b the states of sets i and i + 1 at t:

- SMOOTHSTEP: w = 3 s^2 - 2 s^3, r = (1 - w) r_a + w r_b, v = (1 - w) v_a + w v_b + w' (r_b - r_a) with
  w' = 6 s (1 - s) / (2 h_i): v is the derivative of r, and w and w' are 0 and 0 at the window's start, 1 and 0 at its end.
- HERMITE: r = r_a(t) + c(t), v = v_a(t) + c'(t), c the cubic Hermite with c = 0, c' = 0 at the start and
  c = r_b - r_a, c' = v_b - v_a (both at the window's end) at the end: set a's motion plus a correction that lands on b.

Position and velocity are continuous across the window's edges; the acceleration steps by w'' (r_b - r_a) there.

A blend joins two theory states of sets on one branch only (inside a carried span that span's set flies alone, 18.3, so
two carried forecasts never meet in a window). Every other switch tau_i is a step of x_b - x_a, as with W = 0, with the
selected set's covariance:

- two consecutive AP sets on different branches (16.7: resonance class, the 1,100-minute regime, the eccentricity switches;
  each set's from its own epoch elements): different orbits, never blended;
- a set that gives its carried forecast over the window and one that gives the theory, or a set whose forecast span begins
  or ends inside the window: a blend would be neither a forecast state nor a theory state, and every state the store gives
  is one or the other (18).

Inside the window that switch would have had, `sdnap_epochs_select` gives b = -2 (branches) or -3 (a carried forecast and
the theory) and weight 0; `propagate_epochs` writes the block's COMMENT "Not blended (SPEC 14.3): " with each switch time its
grid crosses and its reason, "(sets on different branches)" or "(a carried forecast and the theory)". Each set's own flight
is continuous in time (16.7), so a blend of two theory sets on one branch is continuous; a carried set's step at its span's
end is 18's.

**14.4 Covariance.** For sets that carry COVARIANCE (SPEC 12), P = (1 - w) P_a + w P_b + w (1 - w) d d^T with
d = x_b - x_a (the smoothstep weight for both shapes): the covariance of the two-component mixture (a blended switch,
14.3).

**One record, one covariance** *[stack #599]*. Every entry that answers a stored record's covariance takes the record's
own set as its bank's nominal (12.3's set 0), as `propagate` always has:
- **The epoch store** (`sdnap_epochs_at`, `propagate_epochs`). Set 0 borrows the store's set's term tables, one copy each.
  The store's set outlives the bank: a slot's release frees the bank first.
- **`sdnap_covariance_at`, `sdnap_covariance_full_at` and `sdnap_test_epoch_floor`.** The record's own set is moved into
  the bank.

The fit's covariance (12.1) keeps its own construction: its bank is the fit's parameter vector, whose J the fit solved
with.

Through 0.6.55 those entries built set 0 again from the parameter vector (12.1's p, then back to elements):
- set 0's elements could differ from the record's in their last bits;
- the store held a second copy of every table;
- the moved sets then matched set 0 exactly in all six elements, so their differences took other paths (12.3's flags of a
  moved set that shares the nominal's terms);
- above e 0.048, set 0 held schedule-node grids of its own (16.11);
- the three exports' returned state was set 0's.

**The moved sets are built as before,** from p moved by h. A moved set shares a table that ap_init tests bit for bit
(same_inc) only where the round trip through p reproduced the record's inclination. On 90 of the 942 stored records it
does not: there, 1,079 moved sets that did not move the inclination own their output, m-daily and zonal tables, about
27.6 KB each at 500 km. Building the moved sets' unmoved elements from the record's bits would bring the sharing back, but
it moves `propagate`'s covariance on 412 records, by up to 6.2 times its largest element, through the noise of the BTERM
column (below). It is not done.

**The measurement.** The 942 stored AP records of the synthetic set, of which 938 answer a covariance. Each was flown at
its epoch and every 30 minutes for 120 hours, TEME; test/store-covariance.e2e.mjs keeps eight of them.
- **One time to the bit.** The store's split Julian date is made as `propagate` makes it from its ISO text. The store's
  covariance then equals `propagate`'s, every element, at every instant on every record (226,058 instants). So does
  `sdnap_covariance_at`'s, given the minutes `propagate` computes.
- **Times that differ in their last bits** (the caller's split Julian date made from milliseconds, up to 0.16 µs off):
  - the store's covariance differs from `propagate`'s by up to 1.4e-3 of its largest element, with 161 records over 1e-6;
  - through 0.6.55 it differed by up to 1.46, with 213 records over 1e-6;
  - the remainder is the noise of the BTERM and AGOM difference columns on orbits that drag and radiation barely move:
    zeroing those two columns brings every record under 1e-6 (stack #624).
- **The borrowing changes nothing.** Against set 0 with tables of its own, every state, status and covariance element is
  equal (227,022 states and 8,162,496 elements, in stores of 40).
- **Against 0.6.55**, in stores of 40:
  - states and statuses are equal;
  - the store's covariance changes on 385 records: 86 by more than 1e-6 of its largest element, and up to 0.80 of it (a
    position variance at hour 103.5 on a 5,000 km perigee record at e 0.9);
  - `sdnap_covariance_at`'s and `sdnap_covariance_full_at`'s covariance changes on 381 records: 85 by more than 1e-6 of
    its largest element, and up to 0.80 of it;
  - their returned state changes on 378 records, by up to 0.15 m and 18 µm/s (47 over 1 mm); it is now the record's own
    set's;
  - `propagate`'s states and covariance are unchanged on every record.
- **At the family grids' limit** (stores of 150), 0.6.55 refuses (code 1) 11,636 states on 51 records that this build
  answers, because set 0 shares the slot's schedule-node grids. Every state both builds answer is equal.
- **At the epoch**, every entry's P(0) is 12.3's to within 3.2e-16 of its largest element.

`_stats`' bytes count the bank: its bodies, and every table and grid its sets own, each holder of a grid its share.
Through 0.6.55 the count held the propagator and its copy of the epoch covariance alone (2.2 KB of a bank of about
233 KB: 1,000 copies of a fitted 500 km record at 31/70, README), and a copy reading its anchor's grid counted none of it.

**14.5 Calls.** `load_epochs`; the resident exports `sdnap_epochs_count`, `_stats` (the load's counts and the store's
bytes), `_series` (identity and epochs), `_select` (the sets and the weight at a time), `_set_at` (one set without
selection) and `_at` (a batch of series at one time, TEME km, km/s or Earth-fixed m, m/s, with the covariance); and
`propagate_epochs`, the store of the call's own snapshot on a grid, one $OEM per series (stateless).

**Catalog memory.** A host loading a catalog should start its imported memory at 2 MiB,
subject to the module's declared minimum, and allow growth for its payload and stored sets.
The host's initial memory is a page setting, independent of the module and its store budget.
Each additional MiB of initial memory costs 1,048,576 bytes per instance; at 100,000 objects
that is 10.48576 bytes per object. The SDK harness reserves that initial region before the
module's allocations, so reducing 64 MiB to 2 MiB saves 62 MiB in these catalog loads.
WebAssembly memory retains its high-water size after payload and temporary storage are freed.
The load holds one decoded weather series at a time, interns equal rows and nodes, holds its decoded records in
blocks that grow with the records actually decoded, and sizes its entry and series arrays from the count it keeps. The host's staged payload remains part
of the load's high-water: repeated weather on the wire still occupies bytes for every record.


---

## 15. Selectable drag atmosphere (side B's option, outside the SGP4-XP specification)

**15.1 Selection.** `fit`, `propagate`, `load_epochs` and `propagate_epochs` read it from their $PCF FORCES (SDS 1.272.0);
`maneuver` and `ingest_omm` keep section 3. With no FORCES field away from its default and no 'space_weather' or
'density_correction' frame, the drag is section 3 exactly: the default is SGP4XP.

| FORCES | Density at the drag nodes of 3.4 |
| --- | --- |
| ENABLE_DRAG false (default), no rows | section 3: Jacchia 1970 on the generic flux model (3.1) |
| ENABLE_DRAG false, WEATHER_SOURCE RECORDS (or UNSPECIFIED with rows) | 3.2 and 3.3 with F, F-bar and Ap from the rows (15.2) |
| ENABLE_DRAG true, ATMOSPHERE_MODEL NRLMSISE00, rows | NRLMSISE-00 (15.3) |
| as above, DENSITY_CORRECTION DCA_COMMON_MODE, a $DCL | NRLMSISE-00 times exp(s(t)) (15.4) |

Refused by name: another ATMOSPHERE_MODEL, WEATHER_SOURCE CONSTANT and a WEATHER table, WEATHER_EXTENSION REFUSE or
FORECAST_CHAIN (UNSPECIFIED and HOLD_LAST hold the last row), DCA_COMMON_MODE without ENABLE_DRAG, a non-zero
DENSITY_CORRECTION_RELAXATION_HOURS (the $DCL's forecast nodes carry the decay), any other FORCES field but section 16's
(the last two, THIRD_BODY_MAXIMUM_DEGREE and _ORDER, included); rows that NRLMSISE-00
or RECORDS needs and that are absent (space-weather-missing); a $DCL without DCA_COMMON_MODE or the reverse
(density-correction-unselected, density-correction-missing); malformed rows or $DCL (invalid-space-weather,
invalid-density-correction); a call that evaluates a day whose previous day precedes the first row
(space-weather-out-of-range). Every set initialized during the call carries the call's atmosphere.

**15.2 Drivers.** $SPW rows (DATE, F107_OBS, F107_OBS_CENTER81, AP_AVG), plain or size-prefixed end to end, one per
UTC day (a later frame's row of a day replaces an earlier one). At d50 on UTC day d (MJD = floor(d50 + 33281)): F10.7
is F107_OBS of day d - 1, F10.7a F107_OBS_CENTER81 of day d, Ap AP_AVG of day d, each from the last row at or before
its day (past the last row that row holds). This is NRLMSISE-00's daily-Ap convention as propagator/ffm and
analysis/density-calibration read the rows; for Jacchia 1970 the three are 3.2's F, F-bar and Ap.

**15.3 NRLMSISE-00.** gtd7d of the public-domain C port in third_party/nrlmsise00 (Picone, Hedin, Drob and Aikin 2002),
every switch 1 but the output units (the daily-Ap form), the total mass density with anomalous oxygen, at the node's
geodetic latitude phi and height h of 3.4 (below 10 km, 10 km, as 3.3), its longitude alpha - theta_g (alpha the
node's TEME right ascension, theta_g = theta_g0 + omega_E t, 1.2), the UTC day of year and seconds of d50, and the
local solar time UT + longitude / 15. Above 2500 km, 1e-20 kg/m^3 as 3.3. The build gives NRLMSISE-00's 29 mutable file-scope declarations thread-local storage. Its pinned source bytes and
numerical expressions are unchanged; concurrent initializations use independent state.

**15.4 Open DCA.** A $DCL as FFM reads the open-DCA product: Solved, ATMOSPHERE NRLMSIS00E, CORRECTION LogDensityNodes
with one finite NODE_LOG_DENSITY_SCALE_DIMENSIONLESS per strictly increasing NODE_TIMES_MS (UTC). s(t) is linear
between nodes and held at the end values outside them; the density is NRLMSISE-00 times exp(s(t)) at every node.

**15.5 Fit, two-stage decoupled tesseral-null pass, and atmosphere mark.** `fit` estimates BTERM and AGOM under the
call's atmosphere, with finite-difference Jacobian fallback (`fit::jacobian_fallback`) enabled under NRLMSISE-00 and
short-span (`< 24 h`) passes. When FIT.DRAG_PRIOR is unset under NRLMSISE-00 or `< 24 h` minimum span, BTERM's
LOG_NORMAL prior takes its median by mean altitude (`0.01` below `600 km`, `0.002` at `600-800 km`, `0.0005` at
`>= 800 km`), and under NRLMSISE-00 at `800-1400 km` the sigma of the log `10 ln 10`, with 12.8's fall-back; on an arc of `71 h` or
more under NRLMSISE-00 an orbit at or below e 0.3 is judged on its perigee's height, and with the perigee at `600-2,500 km` takes
median `0.008` and sigma `10 ln 10` without the fall-back (12.8); a stated FIT.DRAG_PRIOR is
fitted as given. When `FIT.MINIMUM_SPAN_HOURS < 24` and `FIT.DEFAULT_SPAN_HOURS >= 36` on a
non-eccentric orbit without `USEABLE_START_TIME`, `fit` runs a two-stage decoupled solve: Stage 1 fits the `48-72 h`
span to determine `BTERM` and `AGOM`; Stage 2 fits the trailing `MINIMUM_SPAN_HOURS` (e.g. `17.1 h`, the `12 h` order-2
tesseral null) with `BTERM` and `AGOM` pinned to Stage 1 (`sigma = 1e-9`) and the epoch placed at cutoff (`last_useable`).
A set fitted under NRLMSISE-00 records `SDNAP_ATMOSPHERE_MODEL` (`"NRLMSISE00"` or `"NRLMSISE00_DCA"`) in
`$OMM.USER_DEFINED_PARAMETERS`; `propagate`, `ingest_omm`, `load_epochs` and `propagate_epochs` refuse a set whose mark
disagrees with the call's atmosphere (`atmosphere-mismatch`).

---

## 16. AP: an advanced propagator that builds on the entire history of astrodynamics (side B's option, outside the SGP4-XP specification)

AP is an advanced propagator that builds on the entire history of astrodynamics: $PCF FORCES selects its drag atmosphere
(section 15) and the gravity field below. Its sets are SGP4XP sets (BTERM, AGOM) that carry a mark, and it flies on the theory's
own grid.

Given the same forces, AP's first-day error against a numerical orbit is about 20 m below 1,000 km (29 to 72 m at 450 km),
12 m at 1,336 km, 4.5 m at 5,900 km, 4.5 to 7 m in medium orbits and 1 to 6 m in geosynchronous orbits; on eccentric orbits
with low perigee it is 15 to 185 m on the first day and 0.1 to 3.6 km by the seventh. A numerical propagator has no such
floor: AP equals one only where the force model limits both.

**16.1 Selection.** A fit of real data states FORCES.SOLID_TIDES IERS_2010 with the gravity terms: the Earth has the
solid tide, and without it AP's error on a low orbit after a 72 h fit is about twice as large at day 5 against a
numerical propagator that carries it (16.14). `fit`,
`propagate`, `load_epochs` and `propagate_epochs` read FORCES:

| FORCES | Terms |
| --- | --- |
| HAS_MAXIMUM_TESSERAL_DEGREE, MAXIMUM_TESSERAL_DEGREE d, 0 to 70 | the tesseral terms of 16.2, each family to its cap or d, whichever is lower |
| HAS_MAXIMUM_DEGREE, MAXIMUM_DEGREE z, 0 to 70 | the zonal tail J6 to Jz of 16.3 (z below 6: none) |
| SOLID_TIDES (`fit` only; IERS_2010, or NONE, the default) | the solid Earth tide in the rates, in the fit and the record (16.14) |
| ECOM2 (`fit` only; Y0_M_S2, every other coefficient 0) | the radiation term Y0 beside the sphere, in the fit and the record (16.13) |

With both at 0 or unset the theory is SGP4XP bit for bit. Either above 0 also selects the frame policy of 16.4 and the
third-body terms of 16.8. A degree set without its HAS field, or above 70, is refused by name.
MAXIMUM_TESSERAL_DEGREE is a cap on families, not the degree of a field.
- **Above the switch, nothing above degree 12** in the long-period regime (no resonance class and a period of 1,100
  minutes or more, above its 0.05 switch) and in the one-day, eight-hour and sixteen-hour classes above e 0.3: the flight
  carries tesseral terms of degree 2 to 12 whatever d states. The first-order families (the grid in E) and the m-daily
  family stop at 12 (16.11, 16.18), and every term above degree 12 is carried nowhere (16.20's hole of stack #497). The
  zonal tail follows z, as averaged rates only. Two branches above their switch carry more: a set with no resonance class
  and a period under 1,100 minutes carries its near-resonant terms (in the output) and its shallow resonances (in the
  rates) to degree min(d, 31); the half-day class carries its tail, degrees 6 to min(d, 31), in the rates, on both sides
  of e 0.3. The census figures are of the long-period case (no class, above both switches): at e 0.9 with its perigee at
  300 km (0.503 rev/day, i 20) a record at d 31 and one at d 70 carry the same terms, all of degree 2 to 12; 3,898 terms
  of degree 13 to 31 are carried nowhere, the largest 279 m over five days, and 1,144 of degree 32 to 70, the largest 15 m.
- **In the low table** (class 0 at or below the 0.05 switch; from 0.6.42, stack #477), with tesseral cap d above 12 the short-period terms are
  complete to first order to degree min(d, 70). |l - 2p| goes to 17, and the table's own size cut is 0.5 m. Above degree
  12 the table also holds the m-daily terms. No term is carried there inside the slow band at more than 1 - w of its
  epoch rate (w the band taper of 16.18): a first-order term is the theory only away from commensurability, so a band
  term the rates do not hold (under their size cut) is carried nowhere. At 300 km, i 70, d 70, where the 47:3 family
  drifts at 6e-3 n, the band's terms of q +-1 above degree 31 carried at full weight spiked a flight with drag to
  1,372 km (without them, or held to 1 - w, the case is 88 to 94 m). With the slow set of 16.18, which takes degree 70 whatever d states, the table also holds 1 - w of each slow
  term above d of q -1, 0 and 1. A share under 1 is cut on the term's own size. With d of 12 or less the table is the
  one of every other branch.
- **The band guard** (the low table above degree 12, a set with drag). The epoch's share holds while the term's rate stays
  where it was. The rates carry a band term at its current rate, the table at its epoch rate, and drag moves n. So the table
  takes each term's rate at two mean motions: the epoch's n0, and n_end = n0 + n-dot 8 days, with n-dot the set's own drag
  rate at the epoch and e and i held (a straight line forward over the record's span: a 72 h fit's arc and five days). It
  keeps the smaller of the two shares (1 - w at each), and none where the rate changes sign between them.
  - For n between n0 and n_end, the table and the rates never hold more than the whole term, and the table holds no term
    whose rate passes zero (the evaluator divides by the current rate). A term the guard takes from the table is the
    rates' where the slow set holds it, and is carried nowhere where it does not (outside the slow set's 1.3 bands at the
    epoch, or under its size cut). A set that barely decays keeps its epoch shares.
  - Not covered: a flight before the epoch, a flight past eight days, and decay faster than the epoch's rate (an
    accelerating re-entry, a storm in the record's rows). The catalog's fit takes the first state of its 0 to 120 h
    interval as the epoch and flies forward 5 days, so it meets only the third; a 72 h fit flown to day 7 is 10 days from
    its epoch.
  - The jump detector of test/fast-side-band-guard.e2e.mjs, on 100 flights that include each case outside the span, reads
    under 4.5 m on all but two: the test's set at BTERM 1, 2 and 4 times its own (3), the same with a storm in its rows (2),
    72 re-entering seeds flown to refusal (20 of them refused before day 1), the 21 near-circular regimes of
    test/kernel-cost.mjs 30 days forward, and 2 sets flown 3 days back. The two are re-entering seeds in the flight's last
    minutes above 100 km, and they read the same without the fast side (stack #564).
  - At perigee 200 km, e 0.01, i 55 (the 72 h fit; a truth that falls to 145 km by day 3), the m = 48, j = 3 terms of
    degree 53 to 69 (w 2 to 4, 16 terms) were inside the band's edge at the epoch (x 0.94 to 0.96). The table kept 0.08
    to 0.20 of each; the rates took the rest, and all of it once x fell below 0.9. Their rate passes zero 49.4 h after the
    cutoff, where the flight without the guard spiked to 13,161 km. With the guard D is 58,272 m, beside 57,834 m for the
    table of every other branch.
- **Where a set's table is built** (from 0.6.42). The table is filled in the building thread's scratch at its bound
  (tess::SpTableScratch: 755 KB at d 31 and 3.1 MB at 70, against 160 KB at 12) and kept at its counts (68 bytes a combined
  entry, 20 a raw one). The scratch is the thread's, never shared, grown to the largest bound it has asked for and kept for
  the thread's life. The row store's sdnap_init_elements, fit's trial sets and covariance's moved sets build on the calling thread.
  The epoch store's state-only batch also builds on pool threads, with each series' two slots owned by one thread.
  - A table taken at its bound and cut down after leaves the rest free between the sets' tables, a hole no later bound
    fits. On 1,000 rows of a catalog mix (test/set-caches.e2e.mjs's, 783 in the low table) at 31/20 the row store's build
    took 223.9 MB of memory that way, 167.4 MB of it free inside the heap, against 51.9 MB on 0.6.41.
  - Built in the scratch, the same rows take 31.5, 51.8 and 55.2 MB at d 12, 31 and 70 (0.6.41: 32.6, 51.9 and 51.9 MB,
    its table stopping at 12), linear in the number of sets (at 31: 15.2, 27.8 and 51.8 MB for 250, 500 and 1,000 rows),
    with 0.2 to 0.4 MB left free inside. The tables kept are 19.8, 26.0 and 27.2 MB (0.6.41: 19.8, 21.0, 21.0). Under the
    module's maximum of 2 GiB, with the 71.8 MB the module's memory holds before the build (its statics and tables in the
    test's host, before the first set), the build alone fits about 38,000 such sets at 31 and 35,800 at 70 (0.6.41 about
    38,000); the sets' caches when they fly (about 50 MB per 1,000 here) and a batch's reserve come on top.
  - With the reserve, the memory after the first threaded batch on 4 threads is 237.4, 257.4 and 260.9 MB at 12, 31 and 70
    (0.6.41: 238.4, 257.6 and 257.6 MB).
- **On every other branch** the first-order terms and the m-daily family stop at degree min(d, 12). They are not complete to
  it: in the resonance classes and the long-period regime the table leaves out every term within one shallow band (0.045 n)
  of commensurability, and above the eccentricity switch the families are the grid's. Degrees 13 to min(d, 31) contribute
  only: in class 0 with a period under 1,100 minutes, the j = 1 near-resonant terms and the shallow set; in the half-day
  class its tail; in the one-day class at e 0.3 or below its tail (degrees 5 to 31). Everywhere else nothing above degree 12
  is carried, whatever d states.
- **What the degrees 13 to 70 carry in low orbit** (#498's near-circular cases at 300 to 650 km, the record fitted to a
  70 x 70 numerical forecast over 5 days, gravity only on both sides, AP at 70): D falls from 63 to 233 m to 35 to 148 m.
  The terms are along-track and radial lines at once per revolution plus or minus about once a day, and the daily and
  twice-daily m-daily lines.
- **What a record at d of 31 forgoes**: the terms of degree 32 to 70, which a family whose order is 31 or less also has.
  With every force and the record fitted to the numerical forecast, D at 300 km, i 98 is 104 m at d 31 and 85 m at d 70;
  at 300 km, i 55 152 and 142 m; at 400 to 650 km the two are within 4 m of each other.
- **Off the low table** at 800 km, the terms of degree 13 to 31 not carried are 14 m RMS (18.9 m in all against a 31 x 31
  field).

Through 0.6.20, at 450 km the order-15 terms above degree 31 added 72 m on day 1 and 268 m on day 7 after a 72 h fit. From 0.6.25 a fit in the low table that states d of 2 or more also carries the slow set of 16.18 in the
rates, to degree 70 whatever d states: d governs the fast terms, and a commensurability's series is a cancellation, so a slow
set cut at a lower degree is worse than none.
`maneuver` and `ingest_omm` keep SGP4XP.

**16.2 Tesserals.** The field is the fully normalized EGM2008 of propagator/ffm (`lib/egm2008_data.h`, to degree and order
70), pinned by build.mjs; through 0.6.34 it was EGM-96 (`lib/egm96_data.h`).

*Why EGM2008 (from 0.6.36; stack #503).* The numerical propagator AP is held to flies EGM2008: its SPHERICAL_HARMONICS field is
the embedded EGM2008, and EGM96 is an option only. EGM2008 (Pavlis et al. 2012; the model of the U.S. National
Geospatial-Intelligence Agency, published by it and distributed by ICGEM; its license basis is recorded in NOTICE as
unresolved, as the EGM96 model's is) is also the closer field to
the real Earth. Below degree 30 or so the two fields agree closely. Above it they part, and an AP term of high degree fitted to
an EGM2008 truth was a term of the wrong field. The measurement: 300 km, i 98, e 0, with gravity, Sun, Moon and tide on both
sides, AP fitted to the numerical forecast over 0 to 5 days. D is the largest distance over those 5 days; the line is the
along-track residual's first harmonic over the span (0.2 per day). AP's slow set is capped on AP's side only. 0.6.32 is AP
on EGM-96; the EGM2008 rows are this change's first build (git 7ebc98e4, not a release), whose states 0.6.36 flies bit for
bit:

| AP's slow set to degree | 31 | 46 | 48 | 52 | 56 | 62 | 70 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.6.32, truth EGM2008: the line, m | 333 | 27 | 21 | 36 | 56 | 72 | 76 |
| 0.6.32, truth EGM2008: D, m | 451 | 173 | 174 | 186 | 187 | 203 | 206 |
| 0.6.32, truth EGM-96: the line, m | | 31 | | | | | 28 |
| 0.6.32, truth EGM-96: D, m | | 164 | | | | | 180 |
| 7ebc98e4, truth EGM2008: the line, m | 335 | 18 | 13 | 45 | 17 | 33 | 33 |
| 7ebc98e4, truth EGM2008: D, m | 453 | 166 | 179 | 188 | 165 | 176 | 182 |

With the fields apart, every degree AP added above 48 made the line worse. With them alike, on either field, the line at
degree 70 is 28 to 33 m and D 180 to 182 m. The field cut to 12 x 12 on both sides gives D 34 m on both versions. The rest
of D at this height is not the field: the field moves AP's flight there by at most 1.2 m in any line of the residual.

*What changes and what does not.*
- Changed: the fully normalized C_lm, S_lm the tesserals read (degree 2 to 70, order 1 and up), and the zonal tail's C_l0
  (degree 6 to 70, 16.1).
- Unchanged: mu (k_e of 1.3); the reference radius 6378.1363 km, the same in both fields; J2 to J5, which are 1.3's
  constants, not the table's. AP reads no C_20 from the table, so the field's tide system does not enter. The numerical
  propagator states its EGM2008 with GM 398600.4415 km^3/s^2 and the same radius.
- SGP4XP reads none of this. Its resonance terms are 6.2's unnormalized EGM-96 values, and its zonals are 1.3's. The table
  (kEgmC, kEgmS) is read only by the AP terms of tesseral.inc and by the census (16.20). SGP4XP is bit for bit.
- The resonant classes' own terms (6.1, degree 2 to 6) read 6.2's values in AP's flight too, so they keep EGM-96. There the
  two fields differ by 8.9e-5 to 5e-4 of a term (1.8e-3 at (6, 3)). J2 to J5 are 1.3's EGM-96 values; the numerical
  propagator's EGM2008 takes its own, which differ from them by 4.7e-7, 9.7e-5, 1.7e-4 and 2.0e-3 of each. Measured with the
  rest alike (J2 to J5, the Sun and Moon on both sides, AP fitted to the forecast): the largest distance over 5 days moves by
  at most 0.6 m between the two truths, over 19 near-circular and e 0.05 orbits from 300 to 1,400 km. By degree, the rms difference of the two fields over the
  rms of the field is 0.003 at degree 10, 0.05 at 20, 0.11 at 30, 0.17 at 40, 0.21 at 50, 0.23 at 60 and 0.30 at 70.
- The record states the field: PERTURBATIONS.GRAVITY_MODEL is "EGM2008" on an AP set with gravity terms, and "EGM2008; slow
  tesseral terms to degree 70" with the slow set. SGP4XP's sets and a stock AP set keep "EGM-96".
- From 0.6.36 a flight refuses an AP set with gravity terms whose GRAVITY_MODEL is neither of those texts, or absent
  (gravity-model-mismatch): a record fitted on another field is fitted again, never flown on this one. Every AP record
  with gravity terms written before 0.6.36 states "EGM-96" (or "EGM-96; slow tesseral terms to degree 70"), so every such
  record is refused. SGP4 and SGP4XP sets are not checked: their fields are the theory's own (1.3, 6.2). Nor is an AP set
  with both gravity degrees 0: it flies SGP4XP's theory and reads no table, so its "EGM-96" is the theory's.

Inclination functions come
from the Fourier coefficients of the normalized Legendre recurrence, stable to degree 70, at the epoch inclination. The Cap column is a cap on families, not the degree of the field (16.1): at
800 km the terms of degree 13 to 31 not carried are 14 m RMS.

| Family | Terms | Cap | Where |
| --- | --- | --- | --- |
| m-daily | Kaula's q = 0, l = 2p, even l, every m | 12 (in the low table above 12, the first-order table's to d) | at output time, first order at the mean elements |
| first-order | every other q in {-1, 0, 1} with \|j\| <= l + 1: the q = +-1 terms are O(e) in G and O(1) in the eccentricity vector, so they carry the radial m-daily signal and, for odd l with j = 0, a line amplified by n / psi-dot | 12; in the low table d to 70, \|l - 2p\| <= 17, by the 0.5 m size cut | at output time, first order at the mean elements |
| near-resonant | j = 1 above that degree, at orders whose angle drifts slower than 0.2 n: q = 0 with w = 1 outside the shallow band, q = +1 with w = 0, q = -1 with w = 2 | 31 | at output time; class 0 with a period under 1,100 minutes only (the resonance classes and the long-period regime carry none) |
| half-day resonant tail | l = 6..d, every even m <= l, p = 0..l, k = m/2, q = k - l + 2p; 5,291 additional terms at degree 31 | 31 | in the rates of the half-day class; excluded from the output-time table |
| one-day resonant tail | l = 5..d, every m from 1 to 16, p = 0..l, k = m, q = m - l + 2p (below e 0.05 only \|q\| <= 8) | 31 | in the rates of the one-day class at epoch e at or below 0.3; excluded from the output-time table |
| shallow resonances | k = 1, q = 0, l = 1 mod 2, m from 2, angle drifting slower than 0.045 n | 31 | in the rates, each (k, m) tapered by its current distance from commensurability; class 0 with a period under 1,100 minutes only (the resonance classes and the long-period regime carry none) |
| slow set (from 0.6.25) | j = 1 to 6, \|q\| up to 4 (from 0.6.27; q = 0 in 0.6.25), every order and degree whose own angle drifts within 1.3 x 0.045 n at the epoch and whose size reaches 0.5 m (through the mean motion, or from 0.6.27 through the eccentricity vector), the shallow set's own terms aside | 70 | in the rates of a fitted set in the low table, each term tapered by its own current rate; the output table holds the rest of a tapered term (16.18) |

A first-order or near-resonant term is left out when section 6's class or the shallow set carries it in the rates (the shallow set
by the same taper, so a term crossing its band moves from one to the other), when its angle drifts slower than 0.001 n (class 0
with a period under 1,100 minutes; in the resonance classes and the long-period regime, slower than one shallow band, 0.045 n), and when
its position amplitude is below 0.5 m. G is g0 + g1 e about the epoch e: below e = 0.03, q = 0 takes 1 + (l (l + 1) / 4 - w^2) e^2 and
q = +-1 takes ((l + 1) / 2 + q w) e, above it the Hansen coefficient.

Below the eccentricity switch (0.05 in class 0, 0.3 in the resonant classes) the first-order tesseral table keeps |q| <= 1. The
terms dropped are of order e^2 and reach, just below the switch, 14 m at a = 7,600 km (20.6 m against 15.2 m just above it), 12 m
in a 12-hour orbit (13.5 against 6.7 m) and 7.5 m in a geosynchronous orbit (7.6 against 1.1 m), RMS over a 72 h arc.

Section 6's classes keep their terms: the epoch class's, in the rates, for the whole flight (16.7). F is evaluated at the current inclination with the exact dF_632/di;
G_410 has e^2 coefficient 1, dG_40,-2/de includes its e^13 and e^15 terms, and G_30,-1 includes its e^27 term.
When the local Hansen expansion of 6.4 is selected, G for the original resonance terms is exact at the epoch eccentricity to numerical-integral
precision and third order within |de| <= 0.02, as specified in 6.4. The measured per-term relative errors
are 1.1e-4 at |de| = 0.01, 1.5e-3 at 0.02, and 4-15% at 0.05. The Laplace limit does not supply a validity bound for this local expansion.

The half-day tail uses cubic expansions of F about the epoch inclination and G about the epoch eccentricity,
with their consistent derivatives. F comes from the normalized Legendre recurrence; G comes from shared
eccentric-anomaly quadrature. The class's original 29 terms retain their exact inclination functions.

The one-day tail (from 0.6.19; stack #434) is built and evaluated the same way, with k = m: its angle is
w omega + m (M + Omega - theta_G). Its orders run from 1 to 16; at e at or below 0.3 the amplitude cut that ends both
tails (about 2e-16 m/s^2) stops it below degree 15, so no higher order would pass. The inclination quadrature reads which
part of each Fourier coefficient a term takes (real for l - m even, imaginary for l - m odd) from w + m. Through 0.6.18 it
read it from w alone, which holds only for the half-day tail's even orders; for odd orders it would zero the main terms.
The half-day tail is unchanged bit for bit. Sets of the class above e 0.3 (the grid branch, 16.11) do not take the tail:
there the class carries degrees 2 to 4 only, as before (THEMIS-like orbits, whose error is elsewhere).

Through 0.6.18 the one-day class carried resonant gravity of degrees 2 to 4 only, and the output table drops every term
slower than 0.045 n, so on a geosynchronous orbit degree 5 and up was carried nowhere. Each missing term acts as a
constant along-track acceleration set by the longitude, mostly through (5,5), (5,3) and (5,1). Model truth: FFM 20 x 20
with Sun and Moon on both sides, made-up sets at 2026-10-29, a 72 h fit, 7 days flown, whole-day 3D RMS.

- Geostationary (e 0.0002, i 1.5, 12 longitudes): day 7 16.9 to 136.1 m (median 67.1 m) on 0.6.15, against 8.5 to
  11.1 m (median 9.0 m) with the tail. The constant along-track acceleration fitted to each forecast's error, less the 4 x 4
  run's, matches EGM96's degree 5 to 20 value on the same orbit to within 2.1e-12 m/s^2 at every longitude.
- With the field cut to 4 x 4 on both sides (where no tail is built), the 20 x 20 day-7 error is now within 0.05 m of the
  4 x 4 one at every longitude. The same holds on inclined geosynchronous sets (i 55, e 0.003 and 0.075, 6 nodes), where
  the maximum falls from 49.7 and 44.5 m to 25.9 and 23.9 m. One node gets worse (11.8 to 25.9 m at e 0.003): there the
  missing terms had partly cancelled the Moon's floor (stack #446).
- Class members off 1:1 (n 0.82, 0.90, 1.10, 1.18 rev/day; e 0.001, i 30; 4 nodes each), whose degree 5 to 12 terms
  move from the output table into the rates, lose nothing: day 7 moves by -0.18 to +0.38 m.
- The output stays continuous: the 10 s jump detector's worst reading over a day is 0.36 to 0.89 mm on geostationary,
  inclined and off-1:1 sets, against 0.36 to 0.91 mm before.

What is left at 4 x 4 is AP's analytic Moon (stack #446): 7.3 to 8.0 m cross-track at day 7 on geostationary sets, 5.4 to
25.9 m on inclined geosynchronous ones, and 1.1 to 3.6 m and 1.2 to 2.5 m with DE440's Moon in a scratch build.
`test/one-day-resonant-tail.e2e.mjs` checks the 20 x 20 against the 4 x 4 level (0.5 m); `test/one-day-moon-floor.e2e.mjs`
is #446's known defect.

**16.3 Zonal tail.** J6 to Jz in the rates, first order, with F and dF/di at the epoch inclination. At epoch eccentricity
e0 at or below 0.3 the tail carries the secular terms of even l (w = l - 2p = 0, q = 0), the w = +-1 long-period terms
of odd l, and the long-period terms with 2 <= |w| <= 6 (q = -w, even w on even degrees and odd w on odd degrees).
The secular and w = +-1 terms retain their epoch linearization. Each added term has G = e^k (a + b e^2), k = |w|,
matching the value and analytic slope of the finite Hansen sum at its eccentricity anchor:

X_0^{-(l+1),k}(e) = (1 - e^2)^-(l - 1/2) sum_d C(l-1, 2d+k) C(2d+k, d) (e/2)^(2d+k), 2d+k <= l-1.

G and its derivative are exactly zero when k > l - 1, including J6 at |w| = 6. The factor e^k preserves the circular
limit. The cell width is 0.002 and anchor(e) = 0.002 (floor(max(e, 0.01) / 0.002) + 0.5), a function of the state
alone. The immutable table stores a and b at anchor(e0). A state in that cell reads them; a state in another cell
uses coefficients at its own cell center. The coefficients are cached independently of semimajor axis and inclination,
so changing a does not repeat the closed-form Hansen calculation. The largest eccentricity offset is half a cell,
0.001, for e >= 0.01; smaller e uses the floor cell. Value and slope are exact at the anchor before float rounding.

At anchor 0.299, the full half-cell tests give these maximum relative errors against the closed form (all retained
harmonics; the worst degree in the 6 through 70 sweep is 70):

| Degree | Value error | Slope error |
| --- | ---: | ---: |
| 6 | 0.000008764 | 0.001664251 |
| 20 | 0.000211703 | 0.015332648 |
| 70 | 0.004325949 | 0.086896650 |

A five-day crossing flight starts at hp300 km, e0 0.04999, i55, BTERM 0.0064 m²/kg, with zonal70/tesseral0 and
Jacchia70. The mean e crosses 0.05 at 604.281828 minutes. Its one-second position second difference is 8.918317 m;
ten seconds away on either side it is 8.915952 and 8.920569 m. The excess against their vector average is 0.000682 m
(bound 0.01 m). All 1,441 five-minute states are identical in time, reverse and fixed shuffled order.
The hp400/i55 same-field pair with seed e0 at 0.049, 0.04999999 and 0.05000001 has maximum 3D errors
14.494390, 14.519855 and 14.519963 m. Across the boundary placements the maximum difference of AP-minus-FFM residual
vectors is 0.004882 m over five days (bound 0.1 m); removing each truth's physical displacement isolates the residual.
These are seed placements for forecast-span fits, not assertions about the fitted record's eccentricity.

A covariance bank's moved sets read the nominal's table. Its |w| <= 1 entries are linearized at the nominal's e0.
At the same inclination and e0 2e-4 apart, that legacy dependence changes a five-day flight by up to 1.854 m compared
with a separately built table; restoring only the moved set's legacy entries removes the difference to the bit.
The |w| >= 2 contribution depends on the state's cell alone: the probe asserts identical bits under both owners
and in their borrowing sets, including states outside an owner's epoch cell. Shared inclination functions do not
change with the owner eccentricity.

The cutoff at |w| = 6 is tested near e 0.3 (stack #595): keeping only |w| <= 2 left 15 to 19 m in the earlier controlled
measurement. The five-day e0 0.2999 comparison with a full-zonal-harmonic control at identical elements is 0.796426 m
(bound 1 m); the explicit kTailW assertion also fixes the retained range. This control comparison increased from
0.270331 m before the cell grid because the value-and-slope form can start half a cell from its anchor at the epoch.
There is no above-switch comparison of the wide path with itself.
At e 0.3 and degree 70, G7/G6 is 0.664618 and G8/G6 is 0.415383: neglected Hansen factors can be 40 to 66 percent
of the last retained factor. Parity selects the allowed harmonics. Their small orbital effect depends on the degree
weight (R/a)^(l+1), not on G alone. On identical unfitted hp400/e0.05/i55 and hp300/e0.01/i55 elements, the final grid
and the full-zonal control differ by at most 0.312826 and 0.265429 m over five days. These figures, and the 0.796426 m
near-switch figure, include both the coefficient approximation and harmonic truncation; they are not a measurement
of omitted terms alone.

The same-field hp400/e0.05/i55 pair is fitted over days 0 to 5 with degree70/order0, solid tide, drag and radiation off.
The numerical truth also carries Sun, Moon and relativity. Compared with the module before this change, day-1/day-5
once-per-revolution in-track amplitudes fall from 97.971729/101.574079 to 2.979972/2.126085 m, and maximum 3D error
from 126.299846 to 14.515642 m. For hp300/e0.01/i55 the amplitudes fall from 36.806399/39.517290 to
3.315113/2.893981 m and 3D error from 50.914278 to 15.180303 m. The same-field tests use pinned FFM 2.3.0 truths,
GCRF, UTC and 300 s sampling; their bounds are 10 m for day-1/day-5 amplitudes and 20 m for maximum 3D error.

Cost increases in the measured fits and some cold calls. At degree70 the low-e table grows from 97 to 423 entries
(confirmed by zonal_count), four floats per entry: 1,552 to 6,768 bytes per set, an increase of 5,216 bytes.
The cell coefficient cache holds two float arrays indexed by degree and harmonic, plus its anchor and degree,
3,992 bytes per thread. The inclination work array is 16,128 bytes; the rate cache holds 123 doubles plus keys.
Alternating 0.6.48 and this build twice on identical five-day, degree70/order31 FFM fits with drag and radiation
constrained to zero gives hp300/e0.01/i55 0.984052 to 1.222542 s (1.242354 times, 26 to 27 iterations) and
hp800/e0.05/i20 10.376655 to 18.213401 s (1.755229 times, 25 to 23 iterations). These timings do not isolate
closed-form calculation from other fit work.

State costs below compare 0.6.48 with this build: two alternating rounds, five repetitions per round, the mean of
round medians. Warm times use process CPU time for a seven-day sweep; cold times use wall time for a first call
after loading the record. Both use zonal20, NRLMSISE00 and synthetic quiet weather; near-circular cases use
tesseral31. The final case has BTERM 0.0064 m²/kg, AGOM zero, i55 and tesseral0; its semimajor axis decreases and
e rises from 0.04999 to 0.050267301 over seven days, leaving anchor 0.049 for 0.051 by day one.
The host was under load; especially the cold wall times include scheduling variability. No general zero-cost
claim follows from these measurements.

| Orbit | Warm 300 s, µs/state | Warm 60 s, µs/state | Cold day 1, µs | Cold day 7, µs |
| --- | ---: | ---: | ---: | ---: |
| 300 km, e 0.001 | 0.970 → 0.991 | 0.888 → 0.817 | 1357.375 → 1396.875 | 5634.438 → 7724.271 |
| 830 km, e 0.001 | 0.883 → 0.866 | 0.769 → 0.746 | 1027.375 → 600.667 | 1017.208 → 1082.062 |
| hp500 km, e 0.05, tesseral 0 | 0.410 → 0.372 | 0.368 → 0.368 | 464.750 → 504.625 | 2715.313 → 2794.354 |
| hp500 km, e 0.2, tesseral 31 | 29.139 → 32.124 | 29.051 → 29.101 | 595.563 → 609.646 | 5251.751 → 2919.167 |
| hp300 km, e 0.04999, decaying | 0.364 → 0.390 | 0.334 → 0.336 | 594.021 → 632.708 | 3697.333 → 6262.855 |

Above e0 0.3 every long-period term and its existing linearized G remain as 16.11 defines them. These are mean-element
rates only: section 8's output map has no added zonal-tail term. SGP4XP and SGP4 select no AP zonal tail.
`test/zonal-long-period.e2e.mjs`, `test/zonal-long-period-table.e2e.mjs`, `test/zonal-cell.e2e.mjs` and
`test/zonal-cell-placements.e2e.mjs` cover the model pairs, finite sum, half-cell envelope, switch, crossing,
query order, sharing and epoch seed placements. Shared per-set tables are immutable; re-anchoring changes
only the evaluating thread's caches.

**16.4 Frame.** Frame policy is selected once, by `ap_init`, from the record's gravity terms. With d or z above 0,
every AP set carries its epoch-axis states to TEME of date by M(t) M(t0)^T: from 0.6.34 the long-period regime's class 0
sets too (below). M is the GCRF-to-TEME matrix
of `gcrf.inc`, linear between 12-hour nodes: at most 5.6e-9 rad, 0.23 m at the geostationary radius. The Earth's axis is held
at its epoch direction during a flight. With precession alone the error from the epoch is 0.1, 0.8 and 4.1 m at 1, 3 and 7
days at 800 km and 0.2, 1.7 and 9.0 m at 1,336 km, up to twice that with the fortnightly nutation, and below 1 m from 5,900 km
up.

*The long-period regime's class 0 sets (from 0.6.34; stack #479, #513).* Through 0.6.33 the nonresonant long-period
branch (epoch period at least 1,100 minutes, class 0) left this rotation out. The one-day and sixteen-hour classes cover
the long-period periods from 1,100 to about 1,795 minutes and already took it, so the sets that change are the AP sets
with epoch periods of about 1,795 minutes and more. Their output kept the turn from TEME of the epoch to TEME of the
date: 0.70 arcsec in 5 days and 0.98 in 7, times the radius. That is up to 1.27 km at day 5 at a TESS-like apogee of
375,000 km. Measured on model truth (FFM, `test/lib/heo-model-truth.mjs`), the seeded TESS-like set (4 x 4 gravity, the
Sun and Moon off on both sides, no fit) was off the numerical propagator by 1,769, 884 and 1,805 m at day 7 on three
nodes. With the turn M(t) M(t0)^T applied to its TEME states, they are off by 1.7, 2.0 and 2.0 m: the "zonal" error of
that orbit was this rotation, all of it. Fitted over the forecast's 5 days with the full synthetic setting (0.6.30):
- TESS-like: 99.9 to 55.4 m.
- Chandra-like (63.5 h, e 0.685): 114.6 to 66.8 m.

Fitted over 5 days to FFM with J2 to J5 and the Sun and Moon, e 0.9 with perigee 5,000 km
(`test/long-period-moon-output.e2e.mjs`): 255.8 to 11.4 m.

A record of such a set written by 0.6.34 or earlier states GRAVITY_MODEL EGM-96 and, from 0.6.36, is refused
(gravity-model-mismatch, 16.2); on 0.6.34 such a record written by 0.6.33 or earlier flew with the turn. Its elements were
fitted without the turn and took up part of it (a false area-to-mass, below), so such records are fitted again.

Against the numerical forecast on the real windows (0.6.30, the change off and on; the record fitted to the forecast,
D over 0 to 120 h), Chandra's seven windows go from a median of 96 m to 10 m (4 to 7 of 7 within 100 m), and TESS's from
329 to 172 m. The one-day class (THEMIS) already took the rotation and is unchanged.

The real windows against their precise orbits neither support nor contradict the change on TESS. TESS fires its thrusters
about weekly, six times in the span, by 7 to 11 mm/s; 10 mm/s moves the orbit by about 4 km in 5 days. In six of the
seven windows a firing lies in the 72 h fit arc (four windows) or within 13 hours after the cutoff (two); the seventh
has none within the first six days. In six of the seven the reference also changes from one ephemeris file to the next
13 hours after the cutoff, with a step of 17 to 221 m. `test/heo-frame.e2e.mjs`'s replay of those windows (the
module's default fit of the 72 h of states, no drag, the RMS over each day) goes from medians of 775.7, 1,635.8 and
8,549.6 m to 1,011.7, 2,000.0 and 9,032.8 m at days 1, 3 and 7, and AP minus XP at day 3 from -103.1 to +706.0 m (its
known defect, stack #479; XP takes no drift, so it keeps the turn). The replay fits AP to a series half of whose states
are a straight-line fill between the reference's 10-minute solution states, up to about 1 km off the orbit. On those
solution states alone (the test's reader since stack #479, comment 6808033865; 600 s), 0.6.34's replay is 389.6, 1,869.1
and 15,422.3 m for AP and 784.3, 2,492.8 and 12,076.4 m for XP at days 1, 3 and 7, with AP minus XP at day 3 at -810.1 m.
In the four windows whose fit arc holds or ends at TESS's perigee, where the fill lies farthest off the orbit, both
theories are worse at day 7: AP 6.2 to 22.4 km against 3.1 to 10.3 km on the fill. The other three windows move by less
than 0.6 km. The comparison with the archived AP6 arms stays on the reading those arms were scored on.

From 0.6.41, with radiation pressure through the output map (16.22), the replay on the solution states is 333.6, 1,631.4
and 11,782.0 m for AP at days 1, 3 and 7 (0.6.37: 389.6, 1,867.7 and 15,409.5 m), with AP minus XP at day 3 at -1,671.3 m.
On the archive's reading it is 1,014.8, 2,245.8 and 5,037.3 m (0.6.37: 1,011.7, 2,000.1 and 9,032.8 m), so day 3 is above
the archived 2,009 m. With AGOM held at 0 the two builds fly the same replay to 0.01 m (1,505.7, 6,462.2 and 42,488.5 m):
the difference is the radiation term's alone. On the fill, in the three of the seven windows that are worse at day 3, the
fitted AGOM moves from the solution states' fit by -8 to +48 %, and from 0.6.41 that AGOM acts in full on the forecast.

On model truth the rotation is right, and its partner is radiation pressure. Seeded with every force but drag and
radiation, a TESS-like set goes from 1.0 to 1.8 km to 20 to 37 m from FFM at day 7. On the 72 h fit path without
radiation pressure in the truth, its 5-day D goes from 1.3 to 2.9 km to 16 to 251 m; through 0.6.33 the fit took up the
turn as a false area-to-mass. With FFM's radiation pressure in the truth, AP follows FFM's 72 h no closer than 46 to 174 m
on either build, and the frame's error had partly offset that gap in some geometries.

A covariance's copy takes the same rotation through the same flag. The bodies the rates read stay in TEME of date: 0.7
arcsec in 5 days moves the Moon's direction by 3.4e-6 rad.

Fit residuals and propagation share `xp_propagate`, including this policy; there is no separate fit-only
rotation. GCRF fit inputs are converted to TEME at each sample date, and GCRF output converts the propagated
TEME state at that date. The output's GCRF-to-TEME matrix (`propagate`, `propagate_epochs`; EME2000 through it) is the
quintic through the matrix at the six 6-hour nodes about the date (UTC quarter days, held per thread), each node the
same IAU 2006/2000A chain with GMST82 summed without gmst()'s rounding: one IAU 2000A nutation series per 6 hours of
output, not one per state, and a function of the date alone. Against the per-state chain with GMST82 in exact
arithmetic it is off by at most 0.0042 mm at the geostationary radius; the per-state matrix it replaces was off by up
to 1.5 mm there (gmst()'s rounding: up to 3.6e-11 rad), and the two differ by at most 1.6 mm and 1.2e-4 mm/s (SGP4
sets with epochs from 2020 to 2035, 7 days each; test/output-frames.mjs). A GCRF state then costs what a TEME state
costs, against about 31 µs with the matrix at each state; a one-state call at a date whose nodes are not yet held
computes six nodes. The fit's GCRF inputs keep the matrix at each state. GMST82 itself (gmst(), store.inc) sums its
polynomial in seconds of time near 8e8 s and turns that into radians near 6e4 rad, so it is off GMST82 in exact
arithmetic by up to 3.6e-11 rad (1.5 mm at the geostationary radius), an error that changes from one instant to the
next (2020 to 2035, test/output-frames.mjs); the fit's GCRF inputs and every Earth-fixed state (TEME to Earth-fixed by
gmst()) carry that rounding. Default FORCES retains the XP path bit for bit. The one-day class retains its frame
correction and 38-minute grid; the half-day and GTO fixtures retain their previous paths.

The exploratory AP6 replay on 2026-11-03 uses all seven previously read TESS windows, 72-hour fits, the
original 300-second grid, and AP6's pinned foundation/frames conversion for scoring. Leads start at fit end.
The day-3 median paired AP-minus-XP error changes from +420.105792 m to -0.000784 m (acceptance: within
50 m of zero). That replay set the long-period class 0 sets' exception through 0.6.33. It was judged on matching
SGP4-XP, which takes no drift, not on the precise orbits or on a numerical propagator.
From 2026-11-11 the archive replays (heo-frame's TESS windows and the AP6 and AP5 windows of five more tests) score each
module's own GCRF output (DigitalArsenal/spacedatanetwork-stack#386). The pinned foundation/frames 0.2.0 places TEME's x
axis by GMST06, not GMST82 (#389): its conversion of AP's TEME output sat 1.9 m from the module's GCRF output in low orbit,
7.3 m at 12 hours and 11.6 m at the geostationary radius. Through foundation/frames 0.3.0 the same TEME output lands within
5 µm of it on the GNSS orbits and 26 µm at TESS's radius. On 0.6.14 the TESS day-3 median paired AP minus XP is -137.5 m on the module's GCRF and -137.0 m on the old path;
the old path's figures are kept beside each test's.

| Fit end UTC | Previous AP day 3 (m) | AP day 3 (m) | XP day 3 (m) | AP minus XP (m) |
|---|---:|---:|---:|---:|
| 2026-07-27 | 2009.249179 | 1280.596477 | 1280.868413 | -0.271936 |
| 2026-08-03 | 2496.529273 | 2684.873011 | 2684.869564 | 0.003447 |
| 2026-08-10 | 1463.232922 | 1214.681850 | 1214.683662 | -0.001812 |
| 2026-08-17 | 1211.231855 | 791.128364 | 791.126063 | 0.002301 |
| 2026-08-24 | 1850.254952 | 1385.636736 | 1385.640624 | -0.003888 |
| 2026-08-31 | 2017.233821 | 1833.692391 | 1833.693176 | -0.000784 |
| 2026-09-07 | 2157.517187 | 1574.829241 | 1574.457639 | 0.371603 |

`test/heo-frame.e2e.mjs` prints every window and all four synthetic HEO fixtures from the half-day test.
Their day-1/3/7 3D errors change by 0.000 m (acceptance: less than 1 m); the half-day day-7 error remains
104.725 m. XP reproduces the archived AP6 scores within 0.001 m and retains its conformance digest.
`test/results/heo-frame.json` records the per-window errors, fixture checks and kernel hashes.
From 0.4.9 an AP set keeps its full precision while an XP set keeps the two-line lattice (16.9): on the same seven
windows AP then leads XP by a median 137.5 m at day 3 (per window -298.4 to +101.0 m). The E2E requires AP no more than
50 m behind XP, and the fixtures it checks carry their 0.4.11 values.

**16.5 Mark.** A set fitted with either degree set records `SDNAP_GRAVITY_TERMS` (`"<d>,<z>"`) in
`$OMM.USER_DEFINED_PARAMETERS`. `propagate`, `load_epochs` and `propagate_epochs` refuse a set whose mark differs from the call's
degrees, and `ingest_omm` any marked set (`gravity-terms-mismatch`).

**16.6 HEO model truth.** Synthetic GCRF states at 2026-10-29 00:00 UTC, fitted over 72 h through `fit`,
then propagated 1, 3 and 7 days after the fit ends. FFM uses EGM2008 70x70 (EGM96 70x70 through 0.6.34), Sun and Moon
from DE440, zero EOP,
no SRP, and NRLMSISE-00 only for Molniya (Cd A/m = 0.044 m^2/kg; constant F10.7 = 150, Ap = 15).
AP uses FORCES 31,20. Initial states, kernel and module hashes, signed errors and numerical-reference checks
are in `test/results/heo-model-truth.json` (2026-11-03; current[] re-registered on 0.6.36 on the EGM2008 truth, 0.6.22's
figures beside); `test/heo-model-truth.e2e.mjs` reproduces the comparison.

All cases start at perigee, with argument of perigee 270 degrees. The half-day and Molniya cases have RAAN
300 degrees; GTO has RAAN 40 degrees. These are measured cases, not bounds for all HEO objects. The published
fit rounds its elements to the two-line lattice.

| Case (n rev/day, e, i degrees) | Lead days | R, T, N error (m) | 3D error (m) |
| --- | ---: | --- | ---: |
| Half-day (2.0059, .72, 63.4) | 1 | 185.012, -239.084, -16.201 | 302.743 |
| Half-day (2.0059, .72, 63.4) | 3 | 89.080, -111.146, -32.278 | 146.050 |
| Half-day (2.0059, .72, 63.4) | 7 | -73.019, -37.280, -65.160 | 104.725 |
| Molniya (2, .74, 63.4; drag on) | 1 | 73.173, 29.515, -16.047 | 80.516 |
| Molniya (2, .74, 63.4; drag on) | 3 | 39.674, -125.204, -21.271 | 133.051 |
| Molniya (2, .74, 63.4; drag on) | 7 | 366.657, -540.558, -34.603 | 654.092 |
| GTO (2.40, .72, 27) | 1 | 92.703, -148.066, -114.320 | 208.773 |
| GTO (2.40, .72, 27) | 3 | 75.410, -19.887, 36.370 | 86.052 |
| GTO (2.40, .72, 27) | 7 | -1556.157, -1727.365, -88.427 | 2326.636 |
| 12-hour (2, .72, 55) | 1 | 157.566, -109.427, -46.725 | 197.445 |
| 12-hour (2, .72, 55) | 3 | 2.212, -19.735, -77.195 | 79.709 |
| 12-hour (2, .72, 55) | 7 | -176.410, 22.747, -62.891 | 188.661 |

The half-day case measured 3,116.083 m at day 7 before the degree-31 tail and 104.725 m with it. At 0.4.11 (5.4's
quadrature, 16.8 at every eccentricity) the 3D errors at days 1, 3 and 7 are 123.8, 121.4 and 202.0 m (half-day),
208.3, 253.4 and 338.0 m (Molniya), 253.7, 112.3 and 2444.4 m (GTO) and 139.7, 177.2 and 303.2 m (12-hour 55 deg); the
half-day day-7 sample falls 1 h after a perigee, and `test/heo-model-truth.e2e.mjs` pins it within 0.5 m. Flown
hourly, the day-7 whole-day RMS along-track/radial is 84.2/75.3, 149.8/175.9, 960.8/935.3 and 158.0/105.5 m (0.4.10:
228/85, 687/391, 885/860 and 232/60 m); `test/third-body-short-period-eccentric.e2e.mjs` checks them. From 0.4.14
the half-day class's step (16.10) brings GTO to 237.8, 175.8 and 924.7 m and 419.3/455.9 m whole-day. From 0.4.15 (16.11)
the four are 27.5, 70.0 and 60.1 m (half-day; the sample `test/heo-model-truth.e2e.mjs` pins), 45.9, 27.0 and 419.4 m
(Molniya), 115.3, 79.2 and 244.3 m (GTO) and 22.2, 61.4 and 56.4 m (12-hour 55 deg), and whole-day 34.3/23.1,
291.4/219.7, 204.2/133.9 and 67.3/25.3 m. From 0.4.16 (16.12, 12.8) Molniya is 44.4, 27.5 and 392.6 m and whole-day
276.4/208.3 m, the rest unchanged. Molniya's gap is its 72 h arc's fitted drag coefficient (12.8).
The numerical reference changed by 1.165 m at day 7 when its RK78 tolerance tightened from 1e-12 to 1e-13
and maximum step halved from 300 s to 150 s; a further tightening to 1e-14 and 75 s changed it by 0.255 m.

**16.7 The branch in AP.** A set's branch is decided once, at initialization, from its epoch mean motion and
eccentricity, and held for the whole flight, as SGP4XP holds its class (6, Bands): the resonance class (6), the regime
(period below or above 1,100 min; 5, 9) and the eccentricity switches (the first-order tesseral families on the grid above
0.05 in class 0 and 0.3 in the resonant classes, 16.11; above 0.3 the zonal tail's every long-period term and the perigee
drag passage, 16.3 and 16.12; above 0.3 the class's G about e0, 6.4). Each switch's above side begins strictly above
its limit, so a set at the limit itself is on the below side (from 0.6.40; through 0.6.39 the class's G about e0 began
at 0.3 itself, and a set at exactly 0.3 was on a branch of its own). When drag or a resonance carries the mean
motion across a class limit, the epoch class's terms stay in the rates, with F and G at the current elements (16.2), and
out of the output table; their membership is fixed during a flight (16.3's eccentricity re-anchor changes coefficients only).
A record's output is therefore continuous in time: one
seeded set at each of the five mean motions that decide a class (e 0.001, i 55 deg), flown 2 days at 10 s, has a second
difference of position less the two-body term of at most 0.002, 0.003, 0.004, 0.012 and 0.035 m at 0.8022, 1.2033,
1.6045, 2.4067 and 3.6100 rev/day (0.6.5, whose tables followed the current mean motion: 89.9, 135.5, 13.7, 0.012 and
0.035 m, the first three jumps several times a day; review 0, `math/rerun/09-output-continuity.mjs`).

AP's mean elements are defined per resonance class, per regime (period below or above 1,100 min) and per eccentricity branch.
The same six numbers on two sides of a switch are different orbits: 8 to 401 m apart at epoch and up to 33 km after 7 days at
the regime limit. Sets on different sides must not be differenced, blended or interpolated.

The branch is fixed at the epoch, so this holds between records, never along one. With the class held, two sets 2e-9 apart on
either side of a class limit drift further apart than when both followed the current class (review 0's
`08-boundary-jumps.mjs` at e 0.001, day 7: 1,084, 2,291, 88, 1,309 and 3,037 m at the five limits against 279, 16, 266, 49
and 3,682 m on 0.6.5; at the epoch unchanged, 67, 90, 18, 28 and 24 m). The module differences and blends one branch only:

- Covariance (12.1, 12.3): each moved set flies its nominal's branch. Once the class is held, the propagated covariance about
  a limit is continuous in the nominal's mean motion: a fitted record moved to 2e-8 and 3e-7 above 1.2033 rev/day gives the
  same covariance at 0, 1 and 3 days to 2e-4 of its largest position variance (0.6.5: 0.70).
- Fit: the objective jumps at a switch, and a free fit can stop on it (a 72 h arc of a truth at 0.8022 rev/day ended
  1e-16 from the limit, where one Gauss-Newton step of the full theory would have removed 73 % of its cost: its trial
  steps across are refused until it creeps onto the limit). Where the fitted set lies on a switch (within 1e-8, relative
  in n, absolute in e; every other fit is the free one bit for bit), `fit` fits again from it with every trial set
  pinned to its branch (its columns: the analytic two-body and J2 ones, and where an eccentric or short arc takes them,
  one-sided differences of moved sets that fly the iterate's branch, as the covariance's fly the nominal's, so no column
  holds a switch's jump); a minimum on that branch is the answer; a minimum across the switch is fitted again pinned to the
  branch it reached, and its minimum is the answer when it stays there. Otherwise, at a limit in n (a resonance class
  limit or the 1,100-minute regime limit), the fit is refused fit-at-branch-limit, naming the switch, the set's mean
  motion and eccentricity, and asking for another span or epoch. At a switch in eccentricity (0.3, and the first-order
  tesseral families': 0.05 in class 0, 0.3 in every other class) with no limit in n near, the fit ends on one side
  *[stack #504]*: the free set, which its refused trial steps hold at the switch on its own branch, is the answer; its
  branch is that of its own epoch eccentricity, and the record's OD COMMENT says "fit: held at the eccentricity switch on
  its own branch; the least-squares sets of both branches lie across it". The above side begins strictly above the limit
  (with the fit at a switch: at eccentricity exactly 0.3 an AP set reads the class's G as the below side does). What the rule
  guarantees is a held set within 1e-8 of its switch, on its own side: at or under the limit on the below side, above it
  on the above side. On the 13 held records of the measurement below, the four on the below side lie 6.9e-17 to 2.5e-15
  under the limit and the nine on the above side 5.6e-17 to 1.0e-13 above it; none is the limit itself. The branch test's
  truth half on each side, fitted from below, is held at 0.3 itself. The 0.05 switch is one flag with one comparison (the families on the grid strictly above 0.05, tess::wide_set), so
  a set at exactly 0.05 was already the below side's. A held record's covariance is the curvature of the
  cost, e free, at a set that is not the cost's minimum: its e sigma reaches across the switch, and no calibration measured
  it there; the OD COMMENT is the record's only mark of it. Where some pass ends at an eccentricity switch, each caller
  takes the held set where it had a refusal:
  - the 2-revolution stage and the whole-arc pass with BTERM: the next pass starts from the set the fit leaves, whatever its
    status; that was the last set the pinned passes reached, and is now the held set;
  - each stage of the arc grown by threes: a refused stage left the stage before in place; a held stage is kept;
  - the whole-arc pass with AGOM (and Y0): refused fit-at-branch-limit; now the held set is the record's;
  - each pass at the data's own sigma (12.1): a refused pass left the pass before; a held pass is kept;
  - `sdnap_fit`: the held set with status 0 or 1, where it returned -5 with the last set the pinned passes reached (its
    stats carry no mark of the hold).
  Every other fit and flight is the version before's bit for bit, except a set at exactly e 0.3: its class's G now comes
  from the polynomial and its covariance class above the drag is the below side's (the themis-ripple test's e 0.3 seed,
  at 2.4 rev/day, moves by 5.1e-6 mm). Measured on model truth (experiments synthetic-orbits, FFM 2.2.0; every case of
  the seeded set within 0.01 of a switch in e, 212 of 965), the fit at a switch on the 0.6.36 base (wasm 08e7125e: this
  rule and the series switch strictly above 0.3, without the covariance class's change at 0.3, which moves no fit)
  against 0.6.36 (wasm bf1b5898); seven of its cases (the six of a kilometer or more below and e 0.3 at 1,000 km, i 55),
  re-flown on the 0.6.37 base, are bit for bit on both fits:
  - the 72 h fit before the cutoff, refused fit-at-branch-limit on 8 cases (seven at 0.3, one at the 0.05 switch of class
    0), gives a record on each, its largest distance to the truth over 0 to 120 h 16, 144, 1,079, 1,183, 1,545, 1,551,
    2,239 and 4,739 m (the six of a kilometer or more: the e 0.3 orbits with a perigee of 300 to 650 km, and the e 0.05
    orbit at 400 km, i 98);
  - the fit to the numerical forecast over 0 to 120 h, refused on 2 (0.05 and 0.3), gives records of 242 and 115 m;
  - 15 fits of the 72 h arc not refused move, a pass of each having ended at the switch: five nearer the truth (649.8 to
    641.2, 799.0 to 797.5, 206.8 to 206.1, 25.4 to 8.4 and 20.3 to 14.2 m), one farther (e 0.3 at 1,000 km, i 55: 195.7
    to 678.1 m, now held at the switch, its fit RMS 18.3 to 16.9 m), and nine within 0.1 m;
  - the other 399 of the 424 fits are bit for bit.
  A step of half the update inside the pinned passes cures none of the refusals (measured on 0.6.27): each branch's
  least-squares set lies across the switch, wherever the steps go. On the referee's
  full-field truths (its own integrator, 31 x 31, Sun and Moon) seven fits whose mean motion lies 2e-8 to 5.6e-7 from a
  class limit, at each of the five limits, are at the theory's least-squares minimum (a Gauss-Newton polish with the full
  theory's Jacobian lowers the cost by at most 2.3e-8 relative, steps of at most 1 mm); arcs whose two branches' minima lie
  across each other are refused (the 72 h arcs seeded at 0.8022 and at 1.6045 rev/day, whose 24 h arcs fit, and four of
  eight 24 h arcs seeded up to 7e-5 below 0.8022).
- Epoch store (14.3): two sets on different branches are not blended (nor a carried forecast with a theory state).

Model truth (`test/class-crossing.e2e.mjs`): an AP mean-element GTO at 2026-10-29 00:00 UTC seeds FFM with the same GCRF
state. There is no fit. The primary has n = 2.40 rev/day, e = 0.72, i = 27 degrees, RAAN = 40 degrees, argument of perigee
= 270 degrees, M = 0, BTERM = 0.06 m^2/kg and AGOM = 0. The companion changes only n to 2.3966852459, 0.01 rev/day below the
half-day upper edge. FFM uses 16.6's gravity, DE440, zero EOP and the constant weather of `test/lib/spw-constant.mjs`
(NRLMSISE-00); AP uses FORCES 31,20 and NRLMSISE-00. The primary's mean motion reaches 2.4084063 rev/day at day 7 held
(2.4084264 rebuilt), in the eight-hour band; the companion's 2.4039453, inside the half-day band.

| AP treatment | Primary day-7 T error (m) | Companion day-7 T error (m) | Relative difference |
| --- | ---: | ---: | ---: |
| Epoch class held, drag passes continuous (this version, 16.12) | -22,912.217 | -20,534.324 | 11.580% |
| Epoch class held (0.6.8 to 0.6.11) | -168,218.829 | -136,267.630 | 23.447% |
| Tables rebuilt for the current class (0.6.6 and 0.6.7) | -167,341.326 | -136,267.630 | 22.803% |

From 0.6.12 the epoch state is the middle of the perigee pass at M = 0 (16.12). Through 0.6.11 it was the state after the
whole pass, while FFM, seeded there, still flies the pass's second half: about 145 km of the primary's day-7 error.

Holding the class costs this fixture 0.88 km of day-7 along-track error (0.5 %); the E2E allows 25 % against the companion.
On 2026-11-03, with the earlier constant-weather file, the arms were -32,325.032 (held) and -31,291.823 m (rebuilt), the
companion -26,506.785 m; rebuilding was kept then for its 1.0 km smaller error. It is reversed for continuity in time.
Through 0.6.8 the two (2,2) terms (p,q) = (0,-1), (1,1) left the rates at the crossing and were not in the rebuilt output
table either (that E2E's probe found 0 of 2 there, the failure it reported from 0.6.5 on); held, they stay in the rates.
The E2E flies the primary every 10 s from day 3 to day 7 and finds its output continuous away from perigee (jump detector
0.14 m against 1 m; the same on 0.6.7, whose rebuilt tables kept this set's grid). Within 10 min of each perigee the
detector reached 129 m through 0.6.11: the perigee drag passage (16.12) stepped the output by 42 to 87 m at perigee on
this fixture. From 0.6.12 it reads 0.92 m there, against 0.65 m for the same flight with drag off: kinks about 80 s apart
that are not drag (DigitalArsenal/spacedatanetwork-stack#420; `test/perigee-drag-continuity.e2e.mjs`).
`test/results/class-crossing.json` keeps the run.

**16.8 Third-body terms beyond the octupole.** With d or z above 0, the epoch period below 1100 min (the regime whose
third-body rates 5 averages; the long-period regime takes the full point-mass acceleration), AP adds to the rates each
body's tidal acceleration of Legendre degree 4 to 10,

a_l = (mu_b / r_b^2) (r / r_b)^(l-1) [(l P_l(u) - u P_l'(u)) r_hat + P_l'(u) s_hat], u = r_hat . s_hat,

averaged over the mean longitude as 5 averages degrees 2 and 3, each body held at its position at the stage time: the
Gauss equations on the mean orbit at 32 equally spaced eccentric longitudes F, weighted by r/a (d lambda = (r/a) dF).
P_l and P_l' follow the Legendre recurrences. Over all degrees from 2, the same quadrature reproduces 5's closed form
for degrees 2 and 3 within 0.1 m of day-3 error on the Etalon model-truth cases; degree 10 leaves under 1e-7 of the
quadrupole at r / r_b = 0.12. The output takes the short-period terms of degrees 2 to 10 by 5.4's quadrature. Default
FORCES keeps SGP4XP bit for bit (XP digest 72dcf6005046). Builds 0.6.5 to 0.6.7 departed from it: their rates took the
semi-latus rectum of SGP4XP's zonal terms from af^2 + ag^2 as summed rather than from e e, a unit in the last place,
which moved 282 of the conformance corpus's 80,974 XP samples (130 sets, 128 of them at e 0.6 to 0.75) by at most
1.13e-5 m and one, a set whose orbit grazes the Earth's shadow so that a rounding-limited decision of 4 went the other
way, by 0.197 m at day 7 (digest 34cc810d5d99); 0.6.8 restores the digest. On AP, 0.6.5's speed changes (WASM SIMD128,
fast trigonometry, stage-cached RK3, the analytic/SIMD covariance Jacobian, single-precision tesseral tables) move a flight
of fixed elements by at most 2.9 mm and 3.0 µm/s over the 48 h fixture grid at 550 km (test/ap-terms.e2e.mjs) and by at
most 6.9 mm over 7 days, without growth; seven of them, each switched off in a test build, leave that unchanged, and the
single-precision tables, which no build could isolate, remain the candidate. A fit of the fixture's 24 h arc stops at
another point inside its tolerance: 7.3 cm along the grid and 2.1 m 7 days on (26 against 28 iterations, RMS 41.127
against 41.130 m; test/fit.e2e.mjs).

Exploratory (the 2026-11-03 AP6 windows, already read; 72 h fits, day 3, leads from the fit end): the median paired
AP-minus-numerical-reference error falls from 26.64 to 22.42 m on Etalon-1 and from 36.39 to 23.55 m on Etalon-2
(11 windows each). The medians of LAGEOS-1 (15.44 to 14.10 m), LAGEOS-2 (11.89 to 12.24 m) and LARES-2 (15.04 to
11.00 m) change as shown; IG (36.258 m) and GE (54.310 m) are unchanged. On an Etalon-like orbit with
the epoch moved by whole sidereal days (the Earth's geometry fixed) the mean along-track offset swings between -47
and +39 m with the Moon, and removing the Moon from AP and the reference leaves about 2 m. Most of the rest of
Etalon's gap was the two-line lattice of the fitted set (16.9). `test/etalon-resonance.e2e.mjs` prints every window
and median.

**The sweep, rerun with 5.4's quadrature; no bound.** On orbits of n 2.0059 rev/day in three orientations (G1: i 63.4,
node 300, perigee 270 deg; G2: 63.4, 60, 90; G3: 55, 180, 0), against FFM EGM96 70x70 with Sun and Moon from an
AP-consistent state (72 h fits, 7 days flown hourly), the day-7 3D RMS with the degree 4 to 10 terms and without them:

| e | G1 on / off (m) | G2 on / off (m) | G3 on / off (m) |
| --: | --: | --: | --: |
| 0.05 | 21 / 99 | 15 / 78 | 35 / 97 |
| 0.07 | 22 / 100 | 15 / 78 | 36 / 98 |
| 0.085 | 22 / 101 | 15 / 78 | 38 / 98 |
| 0.1 | 23 / 102 | 16 / 79 | 39 / 98 |
| 0.2 | 28 / 111 | 21 / 87 | 55 / 102 |
| 0.3 | 35 / 115 | 27 / 101 | 75 / 112 |
| 0.5 | 33 / 73 | 39 / 157 | 123 / 320 |
| 0.65 | 61 / 161 | 78 / 148 | 164 / 166 |
| 0.72 | 121 / 335 | 145 / 217 | 241 / 102 |
| 0.74 | 187 / 504 | 168 / 208 | 355 / 120 |

The terms help at every e in G1 and G2 and up to e 0.65 in G3. At G3 e 0.72 and 0.74 the day-7 values turn while the
terms still help at days 1 and 3 (at e 0.72: 66 and 118 m with them, 143 and 330 m without; without them the error
swings through a minimum near day 7). 0.4.10 applied the terms below e 0.1 only: with 5.4's closed form the first turn
was G2's, between e 0.085 and 0.1, and came from that closed form. AP now applies them at every eccentricity; without
them the e 0.72-0.74 fixtures of 16.6 carry 594.8 m (half-day) and 1177.5 m (Molniya) at day 7, and the day-1
along-track RMS is 91.2 and 78.6 m.

**Perigee radius and GTO.** On the fixtures of 16.6 flown on 2-minute samples, the radial error at each of the
reference's perigees, fitted with a constant, a slope and a term alternating between consecutive perigees, drifts
+1.6 +/- 0.5 m/day (half-day), +3.0 +/- 1.5 (Molniya) and +2.0 +/- 5.8 (GTO) at 0.4.11; +6.9 +/- 1.7, +7.2 +/- 4.1
and -14.2 +/- 5.8 at 0.4.10; +0.8 +/- 0.6, +2.6 +/- 1.1 and +2.5 +/- 6.1 with no Sun or Moon on either side. No
third-body drift remains. On the same samples GTO's day-7 whole-day RMS (along-track/radial) is 958/933 m at 0.4.11,
882/858 m at 0.4.10 and 931/912 m with no Sun or Moon on either side (929/914 and 936/918 m with the Moon removed from
both). 0.4.11 sits within 3 % of the error the Sun and Moon do not cause; 0.4.10's third-body errors partly cancel it.
With the geopotential cut to J2-J4 on both sides (GTO's period is not resonant), the day-7 RMS is 387/392 m at 0.4.11,
381/396 m without Sun or Moon and 480/445 m at 0.4.10. Evaluating the short-period terms with the bodies at the
orbit's middle instead of the output time moves the day-7 RMS by tens of meters either way (half-day 78/101 m, Molniya
161/47 m, GTO 924/905 m); a 24 h fit gives half-day 71/82 m (0.4.10: 182/133 m), GTO 2447/2024 m (1632/1333 m) and
Molniya, whose drag one day does not resolve, 3077/2307 m (3833/2898 m).

**Cost.** Owner Mac under load, browser host, `propagate` over 7 days, median of 7 runs, milliseconds per object-day
from 0.4.10 to 0.4.11: on a 1 h grid LEO 1.73 to 2.10, Etalon-like 4.44 to 5.33, GPS-like 4.36 to 5.66, half-day
12.3 to 11.9, Molniya 11.5 to 12.0 and GEO-like 1.43 to 1.58; on a 1 min grid 58.2 to 73.5, 51.3 to 80.8, 51.5 to
72.5, 65.8 to 80.0, 62.2 to 86.1 and 51.0 to 51.6. Evaluating the nodes' cosines and sines for every term instead of
the table cost about 250 ms per object-day on the 1 min grid.

**16.9 AP sets at full precision.** `fit` rounds an SGP4XP set to the two-line text's digits and searches their
lattice (mean motion 1e-8 rev/day, eccentricity 1e-7, angles 1e-4 deg), the set the Space Force library reads. An AP
set (16.1, marked as 16.5 states, so it flies on AP only) keeps the solution's full precision. One unit of an angle's
last digit is 1.7e-6 rad: 44 m at 25,500 km and 74 m at the geostationary radius, so the lattice bounded AP's error
from below on medium and high orbits.

On an Etalon-like orbit (2.13 rev/day, e 0.0007, i 64.9 deg; nodes 0, 90, 180 and 270 deg) against FFM EGM96 70x70
without third bodies (a test build with both mass ratios 0; 72 h fits, 7 days flown hourly), the day-7 cross-track RMS
falls from 22-23 m to 0.75-0.78 m and the along-track RMS from up to 52 m to 1.8-6.8 m. With J2 alone, or J2 and J22
alone with every piece of the class's degree-2 terms in, both are under 1 m. Exploratory (the AP6 windows, already
read; day 3, leads from the fit end; 0.4.8 to 0.4.9): Etalon-1 paired AP-minus-numerical-reference 22.42 to 10.12 m,
Etalon-2 23.55 to 9.74 m; medians LAGEOS-1 14.10 to 7.81 m, LAGEOS-2 12.24 to 6.78 m, LARES-2 11.00 to 9.73 m, IG
36.26 to 17.10 m, GE 54.31 to 45.86 m. The e 0.72-0.74 fixtures of 16.6 at day 7: half-day 104.7 to 91.4 m, Molniya
654.1 to 700.4 m, GTO 2326.6 to 2356.1 m, 12-hour 55 deg 188.7 to 175.5 m. `test/twelve-hour-class-terms.e2e.mjs`
prints every number. The AP covariance calibration of 12.7 is re-measured on these sets with its noise constants
unchanged: one of its eight cells (ABOVE, day 1) is now inside the band, none was before.

**16.10 The half-day class's step; the long-period step above e 0.3.** The step is fixed (95 min in the long-period regime,
38 min in the one-day class) with no error control. It resolves perigee only for (1 - e)^(3/2) >= 2 pi h / P: e up to 0.44 at
95 min and 0.70 at 38 min on a one-day orbit. Beyond that the theory's own equations are integrated with a mean-longitude error
of 0.2 km a week at e 0.5 and 0.4 to 4.6 km a week at e 0.7 to 0.82 at 95 min, and 0.09 to 0.17 km at e 0.82 at 38 min.

From 0.6.16 an AP set in the long-period regime with e_0 above 0.3 steps

  h = min(h_0, 0.5 tau), tau = (1 - e_0)^(3/2) / n_0 (n_0 in rad/min),

with h_0 the step above (38 min in the one-day class, 95 min otherwise).
- **Why tau.** In this regime the Sun and the Moon enter the rates as the full acceleration at the satellite's position (5,
  Long-period regime), and near perigee that position turns on the time scale tau. At perigee the true anomaly advances
  (1 + e)^(1/2) rad in tau. tau is the criterion above with h = tau.
- **Why 0.5.** RK3's local error grows as (h / tau)^4 there. Half of tau is the largest measured fraction at which the
  THEMIS-like orbit's own integration error falls to 0.1 m at day 5: 0.77 tau leaves 0.33 m and 1.16 tau leaves 9 m.
- **Decided once.** The step is decided at the epoch with the set's branch (16.7; `Branch::lp_step`). It is not a switch:
  the 0.3 it starts at is the branch's existing eccentricity switch. A moved set (the covariance's, a fit's difference
  columns) flies its nominal's step.
- **What does not change.** Sets at e_0 0.3 and below, every averaged-regime set and SGP4XP keep their step bit for bit.

AP against itself: a seeded set (FORCES 31,20, B 0.01, AGOM 0.0125 m^2/kg, i 10 deg; Chandra-like i 72, TESS-like i 40),
flown 7 days at 300 s, RMS over day 5 against the same set at a 2.375-minute step (one-day class) or an 11.875-minute step
(class 0). Cells marked (rule) are the rule's step.

| Orbit (n rev/day, e) | tau (min) | Day-5 RMS (m), by step |
| --- | ---: | --- |
| THEMIS-like (1.0496, 0.822) | 16.4 | 38 min: 174.11; 19: 8.99; 12.67: 0.33; 9.5: 0.10; 8.20 (rule): 0.08 |
| one-day (1.0496, 0.70) | 35.9 | 38 min: 34.82; 19: 5.43; 17.94 (rule): 4.57 |
| one-day (1.0496, 0.50) | 77.2 | 38 min (rule: h_0): 15.14; 19: 1.85 |
| Chandra-like (0.37795, 0.685) | 107.2 | 95 min: 52.97; 53.6 (rule): 9.54; 47.5: 6.62; 23.75: 0.74 |
| TESS-like (0.0730, 0.55) | 947.7 | 95 min (rule: h_0): 0.95; 47.5: 0.12 |

What the rule leaves is the integration error of a step that already resolves the pass: 4.6 m at e 0.70, 9.5 m on the
Chandra-like orbit, and 15 m at e 0.50, where the rule keeps 38 min.

The price is the steps. On THEMIS-class orbits the long-period rates dominate the cost, so the cost follows the number of
steps, 4.6 times as many at 8.20 min as at 38. Measured with `test/kernel-cost.mjs` (one process, 5 repeats, 0.6.15 against
this rule on the same machine; AP in order over 7 days):
- THEMIS-like: 37.4 to 168.3 us a state at 300 s (4.5 times) and 7.84 to 34.35 us at 60 s. One cold state at 7 days costs
  41 to 175 ms.
- Chandra-like: 1.52 to 2.35 us a state at 300 s (1.5 times) and 0.69 to 0.86 us at 60 s.
- SGP4 and SGP4XP are unchanged.
These are the sets with a period of 1,100 min or more and e above 0.3, a few dozen to a few hundred objects. A step
shortened only near perigee would keep the accuracy at about the 38-minute cost (not done; stack #450).

FFM model truth on the THEMIS-like orbit (EGM96 70 x 70, Sun and Moon from DE440, no drag or radiation pressure on either
side; a 72 h fit flown 7 days; whole-day 3D RMS at 10-minute samples, days 1 / 3 / 5 / 7):
- Through 0.6.15 (38 min): 160.1 / 468.9 / 918.6 / 1,168.2 m.
- From 0.6.16 (8.20 min): 76.6 / 110.0 / 122.9 / 124.9 m.
- With the Sun and the Moon off on both sides: 76.2 / 107.5 / 120.9 / 102.7 m, at either step. The step's error was the third
  bodies' alone.
- Without the step's error, what remains (day 5) is AP's geopotential: J2 alone on both sides 39.8 m, J2 to J5 78.9 m, a
  4 x 4 field 103.2 m and a 12 x 12 field 83.3 m (the J3 to J5 short-period set is not carried; 16.11).
- `test/long-period-perigee-step.e2e.mjs` holds the model truth and the step's convergence (stack #445).

The averaged regime steps two revolutions (9). AP's half-day class (1.604 to
2.406 rev/day) carries resonant terms in lambda - 2 theta, whose period 2 pi / |n - 2 omega_E| is long near the
commensurability (Molniya at 2.00 rev/day: 183 days; the half-day fixture at 2.0059 and GPS: 6.5 and 22 years) and
short away from it (GTO at 2.40 rev/day: 2.5 days; Galileo at 1.70: 3.3 days; BeiDou at 1.86: 6.9 days); two
revolutions, 20 h on GTO, do not resolve the latter. From 0.4.14 the class steps at most a 32nd of that period: 114
min on GTO, 150 on Galileo, 312 on BeiDou and 357 to 359 on Etalon and GLONASS; near the commensurability the two
revolutions stand, and the half-day, Molniya, 12-hour 55 deg and GPS cases are bit for bit 0.4.13's. Against the class
stepped at 23.75 min (11.875 min moves that by under 0.003 m in 7 days), on seeded FORCES 31,20 sets: GTO 0.065 m RMS
over one orbit (two revolutions: 84.5 m, and 261 m over 7 days), the 500 km perigee GTO 0.057 m, and over 7 days
Galileo-, BeiDou- and Etalon-like orbits 0.004, 0.013 and 0.016 m.

On FFM model truth without Sun or Moon on either side (2-minute samples; day-7 3D RMS, m), the geopotential cut on both
sides, the class stepped two revolutions and 95 min:

| Field (AP degrees) | GTO, 220 km perigee | GTO, 95 min | 500 km perigee | 500 km, 95 min |
| --- | --: | --: | --: | --: |
| 4x4 (4,4) | 237.5 | 233.2 | 195.8 | 189.3 |
| 8x8 (8,8) | 604.6 | 558.1 | 451.7 | 427.0 |
| 12x12 (12,12) | 822.1 | 472.0 | 585.1 | 379.1 |
| 20x20 (20,20) | 1,147.4 | 494.7 | 753.9 | 380.3 |
| 70x70 (31,20) | 1,369.8 | 627.6 | 831.1 | 418.4 |

On GTO at 70x70 the class stepped 600, 450, 300, 190, 95 and 47.5 min gives 639.0, 623.6, 626.3, 627.2, 627.6 and
627.7 m. With zonals only the comparison does not separate the fields: XP's own half-day resonance terms (SPEC 6) have
no counterpart in a zonal truth (4x0 against AP 0,4: 600.3 m). What remains on GTO grows with the degree (233 to 628 m
from 4x4 to 70x70): high-degree terms at perigee that AP does not carry.

FFM model truth with Sun and Moon (`test/gto-geopotential-perigee.e2e.mjs`; hourly, day-7 whole-day RMS
along-track/radial against 0.4.13): GTO 960.82/935.27 to 419.32/455.90 m (day-7 sample 2449.15 to 929.45 m), the 500
km perigee GTO 605.15/576.31 to 295.44/304.96 m; on the read AP6 windows Etalon-1 and -2 move from 6.64 and 7.58 to
6.72 and 7.74 m (paired day 3) and LAGEOS-1 and -2, LARES-2, IG and GE not at all; on the Etalon-like synthetic orbit
of `test/twelve-hour-class-terms.e2e.mjs` (no Sun or Moon) the day-7 along-track RMS at nodes 0, 90, 180 and 270 deg
is 3.22, 2.10, 1.65 and 2.84 m (3.37, 3.19, 1.77 and 6.76 m at 0.4.11), cross-track and radial within 0.02 m.

Cost (owner Mac under load, browser host, `propagate` over 7 days, the two releases interleaved, median of 9 runs,
milliseconds per object-day from 0.4.13 to 0.4.14): on a 1 h grid GTO 12.0 to 16.2, Galileo-like 5.8 to 10.5 and
Etalon-like 5.1 to 6.1; on a 1 min grid 121.3 to 124.3, 86.6 to 89.7 and 74.9 to 76.4; LEO, GPS-like, half-day,
Molniya and GEO-like unchanged (2.1, 5.2, 11.7, 11.6 and 1.4 ms on the 1 h grid).

**16.11 Wide terms above e 0.3; the tesseral switch by class.** A perigee pass spreads each term of the field over the harmonics of M. From 0.4.15,
above an epoch eccentricity of 0.3, AP's zonal tail (16.3) carries every long-period term, w = l - 2p for p = 0..l with
q = -w (G = O(e^|w|)), not only w = 0 and +-1. From 0.6.3 the first-order tesseral terms of degree 2 to 12 (16.2) are not a
series in M there. From 0.6.4 the tesseral families' switch is by the set's resonance class (6, the band of the epoch mean
motion, `src/tesseral.inc` `wide_set`): a set in no resonance band (class 0: low orbit above 3.61 rev/day, the LAGEOS band at
6.4 to 6.5 rev/day, orbits below 0.80 rev/day) flies the grid above an epoch eccentricity of 0.05; a set in the one-day,
half-day, eight-hour or sixteen-hour class keeps the 0.3 switch. The zonal tail's wide set, the perigee drag passage (16.12)
and the fit's wide blocks (12.8) keep 0.3 in every class. Measured against the independent full-force reference of 16.11's
last paragraph (orbit-accuracy-experiments results/ap-truth/tesseral-diagnosis, the kWideE 0.01 probe build, byte-identical
to 0.6.3 above the switch on 12 of 12 sets): in the non-resonant regimes the first-order set fails the one-day line where the
grid passes it (Ajisai at e 0.05 and 0.1; LAGEOS-1 at 0.05, 0.1 and 0.2; LAGEOS-2 at 0.05 and 0.1: forward tesseral shares
of 3.0 to 18.4 m on the set against 0.4 to 3.2 m on the grid) and the grid's one-epoch flight is cheaper by 88 to 408 ms
(the set's first-order table is the larger build there); in the half-day class (GPS, GLONASS, Etalon, Molniya at e 0.05 to
0.29) the resonant mixed share is untouched by either and the grid costs 70 to 167 ms more, so the resonant classes keep the
set. The eight-hour and sixteen-hour classes were not measured and keep the shipped switch. A set keeps its epoch class's
switch for the whole flight (16.7). 0.6.4 therefore changes a flight only for a class 0 set with
0.05 < e <= 0.3; every other set is byte-identical to 0.6.3 (PRODUCER's version aside), and the 0.6.4 validation
(orbit-accuracy-experiments experiments/operator-theory/TESSERAL-SWITCH-BY-CLASS.md) states its cells, the catalog budget on
persistent instances and the identity set.

From 0.6.3 (above e 0.3) and 0.6.4 (from e 0.05) to 0.6.10, a class 0 set near an m:1 commensurability with the Earth's rotation
flew without part of its tesseral field (stack #393). The grid left the whole slow band out of each family, as the table does
outside low orbit; in low orbit the table leaves out only the shallow set's terms and those slower than 1e-3 n, and above the
switch it holds nothing of degree 2 to 12, so the slow terms with q != 0 (of order e^|q|) were carried nowhere. They are
near-resonant (periods of days to weeks, along-track as 1 / psi-dot^2), which a fit cannot absorb. From 0.6.11 the grid leaves
out exactly what the table leaves out. Day-7 along-track RMS after a 72 h fit (FFM truth, 2.2.1 and 2.3.0 alike: EGM96 70 x 70, the
truth of these printed figures; the test flies EGM2008 from 0.6.36; DE440 Sun and
Moon, NRLMSISE-00 at constant weather, B 0.044 m^2/kg; i 50; `test/class0-commensurability.e2e.mjs`), 0.6.9 against 0.6.11,
with 0.6.9's switch back at 0.3 beside it:

| n (rev/day), e | 0.6.9 (m) | 0.6.11 (m) | switch at 0.3 (m) |
| --- | ---: | ---: | ---: |
| 4.0, 0.25 | 2,318 | 6 | 58 |
| 5.0, 0.25 | 4,463 | 11 | 414 |
| 6.0, 0.25 | 5,864 | 29 | 70 |
| 7.0, 0.25 | 178 | 27 | 684 |
| 8.0, 0.25 | 2,663 | 220 | 1,346 |
| 6.0, 0.1 / 0.2 / 0.3 | 1,464 / 3,811 / 9,143 | 5 / 16 / 61 | 16 / 56 / 55 |
| 6.0, 0.35 | 14,623 | 159 | 14,623 |
| 4.5, 0.25 (9:2) | 47 | 5 | 19 |
| 5.5 / 6.5, 0.25 | 66 / 42 | 31 / 42 | 38 / 55 |

The fault spans about +-0.045 n about each commensurability (0.7 to 5.9 km between 5.8 and 6.2 rev/day at e 0.25; 0.6.11: 12 to
57 m). Off every band the grid is unchanged: LAGEOS-1-like (6.386 rev/day, i 109.8) at e 0.1 and 0.2 and LAGEOS-2-like (6.47,
i 52.7) at e 0.1, drag off, give the same bytes on 0.6.9 and 0.6.11 (2.4, 6.0 and 7.4 m at day 7; 8.8, 23.5 and 8.5 m with
the switch at 0.3). Ajisai-like (12.44 rev/day, i 50, e 0.1) lies in the 12:1 band: 146.3 m on 0.6.9, 149.7 m on 0.6.11,
135.1 m with the switch at 0.3. At e 0.05 every case is the first-order set's, the same in all three. The exact resonance is
not carried: where an order-m harmonic drifts slower than 1e-3 n (8.05 rev/day at e 0.25) the table and the grid both leave it
out and no class carries it in the rates (6), 1,272 m at day 7 on 0.6.11 (6,090 m on 0.6.9); 8.0 rev/day lies on that
resonance's shoulder (220 m at e 0.25, 90 m at 0.2, 16 m at 0.1).

Above the eccentricity switch AP carries the resonances 1:1, 2:1, 3:1 and 3:2 only; every other commensurability is absent:
0.5 to 1.8 km a week on a transfer orbit (485 m at day 7 with a 12 x 12 field, 58 m without order 9, 1.5 to 1.8 km with the
full field; a one-day orbit at e 0.82 is 3.65 km at degree 12 against 0.56 km at degree 4; 6).

Which slow terms the grid keeps is 16.18's rule; its reasons and measurements are stated there. From 0.6.28 it keeps none: every
class above its switch carries its slow terms of degree 2 to 12 in its rates (stack #473). From 0.6.24 to 0.6.27 the one-day
class kept every slow term its rates did not carry on the grid, down to 1e-2 n (stack #467).

Below the eccentricity switch (0.05 in class 0, 0.3 in the resonant classes) the first-order tesseral table keeps |q| <= 1. The
terms dropped are of order e^2 and reach, just below the switch, 14 m at a = 7,600 km (20.6 m against 15.2 m just above it), 12 m
in a 12-hour orbit (13.5 against 6.7 m) and 7.5 m in a geosynchronous orbit (7.6 against 1.1 m), RMS over a 72 h arc.

For each (l, m, p), the sum over q of G_lpq e^{i(w+q)M} is (a/r)^(l+1) e^{iwf}, so each (m, w) family's
first-order displacement (Lagrange's equations, each harmonic divided by its psi-dot, lambda also through n) is a periodic
function of the anomaly, complete in j. At init it is built on 128 uniform eccentric anomalies from the family's forcing:
H = e^{-i nu e sin E} IFFT(FFT(R (1 - e cos E) e^{i nu e sin E}) / (i (k - nu))) / M-dot, nu = -(w omega-dot + m (Omega-dot -
omega_E)) / M-dot, R the six rates, the harmonics 16.2's table leaves out (m-daily, the class's, the half-day class's tail, and
the slow band as the table leaves it: in low orbit, class 0 below 1100 min, the shallow set's terms q = 0, w = j = 1 with the
shallow set's taper and the terms slower than 1e-3 n; in the one-day class, from 0.6.24, only the terms slower than 1e-2 n
(16.18); elsewhere every term with |psi-dot| < 0.045 n) subtracted one by one,
each by the share the table leaves out, with G and dG/de by the trapezoid on those nodes. Kept on those nodes in single
precision, its derivatives in e, i and a / a (forward differences) on 64 of them in half precision (about 4.9 MB a grid with
the slopes below, 3.1 MB before 0.6.14), and read at
output time in E by the cubic Hermite between the two nodes about E, linear in the mean elements' offsets, times
e^{i(w omega + m beta)}. Each node's slope is the fourth-order central difference of its four neighbours on the periodic
grid, computed once when the grid is built and kept in single precision beside the node's value: four reads, as before.
The derivative grids are read by the four-point Catmull-Rom cubic. Both are continuous with their slope from one interval
to the next. Memory per family is 16,896 bytes against 10,752 (+57 %); cost per state on the low orbits that read the
grid (e 0.1 and 0.2, tesseral degree 31) is that of 0.6.12 within 5 %. Through 0.6.13 it was the four-point Lagrange cubic, whose slope
stepped at every node: kinks about 80 s apart near perigee, where the nodes pass fastest. On the transfer orbit with drag
off the jump detector within 10 min of perigee read 0.395 m at 10 s and 0.031 m at 1 s; it now reads 0.032 m and 0.8 mm
(stack #420; `test/egrid-continuity.e2e.mjs`). A grid is built at the set's mean elements at every 48 hours from its epoch
(the same nodes for every set of a fit) and blended linearly into the next node's over the last fifth of each interval.

*The grid's mean motion in the long-period regime.* From 0.6.30 (stack #479), an AP set in the long-period regime (epoch period
1,100 min or more) with the Sun and Moon builds every node's grid at its epoch mean motion. It reads every grid with the
epoch's offset in a: none on its own grids, and its own epoch's a for a copy that reads its nominal's grids. Each node's e and i,
and the state's offsets in them, are as before. There the bodies act on the mean elements as point masses (5), so the mean
motion moves along each revolution, by up to 4e-4 of n at a = 114,000 km (the energy relation, the Moon at one cutoff). A
family's divisor k - nu (nu = -(w omega-dot + m (Omega-dot - omega_E)) / M-dot, about 4.4 m on that orbit) moves by m x 4.4
times as much. That is as large as a near-resonant family's distance from resonance: m = 7 lies 0.03 from j = 31, m = 9 lies 0.10
from j = 40. Through 0.6.29 every node was built at the mean motion of its instant and every state offset in a from its own
mean a, so the grid followed that oscillation. Measured on 0.6.26 with the change alone: on a synthetic set at e 0.9 with perigee 5,000 km (i 70), with AP fitted to
the numerical forecast over 0 to 120 h and the Moon on both sides, the field 70 x 70 against AP's degree 31 gave 3,717 m. With no
tesseral term at all AP gave 1,175 m, and with the zonal field and the Moon alone on both sides 864 m. With the mean motion
held it gives 970 m. With it held, the cadence no longer matters: nodes every 6 h, every 48 h, and one node for the whole
flight give 971, 970 and 981 m. Rebuilding more often at the instant's mean motion helped only part way (2,436 m every 6 h,
2,426 m every hour). Every other set is bit for bit: the averaged regime, AP without the Sun and Moon, and SGP4XP. A grid
is keyed by its set's exact elements (bitwise n, e, i, the class and the degree): a lookup matches only that key, and a grid held
from an earlier call is the same bytes a rebuild gives. A copy initialized while its nominal set's xpt::GridShareScope lives (the
covariance's sigma sets, a fit iteration's perturbed copies) reads the nominal's grids, its schedule nodes included, linearly, when
within 3e-4 in e, 1e-4 rad in i and 1e-4 in a / a of them; each set keeps its last two nodes. A grid built by a set initialized on
a thread while tess::FitGridScope lives there (thread-local; the fit holds it around its solve on its calling thread) is freed when
its last holder drops it, never kept idle, so a fit leaves no grid behind. The export sdnap_wide_grid_stats(reset, out) writes the
grid lookups since the last reset, out[0] by sets outside a fit and out[1] by a fit's sets (reset != 0 zeroes them after reading);
sdnap_wide_grid_cache(out) writes the grids the cache holds (out[0]), their bytes (out[1]) and the grids built since the
instance began (out[2]).

*The cache's bound (stack #497).*
- **The count:** at most 256 grids.
- **The bytes:** while an idle grid remains to be freed, at most kGridCacheBytes (512 MiB) of grids, live and idle, counting
  the grid about to be built at its size; the least recently used idle grid goes first. A grid in use is never freed, so live
  grids alone may exceed the bound.
- **A grid's bytes** are what it allocates (WideGrid::alloc_bytes): its block, sized for every family (m, w) of its degree
  with their indices, and the WideGrid. At degree 12 on 128 anomalies that is 5,069,464 bytes (kGridMaxBytes); at degree 2,
  169,044. Beside them sit the build's two double-precision family sets (3.7 MB each at degree 12, kept for the instance's
  life). sdnap_wide_grid_cache and sdnap_wide_grid_budget report the same held bytes.
- **The setter:** sdnap_wide_grid_budget(bytes, out) sets the bound when bytes is 1 or more (whole bytes, at most SIZE_MAX;
  1 keeps no idle grid), only reads it otherwise. It writes the bound (out[0]), the bytes held (out[1]), the grids held
  (out[2]) and those idle (out[3]).
- **States never move:** the bound decides which grids are kept, never a grid's bytes. Measured bit for bit
  (`test/grid-cache.e2e.mjs`):
  - at the default bound, a 1-byte bound and a bound that holds a few grids;
  - with a cold, warm or shuffled cache;
  - on 1 and 8 pool threads.

Through 0.6.47 idle grids were bounded by their count alone (128 x 5,069,464 bytes: about 650 MB, 618.8 MiB, at degree 12). The 128-node rule is exact to 1e-13 to degree 20; at degree 31 its relative error is 1e-6 at e 0.72 and
2e-3 at e 0.79. Against the full-field quadrature on THEMIS (e 0.82, 7 days at
300 s): 0.12 m RMS, 2.6 m at most, 3 mm second difference, and 0.09 m RMS with the eccentricity drifting 3e-3 a week; a
first-order series in M, the set the grid replaces, was 65 m RMS and 2.96 m. The near-resonant terms above degree 12 stay in
the table (`src/tesseral.inc:323`); the table builds none of the general set above the switch (`src/tesseral.inc:324`). Below the switch both sets are 0.4.14's: propagations at e 0.25 and 0.3 of Etalon- and GPS-like seeded
sets and of LEO sets at e 0.05 and below are byte-identical. The method is fixed once per flight from the fitted epoch elements: `src/tesseral.inc:43` sets
kWideE = 0.3 and `:49` kWideENonResonant = 0.05, `src/tesseral.inc:264` reads `const bool wide = wide_set(cls, e0);` when the set's terms are built at initialization
(`src/xp_theory.inc:1473` builds the grid on the same test of the epoch eccentricity), the output tests only whether the set
holds a grid (`src/xp_theory.inc:1279` and `1290`), and the 48-hour schedule (`src/xp_theory.inc:1719` to `1777`) rebuilds the
grid at the node elements without re-evaluating the test, so no flight switches method in flight. Against an independent
full-force reference (propagator/ffm 2.2.1 with the same field, Sun and Moon from DE440, in vacuum; orbit-accuracy-experiments
e53a8ef0e1261523f5d28a617b9a5177d629e4f2, results/ap-truth/tesseral-all-regimes/table.json, `primary.steps`) a set fitted at
e 0.29 and flown one day is 22 m RMS (41 m at most) for a one-day orbit, 27 m (55 m) for a half-day Molniya-like orbit and 25 m
(56 m) for GTO, the first-order set's own error near 0.3; a set fitted just above 0.3 (e 0.31; Molniya 0.30) is 10 m RMS
(12 m at most), 26 m (45 m) and 15 m (29 m), the grid's. Two sets fitted on either side of 0.3 can therefore differ by about the
first-order set's own error, the set above 0.3 the nearer to the reference. A fit above e 0.3 builds a grid for each
set it initializes at new elements (about 13 an iteration on the GTO fixture, about 45 ms each in wasm), so fits there may take
up to about twice 0.6.2's time; such a fit's wasm memory stays below 90 MiB on THEMIS A, the GTO and the Molniya fixtures.

The 4x4 case of 16.10 measured a mismatch: XP carries J5 (2) at every FORCES and the 4x4 truth has none. With J5 zero on
AP's side 0.4.14 is at 98.9 m on day 7 (2-minute samples, Sun and Moon off both sides, 72 h fits, 3D RMS), flat over the
7 days. The zonal fields alone on both sides, XP's resonance terms off on AP's side: J2 20.8 m, J2-J3 49.8, J2-J4 48.9,
J2-J5 46.6; with XP's J2^2 terms removed 1,873 m. The flat 30 to 50 m is the J3 to J5 short-period set, which XP does
not carry and this release does not derive; it is open. 24 h fits give 66.2 m (J2) and 159.5 m (J2-J4).

The zonal tail's missing long-period terms carried a linear drift. Zonal fields alone, AP (0, d), day-7 3D RMS from 0.4.14
to 0.4.15: 8x0 561.6 to 40.3 m, 12x0 347.5 to 45.1, 20x0 400.1 to 45.1, 40x0 442.7 to 44.8; at degree 70 the fit does
not converge in either release. On GTO the tesseral set's slow terms outside the class carry much of the rest: (m, j) =
(5, 2) and (7, 3) drift at 0.089 n and 0.075 n (4.7 and 5.5 days); keeping only the new terms faster than 0.2 n leaves
the GTO fixture at 721.97/511.68 m.

| Field (AP degrees), Sun and Moon off both sides | 0.4.14 | 0.4.15 |
| --- | --: | --: |
| 4x4 (4,4), J5 zero on AP's side | 98.9 | 89.6 |
| 8x8 (8,8) | 558.1 | 59.3 |
| 12x12 (12,12) | 471.9 | 63.1 |
| 20x20 (20,20) | 494.7 | 85.3 |
| 40x40 (31,40) | 612.9 | 138.3 |
| 70x70 (31,20) | 627.6 | 201.9 |
| 70x70 (31,20), 500 km perigee | 418.3 | 90.9 |

FFM model truth with Sun and Moon (`test/gto-high-degree-perigee-terms.e2e.mjs`; hourly, day-7 whole-day RMS
along-track/radial, m):

| Fixture | 0.4.14 | 0.4.15 |
| --- | --: | --: |
| GTO | 419.32 / 455.90 | 204.15 / 133.92 |
| GTO, 500 km perigee | 295.44 / 304.96 | 109.46 / 70.85 |
| half-day | 84.22 / 75.28 | 34.33 / 23.12 |
| 12 hours at 55 deg | 158.02 / 105.47 | 67.25 / 25.32 |
| Molniya with drag, coefficient fitted | 149.82 / 175.90 | 291.41 / 219.72 |
| Molniya with drag, coefficient pinned at the truth's 0.044 | 159 / 92 | 144 / 120 |

Molniya with its drag coefficient fitted regresses: the 72 h fit takes 0.0457 m^2/kg against the truth's 0.044 (0.4.14:
0.0451), and the along-track error grows quadratically after the fit (33, 41, 51, 86, 142, 209 and 291 m whole-day on
days 1 to 7). Without drag it improves from 108/102 to 51/36 m; with the coefficient pinned at the truth every build
lands at 141 to 159 m along-track. From 0.4.16 the pinned case is 70.9 m with AGOM pinned at 0 (16.12) and the fitted
case 276.4/208.3 m; the 72 h arc does not separate the coefficient at e 0.74 (12.8).

Against independent integrations at the GTO fixture's elements (argument of perigee 270 deg, and 300 deg, where the zonal
e and i rates do not vanish), J6-J20 and the 1,888 tesseral terms kept there: the zonal tail's rates against the potential
averaged over M by quadrature (8,192 points in E) differ by at most 6.5e-6 m over one orbit, the rates moving the elements
by up to 21 m; the tesseral displacements against a numerical integration of their rates (RK4, 0.1 min) by at most
1.1e-9 m RMS (sizes 20 to 165 m), and against Hansen coefficients by quadrature in M (8,192 points; worst relative
difference 8.2e-6) by at most 1.6e-4 m RMS.

Cost (owner Mac under load, browser host, `propagate` over 7 days, the two releases interleaved, median of 9 runs, ms per
object-day from 0.4.14 to 0.4.15):

| Orbit | 1 h grid | 1 min grid |
| --- | --: | --: |
| GTO | 24.6 to 37.0 | 133.5 to 161.9 |
| half-day | 16.3 to 30.3 | 123.6 to 152.6 |
| Molniya | 18.2 to 30.5 | 118.1 to 159.1 |

Orbits at e 0.3 and below run 0.4.14's path, except the tesseral families of a class 0 set above e 0.05, the grid from 0.6.4.

The grid's cost on one case: the Molniya fixture (e 0.74, 72 h arc, BTERM pinned at the truth's 0.044, NRLMSISE-00 at
constant weather; test/drag-high-eccentricity.e2e.mjs) flies 7 days on from 71.22 m whole-day along-track RMS at day 7
(0.4.16 to 0.6.2) to 83.42 m from 0.6.3 (83.38 m from 0.6.5), on both FFM truths (2.0.4: 70.86 to 83.01 m); not the grid's
resolution (256 nodes: 83.41 m). The same change took the fitted Molniya fixture's day-7 along-track RMS from 276 to
238 m and the half-day fixture's from 34 to 31 m (test/third-body-short-period-eccentric.e2e.mjs). The half-day
fixture's single samples (test/heo-model-truth.e2e.mjs, 0.6.2 against 0.6.3 on the same truth) went from 27.45 / 69.63 /
59.33 m to 61.51 / 100.31 / 30.16 m at days 1, 3 and 7 (27.54 / 69.96 / 60.10 m as registered at 0.4.17, 61.58 / 100.37 /
30.22 m on 0.6.8): day 7 is better, and days 1 and 3 are worse. The 12 h at 55 deg
fixture is worse at every day (22.10 / 61.24 / 55.97 to 62.87 / 77.80 / 65.11 m). The grid's cost and gain fixture by
fixture, and the 12 m, are DigitalArsenal/spacedatanetwork-stack#391.

**16.12 Drag above e 0.3.** A drag pass at perigee is narrow against the orbit: the energy goes in a step, at the
Earth angle of the passage. From 0.4.16, above an epoch eccentricity of 0.3 (the set of 16.11), AP evaluates 3.4's drag
per perigee passage:

- **Time.** The rate at t is the mean of the passages before and after t, t_p = t - M/n and t_p + 2 pi/n. Each node of
  a pass takes the date and the Earth angle of its own time on it, t_p + M(nu)/n, M(nu) by Kepler's equation; the flux
  and date terms are the passage's. The rate at t's own Earth angle averaged the density over every longitude, while a
  repeating ground track (Molniya, 2 rev/day) passes perigee at two, alternating. The nearer passage alone is biased by
  the two-revolution step, whose stages fall unequally on the two (+0.4 % in energy on Molniya).
- **Arc.** The arcs nu_c < |nu| < pi are added, 13 Gauss-Legendre nodes each at nu = nu_c + (pi - nu_c) s^2, s_j =
  (x_j + 1)/2, weight w_j (pi - nu_c) s_j / nu_c in the units of the perigee arc's sums; the co-rotating air at the
  node's radius r: V = sqrt(1 + 2 e cos nu + e^2 - 2 q theta rho + q^2 cos^2 phi' rho^2 / D^2), rho = r D / p.
- **Short-period steps.** The osculating elements change by each pass's whole effect over the pass, while the mean
  elements ramp by the two passes' mean. From 0.6.12 a pass's change is spread over the pass as the cumulative of a
  normal distribution in M of the pass's own width s: the RMS of M(nu) over the perigee arc's 13 nodes, each weighted by
  its share of the pass's sums (at most pi/4). With p the full rates of the pass before t (at t - M/n), q those of the
  next, M in [0, 2 pi), the output adds to each element
  (pi p_j - (p_j + q_j) M/2 + pi (q_j erfc(V) - p_j erfc(U))) / n, U = M/(sqrt2 s_p), V = (2 pi - M)/(sqrt2 s_q),
  and to lambda also n's own difference integrated over time,
  (2 pi/n^2)(p_n (M/2 - pi/6) + (q_n - p_n) M/6 - (p_n + q_n) M^2/(8 pi) + (p_n s_p ierfc(U) + q_n s_q ierfc(V))/sqrt2),
  ierfc(x) = exp(-x^2)/sqrt(pi) - x erfc(x). Both are continuous with their slopes from one revolution to the next. The
  element correction is zero at perigee; the lambda term is not: it is (2 pi p_n / n^2)(s_p / sqrt(2 pi) - pi/6) there.
  Over one revolution the integral of the mean-motion difference is pi^2 (p_n - q_n) / n^2, while this term changes by a
  third of that. Its zero-mean piece (q_n - p_n) M/6 is what makes the difference (stack #429).
  - **Through 0.6.11.** With p = q and no width these are the sawtooth 0.4.16 to 0.6.11 used: y_j + (ydot_j/n)(pi - M),
    and lambda + (ndot/n^2)(pi M - M^2/2 - pi^2/3), ydot the two passes' mean at the output time. That mean changes at
    perigee, so the output stepped there. On the class-crossing fixture (GTO, B 0.06 m^2/kg; 16.7) the steps were 42 to
    77 m in position and 0.12 to 0.14 m/s in velocity at each perigee. On Molniya (B 0.044) they were 5.5 to 9.3 cm and
    3.5e-4 m/s.
  - **From 0.6.12.** At most 2 mm and 6e-7 m/s on both, the same as with drag off (one call, 5 ms states, 30 s each side;
    `test/perigee-drag-continuity.e2e.mjs`).
  - **Per segment.** From 0.6.6 these rates are evaluated per segment: the stretch of one revolution (its two passages
    fixed) inside one interval of the mean-element grid (the mean state one cubic). Each of p, q, s_p and s_q is the
    quadratic in t through the segment's three points s_0 + (k + 1/2)(s_1 - s_0)/3, each at the grid's own mean state
    there. Three evaluations serve every output state of the segment in place of one at each. Against the rates at each
    output time the state differs by 0.23 mm and 1.5e-7 m/s at most over 30 days at 60 s (test/kernel-cost.mjs --diff
    against a build that evaluates them at each state; the largest at a 250 km perigee, B 0.01 m^2/kg, active weather;
    0.23 mm and 1.4e-7 m/s for 0.6.6's one rate). A fit keeps the rates at each of its states.

At e 0.3 and below, and without drag, the path is 0.4.15's, byte for byte (the XP digest and the drag-off runs below).

Isolation, Sun and Moon off on both sides (AP's masses zero in a test build; FFM without third bodies). AP's set at B =
0.044 flown 7 days against FFM from AP's own epoch state, drag on minus drag off on both sides (the shared gravity
residual cancels); AP's drag energy per perigee pass over FFM's, all passes, and the day-7 whole-day along-track RMS (m):

| AP | Molniya | GTO | GTO-500 |
| --- | --- | --- | --- |
| 0.4.15 | 0.9840, 582 | 0.9907, 102,584 | 0.9958, 1,130 |
| passage times | 1.0002, 669 | 0.9916, 102,030 | 0.9963, 1,127 |
| and the whole orbit | 1.0024, 691 | 0.9995, 117,131 | 0.9990, 1,181 |
| and the short-period steps | 1.0026, 22 | 0.9991, 2,480 | 0.9987, 26 |

AP's density and path were not the error: along FFM's path AP's NRLMSISE-00 integrates to FFM's pass loss within 0.01 %,
and AP's own flown path carries the same work within 0.01 %, its perigee within 2 to 31 m of FFM's. The arc beyond nu_c
held 0.23, 0.88 and 0.30 % of the pass's work, the passage times 1.6 % on Molniya and nothing on the two GTOs, whose
perigee longitudes do not repeat; the quadrature's order changes nothing (13 Gauss-Legendre nodes against 401 Simpson
points). The seeded along-track error was the ramp: a continuous rate against a step is a mean-motion offset of half
the per-pass period change, 582 m to 103 km a week, which a fit takes into the mean motion. With BTERM pinned at the
truth and AGOM pinned at 0 (a 72 h fit) the energy ratio follows the seeded one, 0.9916 to 1.0054 (Molniya) and
0.9963 to 0.9995 (GTO-500), and day 7 goes from 157.2 to 93.4 m and 176.5 to 93.5 m. A pinned fit that leaves AGOM free
takes 0.0007 (Molniya) to 0.0034 m^2/kg (GTO-500) against a truth without SRP and moves the apparent drag by +0.8 and
+1.7 %, of opposite effect on the two fixtures' forecasts.

FFM model truth with the Sun and Moon (`test/drag-high-eccentricity.e2e.mjs`; 72 h fits from an osculating perigee,
7 days on a 10-minute grid, day-7 whole-day RMS along-track/radial, m):

| Case | 0.4.15 | 0.4.16 |
| --- | --: | --: |
| Molniya, BTERM pinned at 0.044 and AGOM at 0 | 165.88 / 125.20 | 70.86 / 48.56 |
| drag theory, seeded, on minus off: Molniya | 593.72 / 411.57 | 26.51 / 20.59 |
| drag theory: GTO | 99,624 / 66,866 | 3,259 / 3,408 |
| drag theory: GTO-500 | 1,118.17 / 728.27 | 31.97 / 29.34 |
| Molniya, drag off | 44.63 / 34.38 | 44.63 / 34.38 |

The fitted coefficient is 12.8's. Against the module's independent integral over one orbit
(`sdnap_drag_orbit_check`: the Gauss equations of -(1/2) rho B |v_rel| v_rel along the mean orbit, the density and the
co-rotating air at the radius of 3.4, every sample at its own time, 20,000 Simpson points per pass) the six elements'
changes over one period agree within 0.0003 m RMS on Molniya and GTO-500 and 0.023 m on GTO (2,168 m in a per orbit),
at days 0, 1, 3 and 7.

Cost (owner Mac under load, browser host, `propagate` of the seeded set over 7 days with drag, the two releases
interleaved, median of 9 runs, ms per object-day from 0.4.15 to 0.4.16):

| Orbit | 1 h grid | 1 min grid |
| --- | --: | --: |
| Molniya | 20.5 to 22.5 | 104.0 to 206.2 |
| GTO | 27.1 to 34.9 | 111.5 to 253.1 |
| GTO-500 | 25.8 to 31.5 | 105.0 to 207.1 |

A rate evaluation takes two passes of 39 nodes against 13; the 1 min grid doubles because every output sample evaluates
the drag's rates for its short-period steps. Orbits at e 0.3 and below, and without drag, run 0.4.15's path.

---

**One-day archive windows.** On 2026-11-03 the selected 38-minute step was confirmed on new 72-hour
fit cutoffs 2025-10-05, 10-09 and 10-13 for every AP6 GE/IG object, absent from AP6's original cutoff
list. These windows share AP6's GFZ truth span; they are not independent-truth validation. The AP6
300-second thinning, 90% fit coverage, 260-sample daily minimum and as-issued weather are retained.
Leads are daily bins after the fit ends. Eighteen GE and 36 IG windows pass coverage; nine GE windows
are excluded for missing fit or lead coverage. Both step arms are fitted independently.

| Group | Day | 95-min median 3D (m) | 38-min median 3D (m) | Median paired change (m) |
|---|---:|---:|---:|---:|
| GE | 1 | 18.988 | 18.512 | -0.740 |
| GE | 3 | 46.658 | 41.876 | 0.193 |
| GE | 7 | 217.657 | 235.913 | 5.860 |
| IG | 1 | 25.405 | 24.723 | -0.306 |
| IG | 3 | 34.989 | 33.328 | -0.361 |
| IG | 7 | 70.488 | 68.410 | 0.189 |

The shorter step reduces numerical integration error; these mixed archive changes do not establish a
uniform forecast-accuracy improvement. All windows and coverage exclusions are printed by the E2E and
stored in `test/results/geo-step-convergence.json`.

**16.13 The radiation term Y0 (ECOM2).** For bodies whose solar panels track the Sun (navigation satellites), AP can
carry one term of the empirical ECOM2 model beside the sphere of section 4: Y0, a constant acceleration (m/s^2) along
eY = unit(eD x r), eD the unit vector to the Sun (Arnold et al. 2015, J. Geod. 89, eq. 1; the convention of
propagator/ffm lib/gnss_srp.h). The sphere is ECOM2's direct term D0 (the two differ by (1 AU / r_sun)^2, under 0.6 %
over 10 days), so a separate D0 would only repeat AGOM; B0 and the once-per-revolution terms are not carried. Y0 is zero
where the sphere's rates count the orbit as in shadow (the same decision, 16.15 and srp_rates).

*Theory.* Y0's Gauss rates (the radial component zero) are averaged over the mean anomaly of the mean orbit on its
sunlit arc by three-point Gauss-Legendre panels: the arc's ends, the points a quarter revolution either side of where
the satellite passes the Sun's direction and its opposite, and, below a Sun elevation of 0.5 rad above the orbit plane,
offsets graded by a factor 4 from that elevation (at least 0.01 rad), where eY turns fastest. The rates are applied to
the mean elements in blocks of 6 h along the node grid, not in the rate function: each block (the first, at the epoch,
half of one) acts at its center through one quadrature at the mean state there (the cubic between the two nodes) with
the Sun of section 5 at that time, on the node a step arrives at: every element by its rate times the block, lambda also
by n's change times the time from the center to the node. A step that passes no center adds nothing; the elements
between centers are off by at most half a block's worth of the rates (0.2 m at 1e-9 m/s^2, not growing). The long-period
covariance pair step adds the same blocks, so a sigma set flies what it flies alone. Nothing is added at output time:
Y0's periodic part is Y0 / n^2, 0.05 m on a medium orbit to 0.2 m at geosynchronous radius at 1e-9 m/s^2. A set without
Y0 flies as before, bit for bit (31 and 21 windows over eleven groups, record and flight bytes, against the build before).
Measured against FFM (model truth with the sphere and Y0 = +-1e-9 m/s^2, the AP set fitted once to the sphere truth and
flown with and without Y0): on 11 windows of medium orbit, Galileo, inclined geosynchronous and geostationary, Y0 alone
moves the day-7 error by 120 to 990 m, and AP with the term is within 2.7 m of its sphere-truth error at day 7: the
theory carries at least 99.6 % of the term.

*Record.* The set's Y0 is one entry of ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS: PARAMETER ECOM2_Y0, VALUE in m/s\*\*2,
UNITS m/s\*\*2, SOLVED_FOR as the fit determined it; PERTURBATIONS.SOLAR_RAD_PRESSURE names the model in words and the
OD COMMENT says solved or held, and why. Flight refuses, by name: ECOM2_Y0 on an SGP4 or SGP4XP set or on an AP set
whose gravity caps are both 0 (elements-other-theory), twice (parameter-repeated:ECOM2_Y0), not a number or in other
UNITS (parameter-invalid:ECOM2_Y0), any other ECOM2 coefficient (parameter-not-modeled:<NAME>). A set with Y0 round-trips
only as a record: inside the module Y0 rides in the row's first-derivative slot (ElementRow.mean_motion_dot), which an
SGP4XP or AP set does not have (1.1); a row from outside of theory SGP4XP with that slot not 0 is refused
(sdnap_init_elements holds it refused, elements-other-theory; sdnap_fit refuses it). No export returns an AP row:
export_omm refuses AP sets (17.6), and sdnap_fit neither takes Y0 nor fits it (fit_y0 set:
parameter-record-only:ECOM2_Y0).

*Fit.* $PCF FORCES.ECOM2 on `fit` puts Y0 in the fit: Y0_M_S2 is its start, its prior's mean and the value it is held
at where it is not solved; any other ECOM2 coefficient away from 0 is refused by name (FORCES.ECOM2.D0_M_S2 ...), and so
is the table without AP's gravity terms (FORCES.ECOM2). A flight takes no FORCES (16.1). Y0 is solved on an arc of 72 h
or more (71 h, for an arc sampled off its ends) whose fitted set lies above the drag (perigee at or above 2,500 km): in
the whole-arc fit after the staged ones and in the passes at the data's own sigma (12.1),
as the last parameter, in units of 1e-9 m/s^2, its column a one-sided difference of the theory each iteration (step
the larger of 1 % and 1e-10 m/s^2), with a Gaussian prior about Y0_M_S2 of sigma 1e-9 m/s^2. The cost, the normal
equations and the covariance read one statement of the fit's priors (drag, AGOM, Y0). Elsewhere Y0 is held at Y0_M_S2:
an arc under 72 h (a 24 h fit), a set under the drag, and the second stage of a two-stage fit (at the first stage's Y0).
Through 0.6.18 the one-day class held it too (below). Y0 is not a covariance row (17.1): the covariance holds it at its solved value. On the real 72 h
windows of medium orbit, Galileo, inclined geosynchronous and geostationary sets the share of errors beyond the stated
1, 2 and 3 sigma per RTN axis at days 1, 3, 5 and 7 is the same with Y0 solved as without (the stated sigma is 5 to 100
times the error in both: stack issue 433). AGOM moves by under 1 % between the fits with and without Y0.

*Why 72 h.* On model truth a 48 h arc does not determine Y0: Galileo's came out at 2.0 and 2.1 times its value on two
windows of three and a zero Y0 at 7e-10 m/s^2 on two (day 7 175 and 296 m against 37 and 24 m without the term), while
72 h recovered 0.97 to 1.22 times the value and found at most 1.4e-10 where there was none. On real windows a 48 h Y0
still lowers the medians (medium orbit day 7 73 to 37 m, Galileo 174 to 64 m); it is not trusted.

*The one-day class (geostationary, inclined geosynchronous).* Through 0.6.18 Y0 was held there. The class lacked its
resonant gravity above degree 4 (stack #434), a constant along-track acceleration of up to 2e-10 m/s^2 set by the
longitude, and a free Y0 took it up. The guard was to go when that class's residual was fixed, on the condition that a
zero Y0 come out at most about 1e-10 m/s^2 on model truth and the real medians not get worse. From 0.6.19 the class
carries that gravity (6.1, 16.2) and solves Y0 as the other classes do. **The condition is not met.** What is left of
the class's residual is the Moon's position (SPEC 5, stack #446). On model truth with no Y0 in it (the radiation lane's
sphere truths of real windows), the 72 h fit finds:

- inclined geosynchronous (C005, C010, C221): -0.8e-10 to -1.4e-10 m/s^2, and the day-7 error goes from 20.0, 14.0
  and 19.1 m to 80.7, 61.8 and 83.4 m;
- geostationary (C018, C229, C020 twice): +1.3e-10 to +3.0e-10 m/s^2, where it helps (day 5 13.4, 14.7 and 37.7 m to
  3.6, 5.1 and 9.0 m; C229 day 7 34.2 to 9.7 m).

On made-up inclined geosynchronous sets with the field cut to 4 x 4 on both sides it finds -2.7e-10 to +1.0e-10, and at
most 3.7e-11 with DE440's Moon in a scratch build (`test/one-day-moon-floor.e2e.mjs`, a known defect, bound 5e-11). The
condition is met when #446 lands.

The lift lands anyway, because the real windows gain on both rows. Real 72 h windows; medians at days 1, 3, 5 and 7, and
the windows within 100 m of the numerical propagator (FFMq) at day 5. The table's harness flew 0.6.18 and 0.6.19 with
FORCES.ECOM2 on these rows; the middle column is the tail alone, flown without it on a candidate build:

| Row | 0.6.15 to 0.6.18, Y0 held | the tail, without FORCES.ECOM2 | 0.6.19, Y0 solved | Numerical (FFMc) |
| --- | --- | --- | --- | --- |
| geostationary | 11.67, 35.28, 95.84, 198.26 m; 23 of 32 | 12.97, 53.30, 131.01, 256.15 m; 17 of 32 | 5.84, 23.37, 88.36, 191.23 m; 26 of 32 | 2.05, 5.96, 20.31, 47.57 m |
| inclined geosynchronous | 4.78, 13.01, 27.02, 38.70 m; 52 of 59 | 4.72, 13.45, 23.05, 40.37 m; 51 of 59 | 3.39, 12.61, 31.29, 56.37 m; 59 of 59 | 0.39, 1.45, 3.49, 6.29 m |

Against 0.6.18, 13 windows move onto the line and 3 move off it.
- Onto it: geostationary C006, C011, C016 and C018 once each, and J003 twice; inclined J002 twice and J004 five times.
- Off it: three C020 windows, whose day-5 errors go from 61.2, 54.4 and 54.7 m to 133.3, 125.8 and 115.3 m. With the
  tail, that satellite sits where a numerical propagator with only a sphere does, and Y0 alone does not carry its
  radiation (stack #457).

Per satellite: the recovered Y0 (measured on the candidate build) against the numerical propagator's ECOM2 Y0 (FFMc,
five terms), medians, with the day-5 median error without Y0 (the tail alone) and with it (0.6.19):

| Satellite | AP's Y0 (m/s^2) | FFMc's Y0 (m/s^2) | Day 5 without, with Y0 |
| --- | --- | --- | --- |
| C006 BDS-2G | -1.06e-9 | -1.23e-9 | 137.0, 23.9 m |
| C011 BDS-2G | -0.93e-9 | -1.01e-9 | 114.9, 19.4 m |
| C016 BDS-2G | -1.02e-9 | -0.98e-9 | 143.0, 17.5 m |
| C018 BDS-2G | -1.17e-9 | -1.53e-9 | (burns: 74 km either way) |
| C020 BDS-2G | -0.02e-9 | -1.52e-9 | 117.0, 115.3 m |
| C217 BDS-3G | +0.03e-9 | -0.38e-9 | 25.1, 15.6 m |
| J003 QZS-2G | -0.40e-9 | -2.26e-9 | 176.6, 163.8 m |
| J002 QZS-2I | +0.44e-9 | +0.36e-9 | 116.9, 14.5 m |
| J004 QZS-2I | -1.44e-9 | -0.93e-9 | 222.5, 20.1 m |
| BeiDou inclined (10 satellites) | within 1e-10 of FFMc's | -1.5e-10 to +1.1e-10 | 13.2 - 44.2, 27.5 - 40.6 m |

The tail makes Y0 physical. Without it, the same fit finds -0.74e-9 on C006 and C011, where FFMc has -1.23e-9 and
-1.01e-9.

J003's Y0 is poorly determined (stack #457). Between the candidate build and 0.6.19, whose states differ by under a
millimeter, its five windows move by -29 to +47 m at day 5. One of them (2025-10-10, 77.5 to 103.8 m) crosses the middle of
the 32 windows, which moves the row's day-5 median from 78.3 m on the candidate to 88.4 m on 0.6.19.

What the lift costs: against 0.6.18, the BeiDou inclined satellites' day-5 medians grow by 2 to 23 m (median 12 m), all
still far inside the line. The inclined row's medians rise from 27.02 to 31.29 m at day 5 and from 38.70 to 56.37 m at
day 7. The cause is the Moon's error leaking into Y0, as on model truth.

C020 and J003 (QZS-2G) need more than Y0 (stack #457). There Y0 does not lower the fit's RMS (C020: 5.86 m with and
without), and the forecast stays where a numerical propagator with only a sphere is (FFMr, C020 135 to 157 m at day 5),
while FFMc, with five ECOM2 terms, is at 12.3 and 14.8 m.

Fitted from Y0 starts of 0, +1e-11 and -1e-11 m/s^2, two windows (C020 2025-10-04, C006 2025-10-08) end within 0.10 m of
each other at day 7, so the fit's stopping point is not where the spread comes from. With Y0 solved, the stated
covariance still covers the error on geostationary, BeiDou inclined and QZS windows. |z| = error over stated sigma per
RTN axis is at most 0.21 at days 1, 3, 5 and 7 on six windows (C006, C020, C010, C224, J002, J004), against at most 0.21
without Y0. The stated sigma is far too wide in both cases (stack #433).

Commercial geostationary satellites keep station by thrusting, and Y0 does not serve them. On eight 72 h windows (Eutelsat
117 West B, Galaxy 30, SES-15) the fit finds 2e-11 to 3e-9 m/s^2 while FFMc's Y0 takes up the maneuvers (2e-7 to 4e-6).
The day-5 median moves from 14,739 to 14,787 m and the pass count stays 7 of 8, so that row is fitted without
FORCES.ECOM2.

*Who states it.* The term is for bodies with Sun-tracking panels. On a sphere it fits the residual instead: on six laser
geodetic windows (Etalon, LAGEOS, LARES-2; 72 h) the median day-7 error went from 11 to 29 m (Etalon 2 12 to 38 m, LAGEOS
1 9 to 39 m; LARES-2 23 to 6 m), and the eccentric science orbits (TESS, Chandra, THEMIS) got worse too.

*Measured gain.* Real 72 h windows, ten each, median error at day 1, 3, 5 and 7, without and with FORCES.ECOM2: medium
Earth orbit 8.4, 20.0, 46.4, 84.4 m to 7.6, 9.6, 12.6, 15.2 m (within 100 m of the numerical propagator at day 5: 8 to
10 of 10); Galileo 15.2, 51.4, 106.9, 181.1 m to 10.7, 13.2, 23.8, 37.5 m (6 to 10 of 10). The recovered Y0 over the
numerical propagator's ECOM2 Y0 on the same windows: median 0.94 and 1.02.

*The daily fit.* A short fit can carry the Y0 of a longer one: fit 72 h under FORCES.ECOM2 (Y0 solved), then state
FORCES.ECOM2.Y0_M_S2 as that record's ECOM2_Y0 VALUE in each later fit shorter than 72 h, which holds it (SOLVED_FOR
false). On the real 24 h rows, with the Y0 of a 72 h fit ending 24 h before the 24 h fit's cutoff, the median error at
day 1, 3, 5 and 7 went from 8.5, 17.8, 35.5, 59.8 m to 8.2, 13.8, 20.7, 29.7 m on medium Earth orbit (within 100 m at day
5: 8 to 10 of 10) and from 11.6, 32.9, 89.3, 156.7 m to 11.4, 20.4, 42.8, 63.1 m on Galileo (8 to 10 of 10); one window
of twenty got worse (Galileo IOV 2, day 7 23 to 89 m).

*Cost.* A record with Y0 takes 12 % longer to fly its first week: about 22 microseconds per block (a graded quadrature
of some 60 points), 5.14 to 5.76 ms for a Galileo record flown a week hourly by `propagate` (decode, initialization,
grid, states; medians of 40 calls, under a load of 10 on 28 cores), 3.31 to 3.39 ms for a day at 60 s. Once the grid
exists a state costs the same.

`test/radiation-y0.e2e.mjs` checks the theory and the fit on a Galileo-like and an inclined geosynchronous orbit, the
daily fit, a held fit against the fit without the term byte for byte, and the refusals.

**16.14 The solid Earth tide.** The Moon and the Sun raise a tide in the solid Earth, and its gravity reaches the
satellite. From 0.6.20 AP carries it on request: $PCF FORCES.SOLID_TIDES IERS_2010 on `fit`, the field and the model FFM reads
(propagator/ffm `lib/force_models.cpp`, `lib/iers2010_tides.h`: IERS Conventions 2010, section 6.2, steps 1 and 2, on
a tide-free field), so one configuration means the same in both propagators. NONE, the field's default on the wire,
leaves the tide out, and a set fitted without it flies as before, bit for bit.

*Theory.* The degree-2 tide raised by a body of gravitational parameter mu_b at distance r_b adds at the satellite the
potential k2 (mu_b / r_b^3) (R^5 / r^3) P2(cos psi), psi the angle between the satellite and the body: the
third-body quadrupole of section 5 with the radial law R^5 / r^3 in place of r^2. AP writes the two bodies' tide as
r^-3 r.T.r, T the symmetric traceless tensor (3/2) (mu_b R^5 / r_b^3) (s s^T - I/3) summed over the Sun and the Moon of
section 5 at the stage time, with each order m about the Earth's axis (zz; xz, yz; xx - yy, xy) weighted by its Love
number of IERS Table 6.3: k20 0.30190, |k21| 0.29830 and |k22| 0.30102, the m = 1 and m = 2 parts turned east of the
body by -arg(k2m) / m (0.28 and 0.12 deg: the imaginary parts -0.00144 and -0.00130, the anelastic lag). Step 2's
diurnal band (Table 6.5a, 48 lines, K1 470.9e-12 the largest) is, seen from inertial axes, a degree-2 order-1 term
C' cos(alpha) + S' sin(alpha) with C' = sum(ip sin b - op cos b) and S' = -sum(ip cos b + op sin b), b the line's
Delaunay argument (GMST cancels): it is added to T once, at the set's epoch (over 10 days b moves the band by under
3e-12 of its 5e-10). With W the orbit normal, g = T W and P = W.g, the potential averaged over the mean anomaly is exact
in closed form, -P / (2 a^3 eta^3), and with D = 1 / (n a^5 eta^4), N the node and M the in-plane direction 90 deg past
it, the Lagrange equations give

di/dt = D g.N, sin i dOmega/dt = D g.M, d varpi/dt = D (tan(i/2) g.M - 1.5 P),
d lambda/dt - n = D (tan(i/2) g.M - 3 eta P - 1.5 e^2 P / (1 + eta)), de/dt = dn/dt = 0,

written in the equinoctial elements, regular at i = 0 and e = 0. They are added to the mean-element rates at every
stage in both regimes (a covariance's moved sets each at their own: 12.3), at the state of the stage. With a single k2 the average is k2 (mu_b R^5 / r_b^3) (1 - 3 (w.s)^2) / (4 a^3 eta^3); against the
quadrupole of section 5 the tide is k2 (R/a)^5 of it on a circular orbit, 17 % at 800 km. The Moon's tide is a J2 of
1.69e-8 about the Moon's direction, the Sun's 0.77e-8; their mean over the bodies' motion is the permanent tide, a J2
change of +9.4e-9, which AP's tide-free J2 (1.3) does not hold and the term supplies, as FFM's step 1 does on its
tide-free field. Nothing is added at output time.

*What is left out, and its size.* Degree 3 (k3m 0.093), degree 4 through k+, step 2's long-period and semidiurnal
tables (Tables 6.5b and 6.5c, at most 16.6e-12 and 1.2e-12) and the tide's short-period part are not carried. On model
truth (below) all of them together move AP's day-5 error in low orbit by at most 0.42 m and its day-7 error by 0.67 m,
and its in-arc fit by at most 0.05 m in low orbit and 0.18 m on the eccentric orbits (the short-period part at perigee). Of the parts carried, each moves the
day-5 error by at most (largest of 17 low orbits, 72 h fits): step 2's band 0.41 m, the lag 0.39 m, the Love number
per order against k20 for all three 1.07 m (day 7: 0.56, 0.76 and 1.57 m).

*Measured* (model truth: FFM EGM96 70 x 70, Sun and Moon from DE440, 10 days from an AP-consistent state at
2026-09-01 on a 300 s grid, with FFM's solid tide and without; AP under the headline's forces, tesseral 31, zonal 20,
BTERM and AGOM held at 0, fitted over 72 h or 24 h and flown 7 days; whole-day 3D RMS). On 16 near-circular orbits
(690, 800, 1,340 and 1,490 km; i 50, 66, 98, 108 deg) the median at day 5:

| Fit | no tide either side | the tide in FFM only | the tide in both |
| --- | ---: | ---: | ---: |
| 72 h | 28.5 m | 68.3 m | 28.3 m |
| 24 h | 48.2 m | 64.0 m | 48.1 m |

By altitude (72 h, day 5, the same three columns): 690 km 92.9, 121.0, 92.8 m; 800 km 58.6, 66.5, 58.8 m; 1,340 km 14.4,
60.7, 14.4 m; 1,490 km 15.5, 65.9, 15.6 m. On each orbit AP with the term is within 0.42 m (day 5) and 0.67 m (day 7) of
its error without the tide on either side; a Starlette-like orbit (812 x 1,100 km) too (58.0 against 57.9 m). Further
out the tide is smaller and the term carries it the same way: on a GPS-like orbit the tide in FFM alone moves AP's day-5
error by 4.1 m and with the term AP is within 0.02 m of its level; on a geostationary set 0.07 and 0.01 m; on a
transfer orbit (e 0.72, perigee 454 km) 1.1 and 0.03 m (day 7 of a 24 h fit: 9.2 and 0.13 m); on a THEMIS-like set
(e 0.82, the long-period regime) 6.5 and 0.01 m (a 24 h fit: 1.5 and 1.5 m, of 349 m).

*What the tide uncovers.* With the term AP's error is its error in a world without the tide: on a Sentinel-6A-like
(1,336 km, i 66) and a Sentinel-1-like orbit (693 km, i 98), four nodes each, FFM with drag, a cannonball, relativity and
70 x 70 (and without drag and radiation, and with the field at 12 x 12), AP fitted over 24 h and 72 h with FIT unset and
with B and AGOM held at the truth's, AP with the term on the tide truth equals AP without it on the truth without the
tide within 0.67 m at day 5 in all 96 cases. Whether the error falls depends on what else AP misses. Under FIT unset at
1,336 km the fit holds BTERM at the band median of 12.8, 0.0005 m^2/kg against the truth's 0.02, 100 to 200 m along
track at day 5, and the term wins on 4 of 8; with B and AGOM held, on 7 of 8. At 693 km, with B and AGOM held, AP is
40 to 126 m at day 5 without any tide (the field above degree 12, carried in part), and the term wins on 5 of 8; with the
field capped at 12 on both sides, on 8 of 8. On real windows the tide moves rows both ways, and two rows get worse with
it: the altimetry rows' 24 h fits and near 700 km at 72 h. The model world names what the missing tide was offsetting
there: the drag coefficient at its default (stack issue 460) and the field above degree 12. On real windows tesseral
degrees 13 to 16 alone do not restore them.

*Covariance.* The stated covariance hardly moves with the term. A 72 h fit's position sigma on the tide truth at days
1, 3, 5 and 7, medians of the 17 low orbits, with the term: radial 7.5, 8.4, 10.4, 12.6 m, in-track 252, 1,216, 2,192,
3,157 m, cross-track 10.7, 27.6, 47.8, 68.4 m; without it the same within 0.1 m but cross-track at day 1 (11.2 m). The
errors fall more: cross-track errors beyond 1 sigma are 82, 25, 15 and 19 of 408 hourly states without the term and 67,
3, 0 and 1 with it, as for AP without the tide on the truth without it. Radial and in-track shares do not change.

*Record.* A set fitted under IERS_2010 states PERTURBATIONS.SOLID_TIDES_MODEL "IERS 2010", and every flight reads it
there and nowhere else; an AP set with gravity terms fitted without it says so in its OD COMMENT ("solid Earth tide: not
modeled (FORCES.SOLID_TIDES NONE)"). Refused by name: on `fit` IERS_2010 without the gravity terms or any other value
(configuration-refused, FORCES.SOLID_TIDES); in a flight SOLID_TIDES_MODEL other than "IERS 2010"
(solid-tides-unsupported), or on an SGP4 or SGP4XP set or an AP set whose gravity caps are both 0
(elements-other-theory).

*Why not by default.* The $PCF cannot tell SOLID_TIDES left unset from NONE written, so the module cannot apply the
tide by default without overriding an explicit NONE (stack issue 455 asks the standard for an UNSPECIFIED value).

*Cost.* About 100 floating-point operations per rate evaluation and no trigonometry; the band once per set. AP's cost
per state with the tide over without it, `test/kernel-cost.mjs --solid-tides` on seven regimes at 300 s and 60 s, two
alternating pairs under a load of 63 to 92: median 1.013, the spread (0.84 to 1.28) the load's.

`test/solid-tides.e2e.mjs` checks the term against model truth on two low orbits, NONE written against the field
unset, the long-period regime's stated covariance with the tide, and the refusals.

**16.15 AP's shadow.** Every AP set takes this shadow in place of section 4's: in the sphere's rates (srp_rates)
and in Y0's sunlit arc (16.13). Section 4's closed form, kept as the library computes it, decides by rounding in two
places (stack issue 464):
- A candidate root counts as a boundary only when |S| < 1e-12. Where a boundary lies within a few degrees of an apse of
  the mean orbit, x = cos nu is near +-1, and sin nu = sqrt(1 - x^2) magnifies the root's rounding by 1 / sin nu.
  |S| at the root then falls between 1e-13 and 2e-12. The rates flip between the sunlit arc and the wholly sunlit
  orbit with the last bits of the elements, and the whole eclipse's share of the rates moves for a node step (two
  revolutions on a Galileo orbit, 4.6 % of the eccentricity vector's rate in one case).
- Near-equatorial long-period AP sets (inclination below 0.02 rad, a above 5 Earth radii) took section 4's sequence
  itself, which is rounding-limited at geosynchronous radius.

Under a change of 1e-10 relative in the mean motion, 7-day flights in an eclipse season moved by up to 10 m on
Galileo-like orbits, 35 m GPS-like, 3.5 to 9.4 m geostationary and inclined geosynchronous, 1.0 m at 800 km, 0.4 m
laser geodetic and 145 m on a transfer orbit; the change itself moves them 0.2 to 0.6 m along track, linearly. A fit that solves
AGOM, or Y0 beside it, stopped where rounding put it (stack issue 456).

*The shadow.* Section 4's cylinder of radius R_E on the current mean orbit:
- A, B are the Sun's direction cosines on P and Q, F = A^2 + B^2, phi is the Sun's direction in the orbit plane and
  u = nu - phi - pi the angle from the anti-Sun direction. The night half is |u| < pi/2.
- The shadow is where S(u) = p^2 F cos^2 u + d^2 - p^2 > 0 (d = 1 + e cos nu). S is negative at both terminators
  (S = d^2 - p^2 there, because the perigee is above the surface).
- S's largest value on the night half decides. It is searched at u = 0, then at u = j pi/10 (|j| <= 4), then by
  Newton's method on S' inside the neighbors of the best point. Not above 0: wholly sunlit.
- Above 0: the entry and the exit are the roots of S on either side, each found by Newton's method kept inside its
  bracket (bisection where a step leaves it) to full precision.
- E1 (exit) and E2 (entry, + 2 pi when not above E1) feed section 4's formulas: AP's arrangement of them where the
  set's angles allow, section 4's own for near-equatorial long-period sets. Section 4's test that the cylinder cannot
  reach the orbit (F < 1 and (1 - F) a_min^2 > 1.000002) stays as the first step.
- `sdnap_shadow_policy` 3 (no boundary) makes AP wholly sunlit too; policies 1 and 2 act on SGP4XP alone.

*Continuous, not smooth.* No tolerance decides a branch, so the rates are continuous in the elements. At the season's
edge the two roots merge, and the sunlit-arc formulas over E2 - E1 = 2 pi are those of the wholly sunlit orbit. The
rates are not smooth there: the arc grows as the square root of the orbit's depth in the cylinder.

*One sunlit arc per revolution*, as section 4 assumes, measured: 6,318,000 geometries, 4,636,757 of them shadowed,
none with more than two boundaries on the night half (4,000 samples of it each). The grid: e from 0 to 0.9 (15
values), perigee radius from 1.005 to 60 Earth radii (13 values), 90 Sun elevations up to the highest whose cylinder
reaches the orbit, 360 directions in the plane.

*No shadow missed, none added*, measured against S itself: 4,000 samples of the night half, every sampled maximum
refined by golden section to 1e-14 rad, a shadow wherever a refined maximum is above 0.
- On the grid above, there is no miss and no false shadow among 6,318,000 geometries, 4,638,201 of them shadowed. Where
  both see a shadow, their widths agree to 8e-7 deg of true anomaly.
- The grazing band covers e 0 to 0.9 (18 values), perigee radius 1.005 to 6.61 Earth radii (20 values) and 360 Sun
  directions. Each direction's grazing elevation is bisected on S, then 33 elevations below it are flown, from 1e-1 to
  1e-12 of it below. That is 4,151,232 geometries, all shadowed. None is added. 17,283 are missed, each within about
  1e-12 of its grazing elevation, with S's largest value at most 4.4e-16 p^2 (the rounding of S itself) and a shadow at
  most 1.24e-5 deg of true anomaly wide.
- Neither set has a geometry with two maxima of S on the night half. test/radiation-shadow.e2e.mjs sweeps a transfer
  orbit through grazing where the maximum lies 37 deg from the anti-Sun direction.

*Measured* (`sdnap_ap_srp_rates`: mode 0 the theory, mode 1 the same sphere and cylinder averaged numerically over
one revolution by the Gauss equations, the Sun held fixed; test/radiation-shadow.e2e.mjs):
- The six rates agree within 7.6e-7 of each rate's scale, through grazing (Galileo-like and geostationary) and with
  the exit or the entry crossing the perigee. Their steps along the sweep equal the average's to three digits.
- The transfer orbit (e 0.73), every direction of the Sun in its plane: 7e-7, except a_f (next item).
- The perigee-stepped nudge scans, made-up sets in season:

  | Orbit | Rough flights, section 4's shadow (0.6.20) | 16.15 |
  | --- | --- | --- |
  | Galileo-like | 24 of 120 | 0 of 120 |
  | GPS-like | 15 of 120 | 0 of 120 |
  | laser geodetic | 3 of 120 | 0 of 120 |
  | 800 km | 6 of 120 | 0 of 120 |
  | transfer orbit | 18 of 120 | 0 of 120 |
  | geostationary at i 0.05 deg | 5 of 24 | 0 of 24 |
  | geostationary at i 2 deg | 6 of 24 | 0 of 24 |
  | inclined geosynchronous | 11 of 24 | 0 of 24 |

  "Rough" means the departure from a linear drift exceeds 1 cm; with 16.15 it is at most 0.9 mm over 7 days.
- The transfer orbit's worst flight before: the exit fell 0.008 deg past the perigee, and one node evaluation
  rejected its root (|S| = 2.7e-12) and took the orbit as wholly sunlit. 16.15 takes the arc there; the numerical
  average agrees with it.
- Real fitted records: two of the release table's 0.6.20 records (72 h, ECOM2, the solid tide stated), each flown 7
  days from its cutoff with the tide stated and with that entry removed, the 3D difference at the cutoff / day 3 /
  day 5 / day 7 (m). The tide's own term is about a meter:

  | Record | 0.6.20 | 16.15 and 16.16 | 0.6.20, the shadow out of play (policy 3) |
  | --- | --- | --- | --- |
  | QZS-2G, one window in season (i 0.074 deg, Y0 -1.9e-9 m/s^2) | 3.05 / 5.12 / 6.59 / 8.11 | 0.50 / 0.92 / 1.27 / 1.66 | 0.45 / 0.86 / 1.21 / 1.62 |
  | Galileo IOV 2, one window in season | 19.24 / 22.10 / 17.47 / 33.66 | 0.97 / 1.67 / 2.33 / 3.05 | 0.90 / 1.57 / 2.15 / 2.95 |

  On 0.6.20 QZS-2G's near-equatorial long-period sets took section 4's own sequence, and Galileo's radial part swings
  by up to 4 m once per revolution. With 16.15 the radial part is 0.000 m on both, and the along-track part grows
  smoothly.

*Bits.* SGP4XP and SGP4 are section 4's and unchanged. AP sets with AGOM 0 fly byte for byte, and so do AP orbits
wholly sunlit over the flight. In shadow, where section 4's decision was right, a flight moves by nanometers (4e-9 m
over 7 days on a Galileo-like set), because the boundaries are now solved to full precision.

*The pressure constant.* AP keeps section 4's P = 4.5e-6 N/m^2, and SGP4XP must. The numerical propagator's
cannonball uses the solar flux 1361 W/m^2 / c = 4.54e-6 N/m^2. A fit takes the 0.88 % into AGOM: fitted against
FFM's sphere, AGOM comes out 0.8 to 0.9 % above FFM's coefficient, with nothing lost in forecast (three real
geostationary windows, 2025-10). An AGOM taken from a spacecraft's physical area, mass and reflectivity instead of
fitted is 0.88 % low in AP's units against a propagator that uses 1361 W/m^2.

*Not carried, with their sizes.* Each size is the difference over 7 days of a made-up flight with the same epoch
state and integrator, in season.
- **The penumbra.** AP's shadow is the cylinder; the numerical propagator flies a cone with umbra and penumbra. The
  same sphere averaged numerically in the cone (mode 2, the illuminated fraction of the Sun's disc) against the
  cylinder: 2.7 cm Galileo-like, 2.1 cm GPS-like, 2.8 cm geostationary, 2.2 cm inclined geosynchronous, 0.3 mm laser
  geodetic, 1.4 mm at 800 km, 5.7 cm on the transfer orbit; 0 for a wholly sunlit orbit. The penumbra lies across the
  cylinder's edge, so the light it removes outside the edge and adds inside nearly cancel.
- **Section 4's sunlit-arc eccentricity-vector rate at high eccentricity** (stack issue 466). Against the numerical
  average, a_f-dot departs by 1.1e-4 of its scale at e 0.1, 1.1e-3 at e 0.3 and 1.2e-2 at e 0.73, in shadow only
  (4e-15 wholly sunlit). In flight that is 2.3 to 3.5 m on the transfer orbit (e 0.73, AGOM 0.02) and under 0.3 mm on
  near-circular orbits.
- **The shadow's periodic motion** (stack issue 472, the second clash of 16.16). The output-time terms add, through
  the shadow, the periodic motion of a force that is off there. What it leaves, measured as in 16.16:

  | Orbit, in season | Along track at day 7 | Within-day span | Radial RMS |
  | --- | --- | --- | --- |
  | geostationary | -3.7 m | 6.2 m | 1.4 m |
  | C229-like geostationary (i 1.7 deg) | -1.5 m | 8.0 m | 1.4 m |
  | inclined geosynchronous | -5.5 m | 6.1 m | 1.2 m |
  | Galileo-like | 13.7 m | 5.7 m | 0.9 m |
  | GPS-like | -3.0 m | 3.0 m | 0.6 m |
  | 800 km | -6.6 m | 1.2 m | 0.4 m |
  | laser geodetic | -0.5 m | 0.1 m | 0.006 m |

  Out of season, as the numerical model's own baseline: -5.8 m on the C229-like set and -0.9 m Galileo-like.

*Cost*, measured niced under a load of about 100: the shadow takes 265 ns against the closed form's 183 ns per call at
Galileo radius, 282 against 165 ns geostationary, 691 against 202 ns at 800 km and 821 against 171 ns on the transfer
orbit. The shadow is evaluated at nodes and stages, about 150 to 240 times per 7-day flight. kernel-cost's per-state
costs moved by 0.94 to 1.16 times, within that load's spread. The release's speed table, flown on the final bytes in
a quiet slot, is the cost of record.

**16.16 The mean longitude over a sunlit arc** (stack issue 472). Section 4's averaged rates count the shadow; its
output-time short-period terms (Kozai 1961; Aksnes 1976) do not, being periodic in E with the Sun held fixed and no
shadow. The two clash in an eclipse season, twice:
1. Section 4's rate of lambda over a sunlit arc takes the sunlit average of the Gauss rate plus the sunlit average of
   the output-time mean-motion term Delta n = 3 F_s (A cos E + B eta sin E) / (a n). The numerical average of 16.15
   reproduces section 4's lambda rate only with Delta n added over the sunlit arc: at e 0, 2.5 times the Gauss rate's
   average. But the output-time terms map n_osc = n_mean + Delta n over the whole revolution, the shadow included. The
   mean longitude's rate that agrees with that mapping takes Delta n over the whole revolution.
2. The output-time terms add, through the shadow, the periodic motion of a force that is off there.

*What AP takes.* For (1), an AP set's rate of lambda over a sunlit arc adds Delta n's share over the shadow, in closed
form:

  (1 / 2 pi) int over E2 .. E1 + 2 pi of Delta n (1 - e cos E) dE = 3 F_s / (2 pi a n) [G(E1 + 2 pi) - G(E2)],
  G(E) = A sin E - B eta cos E - e (A (E / 2 + sin E cos E / 2) + B eta sin^2 E / 2).

At e 0 this is 3 F_s sin(h) / (pi a n), h the shadow's half-angle: 2.8e-10 rad/min at geostationary radius for AGOM
0.022. It vanishes with the shadow, so the rates stay continuous (16.15) and a wholly sunlit orbit flies byte for byte.
(2) is not carried (16.15 states its size). SGP4XP keeps section 4.

*Measured.* The method:
- A flight's response to the sphere is the set flown minus the same set with AGOM 0, from the same mean elements.
- The numerical response is a flight of each of the two AP epoch states, with the sphere in the cylinder and without
  it: two bodies, J2, the Sun and Moon of section 5, RK4 at 1 minute. The residual is AP's response minus the
  numerical one; the numerical model's own shortfalls cancel to first order.
- Made-up sets in season, 7 days on a 10 minute grid, the along-track residual at day 7:

  | Orbit, in season | Section 4's rate | 16.16 | 16.16 and (2), numerical |
  | --- | --- | --- | --- |
  | geostationary | 91.7 m | -3.7 m | -0.8 m |
  | C229-like geostationary | 64.7 m | -1.5 m | -4.2 m |
  | inclined geosynchronous | 70.7 m | -5.5 m | -2.3 m |
  | Galileo-like | 115.6 m | 13.7 m | -2.4 m |
  | GPS-like | 76.9 m | -3.0 m | -0.07 m |
  | 800 km | 13.1 m | -6.6 m | 1.5 m |
  | laser geodetic | 1.4 m | -0.5 m | -0.3 m |

  The last column computes (2) numerically at every output time (zero-mean periodic parts of the notched rates
  minus those without the shadow). What it leaves equals each set's out-of-season residual: -5.8 m C229-like,
  -0.9 m Galileo-like.
- The closed form agrees with the same term computed numerically to centimeters in flight.
- Between AP with and without 16.16, a 7-day flight in season moves by 103 m (geostationary) and 110 m
  (Galileo-like), and out of season it is byte for byte.
- Fitted to the numerical propagator's cannonball (FFM, cone, EGM96 70 x 70, Sun and Moon, no Y0 in the truth),
  72 h, then flown, with 16.15 and 16.16 against without them, day 5 / day 7:

  | Set | Without | With |
  | --- | --- | --- |
  | geostationary, made-up, in season, i 0.05 deg | 28.1 / 43.6 m | 12.9 / 17.2 m |
  | geostationary, made-up, in season, i 2 deg | 24.3 / 41.3 m | 12.1 / 15.6 m |

  The fitted AGOM moves from 2.3 % low to within 0.05 % of the truth's (times 1.0088, 16.15). On the release
  table's real geostationary rows, 72 h fits with ECOM2 as the table flies them: the day-5 median goes from 88.4 to
  26.9 m and the windows inside the line from 26 to 29 of 32 (QZS-2G: Y0 found -2.14e-9 against the numerical
  propagator's -2.26e-9). Inclined geosynchronous rows: unchanged.
- Cost: one closed-form term (two sines and cosines) where a sunlit-arc rate is evaluated.

**16.17 The Sun and Moon of AP.** AP does not read section 5's Sun and Moon; SGP4XP keeps them bit for bit (`bodies_at`,
`sun_at`). Every AP path reads its own (`ap_bodies_at`, src/ap_bodies.inc): the rates in both regimes, the output-time
terms, the radiation pressure and its shadow, the radiation term Y0 (16.13), the drag passes (16.12) and the Sun of the
drag atmospheres. Flights read it through `bodies_at_ap`, the quintic through its values at the six nodes about the time,
the nodes on an absolute grid of UTC every 8 hours (node k at 8k hours from 1950 January 0.0). Against the series at the
same instants (20,000 instants of 2010-2035) the quintic is off by 0.00017 arcsec at the median and 0.0025 at the 99.9th
percentile for the Moon (4 cm and 0.37 m in distance), 3e-8 and 2e-7 arcsec for the Sun; the largest, 0.017 arcsec and
1.2 m, fall on the days with a leap second, whose UTC day is 86,401 s long. The second difference of either unit vector
(60 s apart) steps by at most 1.5e-9 arcsec (Sun) and 1.2e-5 arcsec (Moon, mostly its own change of curvature) at a node.
A node is a function of its time alone, so no set fills or owns one: each thread keeps the nodes it has read in a store
of 256 slots by node index (85 days) and the six it read last, and every set and every thread reads the same numbers in
any order. A batch of records at one time evaluates a node once per thread, not once per record; a fresh record whose
epoch another record already flew reads its nodes from the store. Two times 85 1/3 days apart (256 nodes) share a slot:
a thread asked for them in turn evaluates again the node it gave up (about 4.2 µs a node) and reads the same numbers, so
a batch whose sets lie more than 85 days apart costs more on that thread and gives the same states. The grid is in UTC:
on a leap-second day the series, a function of TT, bends where the UTC day begins and ends, which is where the quintic's
largest errors fall, far inside the series' own 0.74 arcsec. A grid in TT would need UTC to TT at every read (ERFA's
leap-second lookup, some 0.3 µs against about 20 ns for the read), so it stays in UTC. A batch at one time
(`plugin_propagate_batch`, `sdnap_propagate_soa`) is SGP4XP's path: it flies the row store, which in the shipped module
holds no AP set (`sdnap_init_elements`, `plugin_init`, `plugin_init_omm` and `ingest_omm` fill it with no AP terms
selected), and it evaluates section 5's bodies once for its sets. A row that is an AP set exists only in a test build;
`row_propagate` withholds the batch's bodies from it and it reads its own (test/set-caches.e2e.mjs, a store of AP sets
and one mixing AP and SGP4XP sets, each bit for bit against the minutes call).

*The series.* A least-squares fit to DE440 (Park et al. 2021; NAIF de440s.bsp, SHA-256 c1c7feea...49f2) at TT from
1990 to 2060, every 0.61 days (42,514 samples), by tools/ap-bodies-fit.mjs; its coefficients are src/ap_bodies_series.inc
(319 arguments, 548 coefficient records). Fitted are the Moon's longitude (less its mean longitude F + Omega), latitude and
distance, and the Earth-Moon barycenter's Sun (longitude less F - D + Omega, latitude, distance), in the mean ecliptic and
equinox of date (IAU 2006 precession, the Fukushima-Williams angles of Capitaine, Wallace and Chapront 2003, with the
frame bias). Each is a quadratic in tau = T - 0.25 (T in Julian centuries of TT from J2000) plus the sine and cosine of
integer combinations of the Delaunay arguments D, l, l', F, Omega (IERS Conventions 2010, eq. 5.43; Simon et al. 1994),
the mean longitudes of Venus, the Earth, Mars, Jupiter and Saturn (eq. 5.44) and two planetary arguments of Meeus (1998,
ch. 47), A2 and A3. The candidates are the lunar problem's combinations to order 8, those with Omega to order 3, and the
planets against the Earth alone and with l, D, 2D, 2D - l, F and l'; candidates slower than a period of 50 years (the
quadratic carries them over the span) or not separable in rate from a lower-order one over the span are left out. A term
is kept above 0.15 arcsec (Moon longitude), 0.12 arcsec (latitude), 0.15 km (distance), 0.06 arcsec (Sun longitude and
latitude) and 25 km (Sun distance); a term above 25 times that also takes an amplitude linear in tau (over the span the
falling eccentricity of the Earth's orbit changes the Moon's terms in l' by up to 1 arcsec and the Sun's equation of the
center by some 12 arcsec). The fit's residuals are 0.73, 0.50 arcsec
and 0.65 km RMS for the Moon and 0.44, 0.08 arcsec and 126 km for the barycenter's Sun. The geocentric Sun is the
barycenter's plus mu_M / (mu_E + mu_M) times the Moon (DE440's masses; 4,671 km on average).

*Time and frame.* The series take TT, from UTC through ERFA's leap-second table (`frames::utc_to_tt`, as the GCRF
rotation of 16.4 takes it); section 5 took UTC, which put the Moon 38 arcsec behind along its path. TDB - TT (under 2 ms)
is left out. From the mean ecliptic of date the bodies go to TEME of date by the IAU 2006 mean obliquity, the fourteen
largest luni-solar terms of IAU 2000B's nutation (McCarthy and Luzum 2003; IERS Conventions 2010, Table 5.3a) and the
equation of the equinoxes: against the module's own GCRF-to-TEME (IAU 2006/2000A through ERFA, 16.4) 0.05 arcsec on
average and 0.085 at worst over 2010-2035. Section 5's Sun and Moon are in the mean equator and equinox of date, 5.5 arcsec
on average and 9.9 at worst from TEME.

*Against DE440.* 2010-2035, 32,745 instants 0.29 days apart, DE440 turned to TEME of date by the module's GCRF-to-TEME;
section 5 as AP read it through 0.6.21 (UTC for TT, the mean equator of date for TEME; measured on 0.6.16) and this
section through `bodies_at_ap` (measured on 0.6.22):

| | Section 5 | 16.17 |
| --- | ---: | ---: |
| Moon direction, mean / 95th percentile / worst (arcsec) | 91.5 / 195 / 377 | 0.74 / 1.57 / 4.14 |
| Moon distance, RMS / worst (km) | 19.2 / 72.6 | 0.68 / 3.08 |
| Sun direction, mean / worst (arcsec) | 10.9 / 32.0 | 0.44 / 1.08 |
| Sun distance, RMS / worst (km) | 4,420 / 11,900 | 128 / 401 |
| Moon's acceleration error at 42,164 km, RMS radial (m/s^2) | 3.7e-9 | 3.7e-11 |
| Moon's acceleration error at 74,600 km, RMS radial (m/s^2) | 7.0e-9 | 6.9e-11 |
| Sun's acceleration error at 42,164 km, RMS radial (m/s^2) | 2.4e-10 | 9.1e-12 |

The acceleration errors are on an equatorial ring of eight points in TEME, the third-body point-mass acceleration with
the module's bodies against DE440's. Section 5's Moon error split into the time argument (37.7 arcsec mean), the frame
(5.5) and its series (83.4); its Sun's into the time argument (2.8), the frame (5.6), the barycenter's offset (4.2) and
its series (9.9). Inside the fit's span but outside 2010-2035 the series measure 0.78 arcsec mean and 4.0 at worst for the
Moon in 1990-2009 and 0.81 and 3.4 in 2036-2060. Outside the span they extrapolate the quadratic and the linear
amplitudes. By decade over every year a satellite's epoch can fall in, against DE440 at the same instants 0.29 days apart
(before 1972 UTC to TT by ERFA's TAI - UTC, as `frames::utc_to_tt` takes it; measured on 0.6.22), direction in arcsec:

| Years | Moon, section 5: mean / 95th percentile / worst | Moon, 16.17 | Sun, section 5: mean | Sun, 16.17 |
| --- | ---: | ---: | ---: | ---: |
| 1957-1959 | 84.9 / 178 / 293 | 37.0 / 60.7 / 66.4 | 9.2 | 4.3 |
| 1960-1969 | 88.9 / 191 / 409 | 25.3 / 45.2 / 55.2 | 11.1 | 4.0 |
| 1970-1979 | 88.6 / 189 / 377 | 15.9 / 28.8 / 32.0 | 10.7 | 2.8 |
| 1980-1989 | 92.0 / 197 / 411 | 5.3 / 12.2 / 19.3 | 10.8 | 2.3 |
| 1990-1999 | 92.6 / 200 / 402 | 0.81 / 1.6 / 4.0 | 10.7 | 0.31 |
| 2050-2060 | 89.6 / 191 / 360 | 0.82 / 1.6 / 3.1 | 10.3 | 0.37 |
| 2061-2070 | 86.6 / 185 / 366 | 6.1 / 13.9 / 19.3 | 10.7 | 2.1 |
| 2071-2080 | 87.5 / 186 / 371 | 17.4 / 31.3 / 38.8 | 12.5 | 3.2 |
| 2081-2090 | 84.9 / 180 / 367 | 27.7 / 50.3 / 63.6 | 9.4 | 3.6 |
| 2091-2100 | 86.8 / 183 / 377 | 45.2 / 78.7 / 96 | 11.7 | 4.2 |

From 1957 to 2100 this section's Sun and Moon are the better in every decade, in mean, 95th percentile and worst alike.
Further out the Moon's mean error grows past section 5's: from 1930 to 2120 this section's mean is the smaller, in the
1920s the two are level (86.6 against 85.4 arcsec), and before 1920 (111 to 116 against 84 to 86) and after 2120 (93 to
126 against 86 to 87) section 5's is; this section's worst stays below section 5's in every decade from 1900 to 2149.
AP flies any epoch and does not switch between the two (a switch inside a flight would be a step).
`test/ap-bodies.e2e.mjs` checks the module against 407 stored DE440 samples of 2010-2035
(test/fixtures/de440-bodies-2010-2035.json, the same tool): the Moon within 8 arcsec and 6 km, RMS 2.5 arcsec and 1.5 km;
the Sun within 2 arcsec and 600 km; the cache against the series, and its smoothness at the nodes.

*Known approximations.* Every AP set's mean elements hold epoch axes (16.4), and every AP set carries the bodies in TEME
of date, not of the epoch. The two part by 0.42, 0.70 and 0.98 arcsec at 3, 5 and 7
days (1.19 at worst; 2010-2035): at 42,164 km a third-body acceleration error of 1.5e-11, 2.5e-11 and 3.5e-11 m/s^2 RMS
radial from the Moon (8.9e-11 at worst at day 7) and 1.6e-11 from the Sun at day 7; 6.5e-11 at 74,600 km from the Moon.
The long-period regime's class 0 sets carry the same residue (16.4).

*Effect on real windows* (72 h fits, the GEO lane's harness of the table's rows, real truth, FORCES.ECOM2 as the table
flies it; medians at days 1, 3, 5 and 7 and the windows within the numerical propagator's error plus 100 m at day 5; 0.6.21
to 0.6.22):
- Inclined geosynchronous (60 windows): 3.39, 12.61, 31.29, 56.37 m to 1.81, 3.59, 6.89, 10.77 m, 59 of 59 both; better at
  day 5 on 56 windows. The Y0 those fits solve was the Moon's error leaking into the radiation term (16.13).
- Geostationary (35 windows): 3.90, 11.54, 26.91, 53.89 m to 3.74, 9.78, 26.31, 53.57 m; 29 of 32 to 28 of 32 (one window,
  96.7 m before, leaves the line at 123.6 m); better at day 5 on 17 windows, worse on 15. Without FORCES.ECOM2 (the
  sphere alone, AGOM fitted) the same windows go from 14.51, 61.62, 149.30, 273.16 m to 15.46, 65.19, 153.71, 283.30 m:
  the old Moon's error, like section 4's shadow before 16.15 (stack #486), had been offsetting the satellites'
  non-spherical radiation, which a sphere does not carry (on 0.6.20 this section alone took the day-3 median from 53.30
  to 57.92 m, adding to 0.6.21's 53.30 to 61.62 m).
- On sphere truth (the numerical propagator fitted to the real arc, flown with the sphere alone), day 7 with Y0 solved:
  three inclined windows 61.8 to 83.4 m down to 3.7 to 16.2 m, the false Y0 from -0.8e-10 to -1.4e-10 m/s^2 down to +6e-13
  to +3.1e-11; two geostationary windows level (day 5 2.2 to 2.6 m, day 7 5.8 to 6.1 m). On a made-up inclined
  geosynchronous set in season (epoch 2026-01-26, AGOM 0.015, a sphere in the truth and no Y0): Y0 +1.01e-9 to +2.3e-11
  m/s^2, day 5 21.9 to 2.1 m (with Y0 held 11.0 to 2.1 m).
- TESS (seven real windows of `test/heo-frame.e2e.mjs`): worse, medians 610.7, 1,390.4, 6,553.6 m to 762.8, 1,677.5,
  8,596.8 m at days 1, 3 and 7 (four windows worse, two better, one level). The Moon is what moves it, and on model truth
  the third body is right there (below). AP's error on that orbit against a numerical propagator, 0.9 to 1.8 km at day
  7, is the frame's (16.4, stack #479).
- Day-3 medians of `test/etalon-resonance.e2e.mjs` (fits that state no FORCES.ECOM2): Etalon-1 4.25 to 3.54 m, Etalon-2
  5.31 to 4.84, LAGEOS-1 7.17 to 7.11, LAGEOS-2 6.92 to 6.80, LARES-2 8.71 to 8.66, inclined geosynchronous 13.45 to 7.60
  m, and geostationary 61.62 to 65.19 m (above).

*Effect on model truth* (72 h fits, day-7 whole-day 3D RMS; 0.6.16 to this section, on main without the one-day class's
resonant tail unless stated):
- Gravity 4 x 4 on both sides: inclined geosynchronous orbits (i 55 deg, e 0.003, six nodes) 5.35-25.85 m to 0.94-2.03 m;
  geostationary (i 1.5 deg, four longitudes) 8.47-10.34 m to 1.53-3.21 m, the cross-track part 7.3-7.9 m to 0.7-1.1 m,
  and the constant along-track acceleration fitted to the forecast from up to 4.6e-11 to 3e-12 m/s^2
  (`test/one-day-moon-floor.e2e.mjs`: at most 5 m; with ECOM2 the Y0 found within 3.8e-11 m/s^2).
- The third body by radius, seeded (no fit; gravity 4 x 4 on both sides, coefficients held), day 7, this section against
  the same flight with the Sun and Moon off on both sides: a THEMIS-like orbit 284, 273, 278 m against 258, 231, 249 m; a
  Chandra-like one (period 63.5 h, e 0.685) 292, 413, 510 m against 289, 426, 510 m; a TESS-like one (13.7 days, e 0.55)
  1,746, 829, 1,818 m against 1,769, 884, 1,805 m. With section 5's Moon: 292, 292, 200 m; 468, 699, 478 m; 2,423,
  2,052, 2,870 m.
- Every HEO fixture of 16.6 moves, both ways (day 7, 0.6.19 to this): half-day sample 30.22 to 27.76 m (along-track RMS
  31.45 to 36.15 m), 12 h at 55 deg sample 64.94 to 76.44 m, GTO 192.87 / 123.44 to 180.70 / 117.62 m along-track /
  radial, the 500 km perigee GTO 94.07 / 56.07 to 82.34 / 51.79 m, Molniya with its drag coefficient pinned at the truth
  80.71 / 50.51 to 84.01 / 51.16 m; Molniya with it fitted lands on the other of its fit's two solutions (stack #392:
  0.04462 to 0.04576 against the truth's 0.044, day 7 332.6 to 763.9 m), inside its record's statement.
- A GPS-like orbit (20 x 20, four nodes): 8.1, 5.4, 13.7, 13.1 m to 13.4, 9.9, 10.0, 8.7 m. The averaged regime's own
  lunar theory carries that orbit's floor (DigitalArsenal/spacedatanetwork-stack#421), not the ephemeris: DE440's Moon in
  a test build moved it the same way.
- Four low orbits (400 to 1,400 km, 20 x 20, no drag): by 0.00 to -0.14 m.
- A THEMIS-like orbit (period 22.9 h, perigee 900 km, e 0.82; three nodes), day 5: 104, 88, 131 m to 98, 86, 106 m with
  4 x 4 on both sides; 126, 148, 167 m to 109, 132, 137 m against 70 x 70 with AP at (31, 20).
- With the full field on both sides the one-day class's missing resonant gravity (#434) had been partly cancelling the
  Moon's error: an inclined geosynchronous node at 20 x 20 goes from 11.8 to 35.6 m (along-track; cross-track 4.4 to
  0.4 m) and, on real 72 h windows flown against the numerical propagator fitted to them, two of three inclined windows
  get worse after day 3 (6.7 to 17.2 m and 3.6 to 21.1 m at day 7; the third 7.8 to 6.6 m).
- With the tail and this section together the cancellation is gone. At 20 x 20 on both sides, day 7: geostationary
  8.5-10.3 m with the tail alone to 1.6-3.2 m (cross-track 7.3-7.9 to 0.7-1.1 m), inclined geosynchronous 5.4-25.9 m to
  1.0-2.0 m, the same as at 4 x 4 within 0.05 m. On five real windows (tail alone to both), the three inclined ones from
  14.0-20.0 m to 2.3-3.4 m at day 7, and the two geostationary ones from 13.4 to 8.5 m at day 5 and 34.2 to 20.6 m at
  day 7 (0.6.16: 58.5 and 95.1 m). What is left on the second (about 18 of its 20.6 m at day 7) is the radiation
  pressure: with it off on both sides the same window is 1.7 m, so it is AP's sphere against the numerical propagator's
  in eclipse season, not the Sun or Moon (measured before 0.6.21's shadow, 16.15).

*Cost.* One evaluation of the series costs about 4.2 µs against SPEC 5's 0.28 (rough, under load); with nodes 8 h apart
a flight evaluates eight times fewer of them than SPEC 5's hourly cache did, and a fresh record whose times another
flight already read evaluates none. Under load (115 to 120 on 28 cores, niced, 0.6.16 against this section alternated
two to five times, `test/kernel-cost.mjs`), AP's cost per state over SGP4's at 300 s moved within the runs' spread
(medium Earth orbit 1.28 to 1.49 against 1.11 to 1.34, geostationary 2.23 to 2.55 against 2.12 to 2.43, 500 km 2.60 to
4.22 against 2.25 to 3.82); the first state of a fresh record a week from its epoch fell (geostationary 1,439 to 1,471 µs
against 1,273 to 1,278, medium Earth orbit 200 to 237 against 178 to 188, apart from single spikes in both builds); and
10,000 fresh records asked at one instant a day after their epoch cost 125.5 against 132.7 µs a record (medium Earth
orbit), 209.1 against 237.1 (geostationary) and 126.1 against 131.0 (500 km). A process's first evaluations (about 40 µs
for a day's nodes, 110 µs for a week's) are paid once per thread and time range.

**16.18 Where each tesseral term is carried.** A tesseral term (l, m, p, q) of the embedded field (EGM2008 to degree and
order 70) has w = l - 2p, j = w + q and the angle rate psi-dot = w omega-dot + j M-dot + m (Omega-dot - omega_E), from the
J2 secular rates at the set's epoch elements (the rates 16.2's table and 16.11's grid take). The rule: each term is carried
in exactly one place, decided by its own psi-dot at the set's epoch, for every commensurability:
- in the rates, integrated at the current elements with all six element rates, the mean motion's response included;
- at output, to first order: 16.2's table below the eccentricity switch, 16.11's grid above it;
- nowhere, stated term by term with its reason (the diagnostic below).

A term is slow when |psi-dot| < 0.045 n (`kShallowBand`). For each (l, m, p) the slow j are the integers within
0.045 n / M-dot of nu = -(w omega-dot + m (Omega-dot - omega_E)) / M-dot, and q = j - w. So j and q follow from the rate, and
each term is classified by its own rate, not by its family's q = 0 rate.

*Where a slow term belongs.* At output, a term's mean-motion response is an along-track term in 1 / psi-dot^2 with a fixed
divisor. 16.2's table takes the divisor at the epoch elements; 16.11's grid takes it at the mean elements of each 48 h node
(at the epoch's mean motion in the long-period regime with the Sun and Moon, from 0.6.30).
That is exact to first order while psi-dot holds still and stays well above the libration rate of the term's own resonance.
Where the rate holds still the two forms agree. At 550 km beside 15:1 (i 87.35, gravity alone, the elements fitted and the
coefficients pinned), the order-15 terms with j = 1 give at day 5, after 24 h and 72 h fits:
- 800 and 1,340 m in the rates;
- 804 and 1,347 m on the table (stack #477).

A term whose rate does not hold still belongs in the rates:
- in low orbit, where drag moves n, and moves a k:j family's rate by j times as much, through the band and through zero.
  There the acceptance is a decaying orbit that crosses a band edge with no kink in its output (stack #477);
- above the switch, every slow term (from 0.6.28; stack #473, #474, below). There the Sun and Moon move omega and Omega on a
  high orbit as fast as J2 does, while the grid takes a term's divisor from J2's secular rates. A term under the one-day
  class's floor drifts about as slowly as the class's own libration.

*The diagnostic.* `sdnap_slow_terms(in, rows, max_rows)` takes in = the mean motion (rev/day), e, i (deg) and the tesseral
cap (2 to 70). It writes one row of eight doubles per slow term of degree 2 to the cap:
- l, m, p, q and psi-dot / n;
- the term's carrier (the table below);
- the rates' weight w, in [0, 1]. Inside a taper the output holds 1 - w of the term. Above the switch w is 1 for the class's
  terms and, from 0.6.28, the band taper of its own rate for every other term in the rates (the grid holds 1 - w);
- the term's size in m. That is its along-track amplitude through the mean motion, 3 |j| A / (a psi-dot^2), with
  A = mu / a^(l+1) |F G| |C, S| at the epoch elements and G exact at the epoch e. A size cut is chosen on this number.

| Code | Carrier |
| ---: | --- |
| 1 | the rates: the class's terms (6.1), the half-day class's tail (16.2), the shallow set (16.2), and from 0.6.28 above the switch every other slow term at or above the size cut (below) |
| 2 | the grid (16.11) |
| 3 | the output table (16.2) |
| 0 | nowhere: under the low table's floor (through 0.6.27, above the switch: under the one-day floor, or left out of the grid as slow) |
| 4 | nowhere: above the carrier's degree |
| 5 | nowhere: under the size cut |
| 6 | nowhere: a q outside the rule's q range, at or above the size cut |

It writes at most max_rows rows and returns the count of all of them, or -1 for a set it does not cover. It covers the sets
above their eccentricity switch outside low orbit (class 0 below 1100 min), and from 0.6.25 the low table (below: codes 3,
5 and 6 are written there only). It returns -1 for every other set. No flight reads it.

*The partition test.* Each part of the rule has an E2E of one shape:
- the rule, written in the test as a function of a row (the carrier from l, m, p, q and psi-dot / n);
- `sdnap_slow_terms` compared with it row by row on sets inside the part's bands;
- one model-truth flight of a set inside a band.

`test/one-day-slow-band.e2e.mjs` is the one-day class's test.

*The one-day class above the switch (from 0.6.24; stack #467).* Before 0.6.24 the grid left out every term slower than
0.045 n, as if the class carried it in the rates. The one-day class carries only SGP4-XP's 27 terms (degrees 2 to 4, k = m,
|q| at most 4), so its other slow terms were carried nowhere:
- j = m of degrees 5 to 12;
- the terms of degrees 3 and 4 with |q| above 4, large at high e.

A set whose resonant angle drifts just under 0.045 n lost them: about 950 m at day 5 on THEMIS A's real geometry, whose
angle drifts at 0.0444 n. A set just above the cut kept them. From 0.6.24 to 0.6.27 each term of a one-day set above the
switch was carried in exactly one place (from 0.6.28 the rule for every class below replaces it):
- the class's rates: its 27 terms;
- the grid: every other term of degree 2 to 12, m-daily aside, whose angle drifts at 1e-2 n or faster;
- nowhere: a term slower than 1e-2 n (the floor below), and the terms above degree 12 (the table holds no near-resonant
  terms outside low orbit).

On a THEMIS A-like set the diagnostic lists 5 terms in the rates, 47 on the grid of degree 2 to 12, and 768 of degree 13 to
31 carried nowhere. On THEMIS A's real geometry (no Sun or Moon, the field cut on both sides) degrees 13 to 31 are 1 to 17 m
of either sign at day 5: 12 x 12 against 31 x 31 gives 50.2 against 48.9 m, 52.1 against 65.7 m and 78.7 against 62.1 m.

FFM model truth, EGM96 70 x 70, no Sun or Moon on either side, a 72 h fit flown 7 days, day 5:
- Made-up THEMIS A-like sets whose fitted mean motion lies in the band (1.0493 rev/day, e 0.825, i 11.9 deg; node 0, 90
  and 180 deg): 369 / 415 / 549 m through 0.6.18, and 155.1 / 69.5 / 160.5 m with the band.
- Five real THEMIS geometries, from their windows' own states with the Sun, the Moon and the radiation sphere: day 5 went
  from 162 to 994 m (median 538 m) to 77 to 129 m (median 100 m).

At the switch, a one-day set at e0 0.30 takes #434's tail in the rates and the table; one at 0.3001 takes the grid with
the band. i 10 deg, 70 x 70 with the Sun and Moon, a 72 h fit, day 5:
- At n 1.0496: 35.5 m at e0 0.30 against 13.7 m at 0.3001.
- At n 1.0027: 19.9 m against 12.0 m.
- Through 0.6.18 the same pairs were 38.7 against 14.8 m and 18.1 against 11.9 m.

The jump is the table's first-order error near 0.3 (16.11). The band adds 1 m at 0.3001 and the tail 3 m at 0.30.

The floor is 1e-2 n, not the table's 1e-3 n. Between the two, a term drifts about as slowly as the class's own resonant
libration, where a first-order term is no longer small. Two synchronous sets at e 0.5 (1.0027 rev/day, i 30 deg, nodes 30
and 120 deg; 70 x 70, no Sun or Moon, day 5) hold 98 terms of degree 2 to 12 between the two floors:
- with the floor at 1e-3 n they went from 105 to 58 m and from 42 to 54 m;
- at 3e-3 n and 1e-2 n both keep their 0.6.18 values.

On the THEMIS-like sets and on the one-day set at e 0.3001 no term of degree 2 to 12 lies between the two floors. What the
floor and the degree cut leave out on such a synchronous set (105 m and 42 m, against 2.7 m and 2.1 m with a 4 x 4 field) is
stack #474.

*Every class above its switch (from 0.6.28; stack #473, with #474's floor).*
- **The rule.** Every set above its eccentricity switch outside low orbit carries in its rates each slow term of degree 2 to
  the grid's degree (12) that its class's terms do not, at or above the size cut of 0.5 m. In the code that is
  `slow_terms_wide` and `wide_slow_six`.
  - The rates are Lagrange's equations at the current elements, with F G at the epoch's e and i moved linearly.
  - Each (j, m, w) is weighted by the band taper of its own rate. The grid holds the rest of each harmonic.
  - The diagnostic writes code 1 with that weight, 5 under the size cut, and 4 above degree 12.
  - "Outside low orbit" excludes class 0 with a period under 1,100 minutes: above its switch (0.05) that branch carries
    neither the slow set (the low table's, at or below the switch) nor this wide set, only the shallow set's j = 1 terms in the
    rates. Its other slow terms are in the grid; the census lists the branch as stack #473's hole (16.20).
- **Before 0.6.28.** The grid left each family's whole slow band out in every class but the one-day class, and nothing else
  carried it. The one-day class kept the band on the grid down to the floor, and that floor and the terms under it are gone.
- **Why the rates and not the grid.** The rates follow a term's angle with the flight's own elements. A term kept on the grid
  takes its divisor from J2's secular rates, and on a high orbit the Sun and Moon move omega and Omega as fast as J2 does.
  Keeping the band on the grid down to 1e-2 n took e 0.9 at 0.50 rev/day from 2.7 to 1.6 km with the field alone, but from
  1.7 to 25 km with the Sun and Moon.
- **Double precision.** At high degree and eccentricity the terms' F G and F dG/de leave a float's range, so the table is in
  double.
- **Degree 12.** The list stops at the grid's degree. Above degree 12 nothing carries a family's fast harmonics, and its slow
  harmonics alone put the transfer orbit below at 165 m (to degree 31) and 186 m (to degree 70), against 134 m.

**What the rule changes.** The numerical propagator (FFM 2.3.0, DE440s) is flown from each case's state, and AP is fitted to
its own 0 to 120 h. D is the largest distance over that span, in m. Constant weather; the truth's drag and radiation terms
are held at the truth's values.

| Case (stack #498's elements) | 12 x 12 alone | 70 x 70 alone | everything | everything, 0.6.28 |
| --- | ---: | ---: | ---: | ---: |
| e 0.9, perigee 300 km, 0.50 rev/day | 2,710 to 189 | 2,770 to 176 | 1,690 | 1,490 |
| e 0.9, perigee 1,400 km, 0.40 rev/day | 4,290 to 136 | 4,280 to 139 | 4,226 | 5,167 |
| one-day, exactly synchronous (1.0027 rev/day, e 0.82) | 1,020 to 49 | 1,000 to 109 | 990.5 | 106.6 |
| transfer orbit (250 km, e 0.73) | 29 to 22 | 98.8 to 95.0 | 134.1 | 128.6 |
| e 0.7, perigee 650 km (eight-hour class) | 46.3 to 46.4 | 144.5 | 155.5 | 155.6 |
| Molniya | | | 34.3 | 34.3 |

On the e 0.9 case at 1,400 km the rule takes the field alone from 4.3 km to 139 m. With the Sun and Moon it is 0.9 km worse:
that piece is the grid of the fast families under the Sun and Moon (stack #479).

`test/slow-band-every-class.e2e.mjs` checks one set of each class with `sdnap_slow_terms`, and flies one model truth at e 0.9
(0.40 rev/day, fitted to its own 5 days): 242.7 m against 2,691.4 m before.

*The other parts.* Every other set carries its slow terms as 16.2 and 16.11 state. These are carried nowhere:
- in low orbit (class 0 below 1100 min), through 0.6.24: the commensurabilities with j of 2 to 4 (orders 25 and up) and the
  degrees above 31. Inside the bands they put a set 0.1 to 1.9 km off at day 5 (stack #477). From 0.6.25 the low table's
  slow set carries those with q = 0 (below); the terms with q other than 0 stay open;
- above the switch in classes 0, 2, 3 and 4: every slow term the class's rates do not carry. A transfer orbit (2.2785
  rev/day, e 0.7306, i 27 deg) is 2.1 km from the numerical propagator at day 5 without radiation pressure (stack #473);
- in the one-day class: the terms under its floor and above degree 12 (stack #474).

*The low table (from 0.6.25; stack #477).* The low table is class 0 below
1,100 min at or below its eccentricity switch. There, through 0.6.20, the shallow set (16.2) carried only j = 1, q = 0 to the
stated degree, at most 31. The output table dropped every term slower than 1e-3 n and took the rest with the divisor of the
epoch. A k:j family at a band's center, or one that drag moves through its band, was carried in the wrong place or nowhere.
Gravity alone, FFM 70 x 70 on both sides with no Sun or Moon, the elements fitted with the coefficients pinned, 300 to
1,500 km in 20 km steps: the worst day-5 error after a 24 h or 72 h fit was 1,584 m at i 53 (25 heights above 100 m) and
1,905 m at i 97.6 (35 heights).

From 0.6.25 a fit that states MAXIMUM_TESSERAL_DEGREE 2 or more carries the slow set in the rates, beside the shallow set:
every term (l, m, p, q) of the embedded field with j = l - 2p + q from 1 to 6, |q| up to 4 (from 0.6.27; 0.6.25 carried
q = 0), order and degree 2 to 70,
- whose own rate psi-dot at the epoch elements is within 1.3 bands (|psi-dot| < 1.3 x 0.045 n, `kShallowSelect`);
- whose size reaches 0.5 m (`kSlowKeepM`). The size is the larger of two, at the epoch elements: the along-track amplitude
  through the mean motion, 3 |j| A / (a psi-dot^2), with A = mu / a^(l+1) |F G| |C, S| the potential's coefficient of the
  term; and from 0.6.27 the once-per-revolution amplitude through the eccentricity vector, 2 A_e / (n a |psi-dot|), with A_e
  the same coefficient with F dG/de in place of F G. A term of q = +-1 has G = e (l + 1 + 2 q w) / 2 at small e (w = l - 2p),
  so near e 0 its first size vanishes while its second does not;
- other than the shallow set's own terms (j = 1, q = 0, to its degree), which stay where they are.

Each term enters the rates with the weight w of its own current rate: 1 below 0.9 bands, a cos^2 taper to 0 at 1.1. The
output table holds a share of the term set once, at the epoch elements: 1 - w at the epoch's rate, and with 16.1's band guard
(the low table above degree 12, a set with drag) 1 - the larger of w at n0 and at n_end, and none where the rate changes sign
between them. The rates' share follows the current rate continuously and the table's stays as set, so a term crossing its
band's edge as drag moves n makes no step in either. At the epoch the two hold the whole term (with the guard, no more than
it). Once n has moved, without the guard they hold more than the whole term where w has risen and less where it has fallen;
with the guard they hold no more than it for n between n0 and n_end, and the rest is carried nowhere. With the record's degree d above 12 the table holds that share to the slow set's degree, for q of
-1, 0 and 1 (16.1); with d of 12 or less it holds it to d. A slow term of |q| 2 or more has its 1 - w carried nowhere. The slow set takes degree 70 whatever MAXIMUM_TESSERAL_DEGREE states (16.1): a record at tesseral 31 does not mean that nothing above degree 31 flies. A model truth cut below 70 is compared with AP like with like only with `sdnap_slow_degree_cap` set to its degree (a test hook; no flight reads it). Against a 31 x 31 truth, without the hook, the slow terms of degree 32 to 70 that the truth leaves out read as a j = 2 error: near 28:2 an amplitude 46 to 64 % too large with its phase 14 to 22 degrees off. Against a 70 x 70 truth with the same order caps on both sides it is 3 to 4 % and under 4 degrees (stack #541). The record states it
as GRAVITY_MODEL "EGM2008; slow tesseral terms to degree 70", and every flight of the record carries it; an AP record
with gravity terms that states "EGM2008" flies without it. Through 0.6.34 the text was "EGM-96; slow tesseral terms to
degree 70"; from 0.6.36 such a record is refused (gravity-model-mismatch, 16.2).

What the slow set leaves out, by stated limits:
- Families whose leading degree is 69 or 70. The embedded field ends their series after one or two degrees where the real
  field continues it, so neither AP nor a numerical propagator at 70 x 70 holds the series: a limit of the field, not of the
  method. j up to 4, 5 or 6 gave the same records on the measured fixtures and band centers.
- Terms under 0.5 m. The largest left out on the bits cases are 0.41 m on a LAGEOS-2-like set and 0.089 m on a LAGEOS-like
  set. A cut at 0.1 m changes the LAGEOS-2-like record, and 0.05 m changes both. Lower cuts also make a free fit of a
  SWOT-like set at BTERM 0.01 worse: 0.925 and 0.937 of the true BTERM against 0.952.
*q other than 0 (from 0.6.27; stack #477's second part).* 0.6.25 carried q = 0 only, and listed the slow terms of q other than
0 at or above the size cut as code 6. Among them:
- at 550 km (i 87.35, e 0.001), the order-15 q = 2 term of degree 15, drifting at 3.2e-5 n with a size of 1.9 km;
- at 880 km (i 97.6), the order-14 q = -1 family at 7.0e-4 n (its largest member 757 m) and the q = +1 family at 1.8e-3 n;
- at e 0.02, the series in q, which needs |q| up to 4.
From 0.6.27 the slow set takes every q with |q| up to 4 by the same rule (its own rate, the 0.5 m cut), G exact at the epoch
e. Below e 2e-4 the exact G's dG/de comes from a tabulated Hansen series, and is 0 where none is tabulated (degrees above
5); for q other than 0 there the slow set takes dG/de as the central difference of the exact G over e +- 2e-4 (G is analytic
in e). Without it a near-circular record (a fit of a circular orbit gives e of 1e-6 to 2e-5) has no q = +-1 forcing of its
eccentricity vector: with gravity, Sun, Moon and tide on both sides, 70 x 70, the largest distance over 0 to 5 days after a
72 h fit at 500 km, i 55 is 356 m
without it and 161 m with it, and at 300 km, i 98 676 and 451 m. On 0.6.25, put in the rates with pinned fits, the q = -1 family had cost 20 to 35 m at 880 km. With AP fitted to the
numerical propagator's own forecast (the record the catalog's fit makes, stack #504), gravity, Sun, Moon and tide on both sides and
the field at 70 x 70, the largest distance over 0 to 5 days, q = 0 / |q| up to 1 / up to 4:
- 880 km, i 97.6, e 0.001: 85 / 42 / 42 m;
- 550 km, i 87.35, e 0.001: 159 / 67 / 67 m;
- 550 km, i 87.35, e 0.02: 448 / 72 / 64 m;
- 1,000 km mean altitude, i 53, e 0.04: 101 / 98 / 93 m.

On the synthetic set of stack #498 (the numerical propagator the truth, AP fitted to its forecast over 0 to 5 days, the largest
distance over those 5 days), the low-orbit band's 205 cases (near-circular 650 to 2,000 km, e 0.05 to 0.1) went from 150 to
149 within 100 m, with a median of 64.1 to 61.5 m and a worst of 3,998 to 2,966 m (0.6.26 to 0.6.27). The case lost,
e 0.05 at 500 km, i 70, was refused at the 0.05 switch through 0.6.36, its best set lying across the switch from either
side; with the fit at a switch it is held there on its own branch (16.7), at 241.9 m, so the count stands. The largest
gains are at a 200 km perigee, e 0.05: 3,998 to 284 m at i 70, 914 to 257 m at i 55.
The largest list on a sweep of 1,880 low-table sets (12 to 16.6 rev/day, eight inclinations, e 0 to 0.05) is 971 terms, under
the list's 2,048 (`kShallowMax`); a term over it would be listed as code 7, and the partition test asserts there is none.

Measured with the slow set:
- The scan above: at i 53 the worst is 218 m (10 heights above 100 m), and at i 97.6 it is 423 m (19 heights). Still above
  100 m at i 97.6, day 5 after a 24 h / 72 h fit: 380 km 423 m, 300 km 296 m, 520 km 239 m, 440 km 235 m, 880 km
  220 / 233 m and 1,220 km 118 / 103 m. At i 53 the heights from 300 to 520 km (up to 218 m) are the fast terms of degrees 13
  to 31 (stack #454).
- Free 72 h fits on model truth with drag, the Sun, the Moon and the tide (70 x 70): a SWOT-like set states 0.995 of the true
  BTERM at 0.044 and 0.952 at 0.01 (day 5 30 m); a Sentinel-3-like set 0.999 and 0.993.
- Real data, 72 h fits, AP's day-5 forecast against the full numerical arm's own forecast (windows under 100 m and the
  median), from 0.6.20 to the slow set: laser spheres 21 to 34 of 56 (116 to 75 m), altimetry 28 to 42 of 112 (191 to
  121 m), near 700 km 10 to 11 of 69 (235 to 216 m). The 24 h rows do not move.
- The records of LAGEOS-, Etalon- and Galileo-like sets are identical to 0.6.20.

What gets worse, measured. No IDS burn lies near either Sentinel-3 window.
- Sentinel-3B 2025-10-25: day 7 goes from 112 to 402 m. Its 72 h fitted term goes from 0.87 to 0.83 of the full numerical
  arm's, and the numerical propagator's own day 7 on that window is 1,179 m.
- Sentinel-3A: the median paired day 3 on its read windows goes from 44.2 to 73.4 m. Its term on 2025-10-15 goes from 0.90
  to 0.87 of the numerical arm's.
- The ISS sample, a 6 h fit at 420 km: the error at 12 h goes from 308.5 to 316.6 m against the sample's own truth. The
  calibration cells of SPEC 12.5 move by at most 0.0011 in median |z|. This is one sample.
- LARETS: two windows leave the 100 m line. 2025-10-15 (a 24 h fit) goes from 73 to 288 m at day 5, and 2025-12-14 (72 h)
  from 74 to 188 m.

*Cost.* The list is built once per set, when the set is loaded, so the cold first state of a low-orbit set costs more:
- at 1 day, 1.25 to 1.40 times 0.6.20 on six of `test/kernel-cost.mjs`'s ten low-orbit regimes and about 2.2 at 400 km;
- at 7 days, 1.03 to 1.28 times.
The cost per state is unchanged within the noise (0.90 to 1.07). These were measured under load; stack #492 is the shared
list that takes the load cost off a catalog.

*The diagnostic, low table.* `sdnap_slow_terms(in, rows, max_rows)` covers the low table with rows of eight doubles: l, m, p,
q, psi-dot / n, the carrier, the rates' weight w at these elements, and the term's size in m. It lists every term of j = 1 to
6 and |q| up to 4 within 1.3 bands:

| Code | Carrier |
| ---: | --- |
| 1 | the rates (the shallow set or the slow set), with its weight w |
| 3 | the output table |
| 0 | nowhere: under the table's 1e-3 n floor |
| 4 | nowhere: above the slow set's degree, or in a family whose leading degree is 69 or 70 |
| 5 | nowhere: under the size cut |
| 6 | nowhere: a q outside the slow set's range, at or above the size cut (none from 0.6.27: the range is the listing's) |
| 7 | nowhere: a term the rules select that the list's capacity (`kShallowMax`, 2,048) could not hold |

`test/slow-set-partition.e2e.mjs` compares it row by row with the rule written in the test. `test/slow-set-taper.e2e.mjs`
flies a decaying orbit whose order-15 family's weight moves from 0.90 to 0.63 over 7 days. The 10 s jump detector reads at
most 0.008 m (bound 0.08 m), and 400 states come out bit-identical in any order of requests.

**16.19 The Sun and Moon of the long-period regime through the output.** In the long-period regime the bodies enter the
rates as point masses: the Gauss equations at the mean state, with the bodies' acceleration at the mean position (5). AP's
output then adds section 8's J2 short-period map to those mean elements. So the bodies' rates moved AP's osculating state
by the map's Jacobian times the rates as well, a velocity of the order of J2 times the bodies' own effect on the elements, at
once. On a synthetic set at e 0.9 with apogee 305,000 km (perigee 10,000 km, i 70), AP with J2 and the Moon diverged from
AP with J2 alone at 2.8 mm/s from the first minute, where the numerical propagator's two flights start together: after 1 min,
0.242 m against 0.073 m. From 0.6.29, an AP set above e 0.3 in the long-period regime takes as the bodies' rates of its
mean elements y the solution m of J m = (0, a): J is the Jacobian of section 8's output (position and velocity, km and km/s)
in the six elements by forward differences (steps 1e-7, and 1e-7 n for n, every column's Kepler equation started from the
base's eccentric anomaly), and a is the Sun's and Moon's point-mass acceleration at the output's position. Gaussian
elimination with partial pivoting solves it; where the output or the solve fails, the Gauss equations remain. The rates
then move the J2 output by the bodies' acceleration and nothing else, to first order. Radiation pressure takes the same
path there from 0.6.41 (16.22).

AP's Moon signal (each side's flight with J2 and the Moon less its flight with J2 alone, no fit, 120 h; J3 to J5 and the
Sun's mass zero in the builds), against the numerical propagator's:

| synthetic set | the Moon's signal at 120 h | error before | error from 0.6.29 |
| --- | ---: | ---: | ---: |
| e 0.9, perigee 5,000 km, i 70 | 1,811 km | 627 m | 28 m |
| e 0.9, perigee 10,000 km, i 70 | 3,202 km | 622 m | 43 m |
| e 0.5, perigee 35,786 km, i 20 | 868 km | 34 m | 27 m |
| TESS-like (e 0.55, perigee 102,000 km) | 2,133 km | 9 m | 8 m |
| e 0.3, perigee 35,786 km, i 55 | 90 km | 34 m | 36 m |
| geosynchronous, e 0 | 9 km | 3 m | 2 m |

The effect is large only where the J2 map is large against the bodies' pull, a low perigee under a high apogee. At e 0.3 and
below it is a few meters while the Jacobian costs about 3 us a state on a geosynchronous flight, so below e 0.3 the Gauss
equations stay, bit for bit. AP fitted to the numerical forecast over 0 to 120 h, J2 and the Moon on both sides: 862 m to
453 m (perigee 5,000 km) and 825 m to 353 m (perigee 10,000 km), against 459 m and 360 m with J2 alone. SGP4XP is unchanged.
`test/long-period-moon-output.e2e.mjs` records AP fitted over 5 days to that case on the zonal field to degree 5 with the Sun
and Moon (FFM): D 343.8 m on 0.6.26, 255.8 m from 0.6.29.

**16.20 The field's census** (from 0.6.32; stack #503). The rule: every tesseral term of the field whose effect on position reaches the
size cut is carried exactly once, by the carrier its rate gives it, in every class, on both sides of every switch.
`sdnap_field_census(in, rows, max_rows)` lists, for a set of epoch mean elements (in: mean motion in rev/day, e, i in degrees,
the record's tesseral degree, the size cut in m), every term (l, m, p, q) of the embedded field, order 1 to 70 and degree to
70, with |q| up to 4 (8 up to e 0.3, 12 above), whose size reaches the cut.

The census builds the set as a flight builds it (`ap_init`, the slow set on), with BTERM 0. The band guard of 16.1 acts
only on a set with drag, so the census's counts are those of a set without it. On a set with drag the guard takes from the
output table the share of a term whose rate moves toward the band over the guard's span, and at the epoch that share is
carried nowhere (measured 2026-11-12, the table built with the guard and without it): at perigee 300 km, e 0.001, i 51.6,
BTERM 0.0064, 17 terms, 19.2 m summed, the largest 4.3 m (l 42, m 32, j 2); at 420 km, i 51.6, BTERM 0.01, 8 terms, 0.03
m summed; on the guard test's set (perigee 200 km, BTERM 0.022) the 16 terms whose rate passes zero, 6.8 m summed, the
largest 1.5 m. It then reads each carrier's own tables:
- the rates: the shallow and slow list, with each term's band taper at the epoch; the class's terms; the half-day and one-day
  tails;
- the output table: each entry's weight, its coefficient over the term's F;
- the m-daily family, to its degree;
- the family grid: the share it keeps, 1 minus `wide_left_out`, the rule the grid is built on.

*The size* is the output table's measure at full weight (16.1), with the eccentricity vector's part counted along track, twice
its radial part:

a A [|F G| (3 |j| / (a^2 psi-dot^2) + 2 (l + 1) / (n a^2 |psi-dot|)) + (2 |F dG/de| + |dF/di G|) / (n a^2 |psi-dot|)],

with A = mu / a^(l+1) |C, S|. |psi-dot| is taken at least 2 / (5 days), since a slower term grows over the forecast and not
past it. Through the mean motion it is the slow set's measure.

Rows have ten doubles: l, m, p, q, psi-dot / n, the code, the rates' weight, all carriers' weight, the size, and the term's period in days (2 pi / |psi-dot|), so a carrier can be checked against the period directly.

Beside the field the census lists one family, radiation pressure (from 0.6.41): one row with l -1, m 0, p 0, q 0 and no
rate, its code read from the same predicates the flight's gates read (4 through the output map, 13 by SPEC 4's two
carriers, 30 if both, 24 if one of SPEC 4's alone). Its size is a Cr A/m of 0.01 m^2/kg at 1 AU over the five days, a t^2 / 2:
4,199 m.

| Code | Carried |
| ---: | --- |
| 1 | once, by the rates |
| 2 | once, by the grid |
| 3 | once, by the output table |
| 4 | once, through the output map (radiation pressure in the long-period regime above e 0.3, 16.22) |
| 8 | once, by the m-daily family |
| 11 | once, by the rates and the output table between them (the band taper) |
| 12 | once, by the rates and the grid between them (the band taper, above the switch) |
| 13 | once, by SPEC 4's averaged rates and its periodic output terms between them (radiation pressure elsewhere) |
| 20 | nowhere: above the degree of the carrier that the term's rate gives it |
| 21 | nowhere: under that carrier's rate floor, or in the slow band that the grid leaves out |
| 22 | nowhere: outside that carrier's q (or j) range |
| 23 | nowhere: under that carrier's own size cut |
| 24 | partly nowhere: the weights sum to less than 1, and the share left out reaches the cut (a share under it counts as carried) |
| 30 | twice: the weights sum to more than 1 |

In the low table the carrier is the rates below 1.1 bands and the output table above.

The census weighs every share at the epoch's elements, so it checks the partition at the epoch only. A shared term's weights
need not sum to 1 later in a flight. The rates' shares (the shallow, slow and wide slow lists) follow the term's current rate.
The output table's and the grid's are fixed when they are built: the table's at the epoch, the grid's at its node (in the
long-period regime with the Sun and Moon, at the epoch's mean motion, 16.19).

`test/field-census.e2e.mjs` sweeps the regime: 101 sets.
- Low orbit: five heights, three inclinations, e 0 to 0.05.
- Class 0 above its switch, to e 0.9.
- The one-day, half-day, eight-hour and sixteen-hour classes on both sides of their switch, plus a THEMIS-like set.
- The 1,100-minute limit.

The test fails on any term carried twice, and on any term carried nowhere that is outside the known holes. Each known hole is
named with the issue that closes it. A hole that no set of the sweep shows any more also fails the test, so it is removed when
its fix lands.

In the low table the output table follows the record's degree to 70 (16.1, stack #477); the slow set takes degree 70
whatever the record states (16.18). A term above the record's degree is outside what the record asks for, so the test
counts it apart, not as a hole: at
the sweep's degree 31, 2,028 terms, the largest 18.5 m (at 300 km). The same low-table sets at a record of
70 show no term above any carrier's degree, and the test asserts that every term they leave nowhere (9,538, the largest
15.3 m, of \|q\| 2 at e 0.05) is in a hole below.

The holes, measured 2026-11-11 with 16.1's fast side on the field EGM2008 (terms over the sweep; the largest, in m over 5 days). From 0.6.28 the wide slow
list carries every class's slow terms above the switch to degree 12, outside low orbit; the census's hole there went from 978
terms (the largest 19 km, at e 0.9) to the 15 left in low orbit above the switch. Before 16.1's fast side the low table's
output table stopped at degree 12 (measured on 0.6.32): 10,740 terms to 74 m, and 58 band-taper complements to 21 m,
carried nowhere (stack #477, closed by the fast side):

| Hole | Issue | Terms | Largest |
| --- | --- | ---: | ---: |
| The low table: terms of \|q\| 2 or more on the output table's side, fast or the taper's complement (1 - w) of a slow one (the output table holds \|q\| up to 1) | stack #503 | 2,942 | 15 |
| A carrier's own size cut measures the term, or the share it leaves out, below the census (the output table counts the eccentricity vector's part radially; under 1 m) | stack #503 | 6,077 | 1 |
| The low table: the slow set's cut misses a term's part through the inclination (dF/di); the output table holds only its band share | stack #503 | 92 | 2.6 |
| The one-day class above its switch: under its floor, or above the grid's degree | stack #474 | 459 | 73 |
| Above the switch, every class: terms above the grid's degree 12 | stack #497 | 190,164 | 3,910 |
| Above the switch, low orbit: slow terms the grid leaves out and no rate carries | stack #473 | 15 | 4,060 |
| Outside the low table, below the switch: terms the output table's degree, q range or band floor leaves out and the class's rates do not carry | stack #511 | 407 | 91 |

The sizes are each term's own forced amplitude. They are not a forecast's error: a fit absorbs part of a term slower than the
arc.

**16.21 The output's Kepler solve** (from 0.6.37; stack #550). An AP output state takes the eccentric anomaly E of its
osculating elements (the mean elements with the corrections the output adds before its J2 step: the Sun's and Moon's
short-period terms, radiation, the tesseral terms and the drag steps) from M = E - e sin E. The warm start Ewarm is the mean
elements' E (in a covariance sigma point that shares the nominal's terms, the nominal's osculating E), and dm the difference
of M and Ewarm - e sin Ewarm, reduced to (-pi, pi]. The fast path is every state but the epoch state of a long-period set
within 0.02 rad of the equator.

- After the epoch, with e at most 0.08 and no tesseral grid: the series from the mean longitude;
- on the fast path, |dm / (1 - e cos Ewarm)| under 0.004: E = Ewarm plus the third-order series in dm;
- on the fast path, e at most 0.018 (below 1100 min) or 0.008 (above): the small-e series of M;
- otherwise Newton, from Ewarm + dm / (1 - e cos Ewarm) on the fast path and Ewarm + dm off it, for m_t = M + 2 pi
  round((Ewarm - e sin Ewarm - M) / 2 pi), M on the start's branch. m_t is M exactly wherever the two anomalies lie on the same
  side of 0, and where Newton meets its tolerance the solve is 0.6.36's;
- a Newton that ends its 30 steps within 1e-12 of the root is solved, its sine and cosine taken from that E, and counted apart
  (sdnap_kepler_unconverged 2); one that ends farther gives way to bisection on [m_t - e, m_t + e], where E - e sin E - m_t,
  increasing, changes sign, and is counted (sdnap_kepler_unconverged 0). The counts are every caller's (output states,
  covariance sigma points, fit evaluations).

Through 0.6.36 the solve had two faults.

*The branch.* Newton solved for M itself. For the seconds of a perigee passage in which the mean and the osculating anomaly lie
either side of 0, M was 2 pi from the start's branch: the first residual was 2 pi and each step 2 pi / (1 - e cos E), and unless
that is a whole number of turns (at e 0.5 exactly, 4 pi) the 30th step left E off the root, its sine and cosine retaken from it.
The series takes dm up to 0.004 (1 - e cos Ewarm), so this needed the output's corrections to move the anomaly by more than
that at perigee. Measured on the synthetic set (seed 498, every case at e 0.3 and above, 408, as AP seed records with FORCES
31,20, BTERM 0.022 and AGOM 0.012, at 1 s through every perigee passage over 5 days): 13 cases held such states, each
exactly a case whose Newton ended far from its root; the other 395 flew the same on both to the bit.

| Orbit (perigee, e) | Inclinations | States off at 1 s over the passages | Largest displacement |
|---|---|---|---|
| 2,000 km, e 0.5 (4:1, 4.0025 rev/day) | 20, 55, 70, 98, 165 | 142 to 401 states over 20 passages | 23 to 83 km |
| 2,000 km, e 0.5 | 130 | 15 states over 20 passages | 8.7 km |
| 800 km, e 0.5 (5:1, 5.047 rev/day) | 70, 98 | 152 states over 25 passages and 30 over 26 | 19.3 and 9.0 km |
| 200 to 1,000 km, e 0.9 (0.43 to 0.52 rev/day) | 0.5 and 20 (200 km), 70 (400 km), 98 and 130 (1,000 km) | 21 to 53 states over 2 or 3 passages | 100,000 to 136,000 km |

At e 0.5 the low-orbit grid's slow harmonics near the commensurability move the anomaly (16.18), and the block's states lay on
the orbit's own path, displaced along it, for up to 20 s a passage. At e 0.9 the drag steps at perigee (16.12) move it, and the
state lay up to the orbit's diameter away. Perigee 2,000 km at e 0.5 and i 0.5, perigee 500 km at e 0.7 and perigee 400 km at
e 0.5 held none.

*The rounding.* Off the fast path Newton stops only at |dE| < 1e-15. With E between 4 and 2 pi the residual moves in steps of
one ulp, and with 1 - e cos E under 0.89 Newton can cycle between two neighboring doubles at the root for all 30 steps. The
sine and cosine were then left at 0 and 1, a perigee state: on a long-period set at 1.2 rev/day, e 0.5, i 0.5, its state at
its epoch for 20,000 mean anomalies, 69 (0.35 %) came out at the perigee radius, up to 27,000 km from their place. A GEO set
(e 1e-5, i 0.05) held none.

Section 8's solve (output_j2_osc) runs Newton for every state, with no series, from Ewarm + dm where there is a warm start and
from k.m + e sin k.m where there is none (an SGP4XP set of 1100 min and more with AGOM 0 or a shared radiation term; AP's
output where e^2 or tan^2 (i/2) is at most 1e-24). It serves SGP4XP's sets, that AP output, and the long-period regime's
output Jacobian (16.19), whose six columns are formed by shifting each element by 1e-7 (n by 1e-7 n) from the base E, and of
which lambda, af and ag move the anomaly. Its Newton solves for k.m. For the milliseconds of a perigee passage in which the
warm start's anomaly and k.m lie either side of 0 it starts a turn from k.m, and unless its step, 2 pi / (1 - e cos E), is a
whole number of turns, it either converges to the root a turn away (the same sine and cosine) or does not converge at all,
its steps alternating in sign at about two turns. From a cold start it can end unconverged at e 0.995 and above (a replay of
the loop: 164 of 200,000 anomalies at e 0.995, 927 at e 0.999, none through e 0.99). From 0.6.38 a
Newton whose last step was 1e-12 or more is counted (sdnap_kepler_unconverged 1) and its E taken by bisection on [k.m - e,
k.m + e]; every solve that converges, and one whose last step was under 1e-12, is 0.6.37's bit for bit, so the only states
that differ from 0.6.37 are those far endings. An AP long-period set above e 0.3 whose rates evaluation forms a column whose
solve ended far gets another rate from 0.6.38 (the old column's partial was off by about 1e4 for that evaluation and was
taken, only its finiteness checked), and its later states move with it; none of the synthetic set's 965 cases every 300 s,
408 at 1 s through their passages, or the 529 seeded real windows met one. The cure differs in form from AP's because this
solve serves SGP4XP, which is held bit for bit from build to build: solving for the anomaly on the warm start's branch, as
AP's solve does, would change the last bits of every state whose Newton converges a turn away (on the synthetic set's SGP4XP
twins every 300 s over 5 days, 1,488 states of 64 near-circular cases moved, by under 1 mm). Through 0.6.37 the windows'
states took E from the last of the 30 steps: on the SGP4XP twins of the synthetic set's 408 cases at e 0.3 and above (no gravity terms,
BTERM 0.022, AGOM 0.012), flown every 1 ms for 15 s either side of every perigee passage over 5 days, 1,702 of 1,814 passages
at e 0.5 held a state 1 m or more off (up to 1,304 km), 1 of 5 at e 0.82 (4,342 km) and 108 of 157 at e 0.9 (up to 328,667
km); none at e 0.3 or e 0.6 to 0.74, where Newton reached the root one turn away. Its dm is SGP4XP's own short-period terms
(the Sun's, the Moon's, radiation): 2.4e-6 to 6.3e-6 rad at perigee on a 4:1 orbit at e 0.5, a window of 8 to 22 ms.

**16.22 Radiation pressure of the long-period regime through the output** (from 0.6.41; stack #479). SPEC 4 carries
radiation pressure in two parts: rates averaged over the mean orbit with the Sun held fixed, and first-order periodic terms
in the output. On a TESS-like orbit five days are under half of a 13.7-day revolution. The average then says little about
the forecast, and periodic terms built with the Sun held fixed miss the rest.

From 0.6.41 an AP set above e 0.3 in the long-period regime, where the Sun and Moon already go through the output (16.19),
takes radiation pressure the same way:
- The acceleration at the output's position joins the bodies' in J m = (0, a).
- It is a cannonball: SPEC 4's pressure, 4.5e-6 N/m^2 at 1 AU, over the square of the Sun-to-satellite distance, away from
  the Sun, times the record's Cr A/m.
- SPEC 4's averaged rates and periodic output terms are off there, so radiation is carried once (16.20, code 4).
- Where the output or the solve fails, the Gauss equations at the mean state take it.

Every set outside that regime flies bit for bit. With a Cr A/m of 0.02 m^2/kg, ten seeded sets flown 7 days at 300 s with
every force on are identical to 0.6.37's flights, state for state:
- low orbit, GTO, Molniya, GPS-like, e 0.5 at 9.5 h, geostationary and IGSO;
- the long-period class 0 at e 0.01 and at e 0.29;
- the one-day class at e 0.29.

*The anomaly.* There SPEC 4's periodic radiation terms are off, so the output does not make the mean Kepler solve that
served them. A plain output then solves the osculating anomaly from the cold start, as such a set without an area-to-mass
always has, and never from a warm start (16.21). Where Newton does not meet its tolerance there, 16.21's bisection and
counts apply. A covariance output still starts from the nominal's
osculating anomaly. A wide grid's terms (16.11) are read at the anomaly `tess::wide_six` solves itself from the mean
anomaly: Newton from E = M to a step under 1e-14, at most 50 steps. 0.6.36 passed it the mean solve's E, solved to 1e-15.

*The record.* An AP set of that regime with an area-to-mass above 0 states `PERTURBATIONS.SOLAR_RAD_PRESSURE` "SPHERE
(AGOM) THROUGH THE OUTPUT MAP, CYLINDRICAL SHADOW OVER THE STEP". With the radiation term Y0 (16.13) it states "SPHERE (AGOM)
THROUGH THE OUTPUT MAP, CYLINDRICAL SHADOW OVER THE STEP, AND ECOM2 Y0 (ARNOLD ET AL. 2015)", exactly when
`ORBIT_DETERMINATION.OD_DYNAMIC_PARAMETERS` carries an `ECOM2_Y0` entry. A flight takes the regime from the record's own
elements, as it takes its branch (`lp_radiation_record`, `src/ocm.inc`). The reader compares the text without regard to
case.
- A record of the regime with an area-to-mass above 0 that states any other text, or none, is refused,
  `radiation-model-superseded`. Every such record fitted before 0.6.41 is fitted again: it was fitted on SPEC 4's
  radiation, which is kilometers from this one there in a week.
- These are refused `radiation-model-mismatch`:
  - a record that states either text outside the regime, or with an area-to-mass of 0 or below;
  - a record of the regime that states the Y0 text without an `ECOM2_Y0` entry;
  - a record of the regime that states the plain text with one.
- A record outside the regime, or without an area-to-mass above 0, that states neither text is read and flown as before
  0.6.41. No build before 0.6.41 writes either text. Any other text there is not read (stack #559).

*The shadow.* AP's shadow is section 4's cylinder of radius R_E (16.15). The integrator's step in that regime is the
smaller of 95 minutes (38 in the one-day class) and 0.5 (1 - e0)^1.5 / n0, n0 the epoch's mean motion in radians a minute
(16.19). That is 7.0 to 7.4 minutes on the e 0.9 sets of about 2,800 minutes, 2.8 minutes at e 0.9 and 1,100 minutes, and
1.0 minute at e 0.95 and 1,100 minutes. A force switched off at the cylinder's edge inside a step puts the step's share of
the eclipse in the wrong place. So the force takes the share of a one-step window about the moment that the satellite
spends outside the cylinder, in closed form along the straight line of its position and velocity.

On an eclipsing orbit of 30 h at e 0.31 (node 0, J2 and radiation alone on both sides), the day-7 distances are:
- 123 m with the shadow taken as on or off at each moment;
- 34 m with the window;
- 25 m with the window and the numerical propagator's pressure constant;
- 19 m with J2 alone.

*Measured.* Seeded, no fit. J2 and radiation alone on both sides: AP's builds (0.6.36 and 0.6.41) have the Sun's and
Moon's mass ratios at zero, FFM's cannonball has Cr 1 and A/m 0.02 m^2/kg, and AP's Cr A/m is 0.02 m^2/kg. Distance to the
numerical propagator at days 1 / 3 / 5 / 7, m:

| set, node | before 0.6.41 | from 0.6.41 | J2 alone |
| --- | ---: | ---: | ---: |
| TESS-like (13.7 d, e 0.55), 0 | 185 / 623 / 942 / 1,076 | 3.4 / 38 / 109 / 210 | 0.1 / 0.5 / 1.2 / 2.2 |
| TESS-like, 120 | 112 / 307 / 769 / 1,543 | 2.8 / 25 / 78 / 172 | 0.1 / 0.5 / 1.2 / 2.2 |
| TESS-like, 240 | 156 / 119 / 321 / 704 | 3.0 / 24 / 63 / 139 | 0.1 / 0.5 / 1.2 / 2.2 |
| Chandra-like (63.5 h, e 0.685), 0 | 5.9 / 8.9 / 31 / 10 | 3.6 / 11 / 57 / 31 | 1.6 / 3.3 / 6.8 / 9.6 |
| Chandra-like, 120 | 5.0 / 29 / 83 / 70 | 2.6 / 9.9 / 16 / 19 | 1.6 / 3.3 / 6.7 / 9.7 |
| Chandra-like, 240 | 4.0 / 43 / 60 / 18 | 4.3 / 31 / 43 / 20 | 1.6 / 3.3 / 6.8 / 9.6 |
| 30 h, e 0.31, 0 | 8.8 / 10.5 / 53 / 32 | 7.0 / 8.3 / 18 / 34 | 1.5 / 8.9 / 8.6 / 19 |
| 30 h, e 0.31, 120 | 8.2 / 3.8 / 64 / 15 | 6.3 / 7.8 / 47 / 18 | 1.5 / 8.9 / 8.7 / 19 |
| 30 h, e 0.31, 240 | 10.7 / 8.4 / 13 / 17 | 1.0 / 13.4 / 28 / 17 | 1.5 / 9.0 / 8.5 / 19 |

*The constant.* AP's radiation pressure constant is SPEC 4's 4.5e-6 N/m^2, shared with SGP4XP. That is 0.88 % under the
numerical propagator's 1,361 W/m^2 over c, 4.540e-6 N/m^2.
- A record's fitted area-to-mass absorbs the ratio.
- A seeded, physical one does not, and from 0.6.41 the table's figures are that ratio alone: 139 to 210 m at day 7 on the
  TESS-like set.
- With the numerical propagator's constant in place of AP's, the TESS-like set flies to 0.1 / 0.5 / 1.3 / 2.2 m and the
  Chandra-like set to 1.6 / 3.3 / 6.8 / 9.6 m, J2's own figures.
- With that constant the eclipsing set flies to 1.4 / 10 / 2.0 / 25, 1.5 / 8.9 / 8.9 / 19 and 1.5 / 8.6 / 10 / 17 m at nodes
  0, 120 and 240.

*The cost.* It was measured on a loaded machine, on a TESS-like set (Cr A/m 0.02, a 1-minute grid over 7 days): the
medians of 7 rounds were 48.0 µs a state before and 48.9 after. On a THEMIS-like set they were 61.9 and 57.0. The
spread from run to run was about 5 µs, so the change makes no difference above that spread. The Jacobian of 16.19 is
already built there, and the share of light costs one quadratic.

`test/long-period-radiation.e2e.mjs`: AP's arms read the module's own Sun and Moon, FFM's DE440's, with J2 alone on both.
It takes radiation's own error at day 7, AP's radiation displacement (with radiation minus without) against FFM's:
- the eclipsing set: 20.0 m, against 48.3 m before 0.6.41 and 108.2 m with the shadow taken as on or off at each moment;
- the TESS-like set: 207.7 m, against 1,386.5 m.

It also holds the eclipsing set's flight through AP's shadow: an entry and an exit, and a 1 s scan across them and a step
boundary in which no position lies off its neighbors' curve (the fourth difference) by more than 1 mm; the largest is 1.2 µm over
14,401 states. It holds the record's refusals above, and
the round trip of the module's own fit.

**16.23 The zonal theory's constant radial term** (from 0.6.43; stack #503, #532). Section 2's rates are Brouwer's
secular and long-period rates to second order, and section 8's output adds the first-order J2 short-period terms. Held
to the same mean rates as the dynamics (the argument of latitude's and the node's), the theory's mean radius on a
near-circular orbit then sits above the true one by

  dr = (R_E^4 / a^3) [ J2^2 (199 cos^4 i - 80 cos^2 i + 25) / 32 - J4 (15/64)(35 sin^4 i - 40 sin^2 i + 8) ]

where a is the mean semi-major axis and i the mean inclination. AP's output (every AP set with gravity terms) adds -dr to
the radius. The velocity: the transverse speed is scaled so that the state's osculating energy (the speed squared over two
less mu over r) is unchanged, and the radial speed is kept; on a circular orbit that raises the transverse speed by dr
times the angular rate (1.1 cm/s at 10 m in low orbit). It is not the time derivative of the corrected positions, and
neither was the velocity before the term: AP's output velocity is not the rate of its output positions (stack #549). At
500 km and e 0.001 the transverse gap is 53 mm/s at i 27 deg and 8 mm/s at i 98 deg without the term, 13 and 12 mm/s
with it. Why the energy and not the angular rate: the radius error had been offsetting that gap in energy, so the same
angular rate would move the energy by about four times dr of semi-major axis, and a numerical flight started from AP's
output state would drift up to ten times faster along-track (seeded at a 500 km perigee and i 27 deg, the day-7
along-track RMS is 7.8 km on 0.6.36, 77 km at the same angular rate, 7.8 km at the same energy). The fit's residuals
are positions only, so the fitted elements are the same either way; the epoch covariance's velocity part moves by about
1e-6 of itself. A record carries its epoch floor at the two-body state of its mean elements (12.4), so the term does not
move what a reader takes off. A record written and fitted to zero residual by 0.6.39, flown against 0.6.39's flight of it
at 300 to 1,200 km and i 0.5 to 97 deg (seven cases), has its along-track variance at 24 h within 1.7e-5 of 0.6.39's with
the term on 0.6.41 (the term moves the states up to 45 m), and within 1.4e-4 with the term on 0.6.42, whose low table's fast
side moves them too (0.6.42 alone: 1.5e-4); `test/epoch-floor.e2e.mjs` holds it at 1e-3. The main output path, its
fallback (where e^2 or tan^2(i/2) is at most 1e-24) and the covariance's sigma-set pairs take the same term, each set at
its own a and i.
SGP4XP's output (section 8) is unchanged, bit for bit. J2 and J4 are 1.3's (EGM-96's). The numerical propagator's EGM2008
J4 differs by 1.7e-4 of itself, which would move the J4 part by at most 3 mm.

*Derivation.*
- The J4 part is first order. The mean radial equation of a near-circular orbit, r^3 w^2 = mu (1 - 5 J4 (R/r)^4 <P4>),
  has <P4> = (105 S^2 - 120 S + 24)/64 with S = sin^2 i. It is set against the theory's in-plane rate
  w = n [1 + (15/32)(-35 S^2 + 40 S - 8) J4 (R/a)^4], which is 2's lambda-dot - Omega-dot + Omega-dot cos i at e = 0,
  with r = a. Together they give -(15/64)(35 S^2 - 40 S + 8) J4 (R/a)^4 a.
- The J2^2 part is exact at i = 0. The equatorial circle obeys w^2 r^3 = mu (1 + (3/2) J2 (R/r)^2). The theory's
  lambda-dot is n [1 + 3 x + 14.625 x^2], with x = J2 (R/a)^2 (Brouwer's own coefficient is 11.25), and its radius is
  r = a (1 - (3/2) x). Together they give (9/2) x^2 a.
- At other inclinations the J2^2 polynomial is fitted, not derived. J2 alone was flown by a fixed-step integrator and
  compared with 2's rates at the same mean rates of the argument of latitude and the node, J2 scaled by 1 and by 0.5 and
  the result extrapolated to second order; a quadratic in S fitted to that from i 10 to 90 deg, (397.97 S^2 - 635.95 S
  + 287.99)/64, was rounded to the rationals above.
  - At i = 0 it meets the exact 9/2.
  - At i = 90 deg it gives 25/32, where the exact value is 13/16 = 26/32: a polar orbit is planar under J2, and its
    forced solution in Binet form, matched to the theory at the same mean rates, gives 13/16. The fit is low there by
    J2^2 R_E^4 / (32 a^3), 0.19 m at 420 km: the leftover at the polar cases of `test/zonal-radius-term.e2e.mjs`
    (+0.16 and +0.18 m).
  - Between, its error is not known exactly. The elimination bounds it, together with third order, J3, J5 and the Sun
    and Moon: the offset left is -0.4 to +0.2 m (below).
  - Third order is under 1 % in low orbit: -0.8 % near the equator at 400 km, about -0.3 m there.
- With EGM's J4 / J2^2 = -1.382 the two parts sum to 17.55 (c^2 - 0.494)(c^2 - 0.202), with c = cos i: about +11 m at
  i 87.5 and 420 km, -2.4 m at i 55, and +42 m near the equator.

*Measured.* AP is fitted to the numerical propagator's forecast over 0 to 5 days, with J2 to J5 and the Sun and Moon on
both sides.
- Over 300 to 1,400 km and 7 inclinations (42 near-circular cases), the closed form is within 0.31 m of the offset AP
  showed before the term (measured on 0.6.36).
- With the term, the offset left is -0.4 to +0.2 m: -0.4 to -0.1 m at i 5 to 63.4 deg (the largest at 300 km and i
  5, where third order is about -0.3 m), +0.1 to +0.2 m at i 87.5 and 98 deg (the fit's shortfall at the pole). At i 45
  and 63.4, where there was none, it leaves -0.1 to -0.3 m.
- Before the term the offset was -2.6 to +44.7 m: largest near the equator, below the true radius at i 55, about 0 at
  i 45 and 63.4.

*Eccentricity* (measured, not derived; stack #532). The term is applied at every eccentricity. The offset left after it:

| a - R | e | Largest offset left |
| --- | --- | --- |
| 1,200 km | 0.05 or less | 1.3 m (test/zonal-radius-term.e2e.mjs's case at i 28.5) |
| 1,200 km | 0.1 | 1.8 m |
| 4,000 km | 0.3 | 9.1 m (21.0 m without it) |

**16.24 Records refused by name.** plugin-manifest.json's "Refused by name" lists for propagate, load_epochs,
propagate_epochs and maneuver name every refusal the record decoder makes (propagate and propagate_epochs also name
decayed:<time>, and fit decayed-in-arc:<time>, SPEC 16.25: refusals of a flight and of a fit, which the decoder does not make); export_omm's names those an SGP4 or SGP4XP
record can reach after the method's own checks (an AP set is refused first, theory-not-exportable:AP, and a record whose
forces are not its theory's, forces-not-exportable, before the decoder reads it). Missing through 0.6.42 (stack #540):
solid-tides-unsupported (16.14), gravity-model-mismatch (16.2), parameter-repeated:ECOM2_Y0, parameter-invalid:ECOM2_Y0
and parameter-not-modeled:<name> (16.13), and from 0.6.41 radiation-model-superseded and radiation-model-mismatch
(16.22; export_omm's list names the second, which an SGP4 or SGP4XP record stating the long-period radiation text
reaches); export_omm's list also lacked unsupported-center, weather-rows-unselected and the density-correction refusals
an SGP4XP record reaches, and named three it cannot return (gravity-model-mismatch, parameter-repeated:ECOM2_Y0 and
parameter-invalid:ECOM2_Y0).

**16.25 Decay** (stack #564). An AP flight is refused, as decayed, from the first time either of these holds:
- (a) with drag, DRAG lowers the set's perigee radius over one revolution, or over the grid's next step where that is longer,
  by more than one density scale height at its mean perigee: -(da/dt (1 - e) - a de/dt)_drag max(P, h_next) > H(h_p), the
  drag term's own mean rates, counted only where they lower the perigee (a perigee that rises counts for nothing);
- (b) its mean perigee height a (1 - e) - R_E is under 100 km (kDecayFloorKm; Jacchia 1970 has no density under 90 km).

SGP4XP keeps the library's decay at a mean perigee radius under 1 R_E (section 10), so its conformance is unchanged, and SGP4
keeps its own.
- Why a step. The theory averages the drag over a revolution, which holds while the perigee density changes little within
  one, and its grid steps two revolutions at a time in low orbit. On #564's seeds the last good node loses 0.58 H a
  revolution and 1.15 H over its 2.9 h step; the node after it is not an orbit (mean perigee -283 km), and every state
  interpolated between the two was off from the first minute (31,250 km at 70.57 h). h_next is the step the grid takes
  from that node (next_node's), a function of the set alone, so the crossing is the record's and the same in any call order.
  The crossing therefore depends on the grid's step rule and moves if that rule ever changes: a version that changes the
  step states the crossing times that move. It refuses up to a step earlier than the per-revolution reading would: #564's
  two seeds are flown to 136.5 km (perigee 200 km, e 0.001, BTERM 0.01; 136.7 km through 0.6.48) and 160.7 km (perigee 220 km, e 0.01, BTERM 0.1).
- What the rule reads, and why. Drag at a perigee passage lowers the semi-major axis and the eccentricity together, so its own
  part of the perigee radius's rate, da/dt (1 - e) - a de/dt, is about 0 on a highly eccentric orbit; the Sun and the Moon move
  the mean perigee of such an orbit by more than a scale height a revolution, rising or falling, and that is not decay. A first
  form of the rule read the whole mean rate of the perigee radius, every force, in absolute value, and refused 23 synthetic
  orbits at e 0.9 (apogee 118,000 to 134,000 km) whose numerical truth never decays, and refused the fitted records of six of
  them (five marked CONVERGED; stack #594: four at the epoch, two within the first two days, three of the six with a RISING perigee). The rule reads the
  drag term's part alone, evaluated at the node (the gate below), and counts it only as a fall. On near-circular orbits drag is the whole of the perigee's rate (gravity is 0.2 % of it on the
  seeds below), so their crossings move by that much and no more.
- What goes in. da/dt and de/dt are the drag term's own mean rates at the node's mean state (a full evaluation of the drag part
  of the rates, SPEC 3.4, the same call the rates make). The gate uses the node's whole mean rates:
  (|da/dt (1 - e)| + |a de/dt|) max(P, h_next) > kDecayTestKm (5 km), in kilometers. A crossing calculation evaluates
  the earlier node's drag part for any positive gate value, including values below 5 km. The whole rates only gate the
  evaluation; the drag-only loss decides the rule. The gate reads the magnitudes of the whole rates' two perigee terms,
  which on a highly eccentric record are the Sun's and Moon's, so on such a record the drag term is evaluated at every node. H is the scale height of the set's own
  atmosphere and weather at its mean perigee, from two density evaluations 1 km either side along the mean perigee's
  direction, made only once the loss passes 5 km. The test changes no step, rate or state: a time before the crossing is
  answered as before, to the bit.
- Eccentric orbits. Drag near perigee takes the apogee down: the semi-major axis falls while the perigee radius barely
  moves, so the rule is on the perigee radius, drag's part of it. At BTERM 0.01 and a 150 km perigee the semi-major axis
  loses 3.80 km a revolution at e 0.7 and the perigee radius 0.6 m (H 17.6 km); near e 0 the two are close. Above e 0.3 the
  drag test (a) therefore stays shut while the orbit is eccentric, and a decaying set is refused by the floor test (b) alone
  (stack #582).
- Where it is found. On the grid's nodes as they are made outward from the epoch (the cached node run and the uncached
  integration alike), once per direction, kept with the set beside its checkpoints and window; no node past the crossing
  node is made. Its time is the root of the test's quantity (ln(loss / H), or 100 km - h_p), linear between the last node
  before it and the first past it, with no further evaluation of the rates beyond the earlier node's test. An epoch that already meets the rule is decayed at every
  time.
- What a caller gets past it. A state: status 4 (kPropDecayed) and the plugin ABI's ORBPRO_STATE_DECAYED; the row store's
  planes are not numbers. `propagate` and `propagate_epochs` answer the epochs before the crossing: the block stops at the
  last of them, its USEABLE_STOP_TIME is the crossing and its COMMENT reads "decayed:<time>; <n> epochs after it refused"; a
  call asking only for times past it is refused `decayed:<time>`. `sdnap_covariance_at` gives every time past the earliest
  crossing of the nominal or any of its moved sets (no difference can be formed once one has crossed) 42 NaN and returns 4.
  `fit`: a trial set that crosses inside the arc is a failed evaluation (the damping takes a smaller step); a written set
  that crosses inside the arc is refused `decayed-in-arc:<time>` and no record is written; one whose mean perigee is under
  400 km and that crosses within 7 days of its epoch is written with "decays at <time>" in its OD COMMENT. Every reader
  finds the same crossing from the record.
- Refused trials in a fit. A trial set that crosses inside the arc is a refused step, never the end of a pass. The fit's
  fallback differences each column of its Jacobian above the iterate (the elements, the drag term, AGOM, Y0); a column whose
  set above is refused as decayed is taken below the iterate, (residuals - trial) / h, the same column. A pass in which a
  column is refused on both sides cannot be said to be at a minimum, and an iteration with such a column cannot declare
  convergence: the pass ends with status 2, the record states CONVERGED false and its OD COMMENT reads "fit: not converged;
  the last pass stopped because a column of its Jacobian could not be differenced: the set decays inside the arc a step to
  either side". (The AGOM column's step below the iterate is at most half the iterate's AGOM, and there is none where the
  iterate's AGOM is not positive, since an AGOM of 0 or less switches the radiation off: that column is then refused, with
  no value read from it.) Only a refusal of an AP set that decays takes this path;
  every other refusal, and every fit in which no column is refused, is as before to the bit. A pass whose starting set decays
  inside the arc (refused at its first evaluation) is refused `decayed-in-arc:<time>` as a written set that does; the fit does
  not move its own start until a set flies. A written set that decays after its arc but before a held-out state of the block
  writes that state as not accepted, reason DECAYED, with no computed value, and does not refuse the record.
  `test/decay-fit.e2e.mjs`: a made-up set at a 200 km perigee whose drag crosses the rule 2 to 3 h after a 120 h arc, fitted to
  FFM's states: the first form of the rule (a refused column ending its pass as converged) read AGOM 0 and a fit RMS 1.21 times
  0.6.45's; this build reads 1.01 times, AGOM solved.
- Two stated cases. A record that carries a forecast (SPEC 18). In `propagate` the block's USEABLE_STOP_TIME is the theory's
  crossing even when states of the carried forecast after it are in the block (those states are the forecast's), and a carried
  forecast's covariance past the crossing refuses the call, propagation-failed, "no covariance". In `propagate_epochs` the carried
  forecast's states after the crossing are answered (status 0) and count as answered after it, so for a crossing after the epoch the
  block states no USEABLE_STOP_TIME, and the block carries no covariance at all: the carried states have none, so every covariance
  line of the block is dropped, those of the states before the crossing too (for a crossing before the epoch the block states its
  USEABLE_START_TIME whatever is answered). In a series with a blend (SPEC 14): an epoch
  inside a blend window that holds a set's crossing, where the blend needs the crossed set's state, is refused and counted among
  the epochs after the crossing though it lies before it.
- Covariance and the crossing. The crossing a call with covariance names is the earliest of the nominal's and every moved set's:
  at the first epoch the call refuses, wherever it stands in the list and whatever the refusal (a decay or another), each set the
  covariance started is run to the call's furthest epoch on each side, so the name does not depend on the order or the list of
  the epochs asked (two calls on one record name the same crossing when the crossing lies at or before the furthest epoch of
  both); a call that refuses no epoch runs nothing more, since an epoch answered with its covariance lies before every set's
  crossing. A Hermite blend's two probes at its window's end start each set's covariance bank when the call requests covariance,
  without evaluating that covariance. A refused nominal probe names the record's earliest crossing, whichever epoch of the call
  is asked first; a moved set crossing between the requested epoch and the window's end does not refuse an epoch before every crossing.
  `propagate_epochs` refuses an epoch past a moved set's crossing as `propagate` does, and, for a record
  that carries no forecast, never writes the block without its covariance. An AP record whose epoch already meets the rule and carries a covariance is refused
  `decayed:<epoch>` in `propagate` and `propagate_epochs`, and `sdnap_covariance_at` and `sdnap_covariance_full_at` give 42 (or
  the full width of) NaN at every time and return 4.
- Held-out statistics. The held-out states past a written set's crossing are not scored: HELD_OUT_RMS_KM, HELD_OUT_MAX_KM and the
  day statistics are of the held-out states before it, HELD_OUT_STATES counts those, and none are stated when there is none.
- Wide sets (e above 0.3). A state in the last fifth of a 48 h interval is blended toward the next schedule node's grid. Where
  that node lies past the crossing, the state is answered from the interval's own grid alone and is not refused: asking such a
  state runs the grid to the next node and so finds the crossing, so the answer is the same in any call order. These states are
  not 0.6.45's to the bit (0.6.45 blended toward a grid built from a state past the crossing: an orbit below the floor, or by
  the drag test one the averaged rates no longer describe); the measured difference is stated with the test, `test/decay-wide.e2e.mjs`. A set at or below e 0.3, and every state of a wide set outside
  those hours, is 0.6.45's to the bit before the crossing.
- Limit of the rule above e 0.3 (stack #582). Above e 0.3 a decaying set is refused by the floor test alone: drag's own part of
  the perigee's rate is about 0 while the orbit is eccentric, so the drag test (a) stays shut and the mean perigee under
  100 km ends the flight, which can come days after the orbit really re-enters or not at all. Measured on made-up sets, both on
  NRLMSISE-00, the numerical propagator flown from AP's own start state: perigee 110 km, e 0.7, BTERM 0.2 (balloon-like)
  re-enters at 40.3 h and the rule has no crossing within 10 days; perigee 110 km, e 0.5, BTERM 0.045 re-enters at 79.3 h and the
  first form of the rule crossed at 66.8 h and this build, by the floor test, at 68.9 h, both before it. Where the
  rule comes late or not at all, AP answers states far from the numerical propagator. This is not made worse by the rule (without
  it the flight had no end); a rule for these sets has to use the loss of orbital energy per perigee passage against the energy
  the orbit has left, or the numerical propagator's own crossing as the yardstick.
- What gets worse: a decaying set loses its states from the crossing to the surface, its last revolutions, which the theory
  does not describe (they were up to 31,250 km off). The first state after a load over a 7-day grid costs more on the
  measured e 0.9 records. Two alternating rounds of `test/kernel-cost.mjs --repeats 5 --steps 300`, measured on a shared
  machine under load, gave 0.6.48 / this build: long-period e 0.9, 153.437 / 255.893 ms and 152.621 / 190.424 ms
  (+66.8 % and +24.8 %); THEMIS, 218.065 / 251.491 ms and 223.059 / 258.866 ms (+15.3 % and +16.1 %).
  A state from a warm grid costs the same within 0.6 % on these records: long-period e 0.9, 87.798 / 87.830 µs and
  89.264 / 89.715 µs; THEMIS, 114.692 / 115.388 µs and 115.554 / 115.832 µs.
- `test/decay.e2e.mjs`: the two seeds decay at 70.140 h and 47.063 h (70.133 h and 47.064 h through 0.6.48: the rule reads drag's part of the perigee's rate, which moves the crossing by at most 0.01 %), every state before the crossing 0.6.45's bit for bit
  and the jump detector at most 2.88 m over them; the epoch store gives the same states before the crossing and status 4
  after it in time order, reversed and shuffled; sets at a 500 km perigee and at a 300 km perigee with e 0.3 fly 7 days
  bit for bit; `sdnap_covariance_at` returns 4 past a record's crossing.

## 17. Products: the producer contract (side B's method, outside the SGP4-XP specification)

What `fit` and the covariance exports hand to the product writers P1 to P9 (`spacedatastandards.org` `lib/js/PROD`):
one `$OCM` per fit, its `$ODR` of residuals, and the covariance per epoch. `test/products-parameters.e2e.mjs`.

### 17.1 Parameter order and units

The covariance rows are the state (TEME position, km; velocity, km/s; `COV_TYPE` CARTPV) and then, when present and
solved, in this fixed order:

| Row kind | prwDynamicParameter | Unit | The theories' sensitivity |
| --- | --- | --- | --- |
| 6 | DRAG_AREA_OVER_MASS (BTERM) | m\*\*2/kg | yes (central difference of the theory) |
| 7 | DRAG_AREA_OVER_MASS_RATE | m\*\*2/kg/s | none |
| 8 | SRP_AREA_OVER_MASS (AGOM) | m\*\*2/kg | yes |
| 9 | IN_TRACK_ACCELERATION | m/s\*\*2 | none |
| 10 | OUTGASSING_ACCELERATION | km/s\*\*2 | none |

`COV_SIZE` is 6 plus the solved count; `COV_PARAMETERS` and `COV_PARAMETER_KINDS` have `COV_SIZE - 6` entries in that
order; `COV_UNITS` has `COV_SIZE` entries (km x3, km/s x3, then the parameters' units); `COV_ORDERING` LTM;
`COV_REF_FRAME` the record's `TRAJ_REF_FRAME`. `OD_DYNAMIC_PARAMETERS` names every row, `SOLVED_FOR` true for each;
`fit` lists DRAG_AREA_OVER_MASS and SRP_AREA_OVER_MASS and nothing it does not know, and under $PCF FORCES.ECOM2 also
ECOM2_Y0 (16.13), which is no covariance row: its `SOLVED_FOR` says whether the fit solved it.

### 17.2 Parameters the theories have no sensitivity to

SGP4XP and AP have no term in DRAG_AREA_OVER_MASS_RATE, IN_TRACK_ACCELERATION or OUTGASSING_ACCELERATION, and the force
model does not change for them. The fit options `fit_bdot`, `fit_thrust` and `fit_outgassing` (one byte each after
`fit_agom` in the 56-byte `sdnap_fit` options) default off; set, the fit is refused before it runs (`sdnap_fit` status
-4; `sdnap_fit_refusal` gives `parameter-not-modeled:<NAME>`). The `$PCF` has no field for them, so `fit` never sets
them. The byte after `fit_outgassing` is `fit_y0` (16.13): only `fit` sets it; `sdnap_fit` refuses it
(parameter-record-only:ECOM2_Y0). A record that carries their rows (solved by another determination) is read and flown as constant parameters:
their state transition columns are zero, their variances and mutual terms constant, their cross terms with the state
carried by the state columns (`P(t) = J(t) P_p J(t)^T`, the parameter block of `P_p` the record's).

### 17.3 Statistics

- Weighting (12.1, the fit's weighting): under drag the fit weights each TEME position component with the a priori
  sigma 1 km, and `OD_DATA_WEIGHTING` reads `UNIT WEIGHTS: A PRIORI SIGMA 1 KM PER TEME POSITION COMPONENT`; above the
  drag with the data's own sigma_r, and it reads `EQUAL WEIGHTS: SIGMA <sigma_r> KM PER TEME POSITION COMPONENT, THE
  POST-FIT RESIDUAL SCATTER, NOT BELOW THE EPHEMERIS' STATED COVARIANCE OR 1 MM` (sigma_r to six digits). `OD_ALGORITHM`
  ends `UNIT WEIGHTS` or `WEIGHTED AT THE DATA SIGMA` accordingly.
- `WEIGHTED_RMS` = sqrt(sum (r_i / sigma)^2 / (3 N)) over the N fitted states' components = `FIT_RMS_KM` / sqrt(3) /
  sigma, sigma the one `OD_DATA_WEIGHTING` states (1 km, or sigma_r).
- `SEDR` (W/kg), the energy the non-gravitational forces remove (the `$OCM` definition): -dE/dt =
  (mu / (3 a)) (n-dot_ng / n), positive under drag, with mu / a = (n a)^2 from the set's mean motion and the theory's
  semi-major axis, and n-dot_ng / n the theory's epoch rate with BTERM less the rate without it
  (`COV_PROPAGATION.NON_GRAVITATIONAL_RATE_PER_DAY`, per day, here per second). Written with the covariance.
- Emission refusals, never a partial record: a parameter row without a name (`cov-parameter-unnamed`), a name or kind
  outside the five (`cov-parameter-unknown`), rows out of the fixed order (`cov-parameter-order`), `COV_UNITS` other than
  above (`cov-units`), `COV_SIZE` not 6 plus the solved count (`cov-size`).
- Reading (`cov::read`): rows out of the fixed order, a kind outside the five or not solved for are malformed
  (`invalid-covariance`; `sdnap_covariance_at` -6).

### 17.4 Residual record

`fit` writes one `$ODR` per fit on `residuals`, after its `$OCM`: `RUN_ID` and `OCM_CONTENT_ID` the `$OCM`'s CID,
`CONVERGENCE_REASON`, and `EDITED_OBSERVATIONS`, one per state of the input block in order (the input count):

| Column | Value |
| --- | --- |
| OBSERVATION_ID | `<ephemeris frame>.<block>.<state>`, from 1 |
| EPOCH | the state's UTC time |
| OBSERVATION_TYPE | POSITION_VECTOR |
| OBSERVED_VALUE, COMPUTED_VALUE | the state's and the fitted set's geocentric distance, km (frame independent) |
| WEIGHT | 1 / sigma^2 inside the fit arc, sigma the one `OD_DATA_WEIGHTING` states (17.3: 1 per km^2 under drag, 1 / sigma_r^2 above it); 0 outside |
| ACCEPTED, REASON | inside the fit arc; REASON BEFORE FIT ARC or HELD OUT otherwise |
| NORMALIZED_RESIDUAL | (observed - computed) / sigma |
| PERTURBATION_MODEL_CODE | SGP4XP or AP, the set's theory |

The residual is OBSERVED_VALUE minus COMPUTED_VALUE. A state of the block past the written set's decay crossing and outside
the fit's arc (SPEC 16.25) is written not accepted, REASON DECAYED, WEIGHT 0, its COMPUTED_VALUE and NORMALIZED_RESIDUAL
not-a-number (no value: an unset field would read as 0); a reader of the residuals takes the accepted rows. A fit whose inputs have no per-observation form writes no rows,
and P9 is then refused downstream.

### 17.5 Covariance per epoch

The covariance the module propagates stays in the `$OCM`'s `COVARIANCE_DATA` layout: `sdnap_covariance_full_at(ocm,
length, minutes, count, out)` gives per time the TEME state and the LTM of the `COV_SIZE` x `COV_SIZE` covariance of the
state and the record's parameter rows (6 + N(N+1)/2 doubles); `sdnap_covariance_at` gives the 6 x 6 state block. The
state transition sensitivities are not exposed in any typed field (no output carries a PRW state matrix), so P8 is
refused.

### 17.6 The $OMM boundary

`export_omm` writes an SGP4XP set's BTERM and AGOM in the `$OMM`'s BTERM and AGOM fields (m\*\*2/kg) and leaves BSTAR and
MEAN_MOTION_DDOT unwritten. `ingest_omm` reads an SGP4XP set's BTERM and AGOM from those fields when either is present;
an SGP4XP `$OMM` with neither carries them, by the SGP4-XP element-set definition, in BSTAR and MEAN_MOTION_DDOT, and is
read from there (program decision D13; the owner may rule to refuse instead). The ingested `$OCM`'s HEADER.COMMENT states
the source in one fixed line: `BTERM_SOURCE=BTERM AGOM_SOURCE=AGOM` or `BTERM_SOURCE=BSTAR AGOM_SOURCE=MEAN_MOTION_DDOT`
(an SGP4 set: no line).

### 17.7 What an AP record's elements and caps mean

AP's mean elements are defined per resonance class, per regime (period below or above 1,100 min) and per eccentricity branch.
The same six numbers on two sides of a switch are different orbits: 8 to 401 m apart at epoch and up to 33 km after 7 days at
the regime limit. Sets on different sides must not be differenced, blended or interpolated.

The branch is fixed at the record's epoch, from its own epoch elements, for the whole flight (16.7): a record's output is
continuous in time wherever its mean motion and eccentricity go. The module differences and blends one branch only: a
covariance's moved sets fly the record's branch (12.1), a fit that would end on a switch is settled on one branch, held at
an eccentricity switch on one side, or refused fit-at-branch-limit at a limit in n (16.7), and the epoch store does not
blend two sets on different branches (14.3). A consumer that
differences, blends or interpolates two records of one object must do the same.

MAXIMUM_TESSERAL_DEGREE is a cap on families, not the degree of a field (16.1). In the low table, with tesseral cap d above
12 the short-period terms are complete to first order to degree min(d, 70), with |l - 2p| up to 17, the table's own 0.5 m
size cut, and 16.1's band rule and band guard (a term inside the slow band is the table's at most 1 - w). On every other
branch the first-order terms and the m-daily family stop at min(d, 12), and 16.1 lists what carries anything of degrees 13
to min(d, 31): class 0 with a period under 1,100 minutes its j = 1 near-resonant terms and the shallow set, the half-day
class its tail, the one-day class at e 0.3 or below its tail; everywhere else nothing. Off the low table at
800 km, the terms of degree 13 to 31 not carried are 14 m RMS (18.9 m in all against a 31 x 31 field).

An AP mean set and the state AP gives for it agree to first order only: integrated numerically that state leaves the AP
trajectory at dn/n = k J2^2 (R/a)^4, k from 1.8 to 9.6, 0.7 to 4.5 km/day in low orbit. AP elements must come from an AP fit.

## 18. The carried forecast (a separate product, outside the SGP4-XP specification)

An `$OCM` element set may carry a numerical forecast of its object made by another propagator (a numerical propagator
such as propagator/ffm, or an operator's own ephemeris), stored in the record (`src/carried.inc`). Inside the forecast's
span flight returns that forecast, not AP's theory; everywhere else the theory, exactly as without it: a record without
one is untouched by the carried code (SGP4XP and SGP4 records fly as 0.6.9 flies them, bit for bit; an AP record flies
alike through propagate_epochs and the store, `test/carried-identity.e2e.mjs`). The record is a separate product, a way to
deliver another propagator's forecast with AP's flight around it. Its figures (its error against truth, which is the
forecast's; its compression error against the forecast; the step at the span's end; bytes a day; the cost of making
it) are its own and never AP's accuracy: AP's accuracy is the theory's alone (SPEC 16). Version 2 (0.6.10)
holds the record to 1 cm and 0.1 mm/s against the forecast at any time (18.4, 18.9), reads a fresh record's forecast
only where it is flown (18.5), states the forecast's source in the record (18.6), fits the theory to the forecast's last
part (18.7) and labels every output state (18.8).

### 18.1 Layout

SDS 1.279.0 as pinned, no schema change. `POLYNOMIAL_POSITION_RECORDS`, one `PPEPositionRecord` per segment:
`BASIS_TYPE` CHEBYSHEV, `NUM_COEFFICIENTS` n (fit writes 16, 24, 32, 48 or 64; a reader takes 1 to 64), `POS_COEFF_X`,
`_Y`, `_Z` (km), `EPOCH_MID` (ISO 8601 UTC, microseconds), `EPOCH_HALF_SPAN` (s), `MAX_POSITION_RESIDUAL` and
`RMS_POSITION_RESIDUAL` (km, against the forecast's interpolant at the points checked, 18.4). No velocity coefficients:
the velocity is the series' derivative. `TRAJ_TYPE` POLYNOMIAL_POS, `TRAJ_BASIS` PREDICTED, `TRAJECTORY_BLOCKS` and
`METADATA` START_TIME and STOP_TIME (18.6). The frame is the set's `TRAJ_REF_FRAME`: TEMEOFEPOCH at the set's `EPOCH` for
AP with gravity terms, TEMEOFDATE otherwise. Each segment starts where the one before ends, within 1 ms; the span is the
first segment's `EPOCH_MID - EPOCH_HALF_SPAN` to the last's `EPOCH_MID + EPOCH_HALF_SPAN`, both included. Refused by
name when the record is read (propagate, load_epochs, propagate_epochs): `POLYNOMIAL_OE_RECORDS`
(carried-type-unsupported), records without `TRAJ_TYPE` POLYNOMIAL_POS or that type without records
(carried-type-mismatch, carried-records-missing), `STATE_DATA` beside them (carried-state-data), and any fault of the
first or last segment (below). Every other segment is read when a state first needs it (18.5): another basis
(carried-basis-unsupported), velocity coefficients (carried-velocity-coefficients), a table that does not verify, a
malformed segment or a coefficient that is not finite (carried-segment-invalid), a time inside the span the segment
found does not hold within 1 ms (carried-gap). `propagate` refuses such a state by name; the store returns
ORBPRO_PROP_BAD_INPUT (-4) for it; the record's other states fly (`test/carried-edges.e2e.mjs`).

### 18.2 Evaluation

The segment holding t (the last starting at or before it: the segment last flown or its successor, else interpolation
search over the segments' start times, each segment read as the search reaches it), tau = (t - EPOCH_MID) /
EPOCH_HALF_SPAN, p = sum c_k T_k(tau),
p' = sum c_k T_k'(tau) / EPOCH_HALF_SPAN. M(t), GCRF to TEME of date: the module's output matrix, the one every GCRF
state takes (gcrf.inc `gcrf_to_teme_output`, the quintic through 6-hour nodes with GMST82 unrounded), made orthonormal
(one Newton step of the polar decomposition); dM/dt its central difference over +-60 s. TEMEOFEPOCH: Q0 = M(t0) at the
set's epoch; TEME r = M Q0^T p, v = M Q0^T p'; GCRF r = Q0^T p, v = Q0^T p'. TEMEOFDATE: TEME r = p, v = p' - dM/dt
M^T p (the module's convention, the GCRF velocity turned by M); GCRF r = M^T p, v = M^T (p' - dM/dt M^T p). EME2000 is
the frame bias of GCRF. No ERFA call per state: a carried GCRF state costs what a carried TEME state costs. M is within
1.1e-13 rad of the exact chain (ERFA, GMST82 unrounded) over 30 days at 7-minute steps (`sdnap_carried_frame_error`):
0.005 mm at 42,164 km. fit undoes its own exact rotation of a GCRF block (gcrf_to_teme), so a forecast given in GCRF
flies back in GCRF to the series alone.

### 18.3 Flight

`propagate`: inside the span the forecast in OUTPUT.FRAME; the theory is not initialized when every requested time is
inside the span and the record carries no `COVARIANCE_DATA`. `load_epochs`: the store keeps the record's bytes (one
copy) and reads its segments as flown (18.5); `sdnap_epochs_set_at`, `sdnap_epochs_at` and `propagate_epochs` time the
forecast by the call's split Julian date (`test/carried-epochs.e2e.mjs`), and whether a span holds the time is decided
once, by that date, for the selection, the state and its label alike: the set taken for its span flies its forecast
there (`test/carried-span-end.e2e.mjs`, split dates a double step apart about a stop). Selection (SPEC 14) first
takes a set whose carried span holds t, the latest by epoch where more than one does, without a blend; elsewhere the
selection by epoch as before, where a blend joins two theory states on one branch only: a switch between a carried
forecast and the theory is a step (14.3), and `sdnap_epochs_select` reports b = -3 there, also where the span-first
rule takes a set the selection by epoch would have blended or stepped from (`test/branch-at-epoch.e2e.mjs`). Sets of
one epoch carrying different spans are both kept (records split by day: one object's forecast in a record per day),
ordered by their span's start; a later record of the same epoch and span replaces as before. A carried record A and
its hand-over set B (18.7) load as one series: inside A's
span its forecast; after the stop B, whose epoch is the stop, by the selection by epoch; before the span A's theory,
whose epoch is the span's start. Covariance: the theory's (SPEC 12) beside the forecast's states.
`sdnap_covariance_at`, `sdnap_covariance_full_at`, `events`, `maneuver` and `export_omm` use the theory; `export_omm`
writes the set (an `$OMM` has no place for the forecast). At the span's ends the state steps by the theory's distance
from the forecast there (no blend), which fit states (18.4) and 18.7 keeps small at both ends.

### 18.4 fit

`$PCF` OUTPUT on fit names the forecast the record carries: START_TIME and STOP_TIME; EPOCHS, FRAME
other than UNSPECIFIED, STEP_SECONDS and MAXIMUM_STATES away from their defaults are refused by name
(configuration-refused); START_TIME alone makes the hand-over set (18.7), STOP_TIME alone is refused. The theory set
is fitted as without OUTPUT but for its arc, anchored at the span's start (18.7). The block's states,
ascending, reach from at or before START_TIME to at or after STOP_TIME (carry-order, carry-not-covered). From those
states and up to four beyond each end:

1. Each state in GCRF (a GCRF or EME2000 block's own, undoing the fit's exact rotation; any other block's by M), then in
   the record's axes: Q0, or M with the velocity M v + dM/dt r.
2. Consecutive states inside the span at most 0.1 rad of arc apart about the Earth's center (carry-states-sparse): 60
   s in low orbit (0.066 to 0.07 rad, the common step of an operator's ephemeris) passes, 120 s is refused. Two tiers by
   the widest spacing: at most 0.05 rad (30 s in low orbit and at the perigee of an e 0.9 orbit at 500 km) the velocity
   bound at the checked points is 0.05 mm/s and the record is held to 0.1 mm/s against the forecast at any time; wider,
   0.1 mm/s at the checked points and about 0.2 mm/s at any time. The position bound is 1 cm on both. Measured, the
   4-node Hermite's own velocity error between FFM states: at most 0.002 mm/s at 30 s; at 60 s 0.017 mm/s at 500 km
   and 0.075 mm/s at 300 km; 1.4 mm/s at 120 s. On the wider tier the velocity agreement that keeps the Hermite (item 3)
   is 1 mm/s RMS (the Lagrange derivative's own error grows with the spacing's seventh power; an analytic theory's still
   misses by 20 to 70 mm/s). The record states its tier, the widest spacing and its largest residuals at the checked
   points in fit's COMMENT and in TRAJECTORY_BLOCKS[0] COMMENT (18.6).
3. The interpolant: the 4-node Hermite of positions and velocities (degree 7); the 8-node Lagrange of the positions
   when a state has no velocity, or when the velocities differ from that Lagrange's derivative by more than 0.05 mm/s
   RMS (FFM's states, at the steps 2 allows: 0.0002 to 0.011 mm/s; SGP4 and SGP4XP: 20 to 70 mm/s in low orbit, an
   analytic theory's velocity is not its position's derivative).
4. Densified: four points per interval and the span's two ends; the interpolant halfway between consecutive points.
5. Segments from the span's start: the longest window of at least n points whose least squares (Householder QR) holds,
   within 5 mm and the velocity bound, every densified point of the window, the interpolant halfway between two, at
   the window's 2n Chebyshev points (cos((j + 1/2) pi / 2n)) and halfway between those. The rows: position and velocity
   at the 2n Chebyshev points (the series is pinned near the window's ends, where its high terms move between densified
   points), the velocity row times 5 mm over the velocity bound; the window's end, and its start (the segment before's
   own position, velocity and acceleration there, or the span's first point), weighted 1e4: consecutive segments meet in
   position, velocity and acceleration, so the output's second difference has no step at a joint. The velocity bound:
   0.05 mm/s (the Hermite path; 0.1 mm/s on the wider tier, item 2); 1 mm/s against the Lagrange's derivative (the
   positions-only path: that derivative misses FFM states 30 s apart by up to 0.04 mm/s and steps by up to 0.12 mm/s
   where two windows meet; an analytic theory's positions hold no tighter). EPOCH_MID the window's middle at the
   text's microsecond. n is 16, 24, 32, 48 or 64: the fewest whose segments write at most 10 % more bytes (112 + 24 n
   a segment) than the fewest any n writes (a state's arithmetic grows with n; in low orbit 64 write about 6 % fewer
   bytes than 32). None holds: carry-tolerance (states too sparse, or a forecast that is not smooth: a maneuver).
6. `ORBIT_DETERMINATION.COMMENT`: the segments, the span, the bytes, the largest position and velocity residuals, the
   interpolant, the widest spacing of the states and the tier (item 2) with what it holds at any time; at the span's
   start and stop, the theory minus the forecast (km, and radial, in-track and cross-track in the forecast's UVW
   axes): the jump flight makes there.

### 18.5 Loading and its cost

A record is verified once (`ocm::view`: the `$OCM` verifier checks the vector of segments, not each segment's table,
build.mjs), its record-level fields and its first and last segments read (the span), and nothing else of its forecast.
The store copies a kept record's bytes once (a record dropped by CACHE_DAYS, MAX_SETS_PER_OBJECT or THEORIES is never
copied) and keeps a view; a state reads its segment when it first needs it (its table by its own verifier, EPOCH_MID's
text, the coefficients copied out), and the segment stays read. A segment is found as 18.2 says: the one last flown or
its successor first (in order, the next state's), else interpolation search over the start times (a fresh record's
first state reads about log2 of its segment count). The segment found flies only when it meets its neighbors: each
readable neighbor within 1 ms (the successor starts where it ends, the predecessor ends where it starts), else
carried-gap (-4 from the store) for every time it holds; a neighbor that cannot be read is not judged (its own fault
refuses its own times). That judgment reads the record's bytes alone, once per segment, so segments out of order or
overlapping a neighbor are refused whichever time is asked first (`test/carried-edges.e2e.mjs`). Not judged without
reading every segment: a record whose segments each meet their neighbors yet repeat a stretch of time (a run of
segments written twice, the junctions refused): a time in the repeated stretch gets one of the two runs' states,
both the record's own, which one by the search and the segment flown before. Measured (provisional, ratios from
interleaved runs on a loaded machine, load average 60 to 90 on 28 cores):

- Load of a 304 KB record (version 1's 8 days at 500 km) against version 1's build: 294 against 672 us a record (paired
  rounds, median); the host's copy of the same bytes into the module and the call alone (a payload of that size refused
  at its first bytes) 230 to 440 us; the store's own copy of them 14 us. The load is now the host's copy, about 0.7 to
  1.0 us a KB here, and the record's other fields (8 to 25 us, as without a forecast).
- W1 to W3 on 8-day records (FFM forecasts, 200 objects; carried over SGP4, median [95 % interval]): 500 km 0.72
  [0.40, 1.14], 2.2 [0.72, 8.9], 1.47 [1.27, 2.18]; 830 km 0.74 [0.61, 1.42], 1.4 [0.57, 2.7], 1.43 [1.03, 1.99]; e 0.1
  0.96 [0.58, 1.70], 1.9 [0.91, 6.7], 1.57 [1.33, 1.69]; MEO 0.87, 0.96, 0.75 and geosynchronous 0.58, 0.65, 0.46 (W2
  includes the fresh record's load). Taking the fewest coefficients within 10 % of the fewest bytes (18.4) and the
  frame once per instant moved W3 in low orbit from 2.3 to 1.4 to 1.6.
- W4, N fresh records one state each a day from the span's start, by span (1 cm bound; record bytes, carried us a
  record, SGP4 us a record, ratio median [95 % interval]):

| Orbit | 1 day | 2 days | 4 days | 8 days |
| --- | --- | --- | --- | --- |
| Low, 500 km | 55 KB; 102 / 7.7 us; 14.5 [1.4, 62] | 106 KB; 180 / 8.7; 24.1 [0.4, 88] | 206 KB; 302 / 10.3; 29.3 [2.0, 130] | 406 KB; 368 / 7.0; 43.6 [5.1, 200] |
| Low, 830 km | 38 KB; 35 / 3.3; 8.5 [1.7, 88] | 69 KB; 62 / 7.7; 14.4 [1.2, 86] | 131 KB; 169 / 6.9; 16.1 [3.9, 144] | 255 KB; 260 / 12.5; 22.4 [6.7, 155] |
| MEO | 7.1 KB; 11.8 / 2.7; 3.9 [1.0, 26] | 8.5 KB; 9.4 / 2.0; 4.2 [1.2, 8.1] | 9.6 KB; 10.9 / 2.1; 4.9 [1.4, 41] | 13.5 KB; 12.6 / 2.0; 5.9 [0.7, 41] |
| Geosynchronous | 7.2 KB; 7.6 / 6.8; 0.99 [0.60, 2.7] | 7.5 KB; 7.5 / 7.0; 1.00 [0.50, 1.9] | 8.5 KB; 8.2 / 7.5; 1.09 [0.49, 2.3] | 11.2 KB; 11.6 / 7.2; 1.38 [0.59, 4.0] |
| Low, e 0.1 | 28 KB; 58 / 3.8; 6.4 [1.0, 76] | 52 KB; 72 / 12.1; 6.2 [2.0, 42] | 97 KB; 130 / 8.6; 20.4 [0.7, 143] | 185 KB; 232 / 4.8; 48 [2.4, 146] |
| Transfer, e 0.72 | 15 KB; 54 / 3.4; 5.4 [2.1, 122] | | | |

(The transfer orbit's longer records were not built in time: AP's fit on that orbit took 2 minutes for the 1-day
record and 5 for the 2-day one under this load.)

(Under this load SGP4's own W4 swings from 2 to 12 us a record; the intervals are as wide.) A fresh record passes W4
(under 2) only where SGP4's own W4 is as dear as the record's floor: at geosynchronous altitude (SGP4's deep-space
initialization, 7 us). The floor is about 7.5 us a record at 7 KB, most of it the theory's weather rows (5.5 KB, 18.9);
MEO records stay 4 to 6 times SGP4's; a low-orbit record carries 22 to 68 KB a day (the velocity bound, 18.9) and fails
W4 at any span by its copy alone. Records split by day (fit with OUTPUT for each day; the store keeps one
object's day records side by side and flies the one whose span holds the time, 18.3) bring a fresh state's bytes to
one day's; the further cut, to the segment a state needs (about 1 KB), is the server's (a record and the segment
ranges it serves), not a module call (DigitalArsenal/spacedatanetwork-stack#394).

Which workloads pass as of this build (pass: the 95 % interval of carried over SGP4 under 2, the cost goal of #316;
W1 to W3 on the 8-day records, the transfer orbit's on its 1-day record (W1, 7 days, runs past it and is not counted); W4 on
every span measured; provisional, the closing figures are the quiet run's on the integrated build; #394 takes W4):

| Orbit | W1 | W2 | W3 | W4 |
| --- | --- | --- | --- | --- |
| Low, 500 km | pass, 0.72 [0.40, 1.14] | **fails**, 2.2 [0.72, 8.9] | **fails**, 1.47 [1.27, 2.18] | **fails**, 14.5 to 44 |
| Low, 830 km | pass, 0.74 [0.61, 1.42] | **fails**, 1.4 [0.57, 2.7] | pass, 1.43 [1.03, 1.99] | **fails**, 8.5 to 22 |
| MEO | pass, 0.87 [0.40, 1.24] | pass, 0.96 [0.93, 1.03] | pass, 0.75 [0.70, 1.36] | **fails**, 3.9 to 5.9 |
| Geosynchronous | pass, 0.58 [0.30, 1.17] | **fails**, 0.65 [0.62, 2.44] | pass, 0.46 [0.27, 0.89] | **fails**, 0.99 to 1.38, intervals to 2.3 to 4.0 |
| Low, e 0.1 | pass, 0.96 [0.58, 1.70] | **fails**, 1.9 [0.91, 6.7] | pass, 1.57 [1.33, 1.69] | **fails**, 6.2 to 48 |
| Transfer, e 0.72 | not counted | pass, 0.69 [0.24, 1.73] | pass, 0.43 [0.31, 0.88] | **fails**, 5.4 [2.1, 122] |

A median under 1 is not a pass: W2's and W4's fresh-record loads put their intervals over 2 at this load.

The `$OCM` verifier's one change (build.mjs): `OCM::Verify` checks POLYNOMIAL_POSITION_RECORDS' vector of offsets
(`VerifyOffset`, `VerifyVector`: its extent inside the buffer) and not each segment's table. The only reads of an
element of that vector in `src/` are `carried::ensure` (`t.recs->Get(k)`), which verifies that table with its own
verifier before any field of it is read; `carried::read` takes the vector itself and its size, and reads the first
and last elements through `ensure`. A table offset past the buffer's end or wrapping to before its start, a vtable
truncated at the end, and a coefficient vector running past the end refuse the state that needs that segment and leave
the record's other states flying (`test/carried-edges.e2e.mjs`). Both verifiers run with `check_alignment = false`: a
record cut from a size-prefixed stream is aligned to its prefix, not to its own start, so offsets in the plain view
are 4 bytes off the builder's alignment (`ocm::view`, as every SDS input here); WebAssembly loads tolerate an unaligned
scalar, and `ensure` reads the coefficients with `memcpy`. A record's vector of segments costs at most 52 bytes of
the store a segment (an element of 4 bytes in the record): a hostile record of n bytes asks at most 13 n.

Threads. The state-only epoch-store batch (`sdnap_epochs_at` without a covariance plane) assigns each series to one
thread, and carried tracks move between threads across batches. `propagate`, `propagate_epochs`, `load_epochs`,
`load_epochs_open`, `load_epochs_part`, `load_epochs_close`, the other `sdnap_epochs_*` exports and `fit` run on the
calling thread. A track's storage is sized once when it is read and never resized; coefficients are read in place from
the record's bytes, copied by the store at load before flight. Segment fields are published by a release store after
one reader moves the state from unread to busy; acquire readers see the completed fields, and a reader finding busy
uses its own copy. The search hint is per thread. `test/epoch-carried-pool.e2e.mjs` checks 128 distinct carried and
theory series at four instants inside and outside the carried span, in TEME and Earth-fixed frames, at 0, 1, 4 and 15
threads, with threaded batches run: all state, status and source bytes equal the serial entry, whose digest is
0.6.57's. The verifier stays
lazy with these states, and they did not change W4: on the six orbits' 1-day records and the 8-day record at 500 km
(paired rounds against the build before them, 100 records, 21 rounds) the load per record moved by -12 to +3 us,
within the rounds' spread, and the first state took 0.1 to 1.0 us against 0.2 to 4.3 (the coefficients are no longer
copied out).

### 18.6 What the record states

Existing `$OCM` fields, written by fit (`test/carried-compression.e2e.mjs` checks them):

| What | Where |
| --- | --- |
| The span's start and end | `METADATA` START_TIME and STOP_TIME; `TRAJECTORY_BLOCKS[0]` USEABLE_START_TIME and USEABLE_STOP_TIME |
| That it is a forecast | `TRAJ_BASIS` PREDICTED; `TRAJECTORY_BLOCKS[0]` TRAJ_ID "CARRIED FORECAST", TRAJ_BASIS "PREDICTED", TRAJ_TYPE "POLYNOMIAL_POS", INTERPOLATION "CHEBYSHEV" and its degree, TRAJ_REF_FRAME (and TRAJ_FRAME_EPOCH), TRAJ_UNITS "km" |
| The initial state's source | `TRAJECTORY_BLOCKS[0]` TRAJ_BASIS_ID (the `$PVN` SOURCE_ID given beside the block), PROPAGATOR (its PRODUCER), and in its COMMENT the ephemeris block's ORBIT_DETERMINATION (OD_METHOD, OD_ARC_START, OD_ARC_STOP, OD_OBSERVATIONS_USED); `PROVENANCE` the `$PVN` itself |
| The forecast's force model and weather date | `TRAJECTORY_BLOCKS[0]` COMMENT: the ephemeris block's own COMMENT, as its producer wrote it ("not stated by the ephemeris block" when it has none) |
| The covariance inside the span | `TRAJECTORY_BLOCKS[0]` COMMENT: "the theory's (COVARIANCE_DATA, SPEC 12), no realism claim for the forecast" |
| The step to the theory at each end | `ORBIT_DETERMINATION.COMMENT` (18.4): position (and RTN) and velocity |
| What it is held to against the forecast | `TRAJECTORY_BLOCKS[0]` COMMENT and `ORBIT_DETERMINATION.COMMENT`: 1 cm and 0.1 mm/s, or about 0.2 mm/s on the wider tier (18.4 item 2), the widest spacing of the states, the largest residuals at the checked points |
| What ORBIT_DETERMINATION describes | `TRAJECTORY_BLOCKS[0]` COMMENT: the OD block describes the theory's fit to the forecast's first part; the determination from observations is the initial state's source named in the trajectory block |
| What serves after the span | `TRAJECTORY_BLOCKS[0]` COMMENT: the hand-over set (18.7), else this record's theory; the hand-over set's own block TRAJ_ID "HAND-OVER", USEABLE_START_TIME the stop |

Not typed today; the fields the record would need (a change to the standards package):

1. `OCMTrajectoryBlock.PERTURBATIONS: Perturbations`: the forecast's own force model (gravity degree and order, third
   bodies, radiation pressure, drag model) and its weather (`SW_DATA_SOURCE`, `SW_DATA_EPOCH`: the weather date), beside
   the record's `PERTURBATIONS`, which are the theory's. On the input side the same table on
   `ephemerisDataBlock` (`OEM`), so the producer of a forecast states it typed and fit copies it.
2. `OCMTrajectoryBlock.ORBIT_DETERMINATION: OrbitDetermination`: the initial state's determination (method, arc,
   observations, residuals), beside the record's `ORBIT_DETERMINATION`, which is the theory's fit.
3. `OCMTrajectoryBlock.COV_ID: string` naming the `OCMCovarianceBlock` that holds inside the span (today the theory's
   `COVARIANCE_DATA`; a forecast's own covariance would be a `COVARIANCE_BLOCKS` entry with `COV_BASIS` PREDICTED).
4. Typed steps at the span's ends: `OCMTrajectoryBlock` START_STEP_KM, STOP_STEP_KM, START_STEP_KM_S, STOP_STEP_KM_S
   (theory minus forecast), today COMMENT text.
5. `PPEPositionRecord.EPOCH_MID_SECONDS: double` (seconds from the record's `EPOCH_TZERO` or the set's epoch) beside the
   required EPOCH_MID text: a segment's time without parsing text (18.5 parses one text per segment read).
6. `ephemerisDataLine.SOURCE` (an enum: THEORY, CARRIED, BLEND) or `ephemerisDataBlock.TRAJ_BASIS`: the label of 18.8,
   today the block's COMMENT.
7. `PCFOutput` CARRY_POSITION_TOLERANCE_M and CARRY_VELOCITY_TOLERANCE_MM_S: the bound of 18.4 set by the caller,
   today fixed (5 mm and 0.05 mm/s at the checked points; the record held to 1 cm and 0.1 mm/s).

### 18.7 The span's end

Two records of one object (`test/carried-span-end.e2e.mjs`):

- **A, the carried record** (fit with OUTPUT.START_TIME and STOP_TIME). Its theory is anchored at the span's start, the
  observation cutoff: with no USEABLE_START_TIME, USEABLE_STOP_TIME or FIT.HOLDOUT_HOURS stated, the arc is the block's
  states from START_TIME through START_TIME plus the default span (FIT.DEFAULT_SPAN_HOURS, 48 h; ECCENTRIC_ above the
  threshold, 24 h), at most STOP_TIME; its epoch the first, the later states held out. The theory's covariance
  (COVARIANCE_DATA, SPEC 12) has its origin there and grows forward through the span. Its weather rows run from the day
  before the span's start through the stop, so that covariance flies over the whole span.
- **B, the hand-over set** (fit with OUTPUT.START_TIME alone, at A's stop). The theory fitted to the forecast's last
  part: the arc ends at START_TIME by the span rule (DESIGN 2e.3, 12.8), its epoch the arc's last state (the stop), the
  later states held out (FIT_STATISTICS.HELD_OUT_*: the theory against the forecast continued); its covariance grows
  forward from the stop. It carries no forecast; its TRAJECTORY_BLOCKS[0] says what it is: TRAJ_ID "HAND-OVER",
  USEABLE_START_TIME the stop; fit's COMMENT states its step at the stop, theory minus forecast.
- **Together** (one series in a store, 18.3): before the span A's theory, labeled THEORY; inside it A's forecast,
  CARRIED FORECAST; from the stop B's theory, HAND-OVER. **A alone**, after its span, flies its own theory, labeled
  THEORY, with the step at the stop that its COMMENT states (a day or more past its arc on spans over 2 days). **B
  alone**, before its start, flies its theory backward, labeled THEORY; from its start HAND-OVER.

The steps at both ends, the theory less the forecast as fit states them (AP: zonal 20, tesseral 31, NRLMSISE-00 on
the forecast's constant weather; FFM forecasts of 9 days at 30 s, 70 x 70, Sun, Moon, radiation pressure, drag; spans
of 2 and 4 days from the forecast's start; median / 95th percentile over the objects, nodes and phases spread):

| Regime | Span (days) | Objects | Start, now (km) | (mm/s) | Start, before (km) | (mm/s) | Stop with B, now (km) | (mm/s) | Stop, A alone (km) | (mm/s) | Stop, before (km) | (mm/s) |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| Low, 500 km | 2 | 8 | 0.024 / 0.053 | 32.4 / 54.6 | 0.024 / 0.053 | 32.4 / 54.6 | 0.040 / 0.065 | 42.9 / 60.2 | 0.042 / 0.067 | 44.9 / 62.5 | 0.042 / 0.067 | 44.9 / 62.5 |
| Low, 500 km | 4 | 8 | 0.024 / 0.053 | 32.4 / 54.6 | 0.394 / 0.634 | 441 / 699 | 0.031 / 0.102 | 38.5 / 81.7 | 0.605 / 0.764 | 660 / 871 | 0.031 / 0.064 | 27.9 / 54.6 |
| Low, 830 km | 2 | 8 | 0.013 / 0.030 | 12.4 / 25.9 | 0.013 / 0.030 | 12.4 / 25.9 | 0.018 / 0.025 | 14.2 / 21.1 | 0.018 / 0.025 | 14.2 / 20.6 | 0.018 / 0.025 | 14.2 / 20.6 |
| Low, 830 km | 4 | 8 | 0.013 / 0.030 | 12.4 / 25.9 | 0.099 / 0.144 | 103 / 162 | 0.013 / 0.029 | 19.1 / 35.7 | 0.121 / 0.193 | 129 / 208 | 0.013 / 0.023 | 18.4 / 30.3 |
| MEO | 2 | 8 | 0.0051 / 0.0077 | 0.441 / 0.802 | 0.0051 / 0.0077 | 0.441 / 0.802 | 0.0047 / 0.0072 | 0.378 / 0.590 | 0.0047 / 0.0073 | 0.374 / 0.591 | 0.0047 / 0.0073 | 0.374 / 0.591 |
| MEO | 4 | 8 | 0.0051 / 0.0077 | 0.441 / 0.802 | 0.0051 / 0.0074 | 0.462 / 0.742 | 0.0046 / 0.0069 | 0.296 / 0.672 | 0.0044 / 0.0071 | 0.483 / 0.714 | 0.0047 / 0.0069 | 0.291 / 0.672 |
| Geosynchronous | 2 | 8 | 0.0014 / 0.0026 | 0.107 / 0.155 | 0.0014 / 0.0026 | 0.107 / 0.155 | 0.0018 / 0.0026 | 0.135 / 0.156 | 0.0018 / 0.0026 | 0.133 / 0.151 | 0.0018 / 0.0026 | 0.133 / 0.151 |
| Geosynchronous | 4 | 8 | 0.0014 / 0.0026 | 0.107 / 0.155 | 0.010 / 0.016 | 0.708 / 1.2 | 0.0018 / 0.0026 | 0.090 / 0.205 | 0.0090 / 0.018 | 0.700 / 1.2 | 0.0017 / 0.0028 | 0.092 / 0.198 |
| Low, e 0.1 | 2 | 4 | 0.025 / 0.031 | 22.5 / 26.9 | 0.025 / 0.029 | 22.5 / 23.9 | 0.027 / 0.040 | 16.6 / 27.6 | 0.027 / 0.041 | 16.8 / 27.6 | 0.027 / 0.038 | 18.9 / 27.3 |
| Low, e 0.1 | 4 | 4 | 0.025 / 0.031 | 22.5 / 26.9 | 0.220 / 0.306 | 225 / 303 | 0.016 / 0.043 | 14.7 / 28.8 | 0.154 / 0.472 | 167 / 496 | 0.020 / 0.024 | 11.1 / 12.9 |
| Transfer, e 0.72 | 2 | 4 | 0.032 / 0.049 | 35.1 / 41.2 | 0.064 / 0.068 | 46.6 / 66.2 | 0.030 / 0.045 | 4.5 / 5.3 | 0.063 / 0.090 | 7.1 / 15.7 | 0.034 / 0.051 | 4.1 / 4.8 |

("Before": the arc at the stop in the carried record itself, 0.6.10's first build; e 0.1 before on 2 objects.) The
start's step no longer grows with the span; the stop's with B is the old one; A alone at its stop is as large as the
old start was (a day or more past its arc).

The covariance grows forward (position sigma, the square root of the trace of its position block, `carried-span-end`
on a 3-day span from 6 h into the forecast): at 500 km A 38 m at the span's start and 944 m at its stop, B 38 m at the
stop and 933 m a day later; at geosynchronous altitude A 1.2 m and 1,269 m, B 1.3 m and 1,259 m.

Before this rule (0.6.10's first build) the theory was fitted to the forecast's last part in the carried record
itself: the step at the stop as B's now, the error past it as follows (the same forecasts, 2-day spans), and the start
of a longer span days off the arc:

| Regime | Step at the stop | Velocity step (mm/s) | 1 day past | 3 days past | 7 days past | Step, theory fitted to the first 24 h |
| --- | --: | --: | --: | --: | --: | --: |
| Low, 500 km | 0.041 / 0.066 | 44.5 / 62.3 | 0.27 / 0.32 | 1.04 / 1.39 | 4.39 / 6.03 | 0.096 / 0.238 |
| Low, 830 km | 0.018 / 0.025 | 14.6 / 20.1 | 0.046 / 0.079 | 0.20 / 0.28 | 0.88 / 1.23 | 0.073 / 0.168 |
| MEO, 26,560 km | 0.0047 / 0.0077 | 0.38 / 0.64 | 0.0046 / 0.0077 | 0.0073 / 0.0103 | 0.014 / 0.027 | 0.0057 / 0.0091 |
| Geosynchronous | 0.0020 / 0.0027 | 0.14 / 0.16 | 0.0045 / 0.0089 | 0.015 / 0.031 | 0.057 / 0.121 | 0.0046 / 0.0063 |
| Low, e 0.1 | 0.016 / 0.041 | 10.8 / 27.1 | 0.11 / 0.23 | 0.31 / 0.96 | 1.18 / 3.54 | 0.089 / 0.149 |
| Transfer, e 0.72 | 0.029 / 0.062 | 4.6 / 9.3 | 0.11 / 0.25 | 0.88 / 1.54 | 1.15 / 1.43 | 0.180 / 0.356 |

Arcs of 6, 12 and 24 h ending at the stop (FIT.DEFAULT_SPAN_HOURS) make the step a little smaller in low orbit (0.023
to 0.026 km median at 500 km) and the error past it larger (10.8 to 92 km at 7 days at 500 km, against 4.4); 48 h is
the best or within its spread past the stop in every regime: the rule stands. "Past the stop" is against the forecast
continued, the same force model: the forecast's own error against the truth past its span is not in these figures.

With the arc at the stop, the start of a span longer than the arc was days off it, flown backward: the step there grew
with the span (spans of 2, 4 and 8 days; median / 95th percentile over the objects):

| Regime | Span (days) | Objects | Step at the start (km) | Its velocity (mm/s) | Step at the stop (km) | Its velocity (mm/s) |
| --- | --: | --: | --: | --: | --: | --: |
| Low, 500 km | 2 | 8 | 0.024 / 0.053 | 32 / 55 | 0.042 / 0.067 | 45 / 63 |
| | 4 | 8 | 0.39 / 0.63 | 441 / 700 | 0.031 / 0.064 | 28 / 55 |
| | 8 | 8 | 0.36 / 1.06 | 374 / 1,201 | 0.053 / 0.081 | 59 / 86 |
| Low, 830 km | 2 | 8 | 0.013 / 0.030 | 12 / 26 | 0.018 / 0.025 | 14 / 21 |
| | 4 | 8 | 0.099 / 0.144 | 103 / 162 | 0.013 / 0.023 | 18 / 30 |
| | 8 | 8 | 0.088 / 0.97 | 91 / 1,007 | 0.017 / 0.026 | 13 / 38 |
| MEO | 2 | 8 | 0.0051 / 0.0077 | 0.44 / 0.80 | 0.0047 / 0.0073 | 0.37 / 0.59 |
| | 4 | 8 | 0.0051 / 0.0074 | 0.46 / 0.74 | 0.0047 / 0.0069 | 0.29 / 0.67 |
| | 8 | 8 | 0.012 / 0.026 | 1.5 / 3.3 | 0.0041 / 0.0062 | 0.79 / 1.01 |
| Geosynchronous | 2 | 8 | 0.0014 / 0.0026 | 0.11 / 0.16 | 0.0018 / 0.0026 | 0.13 / 0.15 |
| | 4 | 8 | 0.010 / 0.016 | 0.71 / 1.21 | 0.0017 / 0.0028 | 0.09 / 0.20 |
| | 8 | 8 | 0.044 / 0.088 | 3.2 / 6.5 | 0.0020 / 0.0027 | 0.14 / 0.18 |
| Low, e 0.1 | 2 | 2 | 0.025 / 0.029 | 23 / 24 | 0.027 / 0.038 | 19 / 27 |
| | 4 | 2 | 0.22 / 0.31 | 225 / 304 | 0.020 / 0.024 | 11 / 13 |
| | 8 | 1 | 0.52 | 543 | 0.006 | 10 |
| Transfer, e 0.72 | 2 | 4 | 0.064 / 0.068 | 47 / 66 | 0.034 / 0.051 | 4.1 / 4.8 |
| | 4 | 2 | 0.12 / 0.15 | 85 / 113 | 0.066 / 0.096 | 3.2 / 4.2 |

(The eccentric orbits' rows have fewer objects: AP's fits there took 2 to 7 minutes each under this load.) Within a
2-day span the arc covers the span and the start's step is the stop's size. Beyond it the start's step grows to 0.1 to
0.5 km in low orbit at 4 days (to 1 km at the 95th percentile at 8 days) and 5 to 90 m above it. At 8 days the arc
rule extended the arc to 120 h for half the 500 km objects (the drag held); the start's step there ranges from 0.04
to 1.2 km over the objects.

A time before the span's start now gets A's theory a step from its epoch, with the small step the table states (no
blend; labeled THEORY, 18.8). A's weather rows begin the day before the span's start, so under WEATHER_SOURCE RECORDS
its theory flies from the span's first day and refuses earlier days by name (weather-rows-short); under the theory's
own flux model it flies anywhere. States further back come from the record the forecast's producer made before (18.3).

### 18.8 Labels

Every output state's source can be known. `propagate` writes one `$OEM` block per input record and `propagate_epochs`
one per series, as without a forecast (a reader of block 0 gets every state). A record carrying a forecast, a hand-over
set, or a series holding either, states each run of consecutive states from one source in its block's COMMENT, in this
grammar (everything else writes 14.3's COMMENT alone, or none, as before):

```
comment = sources [ ". " steps ]
sources = "SOURCES: " run *( "; " run )
steps   = 14.3's "Not blended (SPEC 14.3): " text, the switches the block crosses without a blend
run     = source " " first "-" last " " epoch " TO " epoch
source  = "CARRIED FORECAST" / "THEORY" / "HAND-OVER" / "BLEND"
first, last: the run's first and last state, indices from 0 in the block's order, both included; the runs cover
             0 to the block's last state, in order
epoch   = the run's first and last state's EPOCH, as its line states it
```

For example, a record carrying 2026-10-15T00:00 to 2026-10-16T00:00 flown at four times:
`SOURCES: THEORY 0-0 2026-10-14T23:59:59.999000 TO 2026-10-14T23:59:59.999000; CARRIED FORECAST 1-2
2026-10-15T00:00:00.000000 TO 2026-10-16T00:00:00.000000; THEORY 3-3 2026-10-16T00:00:00.001000 TO
2026-10-16T00:00:00.001000` (on one line). CARRIED FORECAST: the forecast a record carries, inside its span; THEORY: a
record's element set; HAND-OVER: a hand-over set at or after the time it serves from (18.7); BLEND: the store's blend of
two sets' states of different sources. The store at one instant: `sdnap_epochs_source_at(jd_whole, jd_frac, first,
count, int32_t* out)`, one code per series: 0 THEORY, 1 CARRIED FORECAST, 2 BLEND, 3 HAND-OVER. The E2Es parse the
COMMENT by this grammar and check every state's source against it (`test/lib/carried.mjs` `oemLines`;
`test/carried-edges.e2e.mjs`, `test/carried-epochs.e2e.mjs`, `test/carried-span-end.e2e.mjs`).

### 18.9 Bound and size

The record is held to 1 cm and 0.1 mm/s against the forecast at any time inside the span: 5 mm and 0.05 mm/s at the
checked points (18.4), the input's interpolant (0.002 mm/s at 30 s) and the series between checked points the rest.
Built from states 60 s apart in low orbit (the wider tier, 18.4 item 2), 1 cm and about 0.2 mm/s: from the same FFM
forecasts every 60 s, at most 2.41 mm and 0.108 mm/s at 300 km (60,544 bytes a day against 67,760 from 30 s) and 3.42
mm and 0.103 mm/s at 500 km (42,656 against 49,536); joints at most 1.40 mm.
The compression test (`test/carried-compression.e2e.mjs`): FFM forecasts (70 x 70, Sun and
Moon from DE440, radiation pressure, drag; GCRF every 10 s), the record built from the states every 30 s and flown at
every other 10-s time; at the uniform 10-s grid, the second difference of the record's position less the forecast's
at every triplet holding a joint (the output-continuity residual less the forecast's own, which is the
perturbing acceleration times h squared: 1.3 to 2.4 m in low orbit):

| Regime | Span (days) | Segments of n | Bytes per object-day | Largest (mm) | Largest (mm/s) | Joints | Largest at a joint (mm) | The forecast's own residual there (m) |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| Low, 300 km | 1 | 77 of 32 | 67,760 | 1.08 | 0.0506 | 76 | 0.43 | 1.77 |
| Low, 500 km | 1 | 72 of 24 | 49,536 | 1.47 | 0.0501 | 71 | 0.55 | 2.37 |
| Low, 830 km | 1 | 47 of 24 | 32,336 | 2.10 | 0.0503 | 46 | 0.58 | 1.94 |
| Low, 1,336 km | 1 | 29 of 24 | 19,952 | 3.15 | 0.0503 | 28 | 0.49 | 1.30 |
| MEO, 26,560 km | 2 | 4 of 24 | 1,376 | 5.00 | 0.0127 | 3 | 0.015 | 0.16 |
| Geosynchronous | 2 | 2 of 32 | 880 | 4.99 | 0.0125 | 1 | 0.005 | 0.12 |
| Inclined geosynchronous, e 0.075 | 2 | 2 of 32 | 880 | 4.99 | 0.0127 | 1 | 0.014 | 0.13 |
| Transfer, e 0.72 | 1 | 14 of 24 | 9,632 | 5.00 | 0.0492 | 13 | 0.41 | 1.26 |
| Molniya, e 0.74 | 1 | 10 of 24 | 6,880 | 5.00 | 0.0494 | 9 | 0.56 | 1.94 |
| THEMIS-like, e 0.82 | 2 | 13 of 24 | 4,472 | 5.00 | 0.0493 | 12 | 0.56 | 0.98 |
| e 0.9, perigee 500 km | 2 | 6 of 24 | 2,064 | 5.00 | 0.0499 | 5 | 0.43 | 0.51 |
| TESS-like, e 0.55 | 4 | 1 of 48 | 316 | 0.02 | 0.0002 | 0 | | |

Pass (0.1 m, 0.1 mm/s, 0.05 m at a joint) in every regime. The record is about 5.5 KB without the forecast (its
theory's weather rows most of it).

The position bound chosen by bytes (the same builder at 1 and at 10 cm, 5 and 50 mm at the checked points, the count
of fewest bytes; FFM forecasts of 1, 2, 4 and 8 days at 30 s): low-orbit and e 0.1 records take the same bytes at both
(the velocity bound sets the segments' length there: 47 KB a day at 500 km, 30 KB at 830 km, 21 KB at e 0.1); medium
orbit 0.99 to 1.6 KB a day at 1 cm against 0.87 to 1.6 at 10 cm, geosynchronous 0.66 to 1.7 against 0.46 to 1.0. W4
does not change (18.5). 1 cm costs nothing that matters and leaves a tenth of the test's 0.1 m.

### 18.10 Version 2 does not

Blend at the span's ends (the steps are stated, 18.4, and kept small at both ends by A and B, 18.7); carry the
forecast's covariance (18.6, item 3) or the observation fit's own (the next step: an optional `elements` port on fit
taking the determination from observations as record A's set and covariance); let a `$PCF` set the bound (18.6, item
7); fly the forecast in `sdnap_covariance_at`, `events` or `maneuver`; put a track on the pool; make a fresh record
pass W4 (18.5, #394).

## 19. Frames: Chebyshev cells of AP's own states (a separate product, outside the SGP4-XP specification)

A frame is the state of every object of the store at one instant, served from short Chebyshev polynomials of AP's own states
instead of from AP's flight (`src/frames.inc`). For each AP set it serves the module holds at most two cells, the one that
holds the clock (current) and the one that holds the clock a few minutes later (following): six polynomials (x, y, z, vx,
vy, vz, TEME, km and km/s; three with the position-only flag) over one window of a grid anchored at the set's epoch. A cell is
built from AP's own states of a cold set of the stored record, flown from its epoch toward the window, and checked against
AP at points that are not the points it was built from. A frame reads cells and never flies AP. A time that no held cell
holds answers "no cell": the host asks for it with a refill. The entries are exports, not methods (no configuration port, no
output block); nothing is written to a record, no SDS schema changes, and no cell is read by `sdnap_epochs_at`,
`sdnap_epochs_set_at` or `propagate_epochs`, whose bits are the same with a frame open (`test/frames.e2e.mjs`).

The build to run before the tests: `SDM_MODULE_UNSIGNED_BUILD=1 node build.mjs` in `propagator/sdn-ap`, and `SDNAP_WASM=<that
module.wasm>` for the commands below.

The threading contract: one host thread calls the frames entries, one after the other, and never while a batch of the pool
(`sdnap_epochs_at` over many series, `sdnap_propagate_soa`) runs. The module keeps no lock and no busy flag, and nothing
detects a call made from two threads at once or during a batch. What a pool job for rows must change: the state of the
cells (the table, the slab with its free lists and its compaction, the sweep, the counters), the cell under construction
(`g_cell`), the count of failed allocations that a row reads (`mem::failures`, the instance's and not a thread's), the lazy
tables `drag::table()` makes, the caches the first `xp_init` on a thread makes, the forces a row binds (`ocm::Bind`), and
`Store::short_day`, which `rows_cover` writes. `sdnap_frames_at` reads the cells alone and writes nothing.

### 19.1 Entries

- `sdnap_frames_open(budget_bytes, flags)`: reads the resident store (the sets `load_epochs` or the load in parts installed)
  and allocates one block of exactly `budget_bytes` through the counted allocator (SPEC 1.6): a table of 32 bytes a series
  (padded to 64 bytes), then the slab of cells, the first 64 bytes of it reserved. `flags` 1: position only (19.3). Returns 0,
  or -1 (bad argument), -2 (an allocation failed: `sdnap_frames_stats`[11] holds the bytes asked), -3 (the budget cannot
  hold the table and one cell of the largest size, 3,136 bytes: [11] holds the bytes needed). The block is allocated before
  an earlier open is given back: a refused open leaves the earlier frames, cells included, standing. An open over an open
  raises the instance's high water by up to one block (the memory is reused by later allocations and not returned to the
  host): the 300 MB figure of 19.6 assumes a first open, or a close before the open. What a served object needs is not known at
  open: the host sizes the budget by the rule of 19.6, and a slab too small shows as rows that could not be stored.
- `sdnap_frames_at(jd_whole, jd_frac, first, count, frame, out, status)`: objects `[first, first + count)` at one split
  Julian date (UTC), in the layout of `sdnap_epochs_at`: six planes of `count` doubles (three: x, y, z, when open was given
  the position-only flag; no velocity is written then), frame 0 TEME (km, km/s) or 3 Earth-fixed (m, m/s), one status each:
  0 served; 1 no cell holds this time (a window not attempted: the host calls refill); 2 never served by this entry (19.2);
  3 AP refuses somewhere in the 3-minute window that holds this time (decay, weather rows short), or the set cannot be
  made; 4 no window of 3 minutes holds the tolerance there (19.3). The planes of an object not served are NaN. A pure read:
  it evaluates polynomials, allocates nothing, never flies AP and never falls back silently. On 3 and 4 the host asks AP's own
  entry for that object and time: on 3 it may refuse, or answer for the minutes of the window before the refusal; on 4 it
  answers. Returns 0, -1 (bad argument), -4 (the store generation differs: every status is 1) or -5 (not open).
  Catalog loading releases the frame allocation (section 20); the host opens a fresh budget after loading.
- `sdnap_frames_refill(now_whole, now_frac, ahead_seconds, max_rows, priority, priority_count, result)`: builds the cell
  that `now` needs for each object that has none (the objects of `priority`, in that order, then the others in index
  order), then the cell that `now + ahead_seconds` needs (`ahead` is clamped to 48 minutes, the base window), and stops
  after `max_rows` rows. `priority` holds 0-based series indices of the store, not catalog numbers; an index past the last
  series is skipped; the list holds at most as many entries as there are series. A row is one cold set and one cell, or one
  tombstone (19.3); the module imports no clock (SPEC 9), the host turns rows into time with the table below. `max_rows` is at
  least 1. A sweep is keyed on `ahead`, the priority list (its length and its contents) and the store: a call resumes the
  sweep the one before left when those are the same and `now` is the same, or has advanced since the previous call by at most
  a minute of clock while the sweep is not done (a display that asks with a new time every frame goes on from its place); any
  other call starts a sweep, so a clock that steps by about a window or more at every call restarts the sweep at the first
  place each time and can starve the later places. When pass 0 (the cells `now` needs) ends and the clock has advanced since
  it began, pass 0 runs once more (an object that holds its cell costs a skip), so a sweep slowed by `max_rows` across many
  windows still ends with every object holding the clock of its end. A full fill sliced at any `max_rows` at one clock visits
  each object once for each of the two times; a call at the clock of a finished sweep visits no place, and a call at a new
  clock visits the places of one sweep, two passes over the objects (`idleRefillMs` of `node test/frames-cost.mjs` is its
  cost at 100,000 places). The cells do not depend on the order in which objects are visited, only on the record and the
  window. A cell that holds this call's `now` is never freed. A row that cannot be stored (the slab is full) gets one
  reclaim pass over all objects (the cells that hold neither time of the call go back to the slab) and one retry; if it still
  does not fit, the object is skipped and reported ([4], [6]) and the later objects are still visited. A counted allocation
  that failed ends the call. `result`, 7 int32: [0] places of the sequence left to visit for `now`, [1] for `now + ahead`, [2]
  cells stored, [3] tombstones stored, [4] rows that could not be stored, [5] places visited, [6] the index of the last
  object whose row could not be stored, or -1. The host's loop: continue while [0] or [1] is above 0 and not ([4] above 0 and
  [2] + [3] equal to 0) (the slab or the memory cannot take more; stats[12] counts them). A host judges that a frame is full by
  the statuses of `sdnap_frames_at` (19.9), not by [0] and [1]. Returns 0, or -1 (bad argument: a non-finite time, a negative
  `ahead`, `max_rows` under 1, more priority entries than series), -5 (not open), -6 (the store holds more series than
  open's table: open again). `ahead` is for the shortest window the host expects (3 minutes, `ahead` of 180 seconds): a longer
  one builds a cell for a window that is not the one following the current cell, which is not used when the clock reaches the
  current cell's end and is built again. Frames serve one clock and its look-ahead to an instance: two clocks more than a
  window apart rebuild the cells at every alternation. A refill after a
  load first reads the store again, drops every cell and starts a sweep; it does not check the slab against the new store
  (a load that makes more objects serveable shows as rows that could not be stored). A cell that holds `now + ahead`
  becomes the current cell when the clock reaches it; the cells that hold neither time go back to the slab, after the
  replacement is stored, or before it when the slab is full without them.
- `sdnap_frames_stats(out)`: 20 doubles: [0] objects, [1] objects this entry can serve, [2] cells held (tombstones
  included), [3] slab bytes, [4] slab bytes used, [5] table bytes, [6] bytes of the block as allocated, [7] refill rows, [8]
  rows refused for memory, [9] cells and tombstones placed in the slab (each stored row, whatever it holds), [10] windows halved (each halving, counted once), [11] the bytes asked or needed by the last refused open,
  [12] rows that could not be stored for want of room, [13] rows that ended as a tombstone because AP refused in the window, and rows whose set AP could not make (an object whose set
  cannot be made counts once), [14] rows that ended as a tombstone because the builder failed at 3 minutes, [15] 1 when the store is the one read last, [16] the bytes the cells
  held take (their own sizes), [17] compactions of the slab, [18] bytes they moved, [19] places visited by refills. The slab
  is compacted only when the free bytes and the bump's remainder together hold the cell: a slab full of live cells is not
  compacted for nothing.
- `sdnap_frames_close()`.

What a row costs, to turn rows into time: the median milliseconds of one row (162 AP states: 64 sample points, 96 check
points and the two edges, from a cold set; 834 for a set with the dense check) by the window's distance from the epoch, 0, 2, 5 and 10 days, 20 seeded sets of each class with
epochs spread over a day, machine load 14 to 16 (`node test/frames-cost.mjs --objects 100000 --rounds 10 --skip-wide`, the rows part; the median of 20 rows a cell of the table, the quarter and three-quarter points in the command's output): 500 km 0.63, 0.82, 1.20,
1.66; 830 km 0.59, 0.75, 1.03, 1.66; strong drag (perigee 300 km) 1.28, 3.21, 5.63, 9.07; eccentricity 0.015 to 0.045 11.4,
11.4, 11.6, 11.9 (a quarter of the rows cost under 1.6 ms: the tesseral degree follows the eccentricity); medium 0.20, 0.23,
0.27, 0.35; geosynchronous 0.22, 0.79, 1.28, 2.64. The 95th percentile is 1.0 to 2.7
times the median in low orbit and 12.8 ms at the largest. The cost grows with the distance because a cold set integrates its
nodes from the epoch: a record 10 days old costs 2 to 12 times the first window of its day. The most a row can cost is five
builds (the window halved four times, each failing at its check) of 160 states each, 800 AP states and one cold set; AP
refusing in a window ends a build at its first refused state. Two rows of twenty halved in strong drag at 10 days.

### 19.2 What is served

An object is served by this entry when it is an AP set alone in its series (one set), without a carried forecast (SPEC 18)
and without a hand-over, with gravity terms in its forces and not on the wide branch (the first-order tesseral families on a
grid in E: eccentricity above 0.05 in resonance class 0, above 0.3 in the others; SPEC 16: sets of one, two and three
revolutions a day are served up to 0.3, and the test's population holds them). Every other object answers
status 2, and the host asks AP's own entries for it: SGP4 and stock SGP4XP sets, series of several sets, sets with a forecast
or a hand-over, wide sets. Of the stored synthetic set of the fits (spread over the whole orbit regime on purpose) the entry
serves 47 %: 445 of 942 records, 497 are wide. Of a public catalog of 2026-11-12 (32,916 objects with a current set; counted from that catalog, no command of this repository
reads it) 92.1 % are
at eccentricity 0.05 or under: 80.3 % under 0.01, 11.8 % from 0.01 to 0.05, 2.6 % from 0.05 to 0.25, 5.3 % at or above 0.25;
by orbit 45.6 % near-circular with perigee under 600 km, 39.6 % at 600 to 2,000 km, 1.6 % medium, 5.3 % geosynchronous and
above, 7.9 % eccentric.

### 19.3 The grid, the cell and the build

Time is minutes from the record's epoch, formed from the split Julian date as AP's flight forms it:
`((jd_whole - epoch_whole) + (jd_frac - epoch_frac)) * 1440`. The grid: windows `[48 k, 48 (k + 1))` minutes, halved on
demand to 24, 12, 6 and 3 minutes. A row builds the cell of the window that holds the time asked, from a cold set made from
the stored record under its own forces, never kept and never in the pool of caches (its caches are the thread's), released
inside the row. For a window:

1. AP's position and velocity at 64 Chebyshev points of the window from the one cold set: ascending in time for a window
   after the epoch, descending for a window before it (the windows never straddle the epoch: the grid is anchored on it), so
   the set is flown from the epoch toward the window. A time before the epoch is served like a time after it.
2. The discrete cosine transform of the six series; the shortest truncation (position: one count for the three axes;
   velocity: one count) whose dropped tail, summed in magnitude, is under 0.6 of the tolerance (3 mm, 3e-5 m/s).
3. The cell: a head in doubles and a tail in float32, the tail starting where the sum of the remaining coefficients'
   magnitudes times 6e-8 stays under 3e-5 m in position (3e-7 m/s in velocity); the builder sums the tail's rounding and keeps
   a group in doubles if that sum is not under the limit.
4. The check of the stored cell, tail included, against AP at points of the window that are not the 64, and at its first
   instant and its last (a minute-millionth before the end: the window ends where the next begins, and a UTC midnight can be
   the end of the weather rows), the first window after the epoch at t = 0 exactly. The two edges are asked of the set before
   the 64 points and after them (the nearer to the epoch first), not among the checks. At every point of every set the cell
   passes when each axis is within 5 mm and the 3-D distance within 8 mm, and in velocity each axis within 5e-5 m/s and the
   3-D distance within 8e-5 m/s. A set whose output steps (19.5) has 768 points, the others 96; which sets those are is a
   function of the record: the mean perigee height under a line of 500 km at BTERM 0.01 m^2/kg, moving 80 km for each
   decade of BTERM (to 660 km at BTERM 1, down to 300 km at the lowest), from mean motion, eccentricity and BTERM. The 768
   points are a uniform grid offset from the 96-point grid, not a superset of it; the two edge points cover the outer 2 %
   of a window. A window that fails the check, or in which AP refuses a state at any point
   (the set decayed, the weather rows short), is halved, and the half that holds the time is built the same way, down to 3
   minutes. A window of 3 minutes that still fails is stored as a tombstone: a header-only cell for exactly that window
   with its reason, status 3 (AP refuses in it) or 4 (the tolerance is not held in it). A time in a tombstone answers its
   status; a time elsewhere is unaffected, before the epoch or after, and a refill does not rebuild a window that holds a
   tombstone. A set that cannot be made at all (its initialization refuses) answers status 3 at every time. The two kinds of
   tombstone are counted apart (stats[13], [14]). A window that holds the end of the weather rows, or AP's decay, is
   refused whole at 3 minutes: the minutes of it before the refusal, which AP serves, answer 3.

A status is a function of the record and the time once the window that holds the time has been attempted; a window not
attempted answers 1. The cell, or the tombstone, that a window holds does not depend on which windows were attempted before.

A cell is 24 bytes of header (mid and half-span in minutes, the counts, the holder) and 8 bytes a coefficient in the head, 4
in the tail, held in classes of 64 bytes; a tombstone is the header alone. With the position-only flag the velocity is built
and checked and not stored, and `sdnap_frames_at` writes three planes and no velocity, because AP's velocity is not the
derivative of its position (no command of this repository prints their difference) and no derivative is offered as a
velocity. A host that needs velocity opens without the flag. Both modes halve alike, and the positions are the same bits with
and without it. A halved window is built on the set that has already flown its parent windows, always on one side of the
epoch; the kinds of the test that halve are among those compared with fresh asks.

### 19.4 A state depends on the set and the time alone

The grid is a function of the record's epoch and the split decisions are a function of AP's states, so two instances with
different refill histories (priority order, cadence, a jump of the clock, the times before the epoch asked first or last)
return the same bits and the same status for an object and a time (`test/frames.e2e.mjs`, compared with `Object.is`). Each
row builds from a cold set flown from the epoch toward the window: the order of the flight is the one that is right on
every build, a window lying on one side of the epoch and no row's flight crossing the epoch within one set. A refill changes
no bit of `sdnap_epochs_at`, `sdnap_epochs_set_at` or `propagate_epochs` (the test asks the store before the first refill
and after the last, in the same order, in a threaded instance too), and the store asked between the refills at other
times, earlier ones after later ones, leaves the cells bit-identical to a clean instance's.

### 19.5 The bound, and what gets worse

What it means for a host: a served state is within 1 cm (3-D) and 1e-4 m/s (3-D) of AP's state for that record and time,
asked of a fresh instance the way the builder asks it (a cold set, flown toward the time from the epoch). That holds in every
class, strong drag and decay included. A window that cannot meet it is not served: a tombstone, status 4 (or 3 where AP
refuses in it), and the host asks AP's own entries for those times. The cell is a function of the record and the window, so
the reference is a fresh instance's AP state, which no order of earlier asks moves.

The builder checks every window against that reference, with both limits of 19.3 at every point and at the window's two ends.
The error between check points is not bounded by construction: the 1 cm is what a scan every second shows (every 17 s at -1,
2 and 10 days, and against fresh instances at every 61st second), on the tests' populations, not a proof. Why some sets get
the 768-point check: AP's own output steps. A dense scan of AP's states every 0.25 s (`node test/frames-steps.mjs --table all`,
seeded sets, two hours at 2 days from the epoch, 2 sets a row, 4 hours in all) finds jumps at constant intervals, and they
follow the perigee height and BTERM. Steps an hour and the largest step in mm (velocity: largest in 1e-5 m/s), at BTERM
0.01 m^2/kg: 200 km 21, 33.7 (3.4); 250 km 38, 7.2 (0.8); 300 km 6.8, 6.9; 350 km 2.5, 6.4; 400 km 1.0, 6.8; 450 km 0.3, 2.1;
none at 500 km and above, none at e 0.03 (perigees 500 to 800 km). At 450 km: none at BTERM 0.001, 5.8 an hour (6.1 mm) at
0.1, 20 an hour (18.2 mm) at 1. At 500 km: none at 0.001, 2.8 an hour (5.4 mm) at 0.1, 45 an hour (7.5 mm) at 1. At 520 km:
1.3 an hour (8.3 mm) at 0.1, 26 an hour (5.7 mm) at 1. At 560 km: 1 an hour (4.5 mm) at 0.1, 12 an hour (5.7 mm) at 1. At
600 km: 0.5 an hour at 0.1, 8 an hour (5.6 mm) at 1. At 650 km: 0.5 an hour at 0.1, 3 an hour (5.1 mm) at 1. Velocity steps
are at most 3.4e-5 m/s at 200 km and 1.8e-5 m/s above. The gaps are the spacing of the set's nodes (4 pi / n) divided by a
whole number: the steps fall on the part boundaries of a bracket, where AP's baked coefficients change. A step of 10 mm
inside a window leaves a polynomial about half of it from AP on each side, and a window that holds one cannot meet 8 mm
unless the step is small: it is halved to 3 minutes and then tombstoned. So the dense line is a function of BTERM: 500 km at
0.01, 580 km at 0.1, 660 km at 1, down to 300 km at 0.001 (the table has no steps at 450 to 650 km there).
Measured by `node test/frames.e2e.mjs` (34 seeded objects, inclinations 0.3 to 140 degrees, eccentricity to 0.05,
resonance classes to 0.2, BTERM 0.01, 0.1 and 1, epochs spread over a day, a set AP refuses; every second at 0 and 5 days
from the epoch, every 17 s at -1, 2 and 10 days; 5.3 million served points, of which 163,911 against a fresh instance's AP
state): worst position 6.4 mm (3-D) in any class, 6.4 mm and 6.0 mm in strong drag (perigees of 300 and 250 km), 6.1 mm in
the decaying sets; worst velocity 4.5e-5 m/s. The cost in served time, over the same scan: perigee 300 km 99.96 % of the
scanned times served, 250 km 94.5 % (the rest is tombstones of status 4), 490 km at BTERM 0.01, 520 km at 0.1 and 560 km at
1: 100 %; 500 km and above 100 %; the decaying sets 6.2 % (they decay inside the scan, and the windows in the last hours that
cannot meet the line are tombstones); the set with weather rows from the day before its epoch 97.2 % (day -1 is refused by
AP).
What gets worse:

- A frame state differs from AP's by up to the bound above. Two kinds of state exist for an object (AP's, from
  `sdnap_epochs_at`; the cell's, from `sdnap_frames_at`): they differ by up to that bound.
- A first fill, and a jump of the clock, cost seconds during which objects answer 1 (no cell): 100,000 objects of the recipe's mix
  fill in 120 s on one thread when their records are at the epoch (163 s at 2 days, 224 s at 5 days, 323 s at 10 days): the mix of the
  rows of 19.1, `node test/frames-cost.mjs --objects 100000 --rounds 10 --skip-wide`, load 14 to 16. The eccentric sets cost
  11 to 12 ms a row from eccentricity 0.03 with tesseral degree 31 (1 to 4 ms below it at 800 km): the cost is the set's
  initialization, the same at the epoch and at 2 days, and follows the tesseral degree (0.06 ms at degree 0, 0.43 at 8, 12 at
  31, 21 at 70 at e 0.03; `node test/frames-init.mjs`). On a catalog whose objects between e 0.01 and 0.05 are spread evenly
  (11.8 % of the public catalog's), 5.9 % lie above 0.03 and add about 0.7 ms an object, 70 s to a first fill of 100,000.
- Objects that the entry does not serve (19.2) are asked of AP's entries, and so are the times a tombstone holds.
- Memory per served object: 19.6. Refill CPU: a served object needs 1.25 rows an hour (windows of 48 minutes); with the
  rows of 19.1 and the recipe's mix that is 150, 204, 280 and 403 core seconds an hour for 100,000 objects whose records are 0, 2, 5 and 10 days old
  (4 to 11 % of one core; the same command).
- A wide set flown through `sdnap_epochs_set_at` in the same instance holds about 10 MB (a grid in E, SPEC 16.11) for the
  life of the instance: 20 wide sets grew the instance by 210 MB. The byte bounds of 19.6 hold while wide objects are not
  flown in the instance. A refill row's time is the same before and after (0.84 ms median both). `node test/frames-cost.mjs
  --skip-frame --skip-rows`.

### 19.6 Memory

One block, allocated at open, counted, of exactly the budget given: the table (32 bytes a series, padded to 64, 3.2 MB at
100,000) and the slab. The host's rule for the budget: 850 bytes for each object served, 32 bytes for each series and 1 MiB.
Measured by `node test/frames-memory.e2e.mjs` (about 7 minutes, 3 GB of the host's memory; it asserts that the slab holds at most 850 bytes for each object served, that no row is refused, that every served object is served, and that the instance total is under 300 MB decimal with and without a pool; the other figures below are printed)
at 100,000 objects, seeded sets with epochs spread over one window, loaded in parts of 1,000, filled at one instant, then the
windows turned over (48 minutes in steps of one):

| catalog | served | cells at a full fill | slab used, full fill | slab used, after the turn | bytes an object served | cells' own bytes | classes of 64 bytes and free cells |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| the load probe's recipe (85 % low near-circular, 5 % medium, 5 % geosynchronous, 5 % eccentric below 0.05) | 100,000 | 106,340 | 82.7 MB | 84.2 MB | 842 | 79.9 MB | 5.1 % |
| the public catalog's shares (92.1 % with eccentricity at or under 0.05, served; the rest wide) | 92,100 | 97,943 | 75.4 MB | 76.4 MB | 829 | 72.8 MB | 4.7 % |

The cells at a full fill exceed the objects by 6.3 % on the recipe: the cells of the following window, built 3 minutes ahead,
the epochs being spread. A catalog whose epochs are not spread holds two cells for every object during those 3 minutes.
The instance total is the module's bytes plus what the host does. The stored 100,000-set load with covariance holds
180,486,144 bytes with 15 pool threads (the figure of the load probe of `test/load-memory.e2e.mjs`). Three host rules keep the
instance under the total stated here: (1) start the instance at 2 MiB (a browser harness's default of 64 MiB cost 65.0 MB: the
heap grows beside the initial pages it does not use); (2) load in parts of at most 1,000 records and free the staging buffer
(`plugin_free`) after `load_epochs_close` and before allocating the planes and status buffers of the frame (4.78 MB; parts of
5,000 records cost 20 MB more); (3) start no pool, or count 2.5 MB an instance for each thread (`node
test/frames-memory.e2e.mjs` prints it: 15 threads, 37.7 MB). With the rules and this block: the recipe's instance holds 269.7
MB with 15 pool threads (180.5 + 89.2 block, 0 growth) and 232.0 MB without a pool; the public shares 263.0 and 225.3 MB; a
browser tab following the rules measured 239.7 MB without a pool for 100,000 AP records with covariance, and 272.8 MB at
open with 15 threads. The test asserts both totals under 300 MB decimal. The host's own output planes of a frame (5.2 MB at
100,000 objects) are inside the instance and counted. What the instance holds besides the block: the first row on a thread
makes that thread's caches (SPEC 9: 1.8 MB, once, kept); a fill grew the instance by no more than 4 MiB in the test, 0 at
100,000. After a load the instance holds 33 to 38 MB more than the store's own count: the load's high-water (staging and the
decoding of a part), which the memory does not give back to the host. Later allocations reuse it, a block larger than any
hole in it does not: the 89 MB frame block grows the instance by its full size (open minus load equals the block), and the
rows' cold sets, the thread's caches and a refill's allocations land in the load's holes and grow it by 0. The instance's
memory does not shrink: the bound holds while no wide object is flown in the instance (19.5), and a look-ahead of two cells an
object (19.9) adds 80 to 90 MB (329 MB measured in a browser tab without a pool, 29 MB over the line). A slab that fragments (cells that change size) is compacted when its bump fails: the live cells slide down
over the free ones and each holder's offset is rewritten (82.7 MB moved for a 100,000-object recipe slab sized 0.4 % above its full fill, six times in 50 minutes of one-minute
calls: the calls that compacted took 1.66 to 2.12 s, those that did not 1.69 to 2.16 s, for about 2,100 rows each, so a
compaction's own time is below the spread of a call's); a row is not stored only when the slab is full after that.

### 19.7 Cost

A frame of 100,000 objects through `sdnap_frames_at` against the same through the module's SGP4 (`sdnap_epochs_at` on SGP4
records), position and velocity, the recipe's mix, process CPU, 10 rounds in one process, the four kinds in the order A B C D
and then D C B A by round (`node test/frames-cost.mjs --objects 100000 --rounds 10 --skip-wide`; load 14.3 at the start, 15.5 at
the end, 1-minute averages): TEME 0.0666 microseconds a state against 0.2604 for SGP4, a ratio of 0.259 (the middle half of the
rounds' ratios 0.255 to 0.260, within 2 % of the median); Earth-fixed 0.0699 against 0.2806, 0.249 (0.248 to 0.250; the rotation's
sine and cosine are taken once for the call). 99,998 of the 100,000 objects were served in the timed frame (the other two hold a
tombstone). A refill that finds nothing to do, at 100,000 places: 4.84 ms (the same command, `idleRefillMs`). Ratios are what to
read.

### 19.8 Tests

`node test/frames.e2e.mjs` (about 13 minutes at load 14 to 16): the bound against AP asked of a fresh instance (every class), over a day at -1, 0, 2, 5 and 10 days, with counts so that a run that
serves nothing fails; a status the same whatever the order of the windows asked (a refusal before the epoch does not reach
the times after it); wide sets, series of several sets, stock sets, hand-over records and records with a forecast answer 2 and
the store's exports (every set) are unchanged by refills; purity from two fill orders, the store's exports unchanged and a
threaded instance; every status; the budget refused by name and a refused open leaving the earlier frames standing; a
compacted slab sized to the figure of an unconstrained run that never refuses a row; a refill sliced at 8 rows storing the
bits of one at 5,000 and visiting each object once; the position-only mode; a build whose tolerance cannot be held (status
4); every counted allocation of open and of a refill row failed in turn (the object keeps no cell, the slab is as it was,
and the same call then answers with the bits of a clean run). `node test/frames-memory.e2e.mjs`: the bytes at 100,000
objects. `node test/frames-cost.mjs`: 19.1's rows, 19.7's frame ratios and 19.5's residue of wide sets. `node test/frames-steps.mjs`: 19.5's step tables. `node test/frames-init.mjs`: the cost of a cold set by eccentricity.

### 19.9 Driving a clock

What a host that draws frames from a running clock needs, and what it gets.

- **The rate.** Every object needs one cell for each window the clock crosses. Rows a second = served objects / (a window's
  length divided by the clock's speed): a window is 48 minutes of clock, 2,880 s, so 100,000 objects need 35 rows a second at
  1x, 347 at 10x and 2,083 at 60x (a window at 60x lasts 48 s of wall time). One thread stores about 1 ms a row in low orbit
  at the epoch's distance of 0 to 2 days (the table of 19.1; about 480 objects a second were stored in a browser tab), so one
  thread keeps up to about the speed at which its rows a second equal that need, and the first calls on a cold instance cost
  more than the later ones (2.5 ms a row against 1.16 in the tab): a slice sized from the first calls is too small, size
  `max_rows` from the running mean of the rows' time. Beyond that speed the cells of the turn arrive late and objects answer 1
  (no cell) until the rows catch up; a host that cannot catch up at its speed shows the status counts, it does not wait.
- **The look-ahead and the budget.** `ahead` is clock time, at most 48 minutes. With epochs spread over a window, the share
  of objects that hold two cells is `ahead` / 48 minutes: 6.3 % at 3 minutes, 10 % at 5 minutes, all of them at 48 minutes. The
  850 bytes an object of 19.6 holds for a look-ahead of a few minutes; a look-ahead of two cells an object doubles the block
  (80 to 90 MB at 100,000 objects). A look-ahead that is short in wall time at speed (3 minutes of clock is 3 s at 60x) leaves
  the rows no time: the host sizes `ahead` as the rows' time at its speed, and pays for it in the budget. A browser tab
  (one thread, 100,000 objects, the budget doubled and a look-ahead of 48 minutes, no command in this repository) measured:
  at 10x the share of objects without a cell fell to 5 % on average (30 % at the first window turn) and recovered; at 60x it
  did not keep up (77 % without a cell). With two cells an object, a covariance-bearing 100,000-object catalog under the three
  host rules of 19.6 made an instance of 329 MB, 29 MB over the 300 MB line: the line holds with a look-ahead of minutes, not
  of a whole window.
- **The live clock every frame.** A sweep that is not done goes on from its place when `now` has advanced by at most a minute of
  clock since the last call (measured in clock time: 16 ms of wall time at 60x is under a second). A host whose frames
  advance by more than a minute of clock (above 3,600x at 60 frames a second) starts a sweep at every call and scans the
  objects each time. A finished sweep starts a new one at the next new `now`.
- **Is it filled?** The counters [0] and [1] of the result count the places a sweep has left; they read 0 between sweeps while
  the clock has moved on and the next window's cells are not yet built. A host judges whether the frame is full by the
  statuses `sdnap_frames_at` returns (the objects that answer 1), and uses the counters for the loop of 19.1 only.

## References

- Payne, T., Hoots, F., Butkus, A., Slatton, Z., and Nguyen, D. (2022).
  [Improvements to the SGP4 Propagator (SGP4-XP)](https://amostech.com/TechnicalPapers/2022/Astrodynamics/Payne_2.pdf).
  Advanced Maui Optical and Space Surveillance Technologies Conference (AMOS).

- Brouwer, D. (1959). Solution of the problem of artificial satellite theory without drag. AJ 64, 378-397.
- Lyddane, R. H. (1963). Small eccentricities or inclinations in the Brouwer theory of the artificial satellite.
  AJ 68, 555-558.
- Hoots, F. R., Roehrich, R. L. (1980). Models for propagation of NORAD element sets. Spacetrack Report No. 3.
- Hujsak, R. S. (1979). A restricted four body solution for resonating satellites without drag. Project Space
  Track Report No. 1.
- Vallado, D. A., Crawford, P., Hujsak, R., Kelso, T. S. (2006). Revisiting Spacetrack Report #3. AIAA 2006-6753.
- Jacchia, L. G. (1970). New static models of the thermosphere and exosphere with empirical temperature profiles.
  SAO Special Report 313 (Table 5, pp. 52-81; Table 6, "Summary of log densities", pp. 82-87).
- Jacchia, L. G. (1971). Revised static models of the thermosphere and exosphere with empirical temperature
  profiles. SAO Special Report 332.
- U.S. Standard Atmosphere, 1976. NOAA/NASA/USAF, Washington.
- Pavlis, N. K., Holmes, S. A., Kenyon, S. C. and Factor, J. K. (2012). The development and evaluation of the Earth
  Gravitational Model 2008 (EGM2008). Journal of Geophysical Research 117, B04406.
- Lemoine, F. G. et al. (1998). The development of the joint NASA GSFC and NIMA geopotential model EGM96.
  NASA/TP-1998-206861.
- Broucke, R. A., Cefola, P. J. (1972). On the equinoctial orbit elements. Celestial Mechanics 5, 303-310.
- Cefola, P. J. (1972). Equinoctial orbit elements: application to artificial satellite orbits. AIAA 72-937.
- Danielson, D. A., Sagovac, C. P., Neta, B., Early, L. W. (1995). Semianalytic satellite theory. NPS-MA-95-002.
- Kozai, Y. (1959). On the effects of the Sun and the Moon upon the motion of a close Earth satellite. SAO Special
  Report 22. Kozai, Y. (1961). Effects of solar radiation pressure on the motion of an artificial satellite. SAO
  Special Report 56.
- Giacaglia, G. E. O. (1973). Lunar perturbations of artificial satellites of the Earth. SAO Special Report 352.
- Aksnes, K. (1976). Short-period and long-period perturbations of a spherical satellite due to direct solar
  radiation. Celestial Mechanics 13, 89-104.
- Kaula, W. M. (1966). Theory of Satellite Geodesy. Blaisdell.
- Abramowitz, M., Stegun, I. A. (1964). Handbook of Mathematical Functions, table 25.4 (Gauss-Legendre).
- Escobal, P. R. (1965). Methods of Orbit Determination. Wiley (shadow function, section 5.3).
- Picone, J. M., Hedin, A. E., Drob, D. P., Aikin, A. C. (2002). NRLMSISE-00 empirical model of the atmosphere:
  statistical comparisons and scientific issues. JGR 107(A12), 1468.
- Montenbruck, O., Gill, E. (2000). Satellite Orbits. Springer.
- The Astronomical Almanac, section C (Sun) and D (Moon), low-precision formulas.
- Park, R. S., Folkner, W. M., Williams, J. G., Boggs, D. H. (2021). The JPL planetary and lunar ephemerides DE440 and
  DE441. AJ 161, 105.
- Petit, G., Luzum, B., eds. (2010). IERS Conventions (2010). IERS Technical Note 36, chapter 5 (eq. 5.43 and 5.44,
  Table 5.3a). Simon, J. L., Bretagnon, P., Chapront, J., Chapront-Touzé, M., Francou, G., Laskar, J. (1994). Numerical
  expressions for precession formulae and mean elements for the Moon and the planets. A&A 282, 663-683.
- Capitaine, N., Wallace, P. T., Chapront, J. (2003). Expressions for IAU 2000 precession quantities. A&A 412, 567-586.
  McCarthy, D. D., Luzum, B. J. (2003). An abridged model of the precession-nutation of the celestial pole. Celestial
  Mechanics and Dynamical Astronomy 85, 37-49.
- Chapront-Touzé, M., Chapront, J. (1983). The lunar ephemeris ELP 2000. A&A 124, 50-62 (the source of Meeus's A2 and A3).
- Meeus, J. (1998). Astronomical Algorithms, 2nd ed., chapters 25 and 47. Brouwer, D., Clemence, G. M. (1961). Methods of
  Celestial Mechanics. Montenbruck, O., Pfleger, T. (2000). Astronomy on the Personal Computer, 4th ed., chapter 3.
- Seidelmann, P. K., ed. (1992). Explanatory Supplement to the Astronomical Almanac.
- US Space Force Astrodynamics Standards: release notes 7.7-9.9, JIRA summaries 8.2-9.9, Tle and Sgp4Prop
  interface documents (9.9 package); release notes v9.1.1.0 C Sgp4Prop WebAssembly.

## 20. Record entities through the propagator ABI

**Tradeoffs.** An AP entity without a covering frame cell is hidden: its position and velocity are NaN and its
VALID flag is clear. Unsupported AP series, including multiple-set and wide-branch series, have no display state through
these calls. Their direct paths remain available. AP singleton and struct-batch states use the frame approximation of
section 19, including its existing position and velocity bounds. SGP4 and SGP4XP records use their own exact epoch
propagation without AP cells or AP caches. Each direct display read releases its entity slots before reading another
entity, bounding transient direct storage to at most two initialized sets. Repeated frames pay initialization again.
Loading a catalog releases the previous frame allocation and all its cells;
the host opens and refills a new budget. One owning thread serializes load, refill, reads, paths and replacement, so a
refill can delay a display update. Direct path requests allocate theory caches temporarily and release the path entity's
caches on completion. These changes add no concurrent-reader guarantee or implicit refill.

**20.1 Source and indices.** The row and record stores coexist. Plugin calls select rows after a successful
`plugin_init_omm` (including count 0, which selects empty rows), or records after a successful `load_epochs` or
`load_epochs_close`. `load_epochs_open` and parts stage the replacement while the previous source stays readable.
Every refused load or refused `plugin_init_omm` preserves the active source and its states. A successful record load
releases the previous record snapshot and frames, preserving rows. A successful `plugin_init_omm` preserves records,
frames and any open load; its 88-byte record interpretation and numerical propagation are unchanged.
`ingest_omm` and `sdnap_init_elements` replace native rows without changing the plugin selection: with records selected,
plugin calls continue answering records and the native row exports answer the new rows. With rows selected, they answer
the new rows. Pending and resident catalogs coexist during replacement, increasing peak memory by the pending catalog.

A record entity is one epoch series, identified by the existing identity tuple in section 14. Multiple retained epochs
share one entity and the epoch API's selection/blending rules. Plugin indices follow the first accepted input occurrence
of each surviving series, across arbitrary part boundaries. Duplicate replacement, aging and set caps do not reorder a
surviving series. Filtered series have no index. Raw `sdnap_epochs_*` and `sdnap_frames_*` indices retain their sorted
series order. The additional resident map costs four bytes per entity, included in epoch-store byte accounting. Frame
refill priorities use raw series indices, not plugin indices.

**20.2 State and catalog calls.** All dates below are UTC Julian dates. Output pointers reference caller-owned module
memory; the caller allocates the complete output size, refreshes its views after memory growth, and frees its buffers.

```c
int32_t plugin_entity_count(void);
int32_t plugin_propagate(double jd, uint32_t entity, OrbProStateVector* out);
int32_t plugin_propagate_batch(double jd, OrbProStateVector* out, uint32_t count);
int32_t plugin_propagate_all_positions(double jd, double* out, uint32_t max);
```

A state occupies 64 bytes: epoch at byte 0, position at 8 (three doubles, ECEF meters), velocity at 32 (three doubles,
ECEF meters/second), frame 3 at byte 56, zero padding at 57–59, and flags at 60 (VALID bit 0). Every processed record slot
has the requested epoch and frame, including a missing slot. A successful singleton returns 0. Structural errors are -1
(no initialized entities), -2 (index/count outside the source), -3 (null output), and -4 (nonfinite date). AP missing,
unsupported or position-only cells return -8 for a full state; AP refusal/builder failure and direct theory failure
return -6. A failed epoch thread pool also yields -6 without reading its caches.

In record mode, the struct batch returns 0 after filling all requested slots, even when some slots are invalid. Its
structural errors are negative. In row mode it retains the first propagation error, as the original ABI does. AP struct
calls require `sdnap_frames_open` flags 0, which stores velocities. No zero velocity is substituted for an absent one.

The catalog call writes `min(entity_count,max)` interleaved x/y/z triples and returns that count, including missing
entities. Three NaNs occupy each failed entity's slot; output order is never compressed. Empty sources and max 0 return
0 without writing. Nonempty calls reject a null output with -3 or a nonfinite date with -4. Position-only cells are valid
for this positions-only call. The row source uses its existing evaluator and also writes NaN for failed positions.
Neither a singleton, a struct batch, nor a catalog call constructs AP cells or falls back to exact AP automatically.

**20.3 Paths and metadata.**

```c
int32_t plugin_propagate_path(uint32_t entity, double start_jd,
                              double step_days, uint32_t count, double* out);
double get_orbital_period(uint32_t entity); // minutes
double get_eccentricity(uint32_t entity);
```

A path samples `start_jd + i*step_days`, writes one ECEF-meter triple per sample and returns count. Zero and negative
steps are accepted. The cap is 1,000,000 samples (24,000,000 output bytes); counts that overflow 32-bit output
arithmetic are refused. Every sample time is checked for finiteness before any output write. Count 0 returns 0 without accessing the source or output. Otherwise null output is -3, empty source
-1, invalid entity -2, nonfinite grid/endpoint or count above INT32_MAX -4, and a failed epoch thread pool -6. Individual
failed samples are NaN triples. Record paths use the direct epoch evaluator, including selection, blends and carried
forecast precedence; they do not use frame cells. On return, only that entity's direct slots are released; its frame
cells remain intact. Row paths use the row evaluator.

Record sampling hints come from the newest retained set: period is 1440 divided by mean motion in revolutions/day,
eccentricity is the mean-element value. Row hints use the initialized mean motion (recovered mean motion for SGP4) and
epoch eccentricity. Missing period is 0 and missing eccentricity is NaN. These are sampling hints, not an assertion of
exact periodicity under perturbations.

**20.4 Replacement and ownership.** Stream method `replace_epoch` accepts exactly one `ocm` record using the same
binary invoke and size-prefixed framing as `load_epochs`. A closed, nonempty record source is required. The complete
series identity and theory must already exist, and the target must hold exactly one set. Preparation validates the
record, retains any carried forecast and interns its atmosphere before committing. The plugin index and raw series
index are preserved. Commit releases only the target's direct slots, covariance and two frame cells; other entities'
cells and caches remain usable. The target's frame eligibility and epoch are refreshed, and a refill sweep restarts.
There is no global-generation invalidation. Replacement does not reapply snapshot aging/capping or change ingestion
counts. Old weather with no remaining reference is released.

Success is stream status 0. Refusals use status 3 with `records-not-loaded`, `replace-one-record`,
`replace-identity-missing`, `replace-multiple-sets`, `pool-dead`, an existing record-validation error, or `out-of-memory`.
Every refusal preserves the old record and cells. There is no append or identity-changing update in this method.

`plugin_destroy` releases both stores, an open load, the map and frames. Caller-owned output allocations remain the
caller's responsibility. The host quiesces its calls before destruction. If a failed epoch batch still has an active
thread, destruction is a no-op and OMM initialization is refused, preventing a free while that thread holds a reference.

The owning thread can publish two host buffers with atomic generation/timestamp metadata and acknowledgment before
reuse. That protocol belongs to the host. These exports require serialized calls on the owning thread and provide no
concurrent-read publication gate. A previous-time buffer is not relabeled as the requested time.

`test/plugin-records.e2e.mjs` checks mixed synthetic sources, input order, holes, layouts, direct paths, metadata,
replacement and lifecycle. `SDNAP_CONTROL_WASM` adds byte comparisons with an unchanged artifact. Diagnostic allocator
exports enable replacement-refusal and cache-release assertions. The test is an ABI comparison, not an independent
physics calibration.
