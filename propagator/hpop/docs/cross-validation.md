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
    them. These cases are not compared with the NRLMSISE-00 tools. GMAT's
    Earth is given WGS84's flattening on them, the ellipsoid Orekit and HPOP
    take heights on (GMAT's default 0.0033527 moves LEO400 13 cm).
  - **Jacchia-Roberts axes:** GMAT gives the model the spacecraft and the Sun
    in its MJ2000Eq axes, so the Sun's hour angle and declination are on the
    J2000 equator; HPOP uses Earth-fixed axes, the true equator of date. By
    2026 the two poles are 0.15 deg apart. That leaves LEO400 1.38 m and
    SSO700 0.17 m from GMAT after a day; HPOP built with GMAT's axes is 2.4 cm
    and 1.0 cm from it (measured). GMAT's drag limit is therefore 1.5 m.
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
2026-10-11 with HPOP WASM 9c24bf0e...a8a99e3 (propagator/hpop 1.3.0) through
the SDK's browser harness (`node tests/xval-summary.mjs`, which also writes
`tests/evidence/xval/summary.json`), at the Orekit suite's request: RK78 at
1e-13 and steps of at most 300 s. HPOP's own integration error at those steps
is most of its difference from Orekit and Tudat in LEO (README.md, Agreement
with Orekit 13.1). (JR) marks GMAT's Jacchia-Roberts drag cases, where HPOP
was also run with Jacchia-Roberts.

### HPOP against each tool

| Case | HPOP - Orekit 13.1 | HPOP - GMAT R2022a | HPOP - Tudat (tudatpy 1.0.0) | HPOP - Tudat WASM | HPOP - Nyx 2.6.0 |
|---|---:|---:|---:|---:|---:|
| LEO400 F0-point-mass | 0.48 mm | 1.17 mm | 0.32 mm | 0.32 mm | 0.30 mm |
| LEO400 F1-J2 | 18.1 mm | 17.2 mm | 18.0 mm | 18.0 mm | 27.2 mm |
| LEO400 F3-field20x20 | 18.1 mm | 19.9 mm | 19.8 mm | 19.8 mm | 27.5 mm |
| LEO400 F4-field-sun-moon | 18.2 mm | 14.3 mm | 19.9 mm | 19.9 mm | 27.5 mm |
| LEO400 F5-field-sun-moon-srp | 18.7 mm | 24.2 mm | 19.7 mm | 19.7 mm | 27.8 mm |
| LEO400 F6-field-sun-moon-srp-drag | 21.7 mm | 1.38 m (JR) | 33.5 mm | 33.5 mm | 12.08 m |
| SSO700 F0-point-mass | 0.48 mm | 0.85 mm | 0.30 mm | 0.30 mm | 0.36 mm |
| SSO700 F1-J2 | 14.5 mm | 26.1 mm | 14.3 mm | 14.3 mm | 38.3 mm |
| SSO700 F3-field20x20 | 14.5 mm | 19.5 mm | 13.8 mm | 13.8 mm | 39.0 mm |
| SSO700 F4-field-sun-moon | 14.6 mm | 29.4 mm | 13.9 mm | 13.9 mm | 39.2 mm |
| SSO700 F5-field-sun-moon-srp | 14.0 mm | 6.27 mm | 13.4 mm | 13.5 mm | 38.3 mm |
| SSO700 F6-field-sun-moon-srp-drag | 14.2 mm | 166.6 mm (JR) | 65.3 mm | 65.3 mm | 13.5 mm |
| GPS F0-point-mass | 0.14 mm | 0.63 mm | 0.02 mm | 0.02 mm | 0.01 mm |
| GPS F1-J2 | 0.20 mm | 0.74 mm | 0.06 mm | 0.06 mm | 1.78 mm |
| GPS F3-field20x20 | 0.19 mm | 0.01 mm | 0.08 mm | 0.08 mm | 1.76 mm |
| GPS F4-field-sun-moon | 0.15 mm | 3.42 mm | 0.14 mm | 0.15 mm | 1.76 mm |
| GPS F5-field-sun-moon-srp | 0.15 mm | 0.67 mm | 0.14 mm | 0.14 mm | 1.76 mm |
| GEO F0-point-mass | 0.04 mm | 0.09 mm | 0.00 mm | 0.00 mm | 0.00 mm |
| GEO F1-J2 | 0.04 mm | 0.00 mm | 0.01 mm | 0.01 mm | 0.11 mm |
| GEO F3-field20x20 | 0.04 mm | 0.82 mm | 0.05 mm | 0.05 mm | 0.11 mm |
| GEO F4-field-sun-moon | 0.07 mm | 1.35 mm | 0.14 mm | 0.14 mm | 0.11 mm |
| GEO F5-field-sun-moon-srp | 0.06 mm | 1.39 mm | 0.14 mm | 0.14 mm | 0.11 mm |
| MOLNIYA F0-point-mass | 0.58 mm | 4.18 mm | 0.01 mm | 0.01 mm | 0.02 mm |
| MOLNIYA F1-J2 | 11.0 mm | 10.6 mm | 10.8 mm | 10.8 mm | 93.0 mm |
| MOLNIYA F3-field20x20 | 11.0 mm | 4.56 mm | 11.2 mm | 11.2 mm | 92.8 mm |
| MOLNIYA F4-field-sun-moon | 11.0 mm | 3.23 mm | 11.2 mm | 11.2 mm | 92.6 mm |
| MOLNIYA F5-field-sun-moon-srp | 10.5 mm | 7.68 mm | 11.1 mm | 11.1 mm | 92.8 mm |

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
  distance from the others, plus its own integration error. Measured over 24 h
  at the suite's request, GMAT's Jacchia-Roberts drag cases aside:
  - Orekit: at most 2.2 cm.
  - GMAT: at most 2.9 cm.
  - Tudat, native and WebAssembly: at most 6.5 cm. Excluding drag, at most
    2.0 cm.
  - Nyx: at most 9.3 cm, consistent with the Earth-orientation difference above.
    With drag on LEO400, 12.1 m, which is Nyx's own gap from all the others.
  HPOP's own integration error at 1e-13 and steps of at most 300 s is 1.8 cm
  per day in LEO 400 km and 1.6 cm at 700 km; with steps of 30 s HPOP is
  within 4.2 mm of Orekit outside Molniya, and a tolerance of 1e-15 with steps
  of 10 s moves that by under 0.2 mm (README.md, Agreement with Orekit 13.1).
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
- **Jacchia-Roberts date, fixed:** HPOP gave GMAT's density functions
  MJD + 29999.5 where GMAT's modified Julian date (JD - 2430000) is
  MJD - 29999.5, moving the semiannual term (1.67 times the 400 km density
  on 2026-08-02; LEO400 30 km and SSO700 451 m from GMAT after a day). The
  port's fixture had been made with the same mapping. It is now GMAT's own
  density from GmatConsole at 2000 epochs and points
  (`tests/fixtures/atmosphere/make-jacchia-roberts-gmat.mjs`); the port agrees
  to 1.8e-6 (it was up to 124 % off), and the GMAT drag cases are 1.38 m and
  0.17 m from GMAT, the axes difference above.

