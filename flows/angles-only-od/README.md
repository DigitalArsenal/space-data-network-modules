# flows/angles-only-od

Angles-only orbit determination with no element set on any port: RA/Dec `$TDM` tracks (data-source/satnogs-optical-source)
-> Gooding initial orbit (analysis/optical-astrometry `initial_orbit`, on the arc's tracks) -> analysis/estimation
`fit_batch` with propagator/ffm as the dynamics -> one Cartesian `$OCM` that propagator/sdn-ap fit reads.

## Stages and revolution count

The arc is split into nights (gaps over 6 h). Stage 1 fits the nights the initial orbit's sights span (its `START_TIME`
to `STOP_TIME`); each later stage adds the unfitted night nearest the fitted ones (`FIT_START` to `FIT_STOP`). The first
stage that spans a nightly gap before any fit has spanned one sets the revolution count over it from a candidate set:
the base state (the initial orbit, or the last stage's state) moved by k revolutions, n_k = n + 2 pi k / dt (n its
two-body mean motion, dt from its epoch to the stage's farthest observation; the speed by vis-viva, the position and the
velocity's direction kept), k in [`revolutionOffsetMin`, `revolutionOffsetMax`] (default -1..1). Each seed is fitted,
and a candidate counts only when the fit converges, its `WEIGHTED_RMS` is at most `weightedRmsLimit` and it kept its
count (|n - n_seed| dt / 2 pi < 0.5). The lowest `WEIGHTED_RMS` wins; none: `no-converged-revolution-count`. Other
stages carry the last stage's state. Arcs under 24 h: `arc-too-short:<hours>`. Per-station time bias enters
flows/observation-od as a consider `TIME_BIAS`.

## Composition

`plan` (observations, initial, stage, execution, config) -> one `$PRW` EXECUTION_REQUEST per candidate on `execution`
(the seed in INITIAL, the initial orbit's epoch in TARGET_EPOCH) and the stage's tracks on `observations`. The host runs
each to its end through flows/observation-od `step` (RA/Dec, `angleSigmaArcsec`, `timeBiasSigmaS.<station>`, the
source's `$PVN`). `select` (observations, initial, stage, candidates, executions, config): each candidate's `$OCM` with
its execution, in the same order -> the stage's `$OCM` on `selected`, or `no-converged-revolution-count`; it becomes
`stage` for the next `plan`; `report` REASON `complete` ends the arc. Config: `revolutionOffsetMin` (-1),
`revolutionOffsetMax` (1), `weightedRmsLimit` (2), `minimumArcHours` (24).

## Build and E2E

```sh
SPACE_DATA_MODULE_SDK_COMPILE_CACHE=0 node build.mjs
node tests/angles-od.e2e.mjs
```

The E2E flies a simulated arc, no SatNOGS row: a Sentinel-6B-like orbit (propagator/ffm, EGM2008 20x20 with the EOP)
seen from station 11 on the six nights of the 2026-09-21 to 26 sessions (18:00 to 05:00 UTC), RA/Dec at 23 arcsec every
1 s (analysis/observation-simulator, after foundation/frames and analysis/access), the tags late by 10 ms, each pass cut
to field crossings of 40 to 90 s (1 to 3 per pass, 1 to 3 passes per night; night 1 a single crossing). Darkness is
approximated by a Sun fixed in Earth-fixed axes 20 deg below station 11's northern horizon. It asserts `single-crossing`
on night 1, the arc-end position error below 0.15 km (the record's bound), `no-converged-revolution-count` with the
offset forced to +1, and no USER_DEFINED_PARAMETERS.
