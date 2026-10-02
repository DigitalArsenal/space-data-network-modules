# Private screening decoys

Decoy orbits for private conjunction screening, and the experiment that
measures how well they hide a real orbit.

An owner screening a satellite that the public catalog lacks submits N
candidate orbits: one real, N − 1 decoys. Only its key says which is real.
The principle and the study are in `docs/decoy-study-2026-08.md`; the protocol
is in `../conjunction-assessment/docs/private-screening.md`.

## Methods

All ports carry JSON. Histories are
`{objects: [{id, target?, role, generator?, cls?, t, n, e, i, raan, argp, ma, bstar}]}`:
SGP4 mean elements per element set. Units: t in unix seconds, n in rev/day,
angles in degrees, B* in 1/earth radii.

### `decoys`

Inputs:
- `population`: real histories. Each is a target, and the others are the
  public catalog its decoys are drawn from.
- `options`: `generator`, `window` [from, to) (unix s), `perTarget`, `targets`,
  `donors` (`population` or `regime`: the 50 nearest objects in a and i),
  `seed`.

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

Output: `decoys`, histories with role `decoy` and `target` set, plus a report
with counts and the drag common mode per 100 km band.

### `features`

Inputs: `histories` (real and decoy), and `options` `{view, window}`.

- `view: "gp"` reads the element sets.
- `view: "hpop"` reads `windows: [{t, samples, end}]`:
  - `samples`: [t, x, y, z, vx, vy, vz] in GCRF m and m/s, spaced over one
    orbit from the window start;
  - `end`: the state at the next window's start.

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
- `features`: rows from `features`, the real rows plus one generator's
  decoys;
- `options` (optional): `folds`, `depth`, `rounds`, `learningRate`, `bins`,
  `seed`, `ranks`, `exclude`.

The classifier is gradient-boosted trees (logistic loss), cross-validated by
target. The report gives:
- AUC;
- a 95 % lower bound on ε: the threshold is chosen on half the targets and
  bounded on the other half, with one-sided Clopper–Pearson limits;
- P(the real history scores highest of N) = E[F(s_real)^(N − 1)], and
  N_eff = 1/P, overall and by class;
- per-feature AUC and gain share.

## Study

```
node scripts/decoy-study.mjs [--objects 3000] [--from 2026-08-02 --to 2026-08-29] \
  [--hpop-from 2026-08-09 --hpop-days 14] [--skip-hpop | --reuse-hpop] [--out DIR]
```

It reads the GP archive (`/opt/data/sdn-archive/spacetrack/gp_history/by-creation`).
For the HPOP view, each day's window is propagated from the latest element set
through `analysis/epoch-state` and the `propagator/hpop` resident. The
helpers are shared from `../gp-error-model/scripts/hpop.mjs`.

Element sets, histories and features stay on the machine; only aggregates are
committed.

## Build and test

```
npm install && npm run build && npm test
```
