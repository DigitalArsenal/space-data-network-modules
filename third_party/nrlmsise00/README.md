# NRLMSISE-00 (C port, public domain)

Vendored copy of the NRLMSISE-00 empirical atmosphere model, C source code
package release 20041227.

- Model authors: J.M. Picone, A.E. Hedin, D.P. Drob (Naval Research Laboratory).
- C port: Dominik Brodowski (https://www.brodo.de/space/nrlmsise/), translation
  of the official NRL FORTRAN release. The C package is in the public domain
  ("The NRLMSISE-00 C source code is in the public domain" — package
  DOCUMENTATION).
- Reference: Picone, J.M., Hedin, A.E., Drob, D.P., Aikin, A.C.,
  "NRLMSISE-00 empirical model of the atmosphere: Statistical comparisons and
  scientific issues", J. Geophys. Res., 107(A12), 1468, 2002,
  doi:10.1029/2002JA009430.

Files `nrlmsise-00.c`, `nrlmsise-00_data.c`, `nrlmsise-00.h` were copied from
the Basilisk astrodynamics framework
(`src/simulation/environment/MsisAtmosphere/`), which redistributes the
Brodowski package with warning fixes (initialized locals, doxygen comments,
`(int)` casts on switch tests). Compared with upstream
https://github.com/magnific0/nrlmsise-00 the coefficient data file is
byte-identical.

One of Basilisk's casts was not cosmetic. Upstream tests the coefficient with
`if (p[51])`; Basilisk wrote `if ((int) p[51])`, which truncates the
fractional coefficient to zero and drops the UT/longitude magnetic-activity
term whenever the 3-hour ap history is used (switch 9 = -1). With that cast
the package's published test cases 16 and 17 fail (case 16 TINF 1405.566 K
instead of 1426.412 K). `nrlmsise-00.c` restores the upstream semantics as
`if (p[51] != 0.0)`; the other casts act on switch values that are exactly
0, 1 or -1 and do not change results. With that line restored, all 17
published cases reproduce to the printed seven significant digits.

Do not edit these files except to restore upstream behavior. Consumers:

- `propagator/atmosphere` (atmosphere SDN module)
- `propagator/hpop` (HPOP drag / atmosphere path)

The canonical verification vectors are the 17-case output table distributed
with the package (DOCUMENTATION file); tests in the consuming modules assert
against those published values.
