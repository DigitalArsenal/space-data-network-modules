# Screening evaluation, 2026-08

Three ways of deciding whether to alert on a close approach, scored on cases
built from real SGP4 errors (ASO catalog paper sections 9 and 12):

- **Probabilistic:** Foster Pc.
- **Bounded set:** a fixed-coverage relative ellipse.
- **Possibility:** the admissible-set framework, with possibility and
  necessity of collision.

Data: [`screening-evaluation-2026-08.json`](screening-evaluation-2026-08.json).
Method: `screening_evaluation`. Script: `scripts/screening-evaluation.mjs`.

## Cases

1. **Errors.** Each SGP4 prediction is compared with an independent reference
   state in the held-out week, 2026-08-09 to 15. The reference states are
   IGS, ILRS, ILRS NSGF, Sentinel-1 and Swarm: 48 objects and 733,773 error
   samples. Each error is taken in its own RTN axes.
2. **Pairs.** Each stratum (regime × prediction age) draws 500 pairs of errors
   from two different objects. A stratum with a single reference object has no
   pairs, so LEO 450–600 km, which has only Swarm B, is absent.
3. **Encounter planes.** Each pair is placed in two planes:
   - head-on: radial and normal, with the secondary's normal reversed;
   - crossing at 90°: radial plus (T+N)/√2 for the primary, and (T′−N′)/√2 in
     the secondary's own axes.
4. **Misses.** The true miss is synthetic: 0, 10, 50, 100, 500, 1000, 2000 or
   5000 m, in 4 directions. The predicted miss is the true miss plus the
   pair's relative error.
5. **Collision truth.** A case is a collision when the true miss is at most
   the hard-body radius, 20 m.
6. **Covariance.** Each object gets its stratum's position covariance from
   `model-2026-08-scaled.json`, projected to the plane.

## Rules

| Rule | Alerts when |
| --- | --- |
| Probabilistic | Foster Pc with C₁ + C₂ ≥ 1e-4 |
| Bounded set | the relative ellipse at 99.73 % (χ², 2 dof) comes within 20 m of the origin |
| Possibility | N(no collision) < 0.9973 |

For the possibility rule:

- **Per object:** π(e) = 1 − F_χ²₃(eᵀC⁻¹e), the Gaussian
  probability-to-possibility transform.
- **Joint:** min(π₁, π₂), for independent objects.
- **Scores:** Π(collision) is the supremum over colliding error pairs, and
  N(no collision) = 1 − Π(collision).
- **Enclosure:** the α-cut of the relative error is the Minkowski sum of the
  two objects' ellipses, a conservative enclosure.

## Results, CALIBRATED strata

These are the five LEO 600–800 km strata whose covariance passed the held-out
calibration gate, with 10,000 cases per row.

Rows at 0 and 10 m (collisions) give **missed collisions**. Every other row
gives **false alerts**. All rates are in percent.

| Miss (m) | Head-on Pc | Head-on bounded | Head-on possibility | Crossing Pc | Crossing bounded | Crossing possibility |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 (collision) | 2.7 | 0.2 | 0.0 | 16.1 | 0.4 | 0.0 |
| 10 (collision) | 2.7 | 0.2 | 0.0 | 16.2 | 0.4 | 0.0 |
| 50 | 97.1 | 99.8 | 100.0 | 83.7 | 99.6 | 100.0 |
| 100 | 96.0 | 99.7 | 100.0 | 82.2 | 99.5 | 100.0 |
| 500 | 56.4 | 81.8 | 99.7 | 48.0 | 91.4 | 100.0 |
| 1000 | 6.7 | 21.4 | 68.7 | 6.3 | 44.9 | 88.7 |
| 2000 | 0.0 | 0.0 | 4.3 | 0.0 | 4.5 | 24.1 |
| 5000 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |

- **Pc misses collisions because of dilution.** Along-track sigma in these
  strata is 0.6–3 km. For a true collision the mean Pc is only 1.9e-3 head-on
  and 5.6e-4 crossing. In the crossing plane the along-track error enters the
  plane, so 16 % of collisions fall below 1e-4. That rises to 47.5 % at 5–7 d
  of prediction age.
- **Possibility never missed a collision** in a calibrated stratum. The cost
  is false alerts: 69–89 % at 1 km and 4–24 % at 2 km.
