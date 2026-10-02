# HPOP covariance calibration, 2026-08

Does HPOP's propagated covariance, P(t) = Φ P₀ Φᵀ + Q, describe the actual
error of the CA HPOP screen's product? That product is:
- analysis/epoch-state's GCRF state at an element set's epoch;
- propagated by propagator/hpop's resident force model: point mass and the
  EGM2008 degree/order 20 field in Earth-fixed axes, with no Sun, Moon, drag
  or radiation pressure.

Files:
- labels: [`hpop-calibration-2026-08.json`](hpop-calibration-2026-08.json);
- model: [`hpop-covariance-model-2026-08.json`](hpop-covariance-model-2026-08.json);
- methods: `hpop_arcs` and `hpop_coverage`;
- script: `scripts/hpop-calibration.mjs`.

## Method

1. **Arcs.** Every element set of the 48 reference objects with epoch
   2026-07-26 to 08-15 seeds one HPOP arc: 1,509 arcs in all.
2. **Targets.** Each arc is propagated to the reference epoch nearest each
   prediction age (0, 0.25, 0.75, 1.5, 2.5, 4 and 6 days). The age-0 target
   is the first reference epoch within 30 minutes after the set's epoch.
   Every target is compared with an independent reference state: IGS,
   ILRS, ILRS NSGF, Sentinel-1 or Swarm.
3. **P₀ (fit week, 08-02 to 08).** Per regime, the second moment about zero
   of the 6-D RTN error at age 0, after a 5 robust sigma clip. It is rotated
   into GCRF at each arc's epoch.
4. **Q (fit week).** Q is white acceleration on the R, T and N axes, at a
   600 s discretization. HPOP runs four times per arc: P₀ alone, then P₀ = 0
   with unit density on each axis. P(t) is linear in both, so any Q can be
   scored.
   - The densities per regime are the maximum-likelihood fit to the
     position errors at ages above 0.
   - Likelihood and containment can disagree. A regime therefore keeps
     Q = 0 when P₀ alone passes the gate in more fit-week strata. Only the
     fit week enters this choice.
5. **Test (held out, 08-09 to 15).** Zero-mean d² = eᵀP⁻¹e against χ² on 3
   degrees of freedom, by regime and prediction age, with every sample
   counted. The gate is the same as for SGP4:
   - 1σ and 2σ containment within 5 points of nominal;
   - at most 1 % outside 3σ;
   - at least 30 samples from at least 3 objects.

## Results (test week)

The table shows the strata with at least 3 reference objects. The others are
INSUFFICIENT: every LEO band except 600–800 km holds only one or two
reference objects.

| Regime | Age (d) | Samples (objects) | Inside 1σ / 2σ / 3σ | Status | RMS error R / T / N (km) | RMS σ R / T / N (km) |
| --- | --- | ---: | --- | --- | --- | --- |
| LEO 600–800 km | 0–0.5 | 233 (4) | 0.64 / 0.94 / 1.00 | CALIBRATED | 0.13 / 1.49 / 0.16 | 0.13 / 1.33 / 0.14 |
| LEO 600–800 km | 0.5–1 | 114 (4) | 0.72 / 0.98 / 1.00 | CALIBRATED | 0.10 / 5.75 / 0.15 | 0.12 / 5.11 / 0.17 |
| LEO 600–800 km | 1–2 | 113 (4) | 0.71 / 0.97 / 1.00 | CALIBRATED | 0.11 / 10.96 / 0.20 | 0.13 / 10.22 / 0.20 |
| LEO 600–800 km | 2–3 | 111 (4) | 0.64 / 0.94 / 1.00 | CALIBRATED | 0.14 / 18.67 / 0.16 | 0.14 / 17.16 / 0.17 |
| LEO 600–800 km | 3–5 | 108 (4) | 0.57 / 0.79 / 0.93 | FAILED | 0.12 / 29.65 / 0.22 | 0.16 / 27.40 / 0.21 |
| LEO 600–800 km | 5–7 | 80 (4) | 0.59 / 0.76 / 0.88 | FAILED | 0.21 / 42.45 / 0.19 | 0.26 / 41.33 / 0.21 |
| MEO 2000–10000 km | 0–0.5 | 51 (3) | 0.45 / 0.71 / 0.92 | FAILED | 0.06 / 0.59 / 0.16 | 0.06 / 0.50 / 0.14 |
| MEO 10000–30000 km | 0–0.5 | 530 (33) | 0.76 / 0.98 / 1.00 | FAILED | 0.18 / 1.94 / 0.22 | 0.24 / 2.12 / 0.35 |
| MEO 10000–30000 km | 1–2 | 252 (33) | 0.71 / 0.95 / 0.99 | FAILED | 0.32 / 11.25 / 1.15 | 0.23 / 3.76 / 1.12 |
| MEO 10000–30000 km | 5–7 | 247 (34) | 0.58 / 0.87 / 0.97 | FAILED | 0.52 / 36.37 / 3.45 | 0.36 / 15.50 / 2.24 |
| Nominal | | | 0.68 / 0.95 / 1.00 | | | |

