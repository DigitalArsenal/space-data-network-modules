# GP prediction error, 2026-08: model and validation

SGP4 prediction error by orbit regime and prediction age, in RTN (km).

## Inputs

**Model: consecutive element-set differences.**
- 1,891,337 SGP4 element sets for 32,320 objects, created 2026-07-12 to
  2026-08-08 in the GP history archive.
- After dropping 348,914 republished copies (epochs within 1 s), there are
  7,177,502 differences.
- Each difference uses the first later set in its age bin.
- A later set is an estimate, so these differences are not truth.

**Truth: independent reference states for 2026-08-09 to 15** (`analysis/reference-states`), 48 objects:

| Source | Objects |
| --- | --- |
| IGS final orbits | GPS |
| ILRS combined arcs | LAGEOS-1/2, ETALON-1/2 |
| ILRS NSGF arcs | Ajisai, Starlette, Stella, LARETS, WESTPAC, LARES, LARES-2 |
| Sentinel-1 POEORB | Sentinel-1C/1D |
| Swarm precise orbits | Swarm A/B/C |

- 1,565 element sets, created 2026-08-02 to 16.
- 733,773 comparisons, with reference states sampled at least 300 s apart.

**Statistics.**
- σ is the standard deviation after clipping samples beyond 5 robust sigma
  ((q84 − q16)/2) in any position component.
- A stratum is validated when it has at least 30 truth samples.

Files: `model-2026-08.json`, `truth-2026-08.json` and
`validation-2026-08.json`. Rebuild with `scripts/build-model.mjs` (see the
README). Calibration of these covariances: [calibration-2026-08.md](calibration-2026-08.md).

## Validated regimes

