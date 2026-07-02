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
- The standalone `J2J4(...)` convenience function has a **separate, unrelated**
  issue in its hand-coded J3 z-term (`6z² − 7z⁴/r² − 0.6r²` disagrees with the
  recursion and with higherpop). It is not on the deployed path, so it was left
  untouched, but it should be reviewed or removed to avoid confusion.
