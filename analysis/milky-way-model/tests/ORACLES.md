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

The sky comparison uses the task thresholds: log-intensity Pearson r ≥ 0.85
for flux and ≥ 0.75 for density over |b| ≤ 30 degrees; latitude FWHM relative
error ≤ 0.25 at l = 0, 90, 180, 270 degrees; a Great Rift dip. Those tolerances
are visual model acceptance targets, not Gaia measurement uncertainties. The
static Galactic geometry uses the module's documented J2000 Galactic frame
and solar position; no epoch propagation is applied to integrated sky maps.

## Run-two acceptance decision (2026-10-17)

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
An uncertainty-aware replacement requires a clarified acceptance decision.
The current E2E reports these failures instead of silently changing statistics.

## Production calibration

The compiled relative dust coefficient is 0.06788225099390856 kpc^-1, from
the prior 5,400-ray offline fit. Acceptance now measures a fresh `bake`
**before** calling `calibrate`. Recalibration remains a separate diagnostic;
it cannot improve the production acceptance result. The display-map fit does
not establish absolute extinction. Component ablations run in C++ WASM during
this same E2E and are documented in `PHYSICS.md`.
