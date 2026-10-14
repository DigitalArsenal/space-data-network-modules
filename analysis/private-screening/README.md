# Private screening decoys

Decoy orbits for private conjunction screening, and the experiment that
measures how well they hide a real orbit.

An owner screening a satellite that the public catalog lacks submits N
candidate orbits: one real, N − 1 decoys. Only its key says which is real.
The principle and the study are in `docs/decoy-study-2026-08.md`; the protocol
is in `../conjunction-assessment/docs/private-screening.md`.

## Methods

Typed contracts 1.0: every port carries one SDS FlatBuffer.

- **Histories** are `$LFV` rows: `SOURCE_ID` the history's id, `TARGET` (empty
  = the id), `ROLE` (`Real` or `Decoy`; `Unlabelled` reads as real),
  `GENERATOR`, `CLASS_LABEL`, and `ELEMENT_SETS`, the history's `$OMM` element
  sets: `EPOCH` (ISO 8601 UTC; nanosecond digits bring a unix-seconds double
  back exactly), `MEAN_MOTION` (rev/day), `ECCENTRICITY`, `INCLINATION`,
  `RA_OF_ASC_NODE`, `ARG_OF_PERICENTER`, `MEAN_ANOMALY` (deg) and `BSTAR`
  (1/earth radii).
- **Daily ephemeris windows** (hpop view) are one `$OEM`, a block per window:
  `OBJECT.OBJECT_ID` the history, `START_TIME` the window start, the lines up
  to `USEABLE_STOP_TIME` the samples (GCRF km, km/s), and the line at
  `STOP_TIME` after `USEABLE_STOP_TIME` the state at the next window's start.
- **Feature rows** and the **distinguishing report** are `$LFV`.
- **Settings** are node config, read with `plugin.getConfig` (one
  ModuleConfig), one table per method: `decoys`, `features`, `distinguish`,
  with the keys below.

`tests/sds.mjs` builds and reads these frames from the history shapes the
study uses (`{id, target, role, generator, cls, t, n, e, i, raan, argp, ma,
bstar}`, windows `{t, samples, end}` in m and m/s).

### `decoys`

Input `population` ($LFV): the real histories. Each is a target, and the
others are the public catalog its decoys are drawn from.

Config `decoys`: `generator`, `window` [from, to) (unix s), `perTarget`,
`targets`, `donors` (`population` or `regime`: the `neighbours`, default 50,
nearest objects in a and i), `seed`.

Generators:
- **`independent`**: n, e and i from three different objects, B* 0, uniform
  node and phase, SGP4 secular motion only.
- **`rotated`**: one object's history, with the node and mean anomaly shifted
  by uniform constants.
- **`resampled`**: one object's orbit, offset by the (a, i, e) difference
  between a random object and its nearest neighbour. Decay follows the drag
  common mode; manoeuvre steps come at random times; cadence and
  per-element noise are resampled.
- **`chained`**: the same offset start. Each set is the previous one advanced
  by SGP4's secular rates, plus the donor's real consecutive-set changes in
  mean elements, in order from a random start. Each published set gets fresh
  dither that does not carry forward.
- **`aligned`**: chained, with the changes in the donor's own time order and
  epochs.
- **`fleet`**: the target's own history, node rotated and epochs shifted by
  up to half a period: copies of the hidden satellite itself.

Output `decoys` ($LFV): histories with `ROLE` Decoy, `TARGET` and `GENERATOR`
set. `SOURCE_COUNT` is the targets asked, `REFERENCE_COUNT` the donors
(population histories with 6 element sets in the window), `SKIPPED_COUNT` the
decoys refused for fewer than 6 sets.

### `features`

Inputs: `histories` ($LFV, real and decoy) and, for the hpop view,
`ephemerides` ($OEM). Config `features`: `view`, `window`, `minPoints`
(default 6 for gp, 8 for hpop).

- `view: "gp"` reads the element sets.
- `view: "hpop"` reads the daily windows: samples spaced over one orbit from
  the window start, and the state at the next window's start.

Output `features` ($LFV): one row per history with enough points, `VALUES` in
`FEATURE_NAMES` order (NaN = not computable); `SOURCE_COUNT` the histories,
`REFERENCE_COUNT` the catalog, `SKIPPED_COUNT` those with too few points.

Every feature is rotation-invariant:
- orbit: a, e, i;
- decay and its scatter, the largest step, and steps per day;
- e and i scatter, and i drift;
- node-rate residual against SGP4 (gp) or J2 (hpop);
- gp view only: cadence, B*, and the agreement of consecutive sets (RTN);
- hpop view only: the jump between consecutive windows (RTN);
- both views: the correlation of daily decay with the drag common mode, the
  best lagged correlation of the history's changes with those of the 30 most
  similar public objects, and the distance to the nearest public object.

The catalog is the real histories, minus the target itself.

### `distinguish`

Inputs:
- `features` ($LFV): rows from `features`, the real rows plus one generator's
  decoys (`ROLE` Real counts as real, any other role as decoy);
- config `distinguish` (optional): `folds`, `depth`, `rounds`, `learningRate`,
  `lambda`, `minChildHessian`, `bins`, `seed`, `ranks`, `exclude`, and
  `relative` (each feature minus its median over the target's own
  candidates).

The classifier is gradient-boosted trees (logistic loss), cross-validated by
target. The report (`report`, an `$LFV` whose `REPORT` is an `LFVTestReport`)
gives:
- AUC;
- a 95 % lower bound on ε: the threshold is chosen on half the targets and
  bounded on the other half, with one-sided Clopper–Pearson limits;
- P(the real history scores highest of N) = E[F(s_real)^(N − 1)], and
  N_eff = 1/P, overall and by class;
- per-feature AUC and gain share;
- with 10 or more decoys per target, the real one's rank within its own set
  (histogram, KS distance from uniform) and P₁(N) from those ranks and from
  standardized scores pooled over sets.

Ties count as a uniform draw among the tied candidates.

## Study

```
node scripts/decoy-study.mjs [--objects 3000] [--from 2026-08-02 --to 2026-08-29] \
  [--hpop-from 2026-08-09 --hpop-days 14] [--generators …] [--per-target 1] \
  [--relative] [--views gp,gp-28d,hpop] [--reuse-features] [--out DIR]
```

It reads the GP archive (`/opt/data/sdn-archive/spacetrack/gp_history/by-creation`).
For the HPOP view, each day's window is propagated from the latest element set
through `analysis/epoch-state` and the `propagator/hpop` resident. The
helpers are shared from `../gp-error-model/scripts/hpop.mjs`.

Element sets, histories and features stay on the machine; only aggregates are
committed.

## Build and test

```
export SPACE_DATA_STANDARDS_ROOT=…   # a standards tree with LFV
npm run build && npm test
```
