# Vimpel epoch normalization and catalog matching

## Verified format

Primary source: JSC Vimpel, [Orbit parameters of newly detected HEO space debris
objects](http://spacedata.vimpel.ru/), public format documentation inspected
2026-09-21. This describes osculating elements, not an SGP4/TLE mean-element set.
The 15 columns are:

| Column | Meaning | Units / encoding |
| --- | --- | --- |
| 1 | Row ordinal | Not object identity |
| 2 | Provider object number | Vimpel namespace |
| 3 | First observation date | DDMMYYYY |
| 4 | Reference epoch | DDMMYYYY HHMMSS, UTC |
| 5 | Time since orbit update | Days |
| 6 | Semimajor axis | km |
| 7–8 | Inclination, RAAN | Degrees |
| 9 | Eccentricity | Dimensionless |
| 10–11 | Argument of latitude, argument of perigee | Degrees |
| 12 | Effective area / mass | m²/kg |
| 13 | Magnitude | Provider photometric value |
| 14 | Along-track timing uncertainty | Minutes, 50% confidence |
| 15 | Transverse position uncertainty | km, 50% confidence |

Elements and rectangular ephemerides use J2000 inertial axes. Current ephemeris
indices advance by 600 seconds; filenames identify the native object and UTC
epoch. Do not mistake the index for elapsed seconds. Use actual sample counts.

The published numerical model includes degree-8 Earth gravity, DE405 Sun/Moon,
GOST atmosphere and radiation pressure. Its effective area/mass parameter is
not independently a drag coefficient or radiation-pressure coefficient.

## State at the reference epoch

Set true anomaly `ν = u − ω`, where `u` is column 10 and `ω` column 11.
With `p = a(1−e²)` and Earth gravitational parameter `μ`:

```
r_pf = p/(1 + e cos ν) [cos ν, sin ν, 0]
v_pf = sqrt(μ/p) [-sin ν, e + cos ν, 0]
Q = Rz(Ω) Rx(i) Rz(ω)
r_J2000 = Q r_pf
v_J2000 = Q v_pf
```

This is an instantaneous osculating-state conversion, not a numerical propagation.
`files/orbit-products.normalize_vimpel` now uses `foundation/orbits` with explicit unit conversion:
its internal lengths are metres, velocities m/s, angles radians and μ m³/s².
Advancing away from the epoch requires the selected propagator and documented
force-model configuration. Never interpret these fields as SGP4 mean elements.

## Differentiating the provider positions

For positions at spacing `h`, a fourth-order derivative at the first epoch is
`(-25r0 + 48r1 − 36r2 + 16r3 − 3r4)/(12h)`.
The centered stencil uses `(r[i−2] − 8r[i−1] + 8r[i+1] − r[i+2])/(12h)`.
The matcher also checks the second, penultimate and final samples using shifted
five-point stencils. The entire arc must pass the configured residual tolerance.

Differentiation amplifies rounding. If each Cartesian component has rounding
error bounded by `q`, the first-epoch velocity component has a rounding bound
`128q/(12h)`, before adding truncation error. At 0.1 km position resolution and
600 seconds, `q=0.05 km` gives about 0.89 m/s per component. A finer time step
does not necessarily help when the source positions remain quantized.
Compare stencils and independent analytic velocities; do not certify a derived
velocity merely by comparing it against the same differentiation operation.
The endpoint stencil is less noise-tolerant than the centered stencil.

## Reproducible local audit

Run from the package directory, supplying already acquired files:

```
python3 tools/audit-vimpel-epoch.py ELEMENTS_FILE EPHEMERIS_RAR
python3 -m unittest discover -s tools -p 'test_*.py'
```

The tool uses `bsdtar`, does not fetch data or access credentials, extracts at most
64 deterministic samples into a temporary directory, and emits aggregate
residuals and input hashes. It matches native ID **and exact epoch**, and does
not silently compare different epochs. It is a diagnostic, not an ingestion
adapter. Provider files must remain outside Git.

The recorded September-2026 audit found 6,654 archive entries matching the
13,808-row element file at exactly the same identity and epoch. The 64 sampled
entries each had 1,008 positions. Their position residuals were 0.10–48.80 km;
velocity residuals were 0.39–1,106.42 m/s. These are comparisons between rounded
products, not absolute accuracy estimates. The three- versus five-point velocity
estimates differed by up to 1,823.82 m/s. These large discrepancies rule out
unconditionally adopting ten-minute endpoint finite differences as velocities. See the adjacent aggregate audit JSON.

## Association and authoritative catalog policy

`datefirst` proposes a Vimpel-to-NORAD association; it does not prove it. Its
header is `Nvym t_det_v Nnor t_det_n`, with YYYYMMDD dates. Preserve the original
native ID and an explicit numeric normalization for leading-zero comparisons.
Keep duplicate/alias declarations as attributed edges; detect conflicting
associations and cycles before proposing candidates.

For each candidate, retain provider, native ID, immutable record reference,
epoch, frame, original product and crosswalk edition. Propagate with a pluggable
model to a common epoch/grid and normalize the frames explicitly. Then run the
position/velocity/derivative checks and preserve ambiguous or rejected results.
Only accepted associations may populate an identity binding; selection of an
orbit product is a separate, versioned catalog policy. A mixed provider channel
must not be counted as independent evidence of its upstream source.

The two 50%-confidence uncertainty scalars do not specify correlations, a full
state uncertainty, or a Gaussian model. Preserve them; do not manufacture a
6×6 covariance or infer a collision probability from them.

The normalizer and catalog validation/fitting methods are implemented. See
[epoch fitting](epoch-fitting.md) for the binary interfaces and real-data
verification. `datefirst` candidate generation, common-grid preparation and accepted-binding
persistence now run in the Catalog Editor APP. See [workflow evidence](matching-workflow.md).
The local-node audit normalizes its immutable published data; absent independent
counterproducts remain insufficient. This work does not schedule a service or
claim conjunction screening, collision probabilities or production deployment.
