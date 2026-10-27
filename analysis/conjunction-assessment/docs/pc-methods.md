# Collision probability methods

The default `FOSTER-2D` computes the Gaussian probability integrated over
the combined hard-body disk in the encounter plane. Inputs to the C++
methods are miss components in km, covariance in km², and combined
hard-body radius in km. Covariances must be rotated into a common inertial
frame before combination and projection. Numerical results are
dimensionless probabilities.

For miss vector **m**, covariance **C**, and radius R, the default evaluates

```text
Pc = integral over |x| <= R of
     exp[-(x-m)' C^-1 (x-m) / 2] / (2*pi*sqrt(det(C))) dx.
```

The disk is unchanged by the covariance principal-axis rotation. The
implementation analytically integrates one normal coordinate with stable
error-function differences and adaptively integrates the remaining narrow
coordinate using an embedded Gauss–Kronrod rule. This is the full disk
integral, including when the hard-body radius is comparable to or larger
than a covariance sigma. The default CARA eigenvalue repair clips
eigenvalues below `(1e-4 R)^2` and reports remediation. The principal-axis
rotation uses `atan2` and stable eigenvalues; it does not discard small
off-diagonal terms through an absolute near-axis threshold.

## Method selection and interpretation

| Name | Computation and limitations |
| --- | --- |
| `FOSTER-2D` | Default adaptive Gaussian disk integral under the 2-D encounter assumptions. |
| `PC2D-SMALL-HBR-APPROX` | Explicit-only constant-density approximation `R² exp(-Md²/2)/(2 sqrt(det(C)))`. It can be inaccurate when R is comparable to a sigma. |
| `ALFRIEND-1999` | Existing selectable constant-density approximation; equivalent mathematical form to the explicit small-HBR approximation. |
| `ALFANO-SPHERICAL-SMALL-HBR-MAX` | Historical spherical small-HBR expression `R²/(e d²)`, with the existing unit-probability treatment when the nominal miss is within the radius. Requires no covariance. It is not an upper bound for an anisotropic covariance. Legacy input names `alfano` and `ALFANO-MAXPROB` remain accepted. |
| `PC2D-SHAPE-SCALED-MAX` | Maximizes the disk integral over positive scalar covariance multipliers while preserving the given covariance aspect ratio and orientation. Requires a valid positive-definite covariance shape. |
| `FRISBEE-SINGLE-COV-MAX` | CARA's Frisbee prescription when only one object's covariance is known; the input must contain that known covariance alone. The computed region is the HBR disk. |
| `FRISBEE-SINGLE-COV-EQUAL-AREA-SQUARE` | Same Frisbee covariance prescription, integrating a covariance-axis-aligned square with half-width `sqrt(pi/4) R`. This is the CARA optional square approximation. |
| `FRISBEE-SINGLE-COV-CIRCUMSCRIBED-SQUARE` | Same prescription, using a covariance-axis-aligned square of half-width R. The square contains the HBR disk for the resulting covariance. |
| `ALFRIEND-1999-MAX` | Existing small-HBR covariance-scale expression `R²/(e Md² sqrt(det(C)))`; it is not the exact finite-disk maximum. |
| `ALFANO-2005`, `LAAS-2015`, `CHAN-1997` | Existing numerical/series methods, now using the corrected covariance principal-axis geometry. |
| `PATERA-2001`, `ALFRIEND-2D` | Historical names retained for compatibility. These implementations use fixed polar midpoint quadrature. They do not implement Patera's published contour integral or Gauss–Legendre quadrature, and are not the adaptive default. |
| `2D-NC-HALL`, `3D-NC-HALL` | Expected collision entries using Hall's equinoctial peak-overlap model. The engine checks applicability before treating Nc as Pc. These are full-state fallback APIs, not disk-method factory choices. |
| `2D-NC-CARTESIAN`, `3D-NC-CARTESIAN` | Corresponding Cartesian covariance-propagation models, used for rectilinear encounters. Their names distinguish them from the equinoctial Hall model. |
| `SDMC-TWO-BODY`, `SDMC-RECTILINEAR` | Seeded full-state Monte Carlo over a finite observation interval, including overlap at its start. The explicit `-ENTRY-ONLY` variants exclude initial overlap to reproduce CARA's published counting convention. |

