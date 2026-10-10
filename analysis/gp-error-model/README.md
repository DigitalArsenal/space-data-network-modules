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

### `screening_evaluation`

Inputs: `elements`, `reference`, `model` (usually the scaled model) and
`options`. Output: `report`.

It pairs reference-state errors of two different objects in each stratum,
places them in a head-on and a 90° crossing encounter plane, and adds them to
synthetic true misses. Three screening rules are scored on every case:
- Foster Pc ≥ `pcThreshold`;
- the relative ellipse at `boundCoverage`;
- possibility: the per-object χ²₃ possibility, min-joined, alerting unless
  N(no collision) ≥ `necessityLevel`.

It reports alert rates, mean Pc and mean Π(collision) by stratum, geometry and
miss.

### `hpop_arcs` and `hpop_coverage`

They calibrate HPOP's covariance P(t) = Φ P₀ Φᵀ + Q for the CA HPOP screen's
product, analysis/epoch-state's GCRF state at an element set's epoch
propagated by propagator/hpop's resident force model. The host runs HPOP.

- **`hpop_arcs`** takes `elements`, `reference`, an optional `model` and
  `options`, and outputs a `plan`. For each element set it gives:
  - the reference epoch nearest each requested prediction age (for age 0,
    the first epoch after the set's epoch);
  - the reference state there;
  - with a model, P₀ rotated from RTN to GCRF (SI) and the regime's
    process noise.
- **`hpop_coverage`** takes `plan`, `predictions`, `model` and `options`, and
  outputs a `model` or a `report`. It has three modes:
  - `epoch`: P₀ per regime, the second moment about zero of the 6-D RTN
    errors at age 0, after a 5 robust sigma clip.
  - `fit`: white-acceleration densities (R, T, N) per regime by maximum
    likelihood, P = A + Σ qₖ Uₖ. A is HPOP's covariance from P₀ alone, and
    Uₖ is from P₀ = 0 with unit density on axis k (P(t) is linear in both).
  - `test`: zero-mean coverage by regime and age under the calibration gate,
    with P₀ alone alongside, plus RMS error and RMS predicted sigma per RTN
    axis.

### `screening_cases`

Inputs: `cases` (JSON: `pairs` of `{e1, c1, e2, c2}`, RTN position errors in
km and positive definite position covariances as lower triangles RR, TR, TT,
NR, NT, NN in km²) and `options` (as `screening_evaluation`). Output:
`report`. The same rules and geometries as `screening_evaluation`, on pairs
the caller draws, each object with its own covariance.

### `common_epoch`

Inputs: `elements`, `reference` (optional) and `options` (JSON `targets`).
Output: `differences`. For each target, the listed element sets of one object
are propagated by SGP4 to its epoch (backwards for a set after it), and each
one's difference from an origin is given in the origin's RTN axes (GCRF, km,
km/s, prediction minus origin), with its age. The origin is:

- `reference`: the object's reference state at the target; with
  `afterSeconds`, the first reference epoch in [epoch, epoch + afterSeconds];
- `mean`: the mean of the propagated states;
- `set`: one element set's propagated state (`originSet`).

### `map_covariance`

Inputs: `elements` (the anchor sets) and `options` (JSON `requests`). Output:
`covariance`. Each request maps a 6×6 RTN covariance (lower triangle, km,
km/s, in the RTN axes of the anchor's SGP4 state at `from`) to the `to`
epochs, C(t) = B Φ B₀ᵀ C₀ B₀ Φᵀ Bᵀ, B the RTN rotations of the anchor's
SGP4 state (TEME). Φ by `method`:

- `sgp4`: J(t) J(t₀)⁻¹, J the Jacobian of SGP4's state with respect to the
  nonsingular mean elements (n, e cos ω, e sin ω, i, Ω, M + ω) by central
  differences, B* held (the linearized SGP4 STM);
- `two-body`: Keplerian motion from the anchor's SGP4 state at t₀,
  complex-step differentiation of the universal-variable Kepler solution
  (the real anomaly by bracketed Newton, then complex Newton steps);
- `lambert`: Thompson, Gossner, Sais and Cunningham (2019): the two-body arc
  through SGP4's positions at the two epochs (Izzo's solver from
  `analysis/lambert-izzo`), N = floor(Δt / P) revolutions from SGP4's state
  at the earlier epoch, the branch whose energy is nearest SGP4's; Φ is the
  two-body STM on that arc (its inverse, for a target before t₀, taken
  symplectically) and each arc reports its perigee radius. Within a degree of the start inside the first
  revolution the arc is SGP4's osculating one; within a degree of 0 or 180
  degrees otherwise the target is refused.

With `stm: true` each target also carries Φ (TEME, row-major). With
`axesSet` the input covariance is in the RTN axes of that set's SGP4 state at
`from` (Thompson et al. rotate the final set's scatter with its own state).

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

## Screening evaluation

`scripts/screening-evaluation.mjs` runs `screening_evaluation` on a held-out
reference week and carries each stratum's calibration label:

```sh
node scripts/screening-evaluation.mjs --model docs/model-2026-08-scaled.json \
  --calibration docs/calibration-2026-08.json --reference <reference-states>/reference \
  --from 2026-08-09 --to 2026-08-15 --out <dir>
```

Results for 2026-08 are in
[docs/screening-evaluation-2026-08.md](docs/screening-evaluation-2026-08.md).
In the calibrated strata:
- possibility missed no collision, but raised 69–89 % false alerts at a 1 km
  miss;
- Pc missed 2.7 % of collisions head-on and 16 % in a crossing (dilution);
- the bounded set missed 0.2–0.4 %.

## HPOP covariance calibration

`scripts/hpop-calibration.mjs` runs the whole sequence. It measures P₀ on
the fit week, then runs HPOP four times per arc (P₀ alone, and unit noise on
each RTN axis). It fits Q on the fit week and tests coverage on the held-out
week:

```sh
node scripts/hpop-calibration.mjs --reference <reference-states>/reference \
  --fit-from 2026-08-02 --fit-to 2026-08-08 --test-from 2026-08-09 --test-to 2026-08-15 --out <dir>
```

Report: [docs/hpop-calibration-2026-08.md](docs/hpop-calibration-2026-08.md).

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
- `common_epoch` and `map_covariance` (`tests/covariance_mapping.test.mjs`):
  `tests/stm-reference.json`, written by `tests/stm-reference.py` from
  python-sgp4's pure-Python SGP4, pyerfa frames, a two-body propagator in the
  eccentric anomaly with Richardson-extrapolated central differences, and
  Newton shooting for the Lambert arc. SGP4 STMs agree to 1e-7, two-body and
  Lambert STMs to 1e-7 and 1e-6, common-epoch differences to 2 mm.
- `screening_cases`: Foster Pc in closed form at zero miss, and a fine polar
  grid for an offset anisotropic pair.

Tri-runtime parity of these methods: `PATH=$HOME/.wasmedge/bin:$PATH node
tests/parity.mjs` (browser, WasmEdge, Docker WasmEdge; report in
`conformance/parity.json`).
