# Foundation Numerics

`foundation/numerics` provides a standalone SDK-compliant C++/WASM module for SDS `NUM` numerical utility requests. Supported surfaces port Basilisk `avsEigenSupport` Newton-Raphson root solving for scalar functions, Basilisk `Saturate` component-wise vector clamping, Basilisk `Discretize` component-wise vector quantization, Basilisk scalar `linearInterpolation`/`bilinearInterpolation` helpers, and Basilisk bounded `GaussMarkov` sequence statistics.

## Build

```sh
npm install
npm run build
npm test
npm run test:sdk-compat
```

The `solve_scalar_root` method accepts `NUMRootSolveRequest` envelopes on the `request` port and emits `NUMRootSolveResult` envelopes on the `result` port. The `saturate_vector` method accepts `NUMVectorSaturateRequest` envelopes and emits `NUMVectorSaturateResult` envelopes. The `discretize_vector` method accepts `NUMVectorDiscretizeRequest` envelopes and emits `NUMVectorDiscretizeResult` envelopes. The `interpolate_scalar` method accepts `NUMScalarInterpolationRequest` envelopes and emits `NUMScalarInterpolationResult` envelopes. The `compute_gauss_markov_sequence` method accepts `NUMGaussMarkovRequest` envelopes and emits `NUMGaussMarkovResult` envelopes with post-warmup per-state mean, sample standard deviation, min/max, final state, and optional flattened sample-major states.