The historical `PcResult.max_probability` field in ordinary disk-method
results carries the spherical approximation for compatibility; it must not
be interpreted as a universal bound. Select `PC2D-SHAPE-SCALED-MAX` to
compute the maximum conditioned on the actual covariance shape.

## Covariance-scale maximum

`shape_scaled_maximum` returns both the maximum probability and the
multiplier of the covariance (not the sigma). It searches the logarithm of
the positive multiplier using bounded interval refinement. For d > R, all
stationary maxima lie between

```text
(d-R)^2 / (2 lambda_max) <= covariance_scale
                       <= (d+R)^2 / (2 lambda_min).
```

This bracket follows from differentiating each Gaussian density with
respect to the covariance multiplier: the derivative changes sign at
`scale = ((x-m)' C^-1 (x-m))/2`. For d < R, the supremum is one as covariance
tends to zero. At d = R, the limiting supremum is one half, because the
disk lies within the half-plane tangent at the mean. These limiting cases
return covariance multiplier zero.

For inverse scale beta, `Pc(beta)/beta` is a positive Laplace transform,
whose logarithm is convex. Chords between evaluated endpoints therefore
provide upper envelopes over entire scale intervals. The implementation
refines the highest envelope until it lies within 1e-9 relative of the
best computed probability. `upper_probability` exposes that envelope;
`probability` is the best evaluated value. This bounds the optimization
error across all scales, subject to the numerical disk quadrature error.
The scale search disables covariance eigenvalue clipping to preserve the
input shape and rejects non-positive-definite input shapes.

“Covariance-free” here means free of the absolute covariance scale only.
The result remains conditioned on shape, orientation, miss vector, and
HBR. It does not maximize over arbitrary covariance orientations or
aspect ratios.

## Frisbee single-known-covariance prescription

Let C be the known object's encounter-plane covariance and
`Ka² = m' C^-1 m`. When `Ka² > 1`, CARA adds the unknown object's rank-one
covariance `(1 - 1/Ka²) m m'`. Otherwise it uses the known covariance
unchanged. The module then integrates over the requested disk or square.

This follows NASA CARA's current `FrisbeeMaxPc.m` and `PcCircle.m`. The
rank-one prescription originates from maximizing density at the miss
point. Evaluating the finite disk at that covariance does not establish
the exact maximum over all possible missing covariances. The module
retains the established Frisbee method name and documents this limitation
rather than treating the result as a proven finite-HBR upper bound.

## Verification and provenance

The small vendored vectors live in `src/cpp/tests/fixtures/`, with NASA
CARA attribution, source filenames and lines, units, frames, epochs, and
original tolerances. MATLAB source, CDMs, `.mat` files, and PDFs remain in
the ignored local `.oracle` checkout. Python scripts use the offline
NumPy/SciPy environment and independently port the reference mathematics.

`test_pc_maximum` verifies all 58 circle/equal-area-square numeric cases
from CARA `FrisbeeMaxPc_UnitTest` tests 12–27. The circle examples retain
the published absolute tolerance 5e-7 and the populated-secondary
comparison relative tolerance 1e-4. The square examples retain the
upstream relative tolerance 1e-2. It also checks eight independent SciPy
maxima at sigma aspect ratios 3, 10, 100 and 1000, including rotated
covariances, and bounds a 1601-point logarithmic covariance-scale scan for
each. See `NOTICE-frisbee.md` for tolerance rationale.

Regenerate the Frisbee and shape-scale vectors offline from the worktree
root:

```sh
.oracle/venv/bin/python analysis/conjunction-assessment/scripts/regen-cara-frisbee-fixtures.py
cmake --build .oracle/build --target test_pc_maximum -j8
.oracle/build/test_pc_maximum
```

The public boundaries continue to use the existing SDS FlatBuffers and
exported module ABI. A boundary enum cannot be extended locally to encode
new method names: use the existing SDS method/metadata fields supported
by the particular output, preserving the actual method string where a
text field exists. Consumers must not infer that every internal method
has a distinct pre-existing SDS enum member.

## Engine inputs, routing and output formats

The engine rotates both objects' RTN position covariances into their common
inertial frame before computing either the encounter-plane geometry or the
3-D Mahalanobis distance. `make_pc_encounter` also rotates all four 3x3 blocks
of each full position/velocity covariance. Source covariance and CDM calls
preserve those velocity blocks rather than dropping them before assessment.
The uncalled alternative `collision_probability()` implementation was removed.

