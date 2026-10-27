# Lebedev–Laikov quadrature coefficients

`coefficients.inc` contains published numerical coefficients for the 590,
974, 2030, 3890 and 5810 point Lebedev–Laikov spherical rules (algebraic
degrees 41, 53, 77, 107 and 131). Weights in the table sum to one after
symmetry expansion; the integrator multiplies by 4π to integrate solid angle.

Reference: V. I. Lebedev and D. N. Laikov, “A quadrature formula for the sphere
of the 131st algebraic order of accuracy,” *Doklady Mathematics* 59(3),
477–481 (1999).

The coefficients are extracted reproducibly from NASA CARA's copy of Rob
Parrish's `getLebedevSphere.m`, dated 2010-03-24. Its acknowledgments trace
the numerical tables through Christoph van Wüllen to Dmitri Laikov's original
C routines. This directory contains numerical data, not the MATLAB implementation.

Pinned source:
https://github.com/nasa/CARA_Analysis_Tools/blob/ce0f00722c56808755ee0adbe47a4e3d56439484/DistributedMatlab/ProbabilityOfCollision/Utils/getLebedevSphere.m

Source SHA256: `56c39635f8e6d7f6ddb121710b77a174d21314e9fb2c1ebc00e8794e270be221`.
Run `python3 generate.py` to reproduce the table. Production builds require
no download. The symmetry expansion and convergence policy are implemented
separately in `src/pc_sphere_quadrature.cpp` and `src/pc_fallbacks.cpp`.

Analytical polynomial moments and published CARA collision cases validate the
rules as part of `tests/ncCascade.e2e.mjs`. Polynomial exactness does not imply
exactness for a sharply concentrated Gaussian or the inward-flux kink.
