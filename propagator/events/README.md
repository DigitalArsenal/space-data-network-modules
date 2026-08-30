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
