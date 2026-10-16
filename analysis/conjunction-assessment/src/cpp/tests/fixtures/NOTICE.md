# NASA CARA numerical fixtures and independent disk integral

The `cara_*.csv` fixtures contain selected numerical test vectors derived from
NASA CARA Analysis Tools, https://github.com/nasa/CARA_Analysis_Tools, distributed
under the NASA Open Source Agreement (NOSA). Copyright (c) 2019–2025 United
States Government as represented by the Administrator of the National
Aeronautics and Space Administration. All Rights Reserved. The upstream source
and full license remain in the offline `.oracle/CARA_Analysis_Tools` checkout.
No MATLAB source, workbook, `.mat` file, or PDF is vendored here.

Each CSV's `source` field records the upstream file and relevant line or workbook
cell. Scalar geometry rows use kilometers and square kilometers in the Foster
encounter plane: Y is parallel to relative velocity, Z parallel to r cross v,
X = Y cross Z. The input states are ECI/J2000 unless specifically stated below.
Each row records the TCA/epoch, or states that the upstream case supplies no
absolute epoch. CSV values are derived independently with NumPy; expected Pc
values are read from upstream test assertions or published workbook cells.

`cara_pc.csv` covers the Foster circular Omitron case, the tighter PcCircle
reference for the same case, all 11 Foster Alfano-2009 cases, the Foster NPD
repair case, five CARA CDMs, and the two covariance-correlation cases.

- Foster tolerances (0.1% relative; NPD 1e-10 absolute) are unchanged from
  `DistributedMatlab/ProbabilityOfCollision/UnitTests/Pc2D_Foster_UnitTest.m`
  lines 31–43, 65–73, and 100–111. Inputs for Alfano cases come from
  `DataFiles/AlfanoInputData/Alfano_2009_Test_Cases/CaseN data at TCA.xls`,
  rows 5, 9, 13–18, 23, 27, and 31–36. NASA's `get_alfano_test_case.m`
  lines 148–178 describe this layout. They are converted from m/m² to km/km².
- The tighter Omitron reference and 1e-10 relative tolerance come from
  `PcCircle_UnitTest.m` lines 61–66. This guards quadrature accuracy beyond the
  looser legacy Foster integration tolerance.
- NPD eigenvalues are clipped at `(1e-4 HBR)^2`, following `Pc2D_Foster.m`
  lines 111–113. The raw indefinite projected covariance is retained in the
  fixture so the production implementation must perform and report repair.
- The five workbook Pc references use `Pc2D_NoAdj` (column I), matching the
  original supplied CDM state. They deliberately do not claim the TCA-adjusted
  result (column J). The 1e-8 relative tolerance is stricter than the accepted
  `Loose` category in `ComparePc2D_to_CARAValues.m` lines 18–34, which allows
  mixed absolute/relative error. This covers input projection roundoff while
  requiring a useful relative check even at small probabilities.
- Correlation expected values and 0.5% relative tolerances come from
  `Utils/CovarianceDeCorrelationCode/UnitTests/Pc_CovXCorr_UnitTest.m`
  lines 14–16 and 234–236. Its ITRF inputs are expressed in common inertial
  Cartesian axes coincident with ITRF at TCA, with `v_inertial = v_ITRF + omega
  cross r`. Small polar-motion/precession terms are omitted; the independent
  reference remains inside the original 0.5% tolerance. DCP sensitivities are
  rotated from RTN with the corrected inertial velocity. The correction is
  `C1 + C2 - cross - transpose(cross)`, exactly `Pc_CovXCorr.m` line 228.

`cara_correlation.csv` retains the two correlation cases' relative state,
combined 6x6 covariance and nonsymmetric 3x3 cross covariance, all in km/s units.
The covariance block units are km², km²/s, and km²/s². `cara_usage.csv` retains
only eight selected CARA CDMs' two states and full covariances, the workbook
usage-code labels, and published Nc/SDMC values and SDMC confidence bounds.
These values are evidence for separate usage/fallback tests, not a claim that
all algorithms produce the same result. EME2000 is the frame; each row gives
UTC TCA and workbook row. The `usage_code` follows the upstream digit encoding,
not a Boolean. See `NOTICE-frisbee.md` for Frisbee and scaled-maximum vectors.

