# Patch: hpop `SphericalHarmonics` latitudinal/longitudinal acceleration scaling

**File:** `propagator/hpop/lib/astrodynamics.cpp`
**Function:** `computeSphericalHarmonicGravity(...)`
**Severity:** high — the deployed gravity path produced a near-zero J2 effect.

## Symptom

The plugin's production gravity path is
`hpop_plugin.cpp → ForceModel::SphericalHarmonics → computeSphericalHarmonicGravity`.
With zonal coefficients loaded (J2…J6), this path produced a J2 perturbation
roughly **7000× too small** and with the wrong sign in the out-of-plane
component. hpop's own `J2Only` closed form gave the correct result, so the two
gravity implementations in hpop disagreed with each other.

Ground-truth check — nodal regression of a LEO orbit (a=7078 km, i=51.6°) over
one revolution, RK4:

| source | ΔΩ per orbit (rad) |
|---|---|
| analytic secular theory | −5.147e−3 |
| `J2Only` closed form | −5.157e−3 |
| `SphericalHarmonics` (**before fix**) | −7.28e−7  ← wrong |
| `SphericalHarmonics` (**after fix**) | −5.157e−3  ← correct |

## Root cause

The three spherical acceleration components all derive from a potential
`U ∝ mu/r`, so all three carry the scale `mu/r²`:

```
a_r   =  dU/dr                      ∝ mu/r²
a_lat = (1/r)          · dU/dlat    ∝ mu/r²
a_lon = (1/(r cos φ))  · dU/dlon    ∝ mu/(r² cos φ)
```

The code scaled the radial term by `mu/r²` (correct) but the latitudinal and
longitudinal terms by `mu/r³` — an extra factor of `1/r`. At LEO (r≈6.8e3 km)
that shrinks the latitudinal restoring term by ~6800×, which is exactly the
observed deficit. The latitudinal term is what carries J2's characteristic
out-of-plane behaviour, so the perturbation nearly vanished.

## Fix

```diff
     // Scale by mu/r^2
     double muOverR2 = coeffs.mu / (r * r);
     ar *= -muOverR2;
-    alat *= muOverR2 / r;
-    along *= muOverR2 / (r * std::cos(latitude) + 1e-20);
+    alat *= muOverR2;
+    along *= muOverR2 / (std::cos(latitude) + 1e-20);
```

## Verification

- `test/match_accel.cpp`: higherpop's zonal accelerations vs the corrected
  `SphericalHarmonics` — max relative error **3e-12** over 20 000 random states
  (J2, J2–J3, J2–J4).
- `test/crosscheck_hpop.cpp`: trajectory agreement to **≤ 4.1 mm** across
  {LEO, GTO, Molniya} × {J2, J4} for all five formulations.
- After the fix, `SphericalHarmonics`, `J2Only`, and analytic theory all agree.

## Scope / caveats

- The fix only touches the acceleration scaling; the normalized associated
  Legendre recursion and the `Cnm = −Jₙ/√(2n+1)` coefficient convention were
  already correct.
- The standalone `J2J4(...)` convenience function had a **separate, unrelated**
  issue in its hand-coded J3 z-term. **Closed 2026-08-29 under
  `gmat-01-defect-burn-down`** — and it turned out to be two defects, not one.

---

# Patch 2: `J2J4()` zonal terms (gmat-01-defect-burn-down)

**File:** `propagator/hpop/lib/force_models.cpp`
**Function:** `ForceModel::J2J4(...)`

## Root cause

Both terms are the gradient of `U_n = -mu * J_n * Re^n * P_n(z/r) / r^(n+1)`.

1. **J3 z-component sign.** The x/y components absorb the leading minus of
   `grad(U_3)` into the rearranged bracket `(7 z²/r² − 3)`; the z-component's
   bracket `(6z² − 7z⁴/r² − 3/5 r²)` is *not* rearranged, so it needs the minus
   written out. The code added it with a `+`.

2. **J4 scale factor.** The code used `1.875 * J4 * mu * Re⁴ / r⁹` against a
   dimensionless bracket. Only `r⁷` balances `mu * Re⁴` into an acceleration,
   and the correct prefactor is `0.625 * J4 * mu * Re⁴ / r⁷` — the code was
   wrong by `3 / r²`, i.e. ~6e−8 at LEO. The J4 term was not merely
   mis-scaled; it was **effectively absent**.

`J2Only()` was correct and is unchanged.

## Fix

```diff
-    double r7 = r2 * r2 * r2 * r;
     double factor3 = 2.5 * J3_EARTH * mu * RE_EARTH * RE_EARTH * RE_EARTH / r7;
-    acc.z += factor3 * (6.0 * z2 - 7.0 * z2 * z2 / r2 - 0.6 * r2);
+    acc.z -= factor3 * (6.0 * z2 - 7.0 * z2 * z2 / r2 - 0.6 * r2);

-    double r9 = r2 * r2 * r2 * r2 * r;
-    double factor4 = 1.875 * J4_EARTH * mu * Re4 / r9;
+    double factor4 = 0.625 * J4_EARTH * mu * Re4 / r7;
```

## Verification

`propagator/hpop/tests/zonal_crossvalidation.cpp`, driven by
`zonal_crossvalidation.test.mjs`. Three implementations that share no algebra —
hpop's closed forms, higherpop's Legendre recursion, and hpop's normalized
spherical-harmonics production path — compared pointwise over the same 20,000
random states from 200 to 40,200 km altitude:

| comparison | max relative error, before | after | gate |
|---|---|---|---|
| `J2Only` vs recursion (J2) | 1.387e−15 | 1.387e−15 | ≤ 3e−12 |
| `J2J4` vs recursion (J2–J4) | **7.701e−03** | **1.389e−15** | ≤ 3e−12 |
| `SphericalHarmonics` vs recursion (J2–J4) | 2.941e−12 | 2.941e−12 | ≤ 1e−8 |

The pre-fix build was rebuilt from the parent commit and run through the same
harness to produce that middle column: this is a measured negative control, not
an inference from the diff.

The same harness re-asserts the nodal regression of Patch 1 as a standing
regression test rather than a one-off measurement — `a = 7078 km, i = 51.6°`,
one revolution, RK4 at 20,000 steps, node read from the angular-momentum vector:

| source | ΔΩ per orbit (rad) |
|---|---|
| analytic secular theory | −5.146493e−3 |
| `J2Only` closed form | −5.156999e−3 |
| `SphericalHarmonics` (degree 2, zonal) | −5.156999e−3 |

Both measured paths sit 2.287e−7 relative from the −5.157e−3 the patch record
pins, inside the 1e−3 the acceptance allows.
