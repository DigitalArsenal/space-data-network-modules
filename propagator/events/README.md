# Event Locator

One event-location engine; six locators.

Eclipse (umbra, penumbra, antumbra), station contact with light-time
correction, body intrusion into a conic field of view, apsides, node crossings
and a stopping condition on any named catalog parameter are not six algorithms.
They are six **event functions** handed to one runner:

    g(t) is continuous;  an event is a sign change of g;
    the epoch of the event is the root of g, found by refinement.

`src/event_locator.hpp` therefore holds exactly two things a locator does not: a
bracketing scan and a Brent root refinement. Adding a locator is writing a `g`.

## The trajectory is a port

This module carries **no propagator**. The caller supplies a sampled trajectory
on the `ephemeris` port — from whichever propagator it chose — and the module
makes it continuous with a Hermite interpolant that matches position *and*
velocity at every node. An epoch outside the table is refused, never
extrapolated.

## What the scan step does and does not decide

`SCAN_STEP_SECONDS` decides only whether a root is **bracketed**. Once bracketed
it is refined on the continuous function, so the same scenario at three
different steps lands on the same epoch. The JavaScript scans this replaces
reported the refined *sample* and so moved with the step.

## Verification

```sh
npm run build && npm test
```

- `tests/event_locator_conformance.test.mjs` compiles the engine natively and
  measures step-independence, forward-backward closure, root convergence on
  functions whose roots are known exactly, and one located epoch per locator
  against an independent 200-step bisection on the same closed-form geometry.
- `tests/events.test.mjs` measures the SHIPPED artifact on the wire against a
  curve whose event epochs are arithmetic.

## Composed access-constraint locators (`$ACW`)

`locate_access_windows` accepts a `request` port containing an SDS 1.219.0
`ACW.REQUEST` and emits `ACW.RESULT` on `results`. It compiles the same C++
evaluator as `analysis/access` into this module's isomorphic WASM artifact.
The request carries ground sites, moving observer trajectories, nested AND/OR
constraints, blackout windows, and optional Sun/Moon trajectories. Inputs use
Earth-fixed positions in metres and TT Julian dates. `DISCRETE` reports sample
edges; `CONTINUOUS` refines bracketed boundaries to `ROOT_TOLERANCE_S` and
reports limiting-constraint indices/labels and range extrema.

The existing `$EVL` schema does not contain ACW's new constraint configurations.
The added method uses ratified `$ACW` directly; `$EVL` and `$PCE` methods retain
their existing wire contracts. No new schema or private locator-enum values are
introduced. See `analysis/access/README.md` for shared evaluator semantics.

```sh
npm ci
npm run build
npm test
node --test tests/sdk_compat.test.mjs
npm run check:compliance
PATH="$HOME/.wasmedge/bin:$PATH" npm run test:parity
```

`tests/access-constraints.test.mjs` invokes browser/V8 and native WasmEdge with
closed-form metre/radian/TT cases: linear range crossings and attribution,
nested OR, solar/lunar exclusion, an equatorial ellipsoid grazing segment
with and without a 100 m atmosphere, blackout cuts, and target umbra.
`tests/kernel-parity.mjs` sends the identical request and artifact bytes through
Chrome/V8, native WasmEdge, and container WasmEdge, covering those cases and the
existing kernel-backed eclipse cases.

The expected limb is the WGS-84 equatorial semi-major axis, `6378137 m`, from
[NGA's WGS-84 definition](https://earth-info.nga.mil/?action=wgs84&dir=wgs84).
Range and exclusion oracles solve the fixture's straight-line range and
angle equations directly; they do not replay outputs from this implementation.
The 0.1 s edge bar allows the requested 0.01 s refinement and the precision of
TT Julian dates. Range extrema use a 2 m bar (100 m/s × refinement tolerance,
plus endpoint rounding). `tests/events.test.mjs` also checks conic interval
entry and exit against a trigonometric closed form with a 1 ms bar, including
the 10 s Hermite table's interpolation error.