- **The bounded set sits between the two**: 0.2–0.4 % of collisions missed,
  and 21–45 % false alerts at 1 km.
- **Below about 100 m no rule separates** collisions from near misses at
  these error sizes: every rule alerts on nearly all of them.

## By regime and age

The table gives missed collisions, as a percentage of the 0 m and 10 m cases,
and false alerts at a 1 km miss. Each cell lists Pc / bounded / possibility.

| Regime | Age (d) | Label | Objects | Missed, head-on | Missed, crossing | False alerts at 1 km, head-on |
| --- | --- | --- | ---: | --- | --- | --- |
| LEO below 450 km | 0–0.5 | U | 2 | 1.0 / 0.0 / 0.0 | 5.0 / 0.0 / 0.0 | 0.1 / 1.2 / 41.0 |
| LEO below 450 km | 1–2 | U | 2 | 1.9 / 0.0 / 0.0 | 39.1 / 15.5 / 3.2 | 5.7 / 25.6 / 84.6 |
| LEO below 450 km | 5–7 | U | 2 | 59.6 / 0.0 / 0.0 | 100.0 / 0.0 / 0.0 | 2.1 / 79.0 / 99.7 |
| LEO 600–800 km | 0–0.5 | C | 4 | 1.9 / 0.4 / 0.0 | 2.4 / 0.0 / 0.0 | 0.1 / 1.1 / 34.9 |
| LEO 600–800 km | 3–5 | C | 4 | 2.8 / 0.0 / 0.0 | 17.9 / 0.0 / 0.0 | 8.9 / 33.8 / 90.5 |
| LEO 600–800 km | 5–7 | C | 4 | 3.1 / 0.0 / 0.0 | 47.5 / 1.4 / 0.0 | 22.0 / 58.3 / 99.1 |
| LEO 800–1200 km | 0–0.5 | U | 2 | 3.0 / 0.4 / 0.0 | 1.8 / 0.0 / 0.0 | 0.1 / 1.2 / 31.4 |
| LEO 1200–2000 km | 0–0.5 | U | 2 | 1.4 / 0.5 / 0.0 | 0.2 / 0.0 / 0.0 | 0.0 / 0.0 / 2.0 |
| MEO 2000–10000 km | 0–0.5 | U | 3 | 18.5 / 16.1 / 6.9 | 20.0 / 16.0 / 6.7 | 0.0 / 0.0 / 0.0 |
| MEO 10000–30000 km | 0–0.5 | U | 33 | 5.6 / 2.4 / 1.4 | 24.2 / 0.4 / 0.4 | 1.7 / 8.0 / 62.7 |
| MEO 10000–30000 km | 5–7 | U | 34 | 8.0 / 1.8 / 0.8 | 46.8 / 5.0 / 3.0 | 24.6 / 82.7 / 98.8 |

The JSON has every stratum, geometry and miss.

**Possibility misses collisions only in UNCALIBRATED strata**, where the
covariance understates the error. Examples:

- MEO 2000–10000 km (LAGEOS-1/2, LARES-2) misses 5–8 %;
- GPS misses up to 3 %, from its per-satellite along-track offsets.

The rule is only as good as its declared possibility model: it carries the
calibration gate's verdict, it does not replace it.

## Limits

- **Synthetic true misses.** True misses are designed, so the collision base
  rate here is not the real one. Pc's Brier score and mean values show
  dilution, not operational accuracy.
- **Independent objects.** Objects are treated as independent, so the joint
  possibility is min(π₁, π₂). Correlated errors from shared tracking evidence
  are not modelled.
- **Short-term encounters only.** The encounter planes assume short-term
  encounters with fixed geometry; slow and long encounters are not covered.
- **Narrow reference set.** The reference objects are the cataloged precise
  orbits: 48 objects, mostly geodetic and navigation satellites. Calibration,
  and therefore these rates, hold for those objects in this week.

## Disclosure

The baselines (Foster Pc, the fixed-coverage relative ellipse) and the cases
were chosen independently of the TEAG/ESPF authors' implementations. No
TEAG/ESPF code was run. The possibility rule implements the admissible-set
framework as the ASO catalog paper describes it in section 12.
