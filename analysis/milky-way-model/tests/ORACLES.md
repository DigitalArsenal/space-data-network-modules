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

The published Reid Table 1 values are parsed without generating golden outputs.
All sources assigned to the implemented arm families are included, with excluded
arm codes recorded. Parallax inversion and arm distances occur in C++. The
strict 0.3 kpc maximum requirement is evaluated as written; published intrinsic
arm widths and measurement scatter may violate it. Outliers are not removed to
obtain a passing result. Failed acceptance metrics remain failures in the E2E
and are preserved in `.build/band-vs-gaia-report.json`.
