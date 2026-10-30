# foundation/sgp4-str3

SGP4/SDP4 after Spacetrack Report No. 3 (Hoots & Roehrich 1980), with the corrections that Vallado, Crawford, Hujsak &
Kelso (2006), AIAA 2006-6753 Rev 3, document in their text. Written clean room: from the report's equations and FORTRAN
listing (a US Government work, approved for public release), the paper's text, and black-box comparison against a
reference propagator; no other implementation was read. Apache-2.0 (the repository's `LICENSE`).

The repository's one SGP4. It is compiled by:

| consumer | how | mode |
| --- | --- | --- |
| `propagator/sdn-ap` | `build.mjs` inlines `src/sgp4_core.inc` and `src/model.inc` after the module's `constants.inc` | AFSPC |
| `analysis/conjunction-assessment` | `#include "sgp4_str3.h"` (`include/`; `build.mjs` composes it into the module's unit) | AFSPC |
| `propagator/sgp4` | `#include "sgp4_str3.h"` (`include/`, through `src/cpp/src/sgp4_base.hpp`) | AFSPC |
| `analysis/od` (and `analysis/od/fit-pipeline`) | `#include "sgp4_str3.h"` (`include/`) | improved |

## Parts

- `src/sgp4_core.inc`: the report's subroutine DEEP (DPINIT, DPSEC, DPPER as `deep_init`, `deep_secular`,
  `deep_periodics`), Greenwich at epoch (AFSPC: the 1970-referenced series; improved: IAU 1982 GMST), `split_jd`.
- `src/model.inc`: the SGP4 and SDP4 models as one: `Elements`, `sat_init` (the initialization section), `sat_propagate`
  (TEME km and km/s, a `kProp*` status), `fill_checkpoints` (resonance integrator checkpoints, 720-minute nodes for 32
  days each way; the same bits without them).
- `include/sgp4_str3.h`: the header for C++ users other than SDN-AP: pi, 2 pi, 2/3, the 1950 epoch and the WGS-72
  zonal model the parts read, then the parts (namespace `sdnap`).

Each departure from the 1980 listing names its source in the code: the paper's sections for the documented corrections,
and the black-box findings for what the sources leave open (a''o by Kepler's law from n''o; the G520 coefficient
-5740.032; the Earth rate 4.37526908801129966e-3 rad/min).

## Verification

- Against the reference, run only as a black box (element sets in, states out), on the 33 sets of the paper's Appendix
  D and the report's two cases, both modes: every error trap at the same samples; non-resonant sets within 1.2e-6 m,
  resonant ones within 2.3e-6 m once the epoch is rounded as the reference rounds it (one double Julian date).
- Near 180 degrees: AIAA 2006-6753 VI.A drops the solar SH term within 3 degrees of 180 as well as below 3 degrees; the
  improved mode does, the AFSPC mode keeps it there, as the reference does: from 177 to 179.9999 degrees the AFSPC mode
  reproduces the reference within 1e-6 m (dropping it put the module 1.6 to 356 km off). At exactly 0 and 180 degrees
  the theory's divisors vanish (XLCOF's 1 + cos i, the node terms' sin i); the reference returns the origin for a
  near-Earth set at 180 degrees, and both answers for a deep-space set there are rounding noise (up to 58 km apart).
- The small-eccentricity rule at its boundary: C3 and the delta-M term are dropped for e <= 1e-4, as the reference
  drops them (STR#3 computes them for every e; AIAA 2006-6753 drops them below 1e-4 and is silent at equality).
  `tests/ecc-boundary.e2e.mjs` holds the base to the reference's recorded states at e = 0.00009, 0.0001 and 0.00011
  (within 1 µm; measured 9.3e-8 m).
- `propagator/sdn-ap`: against the US Space Force Sgp4Prop 9.9 library (`test/conformance.e2e.mjs`, type-0 control),
  median 2.1e-7 m and max 9.1e-5 m over 7 days; the module's bytes are the same built from here.
- `analysis/od`: its fits on 21 operator ephemerides match the previous build within 0.14 m over the fit day.
