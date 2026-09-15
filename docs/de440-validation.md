# DE440 ephemeris references and measured validation

## Authority and conventions

The numerical oracle is **NASA/JPL NAIF CSPICE N0067**, called through
SpiceyPy 8.0.0 on the published `de440s.bsp`. No reference state is generated
by this repository's reader or HPOP implementation. The reproduction script
imports CSPICE and never imports the implementation under test.

- [NAIF DE440s download](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp).
- [CSPICE `spkez_c`](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spkez_c.html): geometric states with `ref="J2000"`, `abcorr="NONE"`.
- [NAIF SPK required reading](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/spk.html): segment formats and barycentric state composition.
- [Park, Folkner, Williams and Boggs (2021), *The JPL Planetary and Lunar Ephemerides DE440 and DE441*, AJ 161:105](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440_and_de441.pdf), DOI 10.3847/1538-3881/abd414: ephemeris model, ICRF alignment, DE440/DE441 differences.

All stored vectors are geometric: **ICRF/J2000**, **km**, **km/s**, with **TDB
Julian date** input. The conversion to the oracle's ET is
`(jd_tdb - 2451545.0) * 86400`. Reference dates are exact integer/half-integer
Julian dates, so this conversion introduces no single-JD rounding ambiguity.
There is no UTC conversion, light-time correction, stellar aberration, or
precession-of-date correction in these vector comparisons.

The same-kernel acceptance bounds are absolute Euclidean vector norms:
**1e-6 km position and 1e-9 km/s velocity**. They allow floating-point
interpolation and barycentre-chain summation differences. They do not claim
that JPL's physical ephemeris or observations are accurate to one millimetre.

## Fixtures and provenance

`files/orbit-products/tests/fixtures/de440/` contains:

| File | Purpose |
| --- | --- |
| `cspice-de440.csv` | 238 independent states, written at 17 significant digits |
| `cspice-metadata.json` | Oracle version, source SHA-256, units, frame, time scale, coverage and tolerance rationale |
| `horizons.csv` | 48 public JPL Horizons reference vectors |
| `horizons-responses.json` | Complete API responses, query URLs/parameters, retrieval time, and actual source labels |
| `de440-2026.bsp` | 114,688-byte excerpt copied by CSPICE `spksub_c`, preserving the original coefficients |
| `excerpt-metadata.json` | Excerpt hash, source hash, tool version, time span, and all 14 segment identities |
| `download.py` | Streaming downloader with source size and SHA-256 validation |
| `generate_references.py` | Independent CSPICE and Horizons reference acquisition |
| `extract_2026.py` | Reproducible source-record extraction, with no polynomial refit |

The full kernel has **32,726,016 bytes** and SHA-256
`c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2`.
It is deliberately ignored by Git and never compiled into WASM. Its TDB
coverage is JD **2396752.5–2506352.5**.

The committed 2026 excerpt covers JD **2461041.5–2461406.5** (2026-01-01
through 2027-01-01 TDB, inclusive). Its SHA-256 is
`e612a95953ca8211c629bdb632d4c7483cc339f0e963592bd8cae4a7d24ad7ef`.
The [CSPICE `spksub_c` procedure](https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/cspice/spksub_c.html)
copies the required original records, retaining every DE440s segment and its
identity/priority. Production receives either kernel as caller-provided bytes;
these Python tools are only host-side fixture preparation.

The 238 CSPICE rows cover 17 target/centre pairs at J2000, the first day of
every month in 2026, and 2027-01-01. Targets include **SSB 0, planetary
barycentres 1–9, Sun 10, Moon 301, and Earth 399**. Explicit paths include
Moon/Earth, Moon/EMB, Earth/EMB, Earth/Moon, Sun/Moon, and Earth/SSB. Thus the
tests exercise direct segments, chain composition, reverse subtraction, and
SSB as a target. The excerpt is checked against all **221** rows in its
coverage, independently of whether the full kernel has been downloaded.

## JPL Horizons and release differences

The [public Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html)
returned **DE441** for every query on 2026-09-15. The fixture preserves this
fact instead of relabelling these as DE440 values. The queries request
`EPHEM_TYPE=VECTORS`, `REF_SYSTEM=ICRF`, `REF_PLANE=FRAME`,
`VEC_CORR=NONE`, `OUT_UNITS=KM-S`, `TIME_TYPE=TDB`, and `VEC_TABLE=2`,
with exact TDB JDs for 2026-01-01, 04-01, 07-01, and 10-01. The API resolves
Mercury and Venus barycentre requests 1 and 2 to the coincident body IDs 199
and 299; the preserved source headers show those resolutions.

