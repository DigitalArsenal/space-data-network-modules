# FFM (Full Force Model) covariance calibration, 2026-08

FFM (Full Force Model) is defined in [the FFM specification](../../../propagator/ffm/FFM.md).

Does FFM's propagated covariance, P(t) = Φ P₀ Φᵀ + Q, describe the actual
error of the CA FFM screen's product? That product is:
- analysis/epoch-state's GCRF state at an element set's epoch;
- propagated by propagator/ffm at full force, the screen's configuration
  (`propagator/ffm/catalog.mjs`): EGM2008 70×70; the Sun, Moon, Venus, Mars
  and Jupiter from DE440s; NRLMSISE-00; cannonball radiation pressure with
  the conical shadow; Knocke Earth radiation; IERS 2010 solid tides and
  relativity; FES2004 ocean tides 30×30; RK78 at 1e-12, steps of at most
  300 s. Cd·A/m comes from the element set's B* (the module's conversion;
  0.01 m²/kg where B* ≤ 0) and Cr·A/m is 0.02 m²/kg. Earth orientation and
  space weather are as released on the element set's day.

Files:
- labels: [`ffm-calibration-2026-08.json`](ffm-calibration-2026-08.json);
- model: [`ffm-covariance-model-2026-08.json`](ffm-covariance-model-2026-08.json);
- methods: `ffm_arcs` and `ffm_coverage`;
- script: `scripts/ffm-calibration.mjs` (`--ffm-environment`: the JPL
  kernel and, per day, the Earth orientation and space weather as PRW
  records).

## Method

1. **Arcs.** Every element set of the 48 reference objects with epoch
   2026-07-26 to 08-15 seeds one FFM arc: 1,510 arcs in all, 7,654 targets.
2. **Targets.** Each arc is propagated to the reference epoch nearest each
   prediction age (0, 0.25, 0.75, 1.5, 2.5, 4 and 6 days), sampled in one
   integration. The age-0 target is the first reference epoch within 30
   minutes after the set's epoch. Every target is compared with an
   independent reference state: IGS, ILRS, ILRS NSGF, Sentinel-1 or Swarm.
3. **P₀ (fit week, 08-02 to 08).** Per regime, the second moment about zero
   of the 6-D RTN error at age 0, after a 5 robust sigma clip. It is rotated
   into GCRF at each arc's epoch.
4. **Q (fit week).** Q is white acceleration on the R, T and N axes, at a
   600 s discretization. FFM runs four times per arc, with the analytic
   state transition matrix and the density gradient: P₀ alone, then P₀ = 0
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

The table shows the strata with at least 3 reference objects and 30
samples, and MEO 2000–10000 km within half a day. The others are
INSUFFICIENT: every LEO band except 600–800 km holds only one or two
reference objects.

| Regime | Age (d) | Samples (objects) | Inside 1σ / 2σ / 3σ | Status | RMS error R / T / N (km) | RMS σ R / T / N (km) |
| --- | --- | ---: | --- | --- | --- | --- |
| LEO 600–800 km | 0–0.5 | 236 (4) | 0.64 / 0.93 / 1.00 | CALIBRATED | 0.13 / 1.47 / 0.16 | 0.13 / 1.32 / 0.14 |
| LEO 600–800 km | 0.5–1 | 117 (4) | 0.75 / 0.97 / 1.00 | FAILED | 0.10 / 5.65 / 0.16 | 0.12 / 5.12 / 0.17 |
| LEO 600–800 km | 1–2 | 115 (4) | 0.71 / 0.97 / 1.00 | CALIBRATED | 0.11 / 10.82 / 0.20 | 0.13 / 10.23 / 0.20 |
| LEO 600–800 km | 2–3 | 112 (4) | 0.64 / 0.94 / 1.00 | CALIBRATED | 0.13 / 18.45 / 0.17 | 0.14 / 17.18 / 0.17 |
| LEO 600–800 km | 3–5 | 108 (4) | 0.56 / 0.82 / 0.95 | FAILED | 0.12 / 29.37 / 0.23 | 0.16 / 27.43 / 0.21 |
| LEO 600–800 km | 5–7 | 83 (4) | 0.63 / 0.83 / 0.90 | FAILED | 0.21 / 41.63 / 0.21 | 0.26 / 41.37 / 0.21 |
| MEO 2000–10000 km | 0–0.5 | 51 (3) | 0.47 / 0.69 / 0.90 | FAILED | 0.06 / 0.58 / 0.16 | 0.06 / 0.50 / 0.13 |
| MEO 10000–30000 km | 0–0.5 | 530 (33) | 0.63 / 0.96 / 1.00 | FAILED | 0.26 / 2.05 / 0.15 | 0.23 / 2.12 / 0.14 |
| MEO 10000–30000 km | 0.5–1 | 252 (33) | 0.63 / 0.97 / 0.99 | FAILED | 0.43 / 7.74 / 0.14 | 0.29 / 2.58 / 0.14 |
| MEO 10000–30000 km | 1–2 | 252 (33) | 0.73 / 0.97 / 0.98 | FAILED | 0.32 / 11.57 / 0.13 | 0.21 / 3.72 / 0.14 |
| MEO 10000–30000 km | 2–3 | 255 (33) | 0.79 / 0.98 / 0.99 | FAILED | 0.31 / 15.67 / 0.12 | 0.23 / 5.85 / 0.14 |
| MEO 10000–30000 km | 3–5 | 259 (33) | 0.84 / 0.98 / 0.98 | FAILED | 0.37 / 23.06 / 0.12 | 0.27 / 9.72 / 0.13 |
| MEO 10000–30000 km | 5–7 | 247 (34) | 0.87 / 0.97 / 0.98 | FAILED | 0.48 / 35.88 / 0.12 | 0.32 / 15.75 / 0.13 |
| Nominal | | | 0.68 / 0.95 / 1.00 | | | |

