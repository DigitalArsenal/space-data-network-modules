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
Brodowski package verbatim apart from cosmetic warning fixes (initialized
locals, doxygen comments). Verified against upstream
https://github.com/magnific0/nrlmsise-00 — the coefficient data file is
byte-identical and `nrlmsise-00.c` differs only in those cosmetic edits.

Do not edit these files. Consumers:

- `propagator/atmosphere` (atmosphere SDN module)
- `propagator/hpop` (HPOP drag / atmosphere path)

The canonical verification vectors are the 17-case output table distributed
with the package (DOCUMENTATION file); tests in the consuming modules assert
against those published values.