`PcEncounter` supplies two inertial six-component states, two row-major 6x6
covariances, HBR, common epoch, and gravitational parameter (km, seconds).
Position-only callers retain an explicit incomplete usage-check status.
Relative speeds below 1e-10 km/s are flagged `LOW_RELATIVE_SPEED`; there is no
invented 1 m sigma. A violating position-only event reports `PC-UNAVAILABLE`
because a full-state fallback needs velocity uncertainty.

Between-object cross-correlation is off by default. Enabling
`apply_cross_correlation` uses the caller's `Cov(primary,secondary)` matrix
and combines relative covariance as `C1+C2-C12-C12'`. The event reports the
change in covariance trace and Pc. This option removes common correlated
error; it does not set the off-diagonal entries within either object's
covariance to zero. The CARA fixture cases derive the supplied cross matrix
from density sensitivity as in `Pc_CovXCorr.m`.

The existing SDS CQR enumeration has no entries for the new maximum,
Frisbee, Nc, or SDMC method names and no usage-reason/Monte-Carlo confidence
fields. Native C++ APIs expose these methods. CQR source assessments perform
the same routing. When the result cannot be represented by the enum, the
event omits `PROBABILITY`; its embedded `CONJUNCTION_MESSAGE` carries the
actual method and result, or an explicit calculation-failure comment. The
event retains each available source covariance's basis and RTN sigmas,
and the full interpolated 6x6 covariance remains in that CDM. A valid 3-D
Mahalanobis distance is retained independently of Pc success. A singular
or non-positive-definite relative position covariance has no reported
Mahalanobis distance, rather than a fabricated zero. Empirical-model events
follow the same output rules and retain their distinct provenance.
Fallbacks are never labeled as `FOSTER` or replaced by a covariance-free
statistic. Ordinary encounters still report their covariance-based Pc.
No local schema or exported invoke function was added. An upstream SDS
extension is required to expose those new choices and diagnostics in CQR.
The cross-correlation matrix option is currently a native C++ API option;
existing CQR inputs cannot carry it.

### Usage checks and fallback interpretation

The usage check starts with the relative position covariance C and relative
state r, v. The rectilinear Gaussian overlap has center
`tc = -(r' C^-1 v)/(v' C^-1 v)` and width
`sigma_t = 1/sqrt(v' C^-1 v)`. CARA's extent factor 8.304785425194112
corresponds to its `gamma=1e-16` duration criterion. For orbital encounters,
iterative three-point curvature of
`Q(t) = r(t)' C(t)^-1 r(t) + log(det(C(t)))` refines the peak and estimates
the curvilinear probability correction using equinoctial Gaussian propagation.
The reported CARA violations are duration/shorter-orbital-period above 0.02,
offset/period above 0.01, and the Q-derived correction above 0.02.
Failure to establish a peak is also reported. An additional conservative
safeguard flags one-sigma relative-velocity uncertainty above 10% of speed;
this threshold is explicitly separate from CARA's Q-derived indicators.

