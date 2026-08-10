# Maneuver vector provenance

`vectors.json` is the frozen expectation set for `analysis/maneuver`. This file
records where every number in it came from, and — where a claim could not be
verified — says so instead of rounding until it looks verified.

The file is **generated**. `node vectors/tools/build-vectors.mjs --check` fails
if the committed file drifts from its generators, so a hand-edited vector cannot
survive a CI run.

## Conformance model (PINNED)

Two-body point-mass, impulsive burns, `mu = 3.986004418e14 m^3/s^2`,
`Re = 6378137 m` (WGS-84). SI throughout — metres, m/s, seconds, radians.
Sources are km-native; conversion happens **once**, at emit time, inside the
generator. Anything above this fidelity (J2, drag, finite burns) is kill
criterion K2 of `saw-beta-maneuver-program`: stop and re-scope.

## Tolerance policy

```
fail  <=>  |observed - expected|  >  abs + rel * |expected|
```

Both terms are always present. `abs` carries the case near zero, where a
relative band either divides by zero or passes everything; `rel` carries it at
scale. Bands are chosen **per physical quantity**, not per case — see
`BANDS` in `vectors/index.mjs`. Non-finite observations fail as their own kind:
a `NaN` makes every inequality false, so a naive `if (error > budget) fail`
would *pass* it.

The runner prints the worst row's budget usage **on pass as well as on fail**.
A green run that says nothing hides the approach to the cliff.

---

## Tier A — Tudat's own Lambert vectors (foreign authority)

**Extractor:** `vectors/tools/dump-tudat-vectors.mjs`
**Source:** `tests/test_tudat/src/astro/mission_segments/unitTestLambertTargeterIzzo.cpp`
**Raw extraction (audit trail, committed):** `vectors/tudat-extract.json`

Tudat is consulted as an **oracle**. The dumper reads `.cpp` *text*. Tudat is
never compiled, never linked, and is not a dependency of any build in this repo.
Regenerating needs a checkout; consuming the vectors does not.

### What "mechanical" means here, precisely

| Kind | Provenance |
| --- | --- |
| Every numeric literal, arithmetic expression, `Eigen::Vector3d` triple, and stated tolerance | Parsed and evaluated out of the Tudat source by the dumper. No value is retyped. |
| `ASTRONOMICAL_UNIT`, `JULIAN_DAY`, `PI` | Read out of Tudat's own `physicalConstants.h` / `mathematicalConstants.h`. Hardcoding `149597870700.0` here would have silently rescaled every position in the tier. |
| Which extracted symbol plays which role | `CASE_BINDINGS` in the dumper. Hand-written **metadata**; contains no numbers. One glance against the named source line reviews it. |

`PI` is defined twice in Tudat behind an `#ifdef M_PI`. The reader evaluates
every branch it can parse and **requires them to agree bit-for-bit**, then
asserts the result is the IEEE-754 `Math.PI`, so the degree conversion cannot
differ from the C++ one by ULPs.

### Rows

| id | Geometry | Reference precision | Source's own tolerance |
| --- | --- | --- | --- |
| `tudat-izzo-hyperbolic` | Hyperbolic Earth-centred, 100-day ToF | 5 s.f. | `1e-4` fractional |
| `tudat-izzo-elliptical` | 120-degree transfer, Earth canonical units | 6 s.f. | `1e-2` fractional |
| `tudat-izzo-retrograde` | **Retrograde** heliocentric Earth-Mars, 300 days | **15 s.f.** | `1e-9` |
| `tudat-izzo-near-pi` | 179.999-degree transfer — the Lambert singularity | 15 s.f. | `1e-6` |

Tudat's own notes name the upstream references: the hyperbolic case from
Noomen's Lambert-targeter spreadsheet, the elliptical case from Mengali &
Quarta *Fondamenti di Meccanica del volo Spaziale* Example 6.1 (pp. 159–162),
and the retrograde/near-pi cases from ESA/ACT's `Keplerian_Toolbox`. Those
attributions are quoted from the Tudat source, not independently checked
against the works themselves.

`tudat-izzo-near-pi` states its positions as circular equatorial Keplerian
elements. The dumper converts them with the closed form for `e=0, i=0,
raan=0, argp=0` — `r = a * (cos(nu), sin(nu), 0)` — which is exact for that
element set, and it **asserts** the element set rather than assuming it.

### Gate and regression watermark

- **Gate:** `rel = max(source tolerance, 1e-6)`. Nothing tighter than the
  reference's *printed* precision can honestly be asserted; nothing looser than
  what the source itself demanded should be accepted. A correct
  universal-variable Lambert reproduces these arcs to ~1e-12 — the 1e-6 floor
  reflects the reference, not the solver.
