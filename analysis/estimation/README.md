# Measurement-based orbit estimation

This module implements the ratified `estimation` harness family. The estimator
never selects a force model: its `propagator_samples` input is populated by the
caller-selected propagator through `plugin_propagate` and `plugin_compute_stm`.
The same module therefore fits HPOP, numerical, ephemeris-driven, or future
propagators without changing estimator code.

The C++ core owns all measurement physics, corrections, linear algebra,
simulation, filtering and smoothing. JavaScript wrappers only move ABI bytes.
`$ODR` is the canonical run report and `$OCM` carries the estimator covariance.

The `REFERENCE_PROFILE` ionosphere selection consumes total electron content
and its time derivative from the caller's IRI-class media provider. The guest
then applies the published P.531 range and Doppler conversion; no atmospheric
profile or provider is hardwired into the estimator.
