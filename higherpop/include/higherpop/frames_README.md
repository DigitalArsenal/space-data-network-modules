# hp::frames — IAU-2006/2000A Earth-orientation frame chain

`frames.hpp` provides the high-precision inertial↔terrestrial transformation
that STK's HPOP and FreeFlyer use for precision ephemerides: **GCRF ↔ ITRF**
via the CIO-based IAU-2006 precession + IAU-2000A nutation of the IERS 2010
Conventions.

## Why it matters

The rest of the stack's `foundation/frames` module implements geodetic
(ECEF↔lat/lon/height) conversion and polar motion, but **not** the full
precession–nutation–bias chain. Without it, an inertial state propagated with
high-fidelity gravity is rotated into the Earth-fixed frame with metre-to-
tens-of-metres error — which silently caps the accuracy of orbit determination,
conjunction screening, and access/visibility. `hp::frames` closes that gap.

## Accuracy

The transformation is delegated to the **vendored ERFA library** (BSD-3,
derived with permission from IAU SOFA — `third_party/erfa/`), so results match
SOFA to sub-microarcsecond. Validated in `test/frames/frames_validate.cpp`
against pyerfa-generated reference matrices at four epochs (2004–2023):

| Check | Result |
|---|---|
| GCRF→ITRF matrix vs ERFA | **0 (bit-exact)** at all epochs |
| Earth-rotation angle vs ERFA | 0 |
| Rotation determinant | 1.0 |
| Position/velocity round-trip | 9×10⁻¹⁰ m |
| Vallado Ex. 3-15 ITRF position | agrees to ~7 mm (per-component) |

## What it provides

- `EOP{dut1, xp, yp, dX, dY, lod}` — Earth-orientation parameters (from IERS
  Bulletin A/B). Polar motion and pole offsets in arcsec, dUT1/lod in seconds.
- `UTCDate` → `timescales()` — UTC calendar epoch to the TT and UT1 two-part
  Julian dates the chain needs (handles leap seconds via ERFA `dat`).
- `gcrf_to_itrf_matrix()` — the 3×3 CIO-based rotation.
- `gcrfToItrf` / `itrfToGcrf` — position (`Vec3`) and full state (`StatePV`,
  position **and** velocity, accounting for Earth's rotation ω and lod).
- `itrfToGeodetic` / `geodeticToItrf` — WGS84 Cartesian ↔ lat/lon/height.

## Usage

```cpp
#include "higherpop/frames.hpp"
using namespace hp; using namespace hp::frames;

UTCDate epoch{2004,4,6, 7,51,28.386009};
EOP eop; eop.dut1=-0.4399619; eop.xp_arcsec=-0.140682; eop.yp_arcsec=0.333309;

StatePV gcrf{ Vec3{5102.508958,6123.011401,6378.136928},
              Vec3{-4.74322016,0.79053650,5.53375528} };   // km, km/s
StatePV itrf = gcrfToItrf(gcrf, epoch, eop);
Geodetic g   = itrfToGeodetic(itrf.r);
```

## Build

`frames.hpp` is the **only** higherpop header with a third-party dependency, so
the dependency-free core is unaffected (the umbrella `higherpop.hpp` does not
include it). Compile the vendored ERFA C sources once and link:

```
clang++ -std=c++17 -O2 -Iinclude -Ithird_party/erfa \
    test/frames/frames_validate.cpp third_party/erfa/*.o -o frames_validate
```

or via CMake: the `hp_frames` target builds `higherpop_erfa` (static) and links
it. `erfaversion.c` is excluded (it needs build-time version `-D` defines and is
unused here).

## Attribution

`third_party/erfa/` is the ERFA library, Copyright © NumFOCUS Foundation,
BSD-3-Clause, derived with permission from IAU SOFA (http://www.iausofa.org).
See `third_party/erfa/LICENSE.txt`.
