# Keplerian reference propagator — vector provenance

Every row in `vectors.json` and every invariant that adjudicates the module,
with the reason it is trustworthy and the reason it might not be.

## Conformance model (PINNED)

| Quantity | Value | Why this one |
|---|---|---|
| Gravity model | two-body point mass | No drag, no J2, no third bodies. Deliberate — see "What this module is not". |
| `mu` | `398600.8e9` m³/s² (**WGS-72**) | The OMM mean elements were FITTED under WGS-72. Consuming them under WGS-84 introduces a bias that has nothing to do with the two-body simplification, and it would show up as a constant semi-major-axis offset that looks like a propagator bug. |
| Earth rotation rate | `7.292115146706979e-5` rad/s | IAU 1982, matching the GMST series used for TEME→ECEF. |
| Units | SI: metres, metres/second, Julian days | Degrees on INPUT only (the `$OMM` convention, carried into `OrbProOMMRecord` unconverted). |
| Output frame | ECEF (`ORBPRO_FRAME_ECEF = 3`) | The ABI requires it, and the transform happens inside the module. |

## Tolerance policy

```
fail  <=>  |observed - expected| > abs + rel * |expected|
```

Bands are declared per QUANTITY in `vectors/index.mjs`, not per case, so a
single loosened tolerance cannot hide behind one row:

| Quantity | abs | rel | Reasoning |
|---|---|---|---|
| position | 1e-6 m | 1e-9 | On a ~7e6 m orbit, 1e-9 relative is ~7 mm. Two double-precision closed forms should agree far inside that. |
| velocity | 1e-9 m/s | 1e-9 | Same argument at ~7.5e3 m/s. |
| time | 1e-9 day | 0 | Julian dates near 2.46e6 carry ~1e-11 day of resolution. |
| exact | 0 | 0 | Determinism. Compared as bytes. |

## Tier B — closed-form anchors

**There is no Tier A row in this suite, and that is a deliberate statement
rather than an omission.** A foreign authority would have to be a two-body
propagator agreeing on WGS-72 mu, on the GMST series, and on the TEME→ECEF
convention. There is no such published vector set that pins all three, and
adopting one that pins two of them would produce rows that fail for reasons
unrelated to this module's correctness. When a suitable foreign authority is
identified, it belongs here as Tier A and these rows stay as Tier B.

### What "closed form" means here, precisely

| Kind | Provenance |
|---|---|
| Generator | `vectors/tools/build-vectors.mjs` |
| Adjudicator | `vectors/index.mjs` — an **independent** JavaScript implementation of two-body motion, written from the textbook relations, not transcribed from the module's C++ |
| Derivation | `a = (mu/n²)^(1/3)`; Kepler's equation by Newton–Raphson; perifocal→inertial by the classical 3-1-3 rotation; inertial→ECEF by rotation about Z through GMST (IAU 1982) with the `-ω × r` velocity term |
| Never | run the module and record what it said |

Two independent implementations of the same closed form agreeing to 1e-9
relative is evidence. One implementation agreeing with a recording of itself
is a change-detector wearing a conformance suite's clothes.

### The generator refuses to emit

`assertEnergyClosure` runs before any row is written: specific orbital energy
`v²/2 − mu/r` must be conserved along the arc, to 1e-12 relative, against
`−mu/2a`. If it is not, the generator **throws** and writes nothing, naming
the case and the drift.

That refusal is the property this suite borrowed from the maneuver vector
suite: a generator that will happily write a physically impossible expectation
cannot be trusted to have written a possible one. Fix the closed form, never
the tolerance.

### Rows

15 anchors across 4 element sets, each chosen for a failure it exposes:

| Element set | e | i | Exposes |
|---|---|---|---|
| `leo-near-circular` | 0.00067 | 51.64° | The common case — and the one whose errors are least visible in a picture. |
| `molniya-high-eccentricity` | 0.72 | 63.4° | A Kepler solver started from `M` instead of `π` wanders here; a fixed-iteration solver silently returns a wrong anomaly instead of failing. |
| `circular-equatorial-degenerate` | 0.0 | 0.0° | Argument of perigee and RAAN are both undefined-but-declared. A propagator that divides by `e` or by `sin(i)` fails here and nowhere else. |
| `sun-synchronous-retrograde` | 0.001 | 98.2° | An inclination handled as `\|i\|` puts the ground track on the wrong side of the pole — invisible in a single-orbit plot. |

Offsets sample epoch, sub-orbit, near-perigee, near-apogee, one full period and
one day out, per set.

## Tier C — invariants (no stored expectation at all)

| id | Statement |
|---|---|
| `vis-viva-closure` | `v²/2 − mu/r`, computed in the inertial frame from the module's OWN ECEF output by undoing the Earth-rotation term, equals `−mu/2a` for the `a` implied by the ingested mean motion. The orbit adjudicates itself. |
| `period-closure` | Propagating forward by exactly one orbital period returns the same inertial radius. Verified by propagation, not against a recorded value. |
| `determinism` | Identical inputs produce **byte-identical** 64-byte state vectors across repeated calls AND across a destroy / re-ingest cycle. Compared as bytes. Output that changes after a lifecycle round trip is state leaking across it. |
| `frame-and-flags-declared` | `reference_frame` is ECEF, `VALID` is set, and the three padding bytes at offsets 57..59 are zero. A non-zero padding byte means the writer assigned the frame field directly instead of using the generated setter. |
| `refusal-is-typed` | Each documented failure returns its OWN negative code. A propagator returning `-1` for everything cannot be placed on the degradation ladder. |

`vis-viva-closure` runs at a looser band (1e-6 relative) than the Tier B
position rows, and the reason is recorded rather than smoothed over: the test
recovers inertial magnitudes from ECEF output by undoing `ω × r`
approximately. It is tight enough that a wrong semi-major axis — the classic
`mu` or units error, which is the failure this invariant exists to catch —
cannot pass, and loose enough not to fail on the recovery itself.

## Discrepancies, recorded rather than smoothed

None outstanding. All 15 Tier B rows and all Tier C invariants pass against
`dist/isomorphic/module.wasm`.

## What this module is NOT

It is a two-body propagator. Against a real satellite it diverges from SGP4
within hours, and that is not a defect — drag, J2 and third-body effects are
absent BY DESIGN. Do not add rows that compare it to SGP4 output and call the
difference an error; that would be measuring the physics it deliberately
omits.

Its job is to be a correct, complete, minimal implementation of the propagator
ABI that a third party can copy. The conformance set therefore tests the
CONTRACT — units, frame, padding, identity, lifetime, refusals, determinism —
plus the small amount of physics it does claim.

## Regenerating

```
npm run vectors:build    # write vectors.json
npm run vectors:check    # fail on drift; runs in the module's test suite
```

`vectors.json` is generated and must not be hand-edited. If the numbers move,
say WHY here before committing.