Automatic routing attempts 2D-Nc, then 3D-Nc, then Monte Carlo. Each stage must
pass numerical convergence and applicability checks. The 2D-Nc check uses the
Gaussian sphere-rate mixture's time moments, including finite-HBR shifts, to
calculate duration and offset. It also compares the sphere integral with a
Foster disk integral using the peak-overlap covariance and conditional velocity
at the collision-sphere center. The CARA 2D-Nc cutoffs are 0.05 for
duration/shorter-period, 0.1 for offset/period and 0.1 for the symmetric relative
difference between the two estimates. These differ from the 2D-Pc cutoffs.
See the pinned [CARA PcMultiStep implementation](https://github.com/nasa/CARA_Analysis_Tools/blob/ce0f00722c56808755ee0adbe47a4e3d56439484/DistributedMatlab/ProbabilityOfCollision/PcMultiStep.m)
and [effective-plane/time-moment calculation](https://github.com/nasa/CARA_Analysis_Tools/blob/ce0f00722c56808755ee0adbe47a4e3d56439484/DistributedMatlab/ProbabilityOfCollision/Pc2D_Hall.m).

An unresolved quadratic peak, nonpositive sphere-point time curvature or
negative extrapolated squared Mahalanobis distance rejects the 2D series and
escalates to 3D. Angular convergence alone cannot accept the series. For an
automatically estimated window, 3D-Nc also rejects unresolved peak bounds,
duration/period above 0.05, offset/period above 0.75, or non-negligible terminal
occupancy. The existing initial-occupancy and recrossing checks still apply.
Invalid inputs remain errors. Explicit 3D or Monte Carlo policies start at the
requested stage; an explicit 2D-Nc policy still escalates an unusable estimate.
Native results and CDM comments retain the stage history, 2D-Nc indicator values,
actual observation bounds, covariance repair and final method.

Sphere integration currently uses independently refined product quadrature.
It is not Lebedev quadrature. The final sampler is finite-window SDMC with
two-body dynamics (or explicit rectilinear dynamics), not high-fidelity BFMC.
An active boundary causes escalation but does not prove that all encounters
outside the observation window have been captured. This implementation does
not claim the complete CARA multistep/BFMC pipeline.

The Hall implementations propagate the full state covariance in equinoctial
coordinates with iterative peak-overlap linearization. The 3D method
integrates inward Gaussian flux over the collision sphere and observation
time. Time quadrature and sphere quadrature have separate convergence checks.
Nc is an expected number of entries: initial occupancy and repeated crossings
can make it different from the probability of at least one collision. The API
returns `expected_collisions` and `requires_monte_carlo` separately from
numerical convergence. The engine honors that applicability flag.

Monte Carlo samples the joint 12-dimensional Gaussian, including the optional
cross covariance. SplitMix64 and Box–Muller provide deterministic samples.
Each sample uses two-body Kepler propagation or explicit rectilinear motion,
with minimum-distance searches over the finite window. A pericenter-based
subdivision limit prevents unresolved long windows from being reported as
successful estimates. The result includes sample, initial-overlap, entry, and
total-hit counts plus a 95% Wilson interval. Zero hits still gives a nonzero
upper confidence bound. The default 65,536 samples cannot establish very small
Pc precisely; callers must choose a sampling budget appropriate to their
decision threshold.

Both time bounds zero selects the full CARA duration estimate only when its
peak/curvature assessment succeeded. A failed refinement cannot reuse a narrow
rectilinear window and report a falsely converged near-zero integral. When no
reliable duration exists, the sampler uses plus/minus half the shorter orbital period,
or plus/minus 3,600 seconds for unbound motion. Explicit bounds are seconds from
the supplied common epoch. These are finite-window, two-body results;
perturbation-model uncertainty is outside this implementation.

### Sequential escalation verification

`node tests/ncCascade.e2e.mjs` builds the actual native C++ library and reads the
public CARA full-state fixtures. It checks eight usage classifications, the
six converged 2D-Nc references (relative tolerance 1e-4), all 12 published Hall
3D-Nc references (their original 1e-3 tolerance), and automatic method selection.
A finite-window velocity-dispersed Gaussian disk verifies 2D-to-3D escalation;
a static Gaussian sphere verifies initial-occupancy escalation to SDMC against
the closed-form Maxwell CDF. The two rare-event CARA sampling comparisons use
a declared binomial acceptance allowance, not the precision of the published
large-sample runs. A zero sample count of collisions retains a nonzero upper
confidence bound. The same runner then exercises the built CQR artifact's
covariance and method output through browser WASI and native WasmEdge.

### Low-velocity output verification

`node --test tests/lowVelocityCovariance.test.mjs` exercises the same built
artifact through the browser WASI harness and native WasmEdge. It screens
two synthetic TEME OEM tracks with interpolated full covariance, verifies
the closed-form 3-D Mahalanobis result through pair and catalog assessment,
and round-trips all 21 covariance elements through CDM KVN and XML. Singular
covariance produces neither a probability nor a spurious zero Mahalanobis
measurement. An ordinary centered encounter is checked against the analytic
isotropic Gaussian disk integral. This verifies uncertainty preservation;
it does not establish BFMC capability or validate a new escalation algorithm.

The published CARA Monte Carlo references count first entries and exclude
objects overlapping at the initial time without renormalizing the probability.
Set `include_initial_overlap=false` to select that convention. The application
default includes both initial overlaps and subsequent first entries. Method
names and separate counts preserve this distinction.

Ordinary CQR Pc results no longer expose the spherical small-HBR diagnostic
as `MAXIMUM_PROBABILITY`. Explicit historical maximum requests retain their
existing enum. The direct CQR Foster disk request supports finite NPD
covariance with CARA repair; other methods and source-record ingestion
retain their existing positive-semidefinite input gates.

CDM's method string and object COMMENT fields can preserve actual methods,
usage reasons, covariance repair, cross-correlation effects, and Monte Carlo
sample counts and 95% Wilson intervals. CSM has only its historical unlabeled
`MAX_PROB` field: covariance events or events needing diagnostics are rejected
rather than losing their meaning. No-covariance CSM output retains its legacy
spherical statistic.

CDM export uses SANA names where the algorithms match: `ALFANO-MAX-PROBABILITY`,
`CHAN-1997`, `ALFANO-2005`, `FOSTER-1992`, and `ALFRIEND-1999`.
The legacy polar Patera implementation is exported as `PATERA-LEGACY-POLAR`,
not the registered contour-method name `PATERA-2001`. Unregistered names,
including `LAAS-2015` and `ALFRIEND-2D`, carry an explicit relative-metadata
COMMENT. Existing probability-input aliases remain accepted.

## Offline verification and integrator checks

Run from the worktree root:

```sh
.oracle/venv/bin/python analysis/conjunction-assessment/scripts/regen-cara-pc-fixtures.py
.oracle/venv/bin/python analysis/conjunction-assessment/scripts/pc-dblquad-oracle.py
cmake --build .oracle/build --target test_pc_methods -j8
.oracle/build/test_pc_methods
cmake --build .oracle/build -j8
ctest --test-dir .oracle/build --output-on-failure
```

The regeneration script reads only the local `.oracle/CARA_Analysis_Tools`
checkout and invokes the independent Frisbee and dblquad references. Build
products and full validation logs belong in ignored `.oracle/`, never in the
source or fixture directories.

`build.mjs` accepts the repo-local toolchain through `SDN_LOCAL_EMSDK_DIR`
without git discovery. Its source list includes all split files. The native
reference checks above are distinct from the WASM CDM conformance E2E:
`node tests/cdmCcsdsConformance.e2e.mjs` validates the rebuilt artifact against
CCSDS XML schemas, the standard's KVN tables, SANA names and Orekit.

`tests/cqrAuthoritative.test.mjs` adds a Foster high-Pc closed-form regression;
its existing `FOSTER`, `LAAS_2015` and other CQR enum spellings remain unchanged.
The integrator should run it along with Pc/name-related tests:
`cqrStreaming.test.mjs`, `direct-entry.test.mjs`,
`empiricalCovariance.test.mjs`, `ephemerisUpload.test.mjs`,
`gpuScreenParity.test.mjs`, `sdnOmmPartitionedRunner.test.mjs`,
`signedCdmOutput.test.mjs`, `socratesScreenCatalogParity.test.mjs`,
`sourceCovariance.test.mjs`, `wasmedgeStandaloneHarness.test.mjs`, and
`windowedScreenParity.test.mjs`. Related helper expectations live in
`tests/lib/caParityTolerances.mjs` and `tests/lib/tiledPairSolver.mjs`.
The browser/WasmEdge/Docker parity harnesses were intentionally not run here.

The native validation includes 21 Foster/correlation/NPD references (maximum
relative error 4.708071317825e-4, all within each source's tolerance), 20
independent SciPy `dblquad` geometries (maximum relative error
2.657747556478e-11 against the requested 1e-4), all 12 published Alfano Hall
3D cases (maximum relative error 5.45403159705e-4 against 1e-3), six Hall 2D
spreadsheet values (maximum relative error 1.73028798977e-5 against 1e-4), and
eight CARA usage classifications. All 58 Frisbee values meet their original
tolerances. Eight shape-scale maxima match independent SciPy optimization
within 8.61876459091e-10 relative and bound their 1601-point scale scans.

All 12 Monte Carlo comparisons pass the declared sampling-aware Bernstein
acceptance intervals: 32,768 samples per case, except 262,144 for the rare
case 7. This demonstrates statistical consistency with the published
100-million-trial references, not matching their precision or their original
sampling configuration. The fixture NOTICE specifies the 1% family-wise
sampling-error budget and the reference confidence intervals.