- **Watermark:** `alarmRel = max(1e-12, source tolerance * 1e-3)` — three
  decades inside the source's own gate. A row that drifts from 1e-11 to 1e-7 is
  a real regression a 1e-6 gate would sleep through. Deriving the watermark
  from the source is what keeps it meaningful: a fixed 1e-9 watermark alarms
  permanently on the elliptical case, whose references are printed to six
  figures, and an alarm that is always on is an alarm nobody reads.

### KNOWN DEFECT — three of these four rows failed, and were repaired in 0.2.0

`tudat-izzo-hyperbolic`, `tudat-izzo-retrograde` and `tudat-izzo-near-pi` were
marked `expectedToFail`. The runner **asserts that a marked row fails**; an
unexpected pass is itself a test failure, which forces a deliberate re-baseline
instead of letting the ledger quietly go stale.

> **All three are green as of maneuver-planner 0.2.0** and carry a `repairedBy`
> block naming the task, the release, and what changed. Their watermarks were
> recalibrated against the measured agreement at the same time — they had been
> set while the rows were expected to FAIL, so none of them had ever been
> calibrated against a working solver.
>
> **A second thing was wrong and is fixed here (2026-08-10).** The markers came
> off `vectors.json` **by hand** while `build-vectors.mjs` went on applying
> them, and so did the recalibrated watermarks and the `repairedBy` blocks. That
> made the committed file unreproducible: `node vectors/tools/build-vectors.mjs
> --check` — the command whose entire job is to fail when the file drifts from
> its generator — had been failing on `main` ever since, and nothing was running
> it. Every one of those edits now lives in the generator, all twelve
> pre-existing rows regenerate **byte-identically**, and `--check` is the first
> thing `npm test` runs so it cannot rot silently a second time.

The verdict was **adjudicated, not inferred from disagreement**. Each candidate
departure velocity — Tudat's and the module's — was propagated forward by the
stated time of flight with an independent universal-variable Kepler propagator
(`propagateKepler` in `vectors/index.mjs`, which shares no line with either the
module or the tier-B generator) and asked one question: does this arc arrive?

| Row | Tudat's answer arrives within | Module's answer arrives within |
| --- | --- | --- |
| `tudat-izzo-hyperbolic` | 1.06e-6 of \|r2\| | **2.78e-1 of \|r2\|** |
| `tudat-izzo-elliptical` | 4.54e-7 of \|r2\| | 5.79e-11 of \|r2\| |
| `tudat-izzo-retrograde` | 8.29e-12 of \|r2\| | **3.59 x \|r2\|** |
| `tudat-izzo-near-pi` | 5.92e-10 of \|r2\| | **3.78 x \|r2\|** |

The elliptical row is what makes the other three unambiguous: the module solves
that geometry to 5.8e-11, so the harness, the units, the parameter names and the
prograde flag are all demonstrably right. Filed as
`modules-maneuver-lambert-returns-non-solutions`.

---

## Tier B — textbook canonicals (closed form, published anchors)

**Generator:** `vectors/tools/gen-textbook-vectors.mjs`

Inputs come from a named worked example. Expected values are produced by the
closed form written out below, implemented **once** in the generator,
independently of the module's C++. Where a published answer can be stated, the
generator **checks itself against it and refuses to emit on disagreement** — the
check is what turns "the author remembered the number" into a machine-verified
claim.

11 published anchors are checked on every build. Anchor tolerance defaults to
half a unit in the last published decimal place, inferred from the literal
itself.

### Closed forms

```
v_circular(r)      = sqrt(mu / r)
v_visviva(r, a)    = sqrt(mu * (2/r - 1/a))
half_period(a)     = pi * sqrt(a^3 / mu)

HOHMANN(r1, r2):   a = (r1 + r2)/2
                   dv1 = v_visviva(r1, a) - v_circular(r1)
                   dv2 = v_circular(r2) - v_visviva(r2, a)
                   tof = half_period(a)

BI-ELLIPTIC(r1, r2, rb):  a1 = (r1 + rb)/2 ,  a2 = (rb + r2)/2
                   dv1 = v_visviva(r1, a1) - v_circular(r1)
                   dv2 = v_visviva(rb, a2) - v_visviva(rb, a1)
                   dv3 = v_circular(r2)    - v_visviva(r2, a2)
                   tof = half_period(a1) + half_period(a2)

PLANE CHANGE(v, di):      dv = 2 * v * sin(|di| / 2)

COMBINED(r1, r2, di):     dv1 = v_visviva(r1, a) - v_circular(r1)
                          dv2 = sqrt(v2c^2 + v2t^2 - 2*v2c*v2t*cos(di))
                          with v2c = v_circular(r2), v2t = v_visviva(r2, a)

PHASING(r, dtheta, N):    T  = 2*pi*sqrt(r^3/mu)
                          Tp = T - (dtheta / (2*pi*N)) * T
                          ap = cbrt(mu * Tp^2 / (4*pi^2))
                          dv1 = v_visviva(r, ap) - v_circular(r)      [SIGNED]
                          dv2 = -dv1
```