Every stratum is in the JSON. Of 42 strata, 3 are CALIBRATED, 10 FAILED and
29 INSUFFICIENT.

- **LEO 600–800 km, 0–0.5 and 1–3 days: CALIBRATED with P₀ alone.**
  - These objects' P₀ is 0.12 / 0.56 / 0.13 km and 0.59 / 0.14 / 0.21 m/s
    (R, T, N).
  - Carried through FFM's state transition matrix, it predicts the
    along-track growth (1.3 km to 17 km in three days) within 11 %.
  - Radial and normal error stay within 0.1–0.2 km, as Φ P₀ Φᵀ predicts.
  - P₀ alone passed four fit-week strata and the maximum-likelihood Q one,
    so Q is zero.
- **LEO 600–800 km, 0.5–1 day: FAILED.** 75 % of the samples fall inside
  1σ, 7 points above nominal.
- **LEO 600–800 km beyond 3 days: FAILED.** Along-track error outgrows P₀
  (42 km against 41 km RMS at 6 days, with heavier tails).
- **MEO 10000–30000 km (GPS): FAILED at every age.** With the Sun and Moon
  the normal error stays within 0.15 km for a week. The along-track error
  reaches 7.7 km RMS within a day against 2.6 km predicted, and 36 km at
  5–7 days against 16 km; most samples fall inside 1σ while 2 % fall
  outside 3σ. The error is in the epoch state (below).
- **MEO 2000–10000 km (LAGEOS-1/2, LARES-2): FAILED within half a day,
  INSUFFICIENT beyond.** Only 3 objects; the later strata have fewer than 30
  samples.

The labels hold for these objects in this week.

### Where the GPS along-track error comes from

Every GPS arc of both weeks (508 arcs with a reference state within 30
minutes of the element set's epoch) was propagated by the same full force
model twice: from the element set's epoch state, as the screen starts it,
and from that independent reference state. Along-track error against the
reference states, median (90th percentile), km:

| Start | 0.25 d | 0.75 d | 1.5 d | 2.5 d | 4 d | 6 d |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Element-set epoch state | 1.47 (3.78) | 1.75 (4.32) | 2.54 (5.95) | 3.65 (8.52) | 5.51 (12.8) | 8.39 (17.0) |
| Reference state | 0.004 (0.011) | 0.011 (0.028) | 0.044 (0.104) | 0.075 (0.166) | 0.116 (0.270) | 0.195 (0.473) |
| Reference state, Cr·A/m doubled | 0.013 (0.031) | 0.015 (0.038) | 0.249 (0.436) | 0.408 (0.683) | 0.626 (1.11) | 0.974 (1.78) |

From the reference state, the same force model (the cannonball with its
default Cr·A/m and the conical shadow) leaves 0.2 km along-track after six
days, and 1 km with the radiation pressure doubled; from the element set's
epoch state the error is forty times larger and grows nearly linearly with
age, as an error in the mean motion does. The along-track error is the epoch
state's, not the force model's. Two satellites depart from their reference
products from either start: NORAD 35752 by up to 200 km (as in the
companion orbit-accuracy study) and NORAD 38833 by about 7 km after six
days.

## Not covered

- **Other seeds.** P₀ is that of a state seeded from an element set. FFM
  seeded from orbit determination carries the fit's own covariance, which
  is not calibrated here.
- **One reference week.** More reference missions would open the other LEO
  bands.