## GMAT R2026a on the 72 reference cases

GMAT runs every case of `tests/evidence/cases/hpop-reference-cases.json` whose
forces it models (57 of 72), from the case export's initial states, constants,
EOP rows, space weather, DE440 kernel and HPOP's embedded coefficients. HPOP
runs at the three integrator settings of the Orekit table. Runner, scorer and
evidence: `tests/evidence/gmat/` (`run-gmat.mjs`, `score-gmat.mjs`,
`anomalous-oxygen.mjs`, `variants.mjs`).

**Tool.** GMAT R2026a, `gmat-mac-x64-R2026a-signed.dmg` from SourceForge (SHA-1
`5dcbf29f34a7dbdf2633974d05ee32cf0b9b8ce9` and MD5
`94763b2599e4e71c4ceb917464433855` as published; SHA-256
`8a81d22ce2d39504eadc875d71494321adb49f60da92d266fdbe660de0f771d2`), copied
to user space. GmatConsole built 2026-03-26 (universal binary, run natively on
arm64), SHA-256 `1162803de3ed7172bce882b201b00e58de5b604c76a2ba02d16ac6765e7552e2`;
`libGmatBase.R2026a.dylib` `e55086ed22bac9529298482ddc6dfbb703cb457d06d7883ff3d2f65df8ddab26`.
R2022a (GmatConsole built 2023-01-11, x86_64 under Rosetta, SHA-256
`c8a214cf761d7d074c20bee17586a16ac9c9dca9475018e8a0866116377ab655`) is the second row.

**Settings that match HPOP** (each also in `run-gmat.mjs`'s header and in the
trajectory file):

