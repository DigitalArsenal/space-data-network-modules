# flows/angles-only-od

Angles-only orbit determination with no element set on any port: RA/Dec `$TDM` tracks (data-source/satnogs-optical-source)
-> Gooding initial orbit (analysis/optical-astrometry `initial_orbit`, on the first track) -> analysis/estimation
`fit_batch` with propagator/ffm as the dynamics -> one Cartesian `$OCM` that propagator/sdn-ap fit reads.

## Batch and revolution count

The arc is split into nights (gaps over 6 h). Stage 1 fits night 1 from the initial orbit; stage s fits nights 1..s from
stage s-1's estimate. Across the first nightly gap the revolution count is a candidate set: N0 = floor(n1 dt / 2 pi)
(n1 stage 1's two-body mean motion, dt the first observation to night 2's last) and N0 + k for k in
[`revolutionOffsetMin`, `revolutionOffsetMax`] (default -1..1). Each count's seed is a Gooding initial orbit through
both nights (optical-astrometry `initial_orbit` with `revolutions` and `branch`, both Lambert branches), each seed is
fitted, and a candidate counts only when the fit converges, its `WEIGHTED_RMS` is at most `weightedRmsLimit` and it kept
its count (|n - n_seed| dt / 2 pi < 0.5). The lowest `WEIGHTED_RMS` wins; none: `no-converged-revolution-count`.
Arcs under 24 h: `arc-too-short:<hours>`. Per-station time bias enters flows/observation-od as a consider `TIME_BIAS`.

## Composition

`plan` (observations, initial, stage, seeds, execution, config): stage 2 without seeds -> one ModuleConfig per count and
branch on `initial_orbit_config` and the stage's tracks; otherwise one `$PRW` EXECUTION_REQUEST per seed on `execution`
(the seed in INITIAL, the initial orbit's epoch in TARGET_EPOCH) and the stage's tracks on `observations`. The host runs
each to its end through flows/observation-od `step` (RA/Dec, `angleSigmaArcsec`, `timeBiasSigmaS.<station>`, the
source's `$PVN`). `select` (observations, initial, stage, seeds, candidates, config) -> the stage's `$OCM` on
`selected`, or `no-converged-revolution-count`; it becomes `stage` for the next `plan`; `report` REASON `complete` ends
the arc. Config: `revolutionOffsetMin` (-1), `revolutionOffsetMax` (1), `weightedRmsLimit` (2), `minimumArcHours` (24).

## Build and E2E

```sh
SPACE_DATA_MODULE_SDK_COMPILE_CACHE=0 node build.mjs
node tests/angles-od.e2e.mjs
```

The E2E flies a simulated arc, no SatNOGS row: a Sentinel-6B-like orbit (propagator/ffm, EGM2008 20x20 with the EOP)
seen from stations 11 and 15 on the six nights of the 2026-09-21 to 26 sessions (18:00 to 05:00 UTC), RA/Dec at
23 arcsec (analysis/observation-simulator, after foundation/frames and analysis/access), the tags late by 10 and 51 ms.
Darkness is approximated by a Sun fixed in Earth-fixed axes 20 deg below station 11's northern horizon. It asserts the
arc-end position error below 0.5 km (the record's bound), `no-converged-revolution-count` with the offset forced to +1, and no
USER_DEFINED_PARAMETERS.
