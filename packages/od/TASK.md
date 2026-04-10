# SGP4 Differential Correction Rewrite — Equinoctial Elements + WASM

## Goal
Rewrite the SGP4 fitter in `src/cpp/src/sgp4_fitter.cpp` to achieve 100% win rate against CelesTrak SupGP on Starlink MEME data. Currently at 55.8% win rate with 0.277 km median RMS.

## Context
- SGP4 library: src/cpp/deps/sgp4 (dnwrnr/sgp4, Apache 2.0)
- Eigen3 installed at /opt/homebrew
- CelesTrak reference: tests/data/celestrak_starlink_supgp.csv (9943 records)
- Current code: src/cpp/src/sgp4_fitter.cpp, include/od/sgp4_fitter.h
- Build: cd src/cpp && cmake -B build && cmake --build build
- Benchmark: ./build/bench_supgp tests/data/meme 300 tests/data/celestrak_starlink_supgp.csv

## What to Change (based on Vallado AIAA 2008-6770)

### 1. Switch state vector to EQUINOCTIAL elements (7 params)
Replace classical (n, e, i, Ω, ω, M, B*, ndot) with Vallado's equinoctial:
- af = e·cos(ω + Ω)     — no singularity at e=0
- ag = e·sin(ω + Ω)
- a  = semi-major axis in Earth radii (NOT km)
- L  = M + ω + Ω        — mean longitude (no ω/M degeneracy)
- pe = tan(i/2)·sin(Ω)
- qe = tan(i/2)·cos(Ω)
- B* = drag term (7th parameter)

Inverse transforms:
  e = sqrt(af² + ag²)
  i = 2·atan(sqrt(pe² + qe²))
  Ω = atan2(pe, qe)
  ω = atan2(ag, af) - Ω
  M = L - atan2(ag, af)

### 2. DROP ndot entirely
Vallado's paper is explicit: ndot and nddot are NOT estimated. BStar handles drag.
Set ndot = 0.0 and nddot = 0.0 always.

### 3. B* is the 7th state parameter
Don't do separate B* grid search. Include B* directly in the Jacobian from the start.
Still do initial B* estimation from altitude for the starting guess.

### 4. Uniform percentchg perturbation
Replace per-element DELTA array with uniform percentchg = 0.001 (Vallado's optimal value).
deltaamtchg = 1e-7 (minimum perturbation threshold).
If actual perturbation < deltaamtchg, increase percentage up to 5 times.

### 5. Proper Kozai-Brouwer conversion
When converting from osculating to mean elements, use the standard Kozai-Brouwer formula:
  a1 = (XKE/n0)^(2/3)
  K = (3/2)·k2·(3cos²i - 1)/(1-e²)^(3/2)
  δ1 = K/a1²
  a0 = a1·(1 - δ1/3 - δ1² - 134/81·δ1³)
  δ0 = K/a0²
  n_kozai = n_unkozai·(1 + δ0)

For inverse (Brouwer→Kozai when creating TLE), use Newton-Raphson (2-4 iterations).

### 6. SGP4 re-initialization after EVERY parameter change
The dnwrnr/sgp4 library uses OrbitalElements constructor → SGP4 constructor.
After setting new mean elements, you MUST create new OrbitalElements + new SGP4 objects.

### 7. Fit span: 2 orbital periods, ~72 points per revolution
For Starlink at ~550km, period is about 96 min. So:
- Fit span = ~192 min (3.2 hours) — NOT 8 hours
- Subsample to get ~72 points per revolution (~144 total)

### 8. Keep DE + NM as fallback
Keep Differential Evolution and Nelder-Mead for stubborn cases.

## Pipeline Architecture
1. Parse MEME → get Cartesian ephemeris in TEME
2. Pick epoch (first point of fit window)
3. Cartesian → osculating Keplerian
4. Osculating → Brouwer mean (iterative)
5. Classical mean → equinoctial state (af, ag, a_er, L, pe, qe, B*)
6. Estimate initial B* from altitude
7. LM iterations with SVD solve:
   a. For each param j: perturb by percentchg, re-init SGP4, propagate to all obs times
   b. Build Jacobian columns from finite differences
   c. SVD solve augmented system
   d. Apply correction with step limiting
   e. Check convergence (relative sigma change < 0.0002)
8. If RMS > 0.3 km after LM: run Nelder-Mead polish
9. If RMS > 0.5 km: run Differential Evolution → LM
10. Multi-start: try epochs at 0, 1h, 2h, 3h offsets if still bad

## WASM Build
Add Emscripten target to CMakeLists.txt. Create src/cpp/src/wasm_api.cpp with C-ABI exports:
- parse(const char* meme_content, int len) → int (returns handle)
- fit(int handle) → const char* (returns JSON result)
- malloc/free wrappers

## Files to Modify
1. src/cpp/include/od/sgp4_fitter.h — Update SGP4Elements, FitterConfig, add equinoctial types
2. src/cpp/src/sgp4_fitter.cpp — FULL REWRITE of fitting pipeline
3. src/cpp/CMakeLists.txt — Add WASM target
4. src/cpp/src/wasm_api.cpp — NEW: WASM API

## Files NOT to modify
- src/cpp/src/meme_parser.cpp
- src/cpp/include/od/meme_parser.h
- src/cpp/src/orbit_determination.cpp

## Critical Implementation Notes
- dnwrnr/sgp4 OrbitalElements constructor takes: (M_rad, Ω_rad, ω_rad, e, i_rad, n_rad_per_min, bstar, epoch_DateTime)
- n_rad_per_min = mean_motion_rev_per_day * 2π / (24*60)
- The library uses WGS72 constants: mu = 398600.8 km³/s², RE = 6378.135 km
- XKE = 60.0 / sqrt(RE³/mu) ≈ 0.0743669161 rad/min
- TEME is the coordinate frame for SGP4
- Keep the existing utility functions (cartesian_to_keplerian, jd_to_iso_supgp, etc.)

After making changes, build and run:
```bash
cd src/cpp && cmake -B build && cmake --build build
```

If tests/data/meme has MEME files, run the benchmark. If not, just make sure it compiles.
