# Consolidated reference evidence

FFM (Full Force Model) is defined in [the FFM profile](../../FFM.md).

Generated from pinned summaries by `consolidate.mjs`; checked by `node propagator/ffm/tests/evidence/check-all.mjs` from the repository root. No timestamps or host details enter this report.

FFM 1.4.1, SHA-256 `e8c7b4f59d54a1140380105d8463cd037260d4441f29afb74f396f9834ac06c3`. Numerical aggregation and unit formatting run in C++; replay physics stays in C++/WASM.

## Protocol and coverage

largest 3D position difference over the 25 hourly samples, meters, in GCRF (EME2000 for the cases whose frame is EME2000). Epochs and input models are in [the case export](cases/ffm-reference-cases.json). Counts use FFM's suite setting. Skips are explicit unsupported or unavailable cases, never passes. Row-based counts include only primary rows with a stated limit. Diagnostic and decomposition rows are shown separately and do not count as met or missed; all recorded bounds are independently checked.

| FFM setting | Maximum step (s) | Relative tolerance | Point-mass tolerance |
| --- | --- | --- | --- |
| suite | 300 | 1e-13 | 1e-15 |
| steps30 | 30 | 1e-13 | 1e-15 |
| finest | 10 | 1e-15 | 1e-15 |

| Tool group | Point mass (m) | Gravity (m) | SRP (m) | Drag (m) |
| --- | --- | --- | --- | --- |
| default | 0.001 | 0.05 | 0.1 | 0.1 |
| gmat | 0.01 | 0.05 | 0.1 | 1.5 |

The GMAT limits apply only to GMAT. These are agreement limits from the shared protocol, not orbit-accuracy guarantees.

| Tool | Version | Scored (primary) | Skipped | Met | Missed | Diagnostic | Decomposition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Orekit | 13.1 | 72 | 0 | 72 | 0 | 0 | 0 |
| GMAT R2026a | R2026a | 57 | 15 | 51 | 6 | 0 | 0 |
| GMAT R2022a | R2022a | 55 | 17 | 55 | 0 | 0 | 0 |
| Nyx | 2.6.0 | 59 | 13 | 54 | 5 | 0 | 0 |
| tudatpy | 1.0.0 | 59 | 13 | 59 | 0 | 0 | 0 |
| Tudat WASM | 1.0.0.dev4 | 27 | 45 | 27 | 0 | 0 | 0 |
| Basilisk | 2.12.0 | 50 | 22 | 43 | 7 | 0 | 0 |
| ERFA / SPICE | 2.0.1 / CSPICE_N0067 | 13 | 0 | 12 | 1 | 13 | 0 |
| JPL Horizons | 1.2 | 6 | 1 | 6 | 0 | 4 | 0 |
| Vallado SGP4-VER | python-sgp4 2.27 (Brandon Rhodes; MIT), source distribution; module 1.2.0 | 9 | 0 | 7 | 2 | 0 | 21 |
| SGP4-XP | 9.1.1.0; module 0.1.1 | 1 | 0 | 1 | 0 | 0 | 0 |

## Maximum position difference

Maxima across each tool's supported cases, at FFM's suite setting; the Orekit finest column uses its separately stated FFM setting. A dash means no scored case. The no-drag class also includes supported tides, relativity and thrust cases. Force-class case coverage varies by tool; see scored and skipped IDs in consolidated.json.

| Orbit | Force class | Orekit | GMAT R2026a | GMAT R2022a | Nyx | tudatpy | Tudat WASM | Basilisk | Orekit finest |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LEO400 | point mass | 0.479 mm | 0.322 mm | 0.316 mm | 0.305 mm | 0.325 mm | 0.319 mm | 0.315 mm | 0.152 mm |
| LEO400 | field + third bodies + SRP (no drag) | 18.875 mm | 45.162 mm | 45.141 mm | 17.729 mm | 18.148 mm | 19.926 mm | 17.671 mm | 1.317 mm |
| LEO400 | drag | 25.856 mm | 2.337 m | 1.380 m | 12.459 m | 38.864 mm | 33.484 mm | 5418.749 m | 4.077 mm |
| SSO700 | point mass | 0.481 mm | 0.292 mm | 0.304 mm | 0.297 mm | 0.302 mm | 0.295 mm | 0.292 mm | 0.178 mm |
| SSO700 | field + third bodies + SRP (no drag) | 14.595 mm | 19.487 mm | 27.789 mm | 15.879 mm | 14.367 mm | 14.224 mm | 15.880 mm | 1.355 mm |
| SSO700 | drag | 16.834 mm | 7.965 m | 164.793 mm | 45.604 mm | 13.555 mm | 65.324 mm | 58.128 m | 1.066 mm |
| GPS | point mass | 0.143 mm | 0.024 mm | 0.017 mm | 0.017 mm | 0.021 mm | 0.021 mm | 0.023 mm | 0.159 mm |
| GPS | field + third bodies + SRP (no drag) | 0.197 mm | 1.522 mm | 2.532 mm | 0.140 mm | 1.372 mm | 0.146 mm | 0.181 mm | 0.220 mm |
| GPS | drag | — | — | — | — | — | — | — | — |
| GEO | point mass | 0.035 mm | 0.001 mm | 0.001 mm | 0.002 mm | 9.906e-04 mm | 0.003 mm | 6.219e-04 mm | 0.037 mm |
| GEO | field + third bodies + SRP (no drag) | 0.067 mm | 0.151 mm | 1.330 mm | 0.154 mm | 0.148 mm | 0.141 mm | 0.148 mm | 0.065 mm |
| GEO | drag | — | — | — | — | — | — | — | — |
| MOLNIYA | point mass | 0.579 mm | 0.013 mm | 0.059 mm | 0.003 mm | 0.007 mm | 0.008 mm | 0.020 mm | 0.572 mm |
| MOLNIYA | field + third bodies + SRP (no drag) | 11.206 mm | 5.125 mm | 28.577 mm | 1.361 mm | 10.973 mm | 11.352 mm | 1.225 mm | 9.847 mm |
| MOLNIYA | drag | — | — | — | — | — | — | — | — |

