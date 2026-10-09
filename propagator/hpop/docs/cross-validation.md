# HPOP cross-validation against Orekit, GMAT, Tudat and Nyx

HPOP is compared with four established, independently written orbit
propagators on identical inputs: Orekit, GMAT, Tudat (native and as
WebAssembly) and Nyx. The comparison also measures how far those
tools differ from each other. That spread is the honest floor for any claim
of agreement. Everything here is reproducible from the repository: the
generators, the reference trajectories, the end-to-end test
(`tests/xval_reference.test.mjs`) and the table script (`tests/xval-summary.mjs`).

## Cases

The cases are a subset of HPOP's Orekit 13.1 lock-down
(`tests/orekit_reference.test.mjs`), listed in `tests/fixtures/xval/xval-cases.json`:

- **Orbits:** five orbits, each with one GCRF initial state at 2026-08-02 00:00:00 UTC:
  - LEO400: 400 km, 51.6 deg.
  - SSO700: 700 km, 98.2 deg.
  - GPS.
  - GEO.
  - MOLNIYA: e = 0.72.
- **Force sets:**
  - F0: point mass.
  - F1: J2.
  - F3: 20x20 field.
  - F4: F3 + Sun and Moon.
  - F5: F4 + radiation pressure.
  - F6: F5 + drag, on LEO400 and SSO700 only.
- **Arc and score:** 24 h, sampled hourly. The score is the largest 3D position
  difference over the 25 samples.

Every tool is given the Orekit file's initial state and constants:

| Input | Value |
| --- | --- |
| GM | 3.986004415e14 m^3/s^2 |
| Field | HPOP's EGM2008 20x20 (`lib/egm2008_data.h`), radius 6378136.3 m, tide-free |
| Sun and Moon | JPL DE440 (`files/orbit-products/tests/fixtures/de440/de440-2026.bsp`); GM from the DE440 header |
| Earth orientation | the IERS finals2000A rows Orekit read (`tests/fixtures/orekit/eop-2026-08.json`) |
| Radiation pressure | 1361 W/m^2 at 1 au; Cr 1.3; 20 m^2; 1000 kg; conical shadow, Earth 6378137 m, Sun 695 700 km |
| Drag | Cd 2.2; NRLMSISE-00 with F10.7 = F10.7a = 150, Ap 15 (Kp 3o) |

## Tools

| Tool | Version | Integrator | Generator | Reference file |
| --- | --- | --- | --- | --- |
| Orekit (CS GROUP, Apache-2.0) | 13.1 | DormandPrince853, 1e-14, steps <= 10 s | `tests/fixtures/orekit/OrekitReference.java` | `orekit-reference.json` |
| GMAT (NASA GSFC, Apache-2.0) | R2022a, GmatConsole built 2023-01-11 | PrinceDormand78, 1e-13, steps <= 60 s | `tests/fixtures/gmat/make-gmat-reference.mjs` | `gmat-reference.json` |
| Tudat (TU Delft, BSD-3), native | tudatpy 1.0.0 (tudat-team conda channel, build py311h2196d89_3; tudat-resources 2.4) | RKDP 8(7), fixed 10 s (1 s with radiation pressure) | `tests/fixtures/tudat/tudat_reference.py` | `tudatpy-reference.json` |
| Tudat, WebAssembly | `repos/ancillary-packages/tudat-wasm` at 1d4718f (Tudat 1.0.0.dev4 sources, Emscripten 3.1.51) | same as native | `tests/fixtures/tudat/tudat-wasm-reference.mjs` + `tudat_wasm_driver.cpp` | `tudat-wasm-reference.json` |
| Nyx Space (MPL-2.0) | nyx-space 2.6.0, ANISE 0.10.6 (`Cargo.lock`), rustc 1.90.0 | RK8(9), 1e-13, steps <= 60 s | `tests/fixtures/nyx/make-nyx-reference.mjs` + `src/main.rs` | `nyx-reference.json` |

Each generator's header gives its exact setup, the data files it writes and why.