| Item | GMAT setting |
| --- | --- |
| Integrator | RungeKutta89, accuracy 1e-14, steps <= 30 s, RSSStep. Cases without radiation pressure move under 0.06 mm against PrinceDormand78 at 1e-13 with steps <= 10 s |
| Gravity | `.cof` written from `lib/egm2008_data.h` / `lib/egm96_data.h`; degree and order per case; G2's terms of order >= 1 above degree 24 written as zero |
| Earth | GM 398600.4415 km^3/s^2; radius 6378.137 km and WGS84 flattening (shadow, geodetic height); nutation at every call |
| Earth orientation | FK5 (IAU 1976/1980) with the case export's pole and UT1-UTC rows in GMAT's C04 file. The state is given in GMAT's ICRF axes, which it ties to the Earth-fixed frame by IAU 2006/2000A, and the samples are rotated out of its integration axes by the epoch's fixed rotation; EME2000 cases through the IERS 2003 frame bias |
| Sun, Moon | SPICE, the case export's DE440 kernel at TDB; DE440 header GMs; Sun radius 695 700 km |
| Radiation pressure | Spherical, 1361 W/m^2 at 1 au, conical shadow |
| Drag | NRLMSISE-00 (R2026a; R2022a has none, so Jacchia-Roberts with HPOP asked for the same); constant F10.7 = F10.7a = 150, Kp 3 (GMAT's table gives Ap 15) |
| W1 space weather | the drivers HPOP reads from the CSSI rows on the arc's day, as constants: F10.7 139.8 (observed, previous day), F10.7a 136, Kp 5/3 (Ap 6) |
| Solid tides (T1) | `SolidAndPole` (IERS steps 1 and 2 with solid and ocean pole tides) with GMAT's own pole-tide increments (C21 -2.2608e-10, S21 -1.4519e-10 at mid-arc) subtracted from the `.cof`, leaving steps 1 and 2 without pole tide, as HPOP's T1 |
| Relativity (R2) | `RelativisticCorrection = On` (Schwarzschild, Lense-Thirring, de Sitter) |
| In-track thrust (I1) | a thruster on LVLH axes (y along-track, the S axis of QSW), C1 = a * m, no mass decrement |

Not run (no GMAT model): R1 (Schwarzschild alone), B1 (Cd*A/m rate), J1
(JB2008), A1 (Knocke), O1 and O2 (ocean tides), and C1 LEO400 and both C2
cases, which combine them. GPS C1 (radiation pressure and in-track thrust) is
run.

**Results.** HPOP 1.3.1, module SHA-256
`8c9c361bddfda89f5dbb63b0d17c61324ae7351feff550ff554bbea429d9b1a0`; the largest
3D difference over 24 h, hourly samples (`tests/evidence/gmat/summary-gmat-R2026a.json`):

| Force set | Cases | Steps of at most 300 s (the suite's request) | Steps of at most 30 s | Tolerance 1e-15, steps of at most 10 s | Orekit 13.1 - GMAT |
| --- | ---: | ---: | ---: | ---: | ---: |
| Point mass | 5 | 0.32 mm | 0.07 mm | 0.01 mm | 0.58 mm |
| Field, third bodies, radiation pressure, tides, relativity, thrust | 46 | 4.5 cm | 3.1 cm | 3.0 cm | 3.0 cm |
| With drag | 6 | 7.97 m | 7.95 m | 7.95 m | 7.95 m |
| With drag, GMAT's Cd x (1 + anomalous-oxygen share) | 6 | | 12 cm | | |

| Orbit | Row | 300 s | 30 s | 10 s, 1e-15 | Orekit - GMAT |
| --- | --- | ---: | ---: | ---: | ---: |
| LEO 400 km | Point mass | 0.32 mm | 0.07 mm | 0.01 mm | 0.16 mm |
| LEO 400 km | No drag | 4.5 cm | 3.1 cm | 3.0 cm | 3.0 cm |
| LEO 400 km | With drag | 2.34 m | 2.32 m | 2.32 m | 2.32 m |
| SSO 700 km | Point mass | 0.29 mm | 0.04 mm | 0.01 mm | 0.19 mm |
| SSO 700 km | No drag | 1.9 cm | 1.1 cm | 1.1 cm | 1.1 cm |
| SSO 700 km | With drag | 7.97 m | 7.95 m | 7.95 m | 7.95 m |
| GPS | Point mass | 0.02 mm | 0.00 mm | 0.01 mm | 0.16 mm |
| GPS | No drag | 1.52 mm | 1.50 mm | 1.50 mm | 1.66 mm |
| GEO | Point mass | 0.00 mm | 0.00 mm | 0.00 mm | 0.04 mm |
| GEO | No drag | 0.15 mm | 0.15 mm | 0.15 mm | 0.12 mm |
| Molniya | Point mass | 0.01 mm | 0.02 mm | 0.01 mm | 0.58 mm |
| Molniya | No drag | 5.12 mm | 4.99 mm | 4.95 mm | 1.2 cm |

| Force family | 300 s | 30 s | 10 s, 1e-15 | Orekit - GMAT |
| --- | ---: | ---: | ---: | ---: |
| Geopotential, EGM2008 (F1 F2 F3) | 1.8 cm | 1.69 mm | 1.71 mm | 1.2 cm |
| Geopotential, EGM96 and 36Z,24T (G1 G2) | 1.8 cm | 0.77 mm | 0.71 mm | 0.98 mm |
| Sun and Moon (F4 Z1) | 1.8 cm | 1.93 mm | 1.96 mm | 1.2 cm |
| Radiation pressure (F5 Z2) | 3.5 cm | 2.2 cm | 2.2 cm | 2.2 cm |
| EME2000 (E1) | 1.8 cm | 0.76 mm | 0.68 mm | 0.98 mm |
| Solid tides (T1) | 4.5 cm | 3.1 cm | 3.0 cm | 3.0 cm |
| Relativity (R2) | 2.3 cm | 5.45 mm | 5.38 mm | 5.23 mm |
| In-track thrust (I1) | 1.8 cm | 0.77 mm | 0.71 mm | 0.98 mm |
| Drag (F6 Z3 W1) | 7.97 m | 7.95 m | 7.95 m | 7.95 m |

The per-case table, with limits, is in the summary file. At the suite's
request the LEO rows are mostly HPOP's own integration error (Agreement with
Orekit 13.1, README.md).

**State-transition matrix** (GMAT's `OrbitSTM`, 6x6, against HPOP's analytic
STM at the suite's request; largest relative column difference, position and
velocity rows apart, all 57 cases): point mass 8.5e-12; field, Sun and Moon
4.6e-10 (LEO) and 2.0e-9 (Molniya); in-track thrust 6.1e-7; relativity
1.0e-5 (LEO); radiation pressure on eclipsing orbits 2.6e-5, drag cases 2.1e-5.
The last three are terms GMAT leaves out of its variational equations:
`RelativisticCorrection` and `FiniteThrust` add no partials, and
`SolarRadiationPressure` differentiates the Sun-direction term without the
shadow function. GMAT has no Cd or Cr columns in `OrbitSTM`. The STM file
(1.2 MB) stays out of git; its SHA-256 is in the summary.

**Tolerances** (the case export's GMAT limits: point mass 1 cm, gravity 5 cm,
radiation pressure 10 cm, drag 1.5 m): all 51 cases without drag are within
them at all three settings (largest 4.5 cm, LEO400 T1 at 300 s). The six
NRLMSISE-00 cases are not (LEO400 2.3 m, W1 1.53 m; SSO700 7.9 m, W1 6.3 m).

**Cause of the drag gap: anomalous oxygen** (`tests/evidence/gmat/anomalous-oxygen.json`).
GMAT's NRLMSISE-00 plugin takes the total mass density of `gtd7`, which
leaves anomalous oxygen out (`NRLMsise00Atmosphere::Density`); HPOP, like
Orekit, takes `gtd7d`'s, which includes it (Picone et al. 2002 give `gtd7d`
for drag). Along GMAT's trajectory, every 60 s, HPOP's diagnostic gives both
densities; the mean share and its effect:

