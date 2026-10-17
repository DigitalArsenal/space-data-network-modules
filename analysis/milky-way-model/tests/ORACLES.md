# Offline E2E oracles

`band-vs-gaia.e2e.mjs` reads only `../oracle/`. That directory is gitignored;
oracle data is never embedded in the module or published with it. It never
downloads data. Exact cache filenames, source URLs, dimensions, and map SHA256
values are in `oracle-sources.json`. Missing files cause a blocked result with
the exact fetch URL, not a passing skip or substituted generated data.

The integrator's previously saved full maps were available and verified against
their saved hashes and ESA HTML links: the 4000 × 2000 flux map and 1500 × 750
density map are complete Hammer maps, not the separate 1200 × 600 preview.
They were copied into `oracle/` without changing the earlier `tests/.oracle-cache/`.
ESA published these EDR3 maps on its DR3 overview pages. Credit: ESA/Gaia/DPAC,
CC BY-SA 3.0 IGO. The display stretch is not a calibrated radiometric transfer
function. Correlations therefore compare log display luminance; they do not
certify calibrated flux, number counts, or a photometric fit.

The E2E decodes PNGs with the browser image decoder and copies RGBA bytes into
the module's shared memory. C++ WASM performs Hammer projection, 0.5-degree
Galactic plate-carree sampling, volume ray integration from the Sun, correlation,
latitude FWHM, Great Rift comparison, fit residuals, and maser ridge distances.
JavaScript performs only IO, SDS FlatBuffer encoding/decoding, and assertions.
If the permitted headless shell cannot start, the same E2E continues through
the SDK's Node WASI pthread host for diagnostic numerical evidence. Its PNG
decoder only decompresses bytes. The browser check remains failed, the process
exits nonzero, and the report identifies the fallback. `--node-diagnostic`
repeats that diagnostic path explicitly after a blocked browser attempt;
`--legacy-only` exercises the refactor stage before the literature model.

## Run-four production claim (2026-10-17)

Production configuration is hypothesis (e): the Drimmel & Spergel 2001 disk,
separate arm dust and a local segment, independently fitted to COBE/DIRBE.
The inherited Gaia-calibrated normalization is removed from production. The
historical `calibrate` method now returns an explicit error without mutation.
The following claim is verbatim from the coordinator's run-four decision:

- Gaia flux r >= 0.84 and density r >= 0.75 over |b| <= 30;
- latitude FWHM within 25% at l=90 and l=270;
- Great Rift ratio < 1 (a dip);
- Reid arm ridges exactly equal to Table 2 (implementation);
- per-arm maser chi2_nu <= 2 for every arm except the 3-kpc arm, whose chi2_nu is reported, not gated.
  The 3-kpc arm is inside the bar region, where a log-spiral is Reid's weakest description; our curve equals the published one exactly, so that scatter is the data against Reid's curve, not our implementation.
- l=0 and l=180 FWHM are REPORTED with their errors (28.6%, about 70%), not gated, and are listed in ORACLES.md as a known gap with the follow-up task id below.

Follow-up: **milky-way-local-3d-dust-20261017**, filed by the coordinator. A
licensed published local 3D dust map (Edenhofer 2024 or Lallement 2022), delivered
over SDN and baked in C++, targets l=0/180 FWHM <=25% and flux r >=0.85.
Those targets are not claimed here. All four widths, their errors, and all seven
arm chi-square values remain in the E2E report, including ungated failures.

The run-four decision explicitly changes the former 0.85 flux/all-four-width
and all-seven-arm gates. It does not change sampling, projection, masks,
display conversion, or source exclusions. These are visual model acceptance
targets, not Gaia measurement uncertainties. The geometry is the documented
static J2000 Galactic frame and Sun; integrated maps have no epoch propagation.

## Run-two acceptance decision (historical; superseded below)

The coordinator withdrew the 0.3-kpc maximum over all masers: it conflated
implementation accuracy with intrinsic arm width and parallax scatter. Gaia
thresholds, projection, masks, display fit, and sampling remain unchanged.

`reid2019-oracle.json` independently transcribes Table 2. C++ compares each
implemented curve at 4,097 domain positions plus its kink with the published
formula, tolerance 1e-6 kpc. The data check uses the paper's R0=8.15 kpc,
explicit Table 1 segment assignments (Norma and Outer separate), and raw
Euclidean perpendicular RMS <=1.5 times each published intrinsic width.
Baked-ridge residuals remain diagnostic and do not vote against the withdrawn
maximum. The production observer stays at R0=8.178 kpc.