Integration error was checked on each tool's side:

- **GMAT:** RungeKutta89 at 1e-14 with 30 s steps, and PrinceDormand78 with 10 s
  steps, each move GEO by less than 0.1 mm.
- **Tudat:** 5 s steps move every gravity case by less than 0.03 mm. With
  radiation pressure, 0.5 s steps move LEO400 by 8 um.
- **Nyx:** 1e-14 with 20 s steps moves every case by less than 0.3 mm.

## What each tool does differently

These differences are part of the measured spread:

- **GMAT**
  - **Earth orientation:** GMAT ties the Earth-fixed frame to its integration
    axes (MJ2000Eq) with the IAU 1976/1980 (FK5) reduction. It does not apply
    the C04 nutation offsets: changing them leaves the output bit-identical,
    while a 1 s change in UT1-UTC moves LEO400 by 2.4 m.
  - **Axes:** its "ICRF" axes are tied to the Earth through IAU 2000A. The
    initial state is therefore given in ICRF axes, which puts it correctly
    against the field. The samples are taken in the integration axes and
    rotated to GCRF by the single fixed rotation GMAT used at the epoch. Its
    own ICRF output would add a drift of 0.13 mas/day (2.7 cm on GEO).
  - **Epochs:** GMAT carries epochs as a double-precision MJD, so a sample
    lands within about 0.15 us of the hour. That is ±1 mm in LEO and up to
    4.5 mm at MOLNIYA perigee.
  - **Drag:** the macOS build of R2022a has no NRLMSISE-00 plugin, so GMAT's
    drag cases use Jacchia-Roberts and HPOP is asked for Jacchia-Roberts on
    them. These cases are not compared with the NRLMSISE-00 tools.
- **Tudat**
  - **Clock:** Tudat's independent variable is TDB, while the other codes
    integrate geocentric motion on TT. In August 2026 the two rates differ by
    2.9e-10, which moves LEO400 by 19 cm over the day (measured). Tudat is
    therefore given TT as its clock. Its ephemeris and Earth-rotation lookups
    then read 0.75 ms off; the ephemerides are tabulated at the true TDB, so
    only the rotation angle is affected, by 11 mas.
  - **Frame:** its "J2000" frame is the frame-biased EME2000, as Orekit's is.
    DE440 is ICRF, so the Sun and Moon are tabulated in GCRS from SPICE and
    the Earth rotation is GCRS-based.
  - **Shadow in drag cases:** with drag, the Earth must be the WGS84
    ellipsoid for altitude. Tudat's occultation then uses that ellipsoid's
    mean radius, 6371.0 km, instead of 6378.137 km.
  - **Resources:** the installed EOP file ends in 2024. The generator writes
    the arc's rows into Tudat's own C04 file and constant space weather into
    a CelesTrak-format file, in a private resource tree.
- **Tudat WebAssembly**
  - **The package's API could not run a propagation.** Its Embind module
    (the prebuilt `docs/tudatpy_wasm.wasm`, and a fresh build) aborts at load
    on duplicate type registrations. Past those, static initialization
    throws on the station file `glo.vel`. Past that, the vector, map and
    Eigen bindings (`stl_wasm.cpp`, `eigen_wasm.cpp`) are not compiled into
    the target, so a propagation cannot be set up from JavaScript.
  - **What runs instead:** the package's own WebAssembly build of the Tudat
    library, linked with the package's link options, runs
    `tudat_wasm_driver.cpp` under Node. That program is
    `tudat_reference.py` line for line in C++.
  - **SPK files:** its SPICE reads text kernels only, so DE440 is read
    through the package's CALCEPH wrapper. That wrapper forms one double
    Julian date (about 40 us resolution), which is sub-millimeter here.
  - **NRLMSISE-00 defaults:** the C++ settings function defaults to storm
    conditions (3-hourly Ap history), while tudatpy defaults to the daily
    Ap. Left at the C++ default, LEO400 drag ended 956 m from native Tudat.
    The driver passes tudatpy's values explicitly.