### Rows

| id | Source | Published anchor | Reproduced |
| --- | --- | --- | --- |
| `vallado-6-1-hohmann-leo-geo` | Vallado, *Fundamentals of Astrodynamics and Applications*, **Example 6-1**. Circular 191.34411 km altitude to circular 35781.34857 km altitude. | `dv_a = 2.457038 km/s`, `dv_b = 1.478187 km/s`, `tau = 5.256713 hr` | **exact to all six published decimals** |
| `program-hohmann-300km-geo` | `saw-beta-maneuver-program` P0 probe + `docs/maneuver-command-cards.md`. r1 = 6678137 m, r2 = 42164000 m. | `dv1 = 2425.732`, `dv2 = 1466.824` m/s | see the discrepancy note below |
| `vallado-6-2-bielliptic` | Vallado, **Example 6-2**. 191.34411 km altitude to 376310 km altitude via `rb = 503873 km`. | **none asserted** — see below | n/a |
| `plane-change-15deg` | Vallado, **Example 6-3**. `v = 5.892311 km/s`, `di = 15 deg`. | `dv = 1.5382 km/s` | exact to the published precision |
| `combined-300km-geo-28p5deg` | Program verification spec. r1 = 6678.137 km, r2 = 42164 km, `di = 28.5 deg`, plane change entirely at apoapsis. | `4255.96 m/s` | exact |
| `combined-optimal-split-KNOWN-GAP` | Program verification spec. Same transfer, optimally split. | `4231.31 m/s` at `2.195 deg` | delta-v exact; angle — see below |
| `phasing-catch-up-30deg-3revs` | P0 probe + spec section 4.8. r = 6778137 m, `+30 deg`, 3 revs. | `73.038 m/s` | exact |
| `phasing-fall-behind-30deg-3revs` | P0 probe. Same orbit, `-30 deg`. | `69.0899 m/s` | exact |
| `phasing-from-state-catch-up-30deg-3revs` | **Twin** of the row above it, with the angle DERIVED from two Cartesian states. | `73.038 m/s` (the same anchor) | exact; angle recovered to `7.8e-16 rad` |
| `phasing-from-state-fall-behind-30deg-3revs` | Twin of the fall-behind row. | `69.0899 m/s` | exact; angle to `5.6e-16 rad` |
| `phasing-from-state-apsides-opposed` | **Adversarial.** One orbit, apsides 180 deg apart: mean anomalies differ by 210 deg, true separation is 30. | none — analytic | angle to `4.4e-16 rad` |
| `phasing-from-state-raan-offset` | The `cos(i)` projection of a 0.5 deg RAAN difference at i = 51.6 deg. | none — analytic | angle to `1.7e-16 rad` |
| `phasing-from-state-fall-behind-the-long-way` | `direction: "fallBehind"` on a target that LEADS: −330 deg, 1201.75 m/s against the short way's 146.08. | none — analytic | exact |
| `phasing-from-state-recommends-revolutions` | 170 deg of separation, revolution count unstated: the scan must climb to 32. | none — analytic | exact, integer |
| `phasing-from-state-non-coplanar-polar-droid` | The owner's polar craft aimed at an ISS-inclination target: 45.8 deg of plane angle, reported not refused. | none — analytic | exact |

#### Why the from-two-states rows are CONSTRUCTED and what that buys

Each craft is specified by classical elements whose mean argument of latitude
is chosen by hand, and the Cartesian state handed to the module is produced
from those elements by a closed form written in
`vectors/tools/gen-textbook-vectors.mjs` and nowhere else. The separation is
therefore known **analytically, to the last bit**, before the module is asked.
There is no reference to disagree with and no round trip through the code under
test — which is the only construction under which a derived angle can be
checked at all, because (see tier D) no contributing library implements the
derivation.

Each of the two 30-degree rows is a **twin** of the typed-angle row above it:
the same radius, the same revolution count, the same angle. A from-two-states
answer that drifted from the typed answer would show up as two rows disagreeing
about one number, rather than as nothing at all.

