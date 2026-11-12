# Changes

## Zonal long-period terms (stack #595)

AP carries the zonal tail's long-period terms with 2 <= |w| <= 6 at epoch eccentricity at or below 0.3.
Their Hansen coefficients use the finite closed form, including exact zeros, and a value-and-slope match
re-anchored beyond an eccentricity change of 0.002. The output map and the wide-eccentricity terms retain
their definitions. Shared tables are immutable and the evaluation cache is thread-local.

The two degree-70 order-0 model-truth tests bound the once-per-revolution in-track amplitude by 10 m
on days 1 and 5 and the maximum 3D error by 20 m. Separate checks cover the coefficient table,
re-anchoring, and the e 0.3 switch against a full-harmonic control.