- **Nyx**
  - **Earth orientation:** the field is evaluated in ITRF93 from NAIF's
    `earth_latest_high_prec.bpc` (SHA-256 in `nyx-reference.json`). ANISE
    takes the Earth's orientation from that file rather than from EOP rows.
    Its pole is 4.8 to 6.5 mas from the IERS 2010 pole computed with the
    Orekit file's rows (measured against Tudat's rotation model over the
    day). That offset is consistent with Nyx's differences on the J2 case:
    3 cm in LEO and 10 cm on MOLNIYA, the same as on the 20x20 cases. For
    scale, a 2 mas pole change moves Tudat's MOLNIYA J2 case by 7 cm.
  - **Shadow:** the Sun's radius comes from pck08 (696 000 km).
  - **Drag:** Nyx's NRLMSISE-00 uses mean local solar time and the daily
    Ap, the same convention as the others. Its altitude is taken on the
    WGS84 ellipsoid in ITRF93. On LEO400 it ends 12.1 m from Orekit after a
    day, which is 2.8e-4 of the 44 km drag effect; SSO700 agrees to 2 cm.
    The cause of the LEO400 gap was not isolated in this pass.

## Results

Largest 3D position difference over 24 h, at hourly samples, measured on
2026-10-09 with the shipped HPOP WASM (sha256 473d5271...bdabd1) through
the SDK's browser harness (`node tests/xval-summary.mjs`, which also writes
`tests/evidence/xval/summary.json`). (JR) marks GMAT's Jacchia-Roberts drag
cases, where HPOP was also run with Jacchia-Roberts.

### HPOP against each tool

| Case | HPOP - Orekit 13.1 | HPOP - GMAT R2022a | HPOP - Tudat (tudatpy 1.0.0) | HPOP - Tudat WASM | HPOP - Nyx 2.6.0 |
|---|---:|---:|---:|---:|---:|
| LEO400 F0-point-mass | 0.20 mm | 1.17 mm | 0.05 mm | 0.04 mm | 0.02 mm |
| LEO400 F1-J2 | 9.11 mm | 8.39 mm | 9.03 mm | 9.03 mm | 26.2 mm |
| LEO400 F3-field20x20 | 9.10 mm | 16.1 mm | 10.8 mm | 10.8 mm | 26.4 mm |
| LEO400 F4-field-sun-moon | 9.15 mm | 8.43 mm | 10.9 mm | 10.9 mm | 26.4 mm |
| LEO400 F5-field-sun-moon-srp | 9.75 mm | 19.3 mm | 10.7 mm | 10.7 mm | 26.7 mm |
| LEO400 F6-field-sun-moon-srp-drag | 12.6 mm | 30008 m (JR) | 26.8 mm | 26.8 mm | 12.09 m |
| SSO700 F0-point-mass | 0.22 mm | 0.86 mm | 0.04 mm | 0.03 mm | 0.09 mm |
| SSO700 F1-J2 | 6.95 mm | 18.6 mm | 6.71 mm | 6.72 mm | 30.8 mm |
| SSO700 F3-field20x20 | 6.80 mm | 12.7 mm | 6.07 mm | 6.09 mm | 31.4 mm |
| SSO700 F4-field-sun-moon | 6.81 mm | 21.6 mm | 6.10 mm | 6.09 mm | 31.4 mm |
| SSO700 F5-field-sun-moon-srp | 6.55 mm | 8.14 mm | 5.97 mm | 5.98 mm | 30.8 mm |
| SSO700 F6-field-sun-moon-srp-drag | 6.78 mm | 451 m (JR) | 60.2 mm | 60.2 mm | 14.7 mm |
| GPS F0-point-mass | 0.16 mm | 0.63 mm | 0.00 mm | 0.00 mm | 0.00 mm |
| GPS F1-J2 | 0.48 mm | 0.74 mm | 0.33 mm | 0.33 mm | 1.61 mm |
| GPS F3-field20x20 | 0.47 mm | 0.28 mm | 0.28 mm | 0.28 mm | 1.61 mm |
| GPS F4-field-sun-moon | 0.43 mm | 3.18 mm | 0.17 mm | 0.17 mm | 1.61 mm |
| GPS F5-field-sun-moon-srp | 0.43 mm | 0.64 mm | 0.17 mm | 0.17 mm | 1.61 mm |
| GEO F0-point-mass | 0.04 mm | 0.09 mm | 0.00 mm | 0.00 mm | 0.00 mm |
| GEO F1-J2 | 0.04 mm | 0.03 mm | 0.03 mm | 0.03 mm | 0.12 mm |
| GEO F3-field20x20 | 0.04 mm | 0.82 mm | 0.05 mm | 0.05 mm | 0.11 mm |
| GEO F4-field-sun-moon | 0.07 mm | 1.35 mm | 0.14 mm | 0.14 mm | 0.12 mm |
| GEO F5-field-sun-moon-srp | 0.06 mm | 1.40 mm | 0.14 mm | 0.14 mm | 0.11 mm |
| MOLNIYA F0-point-mass | 0.57 mm | 4.19 mm | 0.02 mm | 0.02 mm | 0.01 mm |
| MOLNIYA F1-J2 | 5.25 mm | 26.8 mm | 5.51 mm | 5.49 mm | 109.3 mm |
| MOLNIYA F3-field20x20 | 5.14 mm | 11.5 mm | 4.87 mm | 4.88 mm | 108.9 mm |
| MOLNIYA F4-field-sun-moon | 5.22 mm | 19.5 mm | 5.10 mm | 5.10 mm | 108.9 mm |
| MOLNIYA F5-field-sun-moon-srp | 5.81 mm | 24.0 mm | 5.25 mm | 5.23 mm | 109.1 mm |