`phasing-from-state-apsides-opposed` is the row that earns its place: the
JavaScript this operation replaces (`b1360cb`'s `armTransfer`) differenced two
MEAN ANOMALIES, which is correct only when both apsides coincide — a condition
no real pair satisfies. On that row the mean-anomaly difference is 210 degrees
and the answer is 30. It is checked by the generator's own `assertions` block,
so a construction that stopped being adversarial would stop being emitted.

### Discrepancies, recorded rather than smoothed

**`program-hohmann-300km-geo` — the spec's quoted anchor is imprecise.** The
spec and P0 quote `dv1 = 2425.732 m/s`. The exact two-body value is
`2425.7299089463063`, which rounds to `2425.730`. The last published digit is
therefore off by `2.1e-3 m/s`. This is a transcription artifact in the *quote*,
not a disagreement about the physics; the anchor tolerance for that one value is
widened to `5e-3` with the reason recorded in the generator, and no other
tolerance was touched. P0 recorded this pair as "MATCH", which it is at six
significant figures.

**`vallado-6-2-bielliptic` — no published anchor is asserted.** The total this
author could state for Example 6-2 (`3.904057 km/s`) did **not** reproduce; the
closed form gives `3.906576 km/s`. Rather than round one into the other, the
anchor is withdrawn and the discrepancy recorded here. The row still carries a
checkable claim — the *pedagogical* content of the example is an inequality, and
the generator asserts it: at this radius ratio the bi-elliptic total
(`3.906576 km/s`) is genuinely below the direct Hohmann (`3.966193 km/s`).
Anyone with the book should either supply the correct published figure or
correct the stated inputs.

> **SETTLED, 2026-08-10, by tier D.** The withdrawn anchor was right and the
> inputs were the problem. hapsira's `test_bielliptic_maneuver` carries the same
> Vallado example and asserts `3.904057 km/s`, and it reproduces to **6.3e-8
> relative** once the three radii are read as ALTITUDES above hapsira's
> `R_earth` and the total is the sum of the burn MAGNITUDES — the third burn is
> a deceleration, `-70.466 m/s`, and enters the total with its sign flipped.
> The tier-D row `hapsira-vallado-6-2-bielliptic` asserts it and is green. This
> tier-B row is left exactly as it stands: it is a different claim about a
> different input set, and rewriting it to match would erase the record of how
> the disagreement was actually resolved.

**`combined-optimal-split-KNOWN-GAP` — the optimal angle.** The spec quotes
`2.195 deg`; a ternary search on the exact objective gives `2.2002 deg`. The
delta-v anchor `4231.31 m/s` reproduces *exactly*, because the objective is
extremely flat near the optimum — the difference in total delta-v between
2.195 and 2.200 degrees is below a micrometre per second. The angle is checked
at `0.01 deg`, which is the tolerance that flatness justifies; the delta-v — the
quantity anyone actually flies — is checked tightly.

### KNOWN GAP — the optimal plane-change split

`combined-optimal-split-KNOWN-GAP` is marked `expectedToFail`.
`computeCombinedManeuver` takes the **entire** inclination change at burn 2,
which is the textbook's first answer, not its final one. Splitting `2.20 deg`
into the departure burn saves **24.65 m/s (0.58 %)** on this transfer. The row
exists so the gap cannot be forgotten, and so that implementing the
optimisation *fails the suite* and forces a deliberate re-baseline.

---

## Tier C — invariants (no stored expectation at all)

Declared in `vectors.json`, evaluated by `runInvariants` in
`vectors/index.mjs`. These apply to **every** case whose operation they
recognise, on top of the case's own expectations. An invariant that only runs
where somebody remembered to list it is not an invariant.

| id | Statement |
| --- | --- |
| `vis-viva-closure` | Circular speed at `r1` plus burn 1 equals the transfer orbit's vis-viva speed at `r1`; likewise at `r2` before burn 2. Catches a delta-v computed against the wrong semi-major axis — an error that leaves `dv1 + dv2` looking entirely reasonable. |
| `delta-v-sum-identity` | `totalDeltaV` equals the sum of the reported burn magnitudes. A response whose total does not add up is internally inconsistent regardless of which number is right. |
| `rtn-eci-round-trip-per-component` | A RIC delta-v converted to inertial through `ricBasis` and back reproduces **component by component**. Magnitude-only passes under *any* rotation, including the identity map that engine defect D1 applies — component-wise is the only form of this check that can see the bug it exists to see. The probe state is deliberately non-axis-aligned and non-equatorial, because an aligned state makes the RIC basis a permutation of the inertial axes and hides D1 completely. |
| `lambert-arrival-closure` | Propagating `(r1, v1)` forward by `tof` with an independent Kepler propagator arrives at `r2`, per component, within 1e-6 of `|r2|`. This is the adjudicator that settled the tier-A verdict. |
| `phasing-earth-floor` | Classifies whether the phasing orbit's far apse clears `Re + 100 km`. The module does not clamp it, so this invariant **records rather than fails** — and the console wrapper's guard is tested against exactly the cases it classifies `BELOW-FLOOR`. |
| `lambert-earth-floor` | Classifies whether the transfer arc's **perigee** clears the Earth's surface. Records rather than fails, and the count is printed on every run. It is the check that made the through-Earth defect tractable: six of the Lambert rows classify `THROUGH-EARTH`, so the fix cannot be a refusal — see tier D. |

### The adjudicator was hardened on 2026-08-10

`propagateKepler` — the independent propagator that settles every arrival claim
— gained three things, and **none of them repairs a wrong answer**. Every vector
it had ever adjudicated, it adjudicated correctly. What it could not do was
*tell us when it could not answer*:

1. **An initial guess per orbit type.** `sqrt(mu) * |alpha| * dt` is the
   *elliptic* guess. Tier D walked it onto a near-radial hyperbolic arc where
   that guess puts `z` near `-3300` and `cosh(sqrt(-z))` is `1e24`.
2. **Newton safeguarded by bisection.** `F(x)` is monotone increasing (`dF/dx`
   is the radius), so a bracket always exists. The old loop had no bracket and
   no bail-out: a diverged step simply left `x` where it landed.
3. **Certify or refuse.** The time residual is re-checked, and angular momentum
   and energy must be conserved. If they are not, the arc is re-propagated by
   direct numerical integration; if *that* cannot converge either, the result
   comes back `certified: false` and `lambert-arrival-closure` **fails the row**
   rather than passing it.

The case that forced all three is Curtis example 5.3 solved the retrograde way
round: a mathematically valid Kepler arc whose perigee is **5.9 km from the
Earth's centre**, passed at **369 km/s**. Fixed-step RK4 cannot resolve that
perigee at all and blows up by eleven orders of magnitude, which is exactly why
the integrator measures its own convergence instead of returning its last
iterate.

---

## Tier D — the contributing libraries' own test suites (owner directive 2026-08-10)

> *"We should have tests for all this maneuver functionality that are taken from
> the tests from the contributing libraries."*

**Dumpers:** `vectors/tools/dump-hapsira-vectors.mjs`,
`vectors/tools/dump-orekit-vectors.mjs`
**Composer:** `vectors/tools/gen-library-vectors.mjs`
**Raw extractions (audit trail, committed):** `vectors/hapsira-extract.json`,
`vectors/orekit-extract.json`

Same construction as tier A, twice over: the dumpers read upstream test source
as **text**, parse every literal, and emit an extract; the composer maps the
extract onto the module's JSON surface and derives the bands. Neither library is
imported, executed, compiled, or linked, and neither is a dependency of any
build in this repo. Regenerating needs a checkout; consuming does not.

### Licences — checked in code, not remembered

| Library | Licence | How it is verified |
| --- | --- | --- |
| hapsira 0.19.dev0 (`5d25e627`) — the maintained poliastro fork | **MIT** | The dumper reads `LICENSE` and **refuses to emit** if the first line does not read as MIT. |
| Orekit `81dffba6` (14.0-SNAPSHOT, `develop`) | **Apache-2.0** | The dumper checks the Apache header of **every file it reads** before taking a single number from it, and records the copyright notice. |
| Tudat `028b3087` (tier A) | BSD-style | Unchanged from tier A. |

`tests/vectors.test.mjs` then re-asserts it at RUN time: every tier-D row must
name its library, commit, upstream file, upstream test and licence, and the
licence must be on the permissive list (`MIT`, `Apache-2.0`, `BSD-3-Clause`,
`ISC`). A future dumper pointed at a copyleft source fails there, loudly, rather
than quietly shipping copyleft values inside our test data.

**No upstream CODE is copied.** What crosses the boundary is inputs, expected
numbers, and stated tolerances, re-expressed in our own JSON with citation —
which is the form the GPL firewall requires *even where the licence would not*.
(Perses' SSBM precedent is why the licence is read out of the checkout and
asserted rather than assumed: the rule has to hold when the answer is *no*.)

### Band policy — tighter provenance than tier A, and no invented floor

Tier A floors the relative gate at `1e-6` because Tudat prints some references
to six significant figures and a case-wide floor was all that was available.
Tier D needs no floor:

```
rel = the tolerance the upstream test states for THAT symbol
abs = half a unit in the last decimal place actually published
```

Both come from the source. hapsira asserts `expected_va` at `rtol=1e-5` and
`expected_vb` at `rtol=1e-4` *inside one test*, so bands are **per field**
(`fieldBands`), not per case; a single case-wide band would over-assert one and
under-assert the other.

**The regression watermark is a fraction of the row's own budget (80 %), not a
multiple of the source tolerance.** Tier A can afford `tolerance * 1e-3` because
Tudat quotes its best rows to fifteen figures. Tier D's references are printed
to five to seven, and hapsira gates at `1e-5` *because its own two solvers only
agree to that*. Applying tier A's construction here lit **twenty-two alarms on a
fully green run** — an alarm nobody reads is not an alarm.

### Rows

| id | Op | Upstream authority | Library | Verdict |
| --- | --- | --- | --- | --- |
| `hapsira-vallado-7-5` | `solveLambert` | Vallado example 7-5 | hapsira | green |
| `hapsira-curtis-5-2` | `solveLambert` | Curtis example 5.2 (fully 3-D) | hapsira | green |
| `hapsira-curtis-5-3` | `solveLambert` | Curtis example 5.3 | hapsira | **KNOWN-RED** |
| `hapsira-der-molniya-0rev` | `solveLambert` | Der, *Superior Lambert Algorithm* | hapsira | green |
| `hapsira-der-molniya-1rev-highpath` | `solveLambert` | Der — **multi-rev**, high path | hapsira | **KNOWN-RED** |
| `hapsira-der-molniya-1rev-lowpath` | `solveLambert` | Der — **multi-rev**, low path | hapsira | green |
| `hapsira-issue840-retrograde` | `solveLambert` | hapsira issue #840 | hapsira | green |
| `hapsira-der-molniya-1rev-infeasible` | `solveLambert` | Der geometry, ToF cut to 5 h — **must refuse** | hapsira | green |
| `hapsira-collinear-refusal` | `solveLambert` | collinear positions — **must refuse** | hapsira | green |
| `lambert-perigee-radius-not-published-SCREENING` | `solveLambert` | Der geometry + a requirement of ours | hapsira | **KNOWN-RED** |
| `hapsira-vallado-6-1-hohmann` | `hohmannTransfer` | Vallado example 6-1 | hapsira | green |
| `hapsira-eccentric-departure-hohmann` | `hohmannTransfer` | eccentric departure | hapsira | **KNOWN-RED** |
| `hapsira-vallado-6-2-bielliptic` | `biEllipticTransfer` | Vallado example 6-2 | hapsira | green |
| `hapsira-eccentric-departure-bielliptic` | `biEllipticTransfer` | eccentric departure | hapsira | **KNOWN-RED** |
| `orekit-der-superior-lambert` | `solveLambert` | Der, at **EGM96's mu** | Orekit | green |
| `orekit-inertial-impulsive-burn` | `ricFrameAlgebra` | Orekit `ImpulseManeuverTest` | Orekit | green |
| `orekit-cartesian-to-keplerian` | `phasingFromTargetState` | Orekit `CartesianOrbitTest.testCartesianToKeplerian` | Orekit | green |
| `orekit-cartesian-to-equinoctial` | `phasingFromTargetState` | Orekit `CartesianOrbitTest.testCartesianToEquinoctial` | Orekit | green |
| `orekit-cartesian-phase-pair` | `phasingFromTargetState` | both of the above, as chaser and target | Orekit | green |

### NEITHER LIBRARY IMPLEMENTS `phasingFromTargetState`. That was checked.

A negative finding is worth as much as a positive one when it is precise, and
this one decides what the three rows above can honestly claim. Both checkouts
were searched before the rows were written:

- **hapsira: nothing.** `src/hapsira/maneuver.py` exposes `impulse`, `hohmann`,
  `bielliptic`, `lambert` and `correct_pericenter` — there is no `phasing`
  classmethod. No `phase_angle`, `angular_separation` or `synodic` symbol
  exists anywhere in `src/` or `tests/`. `Maneuver.lambert` is the only method
  taking TWO orbits and it touches only their position vectors and the epoch
  difference — never an anomaly, never a longitude. The single literal
  occurrence of "phase angle" in the tree is a degenerate-geometry guard inside
  the Vallado Lambert solver (`core/iod.py`), about the transfer angle between
  two position vectors, and no test exercises it with numbers.
- **Orekit: the primitive, not the operation.** It has the whole angle
  vocabulary (`getLM`, `getLv`, `getAlphaM`, `getMeanAnomaly`) and two
  hard-literal *Cartesian state in → angle out* unit tests, which is exactly
  what the rows above lift. Its closest thing to a phasing maneuver,
  `WalkerConstellation`, **synthesises** a phased orbit from a T/P/F spec and
  one reference orbit; it does not measure the phase between two given craft
  and it emits an orbit rather than a delta-v.

So the split is deliberate and is the strongest available: the **combination
rule** — the quasi-nonsingular relative mean longitude — is this repo's, and it
is pinned analytically by the tier-B constructions, where the truth is exact by
design. The **element recovery underneath it** is pinned here, by a foreign
implementation, on two states chosen for opposite hazards:

- `testCartesianToKeplerian` is strongly eccentric (e = 0.7435, a Molniya-class
  arc) and Orekit asserts `a`, `e`, `i`, `argp`, `raan` and the **mean anomaly**
  separately, each against its own literal. Every angle of the recovery is
  therefore pinned independently, not merely their sum.
- `testCartesianToEquinoctial` is near-circular AND near-equatorial
  (e = 0.0021, i = 0.4°) — the regime where the node line and the perigee are
  both nearly unresolvable and Orekit itself declines to assert the parts,
  asserting the equinoctial set and the **mean longitude** instead. That is the
  exact regime `stateToClassicalElements` computes `nu = u - argp` for, so the
  cancellation it depends on is checked against a foreign answer rather than
  against its own reasoning.

`orekit-cartesian-phase-pair` then puts the two states in one request. Its
expectations are derived from Orekit's own literals by Orekit's own definitions
(`raan = atan2(hy, hx)`, `i = 2 asin(sqrt((hx² + hy²)/4))`, mean argument of
latitude = `LM − raan`), and every gate is **propagated** from the source's own
tolerances by perturbing each input by its stated gate and summing the
absolute changes — a first-order propagation done by measurement, in
`gen-library-vectors.mjs`, so it cannot drift out of step with the expression
above it. Asserting anything tighter would be asserting digits Orekit never
published.

Measured margin on the pair row: the relative phase agrees to `1.2e-14 rad`
against a `1.1e-6 rad` budget, and the worst element uses **0.04%** of its
budget (`targetSemiMajorAxis`, `3.7e-8 m` against `9.2e-5 m`).

Two details worth stating because they are easy to get wrong:

- **The `prograde` flag is derived from the PUBLISHED ARC, not the geometry.**
  hapsira's Izzo solver takes no such flag. The first version of the dumper
  derived it from the sign of `(r1 × r2)_z` — "the short way" — which is right
  for six of the seven rows and **wrong for hapsira's own issue-840 regression**,
  where the published departure velocity is a *prograde* arc sweeping 328°
  while the short way is retrograde. It is now `sign((r1 × v1)_z)` on the
  published velocity: the only question our flag actually answers.
- **Tier D rows carry the SOURCE's gravitational parameter.** Orekit's Der case
  runs at EGM96's `3.986004415e14` and hapsira's at the IAU `3.986004418e14` —
  the same upstream paper at two constants. Forcing both onto our pin would turn
  a conformance check into a comparison of constants.

### The four known-red rows, and what each one owns

**`hapsira-curtis-5-3` — `solveLambert` refuses an arc that flies.**
`modules-maneuver-lambert-refuses-a-solvable-arc`. The module answers
`no-solution`; hapsira solves it and this repo's own independent propagator
confirms the answer arrives to `2.3e-5` of `|r2|` (which is all hapsira's
five-figure printing supports). Root cause is line-level: the zero-revolution
downward march starts at `|step| = max(1, |z0|)` and only **doubles**. This root
is at `z = -0.173`; the first probe lands at `z = -1`, where `y < 0` and `F` is
not finite, and every probe after it is deeper into the empty domain. A whole
class of short-transfer-angle hyperbolic arcs is unreachable and is reported as
though no arc existed.

**`hapsira-der-molniya-1rev-highpath` — only one of two multi-rev branches.**
`modules-maneuver-lambert-multi-rev-exposes-one-branch-of-two`. A
one-revolution Lambert problem has **two** arcs; hapsira exposes the choice as
`lowpath`. Our solver scans the bounded interval and takes the **first** sign
change, so it returns the low path — which is why the `lowpath` row is green and
this one is red — and the JSON surface carries no way to ask for the other.

**`hapsira-eccentric-departure-{hohmann,bielliptic}` — the departure-speed gap.**
`modules-maneuver-hohmann-departure-speed`, and this is the foreign evidence
that task was missing. hapsira's `Maneuver.hohmann` propagates to periapsis and
departs from the state it finds there
(`dv_a = sqrt(2k/r_i − k/a_trans) − v_i`); ours assumes `v_i = sqrt(mu/r1)` and
the JSON surface gives the caller no way to say otherwise. Each row records both
speeds and the eccentricity, so the marker states the SIZE of the gap and not
merely its existence.

**`lambert-perigee-radius-not-published-SCREENING` — the owner's live hit.**
`modules-maneuver-lambert-publishes-no-transfer-perigee`. An operator met a
through-Earth transfer on 2026-08-10. The obvious fix — refuse arcs whose
perigee is inside the planet — **is wrong, and this tier proves it**: the
`lambert-earth-floor` invariant classifies every Lambert row, and six of them,
including Vallado 7-5 (3,186 km from the centre) and the Der Molniya case that
hapsira *and* Orekit both carry (909 km), are `THROUGH-EARTH`. Those are correct
answers to the Lambert problem, and a solver that refused them would fail its
conformance suite against three libraries. The requirement is therefore a
**report**, not a refusal: publish `perigeeRadius` and let the consumer screen.
Today it publishes neither that nor a flag, so the only place to screen is the
console, in JavaScript, which the no-JS-physics law forbids.

### What tier D does NOT cover, said plainly

`plugin_entity_apply_impulsive_burn` (`propagator/sgp4`) and `plugin_set_burns`
(`propagator/hpop`) are the surfaces that APPLY a burn and recover elements.
Orekit's `ImpulseManeuverTest` is the natural conformance source for them, and
they are not tested here: that ABI is **mid-flight in another lane**
(`orbpro-propagators-have-no-native-burn-surface`), and a second suite against
an artifact somebody is rebuilding races a republish. What the row
`orekit-inertial-impulsive-burn` does assert is the part the maneuver module
owns — the RIC ↔ inertial algebra every `*_ric` field depends on — against
Orekit's triple and Orekit's own `1e-4 m/s` tolerance. The rest is filed, not
dropped.

---

## The ratchet

`vectors/ratchet.json` + `tests/ratchet.test.mjs`. Vector counts may only grow,
**and so may the GREEN count** — the second rule is the one that matters, because
the cheapest way to make a red suite green is to mark a row `expectedToFail`,
and that leaves every total unchanged. Three rules:

1. total per operation may not fall (catches a deleted row);
2. **green** per operation may not fall (catches a row demoted to known-red);
3. every known-red row must name a defect, or it is a disabled test with extra
   steps.

Raising it is deliberate and prints the delta:
`node vectors/tools/update-ratchet.mjs`. It **refuses** to lower any number
without `--allow-lower "<reason>"`, which is recorded in the file.


---

## Signed delta-v: what the JSON bridge does not carry

The C++ computes `dv1_ric = {0, dv1, 0}` with the sign intact for phasing,
bi-elliptic and combined — and then **does not serialise it**. Only
`hohmannTransfer` (`dv1_ric`, `dv2_ric`) and `planeChange` (`dv_ric`) emit their
RIC arrays. Every other operation exposes `std::abs(dv)` and nothing else.

A consumer reading the scalar flies every catch-up phasing burn **prograde when
it must be retrograde**, with no error anywhere. Tier-B phasing rows therefore
carry a `signedDeltaV` block: the signed truth the bridge drops, which the
console wrapper's sign recovery must reproduce. The recovery is exact and uses
only module outputs — `sign(dv1) = sign(phasingSMA - currentRadius)`, because
`v_visviva(r, a) > v_circular(r)` exactly when `a > r`.

Recorded against `modules-maneuver-planner-rebuild-batch`.

---

## Regenerating

```sh
# Tier A + D dumpers. Each READS an upstream checkout; none compiles, imports or
# links one. The emitted *-extract.json files are committed, so only somebody
# CHANGING a vector needs the checkouts.
node vectors/tools/dump-tudat-vectors.mjs      # tier A  -> tudat-extract.json
node vectors/tools/dump-hapsira-vectors.mjs    # tier D  -> hapsira-extract.json
node vectors/tools/dump-orekit-vectors.mjs     # tier D  -> orekit-extract.json

node vectors/tools/build-vectors.mjs           # compose tiers A + B + C + D
node vectors/tools/build-vectors.mjs --check   # fail on drift; FIRST thing npm test runs
node vectors/tools/update-ratchet.mjs          # raise the floor, deliberately
npm test                                       # every vector, every runtime
```

Where the upstream checkouts are expected, and how to make them:

```sh
git clone --filter=blob:none --depth 1 \
  https://github.com/pleiszenburg/hapsira.git ~/software/upstream/hapsira

git clone --filter=blob:none --no-checkout --depth 1 --branch develop \
  https://gitlab.orekit.org/orekit/orekit.git ~/software/upstream/orekit
git -C ~/software/upstream/orekit sparse-checkout set \
  src/test/java/org/orekit src/main/java/org/orekit/utils
git -C ~/software/upstream/orekit checkout
```

Override with `--hapsira <dir>` / `--orekit <dir>`, or `HAPSIRA_ROOT` /
`OREKIT_ROOT`. Both dumpers fail loudly with these instructions when no checkout
is found; neither ever silently emits a partial file.

`~/software/upstream/` is deliberately NOT `repos/` (owner law 2026-08-02: the
`repos/*-packages/` directories carry gitlinked submodules and nothing else) and
NOT `~/software/worktrees/` (which is for agent worktrees). These are read-only
oracles, not part of this stack.
