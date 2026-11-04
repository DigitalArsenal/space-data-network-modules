# flows/angles-only-od

Angles-only orbit determination with no element set on any port: RA/Dec `$TDM` tracks (data-source/satnogs-optical-source)
-> Gooding initial orbit (analysis/optical-astrometry `initial_orbit`, on the first track) -> analysis/estimation
`fit_batch` with propagator/ffm as the dynamics -> one Cartesian `$OCM` that propagator/sdn-ap fit reads.

## Batch and revolution count

The arc is split into nights (gaps over 6 h). Stage 1 fits night 1 from the initial orbit; stage s fits nights 1..s from
stage s-1's estimate. Across the first nightly gap the revolution count is a candidate set (`revolutionOffsets`, default
-1, 0, +1 revolutions relative to stage 1's mean motion): each candidate's seed changes the mean motion by
2 pi k / gap, each is fitted, and a candidate counts only when the fit converges, its reduced chi-square is at most
`chiSquareLimit` and the fitted mean motion still gives k revolutions over the gap. The lowest chi-square wins; none:
`no-converged-revolution-count`. Arcs under 24 h: `arc-too-short:<hours>`. Per-station time bias (the `$GST`
`CLOCK_OFFSET_S`, sigma per station) enters as a consider `TIME_BIAS` measurement parameter.

The estimator-FFM loop is flows/observation-od's node, which reads laser ranges only; the angles entry point it needs
is listed in the record's report.
