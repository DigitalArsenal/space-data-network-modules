# rf-rain

Rain-attenuation primitives. Three exported kernels:

- `rf_rain_specific_attenuation_db_per_km(f, R, θ, τ)` — ITU-R P.838-3 §1
  `γ_R = k(f, θ, τ) · R^α(f, θ, τ)` in dB/km. Coefficients `k_H`, `α_H`,
  `k_V`, `α_V` interpolated from frequency via the published
  four/five-curve sum-of-Lorentzians fit, then mixed via the
  elevation-and-polarization orientation factor.
- `rf_rain_attenuation_db(f, R, d, θ, τ)` — ITU-R P.530-18 §2.4 Eq. (33)
  terrestrial LOS reduction: `A = γ_R · d / (1 + 0.045·d)`.
- `rf_rain_attenuation_crane_db(f, R, d, θ, τ)` — Crane 1980
  IEEE T-COMM-28(9) piecewise-exponential model. Path clamped to 22.5 km
  (matches the JS-port behavior at `RfCommsCore.js:5099-5142`).

Phase 4 Wave B of the RF audit, after `rf-empirical` and
`rf-atmospheric-gaseous`.

## Authority

| Form | Authority |
| --- | --- |
| `γ_R = k·R^α` | ITU-R P.838-3 §1 |
| Specific-attenuation coefficient fit | RfCommsCore.js port (matches P.838-3 published table) |
| Path reduction for terrestrial LOS | ITU-R P.530-18 §2.4 Eq. (33) |
| Crane piecewise model | Crane 1980 IEEE T-COMM-28(9); Ippolito 2017 §7.4 |

## Status

Skeleton complete; build verification + orbpro-integration registration
pending. Phase 2 of the RF audit replaces the in-source coefficient
constants with values transcribed verbatim from ITU-R P.838-3 Tables 1
and 2 (with citation comments) so future ITU revisions can be tracked.