| Case | Anomalous-oxygen share of the mean density | Drag effect over the day | HPOP - GMAT | HPOP - GMAT, GMAT with Cd x (1 + share) |
| --- | ---: | ---: | ---: | ---: |
| LEO400 F6 | 0.0052 % | 43.8 km | 2.32 m | 2.7 cm |
| LEO400 Z3 | 0.0052 % | 43.8 km | 2.31 m | 3.3 cm |
| LEO400 W1 | 0.0047 % | 32.7 km | 1.53 m | 1.7 cm |
| SSO700 F6 | 1.9635 % | 413 m | 7.93 m | 11 cm |
| SSO700 Z3 | 1.9633 % | 413 m | 7.95 m | 12 cm |
| SSO700 W1 | 2.5279 % | 256 m | 6.30 m | 12 cm |

Share times drag effect predicts the gap (2.30 m, 8.11 m, 1.55 m, 6.47 m), and
scaling GMAT's Cd by the mean share closes it to the share's variation along
the orbit. GMAT's drag is otherwise HPOP's: mean local solar time, geodetic
heights on WGS84, the same constant drivers. No HPOP defect.

**What the other settings are worth** (`tests/evidence/gmat/variants.json`,
HPOP with steps <= 30 s):

| GMAT setting | Case | HPOP - GMAT | Orekit - GMAT |
| --- | --- | ---: | ---: |
| PrinceDormand78, 1e-13, steps <= 60 s (the 2026-10-09 runner) | point mass LEO400 / Molniya | 3.0 mm / 1.4 cm | 2.9 mm / 1.3 cm |
| Tide `Solid` (step 1 only) | T1 LEO400 / GPS | 2.12 m / 8.9 cm | 2.12 m / 8.9 cm |
| Tide `SolidAndPole` (steps 1 and 2, pole tides) | T1 LEO400 / GPS | 61 cm / 1.05 cm | 61 cm / 1.05 cm |
| CSSI file read by GMAT, as published | W1 LEO400 / SSO700 | 210 m / 9.25 m | 210 m / 9.26 m |
| CSSI file read by GMAT, all rows observed | W1 LEO400 / SSO700 | 105 m / 8.07 m | 105 m / 8.07 m |
| RungeKutta89, steps <= 5 / 2 / 1 s | radiation pressure, LEO400 | 2.3 / 1.4 / 1.6 cm | 2.4 / 1.3 / 1.7 cm |

