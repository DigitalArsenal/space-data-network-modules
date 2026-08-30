# Differential-correction targeter

This maneuver-family module exposes `Vary`/`Achieve` and open SQP
`Optimize`/`Minimize`/`NonlinearConstraint` operations through the pull/supply
solver ABI in `orbpro_solver_abi.h`.

The module does not import or select a propagator. `plugin_solver_next` yields a
candidate control vector, the consumer evaluates that vector through its chosen
propagator and objective-evaluator ports, and `plugin_solver_supply` returns the
goals, objective, constraints, or analytic state-transition Jacobian. This is
the same surface for Newton-Raphson, Broyden, Modified Broyden, and the open
Yukon-class sequential quadratic-programming solver.

The typed entry consumes a signed `$SLP` problem and starts the same pull/supply
session. Direct ABI limits are fixed at 16 variables/goals so byte offsets
remain identical in browser and server runtimes. The host signs result records
after the selected evaluator ports finish; private signing material never
enters this solver module. `$PSS` is the ratified multi-solution output used by
the sibling `maneuver/star-search` search surface.

`npm test` checks:

- published finite-difference scaling behavior from the pinned Orekit test;
- Newton-Raphson/Broyden/Modified-Broyden agreement and evaluation counts;
- central, forward, and analytic Jacobians;
- single- and combined-burn closed-form targeting anchors;
- annual GEO station-keeping budgets;
- the executable pull/supply protocol for Target and SQP, including an
  inconsistent problem that must report `INFEASIBLE`.

The gallery reference case selects HPOP's point-mass provider, but the solver
and integration take that provider as a port. The WASM module prepares the
candidate state and consumes the returned propagated state; JavaScript only
dispatches buffers and renders the resulting trajectories.
