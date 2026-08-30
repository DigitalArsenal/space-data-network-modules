# Open SQP optimizer

This package contains the open sequential-quadratic-programming implementation
used by the maneuver-family Optimize / Minimize / NonlinearConstraint seam.
Objective and constraint values arrive from an evaluator callback; mission
propagation remains behind the caller-selected propagator port.

The implementation uses finite-difference linearizations, an active-set KKT
subproblem, a merit-function line search, and a damped BFGS Hessian update. It
does not load or emulate a proprietary optimizer.
