# GP prediction error, 2026-08: model and validation

SGP4 prediction error by orbit regime and prediction age, in RTN (km). Two
sources:

- **Model:** consecutive element-set differences. Inputs are 1,891,337 SGP4
  element sets for 32,320 objects, created 2026-07-12 to 2026-08-08 in the GP
  history archive. After dropping 348,914 republished copies (epochs within
  1 s), there are 7,177,502 differences. Each one is the first later set in
  each age bin. A later set is itself an estimate, so these differences are
  not truth.
- **Truth:** comparisons against independent reference states for 2026-08-09
  to 15 (`analysis/reference-states`): IGS final orbits for 32 GPS
  satellites, ILRS combined arcs for LAGEOS-1/2 and ETALON-1/2, and
  Sentinel-1C/1D POEORB. These use 1,051 element sets created 2026-08-02 to
  16 and give 310,782 comparisons, with reference states sampled at least
  300 s apart.

σ is the standard deviation after clipping samples beyond 5 robust sigma
((q84 − q16)/2) in any position component. A stratum is validated when it has
at least 30 truth samples.

Files: `model-2026-08.json`, `truth-2026-08.json` and
`validation-2026-08.json`. Rebuild with `scripts/build-model.mjs` (see the
README).

## Validated regimes

| Regime | Age (d) | Model n | Model σ R / T / N (km) | Truth n | Truth σ R / T / N (km) | Truth ÷ model |
| --- | --- | ---: | --- | ---: | --- | --- |
| LEO 600-800 km | 0–0.5 | 116997 | 0.021 / 0.133 / 0.022 | 8815 | 0.104 / 0.594 / 0.177 | 5.1 / 4.5 / 8.1 |
| LEO 600-800 km | 0.5–1 | 134446 | 0.043 / 0.261 / 0.051 | 8375 | 0.111 / 0.649 / 0.177 | 2.6 / 2.5 / 3.5 |
| LEO 600-800 km | 1–2 | 170183 | 0.074 / 0.517 / 0.088 | 17072 | 0.120 / 0.812 / 0.187 | 1.6 / 1.6 / 2.1 |
| LEO 600-800 km | 2–3 | 162632 | 0.128 / 1.167 / 0.155 | 16596 | 0.140 / 1.117 / 0.202 | 1.1 / 1.0 / 1.3 |
| LEO 600-800 km | 3–5 | 169943 | 0.187 / 2.379 / 0.224 | 30970 | 0.185 / 1.940 / 0.227 | 1.0 / 0.8 / 1.0 |
| LEO 600-800 km | 5–7 | 161376 | 0.296 / 6.047 / 0.354 | 25518 | 0.252 / 3.513 / 0.268 | 0.8 / 0.6 / 0.8 |
| MEO 2000-10000 km | 0–0.5 | 2538 | 0.011 / 0.091 / 0.024 | 2664 | 0.025 / 0.444 / 0.159 | 2.2 / 4.9 / 6.6 |
| MEO 2000-10000 km | 0.5–1 | 3359 | 0.022 / 0.134 / 0.050 | 2739 | 0.029 / 0.449 / 0.161 | 1.3 / 3.4 / 3.2 |
| MEO 2000-10000 km | 1–2 | 4216 | 0.039 / 0.187 / 0.088 | 5142 | 0.027 / 0.413 / 0.173 | 0.7 / 2.2 / 2.0 |
| MEO 2000-10000 km | 2–3 | 3988 | 0.060 / 0.237 / 0.153 | 4903 | 0.026 / 0.429 / 0.192 | 0.4 / 1.8 / 1.3 |
| MEO 2000-10000 km | 3–5 | 4326 | 0.085 / 0.333 / 0.218 | 9437 | 0.026 / 0.432 / 0.239 | 0.3 / 1.3 / 1.1 |
| MEO 2000-10000 km | 5–7 | 4065 | 0.131 / 0.468 / 0.343 | 8201 | 0.026 / 0.370 / 0.299 | 0.2 / 0.8 / 0.9 |
| MEO 10000-30000 km | 0–0.5 | 1304 | 0.046 / 0.163 / 0.024 | 12717 | 0.182 / 1.806 / 0.143 | 3.9 / 11.1 / 5.9 |
| MEO 10000-30000 km | 0.5–1 | 2546 | 0.072 / 0.246 / 0.033 | 12176 | 0.182 / 1.791 / 0.141 | 2.5 / 7.3 / 4.3 |
| MEO 10000-30000 km | 1–2 | 3684 | 0.104 / 0.405 / 0.048 | 24140 | 0.196 / 1.780 / 0.139 | 1.9 / 4.4 / 2.9 |
| MEO 10000-30000 km | 2–3 | 3402 | 0.160 / 0.653 / 0.072 | 24687 | 0.228 / 1.699 / 0.140 | 1.4 / 2.6 / 2.0 |
| MEO 10000-30000 km | 3–5 | 4412 | 0.214 / 0.974 / 0.101 | 49173 | 0.298 / 1.568 / 0.145 | 1.4 / 1.6 / 1.4 |
| MEO 10000-30000 km | 5–7 | 4242 | 0.321 / 1.623 / 0.150 | 47457 | 0.411 / 1.470 / 0.168 | 1.3 / 0.9 / 1.1 |

