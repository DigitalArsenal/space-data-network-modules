# Covariance calibration, 2026-08

Does the GP prediction-error model's covariance describe actual SGP4 error?
Each comparison against an independent reference state gives a position error
**e**. Its stratum (regime × prediction age) has a model position covariance
C (RTN, clipped). Coverage tests

  d² = **e**ᵀ C⁻¹ **e**

with zero mean, as conjunction assessment uses it, against χ² with 3 degrees
of freedom.

- **Every sample counts.** Outliers and failures stay in the denominator.
- **Containment:** the fractions inside the 1, 2 and 3 σ ellipsoids
  (χ²₃ ≤ 3.527, 8.025, 14.156), against 0.683, 0.954 and 0.997.
- **Gate:** CALIBRATED only when all of these hold:
  - the 1 σ and 2 σ fractions are within 5 points of nominal;
  - at most 1 % lies outside 3 σ (nominal 0.27 %);
  - there are at least 30 samples;
  - there are at least 3 distinct objects.

  FAILED when the evidence is enough but the fractions miss. INSUFFICIENT
  when the evidence is too thin.
- **Two covariances are tested:**
  - **Model:** consecutive element-set differences (`model-2026-08.json`).
  - **Scaled:** the model with each stratum's position covariance scaled by
    s_k = √(E[e_k²] / C_kk), from reference-state errors in a *fit* week.
    Clipped, second moment about zero. File: `model-2026-08-scaled.json`.
- **Weeks:**
  - Fit: reference states 2026-08-02 to 08 (`truth-fit-2026-08.json`).
  - Test, held out: 2026-08-09 to 15.

  Both use the same products: IGS GPS, ILRS combined and NSGF arcs,
  Sentinel-1C/1D and Swarm A/B/C. The ILRS NSGF arcs do not overlap across
  the weeks.

Labels: `calibration-2026-08.json`. Re-run with `scripts/calibration-gate.mjs`.

## Results (test week)