| Regime | Age (d) | Model n | Model σ R / T / N (km) | Truth n | Truth σ R / T / N (km) | Truth ÷ model |
| --- | --- | ---: | --- | ---: | --- | --- |
| LEO below 450 km | 0–0.5 | 71239 | 0.195 / 3.158 / 0.080 | 8652 | 0.109 / 0.647 / 0.162 | 0.6 / 0.2 / 2.0 |
| LEO below 450 km | 0.5–1 | 83798 | 0.504 / 18.997 / 0.136 | 8424 | 0.134 / 0.693 / 0.169 | 0.3 / 0.0 / 1.2 |
| LEO below 450 km | 1–2 | 101389 | 1.422 / 66.177 / 0.214 | 16426 | 0.184 / 1.132 / 0.169 | 0.1 / 0.0 / 0.8 |
| LEO below 450 km | 2–3 | 96463 | 9.161 / 217.807 / 0.402 | 15936 | 0.266 / 2.371 / 0.179 | 0.0 / 0.0 / 0.4 |
| LEO below 450 km | 3–5 | 98168 | 40.295 / 470.376 / 0.677 | 29875 | 0.403 / 5.602 / 0.197 | 0.0 / 0.0 / 0.3 |
| LEO below 450 km | 5–7 | 93249 | 244.630 / 1146.353 / 1.271 | 25027 | 0.599 / 15.715 / 0.214 | 0.0 / 0.0 / 0.2 |
| LEO 450-600 km | 0–0.5 | 378024 | 0.139 / 1.906 / 0.085 | 4460 | 0.128 / 0.649 / 0.167 | 0.9 / 0.3 / 2.0 |
| LEO 450-600 km | 0.5–1 | 497338 | 0.227 / 6.473 / 0.145 | 4373 | 0.153 / 0.739 / 0.167 | 0.7 / 0.1 / 1.2 |
| LEO 450-600 km | 1–2 | 589301 | 0.295 / 14.341 / 0.201 | 8560 | 0.215 / 0.933 / 0.170 | 0.7 / 0.1 / 0.8 |
| LEO 450-600 km | 2–3 | 566258 | 0.520 / 34.383 / 0.297 | 7986 | 0.295 / 1.237 / 0.173 | 0.6 / 0.0 / 0.6 |
| LEO 450-600 km | 3–5 | 577021 | 1.124 / 65.216 / 0.405 | 15120 | 0.428 / 1.899 / 0.178 | 0.4 / 0.0 / 0.4 |
| LEO 450-600 km | 5–7 | 547356 | 4.725 / 150.463 / 0.634 | 12472 | 0.604 / 4.779 / 0.179 | 0.1 / 0.0 / 0.3 |
| LEO 600-800 km | 0–0.5 | 116997 | 0.021 / 0.133 / 0.022 | 14968 | 0.106 / 0.570 / 0.165 | 5.2 / 4.3 / 7.5 |
| LEO 600-800 km | 0.5–1 | 134446 | 0.043 / 0.261 / 0.051 | 14876 | 0.107 / 0.602 / 0.164 | 2.5 / 2.3 / 3.2 |
| LEO 600-800 km | 1–2 | 170183 | 0.074 / 0.517 / 0.088 | 31327 | 0.116 / 0.653 / 0.172 | 1.6 / 1.3 / 2.0 |
| LEO 600-800 km | 2–3 | 162632 | 0.128 / 1.167 / 0.155 | 31805 | 0.135 / 0.881 / 0.182 | 1.1 / 0.8 / 1.2 |
| LEO 600-800 km | 3–5 | 169943 | 0.187 / 2.379 / 0.224 | 58981 | 0.175 / 1.335 / 0.201 | 0.9 / 0.6 / 0.9 |
| LEO 600-800 km | 5–7 | 161376 | 0.296 / 6.047 / 0.354 | 49187 | 0.233 / 2.406 / 0.233 | 0.8 / 0.4 / 0.7 |
| LEO 800-1200 km | 0–0.5 | 165947 | 0.018 / 0.072 / 0.018 | 5784 | 0.095 / 0.441 / 0.224 | 5.2 / 6.1 / 12.7 |
| LEO 800-1200 km | 0.5–1 | 202561 | 0.042 / 0.159 / 0.040 | 6056 | 0.096 / 0.453 / 0.232 | 2.3 / 2.9 / 5.7 |
| LEO 800-1200 km | 1–2 | 241846 | 0.073 / 0.259 / 0.071 | 12399 | 0.096 / 0.445 / 0.248 | 1.3 / 1.7 / 3.5 |
| LEO 800-1200 km | 2–3 | 228465 | 0.127 / 0.459 / 0.122 | 12451 | 0.100 / 0.449 / 0.285 | 0.8 / 1.0 / 2.3 |
| LEO 800-1200 km | 3–5 | 237217 | 0.183 / 0.733 / 0.176 | 22594 | 0.112 / 0.459 / 0.363 | 0.6 / 0.6 / 2.1 |
| LEO 800-1200 km | 5–7 | 225480 | 0.289 / 1.511 / 0.279 | 18864 | 0.130 / 0.466 / 0.482 | 0.5 / 0.3 / 1.7 |
| LEO 1200-2000 km | 0–0.5 | 68634 | 0.012 / 0.077 / 0.015 | 6186 | 0.079 / 0.358 / 0.145 | 6.8 / 4.6 / 9.5 |
| LEO 1200-2000 km | 0.5–1 | 85981 | 0.028 / 0.160 / 0.032 | 6644 | 0.081 / 0.371 / 0.151 | 2.9 / 2.3 / 4.7 |
| LEO 1200-2000 km | 1–2 | 103107 | 0.052 / 0.263 / 0.058 | 14451 | 0.084 / 0.364 / 0.164 | 1.6 / 1.4 / 2.8 |
| LEO 1200-2000 km | 2–3 | 97539 | 0.091 / 0.449 / 0.098 | 14221 | 0.092 / 0.375 / 0.180 | 1.0 / 0.8 / 1.8 |
| LEO 1200-2000 km | 3–5 | 100799 | 0.135 / 0.613 / 0.140 | 25685 | 0.108 / 0.401 / 0.220 | 0.8 / 0.7 / 1.6 |
| LEO 1200-2000 km | 5–7 | 95586 | 0.208 / 0.811 / 0.222 | 22794 | 0.135 / 0.444 / 0.289 | 0.6 / 0.5 / 1.3 |
| MEO 2000-10000 km | 0–0.5 | 2538 | 0.011 / 0.091 / 0.024 | 3024 | 0.034 / 0.445 / 0.154 | 3.0 / 4.9 / 6.4 |
| MEO 2000-10000 km | 0.5–1 | 3359 | 0.022 / 0.134 / 0.050 | 3099 | 0.042 / 0.448 / 0.156 | 1.9 / 3.4 / 3.1 |
| MEO 2000-10000 km | 1–2 | 4216 | 0.039 / 0.187 / 0.088 | 5862 | 0.039 / 0.417 / 0.167 | 1.0 / 2.2 / 1.9 |
| MEO 2000-10000 km | 2–3 | 3988 | 0.060 / 0.237 / 0.153 | 5623 | 0.040 / 0.429 / 0.184 | 0.7 / 1.8 / 1.2 |
| MEO 2000-10000 km | 3–5 | 4326 | 0.085 / 0.333 / 0.218 | 10590 | 0.036 / 0.436 / 0.231 | 0.4 / 1.3 / 1.1 |
| MEO 2000-10000 km | 5–7 | 4065 | 0.131 / 0.468 / 0.343 | 8641 | 0.031 / 0.374 / 0.293 | 0.2 / 0.8 / 0.9 |
| MEO 10000-30000 km | 0–0.5 | 1304 | 0.046 / 0.163 / 0.024 | 12717 | 0.182 / 1.806 / 0.143 | 3.9 / 11.1 / 5.9 |
| MEO 10000-30000 km | 0.5–1 | 2546 | 0.072 / 0.246 / 0.033 | 12176 | 0.182 / 1.791 / 0.141 | 2.5 / 7.3 / 4.3 |
| MEO 10000-30000 km | 1–2 | 3684 | 0.104 / 0.405 / 0.048 | 24140 | 0.196 / 1.780 / 0.139 | 1.9 / 4.4 / 2.9 |
| MEO 10000-30000 km | 2–3 | 3402 | 0.160 / 0.653 / 0.072 | 24687 | 0.228 / 1.699 / 0.140 | 1.4 / 2.6 / 2.0 |
| MEO 10000-30000 km | 3–5 | 4412 | 0.214 / 0.974 / 0.101 | 49173 | 0.298 / 1.568 / 0.145 | 1.4 / 1.6 / 1.4 |
| MEO 10000-30000 km | 5–7 | 4242 | 0.321 / 1.623 / 0.150 | 47457 | 0.411 / 1.470 / 0.168 | 1.3 / 0.9 / 1.1 |