### Tool against tool (the spread among established codes)

| Case | orekit/gmat | orekit/tudatpy | orekit/tudat-wasm | orekit/nyx | gmat/tudatpy | gmat/tudat-wasm | gmat/nyx | tudatpy/tudat-wasm | tudatpy/nyx | tudat-wasm/nyx | Spread |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| LEO400 F0-point-mass | 1.35 mm | 0.15 mm | 0.16 mm | 0.18 mm | 1.19 mm | 1.19 mm | 1.17 mm | 0.01 mm | 0.03 mm | 0.03 mm | 1.35 mm |
| LEO400 F1-J2 | 1.94 mm | 0.07 mm | 0.08 mm | 30.6 mm | 1.91 mm | 1.91 mm | 28.8 mm | 0.01 mm | 30.5 mm | 30.5 mm | 30.6 mm |
| LEO400 F3-field20x20 | 12.6 mm | 1.71 mm | 1.71 mm | 30.8 mm | 12.4 mm | 12.4 mm | 41.3 mm | 0.01 mm | 31.3 mm | 31.3 mm | 41.3 mm |
| LEO400 F4-field-sun-moon | 7.60 mm | 1.72 mm | 1.73 mm | 30.8 mm | 8.34 mm | 8.34 mm | 26.6 mm | 0.01 mm | 31.3 mm | 31.3 mm | 31.3 mm |
| LEO400 F5-field-sun-moon-srp | 12.4 mm | 1.00 mm | 1.00 mm | 31.2 mm | 11.6 mm | 11.6 mm | 32.9 mm | 0.00 mm | 31.6 mm | 31.6 mm | 32.9 mm |
| LEO400 F6-field-sun-moon-srp-drag | n/a | 38.1 mm | 38.1 mm | 12.10 m | n/a | n/a | n/a | 0.00 mm | 12.06 m | 12.06 m | 12.10 m |
| SSO700 F0-point-mass | 1.04 mm | 0.18 mm | 0.19 mm | 0.12 mm | 0.87 mm | 0.86 mm | 0.92 mm | 0.01 mm | 0.05 mm | 0.06 mm | 1.04 mm |
| SSO700 F1-J2 | 11.6 mm | 0.24 mm | 0.23 mm | 23.8 mm | 11.9 mm | 11.9 mm | 12.8 mm | 0.01 mm | 24.1 mm | 24.1 mm | 24.1 mm |
| SSO700 F3-field20x20 | 6.10 mm | 0.72 mm | 0.71 mm | 24.6 mm | 6.76 mm | 6.75 mm | 23.8 mm | 0.01 mm | 25.3 mm | 25.3 mm | 25.3 mm |
| SSO700 F4-field-sun-moon | 14.8 mm | 0.71 mm | 0.71 mm | 24.6 mm | 15.5 mm | 15.5 mm | 19.5 mm | 0.00 mm | 25.3 mm | 25.3 mm | 25.3 mm |
| SSO700 F5-field-sun-moon-srp | 14.5 mm | 0.58 mm | 0.56 mm | 24.3 mm | 14.0 mm | 14.0 mm | 37.6 mm | 0.01 mm | 24.8 mm | 24.8 mm | 37.6 mm |
| SSO700 F6-field-sun-moon-srp-drag | n/a | 54.4 mm | 54.4 mm | 21.4 mm | n/a | n/a | n/a | 0.01 mm | 67.1 mm | 67.1 mm | 67.1 mm |
| GPS F0-point-mass | 0.63 mm | 0.16 mm | 0.16 mm | 0.15 mm | 0.63 mm | 0.63 mm | 0.63 mm | 0.00 mm | 0.01 mm | 0.01 mm | 0.63 mm |
| GPS F1-J2 | 0.94 mm | 0.15 mm | 0.15 mm | 1.96 mm | 0.80 mm | 0.80 mm | 1.03 mm | 0.00 mm | 1.81 mm | 1.81 mm | 1.96 mm |
| GPS F3-field20x20 | 0.20 mm | 0.20 mm | 0.20 mm | 1.94 mm | 0.08 mm | 0.08 mm | 1.76 mm | 0.00 mm | 1.79 mm | 1.79 mm | 1.94 mm |
| GPS F4-field-sun-moon | 3.54 mm | 0.27 mm | 0.27 mm | 1.90 mm | 3.30 mm | 3.30 mm | 2.65 mm | 0.00 mm | 1.73 mm | 1.73 mm | 3.54 mm |
| GPS F5-field-sun-moon-srp | 0.80 mm | 0.27 mm | 0.27 mm | 1.90 mm | 0.64 mm | 0.64 mm | 1.80 mm | 0.00 mm | 1.73 mm | 1.73 mm | 1.90 mm |
| GEO F0-point-mass | 0.09 mm | 0.04 mm | 0.04 mm | 0.04 mm | 0.09 mm | 0.09 mm | 0.09 mm | 0.00 mm | 0.00 mm | 0.00 mm | 0.09 mm |
| GEO F1-J2 | 0.04 mm | 0.03 mm | 0.04 mm | 0.12 mm | 0.01 mm | 0.01 mm | 0.11 mm | 0.00 mm | 0.11 mm | 0.11 mm | 0.12 mm |
| GEO F3-field20x20 | 0.81 mm | 0.08 mm | 0.08 mm | 0.12 mm | 0.86 mm | 0.86 mm | 0.82 mm | 0.00 mm | 0.11 mm | 0.11 mm | 0.86 mm |
| GEO F4-field-sun-moon | 1.31 mm | 0.12 mm | 0.12 mm | 0.11 mm | 1.31 mm | 1.31 mm | 1.34 mm | 0.00 mm | 0.18 mm | 0.18 mm | 1.34 mm |
| GEO F5-field-sun-moon-srp | 1.36 mm | 0.12 mm | 0.12 mm | 0.12 mm | 1.35 mm | 1.35 mm | 1.38 mm | 0.00 mm | 0.18 mm | 0.18 mm | 1.38 mm |
| MOLNIYA F0-point-mass | 4.48 mm | 0.59 mm | 0.59 mm | 0.56 mm | 4.18 mm | 4.18 mm | 4.19 mm | 0.00 mm | 0.03 mm | 0.03 mm | 4.48 mm |
| MOLNIYA F1-J2 | 21.6 mm | 0.25 mm | 0.24 mm | 104.0 mm | 21.3 mm | 21.4 mm | 82.4 mm | 0.01 mm | 103.8 mm | 103.8 mm | 104.0 mm |
| MOLNIYA F3-field20x20 | 6.40 mm | 0.27 mm | 0.26 mm | 103.8 mm | 6.67 mm | 6.66 mm | 97.4 mm | 0.01 mm | 104.1 mm | 104.1 mm | 104.1 mm |
| MOLNIYA F4-field-sun-moon | 14.3 mm | 0.15 mm | 0.15 mm | 103.6 mm | 14.4 mm | 14.4 mm | 89.4 mm | 0.01 mm | 103.8 mm | 103.8 mm | 103.8 mm |
| MOLNIYA F5-field-sun-moon-srp | 18.2 mm | 0.55 mm | 0.57 mm | 103.3 mm | 18.8 mm | 18.8 mm | 85.1 mm | 0.02 mm | 103.9 mm | 103.9 mm | 103.9 mm |