For the GMAT R2026a, Nyx and Basilisk drag entries, see [the diagnostic comparison below](#drag-cases-with-the-tool-side-setting-difference-removed-diagnostic).

### Drag cases with the tool-side setting difference removed (diagnostic)

Both columns use FFM's suite setting and the same supported drag cases per tool. Each entry is the maximum hourly 3D position difference across that orbit's cases. These diagnostic comparisons do not change the primary counts.

| Tool | Orbit | Cases | Stock | Setting difference removed | Limit | Stock verdict | Diagnostic verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GMAT R2026a | LEO400 | 3 | 2.337 m | 42.207 mm | 1.500 m | not met | met |
| GMAT R2026a | SSO700 | 3 | 7.965 m | 109.950 mm | 1.500 m | not met | met |
| Nyx | LEO400 | 5 | 12.459 m | 50.162 mm | 100.000 mm | not met | met |
| Nyx | SSO700 | 3 | 45.604 mm | 15.016 mm | 100.000 mm | met | met |
| Basilisk | LEO400 | 4 | 5418.749 m | 26.509 mm | 100.000 mm | not met | met |
| Basilisk | SSO700 | 3 | 58.128 m | 15.259 mm | 100.000 mm | not met | met |

- GMAT R2026a: Cd scaled by 1 + eps from the anomalous-oxygen diagnostic. [Evidence](gmat/anomalous-oxygen.json).
- Nyx: Published NRLMSISE-00 formulas + WGS84 shape. [Evidence](nyx/drag-settings-diagnostic.json).
- Basilisk: WGS84 coordinates + native gtd7d density. [Evidence](basilisk/summary-basilisk-2.12.0.json#/diagnostics/wgs84-gtd7d).

GMAT's stored steps30 score and Nyx's stored finest score are reproduced before their corrected trajectories are re-scored against the pinned FFM suite trajectories. Basilisk's suite diagnostic is stored directly. GMAT's Cd scale uses the recorded mean anomalous-oxygen density fraction for each case.

## STM agreement

No STM pass threshold is defined by the export.

| Tool | STM maximum relative column difference | Interpretation |
| --- | --- | --- |
| Orekit | 1.78057e-05 | Relative column differences; exported protocol specifies no STM pass limit. |
| GMAT R2026a | 2.5907e-05 | 57 suite STM comparisons; largest relative column difference 0.000025907000492078618. Position and velocity rows are compared separately. No STM pass threshold is supplied by this protocol. |
| GMAT R2022a | not exposed | R2022a has no stored STM comparisons; no agreement claim is made. |
| Nyx | 135.001 | The STM comparison is not usable as an FFM check: Nyx uses the step-start ctx.stm and computes stm * grad, instead of grad * stage_stm, while the RK stages retain the same context. |
| tudatpy | 2.59073e-05 | STM and Cd*A/m, Cr*A/m, Cd*A/m-rate, and in-track-acceleration sensitivity agreement is reported as maximum relative column difference, separately for position and velocity rows. Native aerodynamic state partials use central finite differences at 10 m position and 0.01 m/s velocity perturbations, also used by the time-varying-drag adapter. The native cannonball SRP partial omits the eclipse-attenuation position gradient; its effect is conditional on encountering eclipse transitions, not every SRP case. R2 STM omissions record unavailable native non-Schwarzschild partials. Every exported sensitivity is included where its variational case is supported; the shared export defines no STM pass/fail threshold. |
| Tudat WASM | not exposed | The committed Tudat WASM fixture contains state trajectories only; its C++ driver did not save variational equations or sensitivity columns. |
| Basilisk | not exposed | Basilisk spacecraft has no variational equations for the 6x6 STM or exported parameter sensitivities; state-only cases are scored and cases explicitly requesting sensitivities are skipped. |
| ERFA / SPICE | not exposed | not exposed |
| JPL Horizons | not exposed | not exposed |
| Vallado SGP4-VER | not exposed | not exposed |
| SGP4-XP | not exposed | not exposed |

## Frame, time, ephemeris and SGP4 rows

### ERFA / SPICE

| Row | Maximum difference | Limit | Verdict / role | Cause / note |
| --- | --- | --- | --- | --- |
| TAI - UTC | maximum difference: 0 s | maximum difference: ≤ 0 s | met | Leap-second table agreement. |
| TT from UTC | maximum difference: 5.59658e-12 s | maximum difference: ≤ 1e-09 s | met | PRW whole seconds and fraction construct the two-part TT force instant. |
| TDB - TT | maximum difference: 1.34726e-05 s | not specified | diagnostic | Existing FFM two-term model evaluated in seconds. Full ERFA TDB is a different model; no model substitution. |
| TDB - TT reference spread | maximum difference: 1.3258e-05 s | not specified | diagnostic | Independent reference model spread. |
| Force ephemeris TDB instant | maximum difference: 1.34706e-05 s | not specified | diagnostic | Two-part TT plus FFM two-term TDB-TT. Remaining difference includes model spread and binary64 SPK ET representation. |
| Force GCRF -> ITRF at same instant | maximum difference: 0.000483481 mas | maximum difference: ≤ 0.021 mas | met | Hourly TT interpolation of X/Y/s; exact two-part UT1 at each force evaluation. |
| Force GCRF -> ITRF at exact epoch | maximum difference: 0.000483481 mas | maximum difference: ≤ 0.022 mas | met | No single-Julian-date force-clock rounding. |
| Force TT clock contribution | maximum difference: 4.40826e-06 mas | not specified | diagnostic | Same CIO chain, differing only by represented TT. |
| Force GCRF -> ITRF | maximum difference: 8.85737 mas | maximum difference: ≤ 5 mas | missed | reference spread |
| Independent terrestrial-frame reference spread | maximum difference: 8.85713 mas | not specified | diagnostic | Recorded reference spread, not an FFM defect. |
| Tides GMST at same instant | maximum difference: 0 mas | maximum difference: ≤ 0.001 mas | met | Two-part UT1 and TT. |
| Tides GMST at exact epoch | maximum difference: 4.3968e-06 mas | not specified | diagnostic | Two-part UT1 and TT. |
| No-EOP fallback versus CIO | maximum difference: 533.295 mas | not specified | diagnostic | Legacy UT1=UTC, zero polar motion, no frame bias, IAU 1976/1980.. |
| Classical GCRF/J2000 -> MOD | maximum difference: 0 mas | maximum difference: ≤ 0.001 mas | met | ERFA is the sole implementation. |
| Classical MOD -> TOD | maximum difference: 0 mas | maximum difference: ≤ 1e-07 mas | met | ERFA is the sole implementation; full IAU 1980 series. |
| Classical GCRF/J2000 -> TEME | maximum difference: 2.0002e-10 mas | maximum difference: ≤ 1e-07 mas | met | FK5 TEME definition. |
| No-EOP fallback classical chain | maximum difference: 2.86251e-08 mas | maximum difference: ≤ 1e-07 mas | met | Reevaluated at every call, exact two-part dates, no hourly N*P cache. |
| SGP4 GCRF -> TEME | maximum difference: 1.97811e-07 mas | maximum difference: ≤ 0.001 mas | met | Separate foundation/frames IAU 2006/2000A TEME definition. |
| SGP4 versus FK5 TEME definitions | maximum difference: 77.6555 mas | not specified | diagnostic | Definition spread. |
| Sun relative to Earth at force TDB | maximum difference: 0 mm | maximum difference: ≤ 1.000 mm | met | Native FFM force API kernel read; km/km/s converted in C++ to meters. |
| Sun relative to Earth at ERFA TDB | maximum difference: 395.263 mm | not specified | diagnostic | Remaining two-term TDB model spread. |
| Moon relative to Earth at force TDB | maximum difference: 0 mm | maximum difference: ≤ 1.000 mm | met | Native FFM force API kernel read. |
| Moon relative to Earth at ERFA TDB | maximum difference: 14.053 mm | not specified | diagnostic | Remaining two-term TDB model spread. |
| Public coords UTC-JD ECEF versus CIO | maximum difference: 533.295 mas | not specified | diagnostic | Remaining legacy budget: UT1-UTC, polar motion, frame bias and 1976/1980 versus 2006/2000A. |
| Public coords UTC-JD ECEF versus SPICE | maximum difference: 525.313 mas | not specified | diagnostic | Legacy coords choices plus independent BPC reference spread. |
| Neglected full-matrix derivative at GEO | maximum difference: 0.000890341 m/s | not specified | diagnostic | 10,000 epochs, all frame pairs/directions. Precession/nutation/equinox rates omitted by the documented Earth-rotation-only velocity contract. Includes central-difference rounding. |

### JPL Horizons

| Row | Maximum difference | Limit | Verdict / role | Cause / note |
| --- | --- | --- | --- | --- |
| sun: shipped FFM WASM / DE440 | position: 1.529 m; velocity: 0.00025158 mm/s | position: < 10.000 m; velocity: < 0.1 mm/s | met |  |
| sun: sub-meter diagnostic | position: 1.529 m | position: < 1.000 m | diagnostic | ephemeris-release-and-clock: DE440 minus Horizons DE441, matching target 10 and Earth center 399, with FFM versus CSPICE UTC-to-TDB and single-JD rounding where applicable. SPICE removes the FFM clock/reader; its JD-parser control measures time-representation sensitivity. The remaining Horizons/CSPICE time-realization and ephemeris-coefficient contributions cannot be isolated without a local DE441 kernel. |
| moon: shipped FFM WASM / DE440 | position: 2.417 m; velocity: 0.00669293 mm/s | position: < 10.000 m; velocity: < 0.1 mm/s | met |  |
| moon: sub-meter diagnostic | position: 2.417 m | position: < 1.000 m | diagnostic | ephemeris-release-and-clock: DE440 minus Horizons DE441, matching target 301 and Earth center 399, with FFM versus CSPICE UTC-to-TDB and single-JD rounding where applicable. SPICE removes the FFM clock/reader; its JD-parser control measures time-representation sensitivity. The remaining Horizons/CSPICE time-realization and ephemeris-coefficient contributions cannot be isolated without a local DE441 kernel. |
| venus: SpiceyPy / CSPICE / DE440 | position: 1.358 m; velocity: 0.000439891 mm/s | position: < 10.000 m; velocity: < 0.1 mm/s | met |  |
| venus: sub-meter diagnostic | position: 1.358 m | position: < 1.000 m | diagnostic | ephemeris-release-and-clock: DE440 minus Horizons DE441, matching target 299 and Earth center 399, with FFM versus CSPICE UTC-to-TDB and single-JD rounding where applicable. SPICE removes the FFM clock/reader; its JD-parser control measures time-representation sensitivity. The remaining Horizons/CSPICE time-realization and ephemeris-coefficient contributions cannot be isolated without a local DE441 kernel. |
| jupiter: SpiceyPy / CSPICE / DE440 | position: 1.280 m; velocity: 0.0001734 mm/s | position: < 10.000 m; velocity: < 0.1 mm/s | met |  |
| jupiter: sub-meter diagnostic | position: 1.280 m | position: < 1.000 m | diagnostic | ephemeris-release-and-clock: DE440 minus Horizons DE441, matching target 5 and Earth center 399, with FFM versus CSPICE UTC-to-TDB and single-JD rounding where applicable. SPICE removes the FFM clock/reader; its JD-parser control measures time-representation sensitivity. The remaining Horizons/CSPICE time-realization and ephemeris-coefficient contributions cannot be isolated without a local DE441 kernel. |
| JWST withSrp | position: 450.958 m | position: < 10000.000 m | met |  |
| JWST noSrp | position: 766.706 m | position: < 10000.000 m | met |  |

### Vallado SGP4-VER

Source and module use fixed 3D limits of 1.000 mm and 1e-05 m/s. The identical pinned Vallado algorithm, WGS-72 constants and improved operation mode isolate native floating-point evaluation against the printed states. Fixed 1 mm and 10 micrometres/s agreement limits assess that evaluation; the 5 micrometre position component printing envelope is a separate diagnostic. The same fixed agreement limits apply to shipped WASM against native improved-mode Vallado at the same effective minutes since epoch. The elements, build, emccFast and emccStrict controlled subtractions isolate initialization and compiler arithmetic; their observed spread does not raise the limit. No printed reference rows exist at these perturbed times. The recorded compiler decompositions have position maxima 4.116 mm (emccFast) and 0.037 mm (emccStrict); these measurements do not enlarge the fixed limit.

Printing resolution remains a diagnostic: 5e-09 km / 5e-10 km/s per component, giving Euclidean 3D envelopes 0.009 mm and 8.66025e-07 m/s. The request-epoch criterion is evaluated on every paired sample, not on table maxima. The per-sample bound has no acceptance epsilon. The exact vector identity is W-P=module+timeOnly+source, so the two-subtraction bound with printing alone is conditional on native-source-versus-print agreement within the printing envelope. Exceedances retain the measured source residual as their cause; the allowance is not enlarged. The maximum absolute request-time shift is 19.3701 us.

| Table | Comparison | Maximum 3D position difference | Maximum 3D velocity difference | Primary criterion | Verdict | Printing diagnostic | Cause / interpretation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| near-Earth (SGP4) | source: native Vallado vs printed | 0.007 mm | 7.77585e-07 m/s | position ≤ 1.000 mm; velocity ≤ 1e-05 m/s | met | component maxima 5.02723e-09 km; 4.98346e-10 km/s; 1/158 samples exceed the printing envelope | The native build of the same Vallado SGP4.cpp exceeds the decimal output's rounding envelope, including the long-propagation 20413 block. The pinned upstream source is identical after CR removal; this residual is isolated to native floating-point evaluation versus the published printed values, not the WASM adapter. Maximum on set 28872, tsince 40 min. |
| near-Earth (SGP4) | module: shipped WASM vs native Vallado at effective minutes since epoch | 4.087e-04 mm | 4.2584e-10 m/s | position ≤ 1.000 mm; velocity ≤ 1e-05 m/s | met | component maxima 3.99041e-10 km; 3.98348e-13 km/s; 0/158 samples exceed the printing envelope | The stored module subtraction compares shipped WASM with native Vallado at the same effective minutes since epoch; there is no tcppver.out row at the shifted time. OMM/epoch conversion and shipped build arithmetic are isolated by elements and build. The fixed 1 mm / 1e-5 m/s criterion is not enlarged for the emccFast versus emccStrict compiler-arithmetic spread; any exceedance retains this measured cause. Maximum on set 28057, tsince 2880 min. |
| near-Earth (SGP4) | wasm: shipped propagate_state vs printed at request epoch | 151.767 mm | 0.00018246 m/s | Each sample: ‖wasm‖ ≤ ‖timeOnly‖ + ‖module‖ + 3D printing envelope, for position and velocity | met; 0/158 samples exceed; maximum excess 0 mm, 0 m/s | component maxima 0.000139242 km; 1.72467e-07 km/s; 106/158 samples exceed the printing envelope | The request-epoch difference is module + timeOnly + source as vectors. The requested norm inequality uses only the module and timeOnly norms plus the 3D printing envelope. It can miss when the native-source-versus-printed residual exceeds that envelope, as measured in source; printing alone is not a bound on native evaluation error. Request-time rounding accounts for the large absolute differences. The literal inequality is reported without enlarging its allowance or substituting a sum of table maxima. Maximum on set 22312, tsince 394.2028672 min. The time-only maximum is 151.764 mm at set 22312, tsince 394.2028672 min. |
| deep space (SDP4) | source: native Vallado vs printed | 0.118 mm | 8.52869e-07 m/s | position ≤ 1.000 mm; velocity ≤ 1e-05 m/s | met | component maxima 1.16545e-07 km; 4.99695e-10 km/s; 28/508 samples exceed the printing envelope | The native build of the same Vallado SGP4.cpp exceeds the decimal output's rounding envelope, including the long-propagation 20413 block. The pinned upstream source is identical after CR removal; this residual is isolated to native floating-point evaluation versus the published printed values, not the WASM adapter. Maximum on set 20413, tsince 1844335 min. |
| deep space (SDP4) | module: shipped WASM vs native Vallado at effective minutes since epoch | 0.113 mm | 7.20088e-08 m/s | position ≤ 1.000 mm; velocity ≤ 1e-05 m/s | met | component maxima 1.11355e-07 km; 6.74163e-11 km/s; 63/508 samples exceed the printing envelope | The stored module subtraction compares shipped WASM with native Vallado at the same effective minutes since epoch; there is no tcppver.out row at the shifted time. OMM/epoch conversion and shipped build arithmetic are isolated by elements and build. The fixed 1 mm / 1e-5 m/s criterion is not enlarged for the emccFast versus emccStrict compiler-arithmetic spread; any exceedance retains this measured cause. Maximum on set 26900, tsince 9400 min. |
| deep space (SDP4) | wasm: shipped propagate_state vs printed at request epoch | 9.742 m | 0.000148972 m/s | Each sample: ‖wasm‖ ≤ ‖timeOnly‖ + ‖module‖ + 3D printing envelope, for position and velocity | missed; 17/508 samples exceed; maximum excess 0.109 mm, 0 m/s | component maxima 0.00864842 km; 1.21384e-07 km/s; 393/508 samples exceed the printing envelope | The request-epoch difference is module + timeOnly + source as vectors. The requested norm inequality uses only the module and timeOnly norms plus the 3D printing envelope. It can miss when the native-source-versus-printed residual exceeds that envelope, as measured in source; printing alone is not a bound on native evaluation error. Request-time rounding accounts for the large absolute differences. The literal inequality is reported without enlarging its allowance or substituting a sum of table maxima. Maximum on set 33333, tsince 20 min. The time-only maximum is 9.742 m at set 33333, tsince 20 min. Largest criterion excess: set 20413, tsince 1844335 min, with native-source-versus-print residual 0.118 mm. |
| all | source: native Vallado vs printed | 0.118 mm | 8.52869e-07 m/s | position ≤ 1.000 mm; velocity ≤ 1e-05 m/s | met | component maxima 1.16545e-07 km; 4.99695e-10 km/s; 29/666 samples exceed the printing envelope | The native build of the same Vallado SGP4.cpp exceeds the decimal output's rounding envelope, including the long-propagation 20413 block. The pinned upstream source is identical after CR removal; this residual is isolated to native floating-point evaluation versus the published printed values, not the WASM adapter. Maximum on set 20413, tsince 1844335 min. |
| all | module: shipped WASM vs native Vallado at effective minutes since epoch | 0.113 mm | 7.20088e-08 m/s | position ≤ 1.000 mm; velocity ≤ 1e-05 m/s | met | component maxima 1.11355e-07 km; 6.74163e-11 km/s; 63/666 samples exceed the printing envelope | The stored module subtraction compares shipped WASM with native Vallado at the same effective minutes since epoch; there is no tcppver.out row at the shifted time. OMM/epoch conversion and shipped build arithmetic are isolated by elements and build. The fixed 1 mm / 1e-5 m/s criterion is not enlarged for the emccFast versus emccStrict compiler-arithmetic spread; any exceedance retains this measured cause. Maximum on set 26900, tsince 9400 min. |
| all | wasm: shipped propagate_state vs printed at request epoch | 9.742 m | 0.00018246 m/s | Each sample: ‖wasm‖ ≤ ‖timeOnly‖ + ‖module‖ + 3D printing envelope, for position and velocity | missed; 17/666 samples exceed; maximum excess 0.109 mm, 0 m/s | component maxima 0.00864842 km; 1.72467e-07 km/s; 499/666 samples exceed the printing envelope | The request-epoch difference is module + timeOnly + source as vectors. The requested norm inequality uses only the module and timeOnly norms plus the 3D printing envelope. It can miss when the native-source-versus-printed residual exceeds that envelope, as measured in source; printing alone is not a bound on native evaluation error. Request-time rounding accounts for the large absolute differences. The literal inequality is reported without enlarging its allowance or substituting a sum of table maxima. Maximum on set 33333, tsince 20 min. The time-only maximum is 9.742 m at set 33333, tsince 20 min. Largest criterion excess: set 20413, tsince 1844335 min, with native-source-versus-print residual 0.118 mm. |

Controlled subtractions explain the primary differences. The rows below remain decomposition rows and do not contribute to met/missed counts.

| Table | Subtraction | Maximum 3D position difference | Maximum 3D velocity difference | Printing diagnostic (samples beyond envelope) | Role | Cause |
| --- | --- | --- | --- | --- | --- | --- |
| near-Earth (SGP4) | afspc | 0.007 mm | 7.77585e-07 m/s | 1/158 | decomposition | operation-mode-convention: AFSPC mode a is intentionally different from the printed improved-mode i reference; the source comparison separately measures the native-versus-print residual. |
| near-Earth (SGP4) | fastMath | 4.085e-04 mm | 4.28628e-10 m/s | 0/158 | decomposition | compiler-floating-point-flags: The same native Vallado path and times are subtracted with and without -ffast-math, isolating the compiler arithmetic setting. |
| near-Earth (SGP4) | emccFast | 4.087e-04 mm | 4.2584e-10 m/s | 0/158 | decomposition | wasm-compiler-arithmetic: The same Vallado path is compiled to WASM with fast-math and compared with the strict native evaluation; emccStrict separately isolates the result without fast-math. |
| near-Earth (SGP4) | emccStrict | 5.323e-06 mm | 4.21446e-12 m/s | 0/158 | decomposition | native-versus-wasm-floating-point: The strict WASM and native builds evaluate the same source, elements and times. Their subtraction isolates cross-target floating-point evaluation, including accumulated error in the long 20413 arc. |
| near-Earth (SGP4) | elements | 4.099e-04 mm | 4.38873e-10 m/s | 0/158 | decomposition | element-and-epoch-representation: The module OMM initialization path is compared with Vallado TLE initialization at the identical effective tsince, isolating element conversion and the single-double Julian-date epoch representation. |
| near-Earth (SGP4) | build | 8.132e-04 mm | 8.4944e-10 m/s | 0/158 | decomposition | shipped-build-floating-point: The shipped WASM and native module path use the identical OMM initialization and request, isolating the shipped build's arithmetic. |
| near-Earth (SGP4) | timeOnly | 151.764 mm | 0.000183048 m/s | 106/158 | decomposition | single-double-request-epoch: Vallado is evaluated at both the intended tsince and the tsince recovered from a single-double Julian-date request; only request-time rounding differs. |
| deep space (SDP4) | afspc | 963.987 m | 0.389232 m/s | 45/508 | decomposition | operation-mode-convention: AFSPC mode a is intentionally different from the printed improved-mode i reference; the source comparison separately measures the native-versus-print residual. |
| deep space (SDP4) | fastMath | 4.073 mm | 1.79785e-06 m/s | 185/508 | decomposition | compiler-floating-point-flags: The same native Vallado path and times are subtracted with and without -ffast-math, isolating the compiler arithmetic setting. |
| deep space (SDP4) | emccFast | 4.116 mm | 1.81707e-06 m/s | 185/508 | decomposition | wasm-compiler-arithmetic: The same Vallado path is compiled to WASM with fast-math and compared with the strict native evaluation; emccStrict separately isolates the result without fast-math. |
| deep space (SDP4) | emccStrict | 0.037 mm | 1.21119e-09 m/s | 2/508 | decomposition | native-versus-wasm-floating-point: The strict WASM and native builds evaluate the same source, elements and times. Their subtraction isolates cross-target floating-point evaluation, including accumulated error in the long 20413 arc. |
| deep space (SDP4) | elements | 2.257e-04 mm | 9.58107e-11 m/s | 0/508 | decomposition | element-and-epoch-representation: The module OMM initialization path is compared with Vallado TLE initialization at the identical effective tsince, isolating element conversion and the single-double Julian-date epoch representation. |
| deep space (SDP4) | build | 0.113 mm | 7.20088e-08 m/s | 63/508 | decomposition | shipped-build-floating-point: The shipped WASM and native module path use the identical OMM initialization and request, isolating the shipped build's arithmetic. |
| deep space (SDP4) | timeOnly | 9.742 m | 0.000149275 m/s | 361/508 | decomposition | single-double-request-epoch: Vallado is evaluated at both the intended tsince and the tsince recovered from a single-double Julian-date request; only request-time rounding differs. |
| all | afspc | 963.987 m | 0.389232 m/s | 46/666 | decomposition | operation-mode-convention: AFSPC mode a is intentionally different from the printed improved-mode i reference; the source comparison separately measures the native-versus-print residual. |
| all | fastMath | 4.073 mm | 1.79785e-06 m/s | 185/666 | decomposition | compiler-floating-point-flags: The same native Vallado path and times are subtracted with and without -ffast-math, isolating the compiler arithmetic setting. |
| all | emccFast | 4.116 mm | 1.81707e-06 m/s | 185/666 | decomposition | wasm-compiler-arithmetic: The same Vallado path is compiled to WASM with fast-math and compared with the strict native evaluation; emccStrict separately isolates the result without fast-math. |
| all | emccStrict | 0.037 mm | 1.21119e-09 m/s | 2/666 | decomposition | native-versus-wasm-floating-point: The strict WASM and native builds evaluate the same source, elements and times. Their subtraction isolates cross-target floating-point evaluation, including accumulated error in the long 20413 arc. |
| all | elements | 4.099e-04 mm | 4.38873e-10 m/s | 0/666 | decomposition | element-and-epoch-representation: The module OMM initialization path is compared with Vallado TLE initialization at the identical effective tsince, isolating element conversion and the single-double Julian-date epoch representation. |
| all | build | 0.113 mm | 7.20088e-08 m/s | 63/666 | decomposition | shipped-build-floating-point: The shipped WASM and native module path use the identical OMM initialization and request, isolating the shipped build's arithmetic. |
| all | timeOnly | 9.742 m | 0.000183048 m/s | 467/666 | decomposition | single-double-request-epoch: Vallado is evaluated at both the intended tsince and the tsince recovered from a single-double Julian-date request; only request-time rounding differs. |

### SGP4-XP

| Row | Maximum difference | Limit | Verdict / role | Cause / note |
| --- | --- | --- | --- | --- |
| Exact library parity | failed parity tests: 0 tests | failed parity tests: ≤ 0 tests | met |  |

## Findings

Classical-frame source defects remaining: 0. ERFA is the authoritative IAU 1976/1980 implementation. Before/after measurements and the velocity-axis diagnostic are in [before-after.json](erfa-spice/before-after.json).

| Classical ECEF versus CIO | Position bound |
| --- | --- |
| LEO | 17.525 m |
| GPS | 68.671 m |
| GEO | 109.015 m |

The remaining classical ECEF budget is UT1 = UTC, zero polar motion, no frame bias and the 1976/1980 model. These values are radius-times-angle bounds over the 50 sample epochs. Reference-suite field/drag cases supply EOP and use the CIO force-model chain.

The force TDB model spread is 1.34706e-05 s; the exact-epoch Earth-rotation difference is 0.000483481 mas, or 0.016 mm at LEO radius. Two-part TT plus FFM two-term TDB-TT. Remaining difference includes model spread and binary64 SPK ET representation. Evidence: [ERFA/SPICE summary](erfa-spice/summary-erfa-spice.json).

- **Nyx NRLMSISE-00 port:** With the published NRLMSISE-00 formulas and the WGS84 Earth shape, the five missed cases are about 0.05 m from FFM, all below the unchanged 0.1 m limit. The exact corrected residuals are recorded per case. The port defect and the cached runner Earth-shape mismatch are separated in the per-case diagnostics; they do not indicate an FFM defect. Evidence: [nyx/summary-nyx-2.6.0.json](nyx/summary-nyx-2.6.0.json).
- **Nyx variational equation:** The STM comparison is not usable as an FFM check: Nyx uses the step-start ctx.stm and computes stm * grad, instead of grad * stage_stm, while the RK stages retain the same context. Evidence: [nyx/summary-nyx-2.6.0.json](nyx/summary-nyx-2.6.0.json).
- **GMAT anomalous oxygen:** GMAT gtd7 excludes anomalous oxygen; FFM and Orekit use gtd7d drag-effective density. The day-mean density ratio times the independently stored drag effect accounts for the meter-scale gap. A constant Cd multiplier is an approximation to the varying density ratio: the corrected trajectory is the measured residual, not a claim of exact model identity. Evidence: [gmat/anomalous-oxygen.json](gmat/anomalous-oxygen.json).
- **Basilisk atmosphere altitude and conventions:** Basilisk MsisAtmosphere uses spherical altitude and geocentric latitude, and below 500 km selects gtd7 without anomalous oxygen. The export/FFM use WGS84 geodetic coordinates and gtd7d density. Changing only atmosphere coordinates removes the kilometer-scale discrepancy; additionally supplying the installed wheel's native gtd7d density removes the meter-scale residual and passes every unchanged FFM tolerance. This is a measured native model-setting limitation, not evidence of an FFM defect. Evidence: [basilisk/summary-basilisk-2.12.0.json](basilisk/summary-basilisk-2.12.0.json).

## Pins and model settings

Checksums identify recorded bytes. A source-recipe pin is labelled as such and does not assert availability of an engine archive.

### Orekit

Version: 13.1. Evidence: [orekit/summary.json](orekit/summary.json).

- Orekit reference-generator source (engine archive unavailable): `06c0c6e0e55241171e572ab43b2ee6223a9887f3b72aca1a3f1f1d14ed92008d`.

Model settings:

- configuration: Orekit 13.1 (CS GROUP, Apache-2.0), DormandPrince853 (steps <= 10 s), GCRF; NRLMSISE-00 on mean local solar time.

Step setting: FFM suite / steps30 / finest as defined above; reference integrator settings as listed.

Provenance limit:

- availability · status: unavailable.
- availability · reason: The original Orekit 13.1 jar is not retained locally; the stored trajectory and generation source are pinned. Installed 13.1.2 and 13.1.6 jars are not substituted.

### GMAT R2026a

Version: R2026a. Evidence: [gmat/summary-gmat-R2026a.json](gmat/summary-gmat-R2026a.json).

- GmatConsole: `1162803de3ed7172bce882b201b00e58de5b604c76a2ba02d16ac6765e7552e2`.
- libGmatBase: `e55086ed22bac9529298482ddc6dfbb703cb457d06d7883ff3d2f65df8ddab26`.

Model settings:

- integrator: RungeKutta89.
- accuracy: 1e-14.
- max Step S: 30.
- error Control: RSSStep.
- atmosphere: NRLMSISE00.
- stm: false.
- solid Tide Model: SolidStep2.
- cssi Rows: constant.
- eop Offsets: zero dPsi, dEps.
- earth Orientation: GMAT IAU 1976/1980 (FK5) with the case export pole and UT1-UTC rows; NutationUpdateInterval 0.
- axes: initial state in EarthICRF; samples from EarthMJ2000Eq (integration axes) by the epoch's fixed rotation to GCRF; EME2000 cases through the IERS 2003 frame bias.
- ephemeris: SPICE, the case export DE440 kernel, TDB.

Step setting: FFM suite / steps30 / finest as defined above; reference integrator settings as listed.

### GMAT R2022a

Version: R2022a. Evidence: [gmat/summary-gmat-R2022a.json](gmat/summary-gmat-R2022a.json).

- GmatConsole: `c8a214cf761d7d074c20bee17586a16ac9c9dca9475018e8a0866116377ab655`.
- libGmatBase: `25ad1998de28ac0ac5676341b6ea8642ae7fc6fc23fee8b8b7e077392fbe6f98`.

Model settings:

- integrator: RungeKutta89.
- accuracy: 1e-14.
- max Step S: 30.
- error Control: RSSStep.
- atmosphere: JacchiaRoberts.
- stm: false.
- solid Tide Model: SolidStep2.
- cssi Rows: constant.
- eop Offsets: zero dPsi, dEps.
- earth Orientation: GMAT IAU 1976/1980 (FK5) with the case export pole and UT1-UTC rows; NutationUpdateInterval 0.
- axes: initial state in EarthICRF; samples from EarthMJ2000Eq (integration axes) by the epoch's fixed rotation to GCRF; EME2000 cases through the IERS 2003 frame bias.
- ephemeris: SPICE, the case export DE440 kernel, TDB.

Step setting: FFM suite / steps30 / finest as defined above; reference integrator settings as listed.

### Nyx

Version: 2.6.0. Evidence: [nyx/summary-nyx-2.6.0.json](nyx/summary-nyx-2.6.0.json).

- nyx-space crate: `9e84a00fd0df9ef631f2272f52b59caa0915e77851bcf366749d8cb0594ec86f`.
- Cargo.lock: `47d0d9bb89893f354b4cd718ca3cad39f49f1cdf1a5793d57f3734e3b78f21ea`.

Model settings:

- integrator: RK8(9) (Nyx Propagator::rk89).
- tolerance: 1e-13.
- max Step S: 30.
- min Step S: 0.001.
- error Control: RSSCartesianStep.
- stm: false.
- atmosphere: NRLMSISE-00 (Nyx, mean local solar time, daily Ap, anomalous oxygen included).
- earth Orientation: ITRF93 from ffm-itrf-2026-08.bpc.
- axes: SPICE J2000 (ICRF) about the Earth; EME2000 cases through the IERS 2003 frame bias.
- ephemeris: the case export DE440 kernel through ANISE, at hifitime ET.
- constants · moon Gm Km3S2: 4902.8002332671.
- constants · sun Gm Km3S2: 132712440041.27942.
- constants · sun Radius Km: 695700.

Step setting: FFM suite / steps30 / finest as defined above; reference integrator settings as listed.

### tudatpy

Version: 1.0.0. Evidence: [tudat/summary-tudatpy-1.0.0.json](tudat/summary-tudatpy-1.0.0.json).

- installed kernel.so: `18196bbc8fc5aaf77e2b990012bae60325ca15ad6062048c0bed23e874faf672`.

Model settings:

- integrator: RKDP 8(7), fixed step.
- step S: 10.
- srp Step S: 1.
- orientation Interpolation S: 60.
- fine Orientation Interpolation S: 30.
- fine Step S: 5.
- fine Srp Step S: 0.5.
- clock: TT; SPICE ephemerides tabulated at corresponding TDB.
- frame: GCRS (GCRF), EME2000 output through IERS frame bias.
- earth Orientation: native IERS2010 with private C04 EOP file; default subdaily corrections; explicit native TT input clock.
- shadow: separate spherical EarthOccultor, radius 6378137 m; WGS84 Earth for drag.
- atmosphere: native NRLMSISE-00, daily Ap, anomalous oxygen, mean local solar time; private constant/CSSI files.
- stm: native variational equations; 6x6 orbit block, Cr/Cd per-unit coefficient*area/mass, and exported C1 ballistic-rate/in-track columns. Custom ballistic parameter partials are exact C++ a/b and elapsed*a/b. R2 partials unavailable in native Tudat.

Step setting: FFM suite / steps30 / finest as defined above; reference integrator settings as listed.

### Tudat WASM

Version: 1.0.0.dev4. Evidence: [tudat/summary-tudat-wasm.json](tudat/summary-tudat-wasm.json).

- reference C++ driver source: `e2cb73555096b9de7cbd24a117e523ad8c1e05c9003707910505eb8db5488620`.
- Tudat package source revision: `1d4718f`.

Model settings:

- integrator: RKDP 8(7).
- fixed Step S: 10.
- radiation Pressure Fixed Step S: 1.
- clock: TT.
- frame: GCRS about Earth.
- source: Tudat 1.0.0.dev4 as built by repos/ancillary-packages/tudat-wasm (Emscripten 3.1.51, its vendored Tudat sources), driven by tudat_wasm_driver.cpp under Node; same setup as tudatpy-reference.json (RKDP 8(7) fixed steps, 10 s or 1 s with radiation pressure, TT clock, Lagrange-8 to the samples, GCRS about the Earth, IERS 2010 Earth orientation with the rows of ../orekit/eop-2026-08.json, DE440 tabulated in GCRS, NRLMSISE-00 constant space weather).
- covered Case Ids: 27 cases (IDs retained in consolidated.json).
- convergence: Historical 27-case fixture; the existing cross-validation document records step-halving evidence. This task scores committed samples without rebuilding Tudat WASM.
- coverage · requested Count: 28.
- coverage · actual Count: 27.
- coverage · note: The task context calls this a 28-case subset, but the committed Tudat WASM fixture contains 27 cases. Only those stored trajectories are scored; no missing trajectory is inferred.

Step setting: FFM suite / steps30 / finest as defined above; reference integrator settings as listed.

Provenance limit:

- availability: Committed C++ driver trajectory; the package Embind API cannot configure/run propagation (duplicate registrations, station-file initialization, missing STL/Eigen bindings). No Tudat rebuild or rerun was performed.

### Basilisk

Version: 2.12.0. Evidence: [basilisk/summary-basilisk-2.12.0.json](basilisk/summary-basilisk-2.12.0.json).

- Basilisk spacecraft binary: `523c000e9be8966f6a7bc64827a8415bba6aee27543967ceb45cd44412cff9f0`.
- Basilisk source revision: `611665f742999951453d4e128c8540c761de8a4f`.

Model settings:

- integrator: native Basilisk RKF78.
- maximum Step S: 8.
- convergence Limit M: 0.0003.
- variant: nominal.
- threads: 1.
- earth Orientation: Exported EOP, pinned ERFA IAU 2006/2000A CIO GCRF-to-ITRF; orthogonal midpoint rotation held over each step, refined with the integration step.
- ephemeris: SpiceInterface with the exported DE440; geometric Earth-centered J2000 (ICRF) states.
- stm: Unavailable: Basilisk spacecraft has no variational equations.

Step setting: FFM suite / steps30 / finest as defined above; reference integrator settings as listed.

### ERFA / SPICE

Version: 2.0.1 / CSPICE_N0067. Evidence: [erfa-spice/summary-erfa-spice.json](erfa-spice/summary-erfa-spice.json).

- pyerfa-2.0.1.5-cp39-abi3-macosx_11_0_arm64.whl: `be1aeb70390dd03a34faf96749d5cabc58437410b4aab7213c512323932427df`.
- spiceypy-8.3.0-cp314-cp314-macosx_11_0_arm64.whl: `94530fe4927ef4d06d7eb4c4ba2036a448313f5b806c65aa7a3943d55e535d31`.

Model settings:

- epochs: 50.
- frame: IAU 2006/2000A CIO and classical chains; shared EOP; SPICE ITRF93; same-date and UTC-date comparisons.
- ephemeris: DE440.
- time: UTC, TT, UT1, TDB as labelled per row.

Step setting: stored epochs; no integration

### JPL Horizons

Version: 1.2. Evidence: [horizons/summary-horizons.json](horizons/summary-horizons.json).

- Horizons sun response: `ea17c2e867544d61a20040e8087537de378c5077836fd16217e4d70e6422721c`.
- Horizons moon response: `dba05030349de06eda074be84d168aebc86070e8a9beb7dd8e2a75fa30e70941`.
- Horizons venus response: `ce0740066200ede197a5c2a498f3e4f8fcaf4ded9469302296b67d6c81d00329`.
- Horizons jupiter response: `2dc1e366567d1a7e53fb9e2d66b90271e087f4e7f635765f0e823fb8a12b4745`.
- Horizons jwst response: `6723faa3fc86dd71100f34a37f120ef2ec57557bae0cfbf68c9caca5c3445693`.
- spiceypy-8.3.0-cp314-cp314-macosx_11_0_arm64.whl: `94530fe4927ef4d06d7eb4c4ba2036a448313f5b806c65aa7a3943d55e535d31`.

Model settings:

- reference: DE441 geometric ICRF, Earth center 399; identical target IDs.
- evaluators: FFM Sun/Moon; CSPICE DE440 Venus/Jupiter barycenter.
- jwst · area M2: 300.191914.
- jwst · constant Acceleration24h Displacement Km: 1.2798728023461936.
- jwst · cr: 1.56.
- jwst · earth Gm Km3S2: 398600.4415.
- jwst · mass Kg: 6200.
- jwst · one Au Acceleration MS2: 3.429014495311947e-7.
- jwst · ten Km Equivalent Constant Acceleration MS2: 0.0000026791838134430725.

Step setting: stored raw UTC epochs; JWST stored FFM runs

Provenance limit:

- availability: Remote Horizons engine binary is not distributed; API version and exact response bytes are pinned.

### Vallado SGP4-VER

Version: python-sgp4 2.27 (Brandon Rhodes; MIT), source distribution; module 1.2.0. Evidence: [../../../sgp4/tests/evidence/vallado/summary-vallado.json](../../../sgp4/tests/evidence/vallado/summary-vallado.json).

- python-sgp4 source distribution: `06d37247c6985739b707b8b39b6b83e06e8af783b2531e31965501ba983985f9`.
- SGP4.cpp source: `3388a777d710a169f780dfec83ea42f8e51d2c2652b7efe8a3187a3da0a0191d`.
- shipped WASM: `fe14bc65d1bd8a2827f5e26720af2743ca5132a8b180025a65ed7105b000f347`.
- SGP4-VER.TLE: `d246d1d9d768ace445a38a965713fa9ba52d80fd8a41a0502ff83d7acffe2881`.
- tcppver.out: `687bf28dbe52df86e8e60ab5cb4a08d1aa3dbcaf4e63b1f7ab95f044fbe3833b`.

Model settings:

- frame: TEME.
- gravity: WGS72.
- operations: improved (i); AFSPC (a) separately.
- compiler · compiler: Apple clang version 21.0.0 (clang-2100.1.1.101).
- compiler · flags: -std=c++17 -O2 -ffp-contract=off -w.
- compiler · fast Math Flags: -std=c++17 -O3 -ffast-math -w.
- compiler · emcc: emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 4.0.23-git.
- compiler · emcc Flags · emcc Fast: -O3 -flto -ffast-math -msimd128.
- compiler · emcc Flags · emcc Strict: -O3 -flto -msimd128.
- compiler · harness Sha256: 31b85b3d1b2ab6e93e686372b46bc6efb14a6bffe0ce31c22480acf83e863f90.

Step setting: every printed tcppver time; intended and single-JD times separated

### SGP4-XP

Version: 9.1.1.0; module 0.1.1. Evidence: [../../../sgp4/tests/evidence/xp/summary-xp.json](../../../sgp4/tests/evidence/xp/summary-xp.json).

- dist/isomorphic/module.wasm: `f61b15c4fd658817e3e43c7818da18c4d08d453ad28e9d704b0cd11b616b7deb`.
- third_party/ussf-sgp4/Sgp4Prop.xp.wasm: `9f061110f12ac85a76ad80dc76cdb8a33ddad64e54d8dab3b6778602e16cbeb7`.

Model settings:

- comparison: exact (same doubles).
- statement: The module returns the Space Force library's states exactly on 640 SGP4 and SGP4-XP sets at seven times each. The XP theory itself has no public reference outside the library; agreement with the library is the available check.
- anchors · cases: 15.
- anchors · tolerance Policy: fail <=> |observed - expected| > abs + rel * |expected|.
- anchors · band Position M: 0.5.
- anchors · band Velocity MS: 0.0005.
- anchors · source: sgp4-xp/vectors/PROVENANCE.md.

Step setting: 640 sets × 7 times

### GMAT R2026a drag diagnostic inputs

- FFM trajectories at suite / steps30 / finest: `e7a9c467fa412550e772460e16a6bb17d666658f61ad6f448c9b09f4dae388cc`.
- Anomalous-oxygen diagnostic: `9de65208a7ff47474707f50f3b168486f4d890c704ba6022cd2253691dc3fb63`.
- LEO400_F6-field-sun-moon-srp-drag.txt: `aab0dd100945207768a85fca4e3e66bc6b0f2a31361c3555114633a63d7ffa78`.
- LEO400_F6-field-sun-moon-srp-drag.script: `a5c9e8575312ae7c875ea93a7d4e17e0966dbcb289ded124a94d143a0dd35813`.
- LEO400_Z3-zonal20-sun-moon-srp-drag.txt: `a216e50024130da8cffe18bbcb32960034b4ec056b00fa74139a185a72b193c2`.
- LEO400_Z3-zonal20-sun-moon-srp-drag.script: `72c6bf52c692aa785f1d506f80a2ef71a34072a7e14db2954c55790430d126a5`.
- LEO400_W1-field-sun-moon-srp-drag-cssi.txt: `de0307c79ec62680f9e73814f29667a459458651aa763ebffa60cca849c9c14d`.
- LEO400_W1-field-sun-moon-srp-drag-cssi.script: `6c4a8f03b60c670ca86f2294895e3d899aff5cd5d6753255bf689a36e52e18da`.
- SSO700_F6-field-sun-moon-srp-drag.txt: `2c0449793a92997e6227f217c514dccbe466728fda7fdbe2b35a42480a1f3756`.
- SSO700_F6-field-sun-moon-srp-drag.script: `7ee29a8362817e6e435396e874681a16d11ae4529f6c181a24f036023e2d5fad`.
- SSO700_Z3-zonal20-sun-moon-srp-drag.txt: `0813a31f66332df71f0981d5b43542c9b1c00811633f9dad709598d17c60b3d1`.
- SSO700_Z3-zonal20-sun-moon-srp-drag.script: `8a3043c716696a73e600b88f32cb356d26ba03bba6d06205200fd0b559eba3d4`.
- SSO700_W1-field-sun-moon-srp-drag-cssi.txt: `d3c27ecb2c900210fdbd9c5778fa5c3191c6dba9ed52edaff8650f5b7d96d698`.
- SSO700_W1-field-sun-moon-srp-drag-cssi.script: `65a6f0d463bb3deb6d217ae9f096e3b5f5c008031b4a6b28354567850eae89cd`.

### Nyx drag diagnostic inputs

- FFM trajectories at suite / steps30 / finest: `e7a9c467fa412550e772460e16a6bb17d666658f61ad6f448c9b09f4dae388cc`.
- Published-formula / WGS84 trajectories: `b80c5ce7d4d9a2a20a7ae662fcae80bc2deae4dc62be4c2c83299d1d43e6b269`.

### Basilisk drag diagnostic inputs

- WGS84 / gtd7d trajectories: `8d97424ba8b6a75d14ad4be21b94a12479afe572e2438dc4aa7b58c41e469d30`.