- Step 2 of IERS 2010 section 6.2 (the frequency dependence of k2, notably
  the K1 band) is 2.1 m in LEO400 over the day.
- GMAT reads CSSI rows by its own conventions (`SolarFluxReader`): F10.7
  taken as measured at 20 h UT and interpolated in time, and for
  daily-predicted rows the current day's record looked up one day early.
  HPOP and Orekit take each day's values as published (F10.7 of the previous
  day, centred average and daily Ap of the day).
- GMAT's radiation-pressure trajectories in LEO and Molniya move by 1-2 cm
  with its step size while its other cases move under 0.06 mm; HPOP and
  Orekit agree to 9.3 mm on them. The 30 s setting is the one used.

**R2022a** (`summary-gmat-R2022a.json`, 55 cases: W1 is not run with
Jacchia-Roberts, whose drivers HPOP reads three-hourly): point mass 0.07 mm,
no drag 3.1 cm at 30 s (Sun and Moon 1.5 cm: R2022a reads SPICE ephemerides
as J2000, which R2026a corrects, GMT-5211), Jacchia-Roberts drag 1.36 m LEO400
and 18 cm SSO700, within 1.5 m.

## ERFA and SPICE: clock, Earth orientation, TEME axes, Sun and Moon

The frame, time and ephemeris inputs of the reference cases are checked on
their own, at the 50 hourly sample epochs of
`tests/evidence/cases/hpop-reference-cases.json` (25 on 2026-08-02 with the
`eop-2026-08` rows, 25 on 2026-06-10 with `eop-2026-06`). Runner and
evidence: `tests/evidence/erfa-spice/` (`run-erfa-spice.mjs`,
`hpop_frames_native.cpp`, `reference.py`, `hpop-frames.json`,
`reference.json`, `summary-erfa-spice.json`, `tools.json`).