DE440 and DE441 use different lunar core damping models. Park et al. (2021),
page 2 and Figure 1, explain that their lunar differences grow beyond the
1970–2020 fitted range. It would therefore be incorrect to require DE440
vectors to match the current Horizons Moon at the same-kernel tolerance.
The separate cross-release smoke check uses **0.01 km and 1e-7 km/s**:
a conservative ten-metre/0.1-mm/s modern lunar-model envelope, not an
observational uncertainty estimate or a published velocity bound. The strict
DE440 interpolation tests retain **1e-6 km and 1e-9 km/s**.

Measured on 2026-09-15, native C++ (`c++ -std=c++17 -O2`):

| Comparison | Rows | Maximum position difference (km) | Maximum velocity difference (km/s) |
| --- | ---: | ---: | ---: |
| Full DE440s vs independent CSPICE | 238 | 0 | 0 |
| 2026 excerpt vs independent CSPICE from full DE440s | 221 | 0 | 0 |
| DE440s vs public Horizons DE441 | 48 | 0.0024503268843673186 | 6.913231791605064e-9 |
| HPOP kernel Sun/Moon vs independent CSPICE | 24 | 0 | 0 |

Exact zero is the measured result for these reference states and this native
compiler, not a promise of bitwise agreement with CSPICE on every platform.
The tests enforce the stated nonzero tolerances.

## Analytic error removed from the HPOP kernel path

The following measures the actual legacy force-helper outputs,
`astro::getSunPosition` and `astro::getMoonPosition`, explicitly selected as
`EphemerisSource::Analytical`, against the independent CSPICE DE440 vectors.
This is the behaviour consumed by HPOP before selecting a kernel. It is **not
an accuracy claim about full VSOP87, ELP2000, or the separate simplified
`astro::Ephemeris` helper implementations**. The legacy Solar routine includes
a mean-longitude coefficient of `360007.6982779` degrees/century and date-
dependent obliquity; its very large measured discrepancy is retained here
rather than hidden. The analytic fallback itself is unchanged by this lane.

All rows are 00:00 **TDB**, centred on Earth, comparing the existing equatorial
vectors as consumed by HPOP to **ICRF/J2000** DE440. Columns are absolute
position-vector differences in **km**, rounded only for display.

| Epoch TDB | Julian date | Analytic Sun error (km) | Analytic Moon error (km) | DE440 error, either body (km) |
| --- | ---: | ---: | ---: | ---: |
| 2026-01-01 | 2461041.5 | 5,562,039.931 | 3,511.620 | 0 |
| 2026-02-01 | 2461072.5 | 195,018,587.895 | 4,685.669 | 0 |
| 2026-03-01 | 2461100.5 | 294,064,901.328 | 4,868.037 | 0 |
| 2026-04-01 | 2461131.5 | 193,241,634.479 | 4,428.145 | 0 |
| 2026-05-01 | 2461161.5 | 34,968,362.479 | 1,646.493 | 0 |
| 2026-06-01 | 2461192.5 | 229,516,944.936 | 3,010.314 | 0 |
| 2026-07-01 | 2461222.5 | 302,443,605.976 | 2,627.335 | 0 |
| 2026-08-01 | 2461253.5 | 200,810,253.844 | 1,568.492 | 0 |
| 2026-09-01 | 2461284.5 | 5,835,288.652 | 853.888 | 0 |
| 2026-10-01 | 2461314.5 | 222,797,896.754 | 314.125 | 0 |
| 2026-11-01 | 2461345.5 | 296,991,249.372 | 902.316 | 0 |
| 2026-12-01 | 2461375.5 | 199,409,123.907 | 1,230.711 | 0 |

The harness also verifies that each analytic state reports `Analytical` and
each loaded state reports `JPL_DE440`, and checks loaded velocities against
CSPICE. A caller-provided DE label remains caller provenance; a generic SPK
file does not prove its DE release merely from the DAF magic bytes.

## Reproduce

From the modules repository root, using Python 3.11 or later:

