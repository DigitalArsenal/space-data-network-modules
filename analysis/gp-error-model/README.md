# GP prediction-error model

Empirical SGP4 prediction error by orbit regime and prediction age, in RTN.
This module measures error. It does not calibrate a covariance, and it states
which strata independent evidence supports.

## Methods

### `accumulate`

Inputs:

- `elements`: size-prefixed `$OMM` records with SGP4 mean elements.
- `reference` (optional): `$OEM` reference states (GCRF, UTC).
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

## Model and validation

`scripts/build-model.mjs` builds the model and its validation from the GP
history archive (read locally; element sets never leave the machine) and the
reference states:

```sh
node scripts/build-model.mjs --train-from 2026-07-12 --train-to 2026-08-08 \
  --truth <reference-states>/reference --truth-from 2026-08-02 --truth-to 2026-08-16 \
  --out <dir>
```

It runs both modes twice. The first pass sets each stratum's robust centre and
scale. The second clips at 5 robust sigma. It writes `model.json`,
`truth.json` and `validation.json` (truth σ ÷ model σ per stratum; a regime
without reference states is marked unvalidated).

The 2026-08 run is in `docs/`. Report: [docs/validation-2026-08.md](docs/validation-2026-08.md).
In brief:

- Under half a day, consecutive differences understate the true error 4–11×
  along-track. Consecutive fits share their error.
- The gap closes to about 1× by 2–7 days.
- Only LEO 600–800 km and MEO have independent truth. Every other regime is
  unvalidated.

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