| Regime | Age (d) | Objects | n | Model: inside 1/2/3σ | Model | Scale R / T / N | Scaled: inside 1/2/3σ | Scaled mean d² | Scaled | Label |
| --- | --- | ---: | ---: | --- | --- | --- | --- | ---: | --- | --- |
| LEO below 450 km | 0–0.5 | 2 | 8652 | 0.547 / 0.832 / 0.949 | INSUFFICIENT | 0.55 / 0.20 / 2.03 | 0.645 / 0.980 / 1.000 | 3.1 | INSUFFICIENT | UNCALIBRATED |
| LEO below 450 km | 0.5–1 | 2 | 8424 | 0.846 / 0.985 / 1.000 | INSUFFICIENT | 0.26 / 0.04 / 1.20 | 0.474 / 0.854 / 0.961 | 4.8 | INSUFFICIENT | UNCALIBRATED |
| LEO below 450 km | 1–2 | 2 | 16426 | 0.983 / 1.000 / 1.000 | INSUFFICIENT | 0.13 / 0.02 / 0.77 | 0.349 / 0.679 / 0.857 | 7.8 | INSUFFICIENT | UNCALIBRATED |
| LEO below 450 km | 2–3 | 2 | 15936 | 1.000 / 1.000 / 1.000 | INSUFFICIENT | 0.03 / 0.02 / 0.43 | 0.416 / 0.829 / 0.975 | 5.0 | INSUFFICIENT | UNCALIBRATED |
| LEO below 450 km | 3–5 | 2 | 29875 | 1.000 / 1.000 / 1.000 | INSUFFICIENT | 0.01 / 0.02 / 0.26 | 0.424 / 0.839 / 0.978 | 4.9 | INSUFFICIENT | UNCALIBRATED |
| LEO below 450 km | 5–7 | 2 | 25027 | 1.000 / 1.000 / 1.000 | INSUFFICIENT | 0.02 / 0.13 / 0.15 | 0.806 / 0.973 / 0.999 | 2.0 | INSUFFICIENT | UNCALIBRATED |
| LEO 450-600 km | 0–0.5 | 1 | 4460 | 0.451 / 0.785 / 0.963 | INSUFFICIENT | 0.95 / 0.42 / 1.95 | 0.700 / 0.992 / 1.000 | 2.8 | INSUFFICIENT | UNCALIBRATED |
| LEO 450-600 km | 0.5–1 | 1 | 4373 | 0.857 / 0.998 / 1.000 | INSUFFICIENT | 0.68 / 0.13 / 1.15 | 0.684 / 0.972 / 1.000 | 3.0 | INSUFFICIENT | UNCALIBRATED |
| LEO 450-600 km | 1–2 | 1 | 8560 | 0.978 / 1.000 / 1.000 | INSUFFICIENT | 0.69 / 0.07 / 0.83 | 0.577 / 0.919 / 0.987 | 3.8 | INSUFFICIENT | UNCALIBRATED |
| LEO 450-600 km | 2–3 | 1 | 7986 | 1.000 / 1.000 / 1.000 | INSUFFICIENT | 0.53 / 0.04 / 0.56 | 0.428 / 0.820 / 0.958 | 5.2 | INSUFFICIENT | UNCALIBRATED |
| LEO 450-600 km | 3–5 | 1 | 15120 | 1.000 / 1.000 / 1.000 | INSUFFICIENT | 0.36 / 0.05 / 0.42 | 0.380 / 0.792 / 0.955 | 5.6 | INSUFFICIENT | UNCALIBRATED |
| LEO 450-600 km | 5–7 | 1 | 12472 | 1.000 / 1.000 / 1.000 | INSUFFICIENT | 0.12 / 0.04 / 0.29 | 0.386 / 0.793 / 0.921 | 6.0 | INSUFFICIENT | UNCALIBRATED |
| LEO 600-800 km | 0–0.5 | 4 | 14968 | 0.006 / 0.021 / 0.047 | FAILED | 5.21 / 4.54 / 6.78 | 0.642 / 0.954 / 0.997 | 3.3 | CALIBRATED | CALIBRATED |
| LEO 600-800 km | 0.5–1 | 4 | 14876 | 0.052 / 0.160 / 0.353 | FAILED | 2.47 / 2.46 / 2.93 | 0.627 / 0.947 / 0.996 | 3.4 | FAILED | UNCALIBRATED |
| LEO 600-800 km | 1–2 | 4 | 31327 | 0.236 / 0.589 / 0.835 | FAILED | 1.59 / 1.40 / 1.77 | 0.647 / 0.943 / 0.997 | 3.3 | CALIBRATED | CALIBRATED |
| LEO 600-800 km | 2–3 | 4 | 31805 | 0.646 / 0.934 / 0.997 | CALIBRATED | 1.07 / 0.72 / 1.09 | 0.636 / 0.922 / 0.994 | 3.4 | CALIBRATED | CALIBRATED |
| LEO 600-800 km | 3–5 | 4 | 58981 | 0.823 / 0.996 / 1.000 | FAILED | 0.96 / 0.68 / 0.85 | 0.701 / 0.960 / 0.997 | 2.9 | CALIBRATED | CALIBRATED |
| LEO 600-800 km | 5–7 | 4 | 49187 | 0.976 / 0.998 / 1.000 | FAILED | 0.80 / 0.51 / 0.64 | 0.728 / 0.965 / 0.991 | 2.8 | CALIBRATED | CALIBRATED |
| LEO 800-1200 km | 0–0.5 | 2 | 5784 | 0.002 / 0.010 / 0.020 | INSUFFICIENT | 5.25 / 6.22 / 11.27 | 0.540 / 0.920 / 0.993 | 3.8 | INSUFFICIENT | UNCALIBRATED |
| LEO 800-1200 km | 0.5–1 | 2 | 6056 | 0.023 / 0.074 / 0.158 | INSUFFICIENT | 2.23 / 2.85 / 5.18 | 0.515 / 0.891 / 0.989 | 4.1 | INSUFFICIENT | UNCALIBRATED |
| LEO 800-1200 km | 1–2 | 2 | 12399 | 0.105 / 0.287 / 0.504 | INSUFFICIENT | 1.32 / 1.78 / 3.24 | 0.543 / 0.900 / 0.992 | 3.9 | INSUFFICIENT | UNCALIBRATED |
| LEO 800-1200 km | 2–3 | 2 | 12451 | 0.335 / 0.644 / 0.803 | INSUFFICIENT | 0.82 / 1.03 / 2.15 | 0.572 / 0.914 / 0.992 | 3.7 | INSUFFICIENT | UNCALIBRATED |
| LEO 800-1200 km | 3–5 | 2 | 22594 | 0.504 / 0.760 / 0.872 | INSUFFICIENT | 0.64 / 0.66 / 1.94 | 0.616 / 0.913 / 0.998 | 3.5 | INSUFFICIENT | UNCALIBRATED |
| LEO 800-1200 km | 5–7 | 2 | 18864 | 0.653 / 0.839 / 0.932 | INSUFFICIENT | 0.49 / 0.34 / 1.65 | 0.647 / 0.922 / 1.000 | 3.2 | INSUFFICIENT | UNCALIBRATED |
| LEO 1200-2000 km | 0–0.5 | 2 | 6186 | 0.002 / 0.011 / 0.027 | INSUFFICIENT | 6.76 / 4.68 / 8.24 | 0.629 / 0.940 / 0.997 | 3.4 | INSUFFICIENT | UNCALIBRATED |
| LEO 1200-2000 km | 0.5–1 | 2 | 6644 | 0.028 / 0.111 / 0.254 | INSUFFICIENT | 2.98 / 2.28 / 4.09 | 0.607 / 0.942 / 0.994 | 3.4 | INSUFFICIENT | UNCALIBRATED |
| LEO 1200-2000 km | 1–2 | 2 | 14451 | 0.156 / 0.425 / 0.670 | INSUFFICIENT | 1.66 / 1.41 / 2.53 | 0.630 / 0.951 / 0.999 | 3.3 | INSUFFICIENT | UNCALIBRATED |
| LEO 1200-2000 km | 2–3 | 2 | 14221 | 0.462 / 0.807 / 0.952 | INSUFFICIENT | 1.03 / 0.85 / 1.77 | 0.668 / 0.967 / 1.000 | 3.0 | INSUFFICIENT | UNCALIBRATED |
| LEO 1200-2000 km | 3–5 | 2 | 25685 | 0.596 / 0.919 / 0.995 | INSUFFICIENT | 0.83 / 0.65 / 1.53 | 0.673 / 0.967 / 1.000 | 3.0 | INSUFFICIENT | UNCALIBRATED |
| LEO 1200-2000 km | 5–7 | 2 | 22794 | 0.760 / 0.994 / 1.000 | INSUFFICIENT | 0.65 / 0.54 / 1.18 | 0.635 / 0.959 / 1.000 | 3.2 | INSUFFICIENT | UNCALIBRATED |
| MEO 2000-10000 km | 0–0.5 | 3 | 3024 | 0.020 / 0.062 / 0.126 | FAILED | 2.41 / 3.70 / 4.29 | 0.370 / 0.702 / 0.885 | 10.9 | FAILED | UNCALIBRATED |
| MEO 2000-10000 km | 0.5–1 | 3 | 3099 | 0.085 / 0.200 / 0.339 | FAILED | 1.32 / 2.63 / 2.14 | 0.388 / 0.722 / 0.886 | 10.6 | FAILED | UNCALIBRATED |
| MEO 2000-10000 km | 1–2 | 3 | 5862 | 0.243 / 0.466 / 0.653 | FAILED | 0.70 / 1.87 / 1.37 | 0.423 / 0.740 / 0.892 | 10.5 | FAILED | UNCALIBRATED |
| MEO 2000-10000 km | 2–3 | 3 | 5623 | 0.388 / 0.684 / 0.918 | FAILED | 0.48 / 1.40 / 0.96 | 0.416 / 0.747 / 0.890 | 10.3 | FAILED | UNCALIBRATED |
| MEO 2000-10000 km | 3–5 | 3 | 10590 | 0.563 / 0.888 / 0.971 | FAILED | 0.36 / 0.94 / 0.88 | 0.426 / 0.754 / 0.895 | 9.3 | FAILED | UNCALIBRATED |
| MEO 2000-10000 km | 5–7 | 3 | 8641 | 0.818 / 0.989 / 1.000 | FAILED | 0.26 / 0.67 / 0.75 | 0.529 / 0.822 / 0.949 | 5.4 | FAILED | UNCALIBRATED |
| MEO 10000-30000 km | 0–0.5 | 33 | 12717 | 0.006 / 0.018 / 0.042 | FAILED | 3.71 / 12.58 / 5.17 | 0.612 / 0.942 / 0.985 | 7.6 | FAILED | UNCALIBRATED |
| MEO 10000-30000 km | 0.5–1 | 33 | 12176 | 0.016 / 0.054 / 0.119 | FAILED | 2.34 / 8.34 / 3.96 | 0.623 / 0.944 / 0.985 | 15.9 | FAILED | UNCALIBRATED |
| MEO 10000-30000 km | 1–2 | 33 | 24140 | 0.056 / 0.179 / 0.333 | FAILED | 1.71 / 4.94 / 2.85 | 0.637 / 0.938 / 0.979 | 35.0 | FAILED | UNCALIBRATED |
| MEO 10000-30000 km | 2–3 | 33 | 24687 | 0.182 / 0.423 / 0.653 | FAILED | 1.33 / 2.85 / 2.10 | 0.671 / 0.944 / 0.981 | 68.5 | FAILED | UNCALIBRATED |
| MEO 10000-30000 km | 3–5 | 34 | 49173 | 0.335 / 0.682 / 0.871 | FAILED | 1.37 / 1.79 / 1.77 | 0.731 / 0.946 / 0.974 | 171.9 | FAILED | UNCALIBRATED |
| MEO 10000-30000 km | 5–7 | 34 | 47457 | 0.558 / 0.853 / 0.941 | FAILED | 1.28 / 1.12 / 1.49 | 0.757 / 0.935 / 0.962 | 372.4 | FAILED | UNCALIBRATED |