## Findings

- **Agreement:** HPOP agrees with every tool to within that tool's own
  distance from the others. Measured over 24 h, GMAT's Jacchia-Roberts drag
  cases aside:
  - Orekit: at most 1.3 cm.
  - GMAT: at most 2.7 cm.
  - Tudat, native and WebAssembly: at most 6.0 cm. Excluding drag, at most
    1.1 cm.
  - Nyx: at most 10.9 cm, consistent with the Earth-orientation difference above.
    With drag on LEO400, 12.1 m, which is Nyx's own gap from all the others.
  HPOP's own integration error at 1e-13 is about 9 mm per day in LEO.
- **Spread among the tools:**
  - **Orekit and Tudat** agree best: at most 1.7 mm with gravity, Sun and
    Moon; 1.0 mm with radiation pressure; 5.4 cm with NRLMSISE-00 drag.
  - **GMAT** is within 2.2 cm of both, mostly from its Earth orientation
    and epoch representation.
  - **Nyx** is within 0.6 mm on point mass. With the field it is within
    10.4 cm, because its pole is set by JPL's BPC. Its LEO400 drag ends
    12.1 m away.
  - **On point mass,** every pair agrees to 4.5 mm or better.
- **Tudat native against Tudat WebAssembly:** at most 0.02 mm in every case,
  drag included, after matching the NRLMSISE-00 storm-conditions default.
  The WebAssembly build reproduces native Tudat.