- **Short ages: the differences understate the error.** Under half a day, the
  model σ is 4–11× too small along-track and 6–8× too small cross-track.
  Consecutive fits share most of their error (the same observations and the
  same force-model bias), so their difference cancels it. The gap closes with
  age, to about 1× by 2–3 days in LEO 600–800 km and by 3–7 days in GNSS MEO.
- **LEO 600–800 km (Sentinel-1C/1D):**
  - true error at epoch: 0.10 / 0.59 / 0.18 km;
  - along-track grows to 3.5 km at 5–7 days;
  - beyond 3 days the model overstates it, up to 1.7× along-track at 5–7 days.
- **MEO 2000–10000 km (LAGEOS-1/2):**
  - along-track error is flat at about 0.4 km for all ages;
  - radial truth σ (0.03 km) is below the model's from 1 day onward.
- **MEO 10000–30000 km (GPS, ETALON):**
  - along-track σ is about 1.8 km at every age;
  - it is dominated by persistent per-satellite offsets (median −1.6 to
    +3.8 km for GPS, steady across ages), so most of the spread is between
    satellites;
  - the stratum mean is +0.7 to +0.8 km along-track.
- **Clipping:** it removes 0–3.4 % of truth samples and 5–24 % of differences.
  The differences have heavy tails (manoeuvres, cross-tagging, bad sets).

## Unvalidated regimes

There are no independent reference states in these regimes. Their σ is the
consecutive-difference value only. Given the validated regimes, it probably
understates the error at short ages.

