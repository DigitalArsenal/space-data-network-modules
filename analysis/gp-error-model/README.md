# GP prediction-error model

Empirical SGP4 prediction error by orbit regime and prediction age, in RTN,
and the coverage tests that decide which strata's covariance is calibrated.

## Methods

### `accumulate`

Inputs:

- `elements`: size-prefixed `$OMM` records with SGP4 mean elements.
- `reference` (optional): `$OEM` reference states (GCRF, UTC).
- `model` (optional, needs `reference`): a model whose covariance each error
  is tested against.
- `options` (optional): JSON.
- `prior` (optional): an accumulator from an earlier batch.

Output: `accumulator` (JSON).

What it does:

- **Propagation:** each element set is propagated with SGP4 (Vallado 2020,
  WGS-72, opsmode `i`, the `propagator/sgp4` sources) to its comparison
  epochs. Prediction age is the comparison epoch minus the set's epoch, in UTC
  seconds, forward only.
- **Comparison state, without `reference`:** a later element set of the same
  object, at its own epoch, in TEME. For each set and age bin, only the first
  later set is used. These differences are not truth.
- **Comparison state, with `reference`:** each reference state (for example
  `analysis/reference-states` output), sampled at least `referenceStepSeconds`
  apart. SGP4's TEME output goes to GCRF through the `foundation/frames` axis
  engine (IAU 2006/2000A and the equation of the equinoxes). It is compared
  with every element set of that object up to the oldest age bin.
- **Error:** prediction minus comparison, in the comparison state's RTN axes
  (R radial, N orbit normal, T = N × R). Positions are in km and velocities
  in km/s.
- **Regime:** from the propagated set's eccentricity and its mean altitude
  (un-Kozai'd mean motion, WGS-72). Defaults:
  - LEO below 450, 450–600, 600–800, 800–1200 and 1200–2000 km;
  - MEO 2000–10000 and 10000–30000 km;
  - GEO 30000–40000 km;
  - beyond 40000 km;
  - eccentric (e ≥ 0.1).
- **Age bins (defaults):** 0–0.5, 0.5–1, 1–2, 2–3, 3–5 and 5–7 days.
- **Per stratum it accumulates:** the count, sums, second moments and signed
  log histograms (20 bins a decade). With `clip {k, strata [{regime, age,
  centre[3], scale[3]}]}`, the same moments are also kept for the samples
  whose position components lie within k scales of the centre.
- **Batches:** a `prior` accumulator with the same strata, mode and clip is
  added to, so a catalog runs in batches. Keep every set of an object in one
  batch.
- **Duplicates:** element sets of one object with epochs within 1 s are one
  set republished. The later record is kept.
- **Coverage (with `model`):** each sample's position error **e** is tested
  against its stratum's model position covariance C (clipped when present).
  The test is d² = **e**ᵀC⁻¹**e**, zero mean, against χ² with 3 degrees of
  freedom. Every sample counts. Kept per stratum: the count, Σd², the count
  inside each of the 1/2/3 σ ellipsoids, a 20-bin histogram of F(d²) and
  the distinct objects.

### `finalize`

Input: `accumulator`. Output: `model` (JSON). Per stratum:

- count;
- mean;
- covariance: the lower triangle of the 6×6 RTN position/velocity matrix,
  row-major (RR, TR, TT, NR, NT, NN, dR·R, …);
- quantiles at ±3, ±2, ±1 σ and the median;
- robust sigma, (q84.13 − q15.87)/2;
- when clipped: the clipped count, the fraction removed, and the clipped mean
  and covariance.
- with coverage:
  - the fractions inside 1/2/3 σ, mean d², the F(d²) histogram and its
    largest CDF gap;
  - the gate: CALIBRATED (1 and 2 σ within `tolerance`, at most
    `tailLimit` outside 3 σ, at least `minimumSamples` and `minimumObjects`),
    FAILED, or INSUFFICIENT. Defaults are 0.05, 0.01, 30 and 3, set by
    `options.gate`.

### `scale_model`

Inputs: `model`, `truth` (a reference-mode model from another window) and
`options` (`minimumSamples`, default 30). Output: `model`.

It scales each stratum's position covariance by s_k = √(E[e_k²] / C_kk),
using the clipped second moment of the reference errors about zero. It
records the factors. Strata with too few reference samples stay unscaled.

## Model and validation

`scripts/build-model.mjs` builds the model and its validation from the GP
history archive (read locally; element sets never leave the machine) and the
reference states:

```sh
node scripts/build-model.mjs --train-from 2026-07-12 --train-to 2026-08-08 \
  --reference <reference-states>/reference --reference-from 2026-08-09 --reference-to 2026-08-15 \
  --out <dir>
```

It runs both modes twice. The first pass sets each stratum's robust centre and
scale. The second clips at 5 robust sigma. It writes `model.json`,
`truth.json` and `validation.json` (truth σ ÷ model σ per stratum; a regime
without reference states is marked unvalidated).

The 2026-08 run is in `docs/`. Report: [docs/validation-2026-08.md](docs/validation-2026-08.md).
In brief:

- From 600 km up, under half a day, consecutive differences understate the
  true error 4–11× along-track. Consecutive fits share their error.
- Below 600 km they overstate it, by 10–90× beyond a day. Manoeuvring and
  decaying objects dominate those strata, while the passive reference
  satellites do not behave like them.
- GEO, beyond 40000 km and eccentric orbits have no independent truth.

## Calibration gate

`scripts/calibration-gate.mjs` fits `scale_model` on one reference week and
tests both the model and the scaled model on a later, held-out week:

```sh
node scripts/calibration-gate.mjs --model docs/model-2026-08.json --reference <reference-states>/reference \
  --fit-from 2026-08-02 --fit-to 2026-08-08 --test-from 2026-08-09 --test-to 2026-08-15 --out <dir>
```

It writes `calibration.json`, which labels each stratum:
- CALIBRATED only when the scaled model passes the gate on the test week,
  with the evidence as reference text;
- UNCALIBRATED otherwise, with the reason.

For 2026-08 ([docs/calibration-2026-08.md](docs/calibration-2026-08.md)),
five strata pass: LEO 600–800 km at every age except 0.5–1 day. Conjunction
assessment publishes covariance-based Pc as calibrated only in those strata.

## Build and test

```sh
npm ci
node build.mjs
node --test tests/*.test.mjs
```

Each test has an expected value that does not come from this module:

- Consecutive differences: python-sgp4 propagations of Vallado's 06251.
- Reference mode: Vallado SGP4-VER t = 0 states and their pyerfa GCRF
  transforms, with designed offsets.
- Quantiles and clipping: a normal design.
- Coverage: designed offsets with d² computed here, against χ²₃ table
  quantiles.
- Scaling: hand-built model and truth.