**Method.** HPOP's side: its UTC to TT conversion and TDB - TT
(`prw_codec.h`), the single-double TDB Julian date its force model receives,
`EarthRotation::matrix` (GCRF to ITRF from the case's EOP rows), the tides'
GMST, the no-EOP fallback rotation and the `lib/coords` IAU 1976/1980 pieces,
compiled natively from the module's sources with the vendored ERFA; the Sun
and Moon from the shipped WASM's ephemeris operation at that TDB date. The
references evaluate every quantity with two-part Julian dates from the same
UTC epochs and EOP rows (linear in TAI between daily rows, the rows'
interpolation rule). Rotations are compared as the angle of A B^T, split into
the pole and the spin about it; at the radius of LEO 400 km (6778 km)
1 mas is 3.3 cm.

**Tools.** pyerfa 2.0.1.5 (ERFA 2.0.1, SOFA 2023-10-11), wheel SHA-256
`be1aeb70390dd03a34faf96749d5cabc58437410b4aab7213c512323932427df`; SpiceyPy
8.3.0 (CSPICE N0067), wheel SHA-256
`94530fe4927ef4d06d7eb4c4ba2036a448313f5b806c65aa7a3943d55e535d31`; NAIF
`naif0012.tls` (`678e32bd...039b`) and `earth_latest_high_prec.bpc`
(`earth_000101_270111_261015.bpc`, created 2026-10-15, `16b40c07...1528`);
the case export's DE440 file. ERFA is the library HPOP vendors for its
IAU 2006/2000A chain, so the ERFA rows check HPOP's composition, clock and
interpolation, not the series; SPICE is an independent chain.

**Results.** HPOP 1.3.1 (module SHA-256
`8c9c361bddfda89f5dbb63b0d17c61324ae7351feff550ff554bbea429d9b1a0`); largest
value over the 50 epochs. Frames and ephemeris reads have no integrator step,
so one column stands for all three step settings of the trajectory tables.

| Quantity | Reference | Largest difference | Bound | |
| --- | --- | ---: | ---: | --- |
| TAI - UTC | ERFA `eraDat`, SPICE `naif0012.tls` | 0 s | 0 | met |
| TT from UTC | ERFA `eraUtctai`, `eraTaitt` | 5.6 ps | 1 ns | met |
| GCRF to ITRF at HPOP's own instant | ERFA IERS 2010 CIO chain, full X, Y, s | 0.48 µas (16 µm at LEO radius) | 21 µas | met |
| GCRF to ITRF at the UTC epoch | the same, at the exact epoch | 0.214 mas (7.0 mm LEO, 4.4 cm GEO) | 22 µas | missed: clock, below |
| Tides' GMST (`gmst2006`) at HPOP's own UT1, TT | ERFA `eraGmst06` | 0.00 mas | 1 µas | met |
| GCRF to TEME, SGP4 module (`foundation/frames`) | ERFA `eraPnm06a`, `eraEe06a` | 0.2 nas | 1 µas | met |
| Sun from the Earth, HPOP's TDB date | SPICE `spkgeo`, same DE440 file | 30 µm | 1 mm | met |
| Moon from the Earth, HPOP's TDB date | SPICE `spkgeo`, same DE440 file | 15 nm | 1 mm | met |
| GCRF to ITRF | SPICE J2000 to ITRF93 (high-precision BPC) | 8.90 mas (pole 8.23, spin 3.50) | 5 mas | missed: the kernel's EOP and model, below |
| IAU 1976 precession, `lib/coords` | ERFA `eraPmat76` | 206 mas (spin 197, pole 60) | 1 µas | missed: defect 1 |
| IAU 1980 nutation, `lib/coords` | ERFA `eraNutm80` | 49.1 mas | 10 mas | missed: defect 2 |
| GCRF to TEME, `lib/coords` | ERFA `eraPnm80`, `eraEqeq94` | 212 mas (7.0 m LEO, 43 m GEO) | 10 mas | missed: defects 1 and 2 |
| GCRF to Earth-fixed, no-EOP fallback | ERFA `eraGmst82` + `eraEqeq94`, `eraNutm80`, `eraPmat76` (UT1 = UTC, no polar motion) | 212 mas (7.0 m LEO) | 10 mas | missed: defects 1 and 2 |

Measured, without a bound:

| Quantity | Reference | Largest difference |
| --- | --- | ---: |
| TDB - TT (`tdbMinusTtSeconds`) | ERFA `eraDtdb` at the geocentre | 32.0 µs |
| TDB - TT, SPICE | ERFA `eraDtdb` | 13.3 µs (reference spread) |
| TDB date the force model receives | ERFA TT + `eraDtdb` | 46.1 µs |
| GCRF to ITRF: ERFA at HPOP's instant against ERFA at the epoch | ERFA | 0.214 mas (the clock alone) |
| GCRF to ITRF: SPICE against ERFA | | 8.86 mas (reference spread) |
| Tides' GMST at the UTC epoch | ERFA `eraGmst06` at exact UT1, TT | 0.51 mas |
| No-EOP fallback against the full chain with EOP | ERFA | 607 mas (pole 459: the omitted polar motion; spin 402: UT1 - UTC and defect 1) |
| SGP4 TEME (IAU 2006/2000A definition) against the FK5 definition | ERFA `eraPnm80`, `eraEqeq94` | 77.7 mas (2.6 m at LEO radius) |
| Sun from the Earth at the UTC epoch | SPICE at ERFA TDB | 1.35 m |
| Moon from the Earth at the UTC epoch | SPICE at ERFA TDB | 4.9 cm |

**Findings.**

- **The IERS 2010 chain the reference cases use is exact.** At the instant
  HPOP evaluates, `EarthRotation` (hourly X, Y, s nodes interpolated
  linearly, EOP corrections, polar motion and ERA at every call) is within
  0.48 µas of the full ERFA chain, forty times inside its stated 0.02 mas.
  The tides' GMST, HPOP's own code, equals `eraGmst06` at the same dates. The
  SGP4 module's TEME axes equal ERFA's for the definition they state.
- **Clock (precision limit, not a trajectory error).** The force model
  receives TDB as one double Julian date, which resolves 40.2 µs.
  `tdbMinusTtSeconds` (`prw_codec.h`) takes TDB - TT as the difference of two
  such dates, so it moves in 40.2 µs steps (-764.430 µs at every 2026-08-02
  sample, +683.963 µs at every 2026-06-10 sample): up to 19.0 µs of rounding
  on top of the two-term formula's 13.5 µs against `eraDtdb`, 32.0 µs in all.
  Rounding the TDB date adds up to 14.1 µs (46.1 µs from IAU TDB in all).
  Earth rotation, evaluated at the TT recovered from that date, is up to
  14 µs late or early: 0.214 mas about the pole, 7.0 mm at LEO radius. The
  Sun and Moon are read 1.35 m and 4.9 cm from their positions at IAU TDB.
  On a trajectory these are far below the tables above: turning the
  Earth-fixed axes by 0.214 mas moves the EGM2008 70x70 acceleration by at
  most 2.9e-12 m/s^2 at 400 and 700 km (4000 points), which would be 11 mm in
  a day only if it held one direction for the whole day; it changes sign with
  longitude and with the rounding. The Sun and Moon offsets change their
  tidal accelerations by under 1e-14 m/s^2. Where it does
  show is in TDB epoch labels: HPOP writes and reads TDB with its own
  TDB - TT (consistently with itself), and a reader converting those labels
  with `eraDtdb` places a sample up to 32 µs away, 25 cm along track in LEO.
  Computing TDB - TT in seconds rather than as a difference of Julian dates
  removes the 19 µs; a full series (`eraDtdb`) removes the rest.
- **SPICE's ITRF93 kernel is 8.9 mas from the IERS 2010 chain, and HPOP
  follows the IERS chain.** HPOP - SPICE (8.90 mas) and ERFA - SPICE
  (8.86 mas) differ by the clock term alone. The difference is fixed in
  Earth-fixed axes (pole offset of about 4.4, 3.6 mas in August and 4.9,
  5.5 mas in June, plus 1.8 to 3.3 mas of spin), which is an
  Earth-orientation series difference: the kernel is built from JPL's own EOP
  series (`latest.long`) through IAU 1976/1980 with nutation corrections and
  degree-20 Chebyshev fits (its comment area, `tools.json`), while the June
  case rows agree with the current IERS finals to 0.004 mas. The a-priori
  5 mas bound is missed by the reference, not by HPOP; the kernel states
  its own accuracy as several microradians.
- **Defect 1: `lib/coords` IAU 1976 precession.** `coords::precession`
  states "as ERFA pmat76" but multiplies the Lieske coefficients' T0 terms by
  T: zeta and z each carry an extra 1.39656 T^2 - 0.000139 T^3 arcsec and
  theta -0.85330 T^2 - 0.000217 T^3 arcsec (T in centuries from J2000). At
  2026.6 (T = 0.266) that is 98.7, 98.7 and -60.3 mas, the measured 197 mas
  of spin and 60 mas of pole; it grows with T^2 (about 0.7 arcsec of spin in
  2050). For a J2000 start the angles are zeta = 2306.2181 T + 0.30188 T^2 +
  0.017998 T^3, z = 2306.2181 T + 1.09468 T^2 + 0.018203 T^3, theta =
  2004.3109 T - 0.42665 T^2 - 0.041833 T^3 (Lieske et al. 1977; `eraPmat76`).
- **Defect 2: `lib/coords` IAU 1980 nutation table.** In the 63-term table,
  ten rows carry coefficients that IAU 1980 (`eraNut80`) gives to other
  argument multipliers: it gives -158 x 0.1 mas to (-1, 0, 2, 0, 2), which
  IAU 1980 gives to (1, 0, 0, -2, 0), and likewise mispairs (1, 0, 0, -2, 0),
  (0, 0, 2, -2, 1), (-1, 0, 2, 0, 1), (0, 0, 0, 2, 0), (-1, 0, 2, 2, 2),
  (-1, 0, 0, 0, 1) and (1, 0, 2, 0, 1), with the obliquity terms of
  (2, 0, 0, 0, 0) and (0, 0, 2, 0, 0) dropped. One row, (-1, 0, 2, 0, 0), is
  not an IAU 1980 argument. Delta psi is 49.1 mas off and delta epsilon
  1.1 mas on 2026-08-02. Truncation alone costs a few mas (ERFA's own first
  63 rows: 2.4 mas over June to September 2026).
- **Reach of defects 1 and 2.** They are in `lib/coords` alone: its
  `gcrfToTeme`, `gcrfToItrf`, `transform` and `getTransformMatrix` (used by
  `src/hpop_plugin.cpp` for entity input states in TEME or ECEF and its ECEF
  position batches) and the force model's no-EOP fallback
  `ForceModel::GcrfToEarthFixed(jd)`: 212 mas, 7.0 m at LEO radius and 43 m
  at GEO radius, inside the 0.5 arcsec band `environment_conformance.cpp`
  gates them with. The PRW propagation path and every reference case use
  `EarthRotation` (a PRW request with an Earth-fixed force and no EOP is
  refused), and the SGP4 module uses `foundation/frames`; neither is
  affected. No HPOP code was changed here.
- **TEME definitions.** SGP4's TEME taken as the IAU 2006/2000A true
  equator rotated by the equation of the equinoxes (`foundation/frames`)
  and as the FK5 true equator rotated by `eraEqeq94` differ by 77.7 mas,
  2.6 m at LEO radius, against SGP4's kilometre-level accuracy.
- **Existing SPICE and Horizons checks**, not repeated here: HPOP's DE440
  reads against CSPICE N0067 at one epoch for all planets
  (`tests/kernel_invoke.test.mjs`, 1 mm; `tests/de440_force.test.mjs`,
  third-body and SRP accelerations to 1e-18 km/s^2), the DE440 excerpt's
  CSPICE and Horizons vectors (`files/orbit-products/tests/fixtures/de440/`,
  `docs/de440-validation.md`), and `propagator/solar-system-bodies`
  (`tests/cspice_oracle.py`, `tests/parity.mjs`).

## SGP4: Vallado's verification set

The SGP4 module (`propagator/sgp4`) is checked against all 666 rows of
Vallado's `tcppver.out` (33 sets of `SGP4-VER.TLE`, python-sgp4 2.27 sdist
`06d37247...85f9`). Runner and evidence: `propagator/sgp4/tests/evidence/vallado/`
(`run-vallado.mjs`, `sgp4_vallado_native.cpp`, `summary-vallado.json`,
`tools.json`); method and table in `propagator/sgp4/README.md`, "Vallado's
verification set". The case export holds no mean-element sets, so this
runner reads Vallado's own.