Five strata pass: LEO 600–800 km at every age except 0.5–1 day, which misses
by 5.6 points at 1 σ. The evidence there is Sentinel-1C/1D, LARETS and
Stella.

- **Unscaled model:** it fails nearly everywhere. It is too narrow at short
  ages and too wide at long ones. One stratum passes, LEO 600–800 km at 2–3
  days.
- **MEO fails even when scaled:**
  - **10000–30000 km:** heavy tails. 1.5–3.8 % fall outside 3 σ, and the mean
    d² is 8–372. GPS errors are persistent per-satellite offsets, so a single
    stratum covariance spans satellites that sit km apart.
  - **2000–10000 km** (LAGEOS-1/2, LARES-2): the error shape is not the
    model's. Radial error is tiny and along-track is flat, giving mean d²
    of 5–11.
- **LEO below 600 and above 800 km:** INSUFFICIENT, with 1–2 reference
  objects per stratum. Below 600 km the scale factors (along-track
  0.02–0.4) show the stratum's population is not the reference satellites'.
- **GEO, beyond 40000 km and eccentric orbits:** no independent reference
  states, so UNCALIBRATED.

## Use

Conjunction assessment uses the scaled model's covariance at each event's
prediction age:
- it labels covariance-based Pc CALIBRATED only in a CALIBRATED stratum,
  with that stratum's reference text;
- everywhere else, Pc is conditional on stated assumptions.

Calibration is evidence for the named reference objects and week. More
reference objects (other missions' precise orbits) and object-class strata
are the way to widen it.