| Regime | Age (d) | n | Removed by clip | σ R / T / N (km) |
| --- | --- | ---: | ---: | --- |
| LEO below 450 km | 0–0.5 | 71239 | 13.6 % | 0.195 / 3.158 / 0.080 |
| LEO below 450 km | 0.5–1 | 83798 | 7.5 % | 0.504 / 18.997 / 0.136 |
| LEO below 450 km | 1–2 | 101389 | 6.7 % | 1.422 / 66.177 / 0.214 |
| LEO below 450 km | 2–3 | 96463 | 7.1 % | 9.161 / 217.807 / 0.402 |
| LEO below 450 km | 3–5 | 98168 | 8.2 % | 40.295 / 470.376 / 0.677 |
| LEO below 450 km | 5–7 | 93249 | 10.7 % | 244.630 / 1146.353 / 1.271 |
| LEO 450-600 km | 0–0.5 | 378024 | 14.7 % | 0.139 / 1.906 / 0.085 |
| LEO 450-600 km | 0.5–1 | 497338 | 10.5 % | 0.227 / 6.473 / 0.145 |
| LEO 450-600 km | 1–2 | 589301 | 9.7 % | 0.295 / 14.341 / 0.201 |
| LEO 450-600 km | 2–3 | 566258 | 9.1 % | 0.520 / 34.383 / 0.297 |
| LEO 450-600 km | 3–5 | 577021 | 9.5 % | 1.124 / 65.216 / 0.405 |
| LEO 450-600 km | 5–7 | 547356 | 10.4 % | 4.725 / 150.463 / 0.634 |
| LEO 800-1200 km | 0–0.5 | 165947 | 7.6 % | 0.018 / 0.072 / 0.018 |
| LEO 800-1200 km | 0.5–1 | 202561 | 5.2 % | 0.042 / 0.159 / 0.040 |
| LEO 800-1200 km | 1–2 | 241846 | 5.3 % | 0.073 / 0.259 / 0.071 |
| LEO 800-1200 km | 2–3 | 228465 | 5.9 % | 0.127 / 0.459 / 0.122 |
| LEO 800-1200 km | 3–5 | 237217 | 7.2 % | 0.183 / 0.733 / 0.176 |
| LEO 800-1200 km | 5–7 | 225480 | 8.3 % | 0.289 / 1.511 / 0.279 |
| LEO 1200-2000 km | 0–0.5 | 68634 | 11.5 % | 0.012 / 0.077 / 0.015 |
| LEO 1200-2000 km | 0.5–1 | 85981 | 10.1 % | 0.028 / 0.160 / 0.032 |
| LEO 1200-2000 km | 1–2 | 103107 | 9.9 % | 0.052 / 0.263 / 0.058 |
| LEO 1200-2000 km | 2–3 | 97539 | 8.7 % | 0.091 / 0.449 / 0.098 |
| LEO 1200-2000 km | 3–5 | 100799 | 7.2 % | 0.135 / 0.613 / 0.140 |
| LEO 1200-2000 km | 5–7 | 95586 | 8.2 % | 0.208 / 0.811 / 0.222 |
| GEO 30000-40000 km | 0–0.5 | 53934 | 17.8 % | 0.077 / 0.374 / 0.095 |
| GEO 30000-40000 km | 0.5–1 | 64880 | 20.1 % | 0.151 / 0.587 / 0.175 |
| GEO 30000-40000 km | 1–2 | 79185 | 21.6 % | 0.261 / 0.935 / 0.237 |
| GEO 30000-40000 km | 2–3 | 75948 | 22.8 % | 0.443 / 1.587 / 0.394 |
| GEO 30000-40000 km | 3–5 | 77932 | 23.8 % | 0.642 / 2.563 / 0.553 |
| GEO 30000-40000 km | 5–7 | 74109 | 24.2 % | 1.005 / 5.500 / 0.864 |
| Eccentric (e >= 0.1) | 0–0.5 | 24579 | 11.4 % | 0.116 / 0.387 / 0.073 |
| Eccentric (e >= 0.1) | 0.5–1 | 34824 | 12.4 % | 0.229 / 0.766 / 0.125 |
| Eccentric (e >= 0.1) | 1–2 | 45921 | 13.5 % | 0.410 / 1.389 / 0.207 |
| Eccentric (e >= 0.1) | 2–3 | 43799 | 15.4 % | 0.835 / 2.870 / 0.350 |
| Eccentric (e >= 0.1) | 3–5 | 47425 | 16.4 % | 1.527 / 5.048 / 0.503 |
| Eccentric (e >= 0.1) | 5–7 | 44417 | 17.5 % | 3.419 / 11.295 / 0.793 |

Regimes with fewer than 100 differences per bin (beyond 40000 km) are in the
JSON only.

## Use

Nothing here is calibrated. Coverage tests (Mahalanobis χ² and 1/2/3σ
containment against reference states) and the publication rule for
covariance-based Pc belong to the calibration gate
(`covariance-calibration-gate`). Until a stratum passes it, a covariance from
this model is labelled conditional on stated assumptions.
