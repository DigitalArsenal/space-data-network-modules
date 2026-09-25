# HWM14 (C++ port of the NRL release)

Horizontal Wind Model 2014, release HWM14.123114 (31 Dec 2014), ported from
the NRL FORTRAN to C++. Quiet-time winds (HWMQT), disturbance winds (DWM07,
DWM07B), the geodetic to quasi-dipole conversion with its base vectors
(GD2QD), magnetic local time (MLTCALC), the ap/Kp conversion and splines
(AP2KP, KPSPL3), the high-latitude weighting (LATWGT2) and the vector
spherical harmonic basis (ALFBASIS) are all ported.

- Model authors: D. P. Drob (quiet time) and J. T. Emmert (disturbance
  winds), Space Science Division, Naval Research Laboratory.
- References: Drob, D. P., et al. (2015), An update to the Horizontal Wind
  Model (HWM): The quiet time thermosphere, Earth and Space Science 2, 301-319,
  doi:10.1002/2014EA000089. Drob, D. P., et al. (2008), HWM07, J. Geophys. Res.
  113, doi:10.1029/2008JA013668. Emmert, J. T., et al. (2008), DWM07, J.
  Geophys. Res. 113, doi:10.1029/2008JA013541.

## Provenance

`nrl/` holds the package exactly as NRL published it with the Earth and Space
Science paper (supporting information 2,
`HWM14_ess224-sup-0002-supinfo.tgz`, 216,852 bytes, sha256
`4de451beeadef7b3ec3aa5b91129ea98866b9e7156cecf4be1343c33a6f57978`).

- Original location:
  `https://map.nrl.navy.mil/map/pub/nrl/HWM/HWM14/HWM14_ess224-sup-0002-supinfo.tgz`.
  The host no longer resolves (checked 2026-09-24), so the archive was taken
  from the Internet Archive capture of that exact URL
  (`http://web.archive.org/web/20250228082455id_/...`). The archived NRL
  directory listing gives the same file name and size (211.8 K).
- All ten files are byte-identical (git blob hashes) to the first commit of
  `github.com/jacobwilliams/HWM14` (cabce830, "add files from" the NRL URL
  above). The three data files are also byte-identical to those in
  `github.com/gemini3d/hwm14` and `github.com/rilma/pyHWM14`.
- `nrl/SHA256SUMS` lists every vendored file. `hwm14_data.cpp` embeds the
  three data files byte for byte and the model refuses to load if their
  SHA-256 differs.

Licence: the NRL package carries no licence text. It was written by NRL
employees as part of their duties (a work of the United States Government,
not subject to copyright in the United States, 17 U.S.C. 105) and was
published as journal supporting information. The same basis covers the
NRLMSISE-00 code vendored in `third_party/nrlmsise00`. The derivative ports
in the mirrors above add their own licences (Apache-2.0, MIT); nothing here is
taken from those ports.

## Verification

`tests/run.sh` runs both checks natively and, when Emscripten is active, as
WebAssembly.

1. `tests/checkhwm14.cpp` transcribes the NRL test driver. Its output is
   byte-identical to `nrl/Check/gfortran.txt` (211 lines covering height,
   latitude, local time, longitude, day, ap, magnetic latitude, MLT and Kp
   profiles), natively and in WebAssembly.
2. `tests/oracle_parity.cpp` compares every public routine against
   `oracle/oracle.f90`, which links the unmodified `nrl/hwm14.f90`: 8,357
   geographic points (all QWM knots, the 250 km transition, poles, longitude
   wrap, every ap grid value, day and UT boundaries, random interior), 5,332
   magnetic points and 1,689 ap values, 144,464 floats in total.
   - Native (clang or GCC, -O0 to -O3): every float is bit-identical.
   - WebAssembly: within 1e-4 m/s (observed 6.1e-5, 104 floats in the last
     bit). Emscripten's musl libm rounds some sin, cos and exp results
     differently from the Apple libm the oracle used; NRL's README quotes
     differences of about 1e-4 m/s between compilers.
3. The oracle evaluates the points forward and again in reverse with the
   routines interleaved; the outputs are byte-identical, so the FORTRAN's
   internal caches (previous inputs, shared latitude basis) never change a
   result and a stateless port can match it.

`oracle/generate.sh` rebuilds the fixtures with gfortran (committed with
GNU Fortran 16.2.0, `-O0 -ffp-contract=off`, arm64 macOS) and checks that the
same build reproduces `Check/gfortran.txt`.

## Port notes

- Precision follows the FORTRAN declarations: real(4) is float, real(8) is
  double, and mixed expressions promote the same way. The DWM module's
  `pi=3.1415926535897932` has no kind suffix, so it is a single-precision
  constant; `dtor` there is not the double-precision value and the port keeps
  that.
- Build without floating-point contraction. The sources set it off with
  pragmas (clang and GCC), but `-ffp-contract=fast` overrides the clang
  pragma and moves ~5% of results by up to 2.4e-4 m/s.
- `sin` and `cos` of the same argument are separate calls in the FORTRAN.
  Optimisers fuse such pairs into `sincos`, which differs in the last bit, so
  the port calls them through non-inlined wrappers.
- The port is stateless and thread-safe; `hwm14::Model` holds only data.
- The FORTRAN knot search never terminates for altitudes below the first
  knot (0 km). The port returns the first span there instead; no FORTRAN
  result is affected.
- As in the release: `stl`, `f107`, `f107a` and `ap[0]` are ignored; the
  disturbance wind uses `ap[1]` (3-hour ap) and is added only when
  `ap[1] >= 0`; the disturbance winds are height-independent above about
  125 km, with a smooth cutoff of width 4 km (the data file's `twidth`).

Do not edit `nrl/`. Consumers: `propagator/atmosphere`, `propagator/hpop`.