| Comparison | Near-Earth | Deep space |
| --- | ---: | ---: |
| Module's `SGP4.cpp`, native, against `tcppver.out` | 7.3 µm | 8.1 µm (118 µm 1.28e6 min out) |
| Shipped wasm against that, at the module's own minutes | 0.41 µm | 112 µm |
| Shipped wasm against `tcppver.out` through `propagate_state` | 15.2 cm | 14.6 cm (9.74 m on 33333) |

Error codes agree (1, 1, 6, 6, 4, 3, 6). Findings: the deep-space
micrometres are `-ffast-math` in the module's CMake flags (the same wasm
build without it agrees to 0.23 µm), and the centimetres are the request's
single Julian-date double and the set epoch kept as one double (up to
19.4 µs and 19.8 µs). SGP4-XP: no US Space Force baseline cases are
available here; `propagator/sgp4-xp/vectors` remains the adapter check.

## Not compared, and why

| Tool | Reason |
| --- | --- |
| STK/HPOP (Ansys AGI), FreeFlyer (a.i. solutions), ODTK | Commercial licences; not installed and not runnable here |
| JPL MONTE, ESA GODOT | Distribution restricted to their agencies and partners |
| Basilisk (CU Boulder AVS) | In `repos/ancillary-packages/basilisk` as source. It is a spacecraft-simulation framework: matching this setup needs a full Basilisk build plus a simulation scenario per case. That was left for a later pass once four independent propagators were in place |