- **The differences understate short-age error.** From 600 km up, under half
  a day:
  - along-track, the model σ is 4–11× too small;
  - cross-track, 6–13× too small.

  Consecutive fits share most of their error (the same observations and the
  same force-model bias), so their difference cancels it. The gap closes with
  age, to about 1× by 2–3 days in LEO and by 3–7 days in MEO.
- **Below 600 km the differences overstate along-track error**, by 10–90×
  beyond a day (Swarm A/B/C). These strata are dominated by manoeuvring and
  decaying objects: constellations raising, lowering and station-keeping. The
  passive, well-tracked reference satellites are not like them. Stratifying
  by regime alone mixes these populations; object class is the next
  stratifier.
- **Cross-track error is understated at short ages in every validated
  regime.**
- **MEO 10000–30000 km (GPS, ETALON):**
  - along-track σ is about 1.8 km at every age;
  - most of it is persistent per-satellite offsets (GPS medians −1.6 to
    +3.8 km, steady across ages);
  - the stratum mean is +0.7 to +0.8 km along-track.
- **Clipping removes:**
  - at most 3.4 % of truth samples;
  - 5–24 % of differences (heavy tails: manoeuvres, cross-tagging, bad
    sets).

## Unvalidated regimes

No independent reference states fall in these regimes. Their σ is the
consecutive-difference value only.

| Regime | Age (d) | n | Removed by clip | σ R / T / N (km) |
| --- | --- | ---: | ---: | --- |
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

Nothing here is calibrated by itself. Coverage tests and the publication rule
are in [calibration-2026-08.md](calibration-2026-08.md).