```sh
python3 files/orbit-products/tests/fixtures/de440/download.py
node --test files/orbit-products/tests/de440_reference.test.mjs
```

Measured pass lines:

```text
RESULT de440_cspice_position_km 0 9.9999999999999995e-07 PASS
RESULT de440_cspice_velocity_km_s 0 1.0000000000000001e-09 PASS
RESULT horizons_de441_position_km 0.0024503268843673186 0.01 PASS
RESULT horizons_de441_velocity_km_s 6.9132317916050638e-09 9.9999999999999995e-08 PASS
RESULT hpop_de440_position_km 0 9.9999999999999995e-07 PASS
RESULT hpop_de440_velocity_km_s 0 1.0000000000000001e-09 PASS
ℹ tests 3
ℹ pass 3
ℹ fail 0
ℹ skipped 0
```

The Node test orchestrates compilation and compares reported results; all
physics is C++. The full-kernel check is explicitly skipped when its ignored
fixture has not been downloaded; the committed excerpt still runs. Missing
native C++ tooling is likewise reported as a skip, never a numerical pass.
These native results supplement the SDK build and same-byte browser/V8,
native WasmEdge, and container WasmEdge tests; they do not replace them.

To regenerate independent source vectors (requires public network access):

```sh
python3 -m venv /tmp/de440-reference-venv
/tmp/de440-reference-venv/bin/pip install spiceypy==8.0.0
/tmp/de440-reference-venv/bin/python files/orbit-products/tests/fixtures/de440/generate_references.py --horizons
```

To regenerate the excerpt, explicitly remove only its existing file and run
`extract_2026.py` in that environment. The script refuses to overwrite an
existing excerpt. Review changed hashes and any new Horizons source labels;
test execution never regenerates expected values or downloads mutable data.


## HPOP force consumption

A separate focused test verifies the actual `ForceModel::ThirdBody` routine
for Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn, Uranus and Neptune at
JD 2461041.5 TDB, with a satellite at `[7000, -1200, 900]` km in ICRF/J2000.
Independent expected accelerations use the committed CSPICE geocentric
positions and Newtonian differential gravity:

`a = GM * ((R-r)/|R-r|^3 - R/|R|^3)`.

Existing documented HPOP GM constants are explicit inputs to this force-path
check; it does not assert that these legacy constants equal DE440's fitted
GM values. The maximum measured acceleration error is
**2.7745692215067836e-22 km/s²**, below the **1e-18 km/s²** absolute vector-norm
bound allowing numerical cancellation and roundoff.

The same harness enables only SRP in `ComputeTotalAcceleration`, with a
satellite 7000 km from Earth toward the Sun, geometrically outside eclipse.
Its independently calculated photon-momentum acceleration uses
`F/c * (AU/d)^2 * Cr*A/m`, directed away from the Sun, with `Cr=1.5`,
`A=10 m²`, and `m=1000 kg`. The constants are the
[IAU 2015 B3 nominal irradiance of 1361 W/m²](https://iauarchive.eso.org/static/resolutions/IAU2015_English.pdf)
and [IAU 2012 B2 astronomical unit of 149597870700 m](https://iau-a3.gitlab.io/res.html),
with exact SI `c=299792458 m/s`. Measured error is **0 km/s²** against the same
**1e-18 km/s²** bound. This confirms that the force integrator obtains its Sun
vector through the loaded kernel, in addition to the direct-state checks.

```sh
node --test propagator/hpop/tests/de440_force.test.mjs
```

```text
RESULT Sun 2.7745692215067836e-22 1e-18 PASS
RESULT Moon 3.1515065703092862e-24 1e-18 PASS
RESULT Mercury 1.8717589098414146e-28 1e-18 PASS
RESULT Venus 4.6966503963072539e-28 1e-18 PASS
RESULT Mars 2.9039174767017646e-30 1e-18 PASS
RESULT Jupiter 1.3640258749650362e-25 1e-18 PASS
RESULT Saturn 3.9453885613479032e-27 1e-18 PASS
RESULT Uranus 4.1977529063185979e-28 1e-18 PASS
RESULT Neptune 1.2470088261128012e-30 1e-18 PASS
RESULT SRP_kernel_sun 0 1e-18 PASS
PASS DE440 force cases=10 failures=0
ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ skipped 0
```