- **Jacchia-Roberts defect in HPOP:**
  - **The cause:** `lib/jacchia_roberts.h` gives GMAT's density functions
    MJD + 29999.5, but GMAT's modified Julian date is JD - 2430000, which
    is MJD - 29999.5.
  - **The effect:** this moves the semiannual density term to the wrong
    date. On 2026-08-02 it raises the 400 km density 1.67 times (measured on
    the port itself). LEO400 is then 30 km from GMAT after a day (SSO700
    451 m), against a drag effect of 44 km.
  - **Why the earlier check passed:** the port's fixture
    (`tests/fixtures/atmosphere/jacchia-roberts-gmat.json`) was generated
    with the same mapping, so its bit-for-bit check passes.
  - **In the test:** the GMAT drag cases are `todo` until HPOP is fixed.
    HPOP's binary is not changed here.

## Not compared, and why

| Tool | Reason |
| --- | --- |
| STK/HPOP (Ansys AGI), FreeFlyer (a.i. solutions), ODTK | Commercial licences; not installed and not runnable here |
| JPL MONTE, ESA GODOT | Distribution restricted to their agencies and partners |
| Basilisk (CU Boulder AVS) | In `repos/ancillary-packages/basilisk` as source. It is a spacecraft-simulation framework: matching this setup needs a full Basilisk build plus a simulation scenario per case. That was left for a later pass once four independent propagators were in place |