Only these named exclusions are applied, following [Reid III.2](https://arxiv.org/html/1910.03357#S3.SS2):

| Section | Catalog source | Reason |
| --- | --- | --- |
| III.2.1 | G001.14-00.12 | Named outlier; prose spells it G001.15-0.12 |
| III.2.2 | G030.22-00.18 | Named spur/proper-motion source; prose spells it G030.22-0.17 |
| III.2.2 | G030.41-00.23 | Named spur/proper-motion source |
| III.2.2 | G030.74-00.04 | Named spur/proper-motion source |
| III.2.2 | G030.81-00.05 | Named spur/proper-motion source |
| III.2.2 | G030.97-00.14 | Named spur/proper-motion source |
| III.2.2 | G031.41+00.30 | Named spur/proper-motion source |
| III.2.3 | G032.74-00.07 | Named outlier |
| III.2.3 | G033.64-00.22 | Named outlier |

The first two names match the paper's Table 1 and the VizieR table. The E2E
requires all nine exclusions to resolve, and records each in its report.
No additional sigma clipping, parallax-quality cut, or empirical source
selection is applied. Unmodeled arm codes remain separately counted.

The literal revised data criterion still fails. In the browser E2E all seven
curve errors are zero; after the nine exclusions, these are the measured
counts, RMS and unchanged limits (kpc):

| Segment | N | Raw RMS | Limit |
| --- | ---: | ---: | ---: |
| 3-kpc(N) | 5 | 2.239263 | 0.270 |
| Norma | 11 | 0.163904 | 0.210 |
| Scutum-Centaurus | 41 | 0.424887 | 0.345 |
| Sagittarius-Carina | 37 | 0.342157 | 0.405 |
| Local | 28 | 0.259128 | 0.465 |
| Perseus | 41 | 0.737344 | 0.525 |
| Outer | 11 | 1.308877 | 0.975 |

Raw RMS includes measurement scatter. Section III fits with parallax-distance
uncertainty and intrinsic width added in quadrature; an intrinsic width is not
the raw RMS of noisy inverse-parallax positions. The 3-kpc model also has a
short finite domain, and its Table 1 membership exceeds Table 2's fitted N.
Extending that domain in a diagnostic still gives RMS 1.21375 kpc. This is
not evidence for changing the curve or inventing two more exclusions.
Run three authorizes an uncertainty-aware replacement, implemented below.
The finite-segment RMS values above remain available as diagnostics.

## Run-three acceptance decision (historical; run-four exception above)

The authorized criterion is per-arm mean `d_perp^2/(w_int^2+sigma_perp^2) <= 2`.
The implementation consumes each Table 1 parallax error (mas). For the projected
sightline `u` and the closest-point residual unit vector `n`, the first-order
propagated error is `sigma_perp = abs(n dot u) sigma_parallax / parallax^2`,
in kpc. At zero residual the local curve normal supplies `n`. This is linear
error propagation, not a posterior distance distribution for noisy parallaxes.
The denominator uses the independent Table 2 intrinsic width; the decision
specifies a mean over N rather than subtracting fitted parameters from N.

Table 2 beta coverage is not a physical endpoint. The likelihood continues the
published spiral over a full turn about the kink, retaining the longer Scutum
continuation. The rendering geometry is untouched. `finite_segment_rms` preserves
the previous endpoint-limited statistic; `arm_rms` and `arm_chi2_nu` now describe
the perpendicular published-curve statistic. No sources were newly excluded.

| Segment | N | Raw perpendicular RMS (kpc) | chi2_nu | <=2 |
| --- | ---: | ---: | ---: | --- |
| 3-kpc(N) | 5 | 1.213750 | 5.82805 | FAIL |
| Norma | 11 | 0.163904 | 0.696835 | pass |
| Scutum-Centaurus | 41 | 0.424887 | 1.27402 | pass |
| Sagittarius-Carina | 37 | 0.342157 | 0.701732 | pass |
| Local | 28 | 0.257821 | 0.641096 | pass |
| Perseus | 41 | 0.737344 | 0.898786 | pass |
| Outer | 11 | 1.308877 | 0.879486 | pass |

A native centered-parallax finite-difference audit over every modeled source
agrees with the analytic propagated sigma to 4.55e-10 kpc. The retained sources
G010.62-00.33 and G012.02-00.03 contribute chi-square terms 11.1546 and 16.9923
respectively. Changing the endpoint treatment cannot make this arm pass; no
extra exclusion or uncertainty inflation is authorized.

## Production dust and display conversion

The production dust implementation is `src/drimmel_dust.hpp`, shared with the
fixed literature experiments. It preserves hypothesis (e), including its
published normalization, independent disk/arm/local profiles and Reid-center
adaptation. It applies no no-taper, warp, flare or stellar-population trial.
The rejected Gaia-fitted scalar survives only in native historical diagnostics.
The log-affine display conversion remains a measurement operation and never
changes physical dust values. Relative emissivities, the bulge proxy, passband
approximations and the illustrative luminosity function remain model limits.

Run-three sources, approximations and failures are in
[HYPOTHESES.md](HYPOTHESES.md); they are historical evidence, not current gates.
