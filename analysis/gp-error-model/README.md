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
propagated by propagator/hpop at full force (`propagator/hpop/catalog.mjs`,
the screen's configuration, with the space weather released on the element
set's day). The host runs HPOP (`scripts/hpop-calibration.mjs`).

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

### Covariance realism by data source (orbit-accuracy-experiments E14)

Units are SI (m, m/s; m², m²/s, m²/s²). Lower triangles are row-major RR,
TR, TT, NR, NT, NN (and dR R, … for 6 × 6).

- **`pair_statistics`** (`pairs` → `statistics`). Each pair is a predicted
  and a truth state (inertial, one frame), each with a covariance in RTN
  (also `UVW`, the same axes) or inertial axes. Output: the error, predicted
  minus truth, in the RTN axes of the predicted state (or the truth's,
  `axesFrom`), both position covariances in those axes, d² against the
  combined covariance and against the predicted one alone, and per-axis
  z = e/σ. A side may instead be ephemeris `samples` and an `epoch`:
  position and velocity by Lagrange interpolation through the
  `interpolationDegree` + 1 samples nearest the epoch (the container's rule),
  the covariance linear between the two samples that bracket it; an epoch
  outside the samples gives the pair `missing`, never an extrapolation.
  A side's covariance may be `covarianceTerms`, a weighted sum of covariances
  in one axes (for example HPOP's A plus q-weighted unit-noise responses).
- **`fit_calibration`** (`samples`, `options` → `calibration`). Samples
  (stratum, RTN error, RTN position covariance, object). Per stratum a
  variance factor: `scalar-mle`, k² = mean d²/3 (the maximum-likelihood
  common scale); `coverage`, k² = the d² quantile at `coverage` (type 7)
  over its χ²₃ value; `axes-mle`, s_k² = mean(e_k²/P_kk) per axis (the
  marginal maximum likelihood), applied as P' = S P S. Mean d²/3 and the 95 %
  coverage before and after.
- **`calibrate_covariance`** (`model`, `objects`, optional `elements` →
  `covariance`). A frozen model applied to objects:
  - `e14-factors`: strata by regime (or `*`) and horizon `[lo, hi)` days,
    each a common factor or per-axis factors with a status, applied to the
    object's native covariance as S P S, S = diag(s_R, s_T, s_N, s_R, s_T,
    s_N) (velocity rows scale with their position axes);
  - `e14-element-set-model`: per regime and age bin a 6 × 6 RTN second
    moment (km, km/s) and a factor, linear in age between the centres of
    bins with at least `minimumBinSamples`, held beyond them.

  An object's regime is given, or that of the element set it names
  (`elements`, this module's rule), or from its state's osculating elements
  (WGS-84). An `objectFactor` multiplies the covariance. Output: the
  covariance in RTN and, given a state, in inertial axes, the cell, the
  cell's status and the model's calibration version.
- **`dcp_covariance`** (`request` → `dcp`). The density-forecast consider
  term (an open Dynamic Consider Parameter, Hejduk 2019). Daily ln-density
  forecast errors by lead day have covariance C (K × K); `segments` map times
  to lead days; from the forecast start s₀ to t a constant error acts on the
  along-track position with weight 2(t − s)/(t − s₀)², so lead l weighs
  w_l = Σ ((t − a)² − (t − b)²)/(t − s₀)² over its segments [a, b] clipped to
  [s₀, t] (5/9, 3/9, 1/9 at three whole days); σ_eff² = wᵀCw and
  P = σ_eff² g gᵀ, g the sensitivity to ln B from s₀: given, or
  B (S(t) − Φ(t) Φ(s₀)⁻¹ S(s₀)) from HPOP's STM and B columns (`startSample`).
  With a `base` covariance the total is returned too.

- **`noise_responses`** (`request` → `responses`). HPOP's white-acceleration
  process noise (each target's arc cut into n equal steps no longer than
  the discretization; each step adds q[[h³/3, h²/2], [h²/2, h]] on one RTN
  axis at its end; later STMs carry it) for unit density on R, T and N, from
  one propagation's own STM sampled at every step end:
  U_k(t) = Σ_j Φ(t, t_j) G_jk G_jkᵀ Φ(t, t_j)ᵀ, Φ(t, t_j) = Φ(t) Φ(t_j)⁻¹. One
  run with a dense STM replaces three runs with unit noise.

Tests (`tests/covariance_realism.test.mjs`) use designed inputs with
closed-form answers: d² of diagonal cases and its invariance under a rotation
of the whole case; a quintic reproduced exactly by degree-5 interpolation; factors of designed samples; diagonal scalings, the RTN to
inertial rotation and the midpoint of two bins; Hejduk's weights and
σ_eff = √(wᵀCw); the start-relative sensitivity for designed matrices; a free
particle's noise responses equal q[[t³/3, t²/2], [t²/2, t]] exactly.

### `fit_elements`

Inputs:

- `ephemeris`: `$OEM` (size-prefixed or not, any number of streams).
  - Each block needs `OBJECT.NORAD_CAT_ID`, `REFERENCE_FRAME` TEME, GCRF, ICRF, EME2000 or J2000, and `TIME_SYSTEM` UTC, TAI, TT or GPS (converted to UTC through ERFA's leap-second table).
  - States come as lines or in the compact form (`STEP_SIZE`, `STATE_VECTOR_SIZE` 3, 6 or 9). A line whose velocity is all zeros has no velocity.
  - Covariance lines at a state's epoch are its covariance, in `COV_REFERENCE_FRAME` (absent: the state frame; RSW, RTN, RIC or UVW: the state's own axes).
  - Every state goes to TEME: EME2000 through the IAU 2006 frame bias, then GCRF through `gcrfToTeme` (IAU 2006/2000A and the equation of the equinoxes).
- `elements` (optional): a priori `$OMM` sets, the B* source or the starting elements.
- `options` (JSON):
  - span: `from`, `to`;
  - `epoch`: `first`, `last`, `middle` or an ISO instant;
  - `stepSeconds`: thins the fitted states;
  - B*: `fitBstar`, `bstar` (a number or `apriori`);
  - weights: `weighting` (`uniform`, `rtn` with `sigmaRtnKm`, or `covariance`), `velocity` with `sigmaVelocityKmS`, `halfLifeHours` with `towards`;
  - solver: `maxIterations` (100), `tolerance` (1e-10), `floorKm` (1e-6), `initial` (`ephemeris` or `apriori`), `rejectSigma`, `scaleCovariance`;
  - output: `closure` (true), `residuals`, `ephemerisStream`;
  - OMM metadata;
  - `fits[]` with per-object overrides.

Outputs: `elements`, one size-prefixed `$OMM` per converged fit; `report` (JSON).

Method:

- **Least squares.** Weighted least squares on model minus ephemeris (positions, and velocities when asked) in TEME. The model is SGP4 (Vallado 2020, WGS-72, opsmode `i`).
- **Parameters.** Equinoctial mean elements: n (Kozai, rad/min), af = e cos(ω+Ω), ag = e sin(ω+Ω), χ = tan(i/2) sin Ω, ψ = tan(i/2) cos Ω, λ = M+ω+Ω. B* is optional.
- **Solver.** Levenberg-Marquardt on the Jacobi-scaled normal equations, with a central-difference Jacobian.
- **Convergence.** Either an undamped step lowers the weighted cost by a relative `tolerance` or less, or no step lowers it at a stationary point. Stationary means the Gauss-Newton predicted decrease is at most 1e-6 of the cost, or the position RMS is at most `floorKm`.
- **Start.** The osculating elements of the state nearest the epoch, refined to mean elements by matching SGP4's own osculating elements there (osculating-to-mean inversion).
  - Below 3° osculating inclination, SDP4's cost has several basins in (χ, ψ). There the fit also starts from the osculating vector and from copies scaled by 1/4, 1/2 and 1 and turned by 0, 90, 180 and 270°, and keeps the lowest cost.
  - Spans grow four-fold from one period around the seed. B* joins in the last stage.
- **Statistics.** Taken on every state of the span (no thinning, no rejection): N, span, 3D RMS, per-coordinate RMS, R/T/N RMS and means, maxima, and the velocity RMS.
  - The per-coordinate RMS (3D / √3) is the convention of CelesTrak's SupGP rms files. On the NASA ISS OEM, CelesTrak's sets scored over their 6-hour segments match the published values to 0.002 km.
- **Closure.** The same fit on the first ⌊N/2⌋ states by time, scored on every remaining state: split epoch, N, RMS and maxima.
- **Covariance.** s² (JᵀWJ)⁻¹, reported in equinoctial and classical elements and as the RSW Cartesian covariance at the epoch. The RSW covariance also goes into the OMM's `COVARIANCE`.

### `element_residuals`

Inputs: `elements` (`$OMM`), `ephemeris` (`$OEM`, as above), `options`.

- Options: `requests[]` with `norad`, `set` (epoch) and `windows[]` (`from`, `to`, `label`), plus `stepSeconds`, `ephemerisStream` and `samples`.
- Output: `residuals`. Each set is propagated by the same SGP4 to every ephemeris state in each window, with the same statistics (prediction minus ephemeris).

## Covariance for every object: `attach_covariance`

The catalog pipeline gives every object's product a covariance by the first of
four rules that applies, writes it into SDS records with its CVR (covariance
realism) and names the source in PROVENANCE (PVN). The method is the same
whatever the source.

| Rule | Covariance | Applies when |
| --- | --- | --- |
| 1 | The operator's, as supplied | The operator's `$OEM` carries covariance lines (`COVARIANCE_MATRIX_LINES`) in RTN-family axes (RTN, RSW, RIC, UVW) or in the state's own axes |
| 2 | A fit's formal covariance times the realism factor measured for the source and fit class | A fit's `$OCM` carries covariance and the recipe has a measured `realism` entry for the source and `fitClass`. Formal covariances of laser-range fits measured 16 to 21 times too small (E6), so the factor is that measured mean d²/3 |
| 3 | The source's own model of its element sets' error, by regime and age | The element set is SGP4, in a regime the model covers, and a model lists the source in `sources` |
| 4 | The model pooled over all sources | As rule 3, for a source no model lists, and a model has `pooled: true` |

Rules 3 and 4 cover every object that has an SGP4 element set in a regime the
model covers. A set outside every regime (beyond 40,000 km with e < 0.25),
in a regime without strata (HEO today), or SGP4-XP is published with no
covariance and the reason. SGP4-XP sets pass through until the XP propagator
and an XP error model land.

**Models.** E14's S3-KC (`data/e14-s3-kc.json`, written by
`scripts/export-recipe-model.mjs` from `orbit-accuracy-experiments`
`results/e14`): per regime (LEO-L, LEO-M, LEO-H, MEO, GEO) and age bin
([0, 0.25), [0.25, 0.75), [0.75, 1.5), [1.5, 2.5), [2.5, 4), [4, 6) and [6, 8)
days, which hold the horizons 0, 0.5, 1, 2, 3, 5 and 7), the 6×6 RTN second
moment of SGP4 errors against precise orbits, clipped at 5 robust σ and scaled so the
development fit's 95 % coverage is 0.95. The covariance at an age is linear
in age between bin centres and held at the first and last. Each cell also
carries its held-out verdict on E14's test window (2026-05-01 to 2026-09-30):
mean d²/3, 95 % coverage, samples, objects, and REALISTIC or not.

**Verdicts.** A row's CVR is `Calibrated` only where the numbers of its cell pass
the rule on the held-out window: mean d²/3 in [0.8, 1.25] and 95 % coverage in
[0.93, 0.97], from at least 30 samples of at least 3 objects, **and** the model
was measured on the lineage the source belongs to (`source.lineage` is in the
model's `measuredOn.lineages`). The module computes the verdict from the numbers;
a verdict written in the model file does not decide. Otherwise the CVR is
`Uncalibrated`, with the cell's numbers: the cell failed, or the model was never
measured on this source's lineage (the pooled model of a new source; the CVR's
`MEASURED_LINEAGE` is then the lineage the cell was measured on). E14 found two of
the 35 cells realistic: LEO-H at 0 and 0.5 days. An operator's covariance is
`Uncalibrated` (E14 S1 has not reported), and so is a rule 2 covariance: the
numbers of its realism entry are the test of the formal covariance, before
scaling, and the scaled covariance has not itself been tested.

**Records.** Per object, one `$OCM` and one `$OMM` (SDS 1.246.0):

| Field | `$OCM` | `$OMM` |
| --- | --- | --- |
| State | `STATE_DATA`, `STATE_EPOCHS`: the rows of `states`, the operator's, or the fit's | the element set unchanged |
| Covariance | `COVARIANCE_DATA`, 21 values per row (lower triangle, km², km²/s, km²/s²), `COV_REF_FRAME` RSW for a modeled covariance, as supplied for an operator's | `COVARIANCE` of the row nearest the epoch in RTN, `COV_REFERENCE_FRAME` RSW |
| Realism | `COV_REALISM`: one CVR per row, in the order of `STATE_EPOCHS`; `COV_CALIBRATION`: Calibrated only if every CVR is; `COV_CALIBRATION_REFERENCE`: the first row's `EVIDENCE` | `COV_REALISM`: the CVR of the row the covariance is of; none for a set without a covariance (the report says why) |
| Source | `PROVENANCE`: `SOURCE_ID`, `SOURCE_KIND`, `ORIGINATOR`, `PROVIDER_ID`, `PRODUCER`, `LICENSE_CLASS`, `LICENSE_ID`, `LINEAGE` | the same `PROVENANCE` |
| Message's creator | `HEADER.ORIGINATOR` and `METADATA.TECH_ORG`: the recipe's `producer` | `ORIGINATOR`: the recipe's `producer` |

A CVR holds `RULE` (1 to 4: Operator, ScaledFit, SourceModel, PooledModel),
`MODEL_ID` (the model, or for ScaledFit the realism entry's class), `REGIME`,
`AGE_DAYS`, `HORIZON_DAYS`, `MEASURED_LINEAGE`, `TEST_WINDOW` (an ISO 8601
interval), `MEAN_D2_OVER_3`, `COVERAGE_95`, `SAMPLES`, `OBJECTS`, `SCALE_FACTOR`,
`CALIBRATION` and `EVIDENCE`. Fields a rule has no value for are NaN, 0 or empty.
Nothing about the source or the covariance rides in `USER_DEFINED_PARAMETERS`,
`COMMENT` or `TAGS`.

The report lists, per object, the rule that applied, why each earlier rule did
not, every row's cell and verdict, the SHA-256 of each record, and the
licence. It is where the reason a set got no covariance is. The module only labels: a record whose source has no reproduction
terms is computed on and cited, never republished, and the publishing node
reads `licence` from the report.

Inputs: `elements` (`$OMM`), `states` (`$OEM`, from
`analysis/epoch-state` `derive_omm` with `options.ages`), `operator` (`$OEM`
with covariance), `fit` (`$OCM`), `recipe` (JSON). `recipe` is version 1:

```json
{
  "version": 1,
  "source": {"id": "celestrak-gp", "kind": "element-set", "lineage": "space-track-gp",
             "originator": "CelesTrak", "provider": "com.digitalarsenal.data-source.celestrak-reference",
             "licence": {"class": "cite-only", "id": "celestrak"}, "fitClass": ""},
  "producer": "SDN catalog pipeline", "created": "2026-10-11T00:00:00Z",
  "latestOnly": true, "maxOperatorRows": 8,
  "realism": [{"sources": ["ilrs-crd"], "class": "slr-hpop-fit", "factor": 17.04, "meanD2Over3": 17.04,
               "coverage95": 0.17, "samples": 1000, "objects": 5, "evidence": "...", "window": "..."}],
  "models": [{"...": "data/e14-s3-kc.json", "sources": ["celestrak-gp"], "pooled": true}]
}
```

`provider` is the plugin id of the module that gave the records, `licence.class`
the `reproduce` field of the audited licence register and `licence.id` its source id.
`kind` is `element-set`, `ephemeris` or `observation` (PVN `SOURCE_KIND`), and
`licence.class` is `reproducible`, `cite-only`, `share-alike` or `non-commercial`
(PVN `LICENSE_CLASS`); any other value is refused. `producer` is the software that made
the records. `flows/source-products/recipe.mjs` makes the recipe of each registered source.

Only the newest element set of each object gives outputs unless `latestOnly`
is false. A recipe that does not name the source (id, kind, originator,
provider, licence class) is refused: no record travels without its source.

## `attribute_maneuvers`

Every maneuver of `analysis/maneuver-detection` gets the recipe's source in its
`PROVENANCE` (`SOURCE_ID`, `SOURCE_KIND`, `ORIGINATOR`, `PROVIDER_ID`,
`LICENSE_CLASS`, `LICENSE_ID`, `LINEAGE`). Its `PRODUCER` stays the detector when the
record names one (`analysis/maneuver-detection` does), else it is the recipe's
`producer`. The record's tags are untouched.

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
- `fit_elements` and `element_residuals` (`tests/fit_elements.test.mjs`):
  `tests/fit-reference.json`, written by `tests/fit-reference.py` from
  python-sgp4, pyerfa and scipy's Levenberg-Marquardt in classical elements:
  - Vallado's published SGP4 verification states (11 cases) give back their elements;
  - ten seeded random element sets across LEO, MEO, GEO, Molniya and GTO, spans, samplings and frames give back their elements, and half the data predicts the other half within 1 cm;
  - on 50 m noise, the module reaches scipy's optimum, RMS and covariance;
  - on the NASA ISS OEM fixture of `analysis/od`, scipy's fit, and CelesTrak's Segment-01 set scored as python-sgp4 scores it.
    CelesTrak's sets have no reuse licence, so that set is a private fixture (`SDN_MODULES_PRIVATE_FIXTURES`, `tests/lib/privateFixtures.mjs`), not in the tree; the check is skipped where the variable is not set.
  - Sources: Vallado, Crawford, Hujsak and Kelso (2006), Revisiting Spacetrack Report #3, AIAA 2006-6753 (SGP4-VER.TLE, tcppver.out); ISS trajectory, NASA JSC Flight Operations Directorate (TOPO), a U.S. Government work; CelesTrak (T. S. Kelso), https://celestrak.org.

Tri-runtime parity of these methods (E14's four, `attach_covariance`,
`attribute_maneuvers`, `fit_elements` and `element_residuals` included):
`PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs`
(browser, WasmEdge, Docker WasmEdge; report in `conformance/parity.json`).

`tests/source_products.test.mjs` checks `attach_covariance` against numbers
that do not come from the module: the model file's strata and the held-out
verdict of each cell, interpolation in age between bin centres, supplied
covariances returned exactly, their rotation to RTN done independently, and
the formal covariance times the recipe's factor.
