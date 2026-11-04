# flows/angles-only-od

Angles-only orbit determination with no element set on any port: RA/Dec `$TDM` tracks -> Gooding initial orbit
(analysis/optical-astrometry `initial_orbit`) -> analysis/estimation `fit_batch` with propagator/ffm as the dynamics ->
one Cartesian `$OCM` that propagator/sdn-ap fit reads.