`cara_hall.csv` contains all 12 Alfano-2009 full-state cases for the Hall
3D-Nc acceptance tests. Its state/covariance layout matches `cara_usage.csv`,
followed by HBR (km), expected Hall value, relative tolerance, lower/upper
integration bounds (seconds), published Monte Carlo value and its published
95% interval, epoch and source. All Hall values, tolerances (0.001 relative),
and time limits are parsed unchanged from `Pc3D_Hall_UnitTest.m` lines 33–49;
that test applies symmetric explicit time limits in lines 291–299. The full
6x6 covariances come from the same at-TCA workbooks used above. The Monte Carlo
reference/interval columns come from
`Pc3D_Hall_Utils/Output_AlfanoTestCases_Pc3D/A09TestCases_01_12_Distributed.csv`
lines 2–13 (100 million trials). These are distinct Hall and Monte Carlo
references, because Nc and collision probability can differ for recrossings.
A new small Monte Carlo run must account for its own binomial uncertainty;
it cannot be expected to fall inside a 100-million-trial confidence interval.

`test_pc_monte_carlo.cpp` compares all 12 published Monte Carlo references
using deterministic two-body sampling and the same finite time windows.
The comparison explicitly selects first-entry probability, excluding initial
overlap without renormalization. NASA's `Pc_MC_Kep2body_parallel.m` lines
355–359 counts initial overlaps separately as `Nc_0`, lines 425–439 excludes
these trajectories from entry counts, and lines 474–488 omits `Nc_0` from
`Pc_all`/`Pc_att`. The application's default Monte Carlo result continues to
include initial overlap. The case-12 test replays both modes with the same
seed and asserts that total hits equal initial hits plus first-entry hits.
Sample counts were chosen before observing results: 32,768 for each case,
except case 7 at 262,144 (about 42 expected collisions at its published rate).
The original upstream Monte Carlo unit tests use sampling-specific tolerances
(e.g. `MonteCarloPc/UnitTests/Pc_MC_Kep2body_parallel_UnitTest.m` lines 28–32
use 10% accuracy and 95% confidence). Our smaller runs instead use an explicit
Bernoulli Bernstein concentration bound: `sqrt(2 p(1-p) L/n) + 2L/(3n)`, with
`L=log(2*12/0.01)`, maximized over the published 95% probability interval.
The acceptance interval expands that reference interval by this bound. This
allocates a 1% family-wise sampling-error budget across the 12 comparisons,
conditional on the published reference interval containing the true value.
It verifies statistical consistency, not the original 100-million-trial
precision. Each row prints its 95% Wilson interval; tests check valid bounds and that
zero hits cannot be presented with a zero upper probability bound.

`pc_dblquad.csv` is independently generated by `scripts/pc-dblquad-oracle.py`
using `scipy.integrate.dblquad` on the bivariate normal PDF over a disk. These
are constructed static encounter-plane geometries with no epoch. They cover
standard-deviation aspect ratios 1–1000, rotated and near-axis covariances,
sigma_min/HBR from 0.01 to 10, boundary/tail encounters, and Pc above 0.01.
The C++ comparison tolerance is the requested 1e-4 relative. The Python oracle
uses 2e-11 quadrature relative tolerance, 1e-14 absolute tolerance per segment,
and rejects large integration error estimates. Both integration variables
remain numerical integrals; there is no production C++ or CDF-derived answer.

Regenerate offline from the worktree root:

```sh
.oracle/venv/bin/python analysis/conjunction-assessment/scripts/regen-cara-pc-fixtures.py
.oracle/venv/bin/python analysis/conjunction-assessment/scripts/pc-dblquad-oracle.py
```