Every stratum is in the JSON. Of 42 strata, 4 are CALIBRATED, 9 FAILED and
29 INSUFFICIENT.

- **LEO 600–800 km, 0–3 days: CALIBRATED with P₀ alone.**
  - These objects' P₀ is 0.12 / 0.56 / 0.13 km and 0.59 / 0.14 / 0.21 m/s
    (R, T, N).
  - Carried through HPOP's state transition matrix, it reproduces the
    along-track growth (1.3 km to 17 km in three days) within 10 %.
  - Radial and normal error stay within 0.1–0.2 km, as Φ P₀ Φᵀ predicts.
  - The maximum-likelihood Q passed only one fit-week stratum, so it was
    not used.
- **LEO 600–800 km beyond 3 days: FAILED.** Along-track error outgrows P₀
  (42 km against 41 km RMS at 6 days, but with heavier tails). A white
  acceleration fitted to the earlier ages over-covers them.
- **MEO 10000–30000 km (GPS): FAILED at every age.** Along-track error
  reaches 7 km within a day against 2.6 km predicted, and normal error grows
  about 0.6 km a day. The resident model has no Sun or Moon, and lunisolar
  forces dominate both. Within half a day the GPS element sets' own
  along-track offsets (−1.6 to +3.8 km) drive the error.
- **MEO 2000–10000 km (LAGEOS-1/2, LARES-2): FAILED within half a day,
  INSUFFICIENT beyond.** Only 3 objects; the later strata have fewer than 30
  samples.

The labels hold for these objects in this week.

## HPOP faults found by this calibration

The first runs fitted Q of 10⁻⁵–10⁻⁴ m²/s³ per axis, tens of kilometres
within a day. They were covering three HPOP faults, fixed in
propagator/hpop on 2026-10-02:
- **Inertial axes.** The gravity fields were evaluated at the GCRF position
  itself: tesserals frozen in inertial space, pole off by the precession
  since J2000.
- **A partial field.** The built-in "degree/order 20" field held only J2–J6
  and the tesserals through degree 4. Its J5 and J6 were unnormalized values
  with the wrong sign.
- **Frames and clock.** The frame library's nutation sign and GCRF-to-ITRF
  composition were wrong (0.74° off). The integrators evaluated an unset
  force clock at JD 0.

Against the reference orbits (LEO 600–800 km, 5–7 days), the fixes cut the
RMS error:
- radial, from 5.9 km to 0.2 km;
- normal, from 10.9 km to 0.2 km.

The "before" figures come from a 250-arc sample.

## Not covered

- **Other force models.** The calibration covers HPOP's resident force model
  only. A force model with the Sun, Moon and drag needs its own run, and is
  the route to GPS and to LEO below 600 km.
- **Other seeds.** P₀ is that of a state seeded from an element set. HPOP
  seeded from orbit determination carries the fit's own covariance, which
  is not calibrated here.
- **One reference week.** More reference missions would open the other LEO
  bands.
