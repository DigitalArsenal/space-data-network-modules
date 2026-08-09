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

### KNOWN DEFECT — three of these four rows fail

`tudat-izzo-hyperbolic`, `tudat-izzo-retrograde` and `tudat-izzo-near-pi` are
marked `expectedToFail`. The runner **asserts that they fail**; an unexpected
pass is itself a test failure, which forces a deliberate re-baseline instead of
letting the ledger quietly go stale.

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
node vectors/tools/dump-tudat-vectors.mjs   # tier A; needs a tudat checkout to READ
node vectors/tools/build-vectors.mjs        # compose tiers A + B + C
node vectors/tools/build-vectors.mjs --check   # CI: fail on drift
npm test                                    # run every vector on every runtime
```
