# FFM cross-validation against Orekit, GMAT, Tudat and Nyx

FFM (Full Force Model) is defined in [the FFM profile](../FFM.md).

FFM is compared with four established, independently written orbit
propagators on identical inputs: Orekit, GMAT, Tudat (native and as
WebAssembly) and Nyx. The comparison also measures how far those
tools differ from each other. That spread is the honest floor for any claim
of agreement. Everything here is reproducible from the repository: the
generators, the reference trajectories, the end-to-end test
(`tests/xval_reference.test.mjs`) and the table script (`tests/xval-summary.mjs`).

## Cases

The cases are a subset of FFM's Orekit 13.1 lock-down
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
| Field | FFM's EGM2008 20x20 (`lib/egm2008_data.h`), radius 6378136.3 m, tide-free |
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
  - **Drag:** R2026a includes NRLMSISE-00; its anomalous-oxygen convention
    is measured in [the GMAT summary](../tests/evidence/gmat/summary-gmat-R2026a.json).
    The macOS build of R2022a has no NRLMSISE-00 plugin, so its
    drag cases use Jacchia-Roberts and FFM is asked for Jacchia-Roberts on
    them. These cases are not compared with the NRLMSISE-00 tools. GMAT's
    Earth is given WGS84's flattening on them, the ellipsoid Orekit and FFM
    take heights on (GMAT's default 0.0033527 moves LEO400 13 cm).
  - **Jacchia-Roberts axes:** GMAT gives the model the spacecraft and the Sun
    in its MJ2000Eq axes, so the Sun's hour angle and declination are on the
    J2000 equator; FFM uses Earth-fixed axes, the true equator of date. By
    2026 the two poles are 0.15 deg apart. That leaves LEO400 and
    SSO700 <!-- BEGIN GENERATED XVAL JR AXES -->1.360 m and 182.236 mm<!-- END GENERATED XVAL JR AXES --> from GMAT after a day (the subset under Results); FFM built with GMAT's axes is 2.4 cm
    and 1.0 cm from it (measured once, not re-scored). GMAT's drag limit is therefore 1.5 m.
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
    The LEO400 gap is isolated to the NRLMSISE-00 port formulas. The
    measured correction and WGS84 runner setting are separated in
    [the Nyx summary](../tests/evidence/nyx/summary-nyx-2.6.0.json).

## Results

The tables below score the shipped <!-- BEGIN GENERATED XVAL BUILD -->FFM 2.3.0 artifact (module SHA-256 `ea457690`, scored 2026-11-10)<!-- END GENERATED XVAL BUILD --> on the original
subset. The [72-case reference suite](#reference-suite-on-72-cases) supplies
the wider coverage and diagnoses. The exact artifact digest is pinned in
[the current subset summary](../tests/evidence/xval/summary.json).

Largest 3D position difference over 24 h, at hourly samples, through the
SDK's browser harness (`node tests/xval-summary.mjs`), at the Orekit suite's
request: RK78 at
1e-13 and steps of at most 300 s. FFM's own integration error at those steps
is under [Findings](#findings). (JR) marks GMAT's Jacchia-Roberts drag cases, where FFM
was also run with Jacchia-Roberts.

### FFM against each tool

<!-- BEGIN GENERATED XVAL TABLE -->
| Case | FFM - Orekit 13.1 | FFM - GMAT R2022a | FFM - Tudat (tudatpy 1.0.0) | FFM - Tudat WASM | FFM - Nyx 2.6.0 |
|---|---:|---:|---:|---:|---:|
| LEO400 F0-point-mass | 0.162 mm | 1.187 mm | 0.008 mm | 0.002 mm | 0.027 mm |
| LEO400 F1-J2 | 1.027 mm | 0.974 mm | 0.995 mm | 0.994 mm | 29.740 mm |
| LEO400 F3-field20x20 | 1.041 mm | 13.579 mm | 2.064 mm | 2.068 mm | 29.986 mm |
| LEO400 F4-field-sun-moon | 1.039 mm | 7.317 mm | 2.065 mm | 2.075 mm | 29.991 mm |
| LEO400 F5-field-sun-moon-srp | 1.115 mm | 12.435 mm | 2.107 mm | 2.106 mm | 30.253 mm |
| LEO400 F6-field-sun-moon-srp-drag | 3.961 mm | 1.360 m (JR) | 34.301 mm | 34.302 mm | 12.097 m |
| SSO700 F0-point-mass | 0.189 mm | 0.857 mm | 0.010 mm | 0.003 mm | 0.065 mm |
| SSO700 F1-J2 | 1.414 mm | 10.262 mm | 1.655 mm | 1.649 mm | 22.407 mm |
| SSO700 F3-field20x20 | 1.462 mm | 5.847 mm | 2.183 mm | 2.169 mm | 23.097 mm |
| SSO700 F4-field-sun-moon | 1.467 mm | 13.342 mm | 2.178 mm | 2.180 mm | 23.098 mm |
| SSO700 F5-field-sun-moon-srp | 1.574 mm | 15.962 mm | 2.149 mm | 2.137 mm | 22.682 mm |
| SSO700 F6-field-sun-moon-srp-drag | 1.379 mm | 182.236 mm (JR) | 53.314 mm | 53.310 mm | 22.760 mm |
| GPS F0-point-mass | 0.160 mm | 0.630 mm | 0.001 mm | 0.001 mm | 0.007 mm |
| GPS F1-J2 | 0.219 mm | 0.739 mm | 0.067 mm | 0.067 mm | 1.761 mm |
| GPS F3-field20x20 | 0.213 mm | 0.020 mm | 0.075 mm | 0.074 mm | 1.754 mm |
| GPS F4-field-sun-moon | 0.173 mm | 3.400 mm | 0.124 mm | 0.124 mm | 1.753 mm |
| GPS F5-field-sun-moon-srp | 0.174 mm | 0.661 mm | 0.125 mm | 0.125 mm | 1.753 mm |
| GEO F0-point-mass | 0.035 mm | 0.095 mm | 0.001 mm | 0.003 mm | 0.002 mm |
| GEO F1-J2 | 0.036 mm | 0.004 mm | 0.007 mm | 0.007 mm | 0.111 mm |
| GEO F3-field20x20 | 0.039 mm | 0.815 mm | 0.052 mm | 0.052 mm | 0.111 mm |
| GEO F4-field-sun-moon | 0.067 mm | 1.346 mm | 0.139 mm | 0.139 mm | 0.111 mm |
| GEO F5-field-sun-moon-srp | 0.061 mm | 1.391 mm | 0.141 mm | 0.141 mm | 0.111 mm |
| MOLNIYA F0-point-mass | 0.576 mm | 4.188 mm | 0.010 mm | 0.011 mm | 0.019 mm |
| MOLNIYA F1-J2 | 9.668 mm | 11.928 mm | 9.416 mm | 9.429 mm | 94.370 mm |
| MOLNIYA F3-field20x20 | 9.646 mm | 3.242 mm | 9.913 mm | 9.906 mm | 94.149 mm |
| MOLNIYA F4-field-sun-moon | 9.509 mm | 4.749 mm | 9.625 mm | 9.631 mm | 94.135 mm |
| MOLNIYA F5-field-sun-moon-srp | 9.125 mm | 9.083 mm | 9.679 mm | 9.697 mm | 94.178 mm |
<!-- END GENERATED XVAL TABLE -->

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

<!-- BEGIN GENERATED XVAL FINDINGS -->
- **Agreement:** FFM agrees with every tool to within that tool's own
  distance from the others, plus its own integration error. Measured over 24 h
  at the suite's request on the original subset (FFM 2.3.0, module SHA-256 `ea457690`, scored 2026-11-10), GMAT's
  Jacchia-Roberts drag cases aside:
  - Orekit: at most 9.668 mm.
  - GMAT: at most 15.962 mm.
  - Tudat: native at most 53.314 mm, WebAssembly at most 53.310 mm. Excluding drag,
    at most 9.913 mm and 9.906 mm.
  - Nyx: at most 94.370 mm without drag, consistent with the Earth-orientation difference
    above. With drag, 12.097 m on LEO400, which is Nyx's own gap from all the others, and
    22.760 mm on SSO700.
<!-- END GENERATED XVAL FINDINGS -->
- **Integration error:** <!-- BEGIN GENERATED INTEGRATION ERROR -->FFM's own integration error at RK78 1e-13 and steps of at most 300 s (FFM there against FFM at 1e-15 and steps of at most 10 s, the largest over the day) is 9.801 mm in LEO 400 km and 0.455 mm at 700 km; the LEO 400 km cases with radiation pressure and drag are within 8.448 mm of Orekit at those settings, 4.092 mm with steps of at most 30 s and 4.074 mm at 1e-15 with steps of at most 10 s (FFM 2.3.0, module SHA-256 `ea457690`, scored 2026-11-10; README.md, Agreement with Orekit 13.1).<!-- END GENERATED INTEGRATION ERROR -->
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
- **Jacchia-Roberts date:** FFM uses GMAT's modified Julian date
  `JD - 2430000`, equivalent to `MJD - 29999.5`. The independent fixture
  contains GmatConsole densities at 2000 epochs and points
  (`tests/fixtures/atmosphere/make-jacchia-roberts-gmat.mjs`); the port agrees
  to 1.8e-6. The GMAT drag cases are <!-- BEGIN GENERATED XVAL JR DATE -->1.360 m and 182.236 mm<!-- END GENERATED XVAL JR DATE --> from GMAT, consistent
  with the axes difference above.

## GMAT R2026a on the 72 reference cases

GMAT runs every case of `tests/evidence/cases/ffm-reference-cases.json` whose
forces it models (57 of 72), from the case export's initial states, constants,
EOP rows, space weather, DE440 kernel and FFM's embedded coefficients. FFM
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

**Settings that match FFM** (each also in `run-gmat.mjs`'s header and in the
trajectory file):

| Item | GMAT setting |
| --- | --- |
| Integrator | RungeKutta89, accuracy 1e-14, steps <= 30 s, RSSStep. Cases without radiation pressure move under 0.06 mm against PrinceDormand78 at 1e-13 with steps <= 10 s |
| Gravity | `.cof` written from `lib/egm2008_data.h` / `lib/egm96_data.h`; degree and order per case; G2's terms of order >= 1 above degree 24 written as zero |
| Earth | GM 398600.4415 km^3/s^2; radius 6378.137 km and WGS84 flattening (shadow, geodetic height); nutation at every call |
| Earth orientation | FK5 (IAU 1976/1980) with the case export's pole and UT1-UTC rows in GMAT's C04 file. The state is given in GMAT's ICRF axes, which it ties to the Earth-fixed frame by IAU 2006/2000A, and the samples are rotated out of its integration axes by the epoch's fixed rotation; EME2000 cases through the IERS 2003 frame bias |
| Sun, Moon | SPICE, the case export's DE440 kernel at TDB; DE440 header GMs; Sun radius 695 700 km |
| Radiation pressure | Spherical, 1361 W/m^2 at 1 au, conical shadow |
| Drag | NRLMSISE-00 (R2026a; R2022a has none, so Jacchia-Roberts with FFM asked for the same); constant F10.7 = F10.7a = 150, Kp 3 (GMAT's table gives Ap 15) |
| W1 space weather | the drivers FFM reads from the CSSI rows on the arc's day, as constants: F10.7 139.8 (observed, previous day), F10.7a 136, Kp 5/3 (Ap 6) |
| Solid tides (T1) | `SolidAndPole` (IERS steps 1 and 2 with solid and ocean pole tides) with GMAT's own pole-tide increments (C21 -2.2608e-10, S21 -1.4519e-10 at mid-arc) subtracted from the `.cof`, leaving steps 1 and 2 without pole tide, as FFM's T1 |
| Relativity (R2) | `RelativisticCorrection = On` (Schwarzschild, Lense-Thirring, de Sitter) |
| In-track thrust (I1) | a thruster on LVLH axes (y along-track, the S axis of QSW), C1 = a * m, no mass decrement |

Not run (no GMAT model): R1 (Schwarzschild alone), B1 (Cd*A/m rate), J1
(JB2008), A1 (Knocke), O1 and O2 (ocean tides), and C1 LEO400 and both C2
cases, which combine them. GPS C1 (radiation pressure and in-track thrust) is
run.

**Results.** The current shipped FFM artifact, its SHA-256, all three
integration settings, per-case limits, and Orekit-minus-GMAT scores are in
[the R2026a summary](../tests/evidence/gmat/summary-gmat-R2026a.json).
Its verdict keeps measured misses and their causes. The per-case table is
the numerical authority; aggregate prose does not replace those scores.

**State-transition matrix** (GMAT's `OrbitSTM`, 6x6, against FFM's analytic
STM at the suite's request; largest relative column difference, position and
velocity rows apart, all 57 cases): the summary reports each case and the
maximum in `verdict.stm`. Relativity, in-track thrust and eclipsing radiation
pressure have identifiable partial-model differences.
GMAT leaves the corresponding terms out of its variational equations:
`RelativisticCorrection` and `FiniteThrust` add no partials, and
`SolarRadiationPressure` differentiates the Sun-direction term without the
shadow function. GMAT has no Cd or Cr columns in `OrbitSTM`. The STM file
(1.2 MB) stays out of git; its SHA-256 is in the summary.

**Tolerances** remain the case export's limits: point mass 1 cm, gravity
5 cm, radiation pressure 10 cm, and drag 1.5 m. The current summary records
pass/fail at all three settings and diagnoses the R2026a NRLMSISE-00 misses.
No measured discrepancy changes its limit.

**Cause of the drag gap: anomalous oxygen** (`tests/evidence/gmat/anomalous-oxygen.json`).
GMAT's NRLMSISE-00 plugin takes the total mass density of `gtd7`, which
leaves anomalous oxygen out (`NRLMsise00Atmosphere::Density`); FFM, like
Orekit, takes `gtd7d`'s, which includes it (Picone et al. 2002 give `gtd7d`
for drag). Along GMAT's trajectory, every 60 s, FFM's diagnostic gives both
densities. The [anomalous-oxygen record](../tests/evidence/gmat/anomalous-oxygen.json)
contains the mean density share, independently measured drag effect, and
current FFM differences against both the original and Cd-scaled GMAT
trajectories. Scaling a constant Cd by the mean share is an approximation;
the corrected residual remains measured and retains both the GMAT 1.5 m
and shared 0.1 m limits. GMAT's drag otherwise uses mean local solar time,
WGS84 geodetic heights, and the same constant drivers.

**Other GMAT settings.** The [variant measurements](../tests/evidence/gmat/variants.json)
compare the current FFM run at steps <= 30 s with pinned GMAT integrator,
tide and CSSI-driver variants. The record retains both FFM-minus-GMAT and
Orekit-minus-GMAT for each case and setting.

- Step 2 of IERS 2010 section 6.2 (the frequency dependence of k2, notably
  the K1 band) is 2.1 m in LEO400 over the day.
- GMAT reads CSSI rows by its own conventions (`SolarFluxReader`): F10.7
  taken as measured at 20 h UT and interpolated in time, and for
  daily-predicted rows the current day's record looked up one day early.
  FFM and Orekit take each day's values as published (F10.7 of the previous
  day, centered average and daily Ap of the day).
- GMAT's radiation-pressure trajectories in LEO and Molniya move by 1-2 cm
  with its step size while its other cases move under 0.06 mm. The current
  FFM comparison is recorded per variant. The 30 s setting is the one used.

**R2022a.** The [R2022a summary](../tests/evidence/gmat/summary-gmat-R2022a.json)
contains 55 cases and records the current scores and verdict. W1 is not run
with Jacchia-Roberts, whose drivers FFM reads three-hourly. R2022a reads
SPICE ephemerides as J2000; R2026a corrects that convention (GMT-5211).
Jacchia-Roberts uses the axes convention described above and keeps the
unchanged 1.5 m drag limit.

## ERFA, Orekit and SPICE: classical frames and the force clock

FFM 1.4.0 uses ERFA 2.0.1 as the sole implementation of its classical
`coords` frames: IAU 1976 `eraPmat76`, IAU 1980 `eraNutm80`/`eraPnm80`,
FK5 TEME `R3(eraEqeq94) * eraPnm80`, and the equinox terrestrial chain
`R3(eraGst94) * eraPnm80`. GCRF/J2000 are aliases in this API, without frame
bias. Every valid frame pair is supported; invalid frame/date inputs return
all-NaN results. The public single-double argument is UTC JD, split exactly
before ERFA UTC → TAI → TT conversion. Explicit `coords::Epoch` calls carry
TT and UT1 in two parts.

The no-EOP force fallback evaluates that same chain at every call. Its
legacy choices are UT1 = UTC, zero polar motion and no frame bias. The EOP
force path uses the IAU 2006/2000A CIO chain, case EOP interpolated linearly
in TAI, and hourly TT X/Y/s nodes interpolated linearly. The force instant is
two-part TT through integrator stages, rotations, tides and ephemerides.
SPK reads use `((tdb1 - 2451545) + tdb2) * 86400`. FFM retains its existing
two-term TDB−TT model, evaluated in seconds; `eraDtdb` is a different model
and is used only as an independent diagnostic reference.

Velocity follows `v_to = M v_from + Mdot r_from`, retaining Earth rotation
about the true pole and using the analytic GMST82 rate. Precession, nutation
and equinox rates are omitted. The independent full-chain ±1 s derivative
measures their residual; the approximate scale is 2e-11 rad/s times radius
(0.14 mm/s at LEO, 0.8 mm/s at GEO), rather than a strict bound.

**Evidence.** `tests/evidence/erfa-spice/check-classical-frames.mjs` evaluates
10,000 UTC epochs from 1990-01-01 to 2040-01-01 with deterministic
subsecond jitter, all 64 frame pairs and six state directions. Independent
pyerfa evaluates each matrix, transport velocity and full derivative.
C++ reduces the results, enforcing 1 µm position at GEO radius and
1e-9 m/s velocity for the native ERFA comparison. A second native build
with contraction disabled and the provisioned toolchain's musl sin/cos
checks the shipped WASM ECEF export exactly. The report separately records
the ARM FMA arithmetic spread and native-libc versus WASM-libc rounding.

`run-erfa-spice.mjs` evaluates 50 hourly UTC epochs of the shared cases
(2026-06-10/11 and 2026-08-02/03). Source-built force APIs use the exact PRW
TT instant; the independent references are pyerfa 2.0.1.5, SpiceyPy 8.3.0
(CSPICE N0067), the pinned DE440 excerpt and NAIF ITRF93 BPC.
`check-erfa-spice.mjs` authenticates final source/artifact hashes and rebuilds
all 50 FFM records against the pinned reference, including the four
classical rows, exact-epoch CIO rotation and the separate SGP4 TEME chain.
All comparisons and unit conversions run in C++.

<!-- BEGIN CLASSICAL FRAME RESULTS -->

All 64 frame pairs meet the direct-ERFA limits: maximum position error
2.9802323e-8 m at GEO and velocity error 3.7499437e-12 m/s. The 11-epoch
WASM/matched-native comparison is exactly 0 m. Stock native-libc versus
WASM-libc rounding is 7.4505806e-9 m; disabling ARM contraction changes
the direct-ERFA comparison by at most 2.4149826 µm. These separate compiler
and library measurements do not change the accuracy limits.

| Quantity | 1.3.1 baseline | 1.4.0 | Units / reference |
| --- | ---: | ---: | --- |
| MOD precession | 206.420024 | 0 | mas, ERFA, 50 epochs |
| MOD → TOD nutation | 49.083224 | 0 | mas, ERFA, 50 epochs |
| GCRF → TEME | 211.795418 | 2.0002e-10 | mas, ERFA, 50 epochs |
| Classical no-EOP fallback | 211.890408 | 2.8625e-8 | mas, ERFA, 50 epochs |
| Force CIO rotation at exact epoch | 0.213831331 | 0.000483481 | mas, ERFA, 50 epochs |
| Force CIO rotation at exact epoch | 7.026783 | 0.015888 | mm at LEO |
| Sun ephemeris against ERFA TDB | 1.353636 | 0.395263 | m; remaining two-term TDB model spread |
| Moon ephemeris against ERFA TDB | 0.048875 | 0.014053 | m; remaining two-term TDB model spread |
| Isolated ECEF velocity pole error | 1.285653 / 5.037807 / 7.997551 | 0 / 0 / 0 | m/s at LEO / GPS / GEO, 2026-08-02 |

Across the wider 1990–2040 grid, the GCRF → ECEF position error falls from
96.473302 m to 1.666001e-8 m at GEO; velocity error falls from
11.857143 m/s to 2.273737e-12 m/s. The old unimplemented GCRF → PEF pair
returned identity, producing up to 84,328,337.881 m error at GEO.
The maximum neglected full-matrix velocity derivative is 0.000890341 m/s
at GEO over all pairs; GCRF → ECEF alone measures 0.000465126 m/s.
`before-after.json` retains the original measurements, and
`before-after-metrics.json` gives each frame's angle, radius-scaled chord
and velocity values.

The remaining classical-ECEF versus CIO budget is 533.295092 mas,
equivalent to 17.524789 / 68.670550 / 109.014937 m at LEO / GPS / GEO.
It is a model/EOP limitation, separate from ERFA implementation identity.
The ERFA/SPICE verdict contains zero remaining classical/clock defects;
its one limited miss is the retained independent ITRF93 reference spread.

<!-- END CLASSICAL FRAME RESULTS -->

**Independent Orekit frames.** `OrekitFrames.java` uses Orekit 13.1 and the
same `finals2000A.all`. For classical frames, Orekit EME2000 corresponds to
FFM's classical GCRF/J2000 input: neither applies a frame bias inside this
comparison. MOD/TOD/TEME use IERS 1996 without EOP corrections. Orekit's
IERS 1996 Delaunay arguments differ from ERFA IAU 1980; its cubic
psi_A/omega_A/chi_A precession representation also differs slightly from
ERFA's cubic zeta/z/theta representation. The measured spread is retained
against the original 1 mm target.

For GCRF → ITRF, Orekit uses IERS 2010, `simpleEOP=true` and its minimum
allowed EOP interpolation degree, 3. FFM uses linear interpolation. Raw
agreement therefore includes interpolation spread. The report also gives
agreement at midnight EOP nodes and an explicitly labeled same-EOP
comparison to isolate the force-clock effect; neither replaces the raw
Orekit score. Java source, jar resources, oracle output and reducer hashes
are pinned in `orekit-frames-summary.json`.


| Independent Orekit comparison | mas | mm at LEO | mm at GEO |
| --- | ---: | ---: | ---: |
| Classical MOD | 0.010607577 | 0.348579 | 2.168376 |
| Classical TOD | 0.019413815 | 0.637964 | 3.968527 |
| Classical TEME | 0.012053082 | 0.396080 | 2.463863 |
| Force ITRF, all 50 epochs, raw EOP | 0.263518419 | 8.659567 | 53.867820 |
| Force ITRF, EOP midnight nodes | 0.000580149 | 0.019064 | 0.118593 |
| Force ITRF, LEO400 F3 epochs, raw EOP | 0.114602461 | 3.765990 | 23.426767 |
| Force ITRF, LEO400 F3, aligned-EOP diagnostic | 0.000401117 | 0.013181 | 0.081995 |

At EOP midnight nodes, the 1.3.1 rotation error is 7.019445 mm at LEO;
the two-part force clock gives 0.019064 mm. The August aligned-EOP
comparison changes from 7.027113 to 0.013181 mm. Raw scores retain the
independently measured cubic-versus-linear interpolation spread.


On FFM 1.4.0 against the 1.3.1 baseline (the recorded before/after of the
frame change, not re-scored), the Orekit trajectory suite retains 72/72
published limits. The additional
before/after constraint (increase no greater than 0.0001 m) is met by 113 of
117 LEO/SSO setting rows. Its four misses remain explicit:

| Case / setting | Baseline worstM | Current worstM |
| --- | ---: | ---: |
| LEO400 F3-field20x20 / suite | 0.018112741869270137 | 0.01821440531773162 |
| LEO400 J1-field-sun-moon-srp-drag-jb2008 / suite | 0.025022275929181808 | 0.025855702188580517 |
| SSO700 Z1-zonal20-sun-moon / suite | 0.014466331952695819 | 0.014595130077823898 |
| LEO400 J1-field-sun-moon-srp-drag-jb2008 / finest | 0.001237102075599719 | 0.0014349286371713363 |

Adaptive-step counts change in some of these cases; tighter settings improve
F3 and SSO Z1 agreement, while the JB2008 finest row still misses the cap.
This evidence does not turn the four misses into passes.
`orekit-trajectory-before-after.json` records every LEO/SSO row and setting.

**SPICE reference spread.** ITRF93 uses the BPC's own EOP series and IAU
1976/1980 with corrections; the case CIO chain uses shared IERS EOP and
IAU 2006/2000A. `c2tSpice` retains its 5 mas limit and recorded miss;
`c2tSpiceErfa` measures the independent spread. `coordsEcefCio` and
`coordsEcefSpice` record the classical API's remaining EOP/model budget in
mas and meters at LEO/GPS/GEO. These diagnostic differences are not
classical ERFA identity errors.

Offline reproduction from `propagator/ffm`:

```sh
node tests/evidence/erfa-spice/check-classical-frames.mjs
node tests/evidence/erfa-spice/run-erfa-spice.mjs --flatbuffers <flatbuffers checkout>/include
node tests/evidence/erfa-spice/run-orekit-frames.mjs
node tests/evidence/erfa-spice/check-erfa-spice.mjs
```

All seven [runtime receipts](../README.md#verification) pass on FFM 1.4.0,
module SHA-256 `eb05fc526683d6592a8207319e6b8b3eda582d00d4da273198e6126467732629`.
The headless-shell browser, native WasmEdge and Docker WasmEdge lanes have
byte-identical responses and exit classes: PRW 72, GNSS 20, Earth
radiation/tides 24, variational 40, finite burn 180 and kernel 24 runs per
lane. The resident receipt has 33 requests across each of the three runtimes,
with exact agreement. These receipts are not re-scored with the suite.

### Re-scoring a new build

One command re-scores the whole suite on the committed dist, from the
repository root:

```sh
export FFM_XVAL_NYX_OUT=<the Nyx runner's out/ folder>
export FFM_XVAL_GMAT_WORK=<the GMAT work folder>
nice -n 19 node propagator/ffm/tests/evidence/rescore-all.mjs
```

Two stored tool outputs live with the tool installs, outside the repository.
The command, `consolidate.mjs`, `check-all.mjs` and
`refresh-derived-comparisons.mjs` refuse to run without them, and say which
one is missing:
- `FFM_XVAL_NYX_OUT` (or `--nyx-out`) names the folder `run-nyx.mjs` writes
  the Nyx runs to: `nyx-2.6.0-stm.json`, `nyx-2.6.0-msis-published.json`,
  `nyx-2.6.0-fine.json` and `nyx-2.6.0-naif-bpc.json`. That is the `out/`
  folder of the Nyx runner's working directory.
- `FFM_XVAL_GMAT_WORK` (or `--gmat-work`) names the GMAT work folder. Its
  `anomalous-oxygen/` and `variants/` folders hold the GMAT diagnostic scripts
  and reports.

It flies FFM's side again through the shipped WASM, serially, against every
stored reference. No reference engine is run and nothing is fetched. The steps
run in this order:

1. ERFA/SPICE and Horizons with `--stored-reference`. The Nyx summary pins the
   ERFA/SPICE summary, so these come first.
2. The trajectory scorers: Tudat native and WASM, Orekit, GMAT R2026a and
   R2022a, and Basilisk. FFM state caches flown on another build are removed
   and flown again.
3. The derived GMAT, Nyx and Basilisk diagnostics.
4. The summaries that pin those diagnostics: the GMAT annotations, Nyx, and
   Basilisk a second time from the same cached states.
5. The 27-case subset (`tests/xval-summary.mjs`), SGP4-XP
   (`propagator/sgp4/tests/evidence/xp/run-xp.mjs`) and SGP4 against its
   STR#3 base (`propagator/sgp4/tests/evidence/str3/run-str3.mjs`).
6. The date in `rescore.json`, then `consolidate.mjs --write`.
7. `check-all.mjs`.

Finally it writes `tests/evidence/scored/<version>-<sha256[0:8]>.json`. That
file is the build's result, comparison by comparison. Each comparison records:
- what it was against, and whether it ran;
- whether every primary limit was met;
- the rows met out of the rows scored;
- the headline row (the one nearest its limit, or furthest past it), with its
  limit;
- every missed row, with its recorded cause;
- for a comparison that did not pass, a note in plain words.

A missed limit stays missed. `check-all.mjs` holds the current build's file to
`consolidated.json`. `--skip-scoring` keeps the scored summaries and redoes only
the consolidation, the checks and the per-build file. `--record-only
--consolidated <file> --commit <sha>` writes the file of a build scored earlier
from the `consolidated.json` committed with its evidence.

The steps it runs are described below.

`tests/evidence/refresh-derived-comparisons.mjs` refreshes the FFM side of
stored GMAT, Nyx and Basilisk diagnostic comparisons. It uses the current
Tudat FFM response cache, recomputes missing responses through the shipped
WASM, and performs reductions in C++. Independent reference trajectories
stay pinned. Run it after refreshing the primary GMAT/Basilisk summaries
and Tudat current-WASM cache:

```sh
node tests/evidence/refresh-derived-comparisons.mjs --gmat --nyx --basilisk
```

Refresh the affected tool summaries and their file hashes with the
tool-specific scoring/annotation commands before
`node tests/evidence/consolidate.mjs --write`.

The GMAT diagnostic inputs are the provisioned local reports under
`$FFM_XVAL_GMAT_WORK/{anomalous-oxygen,variants}`; this refresh step does not
run or fetch an external reference engine.

ERFA/SPICE and Horizons re-score the FFM side against their stored
pyerfa/SPICE references without running Python; each refuses if FFM's
instants or the authenticated Horizons rows differ from those the stored
reference was evaluated at:

```sh
node tests/evidence/erfa-spice/run-erfa-spice.mjs --stored-reference
node tests/evidence/horizons/run-horizons.mjs --stored-reference
```

[rescore.json](../tests/evidence/rescore.json) records the re-score date and
the evidence not re-scored, with its build and the reason.

## SGP4 against its STR#3 base

The SGP4 module is built on `foundation/sgp4-str3`. Every state it returns is held to the base,
compiled natively without `-ffast-math`, for the seven SGP4-VER element sets, the module's own
test sets and four more regimes, from a day before epoch to ten days after.
[Verification sets](../../sgp4/README.md#verification-sets) gives generated numbers and links to
the evidence and its replay.

SGP4-XP is checked for exact agreement with the Space Force library's own
runtime. Its theory has no independent public reference outside that library;
[the XP summary](../../sgp4/tests/evidence/xp/summary-xp.json) states the scope.

## Not compared, and why

| Tool | Reason |
| --- | --- |
| STK (Ansys AGI), FreeFlyer (a.i. solutions), ODTK | Commercial licenses; not installed and not runnable here |
| JPL MONTE, ESA GODOT | Distribution restricted to their agencies and partners |

## Reference suite on 72 cases

<!-- BEGIN GENERATED REFERENCE SUITE -->
| Orbit | Force class | Orekit | GMAT R2026a | GMAT R2022a | Nyx | tudatpy | Tudat WASM | Basilisk | Orekit finest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LEO400 | point mass | 0.162 mm | 0.005 mm | 0.002 mm | 0.012 mm | 0.008 mm | 0.002 mm | 0.002 mm | 0.162 mm |
| LEO400 | field + third bodies + SRP (no drag) | 1.264 mm | 30.389 mm | 30.370 mm | 0.888 mm | 23.017 mm | 2.106 mm | 1.138 mm | 1.313 mm |
| LEO400 | drag | 8.448 mm | 2.319 m | 1.362 m | 12.462 m | 41.170 mm | 34.302 mm | 5418.767 m | 4.074 mm |
| SSO700 | point mass | 0.189 mm | 0.002 mm | 0.012 mm | 0.005 mm | 0.010 mm | 0.003 mm | 0.002 mm | 0.180 mm |
| SSO700 | field + third bodies + SRP (no drag) | 1.803 mm | 10.531 mm | 12.699 mm | 0.675 mm | 1.700 mm | 2.180 mm | 0.293 mm | 1.355 mm |
| SSO700 | drag | 1.482 mm | 7.950 m | 180.379 mm | 61.282 mm | 2.420 mm | 53.310 mm | 58.144 m | 1.061 mm |
| GPS | point mass | 0.160 mm | 0.004 mm | 0.004 mm | 0.004 mm | 5.440e-04 mm | 0.001 mm | 0.002 mm | 0.158 mm |
| GPS | field + third bodies + SRP (no drag) | 0.219 mm | 1.500 mm | 2.512 mm | 0.115 mm | 1.389 mm | 0.125 mm | 0.156 mm | 0.218 mm |
| GPS | drag | — | — | — | — | — | — | — | — |
| GEO | point mass | 0.035 mm | 8.819e-04 mm | 0.001 mm | 0.002 mm | 0.001 mm | 0.003 mm | 7.045e-04 mm | 0.037 mm |
| GEO | field + third bodies + SRP (no drag) | 0.067 mm | 0.151 mm | 1.330 mm | 0.154 mm | 0.149 mm | 0.141 mm | 0.148 mm | 0.065 mm |
| GEO | drag | — | — | — | — | — | — | — | — |
| MOLNIYA | point mass | 0.576 mm | 0.008 mm | 0.056 mm | 0.007 mm | 0.010 mm | 0.011 mm | 0.017 mm | 0.575 mm |
| MOLNIYA | field + third bodies + SRP (no drag) | 9.668 mm | 4.868 mm | 29.715 mm | 0.664 mm | 9.431 mm | 9.906 mm | 0.633 mm | 9.840 mm |
| MOLNIYA | drag | — | — | — | — | — | — | — | — |

### Drag cases with the tool-side setting difference removed (diagnostic)

| Tool | Orbit | Cases | Stock | Setting difference removed | Limit | Stock verdict | Diagnostic verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GMAT R2026a | LEO400 | 3 | 2.319 m | 33.544 mm | 1.500 m | not met | met |
| GMAT R2026a | SSO700 | 3 | 7.950 m | 122.934 mm | 1.500 m | not met | met |
| Nyx | LEO400 | 5 | 12.462 m | 52.448 mm | 100.000 mm | not met | met |
| Nyx | SSO700 | 3 | 61.282 mm | 0.850 mm | 100.000 mm | met | met |
| Basilisk | LEO400 | 4 | 5418.767 m | 44.175 mm | 100.000 mm | not met | met |
| Basilisk | SSO700 | 3 | 58.144 m | 0.764 mm | 100.000 mm | not met | met |

*Maximum hourly 3D position differences at the suite setting; Orekit finest is separate. Drag adjustments: [GMAT R2026a: Cd scaled by 1 + eps from the anomalous-oxygen diagnostic](../tests/evidence/gmat/anomalous-oxygen.json); [Nyx: Published NRLMSISE-00 formulas + WGS84 shape](../tests/evidence/nyx/drag-settings-diagnostic.json); [Basilisk: WGS84 coordinates + native gtd7d density](../tests/evidence/basilisk/summary-basilisk-2.12.0.json#/diagnostics/wgs84-gtd7d). Limits: [shared protocol](../tests/evidence/cases/ffm-reference-cases.json), with GMAT limits applying only to GMAT.*

Evidence: [Orekit](../tests/evidence/orekit/), [GMAT R2026a](../tests/evidence/gmat/), [GMAT R2022a](../tests/evidence/gmat/), [Nyx](../tests/evidence/nyx/), [tudatpy](../tests/evidence/tudat/), [Tudat WASM](../tests/evidence/tudat/), [Basilisk](../tests/evidence/basilisk/), [ERFA/SPICE](../tests/evidence/erfa-spice/), [Horizons](../tests/evidence/horizons/), [SGP4 against its STR#3 base](../../sgp4/tests/evidence/str3/), [SGP4-XP](../../sgp4/tests/evidence/xp/), [consolidated report](../tests/evidence/CONSOLIDATED.md).

From the repository root:

```sh
UV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/ffm/tests/evidence/check-all.mjs
```
<!-- END GENERATED REFERENCE SUITE -->
